"""P0-5：用 yt-dlp 实测下载「赤春花 (feat. 幾田りら)」MV，并验证时间基准。

## 为什么这一步是阻断性的

这是做出第一个成品视频的第一步：后续全部 mora 时间轴、ASS `\\k` 序列，
都建立在"抽出来的音频 0 时刻 == MV 视频轨 0 时刻"这个假设上。
CLAUDE.md §11 明确点名这是**没人验证过**的坑：
"yt-dlp 合并出的容器 `start_time != 0` 时 ASS 绝对时间会整体偏；
VFR / YouTube VP9 的时间戳；烧录时是否强制 CFR"。
本脚本用真实下载的文件实测这几点，而不是凭印象假设"时间就是时间"。

## 验证曲的版本区分（CLAUDE.md §5.2 / §9 强调的头号坑）

同名曲「赤春花」至少对应三个不同的 YouTube 视频，必须用标题 + 频道 + 时长三条件
一起判定，只看标题会认错：

| 版本 | 视频 ID（本脚本实测锁定） | 时长 | 判据 |
|---|---|---|---|
| sumika 官方 MV（本次要下载的目标） | `HCC-0sr_-lo` | 284s | 标题含"Music Video"，频道 `sumika official`（`UCCdibO9eRKJIre22DKDNqug`），发布于 2026-07-23 |
| 同曲 Art Track（YouTube 自动生成音频轨视频） | `PZ3CB2vmGYo` | 260s | description 以 "Provided to YouTube by Sony Music Labels Inc." 开头，发布于 2026-02-24（紧贴数字先行配信日），标题只有"赤春花"三字 |
| 2025 年 FM802 ACCESS! 合唱原版 | 不在本脚本范围 | ~247s（CLAUDE.md 已记录） | 署名企划名 `Studio April`，非 `sumika official` 频道 |

## 运行方式

不改 `pyproject.toml`、不建 `.venv`，用 `--with` 临时引入 yt-dlp：

    cd <repo_root>
    uv run --python 3.12 --with yt-dlp python -m experiments.download_mv

产物写到 `workspace/media/`（已在 .gitignore 中）。
"""

from __future__ import annotations

import json
import statistics
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yt_dlp
from yt_dlp.utils import DownloadError

from experiments.ffmpeg_locate import find_ffmpeg_with_libass

# --- 已用 ytsearch 实测锁定的目标（判据见模块文档的版本区分表）---
MV_VIDEO_ID = "HCC-0sr_-lo"
MV_URL = f"https://www.youtube.com/watch?v={MV_VIDEO_ID}"
ART_TRACK_VIDEO_ID = "PZ3CB2vmGYo"
ART_TRACK_URL = f"https://www.youtube.com/watch?v={ART_TRACK_VIDEO_ID}"

REPO_ROOT = Path(__file__).resolve().parent.parent
MEDIA_DIR = REPO_ROOT / "workspace" / "media"

# 判定"这确实是官方 MV 而不是别的版本"的硬条件。
_EXPECTED_CHANNEL = "sumika official"
_EXPECTED_TITLE_KEYWORDS = ("赤春花", "幾田りら")
_EXPECTED_DURATION_RANGE_S = (270, 300)  # MV 284s，留余量；用来把 Art Track(260s) 排除掉


@dataclass
class FormatInfo:
    """探测到的单条 format 摘要（只取渲染/对齐决策关心的字段）。"""

    format_id: str
    codec: str
    resolution: str
    bitrate_kbps: float | None
    sample_rate_hz: int | None
    ext: str


@dataclass
class ProbeResult:
    """下载前的探测结果：不落盘，只读元数据。"""

    video_id: str
    title: str
    channel: str
    duration_s: float
    age_limit: int
    availability: str | None
    total_formats: int
    best_video: FormatInfo | None
    best_audio: FormatInfo | None
    extractor_warnings: list[str]


@dataclass
class TimingProbe:
    """容器时间基准实测结果，对应 CLAUDE.md §11 点名的坑。"""

    container_start_time_s: float | None
    video_stream_start_time_s: float | None
    audio_stream_start_time_s: float | None
    video_r_frame_rate: str | None
    video_avg_frame_rate: str | None
    rate_fields_agree: bool | None
    sampled_frame_count: int
    pts_delta_mean_ms: float | None
    pts_delta_stdev_ms: float | None
    is_cfr_by_pts_measurement: bool | None


@dataclass
class DownloadReport:
    """整个实验的最终结论，落盘为 JSON，供交付时引用具体数字。"""

    mv_probe: ProbeResult | None = None
    art_track_probe: ProbeResult | None = None
    download_ok: bool = False
    download_error: str | None = None
    merged_file: str | None = None
    merged_file_size_bytes: int | None = None
    merged_container_timing: TimingProbe | None = None
    audio_44k_path: str | None = None
    audio_44k_duration_s: float | None = None
    audio_16k_mono_path: str | None = None
    audio_16k_mono_duration_s: float | None = None
    notes: list[str] = field(default_factory=list)


def _fmt_summary(f: dict[str, Any]) -> FormatInfo:
    vcodec = f.get("vcodec") or "none"
    acodec = f.get("acodec") or "none"
    codec = vcodec if vcodec != "none" else acodec
    height = f.get("height")
    resolution = f"{f.get('width')}x{height}" if height else "-"
    return FormatInfo(
        format_id=str(f.get("format_id")),
        codec=str(codec),
        resolution=resolution,
        bitrate_kbps=f.get("tbr"),
        sample_rate_hz=f.get("asr"),
        ext=str(f.get("ext")),
    )


def probe_formats(url: str, video_id: str) -> ProbeResult:
    """只探测不下载：拉取元数据 + 全部 format 列表，挑出最佳视频/音频流。"""
    warnings: list[str] = []
    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": False,
        "skip_download": True,
        "logger": _WarningCollector(warnings),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    assert info is not None, f"extract_info 对 {url} 返回了 None"

    formats = info.get("formats") or []
    video_only = [
        f
        for f in formats
        if f.get("vcodec") not in (None, "none") and f.get("acodec") in (None, "none")
    ]
    audio_only = [
        f
        for f in formats
        if f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none")
    ]
    best_video = max(
        video_only, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0), default=None
    )
    best_audio = max(audio_only, key=lambda f: f.get("abr") or 0, default=None)

    return ProbeResult(
        video_id=video_id,
        title=str(info.get("title")),
        channel=str(info.get("channel") or info.get("uploader")),
        duration_s=float(info.get("duration") or 0),
        age_limit=int(info.get("age_limit") or 0),
        availability=info.get("availability"),
        total_formats=len(formats),
        best_video=_fmt_summary(best_video) if best_video else None,
        best_audio=_fmt_summary(best_audio) if best_audio else None,
        extractor_warnings=warnings,
    )


class _WarningCollector:
    """把 yt-dlp 的 warning 收集起来，而不是只打印到 stderr 就丢掉。

    PO Token / n-challenge 失败这类信息只会以 warning 形式出现，
    下载本身可能仍然"成功"（拿到次优 format），必须如实记录，不能假装没发生。
    """

    def __init__(self, sink: list[str]) -> None:
        self._sink = sink

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        self._sink.append(msg)
        print(f"[yt-dlp warning] {msg}", file=sys.stderr)

    def error(self, msg: str) -> None:
        self._sink.append(f"ERROR: {msg}")
        print(f"[yt-dlp error] {msg}", file=sys.stderr)


def verify_mv_identity(probe: ProbeResult) -> list[str]:
    """校验探测到的元数据确实是目标 MV，而不是 Art Track / 2025 原版。

    返回不满足的判据描述列表；空列表表示全部通过。
    """
    problems: list[str] = []
    if probe.channel != _EXPECTED_CHANNEL:
        problems.append(f"频道不是 {_EXPECTED_CHANNEL!r}，实际是 {probe.channel!r}")
    if not all(kw in probe.title for kw in _EXPECTED_TITLE_KEYWORDS):
        problems.append(f"标题缺少关键词 {_EXPECTED_TITLE_KEYWORDS}，实际标题 {probe.title!r}")
    lo, hi = _EXPECTED_DURATION_RANGE_S
    if not (lo <= probe.duration_s <= hi):
        problems.append(
            f"时长 {probe.duration_s}s 不在预期区间 [{lo}, {hi}]（可能拿到了 Art Track 或原版）"
        )
    return problems


def download(url: str, video_id: str, outdir: Path) -> Path:
    """视频与音频分离下载后 remux（stream copy，不重编码）。

    刻意不设 `ignoreerrors=True`：CLAUDE.md §5.1 明确警告过，设了它下载失败会
    静默返回而不抛异常，必须让失败以异常形式冒出来，不能被吞掉。
    """
    outdir.mkdir(parents=True, exist_ok=True)
    ydl_opts: dict[str, Any] = {
        "format": "bv*+ba/b",
        "merge_output_format": "mkv",
        "outtmpl": str(outdir / f"{video_id}.%(ext)s"),
        "progress_hooks": [_progress_hook],
        "quiet": False,
        "noprogress": False,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ret = ydl.download([url])
    if ret != 0:
        msg = f"yt-dlp.download() 返回非零码 {ret}（未抛异常，但不代表成功）"
        raise RuntimeError(msg)

    candidates = sorted(outdir.glob(f"{video_id}.*"))
    candidates = [p for p in candidates if p.suffix not in (".part", ".ytdl")]
    if not candidates:
        msg = f"download() 声称成功，但 {outdir} 下找不到 {video_id}.* 产物文件"
        raise RuntimeError(msg)
    # 优先要 merge_output_format 指定的 mkv；找不到就退而求其次拿第一个。
    mkv = [p for p in candidates if p.suffix == ".mkv"]
    return mkv[0] if mkv else candidates[0]


def _progress_hook(d: dict[str, Any]) -> None:
    status = d.get("status")
    if status == "downloading":
        pct = d.get("_percent_str", "?")
        speed = d.get("_speed_str", "?")
        print(f"  下载中 {pct} 速度 {speed}", end="\r", file=sys.stderr)
    elif status == "finished":
        print(f"  完成分片: {d.get('filename')}", file=sys.stderr)
    elif status == "error":
        print("  下载出错", file=sys.stderr)


def _run_ffprobe_json(ffprobe_bin: str, args: list[str]) -> dict[str, Any]:
    proc = subprocess.run(
        [ffprobe_bin, "-v", "error", "-of", "json", *args],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    return json.loads(proc.stdout or "{}")


def probe_timing(path: Path, ffmpeg_bin: str) -> TimingProbe:
    """实测容器起始 PTS 是否为 0、是否 CFR。

    分两步：
    1. `-show_format -show_streams` 读容器与各流声明的 start_time /
       r_frame_rate（编码时声明值）/ avg_frame_rate（容器统计值）。
       两者不等是 VFR 的强信号，但只是"声明"，不是"实测"。
    2. `-show_frames` 直接采样前 N 个视频帧的时间戳，用相邻帧 pts 差的
       标准差判定是否真的等间隔——这是"实测"而非"声明"，避免被
       元数据糊弄。
    """
    ffprobe_bin = str(Path(ffmpeg_bin).with_name("ffprobe"))
    if not Path(ffprobe_bin).is_file():
        msg = f"在 ffmpeg 同目录下找不到 ffprobe：{ffprobe_bin}"
        raise RuntimeError(msg)

    meta = _run_ffprobe_json(
        ffprobe_bin,
        ["-show_format", "-show_streams", str(path)],
    )
    fmt = meta.get("format", {})
    streams = meta.get("streams", [])
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), {})

    r_rate = v_stream.get("r_frame_rate")
    avg_rate = v_stream.get("avg_frame_rate")
    rate_fields_agree = (r_rate == avg_rate) if (r_rate and avg_rate) else None

    # 直接采样前 100 个视频帧的时间戳做实测。
    frames_data = _run_ffprobe_json(
        ffprobe_bin,
        [
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-read_intervals",
            "%+#100",
            str(path),
        ],
    )
    frames = frames_data.get("frames", [])
    pts_values: list[float] = []
    for fr in frames:
        raw = fr.get("best_effort_timestamp_time")
        if raw is not None:
            pts_values.append(float(raw))

    deltas_ms = [(pts_values[i + 1] - pts_values[i]) * 1000.0 for i in range(len(pts_values) - 1)]
    pts_delta_mean_ms = statistics.fmean(deltas_ms) if deltas_ms else None
    pts_delta_stdev_ms = statistics.pstdev(deltas_ms) if len(deltas_ms) > 1 else None
    # 阈值 0.5ms：CFR 编码的帧间隔抖动理论上应为 0（受限于时间基精度），
    # 留一点浮点误差余量；明显 VFR 的抖动会是几十到几百 ms 量级。
    is_cfr = (pts_delta_stdev_ms is not None) and (pts_delta_stdev_ms < 0.5)

    return TimingProbe(
        container_start_time_s=float(fmt["start_time"])
        if fmt.get("start_time") is not None
        else None,
        video_stream_start_time_s=float(v_stream["start_time"])
        if v_stream.get("start_time") is not None
        else None,
        audio_stream_start_time_s=float(a_stream["start_time"])
        if a_stream.get("start_time") is not None
        else None,
        video_r_frame_rate=r_rate,
        video_avg_frame_rate=avg_rate,
        rate_fields_agree=rate_fields_agree,
        sampled_frame_count=len(pts_values),
        pts_delta_mean_ms=pts_delta_mean_ms,
        pts_delta_stdev_ms=pts_delta_stdev_ms,
        is_cfr_by_pts_measurement=is_cfr,
    )


def _probe_wav_duration(path: Path, ffmpeg_bin: str) -> float:
    ffprobe_bin = str(Path(ffmpeg_bin).with_name("ffprobe"))
    data = _run_ffprobe_json(ffprobe_bin, ["-show_format", str(path)])
    return float(data["format"]["duration"])


def extract_audio(video_path: Path, ffmpeg_bin: str, outdir: Path) -> tuple[Path, Path]:
    """抽音频产出两份：原始采样率立体声（合成用）+ 16k 单声道（模型推理用）。

    刻意不加 `-copyts` / `-avoid_negative_ts`：先用 ffmpeg 的默认行为跑一次，
    再用 `probe_timing` 的容器起始 PTS 与抽出 wav 的时长做交叉核对，
    实测默认行为到底有没有把非零起始 PTS 的偏移吃掉——这正是本实验要回答的问题，
    不能提前"修好"它，否则就测不出默认行为的真实坑在哪。
    """
    outdir.mkdir(parents=True, exist_ok=True)
    audio_44k = outdir / "audio_44k.wav"
    audio_16k_mono = outdir / "audio_16k_mono.wav"

    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "2",
            str(audio_44k),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(audio_16k_mono),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return audio_44k, audio_16k_mono


def main() -> int:
    report = DownloadReport()
    ffmpeg_bin = find_ffmpeg_with_libass()
    print(f"使用 ffmpeg: {ffmpeg_bin}")

    # --- 1. 探测：MV 与 Art Track 的元数据，校验版本判据 ---
    print("\n=== 探测 MV 元数据（不下载）===")
    try:
        mv_probe = probe_formats(MV_URL, MV_VIDEO_ID)
        report.mv_probe = mv_probe
        print(json.dumps(asdict(mv_probe), ensure_ascii=False, indent=2))
        problems = verify_mv_identity(mv_probe)
        if problems:
            for p in problems:
                report.notes.append(f"MV 身份校验失败: {p}")
                print(f"[警告] 身份校验未通过: {p}", file=sys.stderr)
        else:
            report.notes.append("MV 身份校验通过：频道/标题/时长均符合官方 MV 判据")
    except DownloadError as e:
        report.notes.append(f"探测 MV 失败: {e}")
        print(f"[错误] 探测 MV 失败: {e}", file=sys.stderr)

    print("\n=== 探测 Art Track 元数据（仅记录，不下载）===")
    try:
        art_probe = probe_formats(ART_TRACK_URL, ART_TRACK_VIDEO_ID)
        report.art_track_probe = art_probe
        print(json.dumps(asdict(art_probe), ensure_ascii=False, indent=2))
    except DownloadError as e:
        report.notes.append(f"探测 Art Track 失败（不影响主流程）: {e}")
        print(f"[警告] 探测 Art Track 失败: {e}", file=sys.stderr)

    # --- 2. 实际下载 MV ---
    print("\n=== 下载 MV ===")
    try:
        merged = download(MV_URL, MV_VIDEO_ID, MEDIA_DIR)
        report.download_ok = True
        report.merged_file = str(merged)
        report.merged_file_size_bytes = merged.stat().st_size
        print(f"\n下载完成: {merged} ({report.merged_file_size_bytes} bytes)")
    except (DownloadError, RuntimeError) as e:
        report.download_ok = False
        report.download_error = str(e)
        print(f"[错误] 下载失败: {e}", file=sys.stderr)
        _write_report(report)
        return 1

    # --- 3. 时间基准实测 ---
    print("\n=== 校验容器时间基准（起始 PTS / CFR）===")
    try:
        timing = probe_timing(merged, ffmpeg_bin)
        report.merged_container_timing = timing
        print(json.dumps(asdict(timing), ensure_ascii=False, indent=2))
    except (subprocess.CalledProcessError, RuntimeError) as e:
        report.notes.append(f"时间基准探测失败: {e}")
        print(f"[错误] 时间基准探测失败: {e}", file=sys.stderr)

    # --- 4. 抽音频 ---
    print("\n=== 抽取音频 ===")
    try:
        audio_44k, audio_16k = extract_audio(merged, ffmpeg_bin, MEDIA_DIR)
        report.audio_44k_path = str(audio_44k)
        report.audio_16k_mono_path = str(audio_16k)
        report.audio_44k_duration_s = _probe_wav_duration(audio_44k, ffmpeg_bin)
        report.audio_16k_mono_duration_s = _probe_wav_duration(audio_16k, ffmpeg_bin)
        print(f"audio_44k.wav      : {audio_44k} ({report.audio_44k_duration_s:.3f}s)")
        print(f"audio_16k_mono.wav : {audio_16k} ({report.audio_16k_mono_duration_s:.3f}s)")

        start = (
            report.merged_container_timing.container_start_time_s
            if report.merged_container_timing
            else None
        )
        if start is not None:
            if start > 0.001:
                video_dur = report.mv_probe.duration_s if report.mv_probe else None
                report.notes.append(
                    f"容器 start_time={start:.6f}s 非零；抽出的 audio_44k.wav 时长="
                    f"{report.audio_44k_duration_s:.3f}s，探测到的整体时长="
                    f"{video_dur}s。若 wav 时长 ≈ (整体时长 - start_time)，"
                    "说明 ffmpeg 默认行为吃掉了起始偏移（丢弃了对应时长的"
                    "首段数据，wav 的 0 时刻不等于视频轨的 0 时刻）；"
                    "若 wav 时长 ≈ 整体时长，说明起始偏移未被处理，"
                    "需要在正式管线里显式核算这个偏移量。"
                )
            else:
                report.notes.append("容器 start_time ≈ 0，未观测到起始 PTS 偏移问题。")
    except subprocess.CalledProcessError as e:
        report.notes.append(f"抽音频失败: {e.stderr}")
        print(f"[错误] 抽音频失败: {e.stderr}", file=sys.stderr)

    _write_report(report)
    return 0


def _write_report(report: DownloadReport) -> None:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    out = MEDIA_DIR / "download_report.json"
    out.write_text(json.dumps(asdict(report), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告已写入: {out}")


if __name__ == "__main__":
    sys.exit(main())
