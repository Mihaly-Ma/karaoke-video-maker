"""媒体探测（ffprobe）：CLAUDE.md 缺口二的测试。

前端此前靠 Range 请求 + 手写 RIFF chunk 遍历拿轨道信息，本模块改用 ffprobe。
测试覆盖三件事：探测本身对真实文件给出正确结果、`(路径, mtime, size)` 缓存
真的跳过重复 ffprobe（用"第二次故意传一个不存在的 ffprobe 路径也不报错"来
证明确实没有再发起子进程调用）、以及路由层的 404 / 优雅降级判据。
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from kvm.media import probe as pb  # noqa: E402
from kvm.media.download import _ffprobe_bin  # noqa: E402
from kvm.media.ffmpeg import find_ffmpeg_with_libass  # noqa: E402

# ---- 夹具 ----


def _write_test_wav(
    path: Path, *, seconds: float = 1.5, sample_rate: int = 22050, channels: int = 2
) -> None:
    n = int(seconds * sample_rate)
    t = np.arange(n) / sample_rate
    tone = (np.sin(2 * np.pi * 440.0 * t) * 20000).astype("<i2")
    if channels == 2:
        interleaved = np.empty(n * 2, dtype="<i2")
        interleaved[0::2] = tone
        interleaved[1::2] = tone
        payload = interleaved.tobytes()
    else:
        payload = tone.tobytes()
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(channels)
        fh.setsampwidth(2)
        fh.setframerate(sample_rate)
        fh.writeframes(payload)


@pytest.fixture(scope="module")
def ffprobe_bin() -> str:
    return _ffprobe_bin(find_ffmpeg_with_libass())


# ---- probe_track：纯探测 ----


def test_探测不存在的文件不抛异常而是exists为false(ffprobe_bin: str, tmp_path: Path) -> None:
    result = pb.probe_track(ffprobe_bin, tmp_path / "不存在.wav")
    assert result.exists is False
    assert "不存在" in result.error


def test_探测真实wav给出正确的时长采样率声道数(ffprobe_bin: str, tmp_path: Path) -> None:
    wav = tmp_path / "a.wav"
    _write_test_wav(wav, seconds=2.0, sample_rate=22050, channels=2)
    result = pb.probe_track(ffprobe_bin, wav)
    assert result.exists is True
    assert result.error == ""
    assert 1900 <= result.duration_ms <= 2100
    assert result.sample_rate_hz == 22050
    assert result.channels == 2
    assert result.audio_codec == "pcm_s16le"
    assert result.size_bytes == wav.stat().st_size
    # 纯音频文件没有视频流
    assert result.width is None
    assert result.height is None
    assert result.fps is None


def test_探测非媒体文件给出中文错误而不是裸异常(ffprobe_bin: str, tmp_path: Path) -> None:
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not actually a wav file, just some bytes")
    result = pb.probe_track(ffprobe_bin, junk)
    assert result.exists is True  # 文件本身存在
    assert result.error  # 但探测失败，错误可见（CLAUDE.md §2.5）


def test_parse_fraction_分数帧率() -> None:
    assert pb._parse_fraction("24000/1001") == pytest.approx(23.976, abs=0.001)
    assert pb._parse_fraction("25") == 25.0
    assert pb._parse_fraction("0/0") is None  # 除零不炸
    assert pb._parse_fraction(None) is None
    assert pb._parse_fraction("not-a-number") is None


# ---- probe_track_cached：缓存真的跳过重复 ffprobe ----


def test_缓存命中不再重新探测(ffprobe_bin: str, tmp_path: Path) -> None:
    wav = tmp_path / "a.wav"
    _write_test_wav(wav)
    media_dir = tmp_path / "media"

    first = pb.probe_track_cached(ffprobe_bin, media_dir, wav)
    assert first.exists is True

    # 第二次故意传一个不存在的 ffprobe 路径：如果缓存没生效，probe_track 会
    # 真的尝试 spawn 这个不存在的二进制并报错；缓存生效的话根本不会走到那一步，
    # 依然拿到与第一次一致的结果。
    second = pb.probe_track_cached("/nonexistent/ffprobe", media_dir, wav)
    assert second == first


def test_文件内容变化后缓存失效(ffprobe_bin: str, tmp_path: Path) -> None:
    wav = tmp_path / "a.wav"
    _write_test_wav(wav, seconds=1.0)
    media_dir = tmp_path / "media"

    first = pb.probe_track_cached(ffprobe_bin, media_dir, wav)

    # 换一份不同时长的内容，文件名不变——mtime/size 会变化，缓存必须失效
    _write_test_wav(wav, seconds=3.0)
    second = pb.probe_track_cached(ffprobe_bin, media_dir, wav)
    assert second.duration_ms != first.duration_ms
    assert 2900 <= second.duration_ms <= 3100


def test_落盘缓存跨进程内存缓存生效(ffprobe_bin: str, tmp_path: Path) -> None:
    """模拟"后端重启后立刻重新打开工程"：清掉内存缓存，只留磁盘上的
    `probe_cache.json`，仍应命中且不再需要可用的 ffprobe。"""
    wav = tmp_path / "a.wav"
    _write_test_wav(wav)
    media_dir = tmp_path / "media"

    first = pb.probe_track_cached(ffprobe_bin, media_dir, wav)
    pb._MEM_CACHE.clear()  # 模拟进程重启：内存缓存清空，只剩落盘的 probe_cache.json

    second = pb.probe_track_cached("/nonexistent/ffprobe", media_dir, wav)
    assert second == first


# ---- 路由层：GET /api/media/probe/{project_id}[/{kind}] ----


@pytest.fixture
def client_and_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("KVM_DATA_DIR", str(tmp_path / "projects"))
    from fastapi.testclient import TestClient
    from kvm.api.app import app

    with TestClient(app) as client:
        resp = client.post("/api/projects/", json={"title": "探测测试"})
        assert resp.status_code == 201, resp.text
        project_id = resp.json()["id"]

        audio = tmp_path / "audio.wav"
        _write_test_wav(audio, seconds=2.0, sample_rate=16000, channels=1)
        missing_vocals = tmp_path / "vocals_不存在.wav"  # 路径记着，但文件不落盘

        from kvm.api.store import ProjectStore

        store: ProjectStore = app.state.store

        def _apply(p):
            p.audio_path = str(audio)
            p.vocals_path = str(missing_vocals)

        store.mutate(project_id, _apply)

        yield client, project_id


def test_probe_单条轨返回正确字段(client_and_project) -> None:
    client, project_id = client_and_project
    resp = client.get(f"/api/media/probe/{project_id}/audio")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "audio"
    assert body["exists"] is True
    assert body["sample_rate_hz"] == 16000
    assert body["channels"] == 1
    assert 1900 <= body["duration_ms"] <= 2100


def test_probe_文件被移动时不404而是exists为false(client_and_project) -> None:
    client, project_id = client_and_project
    resp = client.get(f"/api/media/probe/{project_id}/vocals")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["exists"] is False
    assert body["error"]


def test_probe_不支持的kind返回404(client_and_project) -> None:
    client, project_id = client_and_project
    resp = client.get(f"/api/media/probe/{project_id}/not-a-kind")
    assert resp.status_code == 404


def test_probe_未设置路径的kind返回404(client_and_project) -> None:
    client, project_id = client_and_project
    # 这个工程有 audio/vocals，没有 drums
    resp = client.get(f"/api/media/probe/{project_id}/drums")
    assert resp.status_code == 404


def test_probe_批量接口只返回已有路径的kind(client_and_project) -> None:
    client, project_id = client_and_project
    resp = client.get(f"/api/media/probe/{project_id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    tracks = body["tracks"]
    assert set(tracks) == {"audio", "vocals"}  # 没有 video/proxy/instrumental/drums
    assert tracks["audio"]["exists"] is True
    assert tracks["vocals"]["exists"] is False  # 路径记着但文件不在，仍然出现在列表里


# ---- 存量工程的画面尺寸自愈 ----


def _write_test_video(ffmpeg_bin: str, path: Path, *, size: str, aspect: str | None = None) -> None:
    """用 lavfi 合成一小段视频。`aspect` 给的是容器 DAR，用来造非方形像素的源。"""
    import subprocess

    cmd = [ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error"]
    cmd += ["-f", "lavfi", "-i", f"testsrc=size={size}:rate=25:duration=1"]
    if aspect:
        cmd += ["-aspect", aspect]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, check=True, timeout=120)


@pytest.mark.parametrize(
    ("size", "aspect", "expected"),
    [
        # 4:3 方形像素：曾经工程停在默认 1920×1080，PlayRes 与帧尺寸比例不等，字变形
        ("640x480", None, (640, 480)),
        # 非方形像素：编码 640×480 但 DAR 16:9，排版必须按显示尺寸 853→854（取偶）
        ("640x480", "16:9", (854, 480)),
    ],
)
def test_打开工程时纠正存量工程的画面尺寸(
    client_and_project, tmp_path: Path, size: str, aspect: str | None, expected: tuple[int, int]
) -> None:
    """光修下载路径救不了已经建好的工程——那些工程停在默认 1920×1080 上。

    **验的是 `GET /api/projects/{id}`，不是媒体探测端点。** 第一版挂在
    `GET /api/media/probe/{id}` 上，而前端压根没有调用点，自愈成了死代码——
    测试当时照样是绿的，因为它自己去调了那个没人调的端点。这就是 §2.6 说的
    "检查存在与检查生效是两回事"：断言必须打在**产品真的会走的那条路径**上。

    尺寸是文件的既成事实，所以纠正走 `update_derived` **不占撤销格**：用户按
    Cmd+Z 撤掉的应该是自己那次编辑，不是"工程终于知道了视频有多大"。
    """
    from kvm.api.app import app
    from kvm.api.store import ProjectStore

    client, project_id = client_and_project
    video = tmp_path / f"v_{size}_{aspect or 'sq'}.mp4"
    _write_test_video(find_ffmpeg_with_libass(), video, size=size, aspect=aspect)

    store: ProjectStore = app.state.store
    store.mutate(project_id, lambda p: setattr(p, "video_path", str(video)))
    before = store.get(project_id)
    assert (before.video_width, before.video_height) == (1920, 1080)  # 默认值，与实际不符
    undo_depth = store.history_depth(project_id)

    assert client.get(f"/api/projects/{project_id}").status_code == 200

    after = store.get(project_id)
    assert (after.video_width, after.video_height) == expected
    assert store.history_depth(project_id) == undo_depth, "纠正尺寸不该占一格撤销"
