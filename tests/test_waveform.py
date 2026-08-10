"""波形峰值预计算：CLAUDE.md §5.10 缺口一的测试。

分两层：

1. **纯计算逻辑**（分组 min/max、降采样、二进制序列化）不依赖真实 ffmpeg，
   用合成 numpy 数组直接验证——这是最容易出精度 bug 的地方（例如降采样时
   不小心用了近似值而不是精确 min/max）。
2. **真实解码 + 缓存 + 路由**：本机装的是带 libass 的 ffmpeg-full
   （CLAUDE.md §2.4 已实测），用标准库 `wave` 现造一段合成正弦波 WAV
   （不依赖 ffmpeg 就能造夹具，也不新增依赖），走真实 `find_ffmpeg_with_libass`
   解码路径，验证"多级 LOD 真的返回不同分辨率的数据"与"缓存命中不重新解码"
   这两条不能只靠纯函数测试覆盖的行为。
"""

from __future__ import annotations

import struct
import sys
import wave
from itertools import pairwise
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from kvm.media import waveform as wf  # noqa: E402
from kvm.media.download import _ffprobe_bin  # noqa: E402
from kvm.media.ffmpeg import find_ffmpeg_with_libass  # noqa: E402

# ---- 夹具 ----


def _write_test_wav(path: Path, *, seconds: float = 2.0, sample_rate: int = 8000) -> None:
    """写一段合成正弦波 WAV，供真实 ffmpeg/ffprobe 解码用。"""
    n = int(seconds * sample_rate)
    t = np.arange(n) / sample_rate
    tone = (np.sin(2 * np.pi * 440.0 * t) * 20000).astype("<i2")
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(sample_rate)
        fh.writeframes(tone.tobytes())


# ---- 纯计算：分组 min/max ----


def test_min_max_pairs_精确到每组() -> None:
    # 4 组、每组 3 个采样，手算好每组的 min/max
    samples = np.array([1, -5, 3, 10, 10, 10, -1, -2, -3, 100, -100, 0], dtype="<i2")
    mins, maxs = wf._min_max_pairs(samples, spp=3)
    assert list(mins) == [-5, 10, -3, -100]
    assert list(maxs) == [3, 10, -1, 100]


def test_min_max_pairs_丢弃不满一组的尾巴() -> None:
    samples = np.array([1, 2, 3, 4, 5, 6, 7], dtype="<i2")  # 7 个采样，spp=3 → 2 组 + 余 1
    mins, maxs = wf._min_max_pairs(samples, spp=3)
    assert mins.size == 2  # 第 7 个采样被丢弃，不足一组没有统计意义
    assert list(mins) == [1, 4]
    assert list(maxs) == [3, 6]


def test_min_max_pairs_短于一组时仍给出一个点() -> None:
    samples = np.array([5, -5, 2], dtype="<i2")
    mins, maxs = wf._min_max_pairs(samples, spp=100)
    assert mins.size == 1
    assert int(mins[0]) == -5
    assert int(maxs[0]) == 5


def test_min_max_pairs_空数组不炸() -> None:
    mins, maxs = wf._min_max_pairs(np.array([], dtype="<i2"), spp=64)
    assert mins.size == 1
    assert maxs.size == 1


# ---- 纯计算：降采样（粗一级从细一级推导）----


def test_downsample_minmax_是精确值不是近似() -> None:
    # 4 组细粒度 min/max，按 factor=2 分成 2 组：min 的 min 与 max 的 max
    mins = np.array([-5, -1, -100, -3], dtype="<i2")
    maxs = np.array([3, 10, -1, 50], dtype="<i2")
    coarse_mins, coarse_maxs = wf._downsample_minmax(mins, maxs, factor=2)
    assert list(coarse_mins) == [-5, -100]
    assert list(coarse_maxs) == [10, 50]


def test_compute_levels_级数与分级公比吻合() -> None:
    sr = 8000
    t = np.arange(sr * 3) / sr  # 3 秒
    samples = (np.sin(2 * np.pi * 440 * t) * 20000).astype("<i2")
    levels = wf.compute_levels(samples)

    assert len(levels) == len(wf.LOD_TIERS)
    assert [lv.samples_per_pixel for lv in levels] == list(wf.LOD_TIERS)
    # 越粗的级别点数越少
    for a, b in pairwise(levels):
        assert a.length >= b.length
    # 全局极值必须在所有级别里保持一致——粗粒度的 min/max 是精确聚合，
    # 不应该因为多级降采样而丢失极值
    global_min = int(samples.min())
    global_max = int(samples.max())
    for lv in levels:
        assert int(lv.mins.min()) == global_min
        assert int(lv.maxs.max()) == global_max


# ---- 二进制序列化：BBC waveform-data version 2 ----


def test_serialize_binary_头部字段与规范一致() -> None:
    level = wf.WaveformLevel(
        samples_per_pixel=256,
        length=3,
        mins=np.array([-100, -50, -10], dtype="<i2"),
        maxs=np.array([100, 50, 10], dtype="<i2"),
    )
    data = wf.serialize_binary(level, sample_rate=44100)

    version, flags, sample_rate, spp, length, channels = struct.unpack("<iiiiii", data[:24])
    assert version == 2
    assert flags == 0  # 16-bit
    assert sample_rate == 44100
    assert spp == 256
    assert length == 3
    assert channels == 1  # 降混为单声道

    body = data[24:]
    assert len(body) == length * 2 * 2  # 每点 (min,max)，每值 2 字节
    values = struct.unpack(f"<{length * 2}h", body)
    assert list(values) == [-100, 100, -50, 50, -10, 10]  # 交错：min0,max0,min1,max1,...


def test_不同级别序列化后字节长度不同() -> None:
    sr = 8000
    t = np.arange(sr * 5) / sr
    samples = (np.sin(2 * np.pi * 440 * t) * 20000).astype("<i2")
    levels = wf.compute_levels(samples)
    sizes = [len(wf.serialize_binary(lv, sr)) for lv in levels]
    # 由细到粗，字节数应严格递减（更粗=更少点=更小响应）
    assert sizes == sorted(sizes, reverse=True)
    assert len(set(sizes)) == len(sizes)


# ---- 真实解码 + 缓存（需要本机的带 libass ffmpeg） ----


@pytest.fixture(scope="module")
def ffmpeg_bins() -> tuple[str, str]:
    ffmpeg_bin = find_ffmpeg_with_libass()
    return ffmpeg_bin, _ffprobe_bin(ffmpeg_bin)


def test_get_or_compute_首次未命中再次命中(tmp_path: Path, ffmpeg_bins: tuple[str, str]) -> None:
    ffmpeg_bin, ffprobe_bin = ffmpeg_bins
    wav = tmp_path / "src" / "tone.wav"
    wav.parent.mkdir()
    _write_test_wav(wav, seconds=3.0, sample_rate=8000)
    media_dir = tmp_path / "media"

    first = wf.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, "audio", wav)
    assert first.cached is False
    assert first.sample_rate == 8000
    assert first.channels == 1
    assert 2900 <= first.duration_ms <= 3100
    assert len(first.levels) == len(wf.LOD_TIERS)

    second = wf.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, "audio", wav)
    assert second.cached is True
    assert second.levels == first.levels
    assert second.source_sha256 == first.source_sha256


def test_不同kind各自独立缓存(tmp_path: Path, ffmpeg_bins: tuple[str, str]) -> None:
    """同一份源文件被拷给两个不同 kind（例如误用同一份素材）时，两条缓存
    互不覆盖——缓存文件名里带 kind 前缀正是为此。"""
    ffmpeg_bin, ffprobe_bin = ffmpeg_bins
    wav = tmp_path / "tone.wav"
    _write_test_wav(wav, seconds=1.0, sample_rate=8000)
    media_dir = tmp_path / "media"

    audio_meta = wf.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, "audio", wav)
    vocals_meta = wf.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, "vocals", wav)
    assert audio_meta.cached is False
    assert vocals_meta.cached is False  # 不会因为 audio 算过了就误判 vocals 命中


def test_read_level_bytes_不同级别真的是不同分辨率(
    tmp_path: Path, ffmpeg_bins: tuple[str, str]
) -> None:
    ffmpeg_bin, ffprobe_bin = ffmpeg_bins
    wav = tmp_path / "tone.wav"
    _write_test_wav(wav, seconds=4.0, sample_rate=8000)
    media_dir = tmp_path / "media"

    meta = wf.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, "audio", wav)
    finest = wf.read_level_bytes(media_dir, "audio", meta.source_sha256, 0)
    coarsest = wf.read_level_bytes(media_dir, "audio", meta.source_sha256, len(wf.LOD_TIERS) - 1)

    assert finest != coarsest
    assert len(finest) > len(coarsest)  # 细粒度点数更多，二进制体积更大

    _, _, _, finest_spp, finest_len, _ = struct.unpack("<iiiiii", finest[:24])
    _, _, _, coarsest_spp, coarsest_len, _ = struct.unpack("<iiiiii", coarsest[:24])
    assert finest_spp == wf.LOD_TIERS[0]
    assert coarsest_spp == wf.LOD_TIERS[-1]
    assert finest_len > coarsest_len


def test_read_level_bytes_越界级别报错(tmp_path: Path, ffmpeg_bins: tuple[str, str]) -> None:
    ffmpeg_bin, ffprobe_bin = ffmpeg_bins
    wav = tmp_path / "tone.wav"
    _write_test_wav(wav, seconds=1.0, sample_rate=8000)
    media_dir = tmp_path / "media"
    meta = wf.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, "audio", wav)
    with pytest.raises(RuntimeError, match="不存在的 LOD 级别"):
        wf.read_level_bytes(media_dir, "audio", meta.source_sha256, len(wf.LOD_TIERS))


def test_探测无音频流文件给中文说明(tmp_path: Path, ffmpeg_bins: tuple[str, str]) -> None:
    _, ffprobe_bin = ffmpeg_bins
    not_media = tmp_path / "not_media.wav"
    not_media.write_bytes(b"this is not a wav file")
    with pytest.raises(RuntimeError, match="探测音频信息失败"):
        wf._ffprobe_audio_info(ffprobe_bin, not_media)


# ---- 路由层：GET /api/media/waveform/{project_id}/{kind}[/{level}] ----


@pytest.fixture
def client_and_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """起一个指向 tmp_path 的独立 ProjectStore，避免污染 `~/.karaoke-video-maker`。"""
    monkeypatch.setenv("KVM_DATA_DIR", str(tmp_path / "projects"))
    from fastapi.testclient import TestClient
    from kvm.api.app import app

    with TestClient(app) as client:
        resp = client.post("/api/projects/", json={"title": "波形测试"})
        assert resp.status_code == 201, resp.text
        project_id = resp.json()["id"]

        wav = tmp_path / "audio.wav"
        _write_test_wav(wav, seconds=2.0, sample_rate=8000)

        # 直接摆一份"已导入音频"的工程状态，不必真的走一遍导入接口
        from kvm.api.store import ProjectStore

        store: ProjectStore = app.state.store
        store.mutate(project_id, lambda p: setattr(p, "audio_path", str(wav)))

        yield client, project_id


def test_waveform_元信息接口返回多级lod(client_and_project) -> None:
    client, project_id = client_and_project
    resp = client.get(f"/api/media/waveform/{project_id}/audio")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["sample_rate_hz"] == 8000
    assert body["channels"] == 1
    assert len(body["levels"]) == len(wf.LOD_TIERS)
    assert [lv["samples_per_pixel"] for lv in body["levels"]] == list(wf.LOD_TIERS)
    assert body["cached"] is False
    assert body["elapsed_s"] >= 0


def test_waveform_二进制接口不同级别体积不同(client_and_project) -> None:
    client, project_id = client_and_project
    resp0 = client.get(f"/api/media/waveform/{project_id}/audio/0")
    resp_last = client.get(f"/api/media/waveform/{project_id}/audio/{len(wf.LOD_TIERS) - 1}")
    assert resp0.status_code == 200
    assert resp_last.status_code == 200
    assert resp0.headers["content-type"] == "application/octet-stream"
    assert len(resp0.content) > len(resp_last.content)

    version, _flags, sample_rate, spp, length, channels = struct.unpack(
        "<iiiiii", resp0.content[:24]
    )
    assert version == 2
    assert sample_rate == 8000
    assert spp == wf.LOD_TIERS[0]
    assert channels == 1
    assert len(resp0.content) == 24 + length * 4


def test_waveform_不支持的kind返回404(client_and_project) -> None:
    client, project_id = client_and_project
    resp = client.get(f"/api/media/waveform/{project_id}/video")
    assert resp.status_code == 404


def test_waveform_越界级别返回404(client_and_project) -> None:
    client, project_id = client_and_project
    resp = client.get(f"/api/media/waveform/{project_id}/audio/999")
    assert resp.status_code == 404


def test_waveform_没有该轨的工程返回404(client_and_project) -> None:
    client, project_id = client_and_project
    # 这个工程有 audio 没有 drums
    resp = client.get(f"/api/media/waveform/{project_id}/drums")
    assert resp.status_code == 404
