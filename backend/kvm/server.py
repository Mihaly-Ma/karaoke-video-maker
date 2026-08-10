"""打包后应用的后端进程入口（PyInstaller 的 entry point）。

    kvm-backend --host 127.0.0.1 --port 51234

开发期不用它——`scripts/dev.py` 直接跑 `uvicorn kvm.api.app:app --reload`，
带热重载更顺手。本模块存在的意义是给打包产物一个**不依赖 uvicorn 命令行**的
入口：PyInstaller 打的是"一个可执行文件 + 一堆依赖"，没有 `uvicorn` 这个脚本。

## 只绑 127.0.0.1

`--host` 有默认值且默认就是 `127.0.0.1`，任何时候都不要改成 `0.0.0.0`：
这是个单机桌面应用，把 API 暴露到局域网上没有任何收益，只会让同网段的人
能读写用户的工程文件与媒体。

## 端口由外壳指定，不写死

用户机器上很可能已经有别的东西占着 8000（开发期本仓自己就占着）。
外壳先向内核要一个空闲端口，再把它传进来——**不要在这里挑默认端口然后
撞了再退让**，那样外壳就不知道后端最终落在哪个端口上了。
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path


def _ensure_package_importable() -> None:
    """让 `kvm` 包在两种运行形态下都 import 得到。

    - 打包后：PyInstaller 把包放进 `sys._MEIPASS`，import 机制已经就位，无需处理。
    - 源码运行（`python backend/kvm/server.py`）：`backend/` 不在 sys.path 上，
      得自己补——本项目是 uv 的 virtual project，`kvm` 不装进 site-packages。
    """
    if getattr(sys, "frozen", False):
        return
    backend_dir = Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kvm-backend", description="Karaoke Video Maker 后端服务")
    p.add_argument("--host", default="127.0.0.1", help="监听地址（默认且应当保持 127.0.0.1）")
    # 刻意**不给默认值**：外壳每次都会传一个它自己选好的空闲端口，
    # 而给了默认值就会出现"外壳以为在 A 端口、后端实际落在 B 端口"的错配。
    p.add_argument("--port", type=int, required=True, help="监听端口（由外壳分配）")
    p.add_argument("--log-level", default="info")
    p.add_argument(
        "--exit-on-stdin-eof",
        action="store_true",
        help="父进程（外壳）消失时自杀。外壳总是传这个。",
    )
    return p


def _die_when_parent_goes(exit_code: int = 0) -> None:
    """外壳没了就自杀。

    外壳正常退出时会主动整组终止后端；但它被 `kill -9` 或崩掉时没有机会做任何事，
    后端就会变成孤儿——继续占着端口与内存，用户下次启动只看到一个莫名其妙的
    "端口被占"（`scripts/dev.py` 记过同类事故）。

    **两条独立的判据，谁先命中算谁**，因为它们各有各的盲区：

    - **父进程 pid 变成 1**（POSIX：父死后被 init/launchd 收养）。判据直白、
      不受 stdio 怎么接管影响。Windows 上没有这个语义，所以只在 POSIX 上开。
    - **stdin 读到 EOF**。外壳把 stdin 接成管道并一直握着写端，写端随外壳消失而关闭。

    **已知缺陷（未解决）**：实测在打好的 macOS 应用里把外壳 `kill -9` 之后，
    这两条都没有生效，后端存活了下来（`lsof` 显示 fd 0 已是"没有写端的管道"，
    `ps` 显示 ppid 已变成 1，两个条件都该命中）。同一个二进制在单独的测试里
    两条都能正常触发，所以不是代码没走到。原因未查清。

    影响范围有限：**正常退出路径（关窗口 / Cmd+Q）已实测干净、不留孤儿**，
    走的是外壳那边的 `RunEvent::Exit` 主动整组终止。只有"外壳被强杀"这一种
    异常情况会留下后端。查这个问题时先确认 `--exit-on-stdin-eof` 有没有传到，
    再在应用内 attach 上去看这两个线程还在不在。

    另注：带这个开关时**不要把 stdin 接到 /dev/null**——读它立刻得到 EOF，
    进程会当场退出。只有外壳（它接的是真管道）该传这个开关。
    """
    original_ppid = os.getppid() if hasattr(os, "getppid") else None

    def _quit() -> None:
        print("[kvm-backend] 外壳已退出，随之关闭", file=sys.stderr, flush=True)
        # 不走 sys.exit：这是后台线程，抛 SystemExit 只会终止它自己而不是进程。
        os._exit(exit_code)

    def _watch_stdin() -> None:
        try:
            while sys.stdin is not None and sys.stdin.readline():
                pass
        except (OSError, ValueError):
            pass
        _quit()

    def _watch_ppid() -> None:
        while True:
            time.sleep(2.0)
            if os.getppid() != original_ppid:
                _quit()

    threading.Thread(target=_watch_stdin, name="parent-watchdog-stdin", daemon=True).start()
    if original_ppid is not None and original_ppid > 1:
        threading.Thread(target=_watch_ppid, name="parent-watchdog-ppid", daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _ensure_package_importable()

    if args.exit_on_stdin_eof:
        _die_when_parent_goes()

    import uvicorn

    from kvm.api.app import app

    if args.host != "127.0.0.1":
        # 不直接拒绝——排查问题时偶尔需要从别的机器连一下；但必须刺眼。
        print(
            f"[kvm-backend] 警告：监听在 {args.host} 而非 127.0.0.1，"
            "同网段的机器将能读写你的工程与媒体文件",
            file=sys.stderr,
            flush=True,
        )

    # 打包后的应用不该继承开发机的环境变量语义，这里显式声明一次运行形态，
    # 供 doctor / bootstrap 在报告里区分"源码跑的"与"装好的应用"。
    if getattr(sys, "frozen", False):
        os.environ.setdefault("KVM_PACKAGED", "1")

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
