"""定位一个带 libass 的 ffmpeg。

Homebrew 官方 ffmpeg formula（8.x）**不含 libass**，但 ffmpeg@6 含。
这个探测逻辑是 CLAUDE.md §11 里 `backend.doctor` 环境自检的原型。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

# 顺序即优先级。ffmpeg-full 排最前：它带齐 libass + harfbuzz + fontconfig + freetype，
# 而 Homebrew 主线 ffmpeg formula 不含 libass，ffmpeg@6 虽含 libass 但版本较旧。
# 必须固定优先级 —— 否则不同实验可能落到不同 libass 上，结论无法互相比较。
CANDIDATES = [
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


if __name__ == "__main__":
    ff = find_ffmpeg_with_libass()
    print(f"ffmpeg  : {ff}")
    print(f"libass  : {libass_version(ff)}")
