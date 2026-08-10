"""环境自检（CLAUDE.md §2.6「查找」阶段 + §9 第 9 条）。

> 启动自检必须先于任何长任务。宁可开机多花两秒，也不要让用户等 20 分钟
> 分离完才发现 ffmpeg 不能烧字幕。

## 为什么自检是模块而不是脚本

它有三个调用方，逻辑只能有一份：

1. `scripts/setup.py`（一键装依赖）装完之后跑它做验收；
2. `scripts/dev.py`（一键启动）在拉起前后端**之前**跑它，硬前提不满足就不启动；
3. 将来后端启动/界面"环境"面板也要跑它（§2.6 要求自检先于长任务，
   §8.8 要求错误可结构化下发给前端翻译——所以每条检查都带稳定的 `key`）。

本仓已经吃过"同一规则两份实现漂移"的亏（`collectParts` 在两个文件里各有一份，
改了一处另一处仍是坏的）。所以脚本一律是本模块的薄壳，不许自己再写一遍探测。

## 硬性约束：本模块必须 stdlib-only

自检要在**依赖还没装好**的环境里跑——那正是最需要它的时刻。因此：

- 顶层只 import 标准库与 `kvm.paths`/`kvm.media.ffmpeg`（两者也都是 stdlib-only）；
- 任何第三方包（pydantic / torch / fontTools…）一律用 `importlib.util.find_spec`
  **探测而不导入**；
- **torch 必须在子进程里问**，绝不在本进程 import：§5.13 明令后端进程不得直接
  拉起 torch（MPS 不 fork-safe），而本模块将来要被后端调用；而且一个装坏的
  torch 能直接段错误，那会把自检本身带走——最需要报告的时候恰好没有报告。

## 判据一律是"实际能力"而不是"存在性"

§2.6 写死的原则。具体到本模块：ffmpeg 看 `ass` 滤镜有没有注册（不是看版本号、
不是看 `which ffmpeg` 找不找得到）；Python 包看 `find_spec` 而不是看目录在不在；
torch 看 `cuda.is_available()` 的真实返回值——PyPI 的 Windows torch wheel 是
CPU-only，不显式打给用户看，他会以为自己那块 4090 在干活（§6.4）。

## 自检不下载任何东西

模型权重只报告"有没有"。§5.14：绝不让 transformers / huggingface_hub 在后台
静默拉 1.26 GB 权重——弱网下用户会以为程序卡死。下载必须是显式动作。
"""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

from kvm import paths
from kvm.media import ffmpeg as ffmpeg_mod

Status = Literal["ok", "warn", "fail", "skip"]

_STATUS_LABEL: dict[str, str] = {
    "ok": "通过",
    "warn": "警告",
    "fail": "失败",
    "skip": "跳过",
}

# 分离/对齐/引导声的模型权重加起来 1.3–2.5 GB，一首歌的中间产物 3–5 GB
# （CLAUDE.md §5.13 磁盘预算）。低于这个数就该提醒，而不是等烧录到一半没空间。
_DISK_WARN_GB = 15.0

# Node 18 是 Vite 6 的下限；本机用 22 验证过。
_NODE_MIN_MAJOR = 18


@dataclass(frozen=True)
class CheckResult:
    """一条检查的结果。

    `key` 是**稳定标识**，不是展示文案：§8.8 要求后端不再往前端吐中文散文，
    界面文案由前端按 key 翻译。这里的 `title`/`detail` 只服务命令行报告。
    """

    key: str
    title: str
    status: Status
    detail: str
    fix: str | None = None
    """不通过时**可直接复制粘贴执行**的命令。§2.6：不要只说"请安装 X"。"""
    blocking: bool = False
    """不满足就不该启动（`scripts/dev.py` 据此决定拦不拦）。"""
    affects: str = ""
    """非阻断项不满足时，具体哪些功能会不可用——用户得知道自己在放弃什么。"""


@dataclass
class Report:
    checks: list[CheckResult] = field(default_factory=list)
    generated_at: str = ""

    @property
    def failures(self) -> list[CheckResult]:
        return [c for c in self.checks if c.status == "fail"]

    @property
    def blocking_failures(self) -> list[CheckResult]:
        return [c for c in self.failures if c.blocking]

    @property
    def warnings(self) -> list[CheckResult]:
        return [c for c in self.checks if c.status == "warn"]

    @property
    def ok(self) -> bool:
        """没有阻断性失败即为可启动——警告不拦人（§2.5 失败要降级不能终止）。"""
        return not self.blocking_failures


# ---------------------------------------------------------------------------
# 各项检查
# ---------------------------------------------------------------------------


def check_platform() -> CheckResult:
    """支持矩阵：macOS Apple Silicon / Windows x64（CLAUDE.md §2.2）。

    **Intel Mac 是明确的 fail 而不是 warn**：PyTorch 2.2 之后停止支持 Intel
    macOS，人声分离基本无解。这不是"可能有点问题"，是这条路走不通。
    """
    system, machine = platform.system(), platform.machine().lower()
    desc = f"{system} {platform.release()} {platform.machine()}"

    if system == "Darwin":
        if machine in {"arm64", "aarch64"}:
            return CheckResult("platform", "平台", "ok", f"{desc}（支持矩阵内）")
        return CheckResult(
            "platform",
            "平台",
            "fail",
            f"{desc}——不支持 Intel Mac：PyTorch 2.2 之后停止支持 Intel macOS，人声分离不可用",
            fix="换用 Apple Silicon 机器，或 Windows x64",
            blocking=True,
        )
    if system == "Windows":
        if machine in {"amd64", "x86_64"}:
            return CheckResult(
                "platform",
                "平台",
                "warn",
                f"{desc}（在支持矩阵内，但尚未在 Windows 上实测）",
            )
        return CheckResult(
            "platform", "平台", "warn", f"{desc}——Windows 仅设计支持 x64", blocking=False
        )
    return CheckResult(
        "platform",
        "平台",
        "warn",
        f"{desc}——不在支持矩阵（macOS arm64 / Windows x64）内，多数功能仍可用但未经验证",
    )


def check_python() -> CheckResult:
    """跑自检的这个解释器是不是项目要的 3.12。

    系统 Python 是 3.14，项目要 3.12，由 uv 管理、**不动系统 Python**
    （CLAUDE.md §2.4）。所以这里报的是"当前解释器"，不是"机器上有没有 3.12"。
    """
    v = sys.version_info
    where = sys.executable
    in_venv = sys.prefix != sys.base_prefix
    # 报告是纯文本，`**非**` 会原样打出来。要强调就用词本身强调，不要用 Markdown 标记
    venv_note = "虚拟环境" if in_venv else "非虚拟环境"
    detail = f"Python {v.major}.{v.minor}.{v.micro}（{venv_note}）：{where}"
    if (v.major, v.minor) == (3, 12):
        return CheckResult("python", "Python", "ok", detail)
    return CheckResult(
        "python",
        "Python",
        "fail",
        detail + "——项目要求 3.12（pyproject 的 requires-python 是 >=3.12,<3.13）",
        fix="uv python install 3.12 && uv sync --all-extras",
        blocking=True,
    )


def _tool_version(cmd: str, *args: str) -> tuple[str | None, str | None]:
    """跑一个 `--version` 拿版本串。返回 (可执行文件路径, 版本首行)。"""
    binary = shutil.which(cmd)
    if binary is None:
        return None, None
    try:
        out = subprocess.run(
            [binary, *args],
            capture_output=True,
            text=True,
            # 编码显式给：中文 Windows 的 locale 是 cp936，解不了这些工具的输出。
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return binary, None
    text = (out.stdout or out.stderr or "").strip()
    return binary, text.splitlines()[0].strip() if text else None


def check_uv() -> CheckResult:
    binary, version = _tool_version("uv", "--version")
    if binary is None:
        return CheckResult(
            "uv",
            "uv",
            "fail",
            "未找到 uv——它负责装 Python 3.12 与全部 Python 依赖",
            fix=(
                'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
                if sys.platform.startswith("win")
                else "curl -LsSf https://astral.sh/uv/install.sh | sh"
            ),
            blocking=True,
        )
    return CheckResult("uv", "uv", "ok", f"{version or '版本未知'}：{binary}")


def check_node() -> CheckResult:
    binary, version = _tool_version("node", "--version")
    if binary is None:
        return CheckResult(
            "node",
            "Node.js",
            "fail",
            "未找到 node——前端无法启动",
            fix=(
                "brew install node"
                if sys.platform == "darwin"
                else "winget install --id OpenJS.NodeJS.LTS"
            ),
            blocking=True,
        )
    major = 0
    if version and version.lstrip("v").split(".")[0].isdigit():
        major = int(version.lstrip("v").split(".")[0])
    if major and major < _NODE_MIN_MAJOR:
        return CheckResult(
            "node",
            "Node.js",
            "fail",
            f"{version}：{binary}——Vite 6 要求 Node {_NODE_MIN_MAJOR}+",
            fix="升级 Node 到 LTS（20 或 22）",
            blocking=True,
        )
    return CheckResult("node", "Node.js", "ok", f"{version or '版本未知'}：{binary}")


def check_npm() -> CheckResult:
    binary, version = _tool_version("npm", "--version")
    if binary is None:
        return CheckResult(
            "npm",
            "npm",
            "fail",
            "未找到 npm（通常随 Node.js 一起安装）",
            fix="重装 Node.js LTS",
            blocking=True,
        )
    return CheckResult("npm", "npm", "ok", f"{version or '版本未知'}：{binary}")


def check_frontend_deps(repo_root: Path | None) -> CheckResult:
    """前端依赖是否装好、是否已过期。

    判据不是"目录在不在"：`npm install` 会在 `node_modules/.package-lock.json`
    留下它当时装的那份锁文件副本，比源 `package-lock.json` 旧就说明该重装了。
    只看目录存在会让"锁文件更新过但没重装"这种最常见的状态显示为通过。
    """
    if repo_root is None:
        return CheckResult(
            "frontend_deps",
            "前端依赖",
            "skip",
            "未在源码检出中运行，跳过（打包后的应用不带前端源码）",
        )
    frontend = repo_root / "frontend"
    if not (frontend / "package.json").is_file():
        return CheckResult("frontend_deps", "前端依赖", "skip", f"没有 {frontend}/package.json")

    installed_lock = frontend / "node_modules" / ".package-lock.json"
    source_lock = frontend / "package-lock.json"
    fix = "cd frontend && npm install"
    if not (frontend / "node_modules").is_dir():
        return CheckResult(
            "frontend_deps",
            "前端依赖",
            "fail",
            "frontend/node_modules 不存在",
            fix=fix,
            blocking=True,
        )
    stale = (
        installed_lock.is_file()
        and source_lock.is_file()
        # 容 1 秒：同一次 npm install 里两个文件的 mtime 可能差几十毫秒，
        # 严格比大小会把刚装好的依赖报成过期。
        and source_lock.stat().st_mtime > installed_lock.stat().st_mtime + 1
    )
    if stale:
        return CheckResult(
            "frontend_deps",
            "前端依赖",
            "warn",
            "package-lock.json 比已安装的那份新，依赖可能已过期",
            fix=fix,
            affects="前端可能因缺包而白屏或行为与预期不符",
        )
    return CheckResult("frontend_deps", "前端依赖", "ok", f"已安装：{frontend / 'node_modules'}")


def check_ffmpeg() -> list[CheckResult]:
    """ffmpeg / ffprobe / libass 三条。

    **判据是 `ass` 滤镜有没有注册，不是版本号、不是 `which ffmpeg` 找不找得到。**
    Homebrew 主线 `ffmpeg` formula 不含 libass——这是 macOS 上最常见安装路径的
    默认行为，不是个例配置问题（CLAUDE.md §6.4）。装了 ffmpeg 却烧不了字幕，
    正是本项目最容易踩的那个坑，所以这条是阻断项。
    """
    probe = ffmpeg_mod.probe_ffmpeg()
    tried = "；".join(f"{where} → {verdict}" for where, verdict in probe.tried) or "无候选"

    if not probe.ok:
        detail = probe.override_rejected or (f"没有任何候选注册了 ass 滤镜。已探测：{tried}")
        return [
            CheckResult(
                "ffmpeg",
                "ffmpeg（带 libass）",
                "fail",
                detail,
                # 首选让应用自己去取（§2.6：用户不该为了跑起这个工具手动 brew install
                # 任何东西），系统包管理器的写法作为退路一并给出。
                fix=(
                    probe.override_rejected
                    and f"unset {ffmpeg_mod.ENV_FFMPEG}  # 或把它指向一个带 libass 的 ffmpeg"
                )
                or (
                    "PYTHONPATH=backend uv run python -m kvm.bootstrap --fetch ffmpeg"
                    f"    # 自动装进应用私有目录；或手动：{ffmpeg_mod.install_hint()}"
                ),
                blocking=True,
            )
        ]

    results = [
        CheckResult(
            "ffmpeg",
            "ffmpeg（带 libass）",
            "ok",
            f"{probe.path}（来源：{probe.origin}）\n         {probe.version or '版本未知'}",
        )
    ]

    ffprobe_bin = ffmpeg_mod.ffprobe_for(probe.path or "")
    if Path(ffprobe_bin).is_file() or shutil.which(ffprobe_bin):
        results.append(CheckResult("ffprobe", "ffprobe", "ok", ffprobe_bin))
    else:
        results.append(
            CheckResult(
                "ffprobe",
                "ffprobe",
                "fail",
                "找不到与 ffmpeg 同源的 ffprobe——时长/起始偏移探测、波形、代理视频都要用它",
                fix=ffmpeg_mod.install_hint(),
                blocking=True,
            )
        )

    # libass 版本只报告不判定：§5.12 要求预览（JASSUB）与导出（ffmpeg）用**同一个
    # libass commit**，但"两端是否同源"要靠像素回归来证，光比版本号证明不了，
    # 而且 macOS 之外根本读不出版本。这里如实展示，不假装校验过。
    results.append(
        CheckResult(
            "libass",
            "libass",
            "warn",
            f"{probe.libass or 'unknown'}——与预览端打包的 libass 是否同源尚无自动校验",
            affects="预览与导出可能在描边、模糊等细节上存在差异",
        )
    )
    return results


# 各 extra 提供的模块。键是 pyproject 的 extra 名，值是 (import 名, 发行包名)。
# **import 名与包名经常不一致**，写错会把装好的依赖报成缺失：
# python-multipart → multipart、pycryptodome → Crypto、fonttools → fontTools。
_EXTRA_MODULES: dict[str, tuple[tuple[str, str], ...]] = {
    "api": (
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("pydantic", "pydantic"),
        ("multipart", "python-multipart"),
        ("httpx", "httpx"),
    ),
    "fonts": (("fontTools", "fonttools"), ("brotli", "brotli")),
    "audio": (
        ("librosa", "librosa"),
        ("numba", "numba"),
        ("soundfile", "soundfile"),
        ("torchcrepe", "torchcrepe"),
    ),
    "separate": (("audio_separator", "audio-separator"), ("onnxruntime", "onnxruntime")),
    "download": (("yt_dlp", "yt-dlp"),),
    "lyrics": (("requests", "requests"), ("Crypto", "pycryptodome")),
}

# extra 缺失时具体失去什么功能，以及它是不是启动的硬前提。
_EXTRA_META: dict[str, tuple[bool, str]] = {
    "api": (True, "后端 HTTP 服务——整个界面都依赖它"),
    "fonts": (False, "字体扫描、缺字检查、预览字体子集化"),
    "audio": (False, "节拍检测（开唱引导点）与引导声合成"),
    "separate": (False, "人声分离——没有它就没有 OFF VOCAL，也没有鼓轨供节拍检测"),
    "download": (False, "YouTube / bilibili 下载（仍可手工导入本地文件）"),
    "lyrics": (False, "QQ 音乐歌词搜索与 QRC 解密（仍可手工粘贴歌词）"),
}


def _module_present(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        # find_spec 对"父包存在但子模块导入失败"会抛，那也算不可用
        return False


def _dist_version(dist: str) -> str | None:
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return None


def check_python_extras() -> list[CheckResult]:
    """按 extra 分组检查 Python 依赖，缺哪一组就只报哪一组。

    用 `find_spec` **探测而不导入**：import 一遍 librosa/torch 要好几秒，
    而且装坏的包在 import 时才炸，会把自检本身带走。
    """
    results: list[CheckResult] = []
    for extra, modules in _EXTRA_MODULES.items():
        blocking, affects = _EXTRA_META[extra]
        missing = [(mod, dist) for mod, dist in modules if not _module_present(mod)]
        title = f"Python 依赖 [{extra}]"
        if not missing:
            versions = ", ".join(f"{dist} {_dist_version(dist) or '?'}" for _, dist in modules)
            results.append(CheckResult(f"extra_{extra}", title, "ok", versions))
            continue
        names = "、".join(dist for _, dist in missing)
        results.append(
            CheckResult(
                f"extra_{extra}",
                title,
                "fail" if blocking else "warn",
                f"缺少 {names}",
                fix=f"uv sync --extra {extra}",
                blocking=blocking,
                affects=affects,
            )
        )
    return results


# 在子进程里问 torch 的设备情况。**不在自检进程里 import torch**：
# §5.13 明令后端进程不得直接拉起 torch（MPS 不 fork-safe），而本模块将来要被
# 后端调用；且装坏的 torch 会段错误，在子进程里最多丢一条检查，不会带走报告。
_TORCH_PROBE = """
import json, sys
try:
    import torch
    info = {
        "version": torch.__version__,
        "cuda_available": bool(torch.cuda.is_available()),
        "cuda_device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "mps_available": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
    }
except Exception as exc:
    info = {"error": f"{type(exc).__name__}: {exc}"}
print(json.dumps(info))
"""


def check_torch(timeout: float = 120.0) -> CheckResult:
    """torch 的设备情况——**必须把 `cuda.is_available()` 显式打给用户看**。

    CLAUDE.md §6.4：PyPI 的 Windows torch wheel 是 CPU-only，不配 uv 的
    PyTorch index 就会静默得到 CPU 版，用户以为自己有 4090、结果跑了 20 分钟。
    这条检查存在的唯一理由就是把那个静默变成显式。
    """
    if not _module_present("torch"):
        return CheckResult(
            "torch",
            "torch 设备",
            "warn",
            "未安装 torch",
            fix="uv sync --extra separate --extra audio",
            affects="人声分离与引导声不可用",
        )
    try:
        out = subprocess.run(
            [sys.executable, "-c", _TORCH_PROBE],
            capture_output=True,
            text=True,
            # 编码显式给：探测脚本按 UTF-8 打印，中文 Windows 的 cp936 解不了。
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return CheckResult(
            "torch", "torch 设备", "warn", f"探测超时（>{timeout:.0f}s），torch 可能装坏了"
        )
    except OSError as exc:
        return CheckResult("torch", "torch 设备", "warn", f"探测失败：{exc}")

    try:
        info = json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        tail = (out.stderr or out.stdout or "").strip()[-300:]
        return CheckResult("torch", "torch 设备", "warn", f"探测输出无法解析：{tail}")

    if "error" in info:
        return CheckResult(
            "torch",
            "torch 设备",
            "warn",
            f"torch 已安装但 import 失败：{info['error']}",
            fix="uv sync --extra separate --extra audio",
            affects="人声分离与引导声不可用",
        )

    cuda = info["cuda_available"]
    mps = info["mps_available"]
    device = "cuda" if cuda else ("mps" if mps else "cpu")
    detail = (
        f"torch {info['version']}；cuda.is_available()={cuda}"
        f"{'（' + str(info['cuda_device']) + '）' if info.get('cuda_device') else ''}"
        f"；mps.is_available()={mps} → 实际会用 {device}"
    )
    if device == "cpu":
        return CheckResult(
            "torch",
            "torch 设备",
            "warn",
            detail + "——纯 CPU 分离会很慢（数分钟起）",
            fix=(
                "有 N 卡的话跑一次 `python3 scripts/setup.py`：它会探测显卡与驱动，"
                "自动换成 CUDA 版 torch（约 2.7 GB）。"
                "PyPI 的 Windows torch wheel 是 CPU-only，不换就一直是 CPU"
            ),
            affects="人声分离耗时可能是 GPU 的十倍以上",
        )
    return CheckResult("torch", "torch 设备", "ok", detail)


def _tier_filenames() -> list[tuple[str, str]] | None:
    """从 `kvm.media.separate.MODEL_TIERS` 取档位表——**它是唯一真相来源**。

    取不到（pydantic 没装，`kvm.api.schemas` import 不了）时返回 None，
    由调用方降级为"只列目录里有什么"。**不要在这里抄一份文件名常量**：
    抄的那份和 separate.py 一旦漂移，自检就会报告一组根本没人用的权重。
    """
    try:
        from kvm.media.separate import MODEL_TIERS
    except Exception:
        return None
    return [(t.id, t.model_filename) for t in MODEL_TIERS]


def check_models() -> CheckResult:
    """模型权重**只报告有没有，绝不下载**（CLAUDE.md §5.14）。

    静默拉 1.26 GB 权重会让弱网用户以为程序卡死，所以下载必须是显式动作。
    """
    model_dir = paths.models_dir() / "audio-separator"
    tiers = _tier_filenames()
    if not model_dir.is_dir():
        return CheckResult(
            "models",
            "分离模型权重",
            "warn",
            f"尚未下载（目录不存在：{model_dir}）",
            affects="首次分离时会自动下载 84–640 MB，需要联网并等待",
        )
    present = {p.name for p in model_dir.iterdir() if p.is_file()}
    if tiers is None:
        listing = "、".join(sorted(present)[:6]) or "（空）"
        return CheckResult(
            "models",
            "分离模型权重",
            "warn",
            f"{model_dir} 内已有：{listing}（档位表不可用，未逐档核对）",
        )
    have = [tid for tid, fn in tiers if fn in present]
    miss = [tid for tid, fn in tiers if fn not in present]
    if not miss:
        return CheckResult("models", "分离模型权重", "ok", f"三档齐备：{model_dir}")
    return CheckResult(
        "models",
        "分离模型权重",
        "warn",
        f"已有档位 {have or '无'}，缺 {miss}（{model_dir}）",
        affects="首次用到缺失档位时会自动下载 84–640 MB，需要联网并等待",
    )


def check_fonts() -> CheckResult:
    """字体只做**廉价**探测：能读字体的库在不在、系统字体目录有没有东西。

    **不在这里做缺字检查。** §2.6 要求字体缺字必须在渲染前拦截，但那是
    "本曲全部字符 + 注音假名"对具体某个字体的 cmap 覆盖判定，只有在选定
    字体与歌词之后才有意义；而全量扫系统字体要 30–40 秒，放进每次启动的
    自检里就是纯粹的等待。真正的覆盖判定在样式步骤里做。
    """
    if not _module_present("fontTools"):
        return CheckResult(
            "fonts",
            "字体",
            "warn",
            "fontTools 未安装，无法扫描系统字体、也无法做缺字检查",
            fix="uv sync --extra fonts",
            affects="样式步骤选不了字体；渲染前的缺字拦截失效",
        )
    dirs = _system_font_dirs()
    existing = [d for d in dirs if d.is_dir()]
    if not existing:
        return CheckResult(
            "fonts",
            "字体",
            "warn",
            f"找不到任何系统字体目录（已探测 {', '.join(str(d) for d in dirs)}）",
            affects="样式步骤没有可选字体",
        )
    total = sum(1 for d in existing for _ in d.rglob("*") if _.suffix.lower() in _FONT_SUFFIXES)
    return CheckResult(
        "fonts",
        "字体",
        "ok" if total else "warn",
        f"系统字体目录 {len(existing)} 个，共 {total} 个字体文件"
        "（缺字检查在样式步骤按本曲用字进行，自检不做全量扫描）",
    )


_FONT_SUFFIXES = {".ttf", ".otf", ".ttc", ".otc"}


def _system_font_dirs() -> list[Path]:
    if sys.platform == "darwin":
        return [
            Path("/System/Library/Fonts"),
            Path("/Library/Fonts"),
            Path.home() / "Library/Fonts",
        ]
    if sys.platform.startswith("win"):
        windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
        local = os.environ.get("LOCALAPPDATA")
        dirs = [windir / "Fonts"]
        if local:
            dirs.append(Path(local) / "Microsoft/Windows/Fonts")
        return dirs
    return [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts"]


def check_workspace() -> list[CheckResult]:
    """应用私有数据目录可写 + 磁盘余量。

    一首歌 = 原视频 + 音频 + 2 条 stem + 代理视频 + 成片 ×2，轻松 3–5 GB
    （§5.13）。磁盘不够的表现是烧录跑到一半失败，那时已经等了几分钟。
    """
    root = paths.app_data_root()
    results: list[CheckResult] = []
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / ".doctor_write_test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        results.append(CheckResult("data_dir", "应用数据目录", "ok", f"可写：{root}"))
    except OSError as exc:
        results.append(
            CheckResult(
                "data_dir",
                "应用数据目录",
                "fail",
                f"不可写：{root}（{exc}）",
                fix=f"检查该目录权限，或用环境变量 {paths.ENV_DATA_DIR} 指向其他位置",
                blocking=True,
            )
        )
        return results

    usage = shutil.disk_usage(_nearest_existing(root))
    free_gb = usage.free / 1024**3
    detail = f"剩余 {free_gb:.1f} GB / 共 {usage.total / 1024**3:.1f} GB（{root}）"
    if free_gb < _DISK_WARN_GB:
        results.append(
            CheckResult(
                "disk",
                "磁盘余量",
                "warn",
                detail
                + f"——单曲中间产物 3–5 GB，模型权重另需 1.3–2.5 GB，建议留 {_DISK_WARN_GB:.0f} GB 以上",
                affects="分离或烧录可能中途因磁盘写满而失败",
            )
        )
    else:
        results.append(CheckResult("disk", "磁盘余量", "ok", detail))

    results.append(_check_font_cache())
    return results


_FONT_CACHE_WARN_MB = 512.0
"""字体缓存超过这个数就提醒。

清理是自动的（`kvm.render.font_cache`：启动时删旧版本、生成后按预算裁剪），
所以正常情况下到不了这里。真到了就说明自动清理没跑或没跑动，**用户有权知道
这几百 MB 是什么、以及怎么一键清掉**——这个目录曾经长到 106 MB 而无人过问，
用户最后是自己 `rm` 掉的，那正是 §2.6 要排除的事。
"""


def _check_font_cache() -> CheckResult:
    """预览字体子集缓存占了多少。**产物是可再生的派生物，删掉只是下次重裁几秒。**"""
    from kvm.render import font_cache  # 局部导入：自检要能在依赖没装全时也跑起来

    try:
        count, total, stale = font_cache.cache_stats()
    except OSError as exc:  # pragma: no cover
        return CheckResult("font_cache", "字体缓存", "warn", f"读取失败：{exc}")

    mb = total / 1024**2
    detail = f"{count} 份 / {mb:.0f} MB（{paths.font_cache_dir()}）"
    if stale:
        detail += f"，其中 {stale} 份属于旧版本，下次启动自动清理"
    if mb >= _FONT_CACHE_WARN_MB:
        return CheckResult(
            "font_cache",
            "字体缓存",
            "warn",
            detail,
            fix="uv run python -m kvm.doctor --prune-font-cache",
            affects="只占磁盘，不影响功能；产物可再生，清理后下次预览重裁约几秒",
        )
    return CheckResult("font_cache", "字体缓存", "ok", detail)


def _nearest_existing(path: Path) -> Path:
    for candidate in [path, *path.parents]:
        if candidate.exists():
            return candidate
    return Path(path.anchor or ".")


def _bind_fails(family: int, host: str, port: int) -> str | None:
    """尝试在某个地址族上 bind，返回失败原因（成功则 None）。"""
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
    except OSError as exc:
        return exc.strerror or str(exc)
    return None


def check_port(port: int, *, label: str) -> CheckResult:
    """端口是否可用。

    两条容易写错、且都实测踩过的地方：

    1. **判据是能不能 bind，不是能不能连上。** 连不上只说明此刻没人应答，
       而 TIME_WAIT、被别的进程占着监听等情况照样会让随后的启动失败。
    2. **必须两个回环地址族都查。** 实测 Vite 只监听 IPv6 回环
       （`lsof` 显示 `[::1]:5173`，127.0.0.1 上什么都没有），只查 IPv4 会把
       一个还开着的旧 Vite 报成"端口可用"，然后 `--strictPort` 才炸；
       而 uvicorn 显式绑 127.0.0.1，只查 IPv6 又会漏掉旧后端。
       两族任一被占就算被占——本项目两个服务恰好各用一族。
    """
    key = f"port_{port}"
    attempts: list[tuple[str, str]] = []
    if (reason := _bind_fails(socket.AF_INET, "127.0.0.1", port)) is not None:
        attempts.append(("127.0.0.1", reason))
    if socket.has_ipv6 and (reason := _bind_fails(socket.AF_INET6, "::1", port)) is not None:
        attempts.append(("::1", reason))

    if attempts:
        where = "、".join(f"{host}（{reason}）" for host, reason in attempts)
        return CheckResult(
            key,
            f"{label} 端口 {port}",
            "fail",
            f"已被占用：{where}{_port_holder(port)}",
            fix=f"换端口：--{label.lower()}-port <其他端口>；或结束占用进程",
            blocking=True,
        )
    return CheckResult(key, f"{label} 端口 {port}", "ok", "可用（IPv4/IPv6 回环均空闲）")


def _port_holder(port: int) -> str:
    """尽力说清是谁占着这个端口——只说"被占用"等于让用户自己去查。"""
    if sys.platform.startswith("win"):
        cmd = ["netstat", "-ano", "-p", "TCP"]
    else:
        cmd = ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"]
    try:
        # 这里**刻意不指定 encoding**：netstat / lsof 是系统命令，按 locale 输出
        # （中文 Windows 上表头就是 GBK 中文），强按 UTF-8 解只会得到乱码。
        # 只加 errors="replace" 兜底——占用者信息读不出来不该让自检崩掉。
        out = subprocess.run(
            cmd, capture_output=True, text=True, errors="replace", timeout=15, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    lines = [ln for ln in out.splitlines() if str(port) in ln]
    return f"，占用者：{lines[0].strip()}" if lines else ""


# ---------------------------------------------------------------------------
# 组装与输出
# ---------------------------------------------------------------------------


def find_repo_root(start: Path | None = None) -> Path | None:
    """向上找带 pyproject.toml 的目录。

    找不到就返回 None（打包后的应用不带源码），调用方据此跳过与源码检出
    相关的检查，而不是报一堆"文件不存在"的假失败。
    """
    here = (start or Path(__file__).resolve()).parent
    for candidate in [here, *here.parents]:
        if (candidate / "pyproject.toml").is_file() and (candidate / "backend").is_dir():
            return candidate
    return None


def run_checks(
    *,
    repo_root: Path | None = None,
    skip_torch: bool = False,
    ports: Iterable[tuple[int, str]] = (),
) -> Report:
    """跑一遍全部检查。顺序即报告顺序：先平台/工具链，再依赖，再资源。"""
    import datetime

    root = repo_root if repo_root is not None else find_repo_root()
    checks: list[CheckResult] = [
        check_platform(),
        check_python(),
        check_uv(),
        check_node(),
        check_npm(),
        check_frontend_deps(root),
    ]
    checks.extend(check_ffmpeg())
    checks.extend(check_python_extras())
    checks.append(
        CheckResult("torch", "torch 设备", "skip", "按要求跳过") if skip_torch else check_torch()
    )
    checks.append(check_models())
    checks.append(check_fonts())
    checks.extend(check_workspace())
    checks.extend(check_port(port, label=label) for port, label in ports)

    stamp = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    return Report(checks=checks, generated_at=stamp)


def _pad(text: str, width: int) -> str:
    """按**显示宽度**补空格。

    Python 的 `f"{s:<18}"` 按字符数补，而中日文是双宽字符——直接用会让中文标题
    那几行整体右移，报告看起来像没对齐的乱码。
    """
    import unicodedata

    shown = sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)
    return text + " " * max(0, width - shown)


def render_report(report: Report) -> str:
    """渲染成可直接粘进 issue 的纯文本（§2.6：自检报告要能一键复制）。"""
    lines = ["Karaoke Video Maker 环境自检"]
    # 局部报告（如启动前单查端口）不带时间戳，那时不要留一行空的"生成时间："
    if report.generated_at:
        lines.append(f"生成时间：{report.generated_at}")
    lines += [f"解释器：{sys.executable}", "-" * 72]
    for c in report.checks:
        lines.append(f"[{_STATUS_LABEL[c.status]}] {_pad(c.title, 22)} {c.detail}")
        if c.affects and c.status in {"warn", "fail"}:
            lines.append(f"{'':8}影响：{c.affects}")
        if c.fix and c.status in {"warn", "fail"}:
            lines.append(f"{'':8}处理：{c.fix}")
    lines.append("-" * 72)

    n_ok = sum(1 for c in report.checks if c.status == "ok")
    summary = (
        f"合计 {len(report.checks)} 项：通过 {n_ok}、"
        f"警告 {len(report.warnings)}、失败 {len(report.failures)}"
    )
    lines.append(summary)
    if report.blocking_failures:
        lines.append("")
        lines.append("以下是启动的硬前提，未解决前不会启动服务：")
        lines.extend(f"  - {c.title}：{c.detail.splitlines()[0]}" for c in report.blocking_failures)
        lines.extend(f"    → {c.fix}" for c in report.blocking_failures if c.fix)
    elif report.warnings:
        lines.append("可以启动。警告项不阻断启动，各项『影响』一行列出了会失去的功能。")
    else:
        lines.append("全部通过。")
    return "\n".join(lines)


def copy_to_clipboard(text: str) -> bool:
    """把报告塞进系统剪贴板。失败返回 False——它只是便利功能，不该让自检失败。"""
    if sys.platform == "darwin":
        cmd = ["pbcopy"]
    elif sys.platform.startswith("win"):
        cmd = ["clip"]
    elif shutil.which("wl-copy"):
        cmd = ["wl-copy"]
    elif shutil.which("xclip"):
        cmd = ["xclip", "-selection", "clipboard"]
    else:
        return False
    try:
        # 同样不指定 encoding：clip.exe / pbcopy 按 locale 收字节，改成 UTF-8
        # 会让粘贴出来的中文变乱码。
        subprocess.run(cmd, input=text, text=True, errors="replace", timeout=15, check=True)
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m kvm.doctor",
        description="环境自检：ffmpeg 是否带 libass、依赖是否齐、torch 用什么设备、磁盘还剩多少。不下载任何东西。",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON，供脚本/界面消费")
    parser.add_argument(
        "--prune-font-cache",
        action="store_true",
        help="清理预览字体子集缓存（产物可再生，删掉只是下次预览重裁几秒）",
    )
    parser.add_argument("--copy", action="store_true", help="把报告复制到剪贴板")
    parser.add_argument("--skip-torch", action="store_true", help="跳过 torch 探测（省几秒）")
    parser.add_argument(
        "--port",
        action="append",
        type=int,
        default=[],
        metavar="PORT",
        help="额外检查某个端口是否可用",
    )
    args = parser.parse_args(argv)

    if args.prune_font_cache:
        # 手动入口。自动清理已经挂在启动与生成之后两处，这里是给"自检报告说它太大了"
        # 之后的那一步——§2.6 要求给出可直接粘贴执行的命令，而不是只说"太大了"
        from kvm.render import font_cache

        result = font_cache.prune_font_cache()
        print(
            f"字体缓存已清理：删除 {result.removed_files} 份"
            f"（旧版本 {result.removed_stale} / 超预算 {result.removed_overflow}），"
            f"释放 {result.freed_bytes / 1024**2:.1f} MB；"
            f"剩余 {result.kept_files} 份 {result.kept_bytes / 1024**2:.1f} MB"
        )
        return 0

    report = run_checks(
        skip_torch=args.skip_torch,
        ports=[(p, "服务") for p in args.port],
    )

    if args.json:
        print(
            json.dumps(
                {
                    "generated_at": report.generated_at,
                    "ok": report.ok,
                    "checks": [asdict(c) for c in report.checks],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        text = render_report(report)
        print(text)
        if args.copy:
            print(
                "\n（报告已复制到剪贴板）"
                if copy_to_clipboard(text)
                else "\n（剪贴板不可用，请手动复制上面的内容）"
            )
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
