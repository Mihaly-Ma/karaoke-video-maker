#!/usr/bin/env python3
"""一键环境检测 + 依赖安装（CLAUDE.md §2.6）。

    python3 scripts/setup.py              # 检测 + 把缺的依赖装上
    python3 scripts/setup.py --check-only # 只检测，什么都不装
    python3 scripts/setup.py --json       # 机器可读，供别的脚本消费

§2.6 的要求是：**用户不应该为了跑起这个工具去手动 `brew install` 任何东西。**
本脚本能自动做的都自动做，做不了的给一条**可直接复制粘贴**的命令，
而不是一句"请安装 X"。

## 三段式里本脚本负责哪两段

| 阶段 | 谁做 | 现状 |
|---|---|---|
| 查找 | `kvm.doctor` | 已实现，判据是实际能力（ffmpeg 看 `ass` 滤镜是否注册） |
| 获取 | —— | **本轮不做**：自动下载 ffmpeg 静态构建等于下载并执行外部二进制 |
| 安装 | 本脚本 | Python 3.12 / venv / 全部 extras / 前端 npm 依赖 |

因此 ffmpeg、Node.js、uv 自身这三样目前只检测 + 给命令，不自动装。
它们的共同点是"要下载并执行一个外部二进制"，风险与收益不成比例。

## 为什么是 Python 脚本而不是 setup.sh + setup.ps1

一对 shell 脚本意味着同一套逻辑写两遍，然后在只有一端被实测的情况下慢慢漂移
——本仓刚吃过"同一规则两份实现，改了一处另一处仍是坏的"的亏。而 Python 本来
就是硬前提（macOS 自带 python3，Windows 用户装 uv 时也会有），拿它写一份能在
两端跑的脚本，代价最小。

**本脚本只用标准库，且要能被 3.9+ 的任意 Python 跑起来**：它的职责之一就是
把 3.12 装出来，不能反过来要求 3.12 才能启动。真正需要 3.12 的部分
（`kvm.doctor` 的依赖探测）是拿建好的 venv 的解释器**以子进程方式**跑的。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"

# 与 pyproject.toml 的 [project.optional-dependencies] 一一对应。
# 默认全装：这是给"想把这个工具跑起来"的人用的脚本，缺一个 extra 就少一块功能，
# 而挑着装省下的那点体积远不值得让用户在半路撞见"分离不可用"。
ALL_EXTRAS = ("api", "fonts", "audio", "separate", "download", "lyrics")

# `--minimal` 只装出片必需的两组：不拉 torch/librosa，装机快得多，
# 适合只想在备好的素材上渲染、不做分离与引导声的场景。
MINIMAL_EXTRAS = ("api", "fonts")

PYTHON_VERSION = "3.12"


class SetupError(RuntimeError):
    """带一条可复制命令的失败。"""

    def __init__(self, message: str, fix: str | None = None) -> None:
        super().__init__(message)
        self.fix = fix


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def log(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> int:
    """跑一条命令，输出直接透传给用户。

    **不捕获输出**：`uv sync` 与 `npm install` 动辄几十秒到几分钟，把进度藏起来
    只会让人以为脚本卡死（§5.14 记的就是这个教训——静默的长下载会被当成崩溃）。
    """
    print(f"    $ {' '.join(cmd)}", flush=True)
    return subprocess.call(cmd, cwd=str(cwd) if cwd else None, env=env)


def uv_bin() -> str:
    """定位 uv。它是整条 Python 依赖链路的入口，缺了什么都做不了。

    **不自动安装 uv**：官方安装方式是 `curl | sh`，那是下载并执行外部脚本，
    不该由一个"帮你装依赖"的脚本替用户默默做掉。给命令，让用户自己按一次回车。
    """
    found = shutil.which("uv")
    if found:
        return found
    installer = (
        'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
        if sys.platform.startswith("win")
        else "curl -LsSf https://astral.sh/uv/install.sh | sh"
    )
    raise SetupError(
        "找不到 uv——它负责装 Python 3.12 与全部 Python 依赖，是所有后续步骤的前提。",
        fix=installer,
    )


def venv_python() -> Path:
    """项目 venv 里的解释器路径（uv sync 默认建在仓库根的 `.venv/`）。"""
    if sys.platform.startswith("win"):
        return REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    return REPO_ROOT / ".venv" / "bin" / "python"


# ---------------------------------------------------------------------------
# 安装阶段
# ---------------------------------------------------------------------------


# torch 的 CUDA 轮子从这里取。**不写进 pyproject.toml / uv.lock**：那会让 CI 与
# 打包也拉 CUDA 版，而单个 wheel 解开就有 2.7 GB，装进安装包必然撞穿 NSIS 的
# 2 GB 上限（CLAUDE.md §5.15）。所以它只是本机开发环境的一次覆盖安装。
_TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu130"

# 这三个必须一起换：混着装（torch 是 CUDA 版、torchvision 是 CPU 版）会在
# import 时才报符号缺失，而错误信息与"装错了 torch"毫无关系。
_TORCH_PACKAGES = ("torch", "torchvision", "torchaudio")

# 驱动报告的 CUDA 版本低于这个数就不装 CUDA 版：cu130 的 wheel 需要足够新的
# 驱动，老驱动上装了也只会在运行时报错，不如老老实实用 CPU 版。
_MIN_DRIVER_CUDA = (13, 0)


def detect_nvidia_gpu() -> tuple[str, tuple[int, int]] | None:
    """探测本机的 N 卡与驱动支持的 CUDA 版本。返回 (显卡名, (主, 次))。

    **判据是 `nvidia-smi` 跑得通**，不是"装没装 CUDA Toolkit"——用 pip 装的
    torch 自带全套 CUDA 运行时（Windows 上就打在那 2.7 GB 里），用户不需要
    另外装 Toolkit，只要驱动够新。
    """
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return None

    def _run(args: list[str]) -> str:
        try:
            return subprocess.run(
                [exe, *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return ""

    # CUDA 版本只在默认输出的表头里，没有对应的 --query 字段
    ver = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", _run([]))
    if ver is None:
        return None
    # 型号走结构化输出：默认输出是画出来的表格，按空白切会切到表头上
    names = [ln.strip() for ln in _run(["--query-gpu=name", "--format=csv,noheader"]).splitlines()]
    name = next((n for n in names if n), "NVIDIA GPU")
    return name, (int(ver.group(1)), int(ver.group(2)))


def install_cuda_torch(uv: str) -> None:
    """把 torch 三件套换成 CUDA 版，装进同一个 `.venv`。

    **下载量约 2.7 GB**，所以要先把这件事说出来再动手——静默的长下载会被当成
    程序卡死（§5.14 记的就是这个教训）。
    """
    log("检测到 N 卡，安装 CUDA 版 torch（约 2.7 GB，首次较慢）")
    cmd = [
        uv,
        "pip",
        "install",
        "--python",
        str(venv_python()),
        "--reinstall",
        *_TORCH_PACKAGES,
        "--index-url",
        _TORCH_CUDA_INDEX,
    ]
    if run(cmd, cwd=REPO_ROOT) != 0:
        # 不抛错：CPU 版已经装好了，分离照样能跑，只是慢（§2.5 降级不终止）
        log("CUDA 版 torch 安装失败，继续用 CPU 版（分离会慢很多）")


def install_python_deps(uv: str, extras: tuple[str, ...]) -> None:
    """装 Python 3.12 与全部所需 extras，装进仓库根的 `.venv/`。

    `.venv/` 就是应用私有目录：不需要 sudo，不碰系统 Python（§2.4 明确
    "系统 Python 是 3.14，项目用 3.12，由 uv 管理，不动系统 Python"），
    卸载即删目录。

    **必须一次把所有要装的 extra 全列上。** `uv sync` 会把 venv 收敛到
    "本次命令声明的那些依赖"，只列一部分会把上次装好的其他 extra **剪掉**——
    表现为昨天还能用的分离功能今天报缺包，而用户什么都没删。
    """
    log(f"确保 Python {PYTHON_VERSION} 可用")
    if run([uv, "python", "install", PYTHON_VERSION]) != 0:
        raise SetupError(
            f"`uv python install {PYTHON_VERSION}` 失败",
            fix=f"uv python install {PYTHON_VERSION}",
        )

    gpu = detect_nvidia_gpu()
    want_cuda = gpu is not None and gpu[1] >= _MIN_DRIVER_CUDA

    extra_args = [arg for extra in extras for arg in ("--extra", extra)]
    log(f"安装 Python 依赖（extras: {', '.join(extras)}）")
    cmd = [uv, "sync", "--python", PYTHON_VERSION, *extra_args]
    if want_cuda:
        # **把 torch 三件套排除在 sync 之外**，否则每次跑 setup 都会按 uv.lock
        # 把已经装好的 CUDA 版覆盖回 CPU 版——而且一声不吭，用户只会发现
        # 分离忽然又变慢了（实测 `uv sync --dry-run` 确实是
        # `- torch==2.13.0+cu130  + torch==2.13.0`）。装 CUDA 版那一步在下面单独做。
        #
        # **两个开关缺一不可，这是实测出来的**：只给 `--no-install-package`，
        # uv 仍会把"不符合 lock"的 CUDA 版**卸掉却不装回任何东西**，环境里直接
        # 没有 torch；只给 `--inexact`，它照样执行替换。两个一起才是"这三个包
        # 原样别动"。
        cmd.append("--inexact")
        cmd += [arg for pkg in _TORCH_PACKAGES for arg in ("--no-install-package", pkg)]
    if run(cmd, cwd=REPO_ROOT) != 0:
        raise SetupError("`uv sync` 失败", fix=" ".join(cmd))

    if gpu is None:
        return
    name, (major, minor) = gpu
    if not want_cuda:
        log(
            f"发现 {name}，但驱动只支持到 CUDA {major}.{minor}"
            f"（需要 {_MIN_DRIVER_CUDA[0]}.{_MIN_DRIVER_CUDA[1]}+），继续用 CPU 版 torch"
        )
        return
    if _torch_is_cuda():
        log(f"CUDA 版 torch 已就绪（{name}）")
        return
    install_cuda_torch(uv)


def _torch_is_cuda() -> bool:
    """当前 venv 里装的是不是 CUDA 版 torch。

    只读包元数据里的版本号（`2.13.0+cu130`），**不 import torch**：那要几秒，
    而且装坏的 torch 会直接把进程带走（§2.6 要求 torch 一律隔在子进程里问）。
    """
    py = venv_python()
    if not py.is_file():
        return False
    code = (
        "import importlib.metadata as m;"
        "print(m.version('torch'))"
    )
    try:
        out = subprocess.run(
            [str(py), "-c", code],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "+cu" in out


def frontend_needs_install() -> bool:
    """判据不是"node_modules 在不在"，而是"装的那份和锁文件对不对得上"。

    `npm install` 会把当时用的锁文件复制成 `node_modules/.package-lock.json`。
    源锁文件更新过而它没更新，就说明依赖已经过期——只看目录存在会把这种
    最常见的状态报成"已装好"，然后前端在运行时才因缺包白屏。
    """
    if not (FRONTEND_DIR / "package.json").is_file():
        return False
    installed = FRONTEND_DIR / "node_modules" / ".package-lock.json"
    source = FRONTEND_DIR / "package-lock.json"
    if not (FRONTEND_DIR / "node_modules").is_dir() or not installed.is_file():
        return True
    if not source.is_file():
        return False
    return source.stat().st_mtime > installed.stat().st_mtime + 1


def install_frontend_deps() -> None:
    """装前端依赖到 `frontend/node_modules/`（同样是项目私有目录）。

    **不自动装 Node.js**：与 uv 同理，那是下载并执行外部安装器。
    """
    if shutil.which("npm") is None:
        raise SetupError(
            "找不到 npm（随 Node.js 一起安装）——前端无法启动。",
            fix=(
                "brew install node"
                if sys.platform == "darwin"
                else "winget install --id OpenJS.NodeJS.LTS"
            ),
        )
    if not frontend_needs_install():
        log("前端依赖已是最新，跳过 npm install")
        return
    log("安装前端依赖")
    npm = shutil.which("npm") or "npm"
    if run([npm, "install"], cwd=FRONTEND_DIR) != 0:
        raise SetupError("`npm install` 失败", fix="cd frontend && npm install")


# ---------------------------------------------------------------------------
# 自检阶段：一律委托给 kvm.doctor，本脚本不自己写探测
# ---------------------------------------------------------------------------


def doctor_command(extra_args: list[str]) -> tuple[list[str], dict[str, str]]:
    """拼出跑 `kvm.doctor` 的命令。

    用 venv 里的解释器跑，而不是当前这个：自检要报告的是**项目环境**装了什么、
    torch 会用什么设备，拿引导用的系统 Python 去问只会得到一份和实际运行环境
    无关的报告。venv 还没建好时退回当前解释器，至少能报出"缺 uv/缺 ffmpeg"。
    """
    python = venv_python()
    exe = str(python) if python.is_file() else sys.executable
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(BACKEND_DIR), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
    )
    return [exe, "-m", "kvm.doctor", *extra_args], env


def run_doctor(extra_args: list[str]) -> int:
    cmd, env = doctor_command(extra_args)
    return subprocess.call(cmd, env=env, cwd=str(REPO_ROOT))


def doctor_json(extra_args: list[str]) -> dict:
    cmd, env = doctor_command([*extra_args, "--json"])
    out = subprocess.run(cmd, env=env, cwd=str(REPO_ROOT), capture_output=True, text=True)
    try:
        return json.loads(out.stdout)
    except ValueError:
        return {
            "ok": False,
            "checks": [],
            "error": (out.stderr or out.stdout or "自检无输出").strip()[-800:],
        }


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python3 scripts/setup.py",
        description="一键检测环境并安装依赖。能自动装的自动装，装不了的给出可直接复制的命令。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "不会自动做的事（有意为之）：\n"
            "  - 不下载 ffmpeg / Node.js / uv 的二进制（那是下载并执行外部程序）\n"
            "  - 不下载模型权重（§5.14：静默拉 1.3 GB 会被当成程序卡死，必须是显式动作）\n"
            "  - 不碰系统 Python，一切装进仓库内的 .venv/ 与 frontend/node_modules/"
        ),
    )
    p.add_argument("--check-only", action="store_true", help="只自检，不安装任何东西")
    p.add_argument(
        "--minimal", action="store_true", help=f"只装 {'/'.join(MINIMAL_EXTRAS)}（不拉 torch）"
    )
    p.add_argument("--no-frontend", action="store_true", help="跳过前端依赖")
    p.add_argument("--skip-torch", action="store_true", help="自检时跳过 torch 探测（省几秒）")
    p.add_argument("--json", action="store_true", help="输出机器可读的自检结果")
    p.add_argument("--copy", action="store_true", help="把自检报告复制到剪贴板")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    doctor_args: list[str] = []
    if args.skip_torch:
        doctor_args.append("--skip-torch")

    if not args.check_only:
        try:
            uv = uv_bin()
            install_python_deps(uv, MINIMAL_EXTRAS if args.minimal else ALL_EXTRAS)
            if not args.no_frontend:
                install_frontend_deps()
        except SetupError as exc:
            # 安装阶段失败也要**接着跑自检**：用户最需要的是一份完整的环境快照，
            # 而不是在第一个错误处戛然而止、还得自己一项项去查别的哪里也不对。
            print(f"\n[失败] {exc}", file=sys.stderr)
            if exc.fix:
                print(f"        请执行：{exc.fix}\n", file=sys.stderr)
            if args.json:
                print(
                    json.dumps({"ok": False, "error": str(exc), "fix": exc.fix}, ensure_ascii=False)
                )
                return 1
            print("继续执行自检，以便一次列出全部问题：\n", file=sys.stderr)
            run_doctor(doctor_args)
            return 1

    if args.json:
        # 只跑一次自检：它要起 torch 子进程、跑 ffmpeg -filters，
        # 为了拿退出码再跑一遍纯属浪费好几秒。
        result = doctor_json(doctor_args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1

    print()
    if args.copy:
        doctor_args.append("--copy")
    code = run_doctor(doctor_args)
    if code == 0 and not args.check_only:
        print("\n环境就绪。启动：python3 scripts/dev.py")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
