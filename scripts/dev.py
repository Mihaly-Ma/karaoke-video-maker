#!/usr/bin/env python3
"""一键启动：先自检+装依赖，再把前后端一起拉起来。

    python3 scripts/dev.py                       # 装依赖 → 自检 → 起前后端
    python3 scripts/dev.py --skip-setup          # 跳过安装，只自检后启动
    python3 scripts/dev.py --backend-port 8010 --frontend-port 5183
    python3 scripts/dev.py --backend-only

## 为什么启动前一定要自检

CLAUDE.md §2.6：**启动自检必须先于任何长任务。**"宁可开机多花两秒，也不要让
用户等 20 分钟分离完才发现 ffmpeg 不能烧字幕。" 所以本脚本先跑
`scripts/setup.py`（它内部委托 `kvm.doctor`），有阻断项就**不启动**。

## 哪些算阻断项，哪些只是警告

判据由 `kvm.doctor` 的每条检查自带 `blocking` 标注，本脚本不另立一套。当前
阻断的是：平台是 Intel Mac、Python 不是 3.12、缺 uv/Node/npm、前端依赖没装、
**ffmpeg 不带 libass**、应用数据目录不可写、要用的端口被占。

ffmpeg 之所以阻断而不是降级：没有它，预览、样式、波形、探测、导出全线不可用，
起来的是个空壳；而"装了 ffmpeg 却不带 libass"恰恰是本项目最常见的坑
（Homebrew 主线 formula 就不带）。早报一秒胜过烧录失败后再报。

分离/下载/歌词这些缺了只是少一块功能（都有手工旁路，§2.5），一律只警告，
照常启动——**失败要降级，不能终止**。

## 收尾

`npm run dev` 会再 fork 出 vite、uvicorn 带 `--reload` 也会 fork 出 reloader 子进程。
只 kill 直接子进程会留下孤儿继续占着端口，下次启动就报"端口被占"而看不出是谁。
所以两个子进程都放进**独立进程组**，退出时按组整体终止。
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
SETUP_SCRIPT = REPO_ROOT / "scripts" / "setup.py"

IS_WINDOWS = sys.platform.startswith("win")

DEFAULT_BACKEND_PORT = 8000
DEFAULT_FRONTEND_PORT = 5173


def log(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def venv_python() -> Path:
    if IS_WINDOWS:
        return REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    return REPO_ROOT / ".venv" / "bin" / "python"


def backend_env() -> dict[str, str]:
    """后端进程的环境：把 `backend/` 塞进 PYTHONPATH。

    本项目是 uv 的 virtual project，`kvm` 包不装进 site-packages，必须显式
    指路径；命令行上等价的写法是 uvicorn 的 `--app-dir backend`。
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(BACKEND_DIR), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    return env


# ---------------------------------------------------------------------------
# 子进程管理
# ---------------------------------------------------------------------------


def _spawn_kwargs() -> dict:
    """让子进程自成一个进程组/作业，好在退出时整组带走。

    - POSIX：`start_new_session=True` 建新会话，之后用 `os.killpg` 整组终止。
      顺带的好处是终端的 Ctrl-C（SIGINT 发给前台进程组）不会直接打到子进程，
      收尾顺序完全由本脚本控制，不会出现"子进程先死、父进程还在等"的竞态。
    - Windows：`CREATE_NEW_PROCESS_GROUP` 让我们能对该组发 CTRL_BREAK_EVENT。
      **未在 Windows 上实测**（本仓从未在 Windows 上跑过）。
    """
    if IS_WINDOWS:
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


class Service:
    """一个被托管的子进程（后端或前端）。"""

    def __init__(self, name: str, cmd: list[str], cwd: Path, env: dict[str, str] | None = None):
        self.name = name
        self.cmd = cmd
        self.cwd = cwd
        self.env = env
        self.proc: subprocess.Popen[str] | None = None

    def start(self) -> None:
        print(f"    $ ({self.cwd.name}) {' '.join(self.cmd)}", flush=True)
        self.proc = subprocess.Popen(
            self.cmd,
            cwd=str(self.cwd),
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            **_spawn_kwargs(),
        )
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        """把子进程输出加上前缀转发出来。

        两个服务的日志混在一起时，没有前缀根本分不清是谁在报错。
        """
        assert self.proc is not None
        if self.proc.stdout is None:
            return
        with self.proc.stdout as stream:
            for line in stream:
                print(f"[{self.name}] {line.rstrip()}", flush=True)

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self, timeout: float = 8.0) -> None:
        """按进程组终止，先温和后强硬。

        直接 `proc.terminate()` 只打到 npm / uvicorn 的壳，真正监听端口的
        vite / reloader 子进程会活下来变成孤儿——症状是下次启动报端口被占，
        而 `ps` 里看不到明显的"上一个服务"。
        """
        if self.proc is None or self.proc.poll() is not None:
            return
        try:
            if IS_WINDOWS:
                # Windows 上没有进程组信号语义可用于 SIGTERM；CTRL_BREAK 是最接近的。
                self.proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
            else:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except (OSError, ValueError):
            self.proc.terminate()

        try:
            self.proc.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass

        log(f"{self.name} 未在 {timeout:.0f}s 内退出，强制结束")
        try:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(self.proc.pid)],
                    capture_output=True,
                    check=False,
                )
            else:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
        except (OSError, ValueError):
            self.proc.kill()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log(f"{self.name} 仍未退出，可能需要手工清理 PID {self.proc.pid}")


# ---------------------------------------------------------------------------
# 启动前的检查
# ---------------------------------------------------------------------------


def run_setup(args: argparse.Namespace) -> int:
    """跑 `scripts/setup.py`——安装与自检的逻辑都在那里，本脚本不重复实现。

    端口检查作为额外参数传给 doctor：它必须**在启动之前**做完，否则用户会看到
    半截启动后一个进程神秘退出。
    """
    setup_args = ["--skip-torch"] if args.skip_torch else []
    if args.check_only:
        setup_args.append("--check-only")
    if args.backend_only:
        setup_args.append("--no-frontend")
    cmd = [sys.executable, str(SETUP_SCRIPT), *setup_args]
    log("环境自检与依赖安装")
    return subprocess.call(cmd, cwd=str(REPO_ROOT))


def check_ports(ports: list[tuple[int, str]]) -> bool:
    """端口占用单独检查——它每次启动都可能变，不属于"环境装没装好"。"""
    sys.path.insert(0, str(BACKEND_DIR))
    try:
        from kvm.doctor import Report as DoctorReport
        from kvm.doctor import check_port, render_report
    except ImportError as exc:
        log(f"无法导入 kvm.doctor（{exc}），跳过端口检查")
        return True
    results = [check_port(port, label=label) for port, label in ports]
    failed = [r for r in results if r.status != "ok"]
    if failed:
        print(render_report(DoctorReport(checks=results, generated_at="")))
        return False
    for r in results:
        log(f"{r.title}：{r.detail}")
    return True


def wait_until_listening(port: int, timeout: float = 60.0) -> bool:
    """等后端真的开始监听再启动前端。

    不是为了正确性（vite 的代理是按请求转发的，晚一点起来也没关系），而是为了
    可读性：先看到"后端就绪"再看到前端地址，比两份日志交织着刷更好判断是谁没起来。
    """
    import socket

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.25)
    return False


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python3 scripts/dev.py",
        description="一键启动：先跑 scripts/setup.py 做自检与安装，通过后同时拉起后端与前端。",
    )
    p.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    p.add_argument("--frontend-port", type=int, default=DEFAULT_FRONTEND_PORT)
    p.add_argument("--skip-setup", action="store_true", help="跳过安装与自检，直接启动")
    p.add_argument("--check-only", action="store_true", help="只自检，不安装也不启动")
    p.add_argument("--backend-only", action="store_true", help="只起后端")
    p.add_argument("--frontend-only", action="store_true", help="只起前端")
    p.add_argument("--no-reload", action="store_true", help="后端不开 --reload")
    p.add_argument("--skip-torch", action="store_true", help="自检时跳过 torch 探测（省几秒）")
    p.add_argument(
        "--force", action="store_true", help="即使自检有阻断项也照样启动（用于排查，不建议常用）"
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.skip_setup:
        code = run_setup(args)
        if args.check_only:
            return code
        if code != 0:
            if not args.force:
                print(
                    "\n环境自检未通过，已停止启动。解决上面标出的问题后重新执行，"
                    "或用 --force 强制启动（用到相关功能时仍会失败）。",
                    file=sys.stderr,
                )
                return code
            log("自检未通过，但指定了 --force，继续启动")
    elif args.check_only:
        log("--skip-setup 与 --check-only 同时指定，无事可做")
        return 0

    ports: list[tuple[int, str]] = []
    if not args.frontend_only:
        ports.append((args.backend_port, "backend"))
    if not args.backend_only:
        ports.append((args.frontend_port, "frontend"))
    if not check_ports(ports) and not args.force:
        return 1

    python = venv_python()
    if not python.is_file() and not args.frontend_only:
        print(
            f"找不到项目虚拟环境的解释器：{python}\n请先执行 `python3 scripts/setup.py`。",
            file=sys.stderr,
        )
        return 1

    services: list[Service] = []
    if not args.frontend_only:
        backend_cmd = [
            str(python),
            "-m",
            "uvicorn",
            "kvm.api.app:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(args.backend_port),
        ]
        if not args.no_reload:
            # reload 只盯 backend/：不加 --reload-dir 时 uvicorn 会监视整个 cwd，
            # 把 frontend/node_modules 和 workspace/ 里几 GB 的中间产物一起纳入
            # 监视，启动就卡住甚至撞上系统的文件描述符上限。
            backend_cmd += ["--reload", "--reload-dir", str(BACKEND_DIR)]
        services.append(Service("后端", backend_cmd, REPO_ROOT, backend_env()))

    frontend_service: Service | None = None
    if not args.backend_only:
        npm = "npm.cmd" if IS_WINDOWS else "npm"
        frontend_cmd = [
            npm,
            "run",
            "dev",
            "--",
            "--port",
            str(args.frontend_port),
            # strictPort：端口被占就报错退出，而不是悄悄换一个。悄悄换端口会让
            # 用户打开日志里那个地址却发现代理指向的后端不对——不如直接失败。
            "--strictPort",
        ]
        frontend_service = Service("前端", frontend_cmd, FRONTEND_DIR)

    stopping = threading.Event()

    def _shutdown(signum: int, _frame: object) -> None:
        if stopping.is_set():
            return
        stopping.set()
        print()
        log(f"收到信号 {signum}，正在停止…")

    signal.signal(signal.SIGINT, _shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _shutdown)

    try:
        for svc in services:
            svc.start()
        if services and not args.frontend_only:
            if wait_until_listening(args.backend_port):
                log(f"后端就绪：http://127.0.0.1:{args.backend_port}")
            else:
                log("后端在 60s 内没有开始监听，原因见上方 [后端] 日志")
        if frontend_service is not None:
            frontend_service.start()
            services.append(frontend_service)
            log(f"前端启动中：http://localhost:{args.frontend_port}")

        print()
        log("两个服务都在运行，按 Ctrl-C 停止。")

        # 任何一个子进程意外退出都要整体收尾：只剩半边服务的界面会以各种
        # 难以理解的方式坏掉（前端能开、每个请求 502），不如直接停下来说清楚。
        while not stopping.is_set():
            dead = [s for s in services if not s.alive]
            if dead:
                log(
                    f"{dead[0].name} 已退出（退出码 {dead[0].proc.returncode if dead[0].proc else '?'}），停止其余服务"
                )
                break
            time.sleep(0.4)
    finally:
        stopping.set()
        for svc in reversed(services):
            svc.stop()
        log("已全部停止")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
