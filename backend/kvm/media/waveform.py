"""波形峰值预计算（CLAUDE.md §5.10）。

## 为什么要有这一层

此前前端画波形要靠 wavesurfer.js 自己整段解码音频 PCM 才能拿到峰值——一首
5 分钟的曲子解码后是几十 MB 的 Float32Array，素材舞台如果同时挂载多条轨
（原声/人声/伴奏/鼓）就必须把解码排成队列，一次只解一条，否则内存和主线程
都会被顶爆。真正需要送到浏览器的东西只是"每个像素一对 min/max"，用不着把
完整波形搬过去再算一遍。

本模块在**后端**做这件事：ffmpeg 解码 → numpy 求 min/max → 按内容哈希缓存，
输出 BBC `audiowaveform` 的二进制 waveform-data 格式（`.dat`，version 2），
前端可以直接用 `waveform-data` 这个 npm 包解析，不必再理解格式细节。

## 二进制格式（BBC waveform-data，version 2）

```
偏移   长度   字段
0      4      version          = 2（int32, little-endian）
4      4      flags            = 0（16-bit 分辨率；1 表示 8-bit）
8      4      sample_rate      解码用的采样率（Hz）
12     4      samples_per_pixel  多少个原始采样合并成一个 min/max 点对
16     4      length           点对个数（每声道）
20     4      channels         声道数，本模块恒为 1（见下）
24     ...    data             按"每点每声道"交错：min0_c0,max0_c0,min0_c1,
                                max0_c1,min1_c0,... —— 声道数为 1 时就是
                                min0,max0,min1,max1,...，每个值 int16 LE
```

规范来源：BBC `audiowaveform` 项目 `doc/DataFormat.md`。不打包
`audiowaveform` 二进制、不依赖它的库——这里的产出格式与它兼容，但计算本身
只是 ffmpeg 解码 + numpy 向量化 min/max，不值得为此背一个原生依赖
（CLAUDE.md §5.10 原文）。

## 单声道降混

波形只用于可视化定位（缩放、tap-to-time、拖边界），不需要保留立体声分离度；
`channels` 恒为 1 能让计算量与传输量减半，且不影响调轴精度——左右声道的
时间信息在人声/伴奏这类素材上是一致的。

## 多级 LOD

`LOD_TIERS` 由细到粗、公比 4：`samples_per_pixel` 越小，1 像素对应的时间越短
（越适合逐音节核对），越大则越适合整曲缩略图。粗一级的 min/max 直接从细一级
分组再取 min/max 得到（min 的 min 仍是真实 min，max 的 max 仍是真实 max），
不需要重新扫一遍原始采样，因此每多一级 LOD 的增量成本随公比指数下降。

## 缓存

缓存键是 `(源文件内容哈希, LOD 分级方案, 实现版本)`（CLAUDE.md §5.13）。
落盘的 `.dat` 文件本身就是缓存——文件存在即命中，不需要额外的清单文件；
改了 `LOD_TIERS` 或降采样算法必须把 `WAVEFORM_VERSION` +1，否则旧参数产出的
峰值会被当成命中继续沿用。
"""

from __future__ import annotations

import json
import struct
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from kvm.media.hashing import cached_sha256

# 改了 LOD_TIERS、降采样算法或二进制序列化方式必须 +1。
WAVEFORM_VERSION = "1"

# 由细到粗，公比 4。以常见的 44.1kHz 源为例：
# - 64   spp ≈ 1.45ms/像素——足够核对单个音节的起止边界
# - 16384 spp ≈ 371ms/像素——一首 5 分钟曲子缩到约 770 个点，适合整曲缩略图
LOD_TIERS: tuple[int, ...] = (64, 256, 1024, 4096, 16384)
_LOD_FACTOR = 4  # LOD_TIERS 里每一级相对上一级的分组倍数，必须与上面的数列一致

_CHANNELS = 1  # 降混为单声道，见模块文档
_FLAGS_16BIT = 0  # BBC 格式的 flags：0=16-bit，1=8-bit


@dataclass(frozen=True)
class WaveformLevel:
    """一级 LOD 的峰值数据。"""

    samples_per_pixel: int
    length: int
    mins: np.ndarray
    maxs: np.ndarray


@dataclass(frozen=True)
class WaveformMeta:
    """一次"要不要重新计算"的结果，供路由层拼装响应。"""

    sample_rate: int
    channels: int
    duration_ms: int
    levels: list[dict[str, int]]
    """`[{"level": i, "samples_per_pixel": spp, "length": n}, ...]`。"""

    cached: bool
    elapsed_s: float
    source_sha256: str


# ---------------------------------------------------------------------------
# 解码
# ---------------------------------------------------------------------------


def _ffprobe_audio_info(ffprobe_bin: str, path: Path) -> tuple[int, float]:
    """返回 `(采样率 Hz, 时长秒)`。只探测第一条音频流——本模块只服务
    `audio`/`vocals`/`instrumental`/`drums` 这些纯音频轨。
    """
    try:
        proc = subprocess.run(
            [
                ffprobe_bin,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate:format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        meta = json.loads(proc.stdout or "{}")
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as exc:
        msg = f"探测音频信息失败（文件可能已损坏，或根本不是媒体文件）：{path}"
        raise RuntimeError(msg) from exc

    streams = meta.get("streams", [])
    if not streams:
        msg = f"这个文件里没有音频流，无法计算波形峰值：{path}"
        raise RuntimeError(msg)
    sample_rate = int(streams[0].get("sample_rate") or 0)
    duration_s = float(meta.get("format", {}).get("duration") or 0.0)
    if sample_rate <= 0:
        msg = f"探测不到采样率，无法计算波形峰值：{path}"
        raise RuntimeError(msg)
    return sample_rate, duration_s


def _decode_mono_pcm16(ffmpeg_bin: str, path: Path) -> np.ndarray:
    """把音频解码为单声道 16-bit PCM，直接读子进程 stdout，不落中间文件。

    不传 `-ar`：保持源的原生采样率，与 `_ffprobe_audio_info()` 探测到的
    采样率对应，避免"头里写的采样率"和"实际解码出来的采样率"对不上。
    """
    cmd = [
        ffmpeg_bin,
        "-v",
        "error",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=600, check=True)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
        msg = f"解码音频失败：{path}\n{stderr[-2000:]}"
        raise RuntimeError(msg) from exc
    except (OSError, subprocess.SubprocessError) as exc:
        msg = f"解码音频失败：{path}"
        raise RuntimeError(msg) from exc
    return np.frombuffer(proc.stdout, dtype="<i2")


# ---------------------------------------------------------------------------
# 峰值计算
# ---------------------------------------------------------------------------


def _min_max_pairs(samples: np.ndarray, spp: int) -> tuple[np.ndarray, np.ndarray]:
    """把采样按 `spp` 分组，向量化算每组的 min/max。

    尾部不足一组的采样点丢弃：最后一组不到 `spp` 个采样点时统计上没有意义，
    且能让所有分级的分组边界严格对齐（下一级降采样时不必特殊处理尾巴）。
    """
    n_groups = samples.size // spp
    if n_groups == 0:
        if samples.size == 0:
            return np.zeros(1, dtype=np.int16), np.zeros(1, dtype=np.int16)
        # 极短音频（比一个 spp 分组还短）：仍给出一组，用全部采样的 min/max，
        # 保证任何长度的音频都至少能画出一个点，不会给前端一个空响应
        return (
            np.array([int(samples.min())], dtype=np.int16),
            np.array([int(samples.max())], dtype=np.int16),
        )
    trimmed = samples[: n_groups * spp].reshape(n_groups, spp)
    return trimmed.min(axis=1).astype(np.int16), trimmed.max(axis=1).astype(np.int16)


def _downsample_minmax(
    mins: np.ndarray, maxs: np.ndarray, factor: int
) -> tuple[np.ndarray, np.ndarray]:
    """从细一级的 min/max 数组推导粗一级：分组取"min 的 min"与"max 的 max"。

    这依然是精确值——不是近似：一组 4 个 min 值里的最小值，就是这 4 组原始采样
    合起来的真实最小值,不需要回头重新扫描原始采样。
    """
    n_groups = mins.size // factor
    if n_groups == 0:
        if mins.size == 0:
            return np.zeros(1, dtype=np.int16), np.zeros(1, dtype=np.int16)
        return (
            np.array([int(mins.min())], dtype=np.int16),
            np.array([int(maxs.max())], dtype=np.int16),
        )
    mins_grouped = mins[: n_groups * factor].reshape(n_groups, factor).min(axis=1)
    maxs_grouped = maxs[: n_groups * factor].reshape(n_groups, factor).max(axis=1)
    return mins_grouped.astype(np.int16), maxs_grouped.astype(np.int16)


def compute_levels(samples: np.ndarray) -> list[WaveformLevel]:
    """算出 `LOD_TIERS` 里每一级的峰值数据，由细到粗。"""
    base_spp = LOD_TIERS[0]
    mins, maxs = _min_max_pairs(samples, base_spp)
    levels = [WaveformLevel(base_spp, int(mins.size), mins, maxs)]
    for spp in LOD_TIERS[1:]:
        factor = spp // levels[-1].samples_per_pixel
        mins, maxs = _downsample_minmax(levels[-1].mins, levels[-1].maxs, factor)
        levels.append(WaveformLevel(spp, int(mins.size), mins, maxs))
    return levels


# ---------------------------------------------------------------------------
# 二进制序列化（BBC waveform-data version 2）
# ---------------------------------------------------------------------------


def serialize_binary(level: WaveformLevel, sample_rate: int) -> bytes:
    """把一级 LOD 的峰值打包成 BBC waveform-data 二进制格式，见模块文档。"""
    header = struct.pack(
        "<iiiiii",
        2,  # version
        _FLAGS_16BIT,
        sample_rate,
        level.samples_per_pixel,
        level.length,
        _CHANNELS,
    )
    # 交错写 min/max：channels=1 时就是 min0,max0,min1,max1,...
    data = np.empty(level.length * 2, dtype="<i2")
    data[0::2] = level.mins
    data[1::2] = level.maxs
    return header + data.tobytes()


# ---------------------------------------------------------------------------
# 缓存
# ---------------------------------------------------------------------------


def _cache_dir(media_dir: Path) -> Path:
    d = media_dir / "waveform"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key(sha256: str) -> str:
    return f"{sha256[:16]}_v{WAVEFORM_VERSION}"


def _meta_path(media_dir: Path, kind: str, key: str) -> Path:
    return _cache_dir(media_dir) / f"{kind}_{key}.meta.json"


def _level_path(media_dir: Path, kind: str, key: str, level: int) -> Path:
    return _cache_dir(media_dir) / f"{kind}_{key}_L{level}.dat"


def _hash_index_path(media_dir: Path) -> Path:
    """`kvm.media.hashing.cached_sha256` 的旁路索引，按工程共享（不同 kind
    指向不同文件，天然不会互相覆盖）。"""
    return _cache_dir(media_dir) / "source_hash_index.json"


def _read_cached_meta(media_dir: Path, kind: str, key: str) -> dict[str, Any] | None:
    path = _meta_path(media_dir, kind, key)
    if not path.is_file():
        return None
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    levels = meta.get("levels")
    if not isinstance(levels, list):
        return None
    # 元数据存在不代表数据文件还在——用户可能手动清理过 waveform 缓存目录，
    # 必须逐个核对，命中率判据是"文件确实还在磁盘上"，不是"清单里有记录"
    # （与 kvm.media.proxy 的 `_load_cache_entry` 同一原则）。
    if not all(_level_path(media_dir, kind, key, lv["level"]).is_file() for lv in levels):
        return None
    return meta


def get_or_compute(
    ffmpeg_bin: str, ffprobe_bin: str, media_dir: Path, kind: str, source: Path
) -> WaveformMeta:
    """拿到（必要时计算）某条音频轨的分级峰值元信息。

    实际的二进制数据不在这里返回——那由 `read_level_bytes()` 按需读某一级，
    避免"只想看有哪些级别可选"的调用也被迫把最细一级的数据搬一遍。
    """
    started = time.monotonic()
    sha = cached_sha256(source, _hash_index_path(media_dir))
    key = _cache_key(sha)

    cached_meta = _read_cached_meta(media_dir, kind, key)
    if cached_meta is not None:
        return WaveformMeta(
            sample_rate=cached_meta["sample_rate"],
            channels=cached_meta["channels"],
            duration_ms=cached_meta["duration_ms"],
            levels=cached_meta["levels"],
            cached=True,
            elapsed_s=time.monotonic() - started,
            source_sha256=sha,
        )

    sample_rate, duration_s = _ffprobe_audio_info(ffprobe_bin, source)
    samples = _decode_mono_pcm16(ffmpeg_bin, source)
    levels = compute_levels(samples)

    for i, level in enumerate(levels):
        data = serialize_binary(level, sample_rate)
        dest = _level_path(media_dir, kind, key, i)
        tmp = dest.with_suffix(f"{dest.suffix}.part")
        tmp.write_bytes(data)
        tmp.replace(dest)  # 原子替换，避免并发请求读到写了一半的文件

    meta = {
        "sample_rate": sample_rate,
        "channels": _CHANNELS,
        "duration_ms": round(duration_s * 1000),
        "levels": [
            {"level": i, "samples_per_pixel": lv.samples_per_pixel, "length": lv.length}
            for i, lv in enumerate(levels)
        ],
        "source_sha256": sha,
        "version": WAVEFORM_VERSION,
    }
    meta_dest = _meta_path(media_dir, kind, key)
    tmp = meta_dest.with_suffix(f"{meta_dest.suffix}.part")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(meta_dest)

    return WaveformMeta(
        sample_rate=sample_rate,
        channels=_CHANNELS,
        duration_ms=meta["duration_ms"],
        levels=meta["levels"],
        cached=False,
        elapsed_s=time.monotonic() - started,
        source_sha256=sha,
    )


def read_level_bytes(media_dir: Path, kind: str, sha256: str, level: int) -> bytes:
    """读某一级 LOD 的二进制峰值数据。调用前应先用同一个 `sha256`（来自
    `get_or_compute()` 返回的 `WaveformMeta.source_sha256`）确保对应文件存在。
    """
    if not (0 <= level < len(LOD_TIERS)):
        msg = f"不存在的 LOD 级别：{level}（应在 0~{len(LOD_TIERS) - 1} 之间）"
        raise RuntimeError(msg)
    path = _level_path(media_dir, kind, _cache_key(sha256), level)
    if not path.is_file():
        msg = f"该 LOD 级别尚未计算或缓存已被清理：{kind} L{level}"
        raise RuntimeError(msg)
    return path.read_bytes()
