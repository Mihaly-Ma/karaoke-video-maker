"""编辑用代理视频（`kvm.media.proxy`）的决策与命令拼装测试。

这一层值得测的不是"ffmpeg 跑不跑得起来"（那要真机实测，见报告里的实跑记录），
而是**判断**：什么时候必须重编码、转成多大、GOP 多少、硬件编码有没有给码率。
这些判断一旦错了，症状都是"看起来出片了但用起来不对"：

- 漏了 `-b:v` → videotoolbox 掉到约 200 kb/s，代理糊到没法核对口型（CLAUDE.md §5.11）；
- GOP 写死 24 → 60fps 源的代理变成 0.4 秒一个关键帧，白白浪费码率；
- 该转码却判成 remux → Safari 依旧放不了，或者 seek 依旧卡；
- 代理混进导入/导出路径 → 用 540p 素材出片。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.api.schemas import ProjectDTO  # noqa: E402
from kvm.media.proxy import (  # noqa: E402
    DEFAULT_MAX_HEIGHT,
    REMUX_MAX_KEYFRAME_INTERVAL_S,
    ProxyPlan,
    SourceInfo,
    build_proxy_command,
    cache_key,
    encoder_candidates,
    plan_proxy,
    progress_seconds,
    target_bitrate_kbps,
    target_gop,
)


def _source(**overrides: object) -> SourceInfo:
    """默认是本机验证曲的真实规格：yt-dlp 拿回来的 4K AV1 Matroska。"""
    base: dict[str, object] = {
        "width": 3840,
        "height": 2160,
        "fps": 24000 / 1001,
        "codec_name": "av1",
        "duration_s": 283.821,
        "suffix": ".mkv",
        "keyframe_interval_s": 5.0,
    }
    base.update(overrides)
    return SourceInfo(**base)  # type: ignore[arg-type]


# ---- 转码 / remux 的裁决 ----


def test_4k_av1_必须转码() -> None:
    # Safari 对这份源是三重不可播：Matroska 容器、MKV 里的 Opus、M1/M2 无 AV1 硬解。
    # 只换容器救不了，必须真的转成 H.264。
    plan = plan_proxy(_source(), DEFAULT_MAX_HEIGHT, "h264_videotoolbox")
    assert plan.mode == "transcode"
    assert plan.encoder == "h264_videotoolbox"


def test_1080p_h264_也要转码因为高度超上限() -> None:
    plan = plan_proxy(
        _source(width=1920, height=1080, codec_name="h264", keyframe_interval_s=1.0),
        DEFAULT_MAX_HEIGHT,
        "libx264",
    )
    assert plan.mode == "transcode"
    assert plan.target_height == DEFAULT_MAX_HEIGHT


def test_已经符合代理规格的源只remux() -> None:
    # H.264 + 高度不超上限 + 关键帧已经够密 —— 重编码只会白掉一次画质
    plan = plan_proxy(
        _source(width=960, height=540, codec_name="h264", suffix=".mp4", keyframe_interval_s=1.0),
        DEFAULT_MAX_HEIGHT,
        "h264_videotoolbox",
    )
    assert plan.mode == "remux"
    assert plan.encoder == "copy"


def test_低分辨率_h264_但长_gop_仍要转码() -> None:
    # 代理存在的另一半理由是 seek 要快；`-c:v copy` 会原样继承源的长 GOP
    plan = plan_proxy(
        _source(
            width=960,
            height=540,
            codec_name="h264",
            suffix=".mp4",
            keyframe_interval_s=REMUX_MAX_KEYFRAME_INTERVAL_S + 1,
        ),
        DEFAULT_MAX_HEIGHT,
        "libx264",
    )
    assert plan.mode == "transcode"


def test_关键帧间隔探不出来时保守转码() -> None:
    plan = plan_proxy(
        _source(width=960, height=540, codec_name="h264", suffix=".mp4", keyframe_interval_s=None),
        DEFAULT_MAX_HEIGHT,
        "libx264",
    )
    assert plan.mode == "transcode"


def test_mkv_里的短_gop_h264_可以只换容器() -> None:
    # 容器不作为 remux 的前置条件：MKV 里的 H.264 换个 MP4 壳就能放，没理由重编码
    plan = plan_proxy(
        _source(width=854, height=480, codec_name="h264", suffix=".mkv", keyframe_interval_s=2.0),
        DEFAULT_MAX_HEIGHT,
        "libx264",
    )
    assert plan.mode == "remux"


def test_源比上限还小时不放大() -> None:
    plan = plan_proxy(
        _source(width=640, height=360, codec_name="av1", keyframe_interval_s=1.0),
        DEFAULT_MAX_HEIGHT,
        "libx264",
    )
    assert plan.target_height == 360
    assert plan.target_width == 640


def test_缩放后宽高都是偶数() -> None:
    # H.264 的 yuv420p 要求宽高皆偶数；奇数宽会让 ffmpeg 直接报错
    plan = plan_proxy(
        _source(width=1919, height=1079, codec_name="av1"), DEFAULT_MAX_HEIGHT, "libx264"
    )
    assert plan.target_width % 2 == 0
    assert plan.target_height % 2 == 0


def test_裁决理由是中文且能直接当进度文案() -> None:
    plan = plan_proxy(_source(), DEFAULT_MAX_HEIGHT, "h264_videotoolbox")
    assert plan.reason
    assert "av1" in plan.reason.lower() or "H.264" in plan.reason


# ---- GOP 与码率 ----


@pytest.mark.parametrize(
    ("fps", "expected"),
    [
        (24000 / 1001, 24),  # 本机验证曲：23.976fps
        (30000 / 1001, 30),
        (25.0, 25),
        (60.0, 60),
        (0.0, 24),  # 探不出帧率时的兜底
    ],
)
def test_gop_按源帧率算约一秒(fps: float, expected: int) -> None:
    assert target_gop(fps) == expected


def test_码率随像素面积增长且被夹在合理区间() -> None:
    assert target_bitrate_kbps(960, 540) == 1800  # 实测基准：1.87 Mbps 足够核对口型
    assert target_bitrate_kbps(1280, 720) > target_bitrate_kbps(960, 540)
    assert target_bitrate_kbps(64, 36) >= 600
    assert target_bitrate_kbps(7680, 4320) <= 8000


# ---- 命令拼装 ----


def _plan(mode: str = "transcode", encoder: str = "h264_videotoolbox") -> ProxyPlan:
    return ProxyPlan(
        mode=mode,  # type: ignore[arg-type]
        encoder=encoder,
        target_height=540,
        target_width=960,
        gop=24,
        bitrate_kbps=1800,
        reason="测试",
    )


def test_硬件编码必须显式给码率() -> None:
    # 不给 -b:v 时 videotoolbox 会落到约 200 kb/s 的默认值（CLAUDE.md §5.11）
    cmd = build_proxy_command("ffmpeg", Path("/tmp/a.mkv"), Path("/tmp/b.mp4"), _plan())
    assert "-b:v" in cmd
    assert cmd[cmd.index("-b:v") + 1] == "1800k"


def test_软件编码走_crf_而不是码率() -> None:
    cmd = build_proxy_command(
        "ffmpeg", Path("/tmp/a.mkv"), Path("/tmp/b.mp4"), _plan(encoder="libx264")
    )
    assert "-crf" in cmd
    assert "-b:v" not in cmd


def test_代理一律不带音轨() -> None:
    # <video> 在编辑器里永远静音，声音全部走 Web Audio（CLAUDE.md D15）
    for plan in (_plan(), _plan(mode="remux", encoder="copy")):
        cmd = build_proxy_command("ffmpeg", Path("/tmp/a.mkv"), Path("/tmp/b.mp4"), plan)
        assert "-an" in cmd


def test_转码命令带短_gop_与缩放() -> None:
    cmd = build_proxy_command("ffmpeg", Path("/tmp/a.mkv"), Path("/tmp/b.mp4"), _plan())
    assert cmd[cmd.index("-g") + 1] == "24"
    assert cmd[cmd.index("-vf") + 1] == "scale=-2:540"


def test_remux_命令不重编码也不缩放() -> None:
    cmd = build_proxy_command(
        "ffmpeg", Path("/tmp/a.mp4"), Path("/tmp/b.mp4"), _plan(mode="remux", encoder="copy")
    )
    assert cmd[cmd.index("-c:v") + 1] == "copy"
    assert "-vf" not in cmd


def test_产物一律是_faststart_的_mp4() -> None:
    # moov 不前置的话浏览器要下完整个文件才能起播
    cmd = build_proxy_command("ffmpeg", Path("/tmp/a.mkv"), Path("/tmp/b.mp4"), _plan())
    assert cmd[cmd.index("-movflags") + 1] == "+faststart"
    assert cmd[cmd.index("-f") + 1] == "mp4"


def test_命令带进度协议() -> None:
    cmd = build_proxy_command("ffmpeg", Path("/tmp/a.mkv"), Path("/tmp/b.mp4"), _plan())
    assert cmd[cmd.index("-progress") + 1] == "pipe:1"
    assert "-nostats" in cmd


def test_ffmpeg_路径来自参数而不是字面量() -> None:
    # 禁止在代码里散落 "ffmpeg" 字面量（CLAUDE.md §2.6：统一的解析层）
    cmd = build_proxy_command("/opt/x/ffmpeg", Path("/tmp/a.mkv"), Path("/tmp/b.mp4"), _plan())
    assert cmd[0] == "/opt/x/ffmpeg"


# ---- 进度解析 ----


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("out_time_us=1500000", 1.5),
        ("out_time_ms=2000000", 2.0),  # ffmpeg 的 out_time_ms 其实也是微秒
        ("out_time_us=N/A", None),  # 还没有输出帧时会是 N/A，不能炸
        ("out_time_us=-1", None),
        ("frame=42", None),
        ("progress=continue", None),
        ("完全不是 key=value", None),
    ],
)
def test_进度解析(line: str, expected: float | None) -> None:
    assert progress_seconds(line) == expected


# ---- 缓存键 ----


def test_缓存键随参数变化() -> None:
    a = cache_key("abc", _plan())
    assert a == cache_key("abc", _plan())
    assert a != cache_key("def", _plan())  # 换了源视频
    assert a != cache_key("abc", _plan(encoder="libx264"))  # 换了编码器


def test_缓存键随目标分辨率变化() -> None:
    small = ProxyPlan(
        mode="transcode",
        encoder="h264_videotoolbox",
        target_height=360,
        target_width=640,
        gop=24,
        bitrate_kbps=800,
        reason="测试",
    )
    assert cache_key("abc", _plan()) != cache_key("abc", small)


def test_写入缓存清单会丢弃旧条目(tmp_path: Path) -> None:
    """一个工程只保留一份代理，清单里最多只能有一条有效记录。

    实测复现过的回归：先出 540p、再出 360p（覆盖同一个 proxy.mp4）、再切回 540p，
    合并式写入会让 540p 的旧键仍在并被判成缓存命中，于是拿到的其实是 360p 那份。
    """
    from kvm.media.proxy import _load_cache_entry, _save_cache_entry

    proxy = tmp_path / "proxy.mp4"
    proxy.write_bytes(b"fake")
    _save_cache_entry(tmp_path, "key-540", str(proxy))
    _save_cache_entry(tmp_path, "key-360", str(proxy))

    assert _load_cache_entry(tmp_path, "key-360") == str(proxy)
    assert _load_cache_entry(tmp_path, "key-540") is None


def test_探测失败给中文说明而不是裸_calledprocesserror(tmp_path: Path) -> None:
    """任务状态里的 error 会被直接贴到界面上，英文异常用户看不出该怎么办。"""
    from kvm.media.proxy import probe_source

    with pytest.raises(RuntimeError) as exc:
        probe_source("/nonexistent/ffprobe", tmp_path / "x.mkv")
    assert "探测视频失败" in str(exc.value)


def test_产物已被清理时不算缓存命中(tmp_path: Path) -> None:
    from kvm.media.proxy import _load_cache_entry, _save_cache_entry

    _save_cache_entry(tmp_path, "key", str(tmp_path / "不存在.mp4"))
    assert _load_cache_entry(tmp_path, "key") is None


# ---- 平台编码器顺序 ----


@pytest.mark.parametrize(
    ("platform", "first"),
    [("darwin", "h264_videotoolbox"), ("win32", "h264_nvenc"), ("linux", "h264_nvenc")],
)
def test_各平台优先硬件编码(platform: str, first: str) -> None:
    assert encoder_candidates(platform)[0] == first


def test_每个平台都以纯软件编码兜底() -> None:
    for platform in ("darwin", "win32", "linux"):
        assert encoder_candidates(platform)[-1] == "libx264"


def test_windows_同时给出_nvidia_与_intel_两条硬件路径() -> None:
    assert "h264_qsv" in encoder_candidates("win32")


# ---- 契约：代理与原视频必须分开 ----


def test_老工程文件缺代理字段也能正常读取() -> None:
    # 向后兼容：本机已有的工程 JSON 都是在这个字段之前写的
    old = '{"id": "abc123", "title": "旧工程", "video_path": "/tmp/a.mkv"}'
    project = ProjectDTO.model_validate_json(old)
    assert project.proxy_video_path is None
    assert project.video_path == "/tmp/a.mkv"


def test_代理与原视频是两个独立字段() -> None:
    # 导出读 video_path、预览读 proxy_video_path，混用就会拿 540p 素材出片
    project = ProjectDTO(id="abc123", video_path="/tmp/src.mkv", proxy_video_path="/tmp/proxy.mp4")
    assert project.video_path != project.proxy_video_path


def test_proxy_可以下发但不可导入() -> None:
    from kvm.api.routes.media import _IMPORT_FIELDS, _MEDIA_FIELDS

    assert _MEDIA_FIELDS["proxy"] == "proxy_video_path"
    # 代理是本工具从原视频派生出来的中间产物，不是用户素材
    assert "proxy" not in _IMPORT_FIELDS
