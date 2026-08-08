"""定位一个**真的能烧 ASS 字幕**的 ffmpeg（CLAUDE.md §2.6 三段式的"查找"阶段）。

原型是 `experiments/ffmpeg_locate.py`（实测证据，保留原样不动）；这里是它的
生产落点——生产代码不再 import `experiments/`，否则后端必须靠
`PYTHONPATH=backend:.` 才能启动，打包时必挂。

判据是**实际能力而非存在性**：以 `ass` 滤镜是否注册为准，不看版本号。
Homebrew 主线 `ffmpeg` formula 不含 libass，`ffmpeg@6` 含但版本旧，
`which ffmpeg` 拿到的那个不一定可用（CLAUDE.md §2.4）。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

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


def has_libass(binary: str) -> bool:
    """判断该 ffmpeg 是否真的能渲染 ASS。

    只查 buildconf 不够 —— 以滤镜是否注册为准，这才是实际可用性。
    """
    try:
        out = subprocess.run(
            [binary, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(line.split()[1:2] == ["ass"] for line in out.splitlines() if line.strip())


def find_ffmpeg_with_libass() -> str:
    """返回第一个带 libass 的 ffmpeg 路径，找不到则抛错。"""
    for cand in CANDIDATES:
        path = cand if Path(cand).is_file() else shutil.which(cand)
        if path and has_libass(path):
            return path
    msg = (
        "找不到带 libass 的 ffmpeg。macOS 上 Homebrew 主线 ffmpeg 不含 libass，"
        "可用 `brew install ffmpeg@6`，或自建带 --enable-libass 的构建。"
    )
    raise RuntimeError(msg)


def libass_version(binary: str) -> str:
    """从 ffmpeg 链接的动态库里读出 libass 版本，用于 §5.12 的同源校验。"""
    try:
        out = subprocess.run(
            ["otool", "-L", binary], capture_output=True, text=True, timeout=30
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    for line in out.splitlines():
        if "libass" in line:
            return line.strip().split(" ")[0]
    return "unknown（可能为静态链接）"
