"""定位一个**真的能烧 ASS 字幕**的 ffmpeg（CLAUDE.md §2.6 三段式的"查找"阶段）。

原型是 `experiments/ffmpeg_locate.py`（实测证据，保留原样不动）；这里是它的
生产落点——生产代码不再 import `experiments/`，否则后端必须靠
`PYTHONPATH=backend:.` 才能启动，打包时必挂。

判据是**实际能力而非存在性**：以 `ass` 滤镜是否注册为准，不看版本号。
Homebrew 主线 `ffmpeg` formula 不含 libass，`ffmpeg@6` 含但版本旧，
`which ffmpeg` 拿到的那个不一定可用（CLAUDE.md §2.4）。

## 解析顺序（§2.6：所有外部可执行文件必须经由统一的解析层获取）

1. **应用私有目录** `kvm.paths.private_bin_dir()`——将来"获取"阶段下载的那份。
   排第一位是因为它的版本已知（§5.12 要求预览与导出两端 libass 同源），
   比系统上碰巧存在的那个可信。目前该目录通常为空。
2. **用户显式配置** 环境变量 `KVM_FFMPEG`。
3. **系统 PATH / 已知安装位置**探测（下面的 `CANDIDATES`）。
4. 触发自动获取——**尚未实现**，本轮不做（不自动下载并执行外部二进制），
   走到这一步就是抛错并给出可直接复制的安装命令。

**`KVM_FFMPEG` 在它那一步是权威的：设了但探测不通过就直接失败，不往下回退。**
用户明确指定了一个 ffmpeg，却被静默换成另一个去渲染，正是本项目反复要求
杜绝的"静默降级"——预览与导出用的还可能不是同一个 libass，而这类分叉要到
成片里才暴露。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from kvm import paths

ENV_FFMPEG = "KVM_FFMPEG"
"""用户显式指定 ffmpeg 的环境变量（可以是绝对路径，也可以是 PATH 里的命令名）。"""

# 顺序即优先级。ffmpeg-full 排最前：它带齐 libass + harfbuzz + fontconfig + freetype，
# 而 Homebrew 主线 ffmpeg formula 不含 libass，ffmpeg@6 虽含 libass 但版本较旧。
# 必须固定优先级 —— 否则不同进程/不同阶段可能落到不同 libass 上，
# 预览与导出的渲染结果就会分叉（CLAUDE.md §5.12 两端 libass 必须同源）。
CANDIDATES: list[str] = [
    "/opt/homebrew/bin/ffmpeg-full",
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/opt/homebrew/opt/ffmpeg@6/bin/ffmpeg",
    "/usr/local/opt/ffmpeg@6/bin/ffmpeg",
    "ffmpeg",
]

INSTALL_HINT_MACOS = "brew install ffmpeg-full"
INSTALL_HINT_WINDOWS = "winget install --id Gyan.FFmpeg.Essentials"
"""Windows 的安装指引**未经实测**（本仓从未在 Windows 上跑过，见 README）。
gyan.dev 的 "essentials"/"full" 构建都带 libass；winget 包 id 取自其官方发布页。
"""


def install_hint() -> str:
    """按平台给一条可直接复制粘贴的安装命令（§2.6：不要只说"请安装 X"）。"""
    if sys.platform == "darwin":
        return INSTALL_HINT_MACOS
    if sys.platform.startswith("win"):
        return INSTALL_HINT_WINDOWS
    return "需要带 --enable-libass 编译的 ffmpeg（发行版仓库提供的 ffmpeg 通常已带）"


def has_libass(binary: str) -> bool:
    """判断该 ffmpeg 是否真的能渲染 ASS。

    只查 buildconf 不够 —— 以滤镜是否注册为准，这才是实际可用性。
    """
    try:
        out = subprocess.run(
            [binary, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            # 编码显式给：中文 Windows 的 locale 是 cp936，解不了 ffmpeg 的输出。
            encoding="utf-8",
            errors="replace",
            timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(line.split()[1:2] == ["ass"] for line in out.splitlines() if line.strip())


def ffprobe_for(ffmpeg_bin: str) -> str:
    """取与该 ffmpeg 同目录的 ffprobe，取不到就退回 PATH 里的同名命令。

    **必须与 ffmpeg 同源**：ffprobe 报的时长/起始偏移会直接进时间轴计算，
    两个不同构建之间的差异会变成对不上的轴。

    **扩展名跟着 ffmpeg 走**：Windows 上私有目录里的文件是 `ffprobe.exe`，
    写死无后缀名会找不到它，从而静默退回 PATH 里的另一个构建——正是这个函数
    要防的事。
    """
    ffmpeg_path = Path(ffmpeg_bin)
    candidate = ffmpeg_path.with_name(f"ffprobe{ffmpeg_path.suffix}")
    return str(candidate) if candidate.is_file() else "ffprobe"


def _resolve_candidate(cand: str) -> str | None:
    """把候选项（绝对路径或命令名）解析成实际存在的可执行文件路径。"""
    if Path(cand).is_file():
        return cand
    return shutil.which(cand)


@dataclass(frozen=True)
class FfmpegProbe:
    """一次 ffmpeg 探测的完整结果，供自检报告使用。

    与 `find_ffmpeg_with_libass()` 的区别只在于**不抛异常**：自检要把"查了哪些
    位置、各自为什么不合格"原样报给用户，抛异常就只剩一句"找不到"。
    """

    path: str | None
    """选中的 ffmpeg 路径；None 表示没有任何候选通过能力探测。"""
    version: str | None
    """`ffmpeg -version` 的第一行，仅供展示——**判据从来不是版本号**。"""
    origin: str
    """选中的这份来自解析顺序的哪一步，出问题时第一眼要看的就是它。"""
    libass: str | None
    """动态链接的 libass 路径/版本；静态链接或非 macOS 上为 None（读不出来）。"""
    tried: list[tuple[str, str]] = field(default_factory=list)
    """(候选位置, 判定结果) 全表，包括被跳过与被否决的。"""
    override_rejected: str | None = None
    """`KVM_FFMPEG` 指定了却不合格时的原因；非 None 时**不允许回退**到别的候选。"""

    @property
    def ok(self) -> bool:
        return self.path is not None


def probe_ffmpeg() -> FfmpegProbe:
    """按 §2.6 的解析顺序找一个带 libass 的 ffmpeg，并留下完整审计轨迹。"""
    tried: list[tuple[str, str]] = []

    def _check(where: str, cand: str, origin: str) -> FfmpegProbe | None:
        resolved = _resolve_candidate(cand)
        if resolved is None:
            tried.append((where, "不存在"))
            return None
        if not has_libass(resolved):
            tried.append((where, "存在，但没有注册 ass 滤镜（不带 libass）"))
            return None
        tried.append((where, "可用"))
        return FfmpegProbe(
            path=resolved,
            version=_version_line(resolved),
            origin=origin,
            libass=libass_version(resolved),
            tried=tried,
        )

    # 1. 应用私有目录
    private = paths.private_bin_dir() / (
        "ffmpeg.exe" if sys.platform.startswith("win") else "ffmpeg"
    )
    if private.exists():
        found = _check(str(private), str(private), "应用私有目录")
        if found is not None:
            return found

    # 2. 用户显式配置——设了就必须用它，不合格直接失败，不静默换人
    override = os.environ.get(ENV_FFMPEG)
    if override:
        found = _check(f"{ENV_FFMPEG}={override}", override, f"{ENV_FFMPEG} 环境变量")
        if found is not None:
            return found
        reason = tried[-1][1]
        return FfmpegProbe(
            path=None,
            version=None,
            origin=f"{ENV_FFMPEG} 环境变量",
            libass=None,
            tried=tried,
            override_rejected=(
                f"{ENV_FFMPEG} 指向 {override}——该文件{reason}。"
                f"显式指定的 ffmpeg 不合格时不会自动切换到其他候选，"
                f"需要修正或清除 {ENV_FFMPEG}。"
            ),
        )

    # 3. 系统 PATH / 已知安装位置
    for cand in CANDIDATES:
        found = _check(cand, cand, "系统探测")
        if found is not None:
            return found

    # 4. 自动获取尚未实现，到这里就是失败
    return FfmpegProbe(path=None, version=None, origin="未找到", libass=None, tried=tried)


def find_ffmpeg_with_libass() -> str:
    """返回第一个带 libass 的 ffmpeg 路径，找不到则抛错。"""
    result = probe_ffmpeg()
    if result.path is not None:
        return result.path
    if result.override_rejected:
        raise RuntimeError(result.override_rejected)
    msg = (
        "找不到带 libass 的 ffmpeg。macOS 上 Homebrew 主线 ffmpeg 不含 libass；"
        f"安装命令：`{install_hint()}`，或将可用的 ffmpeg 路径写入环境变量 {ENV_FFMPEG}。"
    )
    raise RuntimeError(msg)


def _version_line(binary: str) -> str | None:
    try:
        out = subprocess.run(
            [binary, "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return out.splitlines()[0].strip() if out.strip() else None


def libass_version(binary: str) -> str:
    """从 ffmpeg 链接的动态库里读出 libass 版本，用于 §5.12 的同源校验。

    只在 macOS 上读得到（`otool`）。**没有跨平台的办法从 ffmpeg 命令行问出
    libass 版本**：`-version` 只给 configure 开关，`-h filter=ass` 也不含版本。
    Windows/Linux 上如实返回 unknown，不要为了填满这一栏去猜。
    """
    if sys.platform != "darwin":
        return "unknown（本平台无法从 ffmpeg 读出 libass 版本）"
    try:
        out = subprocess.run(
            ["otool", "-L", binary],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    for line in out.splitlines():
        if "libass" in line:
            return line.strip().split(" ")[0]
    return "unknown（可能为静态链接）"
