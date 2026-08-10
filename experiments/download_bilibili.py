"""bilibili 作为视频下载源的兼容性实测（新增需求：下载源不止 YouTube）。

## 为什么要测这个

CLAUDE.md §5.1 只写了 YouTube。但 bilibili 上日语曲目、翻唱、niconico 搬运的存量
远大于 YouTube —— 很多曲子 YouTube 上根本没有。所以下载层必须能吃 bilibili。

问题是 bilibili 不是"YouTube 的等价替换"，它在两个地方会直接伤到本项目的成片质量：

1. **音频码率普遍低于 YouTube。** 本项目的链路是
   `下载 → 抽音频 → 去人声分离 → 强制对齐`，分离与对齐都吃音频质量。
   低码率带来的不只是"听起来闷"：编码器的量化噪声与频带置零会被分离模型当成信号
   一起搬进 stem，让伴奏带杂音、人声残留变多；分离质量退化又会连带拉低 CTC 对齐
   的可靠性（CLAUDE.md §5.5 给出的假名起点误差预算只有 50–150 ms，没有多少余量）。
2. **登录门槛。** bilibili 的高清晰度档位对游客有限制，必须如实测出上限，
   而不是假设"和 YouTube 一样想拿什么拿什么"。

## 本脚本回答的问题

| 问题 | 对应函数 |
|---|---|
| 各样本能探到哪些流？编码/分辨率/码率/采样率 | `probe_formats` |
| 各音频档位的**真实** ES 码率（不是 DASH 声称的 bandwidth） | `measure_es_bitrate` / `remote_stream_size` |
| 音频实际频带上限（编码器低通截止点在哪） | `measure_spectrum` |
| 不登录的画质/音质天花板；1080P+/4K 是否要 cookie | `probe_login_gate` |
| 分P / 番剧 ep / 番剧 ss / 合集 URL 各自什么行为 | `probe_url_forms` |
| 容器起始 PTS 是否为 0、是否 VFR | `download_and_check_timing` |
| 同一首歌在 B 站与 YouTube 上的音质差距有多大 | `compare_with_youtube` |
| 这个差距是否足以影响去人声分离 | `separation_impact`（需 `--sep`） |

## 纪律

- 只做"取数据"式联网，不下载执行任何第三方代码，不做任何云端推理（CLAUDE.md §2.1）。
- **不尝试任何绕过登录/会员限制的手段**，游客拿不到就如实记为拿不到。
- 所有数字来自本次实际运行，跑不通就在报告里记 error 原文，不编造成功。

## 运行方式

不改 `pyproject.toml`、不建 `.venv`：

    cd <repo_root>
    uv run --python 3.12 --with yt-dlp --with numpy python -m experiments.download_bilibili

可选：追加 `--sep` 跑分离影响实验（需要额外的重依赖，且需要
`experiments/download_mv.py` 已产出 `workspace/media/` 下的真值 stem）：

    uv run --python 3.12 --with yt-dlp --with numpy --with audio-separator \
        --with "numba>=0.61" --with onnxruntime --with soundfile \
        python -m experiments.download_bilibili --sep

产物写到 `workspace/bilibili/`（已在 .gitignore 中）。
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yt_dlp
from yt_dlp.utils import DownloadError

from experiments.ffmpeg_locate import find_ffmpeg_with_libass

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "workspace" / "bilibili"
# experiments/download_mv.py 的产物，用作 YouTube 侧的对照基准。缺失时自动跳过对比。
YT_MEDIA_DIR = REPO_ROOT / "workspace" / "media"
YT_BASELINE_MKV = YT_MEDIA_DIR / "HCC-0sr_-lo.mkv"
YT_VOCAL_REF = YT_MEDIA_DIR / "vocal_ref_30s.wav"
YT_INST_REF = YT_MEDIA_DIR / "instrumental_ref_30s.wav"
YT_SYNTH_MIX = YT_MEDIA_DIR / "synth_mix_30s.wav"

REPORT_PATH = OUT_DIR / "bilibili_probe_report.json"

# bilibili CDN 对无 Referer 的请求会 403，探测远端体积时必须带上 yt-dlp 给的头。
_FALLBACK_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://www.bilibili.com/",
}

# bilibili 的音频档位 id 是固定命名空间，不是"越大越好"的连续量，
# 必须显式映射，否则选流策略只能靠猜。
AUDIO_TIER_NAMES = {
    "30216": "64K 档（AAC-LC / 部分 PGC 为 HE-AAC）",
    "30232": "132K 档",
    "30280": "192K 档",
    "30250": "Dolby Atmos（需大会员）",
    "30251": "Hi-Res 无损 FLAC（需大会员且 UP 主开启）",
}


@dataclass
class BiliSample:
    """一个实测样本。`role` 说明它覆盖的是需求里的哪一类内容。"""

    key: str
    role: str
    url: str
    note: str = ""


# 样本经 bilibili 搜索 API 实检索得到（keyword 见各条 note），覆盖需求要求的
# 「日语歌曲 MV / 翻唱 / niconico 搬运」三类，外加一条与 YouTube 同曲的对照样本。
SAMPLES: list[BiliSample] = [
    BiliSample(
        key="mv_repost_4k",
        role="日语歌曲官方 MV 的搬运稿（源片 3840x2160）",
        url="https://www.bilibili.com/video/BV1CLg46VEBq",
        note=(
            "与 CLAUDE.md 验证曲 sumika『赤春花 (feat. 幾田りら)』"
            "的 YouTube 官方 MV(HCC-0sr_-lo) 同曲同时长，是唯一能做"
            "跨平台直接对比的样本"
        ),
    ),
    BiliSample(
        key="niconico_repost",
        role="niconico 搬运（简介标注 nicovideo.jp/watch/sm46642237）",
        url="https://www.bilibili.com/video/BV1H3u56eEAs",
        note="【初音ミク】HASU —— VOCALOID 曲，本家在 N 站",
    ),
    BiliSample(
        key="cover_nicokara",
        role="日语翻唱 + 已经是 ニコカラ 形态的稿件",
        url="https://www.bilibili.com/video/BV1pTu56TEtx",
        note="Stand By You - official髭男dism covered by 依允",
    ),
    BiliSample(
        key="hires_claim",
        role="标题自称 Hi-Res / 4K60 的高规格投稿",
        url="https://www.bilibili.com/video/BV1LGuM6zE3b",
        note="用来检验『标题写 Hi-Res』与『实际能取到的流』是否一致",
    ),
    BiliSample(
        key="multipart_p3",
        role="分P 稿件的第 3 P（on vocal 版）",
        url="https://www.bilibili.com/video/BV1Hf3J69E4Q?p=3",
        note="ニコカラ 圈常见形态：同一稿件里 on/off vocal 分 P 摆放",
    ),
    BiliSample(
        key="bangumi_ep",
        role="番剧单集（PGC 专业内容，转码流水线与 UGC 不同）",
        url="https://www.bilibili.com/bangumi/play/ep826497",
        note=("49 分钟，超过 AUDIO_DOWNLOAD_MAX_DURATION_S，只用 Range 请求量远端体积，不整段下载"),
    ),
]

# 超过这个时长的样本不整段下载音频，只用 Range 请求量体积。
# 一集 49 分钟的番剧音轨 70 MB，为了一个码率数字拖下来不划算。
AUDIO_DOWNLOAD_MAX_DURATION_S = 900.0

# URL 形态覆盖测试用。这里只探测 yt-dlp 的返回类型，不下载。
URL_FORMS: list[tuple[str, str]] = [
    ("普通稿件（BV号，单P）", "https://www.bilibili.com/video/BV1CLg46VEBq"),
    ("多P稿件的裸 BV 号（无 ?p=）", "https://www.bilibili.com/video/BV1Hf3J69E4Q"),
    ("多P稿件指定 ?p=3", "https://www.bilibili.com/video/BV1Hf3J69E4Q?p=3"),
    (
        "多P + 无关跟踪参数 ?p=3&spm_id_from=",
        "https://www.bilibili.com/video/BV1Hf3J69E4Q?p=3&spm_id_from=333.788",
    ),
    ("番剧单集 ep 号", "https://www.bilibili.com/bangumi/play/ep826497"),
    ("番剧整季 ss 号", "https://www.bilibili.com/bangumi/play/ss47836"),
    (
        "UP 主合集（旧版 collectiondetail）",
        "https://space.bilibili.com/44627483/channel/collectiondetail?sid=4098572",
    ),
    (
        "UP 主合集（新版 /lists/）",
        "https://space.bilibili.com/44627483/lists/4098572?type=season",
    ),
]

# 登录门槛实测用。直接打官方 playurl，因为 yt-dlp 已经默认带了 try_look=1，
# 用它测不出"不带试看参数时游客能拿到什么"。
LOGIN_GATE_BVID = "BV1CLg46VEBq"
LOGIN_GATE_CID = 40228028532


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


def _ffprobe_path(ffmpeg: str) -> str:
    """由 ffmpeg 路径推出同目录的 ffprobe（保持与 §2.5 的统一解析层一致）。"""
    candidate = Path(ffmpeg).with_name("ffprobe")
    return str(candidate) if candidate.is_file() else "ffprobe"


def _run_json(cmd: list[str]) -> dict[str, Any]:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False)
    if out.returncode != 0:
        msg = f"命令失败: {' '.join(cmd[:3])} ... rc={out.returncode}\n{out.stderr[:400]}"
        raise RuntimeError(msg)
    return json.loads(out.stdout)


def _http_headers(fmt: dict[str, Any]) -> dict[str, str]:
    headers = dict(fmt.get("http_headers") or {})
    return headers or dict(_FALLBACK_HEADERS)


# ---------------------------------------------------------------------------
# 一、格式探测
# ---------------------------------------------------------------------------


@dataclass
class StreamSummary:
    """一条流的摘要。只保留选流/对齐决策真正关心的字段。"""

    format_id: str
    tier_name: str
    ext: str
    codec: str
    resolution: str
    fps: float | None
    declared_kbps: float | None
    remote_bytes: int | None = None
    measured_kbps: float | None = None


@dataclass
class SampleProbe:
    key: str
    role: str
    url: str
    note: str
    ok: bool = True
    error: str | None = None
    title: str | None = None
    uploader: str | None = None
    duration_s: float | None = None
    source_resolution: str | None = None
    n_formats: int = 0
    videos: list[StreamSummary] = field(default_factory=list)
    audios: list[StreamSummary] = field(default_factory=list)


def probe_formats(sample: BiliSample) -> SampleProbe:
    """用 yt-dlp 的 Python API 探测单个样本的全部可用流。

    只 `extract_info(download=False)`，不落盘。DASH 声明的 bandwidth 会一并记下来，
    但**不作为结论**——bilibili 的 UGC 转码是 VBR，声明值与实际 ES 码率可以差很多，
    真实值由 `remote_stream_size` / `measure_es_bitrate` 给出。
    """
    probe = SampleProbe(key=sample.key, role=sample.role, url=sample.url, note=sample.note)
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(sample.url, download=False)
    except (DownloadError, OSError) as exc:  # ExtractorError 不是 DownloadError 子类
        probe.ok = False
        probe.error = f"{type(exc).__name__}: {exc}"
        return probe
    except Exception as exc:  # noqa: BLE001 —— 抽取器异常层次杂，实验脚本要记录而不是崩
        probe.ok = False
        probe.error = f"{type(exc).__name__}: {exc}"
        return probe

    if info.get("_type") == "playlist":
        probe.ok = False
        probe.error = "该 URL 展开成了播放列表（多P/合集），样本探测需要指定单集"
        return probe

    probe.title = info.get("title")
    probe.uploader = info.get("uploader")
    probe.duration_s = info.get("duration")
    formats = info.get("formats") or []
    probe.n_formats = len(formats)

    for fmt in formats:
        vcodec = fmt.get("vcodec") or "none"
        acodec = fmt.get("acodec") or "none"
        fid = str(fmt.get("format_id"))
        summary = StreamSummary(
            format_id=fid,
            tier_name=AUDIO_TIER_NAMES.get(fid, ""),
            ext=fmt.get("ext") or "",
            codec=vcodec if vcodec != "none" else acodec,
            resolution=(
                f"{fmt.get('width')}x{fmt.get('height')}" if fmt.get("height") else "audio-only"
            ),
            fps=fmt.get("fps"),
            declared_kbps=fmt.get("abr") if vcodec == "none" else fmt.get("tbr"),
        )
        if vcodec == "none":
            summary.remote_bytes = remote_stream_size(fmt)
            if summary.remote_bytes and probe.duration_s:
                summary.measured_kbps = summary.remote_bytes * 8 / probe.duration_s / 1000
            probe.audios.append(summary)
        else:
            probe.videos.append(summary)

    best_v = max(probe.videos, key=lambda s: _res_area(s.resolution), default=None)
    probe.source_resolution = best_v.resolution if best_v else None
    return probe


def _res_area(resolution: str) -> int:
    if "x" not in resolution:
        return 0
    width, _, height = resolution.partition("x")
    try:
        return int(width) * int(height)
    except ValueError:
        return 0


def remote_stream_size(fmt: dict[str, Any]) -> int | None:
    """只发一个 Range 请求就拿到整条流的字节数。

    对 40 分钟的番剧，完整下载音轨要 70 MB；用 `Range: bytes=0-1` 读
    `Content-Range` 的总长度即可得到精确体积，代价是两个字节。
    这是本脚本能覆盖长视频样本而不炸磁盘的关键。
    """
    url = fmt.get("url")
    if not url:
        return None
    req = urllib.request.Request(url, headers={**_http_headers(fmt), "Range": "bytes=0-1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            content_range = resp.headers.get("Content-Range")
    except (OSError, ValueError):
        return None
    if not content_range or "/" not in content_range:
        return None
    try:
        return int(content_range.rsplit("/", 1)[1])
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# 二、音频真实质量测量
# ---------------------------------------------------------------------------


def download_stream(url: str, format_id: str, dest_stem: Path) -> Path | None:
    """下载指定单条流（不合并），返回落盘路径。失败返回 None。"""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "format": format_id,
        "outtmpl": f"{dest_stem}.%(ext)s",
        "overwrites": True,
        # ignoreerrors 会让失败静默返回，这里显式不开，靠异常与返回码双重判定
        "ignoreerrors": False,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            rc = ydl.download([url])
    except Exception as exc:  # noqa: BLE001 —— 实验脚本要记录失败而不是中断整轮
        print(f"    [下载失败] {format_id}: {type(exc).__name__}: {exc}")
        return None
    if rc != 0:
        print(f"    [下载失败] {format_id}: yt-dlp 返回码 {rc}")
        return None
    hits = sorted(dest_stem.parent.glob(dest_stem.name + ".*"))
    return hits[0] if hits else None


def measure_es_bitrate(ffprobe: str, path: Path) -> dict[str, Any]:
    """量出音频**基本流**的真实平均码率与容器参数。

    刻意不取 ffprobe 的 `format.bit_rate`：那个数含 m4a 的 moov/stts 开销，
    对 4 分钟的曲子会把 81 kbps 报成 83 kbps。逐包累加 `packet.size` 才是 ES 码率。
    """
    meta = _run_json(
        [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]
    )
    stream = meta["streams"][0]
    duration = float(meta["format"]["duration"])
    packets = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "packet=size",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    ).stdout
    total = sum(int(line.strip().rstrip(",")) for line in packets.splitlines() if line.strip())
    return {
        "codec": stream.get("codec_name"),
        "profile": stream.get("profile"),
        "channels": stream.get("channels"),
        "sample_rate_hz": int(stream.get("sample_rate", 0)) or None,
        "duration_s": duration,
        "container_kbps": round(path.stat().st_size * 8 / duration / 1000, 2),
        "elementary_stream_kbps": round(total * 8 / duration / 1000, 2),
        "packet_count": len([x for x in packets.splitlines() if x.strip()]),
        "stream_start_time_s": float(stream.get("start_time") or 0.0),
    }


def measure_spectrum(ffmpeg: str, path: Path) -> dict[str, Any] | None:
    """测编码器的低通截止频率与分频段能量。

    这是判断"这条音轨到底被压得多狠"最直接的证据：有损编码器在低码率下会
    直接把高频整段置零，截止点一目了然，比码率数字更能说明源的实际信息量。
    """
    try:
        import numpy as np
    except ImportError:
        return None

    wav = path.with_name(path.stem + "_mono48k.wav")
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(path),
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "wav",
            str(wav),
        ],
        check=True,
        timeout=600,
    )
    import wave

    with wave.open(str(wav), "rb") as handle:
        sample_rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    signal = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    wav.unlink(missing_ok=True)

    # 取中段 ±60 s，避开首尾的静音/淡入淡出，否则会把静音段的噪声底当成频谱
    mid = len(signal) // 2
    half = sample_rate * 60
    segment = signal[max(0, mid - half) : mid + half]
    if len(segment) < 8192:
        return None

    size = 8192
    window = np.hanning(size)
    accum = np.zeros(size // 2 + 1)
    frames = 0
    for start in range(0, len(segment) - size, size // 2):
        spec = np.fft.rfft(segment[start : start + size] * window)
        accum += np.abs(spec) ** 2
        frames += 1
    accum /= max(frames, 1)
    db = 10 * np.log10(accum + 1e-20)
    freqs = np.fft.rfftfreq(size, 1 / sample_rate)
    relative = db - db.max()

    above = np.where(relative > -75)[0]
    cutoff = float(freqs[above.max()]) if len(above) else 0.0

    bands: dict[str, float] = {}
    for low, high in [
        (0, 4000),
        (4000, 8000),
        (8000, 12000),
        (12000, 14000),
        (14000, 16000),
        (16000, 18000),
        (18000, 20000),
        (20000, 24000),
    ]:
        mask = (freqs >= low) & (freqs < high)
        value = 10 * np.log10(float(np.mean(10 ** (db[mask] / 10))) + 1e-20)
        bands[f"{low // 1000}-{high // 1000}k"] = round(value - float(db.max()), 1)
    return {"cutoff_hz_at_minus75db": round(cutoff), "band_energy_db_rel_peak": bands}


# ---------------------------------------------------------------------------
# 三、登录门槛
# ---------------------------------------------------------------------------


def probe_login_gate(bvid: str, cid: int) -> dict[str, Any]:
    """如实记录游客能拿到的画质上限，**不做任何绕过尝试**。

    对比三种请求：
      - 完全匿名、不带试看参数
      - 匿名 + `try_look=1`（bilibili 官方对游客开放的"高画质试看"，yt-dlp 默认带）
      - 报告 `accept_quality` 声称支持的档位与实际返回档位的差集 = 需要登录/会员的部分
    """
    base = (
        f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=127&fnval=4048&fourk=1"
    )
    result: dict[str, Any] = {"bvid": bvid, "cid": cid, "variants": {}}
    for name, url in [("匿名", base), ("匿名+try_look=1", base + "&try_look=1")]:
        req = urllib.request.Request(
            url,
            headers={
                **_FALLBACK_HEADERS,
                "Referer": f"https://www.bilibili.com/video/{bvid}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.load(resp)
        except (OSError, ValueError) as exc:
            result["variants"][name] = {"error": f"{type(exc).__name__}: {exc}"}
            continue
        data = payload.get("data") or {}
        dash = data.get("dash") or {}
        heights = sorted({v.get("height") for v in dash.get("video") or []}, reverse=True)
        result["variants"][name] = {
            "api_code": payload.get("code"),
            "accept_description": data.get("accept_description"),
            "accept_quality": data.get("accept_quality"),
            "returned_video_heights": heights,
            "returned_audio_ids": sorted({str(a.get("id")) for a in dash.get("audio") or []}),
            "has_flac_hires": bool((dash.get("flac") or {}).get("audio")),
            "has_dolby": bool((dash.get("dolby") or {}).get("audio")),
        }
    return result


# ---------------------------------------------------------------------------
# 四、URL 形态覆盖
# ---------------------------------------------------------------------------


def probe_url_forms() -> list[dict[str, Any]]:
    """探测各类 bilibili URL 在 yt-dlp 下的返回形态。

    重点不是"能不能解析"，而是**解析成单集还是播放列表**：
    多P 稿件的裸 BV 号会展开成整个列表，生产代码若直接把用户粘贴的链接丢给
    downloader，会一次性拖下十几个分P。这是必须在 provider 层拦住的行为差异。
    """
    rows: list[dict[str, Any]] = []
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "playlist_items": "1-3",
    }
    for label, url in URL_FORMS:
        row: dict[str, Any] = {"形态": label, "url": url}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as exc:  # noqa: BLE001
            row.update(ok=False, error=f"{type(exc).__name__}: {exc}")
            rows.append(row)
            continue
        is_playlist = info.get("_type") == "playlist"
        row.update(
            ok=True,
            extractor=info.get("extractor_key"),
            returns="playlist（多条目）" if is_playlist else "single（单条目）",
            title=(info.get("title") or "")[:60],
            entry_count=len(info.get("entries") or []) if is_playlist else 1,
            first_entries=[str(e.get("id")) for e in (info.get("entries") or [])[:3]]
            if is_playlist
            else [str(info.get("id"))],
            n_formats=0 if is_playlist else len(info.get("formats") or []),
            max_height=0
            if is_playlist
            else max((f.get("height") or 0 for f in info.get("formats") or []), default=0),
        )
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# 五、完整下载 + 时间基准
# ---------------------------------------------------------------------------


def download_and_check_timing(ffmpeg: str, ffprobe: str, url: str, stem: str) -> dict[str, Any]:
    """实际下载一个样本并验证时间基准。

    CLAUDE.md §6.2 把「容器 `start_time != 0` 会让 ASS 绝对时间整体偏移」列为
    未验证的坑。YouTube 侧已由 `experiments/download_mv.py` 测过为 0；
    bilibili 走的是完全不同的转码流水线（DASH 分片 + 自家 muxer），必须单独测。
    """
    result: dict[str, Any] = {"url": url}
    opts = {
        "quiet": True,
        "no_warnings": True,
        # CLAUDE.md §5.1 的既定策略：最佳视频 + 最佳音频，remux 成 mkv，不重编码
        "format": "bv*+ba/b",
        "merge_output_format": "mkv",
        "outtmpl": str(OUT_DIR / f"{stem}.%(ext)s"),
        "overwrites": True,
        "ignoreerrors": False,
        "ffmpeg_location": str(Path(ffmpeg).parent),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            rc = ydl.download([url])
    except Exception as exc:  # noqa: BLE001
        result.update(ok=False, error=f"{type(exc).__name__}: {exc}")
        return result
    if rc != 0:
        result.update(ok=False, error=f"yt-dlp 返回码 {rc}")
        return result

    merged = OUT_DIR / f"{stem}.mkv"
    if not merged.is_file():
        result.update(ok=False, error="合并产物不存在")
        return result
    result.update(ok=True, file=str(merged), size_bytes=merged.stat().st_size)

    meta = _run_json(
        [ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(merged)]
    )
    video = next(s for s in meta["streams"] if s["codec_type"] == "video")
    audio = next(s for s in meta["streams"] if s["codec_type"] == "audio")
    result["timing"] = {
        "container_start_time_s": float(meta["format"].get("start_time") or 0.0),
        "video_stream_start_time_s": float(video.get("start_time") or 0.0),
        "audio_stream_start_time_s": float(audio.get("start_time") or 0.0),
        "video_codec": video.get("codec_name"),
        "video_resolution": f"{video.get('width')}x{video.get('height')}",
        "audio_codec": audio.get("codec_name"),
        "audio_sample_rate_hz": audio.get("sample_rate"),
        "r_frame_rate": video.get("r_frame_rate"),
        "avg_frame_rate": video.get("avg_frame_rate"),
    }

    # 采样前 200 帧的 PTS 间隔判定 CFR/VFR。r_frame_rate == avg_frame_rate 只是必要条件，
    # 真正会咬人的是逐帧间隔抖动，必须实测。
    pts_out = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-read_intervals",
            "%+60",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
            str(merged),
        ],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    ).stdout
    times = [
        float(line.strip().rstrip(","))
        for line in pts_out.splitlines()
        if line.strip().rstrip(",").replace(".", "", 1).isdigit()
    ]
    if len(times) > 10:
        deltas = [(times[i + 1] - times[i]) * 1000 for i in range(min(len(times) - 1, 200))]
        mean = sum(deltas) / len(deltas)
        var = sum((d - mean) ** 2 for d in deltas) / len(deltas)
        result["timing"].update(
            sampled_frames=len(deltas) + 1,
            pts_delta_mean_ms=round(mean, 4),
            pts_delta_stdev_ms=round(var**0.5, 4),
            is_cfr_by_pts_measurement=var**0.5 < 0.5,
        )

    # 抽音频，验证抽出来的两条轨确实完整可用（管线阶段 [2]）
    audio_44k = OUT_DIR / f"{stem}_audio_44k.wav"
    audio_16k = OUT_DIR / f"{stem}_audio_16k_mono.wav"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(merged),
            "-vn",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(audio_44k),
        ],
        check=True,
        timeout=900,
    )
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(merged),
            "-vn",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(audio_16k),
        ],
        check=True,
        timeout=900,
    )
    for key, path in [("audio_44k", audio_44k), ("audio_16k_mono", audio_16k)]:
        info = _run_json([ffprobe, "-v", "error", "-show_format", "-of", "json", str(path)])
        result[key] = {
            "path": str(path),
            "duration_s": float(info["format"]["duration"]),
            "size_bytes": path.stat().st_size,
        }
    return result


# ---------------------------------------------------------------------------
# 六、与 YouTube 同曲直接对比
# ---------------------------------------------------------------------------


def compare_with_youtube(ffmpeg: str, ffprobe: str, bili_audio: Path) -> dict[str, Any] | None:
    """把 bilibili 的音轨与 YouTube 同曲音轨做逐帧对比。

    做法：都解码成 48 kHz 单声道 → 互相关估时间偏移 → 增益归一 → 以 YouTube 轨为
    参考算分频段 SNR。注意这是**两份各自有损编码的对比**，不是"距离母带的距离"，
    所以数值应读作"bilibili 相对 YouTube 多出来的失真"，而非绝对音质。
    """
    if not YT_BASELINE_MKV.is_file():
        return None
    try:
        import numpy as np
    except ImportError:
        return None

    bili_wav = OUT_DIR / "cmp_bili_mono48k.wav"
    yt_wav = OUT_DIR / "cmp_yt_mono48k.wav"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(bili_audio),
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "wav",
            str(bili_wav),
        ],
        check=True,
        timeout=600,
    )
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(YT_BASELINE_MKV),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "wav",
            str(yt_wav),
        ],
        check=True,
        timeout=600,
    )

    import wave

    def _load(path: Path) -> tuple[Any, int]:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            raw = handle.readframes(handle.getnframes())
        return np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0, rate

    bili, sample_rate = _load(bili_wav)
    youtube, _ = _load(yt_wav)

    # 先确认两条轨是同一段音频且时间对齐 —— 不对齐的话后面的 SNR 全是噪声
    mid = len(youtube) // 2
    ref = youtube[mid : mid + sample_rate * 10]
    probe = bili[mid - sample_rate * 2 : mid + sample_rate * 12]
    corr = np.correlate(probe - probe.mean(), ref - ref.mean(), mode="valid")
    lag = int(np.argmax(corr)) - sample_rate * 2

    length = min(len(bili), len(youtube))
    a = bili[:length]
    b = youtube[:length]
    gain = float(np.dot(a, b) / np.dot(b, b))
    scaled = b * gain
    diff = a - scaled

    size = 8192
    window = np.hanning(size)
    freqs = np.fft.rfftfreq(size, 1 / sample_rate)
    bands = [
        (0, 1000),
        (1000, 2000),
        (2000, 4000),
        (4000, 6000),
        (6000, 8000),
        (8000, 12000),
        (12000, 16000),
        (16000, 20000),
    ]
    sig = np.zeros(len(bands))
    noise = np.zeros(len(bands))
    for start in range(sample_rate * 60, min(len(diff), sample_rate * 220) - size, size // 2):
        s_spec = np.abs(np.fft.rfft(scaled[start : start + size] * window)) ** 2
        d_spec = np.abs(np.fft.rfft(diff[start : start + size] * window)) ** 2
        for idx, (low, high) in enumerate(bands):
            mask = (freqs >= low) & (freqs < high)
            sig[idx] += float(s_spec[mask].sum())
            noise[idx] += float(d_spec[mask].sum())

    bili_wav.unlink(missing_ok=True)
    yt_wav.unlink(missing_ok=True)
    return {
        "youtube_reference": str(YT_BASELINE_MKV),
        "time_lag_samples": lag,
        "time_lag_ms": round(lag / sample_rate * 1000, 3),
        "gain_bili_over_yt_db": round(20 * float(np.log10(gain)), 2),
        "fullband_snr_db": round(
            10 * float(np.log10(np.dot(scaled, scaled) / max(np.dot(diff, diff), 1e-30))),
            2,
        ),
        "band_snr_db": {
            f"{low // 1000}-{high // 1000}k": round(
                10 * float(np.log10(sig[i] / max(noise[i], 1e-30))), 2
            )
            for i, (low, high) in enumerate(bands)
        },
    }


# ---------------------------------------------------------------------------
# 七、分离影响（可选，重依赖）
# ---------------------------------------------------------------------------


def simulate_bilibili_grade_audio(
    ffmpeg: str, source: Path, dest_stem: Path, kbps: int, cutoff_hz: int
) -> Path:
    """把一份高质量音频压成"bilibili 级"，用于受控对照实验。

    直接拿真实的 bilibili 文件做分离实验测不出因果：它和 YouTube 版本的母带、
    混音、响度都可能不同。要把「编码质量」这一个变量单独摘出来，只能拿同一份音频
    做 A/B —— 参数（码率、低通截止）取自本脚本对真实 bilibili 流的实测值。
    """
    encoded = dest_stem.with_suffix(".m4a")
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-ar",
            "48000",
            "-c:a",
            "aac",
            "-b:a",
            f"{kbps}k",
            "-cutoff",
            str(cutoff_hz),
            str(encoded),
        ],
        check=True,
        timeout=600,
    )
    decoded = dest_stem.with_suffix(".wav")
    subprocess.run(
        [ffmpeg, "-v", "error", "-y", "-i", str(encoded), "-ar", "44100", "-ac", "2", str(decoded)],
        check=True,
        timeout=600,
    )
    return decoded


def separation_impact(ffmpeg: str, kbps: int, cutoff_hz: int) -> dict[str, Any]:
    """量化"bilibili 级音频"对去人声分离的实际损害（SI-SDR）。

    依赖 `experiments/download_mv.py` 产出的合成真值：
    `synth_mix_30s.wav = vocal_ref_30s.wav + instrumental_ref_30s.wav`。
    有真值才能算 SI-SDR；只拿两个平台的真实文件互比是算不出"分离好坏"的。

    模型用 `htdemucs`（CLAUDE.md §5.4 的"快速"档）。选它而非 BS-Roformer 是因为
    本机上 BS-Roformer 对该 30 s 素材输出全零 vocals（`workspace/sep_probe/` 里
    另一实验的产物也是全零，说明是既有问题，不是本脚本引入的）。
    """
    out: dict[str, Any] = {"ok": False}
    missing = [str(p) for p in (YT_SYNTH_MIX, YT_VOCAL_REF, YT_INST_REF) if not p.is_file()]
    if missing:
        out["error"] = f"缺少真值素材（需先跑 experiments/download_mv.py）：{missing}"
        return out
    try:
        import numpy as np
        import soundfile as sf
        from audio_separator.separator import Separator
    except ImportError as exc:
        out["error"] = f"缺少可选依赖：{exc}（用 --with audio-separator --with soundfile）"
        return out

    model_dir = OUT_DIR / "sep_models"
    model_dir.mkdir(parents=True, exist_ok=True)
    degraded = simulate_bilibili_grade_audio(
        ffmpeg, YT_SYNTH_MIX, OUT_DIR / "sim_bili_30s", kbps, cutoff_hz
    )

    runs: dict[str, Path] = {}
    for tag, src in [("reference", YT_SYNTH_MIX), ("bilibili_grade", degraded)]:
        target = OUT_DIR / f"sep_{tag}"
        target.mkdir(parents=True, exist_ok=True)
        separator = Separator(model_file_dir=str(model_dir), output_dir=str(target), log_level=40)
        separator.load_model("htdemucs.yaml")
        separator.separate(str(src))
        runs[tag] = target

    def _mono(path: Path) -> Any:
        data, _ = sf.read(str(path), dtype="float64", always_2d=True)
        return data.mean(axis=1)

    def _si_sdr(est: Any, ref: Any) -> float:
        length = min(len(est), len(ref))
        est = est[:length] - est[:length].mean()
        ref = ref[:length] - ref[:length].mean()
        alpha = float(np.dot(est, ref) / np.dot(ref, ref))
        target = alpha * ref
        noise = est - target
        return float(10 * np.log10(np.dot(target, target) / max(np.dot(noise, noise), 1e-30)))

    def _stem(tag: str, base: str, name: str) -> Any:
        return _mono(runs[tag] / f"{base}_({name})_htdemucs.wav")

    bases = {"reference": YT_SYNTH_MIX.stem, "bilibili_grade": degraded.stem}
    vocal_ref = _mono(YT_VOCAL_REF)
    inst_ref = _mono(YT_INST_REF)
    scores: dict[str, dict[str, float]] = {}
    for tag in runs:
        base = bases[tag]
        vocals = _stem(tag, base, "Vocals")
        inst = sum(_stem(tag, base, n) for n in ("Bass", "Drums", "Other"))
        scores[tag] = {
            "vocals_si_sdr_db": round(_si_sdr(vocals, vocal_ref), 2),
            "instrumental_si_sdr_db": round(_si_sdr(inst, inst_ref), 2),
        }
    out.update(
        ok=True,
        model="htdemucs",
        simulated_kbps=kbps,
        simulated_cutoff_hz=cutoff_hz,
        scores=scores,
        delta_db={
            k: round(scores["bilibili_grade"][k] - scores["reference"][k], 2)
            for k in scores["reference"]
        },
    )
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _print_probe_table(probes: list[SampleProbe]) -> None:
    print("\n" + "=" * 96)
    print("【一】各样本可用流概览（游客身份，无 cookie）")
    print("=" * 96)
    for probe in probes:
        print(f"\n▌{probe.key} —— {probe.role}")
        print(f"  URL      : {probe.url}")
        if not probe.ok:
            print(f"  ❌ 探测失败: {probe.error}")
            continue
        print(f"  标题     : {probe.title}")
        print(f"  UP 主    : {probe.uploader}    时长: {probe.duration_s:.1f}s")
        print(f"  format 数: {probe.n_formats}")
        best = max(probe.videos, key=lambda s: _res_area(s.resolution), default=None)
        if best:
            print(
                f"  最佳视频 : {best.resolution} {best.codec} "
                f"{best.declared_kbps:.0f}k fps={best.fps}"
            )
        print("  音频档位 :")
        for audio in sorted(probe.audios, key=lambda s: s.format_id):
            measured = (
                f"{audio.measured_kbps:6.1f} kbps(实测容器)" if audio.measured_kbps else "   n/a"
            )
            print(
                f"    {audio.format_id:>6} {audio.tier_name:<32} "
                f"声称 {audio.declared_kbps or 0:6.1f}k  {measured}"
            )


def main() -> int:
    want_sep = "--sep" in sys.argv
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg_with_libass()
    ffprobe = _ffprobe_path(ffmpeg)
    print(f"ffmpeg  : {ffmpeg}")
    print(f"ffprobe : {ffprobe}")
    print(f"yt-dlp  : {yt_dlp.version.__version__}")
    print(f"产物目录: {OUT_DIR}")

    report: dict[str, Any] = {
        "yt_dlp_version": yt_dlp.version.__version__,
        "ffmpeg": ffmpeg,
    }

    # 一、格式探测
    probes = [probe_formats(s) for s in SAMPLES]
    report["samples"] = [asdict(p) for p in probes]
    _print_probe_table(probes)

    # 二、真实音频质量：对歌曲类样本完整下载最高档音频并实测
    print("\n" + "=" * 96)
    print("【二】最高档音频的真实 ES 码率与频带上限（完整下载后实测）")
    print("=" * 96)
    audio_facts: dict[str, Any] = {}
    downloaded_audio: dict[str, Path] = {}
    for probe in probes:
        if not probe.ok or not probe.audios:
            continue
        # 同码率时取档位 id 更大的那条：bilibili 会把 30232/30280 转出同一份数据，
        # 但 30280 才是"这个稿件能给到的最高档"，报告里记它更能反映真实上限。
        best_audio = max(probe.audios, key=lambda s: (s.measured_kbps or 0, s.format_id))
        print(f"\n▌{probe.key}  取 format {best_audio.format_id}")
        if (probe.duration_s or 0) > AUDIO_DOWNLOAD_MAX_DURATION_S:
            audio_facts[probe.key] = {
                "skipped_full_download": True,
                "reason": f"时长 {probe.duration_s:.0f}s 超过阈值，仅用 Range 量体积",
                "format_id": best_audio.format_id,
                "remote_bytes": best_audio.remote_bytes,
                "container_kbps": round(best_audio.measured_kbps or 0, 2),
                "declared_kbps": best_audio.declared_kbps,
            }
            print(
                f"  跳过整段下载（{probe.duration_s:.0f}s）；"
                f"远端体积 {best_audio.remote_bytes} B → "
                f"{best_audio.measured_kbps:.1f} kbps（容器口径）"
            )
            continue
        path = download_stream(probe.url, best_audio.format_id, OUT_DIR / f"audio_{probe.key}")
        if path is None:
            audio_facts[probe.key] = {"error": "下载失败"}
            continue
        downloaded_audio[probe.key] = path
        facts = measure_es_bitrate(ffprobe, path)
        spectrum = measure_spectrum(ffmpeg, path)
        if spectrum:
            facts.update(spectrum)
        audio_facts[probe.key] = facts
        print(
            f"  {facts['codec']}/{facts['profile']} "
            f"{facts['channels']}ch {facts['sample_rate_hz']}Hz  "
            f"ES {facts['elementary_stream_kbps']} kbps "
            f"(容器 {facts['container_kbps']} kbps)"
        )
        if spectrum:
            print(f"  频带上限（-75 dB）: {spectrum['cutoff_hz_at_minus75db']} Hz")
    report["audio_facts"] = audio_facts

    # 三、登录门槛
    print("\n" + "=" * 96)
    print("【三】游客（无 cookie）画质/音质上限 —— 不做任何绕过尝试")
    print("=" * 96)
    gate = probe_login_gate(LOGIN_GATE_BVID, LOGIN_GATE_CID)
    report["login_gate"] = gate
    for name, data in gate["variants"].items():
        print(f"\n▌{name}")
        if "error" in data:
            print(f"  ❌ {data['error']}")
            continue
        print(f"  服务端声称支持: {data['accept_description']}")
        print(f"  实际返回视频高: {data['returned_video_heights']}")
        print(f"  实际返回音频档: {data['returned_audio_ids']}")
        print(f"  FLAC 无损: {data['has_flac_hires']}   杜比: {data['has_dolby']}")

    # 四、URL 形态
    print("\n" + "=" * 96)
    print("【四】URL 形态覆盖")
    print("=" * 96)
    forms = probe_url_forms()
    report["url_forms"] = forms
    for row in forms:
        if not row.get("ok"):
            print(f"  ❌ {row['形态']:<34} {row.get('error', '')[:70]}")
            continue
        extra = (
            f"条目 {row['entry_count']}: {row['first_entries']}"
            if row["returns"].startswith("playlist")
            else f"format {row['n_formats']} 条，最高 {row['max_height']}p"
        )
        print(f"  ✅ {row['形态']:<34} {row['extractor']:<24} {row['returns']:<16} {extra}")

    # 五、完整下载 + 时间基准
    print("\n" + "=" * 96)
    print("【五】实际下载一个样本并验证时间基准（CLAUDE.md §6.2 的未验证项）")
    print("=" * 96)
    timing = download_and_check_timing(ffmpeg, ffprobe, SAMPLES[0].url, "sample_mv_repost_4k")
    report["full_download"] = timing
    if timing.get("ok"):
        info = timing["timing"]
        print(f"  文件      : {timing['file']}  ({timing['size_bytes'] / 1e6:.1f} MB)")
        print(
            f"  视频      : {info['video_codec']} {info['video_resolution']} "
            f"r={info['r_frame_rate']} avg={info['avg_frame_rate']}"
        )
        print(f"  音频      : {info['audio_codec']} {info['audio_sample_rate_hz']}Hz")
        print(
            f"  起始 PTS  : 容器 {info['container_start_time_s']}s / "
            f"视频 {info['video_stream_start_time_s']}s / "
            f"音频 {info['audio_stream_start_time_s']}s"
        )
        if "pts_delta_mean_ms" in info:
            print(
                f"  帧间隔    : 均值 {info['pts_delta_mean_ms']} ms  "
                f"标准差 {info['pts_delta_stdev_ms']} ms  "
                f"判定 CFR={info['is_cfr_by_pts_measurement']}"
            )
        for key in ("audio_44k", "audio_16k_mono"):
            if key in timing:
                print(f"  {key:<14}: {timing[key]['duration_s']:.3f}s")
    else:
        print(f"  ❌ 下载失败: {timing.get('error')}")

    # 六、与 YouTube 同曲对比
    print("\n" + "=" * 96)
    print("【六】与 YouTube 同曲音轨直接对比")
    print("=" * 96)
    cmp_result = None
    bili_audio = downloaded_audio.get("mv_repost_4k")
    if bili_audio is None:
        print("  跳过：bilibili 侧音频未成功下载")
    elif not YT_BASELINE_MKV.is_file():
        print(f"  跳过：缺少 YouTube 基准 {YT_BASELINE_MKV}（先跑 experiments/download_mv.py）")
    else:
        cmp_result = compare_with_youtube(ffmpeg, ffprobe, bili_audio)
        if cmp_result:
            print(
                f"  时间偏移  : {cmp_result['time_lag_samples']} samples "
                f"({cmp_result['time_lag_ms']} ms)"
            )
            print(f"  响度差    : {cmp_result['gain_bili_over_yt_db']} dB")
            print(f"  全带 SNR  : {cmp_result['fullband_snr_db']} dB（以 YouTube 轨为参考）")
            print("  分频段 SNR:")
            for band, value in cmp_result["band_snr_db"].items():
                print(f"    {band:>10}  {value:7.2f} dB")
    report["youtube_comparison"] = cmp_result

    # 七、分离影响（可选）
    if want_sep:
        print("\n" + "=" * 96)
        print("【七】bilibili 级音频对去人声分离的影响（受控 A/B）")
        print("=" * 96)
        facts = audio_facts.get("mv_repost_4k") or {}
        kbps = round(facts.get("elementary_stream_kbps") or 81)
        cutoff = int(facts.get("cutoff_hz_at_minus75db") or 16000)
        sep = separation_impact(ffmpeg, kbps, cutoff)
        report["separation_impact"] = sep
        if sep.get("ok"):
            print(
                f"  模拟参数  : AAC {sep['simulated_kbps']}k / 低通 {sep['simulated_cutoff_hz']}Hz"
            )
            for tag, score in sep["scores"].items():
                print(
                    f"  {tag:<16} vocals {score['vocals_si_sdr_db']:6.2f} dB   "
                    f"instrumental {score['instrumental_si_sdr_db']:6.2f} dB"
                )
            print(f"  差值 Δ    : {sep['delta_db']}")
        else:
            print(f"  ❌ {sep.get('error')}")

    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n结构化报告已写入: {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
