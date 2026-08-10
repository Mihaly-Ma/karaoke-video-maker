"""媒体探测（ffprobe）。

## 为什么需要这一层

前端此前靠 Range 请求 + 手写 RIFF chunk 遍历去拿每条轨的时长/采样率/体积——
这只对当前固定输出 WAV 的管线有效，换一种容器（分离产物变成 FLAC，或者
Windows 上装出来的 ffmpeg 恰好选了别的中间格式）就立刻退化成显示"—"。

更具体的坑：**ffmpeg 写 WAV 时会在 `fmt ` 与 `data` 之间插入 `LIST/INFO`
标签块**（本项目实测踩过，见前端那个手写解析器的注释）。手搓的 RIFF 遍历器
很容易假设 `data` 紧跟在 `fmt ` 后面而被这类可选 chunk 绊倒。ffprobe 走的是
libavformat 的正规解复用路径，不会有这个问题——这正是"不要在后端也手搓格式
解析"这条纪律要落地的地方：探测一律交给 ffprobe，不自己读字节。

## 缓存

探测本身很快（单次 ffprobe 通常几十毫秒），"浪费"的不是 CPU 时间而是重复
spawn 子进程这件事本身——每次打开工程都对着全部轨道各起一次 ffprobe。
缓存键用 `(路径, mtime_ns, size)`，**不用内容哈希**：ffprobe 比对内容哈希
（要整份读一遍文件）便宜得多，为了省一次 ffprobe 反而去读一遍上百 MB 的文件
是本末倒置——这与 `kvm.media.waveform`（解码本身就要整份读文件，哈希只是零头）
的取舍刻意不同。
"""

from __future__ import annotations

import dataclasses
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROBE_VERSION = "1"


@dataclass(frozen=True)
class TrackProbe:
    """一条媒体轨的探测结果。

    `exists=False` 时只有 `error` 有意义：调用方传入的路径在磁盘上找不到
    （工程记录着路径，但文件被移动/清理了）。这不是路由层该拦的"这个 kind
    压根没有素材"（那种情况路由层直接 404），而是"自动环节的错误必须可见，
    不能终止"的一个具体样例——批量探测多条轨时，一条读失败不该连累其余轨
    （CLAUDE.md §2.5）。
    """

    exists: bool
    error: str = ""

    duration_ms: int = 0
    size_bytes: int = 0

    sample_rate_hz: int | None = None
    channels: int | None = None
    audio_codec: str = ""

    width: int | None = None
    height: int | None = None
    fps: float | None = None
    video_codec: str = ""


# 进程内内存缓存：覆盖"同一进程生命周期内反复探测同一条轨"这一多数情形，
# 命中不必再摸一次磁盘上的 JSON。键是路径字符串，值是 `(mtime_ns, size, 探测结果)`。
_MEM_CACHE: dict[str, tuple[int, int, TrackProbe]] = {}


def _parse_fraction(value: str | None) -> float | None:
    """把 ffprobe 的 `24000/1001` 这类分数帧率转成浮点。"""
    if not value:
        return None
    if "/" in value:
        num, _, den = value.partition("/")
        try:
            denominator = float(den)
            return float(num) / denominator if denominator else None
        except ValueError:
            return None
    try:
        return float(value)
    except ValueError:
        return None


def _ffprobe_json(ffprobe_bin: str, path: Path) -> dict[str, Any]:
    proc = subprocess.run(
        [ffprobe_bin, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return json.loads(proc.stdout or "{}")


def probe_track(ffprobe_bin: str, path: Path) -> TrackProbe:
    """探测单条轨道。文件不存在或探测失败都不抛异常——统一落到
    `TrackProbe(exists=False, error=...)`，由调用方（路由层/批量探测）决定
    要不要把它当成硬错误。
    """
    if not path.is_file():
        return TrackProbe(exists=False, error=f"媒体文件不存在（可能已被移动/清理）：{path}")

    try:
        meta = _ffprobe_json(ffprobe_bin, path)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as exc:
        return TrackProbe(exists=True, error=f"探测失败（文件可能已损坏）：{exc}")

    streams = meta.get("streams", [])
    fmt = meta.get("format", {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    video = next((s for s in streams if s.get("codec_type") == "video"), None)

    duration_raw = (
        fmt.get("duration") or (audio or {}).get("duration") or (video or {}).get("duration")
    )
    size_raw = fmt.get("size")
    try:
        size_bytes = int(size_raw) if size_raw else path.stat().st_size
    except OSError:
        size_bytes = 0

    return TrackProbe(
        exists=True,
        duration_ms=round(float(duration_raw) * 1000) if duration_raw else 0,
        size_bytes=size_bytes,
        sample_rate_hz=int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        channels=int(audio["channels"]) if audio and audio.get("channels") else None,
        audio_codec=str(audio.get("codec_name") or "") if audio else "",
        width=int(video["width"]) if video and video.get("width") else None,
        height=int(video["height"]) if video and video.get("height") else None,
        fps=_parse_fraction(
            (video or {}).get("avg_frame_rate") or (video or {}).get("r_frame_rate")
        )
        if video
        else None,
        video_codec=str(video.get("codec_name") or "") if video else "",
    )


def _cache_path(media_dir: Path) -> Path:
    return media_dir / "probe_cache.json"


def _load_disk_cache(media_dir: Path) -> dict[str, Any]:
    path = _cache_path(media_dir)
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_disk_cache(media_dir: Path, cache: dict[str, Any]) -> None:
    path = _cache_path(media_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f"{path.suffix}.part")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def probe_track_cached(ffprobe_bin: str, media_dir: Path, path: Path) -> TrackProbe:
    """带缓存的单轨探测：`(路径, mtime_ns, size)` 三元组没变就跳过 ffprobe。

    落盘缓存额外覆盖"后端重启后立刻重新打开工程"的情形；进程内内存缓存覆盖
    同一进程生命周期内的重复探测，两层缓存键的判据完全一致。
    """
    try:
        stat = path.stat()
    except OSError:
        return TrackProbe(exists=False, error=f"媒体文件不存在（可能已被移动/清理）：{path}")

    key = str(path)
    mem = _MEM_CACHE.get(key)
    if mem is not None and mem[0] == stat.st_mtime_ns and mem[1] == stat.st_size:
        return mem[2]

    disk_cache = _load_disk_cache(media_dir)
    entry = disk_cache.get(key)
    if (
        isinstance(entry, dict)
        and entry.get("version") == PROBE_VERSION
        and entry.get("mtime_ns") == stat.st_mtime_ns
        and entry.get("size") == stat.st_size
        and isinstance(entry.get("probe"), dict)
    ):
        probe = TrackProbe(**entry["probe"])
        _MEM_CACHE[key] = (stat.st_mtime_ns, stat.st_size, probe)
        return probe

    probe = probe_track(ffprobe_bin, path)
    _MEM_CACHE[key] = (stat.st_mtime_ns, stat.st_size, probe)
    disk_cache[key] = {
        "version": PROBE_VERSION,
        "mtime_ns": stat.st_mtime_ns,
        "size": stat.st_size,
        "probe": dataclasses.asdict(probe),
    }
    _save_disk_cache(media_dir, disk_cache)
    return probe
