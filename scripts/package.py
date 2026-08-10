#!/usr/bin/env python3
"""出安装包：前端构建 → PyInstaller 打后端 → Tauri 出壳。

    python3 scripts/package.py                # 全套
    python3 scripts/package.py --backend-only # 只打后端（调 PyInstaller 配置时用）
    python3 scripts/package.py --lean         # 不打包 torch 等重依赖（见下）
    python3 scripts/package.py --skip-frontend

## 为什么是 `--onedir` 而不是 `--onefile`

`--onefile` 每次启动都要把整包解压到临时目录。本项目的依赖里有 PyTorch
（单 torch 就 500 MB），解压耗时以十秒计——**每次开应用都等一次**，
体验直接崩坏（CLAUDE.md §5.15）。`--onedir` 只在安装时解一次。

## 重依赖进不进包（`--lean`）

默认**进**。理由是一站式（§2.3）：装完就该能用，不该让用户再自己装 torch。
代价是安装包很大，而 Windows 的 NSIS/WiX 有 **2 GB 单安装包硬上限**
（`tauri-apps/tauri#7372`）——本脚本最后会把各部分体积打印出来，就是为了
让这条限制是可度量的而不是靠猜。

`--lean` 把 torch / audio-separator / librosa / numba / onnxruntime 排除在外，
产物小一个数量级。**但它目前不是可交付形态**：冻结后的解释器没有 pip，
`kvm.media.deps` 那套"缺依赖就自动装"在打包环境里走不通（`sys.executable`
是打好的可执行文件，`uv pip install --python` 认不了）。所以 `--lean` 只用来
量体积、做对照，不要拿它出正式包——除非先验证"往 `private_deps_dir` 装 wheel
再加进 sys.path"这条路可行。

## CUDA 版 torch 不进包（已定）

PyPI 的 Windows `torch` wheel 本来就是 CPU-only；CUDA 版单个 wheel 就 2.58 GB，
**装进安装包必然撞穿 2 GB 上限**。所以安装包一律带 CPU 版，
需要 CUDA 的用户在应用外自行替换（属于高级用法，不是默认路径）。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
DIST_BACKEND = REPO_ROOT / "dist-backend"
BUILD_BACKEND = REPO_ROOT / "build-backend"

IS_WINDOWS = sys.platform.startswith("win")

# uvicorn 与 fastapi 大量用运行时 import（协议实现、事件循环、logging 配置），
# 静态分析看不见，不 collect 会在启动时报 ModuleNotFoundError。
COLLECT_ALL = ["uvicorn", "kvm"]

# `--lean` 排除的模块。注意排除的是**顶层包名**，PyInstaller 会连带跳过其子模块。
HEAVY_MODULES = [
    "torch",
    "torchaudio",
    "torchcrepe",
    "audio_separator",
    "librosa",
    "numba",
    "llvmlite",
    "onnxruntime",
    "scipy",
    "matplotlib",
]

# 任何情况下都不该进包的东西：测试框架、打包器自己、开发工具。
ALWAYS_EXCLUDE = ["pytest", "ruff", "pyright", "PyInstaller", "tkinter", "IPython"]


def log(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def run(cmd: list[str], cwd: Path) -> None:
    print(f"    $ ({cwd.name}) {' '.join(cmd)}", flush=True)
    code = subprocess.call(cmd, cwd=str(cwd))
    if code != 0:
        raise SystemExit(f"命令失败（退出码 {code}）：{' '.join(cmd)}")


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def human(n: int) -> str:
    return f"{n / 1024 / 1024:.0f} MB" if n < 1 << 30 else f"{n / 1024 / 1024 / 1024:.2f} GB"


def build_frontend() -> None:
    log("构建前端")
    npm = "npm.cmd" if IS_WINDOWS else "npm"
    run([npm, "run", "build"], FRONTEND_DIR)
    index = FRONTEND_DIR / "dist" / "index.html"
    if not index.is_file():
        raise SystemExit(f"前端构建产物不存在：{index}")


def build_backend(lean: bool) -> Path:
    log("打包后端（PyInstaller --onedir）")
    dist_index = FRONTEND_DIR / "dist"
    if not (dist_index / "index.html").is_file():
        raise SystemExit("前端产物缺失——后端要把它作为界面下发，先跑 npm run build")

    # PyInstaller 的 --add-data 分隔符跟平台走：Windows 用 ;，其余用 :
    sep = ";" if IS_WINDOWS else ":"
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "kvm-backend",
        # 控制台版：后端的 stdout/stderr 要能被外壳收上来做诊断（§2.6：
        # 失败要说清楚）。窗口化版本在 Windows 上拿不到这两条流。
        "--console",
        "--distpath",
        str(DIST_BACKEND),
        "--workpath",
        str(BUILD_BACKEND),
        "--specpath",
        str(BUILD_BACKEND),
        "--paths",
        str(BACKEND_DIR),
        "--add-data",
        f"{dist_index}{sep}webui",
    ]
    # 许可证与第三方声明必须随安装包一起走：MIT 要求"副本及实质性部分"都带上声明，
    # 而安装包正是一份副本；jassub（MIT）与 Liberation Sans（OFL）同理。
    # 目标写 `.` 即 onedir 的 `_internal/` 根（`--add-data dist:webui` 落在
    # `_internal/webui` 可以互证）。缺文件直接失败——静默出一个没有许可证的包，
    # 要等别人来提 issue 才发现。
    for doc in ("LICENSE", "THIRD-PARTY-NOTICES.md"):
        src = REPO_ROOT / doc
        if not src.is_file():
            raise SystemExit(f"许可证文件缺失，安装包不能这样出：{src}")
        cmd += ["--add-data", f"{src}{sep}."]
    for mod in COLLECT_ALL:
        cmd += ["--collect-all", mod]
    for mod in ALWAYS_EXCLUDE + (HEAVY_MODULES if lean else []):
        cmd += ["--exclude-module", mod]
    cmd.append(str(BACKEND_DIR / "kvm" / "server.py"))

    run(cmd, REPO_ROOT)
    out = DIST_BACKEND / "kvm-backend"
    exe = out / ("kvm-backend.exe" if IS_WINDOWS else "kvm-backend")
    if not exe.is_file():
        raise SystemExit(f"PyInstaller 没有产出可执行文件：{exe}")
    return out


def smoke_test_backend(bundle: Path) -> None:
    """打完就地跑一次：起得来、/api/health 通、界面首页发得出来。

    不做这一步的话，"安装包能出"与"装完能用"之间是空的——
    PyInstaller 漏收一个运行时 import，要等用户装完打开才暴露。
    """
    import socket
    import urllib.request

    log("冒烟测试打好的后端")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    exe = bundle / ("kvm-backend.exe" if IS_WINDOWS else "kvm-backend")
    proc = subprocess.Popen(
        [str(exe), "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + 60
        last = ""
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise SystemExit(f"后端启动即退出（{proc.returncode}）：\n{out}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
                    if r.status == 200:
                        break
            except OSError as e:
                last = str(e)
            time.sleep(0.3)
        else:
            raise SystemExit(f"后端 60 秒内没有响应：{last}")

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as r:
            body = r.read(512)
            coep = r.headers.get("Cross-Origin-Embedder-Policy")
        if b"<html" not in body.lower() and b"<!doctype" not in body.lower():
            raise SystemExit("首页不是 HTML——前端产物没有被正确打进包里")
        if coep != "require-corp":
            # 缺这个头 = 页面拿不到跨源隔离 = JASSUB 起不来 = 没有字幕预览。
            # 这在成品上是灾难性的，必须在打包阶段就拦住。
            raise SystemExit(f"首页缺少跨源隔离响应头（COEP={coep!r}）")
        log("冒烟测试通过：健康检查、界面下发、跨源隔离头都正常")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def build_shell() -> None:
    log("构建 Tauri 外壳")
    npx = "npx.cmd" if IS_WINDOWS else "npx"
    run(
        [npx, "tauri", "build", "--config", "src-tauri/tauri.bundle.conf.json"],
        REPO_ROOT,
    )


def report() -> None:
    log("产物体积")
    if DIST_BACKEND.is_dir():
        print(f"    后端 onedir      {human(dir_size(DIST_BACKEND))}")
    bundle_root = REPO_ROOT / "src-tauri" / "target" / "release" / "bundle"
    if bundle_root.is_dir():
        for item in sorted(bundle_root.rglob("*")):
            if item.suffix in {".dmg", ".exe", ".msi", ".AppImage", ".deb"} and item.is_file():
                print(f"    {item.name:<40} {human(item.stat().st_size)}")
            elif item.suffix == ".app" and item.is_dir():
                print(f"    {item.name:<40} {human(dir_size(item))}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python3 scripts/package.py", description="出安装包")
    p.add_argument("--backend-only", action="store_true")
    p.add_argument("--skip-frontend", action="store_true")
    p.add_argument("--skip-smoke", action="store_true", help="跳过打包后的冒烟测试")
    p.add_argument("--lean", action="store_true", help="排除 torch 等重依赖（只用于量体积）")
    args = p.parse_args(argv)

    if shutil.which("npm") is None:
        raise SystemExit("找不到 npm，前端与外壳都构建不了")

    started = time.monotonic()
    if not args.skip_frontend:
        build_frontend()
    bundle = build_backend(args.lean)
    if not args.skip_smoke:
        smoke_test_backend(bundle)
    if not args.backend_only:
        build_shell()
    report()
    log(f"完成，用时 {time.monotonic() - started:.0f}s")
    if args.lean:
        log("注意：--lean 产物缺少分离/引导声/对齐所需的依赖，不是可交付形态")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    raise SystemExit(main())
