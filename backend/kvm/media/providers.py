"""视频源 provider 抽象与选流策略（下载层的生产落点）。

原型与实测证据在 `experiments/download_provider.py`（保留原样不动，它记录了
B站/YouTube 各档音频的实测码率与频带上限）；这里是它**生产所需部分**的迁入版：
provider 抽象、站点适配、选流策略、yt-dlp 依赖自动化。生产代码不再 import
`experiments/`，否则后端必须靠 `PYTHONPATH=backend:.` 才能启动，打包时必挂。

## 架构（与 CLAUDE.md §5.2 歌词源已定的形状一致）

**provider 只负责"取回并归一化"，不负责选择；选择交给站点无关的 selector。**

    VideoProvider.match(url)        -> bool            能不能处理这个 URL
    VideoProvider.resolve(url)      -> ResolvedTarget  规范化 URL / 判定单集还是列表
    VideoProvider.probe(target)     -> MediaProbe      探测格式并归一化成统一模型
    StreamSelector.select(probe)    -> StreamSelection 按策略选流（站点无关）
    VideoProvider.download(...)     -> DownloadResult  下载 + 归一化元数据

## 三条必须保住的关键判断（迁移时最容易丢的东西）

1. **音频优先于画质**：管线是 `下载 → 抽音频 → 去人声 → 强制对齐 → 烧字幕`，
   视频只是背景板，音频却是分离与对齐的唯一输入。实测把同一份音频压成
   "B站级"（AAC 81k / 低通 15.9 kHz）再分离，htdemucs 的 SI-SDR 掉
   vocals −0.84 dB / instrumental −1.31 dB，而 §5.4 里"标准档 vs 最佳档"
   两个分离模型的差距只有 0.1 SDR —— **选错音源的损失比选错模型大一个数量级**。
   所以 `SelectionPolicy` 只给视频分辨率上限，**不给音频任何降档口子**。
2. **跨编码比较必须折算等效码率**：Opus 117 kbps（YouTube fmt 251）频带到
   20.3 kHz，AAC-LC 185 kbps（B站）只到 16.2 kHz。直接比 kbps 会选反。
3. **bilibili 裸 BV 号在多P 稿件上会被 yt-dlp 展开成 playlist**，必须在
   `BilibiliProvider.probe()` 拦截并报错，不能一口气拖十几个分P，也不能
   替用户擅自选一集。

## 与 CLAUDE.md §2.6 的一致性

yt-dlp 是"系统里可能有、可能没有、有也可能过期"的典型依赖，而且 YouTube /
bilibili 的抽取器失效是运维常态。`YtDlpManager` 落实三段式：查找（应用私有
目录 → 当前解释器 → 系统 PATH）→ 获取 → 更新。更新按 §5.1 已定的方式做：
子进程跑一次 `uv pip install -U --pre "yt-dlp[default]"`，不用 yt-dlp 内置的
`-U`（pip/uv 装的会被 `is_non_updateable()` 拒绝）。
"""

from __future__ import annotations

import random
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from abc import ABC, abstractmethod
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, ClassVar


def default_private_deps_dir() -> Path:
    """自动获取的依赖装在哪（CLAUDE.md §2.6：一律装进应用私有目录，不污染用户系统）。

    实验脚本原本落在仓库内的 `.kvm/`，那个位置在打好包的应用里根本不存在；
    生产改用与工程 JSON 同一个应用数据根目录下的 `deps/`，卸载即删目录。
    """
    from kvm.api.store import default_root

    return default_root().parent / "deps"


# ===========================================================================
# 第一部分：yt-dlp 依赖自动化（CLAUDE.md §2.6 / §5.1）
# ===========================================================================


@dataclass
class YtDlpStatus:
    """一次 yt-dlp 可用性自检的结果，直接可以喂给启动自检报告。"""

    available: bool
    version: str | None
    source: str
    age_days: int | None
    stale: bool
    updatable: bool
    message: str


class YtDlpManager:
    """yt-dlp 的查找 / 获取 / 更新。

    为什么值得单独一个类：抽取器失效是**运维常态**而非异常。用户遇到的
    "下载失败"里有相当比例其实是"yt-dlp 该升级了"，如果只把 DownloadError
    原样抛给 UI，用户永远不知道该做什么。
    """

    # 超过这个天数就认为可能已经跟不上站点变更，值得提示升级。
    STALE_AFTER_DAYS = 30

    def __init__(self, private_dir: Path | None = None) -> None:
        self._private_dir = private_dir or default_private_deps_dir()
        self._module: Any = None

    def locate(self) -> YtDlpStatus:
        """按 §2.6 规定的顺序解析：私有目录 → 当前解释器 → 系统 PATH。

        注意判据是**实际能力**而不是存在性：能 import 且能读出版本号才算数，
        和 ffmpeg 探测"看 ass 滤镜是否注册"是同一个原则。
        """
        private_site = self._private_dir / "python" / "site-packages"
        if private_site.is_dir() and str(private_site) not in sys.path:
            sys.path.insert(0, str(private_site))

        try:
            import yt_dlp

            self._module = yt_dlp
            version = str(yt_dlp.version.__version__)
            source = str(Path(yt_dlp.__file__).resolve().parent)
        except ImportError:
            binary = shutil.which("yt-dlp")
            if binary is None:
                return YtDlpStatus(
                    available=False,
                    version=None,
                    source="未找到",
                    age_days=None,
                    stale=True,
                    updatable=True,
                    message="yt-dlp 不可用，需要先自动获取（见 upgrade()）",
                )
            out = subprocess.run(
                [binary, "--version"],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            version = out.stdout.strip() or None
            source = f"系统 PATH: {binary}"

        age = self._version_age_days(version)
        stale = age is None or age > self.STALE_AFTER_DAYS
        return YtDlpStatus(
            available=True,
            version=version,
            source=source,
            age_days=age,
            stale=stale,
            updatable=True,
            message=(
                f"yt-dlp {version}（{age} 天前发布），建议升级"
                if stale
                else f"yt-dlp {version} 较新"
            ),
        )

    @staticmethod
    def _version_age_days(version: str | None) -> int | None:
        """yt-dlp 的版本号就是发布日期（YYYY.MM.DD），直接拿来算新鲜度。"""
        if not version:
            return None
        match = re.match(r"^(\d{4})\.(\d{2})\.(\d{2})", version)
        if not match:
            return None
        import datetime

        released = datetime.date(*(int(g) for g in match.groups()))
        today = datetime.datetime.now(tz=datetime.UTC).date()
        return (today - released).days

    def upgrade_command(self) -> list[str]:
        """返回升级命令但**不执行**。

        真正执行必须由上层在用户确认后触发，并且升级完要重启后端进程 ——
        已经 import 进内存的旧 extractor 不会因为装了新包就换掉。
        """
        return [
            "uv", "pip", "install", "-U", "--pre",
            "--target", str(self._private_dir / "python" / "site-packages"),
            "yt-dlp[default]",
        ]

    def upgrade(self, timeout_s: int = 600) -> tuple[bool, str]:
        """执行升级。返回 (是否成功, 输出摘要)。"""
        cmd = self.upgrade_command()
        try:
            out = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout_s, check=False
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return False, f"{type(exc).__name__}: {exc}"
        ok = out.returncode == 0
        tail = (out.stdout or out.stderr).strip().splitlines()[-3:]
        return ok, "\n".join(tail)

    @property
    def module(self) -> Any:
        """真正会被用到的 yt-dlp **库**（下载走 `import yt_dlp`，不是命令行子进程）。

        `locate()` 在只找到 PATH 里的 yt-dlp 命令行时 `available` 也会是 True，
        所以调用方应以能否取到这个属性为准。
        """
        if self._module is None:
            self.locate()
        if self._module is None:
            msg = "yt-dlp 不可用，且自动获取未执行"
            raise RuntimeError(msg)
        return self._module


# ===========================================================================
# 第二部分：归一化数据模型（站点无关）
# ===========================================================================


class TargetKind(Enum):
    """一个 URL 指向什么。

    这个枚举的存在是为了把"用户粘了个链接"和"这个链接到底是一个视频还是一堆"
    分开。实测里裸 BV 号（多P 稿件）、番剧 ss 号、UP 主合集都会展开成列表，
    直接丢给 downloader 会一口气拖十几个分P。
    """

    SINGLE = "single"  # 单个可下载条目
    COLLECTION = "collection"  # 需要上层选集：分P / 整季 / 合集 / 播放列表
    UNSUPPORTED = "unsupported"


@dataclass
class ResolvedTarget:
    """URL 规范化结果。"""

    site: str
    kind: TargetKind
    canonical_url: str
    media_id: str
    part_index: int | None = None
    raw_url: str = ""
    hint: str = ""


class CodecFamily(Enum):
    """音频编码族。选流时要跨编码比较质量，光比 kbps 会得出错误结论。"""

    LOSSLESS = "lossless"
    OPUS = "opus"
    VORBIS = "vorbis"
    AAC_LC = "aac_lc"
    AAC_HE = "aac_he"
    MP3 = "mp3"
    UNKNOWN = "unknown"


# 跨编码的等效系数：把 kbps 折算成"相当于多少 kbps 的 AAC-LC"。
# 依据是本项目实测出的可用信息量而非听感评测：
#   - Opus 117 kbps（YouTube fmt 251）频带到 20.3 kHz，
#     而 AAC-LC 81 kbps（B站）只到 15.9 kHz，AAC-LC 185 kbps 也只到 16.2 kHz。
#     即同码率下 Opus 保留的带宽与细节明显更多，取 1.5。
#   - HE-AAC 的高频是 SBR 参数化重建出来的，不是真实采样。对听感尚可，
#     但对分离模型来说是"伪高频"，会被当成信号一起搬进 stem，故重罚到 0.5。
CODEC_EQUIVALENCE: dict[CodecFamily, float] = {
    CodecFamily.LOSSLESS: 10.0,
    CodecFamily.OPUS: 1.5,
    CodecFamily.VORBIS: 1.15,
    CodecFamily.AAC_LC: 1.0,
    CodecFamily.AAC_HE: 0.5,
    CodecFamily.MP3: 0.85,
    CodecFamily.UNKNOWN: 0.8,
}


def classify_audio_codec(codec: str | None, abr: float | None) -> CodecFamily:
    """把各站各异的 codec 串归一到编码族。"""
    text = (codec or "").lower()
    if any(k in text for k in ("flac", "alac", "pcm", "wav")):
        return CodecFamily.LOSSLESS
    if "opus" in text:
        return CodecFamily.OPUS
    if "vorbis" in text:
        return CodecFamily.VORBIS
    if "mp3" in text or text.startswith("mp4a.40.34"):
        return CodecFamily.MP3
    # mp4a.40.5 / .29 是 HE-AAC(v1/v2)。B站的 30216 档在 PGC 内容上就是它。
    if text.startswith(("mp4a.40.5", "mp4a.40.29")) or "he-aac" in text:
        return CodecFamily.AAC_HE
    if "aac" in text or text.startswith("mp4a"):
        # 有些站不给 profile 串，只能靠码率兜底判：低于 80k 的 AAC 多半是 HE
        if abr is not None and abr < 80:
            return CodecFamily.AAC_HE
        return CodecFamily.AAC_LC
    return CodecFamily.UNKNOWN


@dataclass
class AudioStream:
    """归一化的音频流。"""

    stream_id: str
    codec_raw: str
    family: CodecFamily
    kbps: float | None
    sample_rate_hz: int | None
    channels: int | None
    ext: str
    tier_label: str = ""
    requires_login: bool = False
    requires_premium: bool = False

    @property
    def effective_kbps(self) -> float:
        """折算成 AAC-LC 等效码率，用于跨编码比较。"""
        return (self.kbps or 0.0) * CODEC_EQUIVALENCE[self.family]


@dataclass
class VideoStream:
    """归一化的视频流。"""

    stream_id: str
    codec_raw: str
    width: int | None
    height: int | None
    fps: float | None
    kbps: float | None
    ext: str
    requires_login: bool = False
    requires_premium: bool = False


@dataclass
class MediaProbe:
    """一次探测的归一化结果。"""

    site: str
    target: ResolvedTarget
    title: str
    uploader: str | None
    duration_s: float | None
    thumbnail: str | None
    upload_date: str | None
    audios: list[AudioStream] = field(default_factory=list)
    videos: list[VideoStream] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    subtitle_langs: list[str] = field(default_factory=list)
    auto_subtitle_langs: list[str] = field(default_factory=list)

    @property
    def best_audio_effective_kbps(self) -> float:
        return max((a.effective_kbps for a in self.audios), default=0.0)


@dataclass
class DownloadResult:
    """下载产物 + 归一化元数据。下游阶段只认这个结构，不认站点。"""

    ok: bool
    site: str
    media_id: str
    path: Path | None
    title: str
    uploader: str | None
    duration_s: float | None
    upload_date: str | None
    source_url: str
    selected_video_id: str | None
    selected_audio_id: str | None
    audio_family: CodecFamily | None
    audio_kbps: float | None
    audio_sample_rate_hz: int | None
    error: str | None = None
    notes: list[str] = field(default_factory=list)


# ===========================================================================
# 第三部分：选流策略（站点无关，是本模块的核心）
# ===========================================================================


@dataclass
class SelectionPolicy:
    """选流策略。默认值就是卡拉OK 场景的正确取值。"""

    # 视频只是背景板，可以为省磁盘设上限；1080p 对烧字幕已绰绰有余。
    max_video_height: int | None = 1080
    # 音频**没有**上限参数 —— 这是刻意的：任何"为了省流量降音频"的开关
    # 都会直接损害分离与对齐，不给这个口子。
    prefer_video_codec: tuple[str, ...] = ("avc1", "av01", "vp9", "hev1")
    # 允许在必要时接受需要登录的流（上层需已备好 cookie）
    allow_login_required: bool = False
    allow_premium_required: bool = False


@dataclass
class StreamSelection:
    audio: AudioStream | None
    video: VideoStream | None
    format_expr: str
    rationale: list[str] = field(default_factory=list)


class StreamSelector:
    """按策略选流。

    **音频优先**在这里有三处具体体现，不是一句口号：

    1. 音频候选与视频候选**独立打分**，音频不受 `max_video_height` 之类的
       预算约束影响；视频可以降档，音频不设上限。
    2. 音频比较用 `effective_kbps`（跨编码等效换算），而不是原始 kbps。
       否则 Opus 117k 会被 AAC 185k 压过去 —— 而实测频带上限是 20.3 kHz
       对 16.2 kHz，恰恰相反。
    3. 若站点只有音视频合流的 progressive 格式（音频质量被视频档位绑架），
       则**按音频反推视频档位**：选音频最好的那条合流，哪怕它的画质不是最高。
    """

    def __init__(self, policy: SelectionPolicy | None = None) -> None:
        self.policy = policy or SelectionPolicy()

    def _audio_key(self, stream: AudioStream) -> tuple[float, int, int, str]:
        # 主键：等效码率。次键：采样率（44.1k 与 48k 混排时取高的，
        # 重采样到 16k 喂对齐器时滤波器行为更可控）。再次：声道数。
        # 末键：档位 id 字典序 —— bilibili 常把 30232/30280 转出同一份数据，
        # 码率完全相同，此时取标称更高的 30280，报告与缓存键才稳定。
        return (
            stream.effective_kbps,
            stream.sample_rate_hz or 0,
            stream.channels or 0,
            stream.stream_id,
        )

    def _video_key(self, stream: VideoStream) -> tuple[int, int, float]:
        codec = (stream.codec_raw or "").lower()
        pref = next(
            (
                len(self.policy.prefer_video_codec) - i
                for i, name in enumerate(self.policy.prefer_video_codec)
                if codec.startswith(name)
            ),
            0,
        )
        return (stream.height or 0, pref, stream.kbps or 0.0)

    def _allowed(self, stream: AudioStream | VideoStream) -> bool:
        if stream.requires_login and not self.policy.allow_login_required:
            return False
        return not (stream.requires_premium and not self.policy.allow_premium_required)

    def select(self, probe: MediaProbe) -> StreamSelection:
        rationale: list[str] = []
        audios = [a for a in probe.audios if self._allowed(a)]
        videos = [v for v in probe.videos if self._allowed(v)]

        best_audio = max(audios, key=self._audio_key, default=None)
        if best_audio is not None:
            rationale.append(
                f"音频选 {best_audio.stream_id}"
                f"（{best_audio.codec_raw} {best_audio.kbps or 0:.1f} kbps "
                f"→ 等效 {best_audio.effective_kbps:.1f} kbps AAC-LC，"
                f"{best_audio.sample_rate_hz or '?'} Hz）"
                f"；音频不设码率上限，因为分离与对齐只吃它"
            )
            others = sorted(audios, key=self._audio_key, reverse=True)[1:3]
            if others:
                rationale.append(
                    "落选音频档："
                    + "、".join(
                        f"{a.stream_id}={a.effective_kbps:.0f}等效k" for a in others
                    )
                )
        else:
            rationale.append("⚠ 没有可用的独立音频流")

        capped = videos
        if self.policy.max_video_height is not None:
            capped = [
                v for v in videos if (v.height or 0) <= self.policy.max_video_height
            ] or videos
            if capped is not videos:
                rationale.append(
                    f"视频按策略封顶 {self.policy.max_video_height}p"
                    "（背景板而已，省磁盘与解码开销；音频不受此约束）"
                )
        best_video = max(capped, key=self._video_key, default=None)
        if best_video is not None:
            rationale.append(
                f"视频选 {best_video.stream_id}"
                f"（{best_video.codec_raw} {best_video.width}x{best_video.height} "
                f"{best_video.kbps or 0:.0f} kbps）"
            )

        if best_audio is None and best_video is not None:
            rationale.append(
                "⚠ 只有合流格式：音频质量被视频档位绑架，"
                "此时按音频反推档位，宁可牺牲画质"
            )

        parts: list[str] = []
        if best_video is not None:
            parts.append(best_video.stream_id)
        if best_audio is not None:
            parts.append(best_audio.stream_id)
        expr = "+".join(parts) if parts else "bv*+ba/b"
        return StreamSelection(
            audio=best_audio, video=best_video, format_expr=expr, rationale=rationale
        )


# ===========================================================================
# 第四部分：Provider 抽象与站点实现
# ===========================================================================


@dataclass
class SiteCapabilities:
    """一个站点的能力与限制。全部来自实测，不写"应该"。"""

    site: str
    display_name: str
    anonymous_max_height: int | None
    anonymous_max_audio_kbps: float | None
    lossless_available: bool
    cookie_hint: str
    min_request_interval_s: float
    notes: list[str] = field(default_factory=list)


@dataclass
class RetryPolicy:
    """限流退避。指数退避 + 抖动，抖动是为了避免多任务同时重试撞在一起。"""

    max_attempts: int = 4
    base_delay_s: float = 1.5
    max_delay_s: float = 30.0

    def delay_for(self, attempt: int) -> float:
        raw = min(self.base_delay_s * (2**attempt), self.max_delay_s)
        return raw * (0.7 + 0.6 * random.random())


# `_with_retry()` 判定"重试也没用"的关键字。调用方（如下载编排层的取消逻辑）
# 会借用它让致命错误立刻终止重试循环，而不是被当成瞬时网络错误重试数次。
FATAL_ERROR_KEYWORDS: tuple[str, ...] = ("Private video", "该视频不可见", "已失效", "稿件不可见")


class VideoProvider(ABC):
    """视频源 provider。只做"取回并归一化"，不做选择。"""

    site: str = ""
    capabilities: SiteCapabilities

    def __init__(self, manager: YtDlpManager, retry: RetryPolicy | None = None) -> None:
        self._manager = manager
        self._retry = retry or RetryPolicy()
        self._last_request_at = 0.0

    # --- 站点必须实现的三件事 ---

    @abstractmethod
    def match(self, url: str) -> bool:
        """这个 URL 归不归我管。"""

    @abstractmethod
    def resolve(self, url: str) -> ResolvedTarget:
        """规范化 URL，并判定它是单集还是需要上层选集的集合。"""

    @abstractmethod
    def _annotate(self, probe: MediaProbe, info: dict[str, Any]) -> None:
        """把站点特有的信息（档位名、登录门槛、警告）补进归一化结果。"""

    # --- 以下是所有站点共用的机制 ---

    def _throttle(self) -> None:
        """按站点节流。B站的风控（code -352 / v_voucher）对突发请求敏感。"""
        gap = self.capabilities.min_request_interval_s - (
            time.monotonic() - self._last_request_at
        )
        if gap > 0:
            time.sleep(gap)
        self._last_request_at = time.monotonic()

    def _with_retry(self, action: Callable[[], Any], what: str) -> Any:
        """带退避的重试。区分"该重试的"和"重试也没用的"。"""
        last: Exception | None = None
        for attempt in range(self._retry.max_attempts):
            self._throttle()
            try:
                return action()
            except Exception as exc:  # 抽取器异常层次杂，统一按文本判定
                last = exc
                text = str(exc)
                fatal = any(k in text for k in FATAL_ERROR_KEYWORDS)
                if fatal or attempt == self._retry.max_attempts - 1:
                    break
                time.sleep(self._retry.delay_for(attempt))
        msg = f"{what} 失败（重试 {self._retry.max_attempts} 次）：{last}"
        raise RuntimeError(msg)

    def _ydl_opts(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            # 绝不开 ignoreerrors：开了以后下载失败会静默返回，
            # 这是 CLAUDE.md §5.1 点名的坑
            "ignoreerrors": False,
        }
        opts.update(extra or {})
        return opts

    def probe(self, target: ResolvedTarget) -> MediaProbe:
        """探测并归一化。不落盘。"""
        yt_dlp = self._manager.module

        def _extract() -> dict[str, Any]:
            with yt_dlp.YoutubeDL(self._ydl_opts({"skip_download": True})) as ydl:
                return ydl.extract_info(target.canonical_url, download=False)

        info = self._with_retry(_extract, f"探测 {target.canonical_url}")
        probe = MediaProbe(
            site=self.site,
            target=target,
            title=info.get("title") or "",
            uploader=info.get("uploader") or info.get("channel"),
            duration_s=info.get("duration"),
            thumbnail=info.get("thumbnail"),
            upload_date=info.get("upload_date"),
            subtitle_langs=sorted((info.get("subtitles") or {}).keys()),
            auto_subtitle_langs=sorted((info.get("automatic_captions") or {}).keys()),
        )
        for fmt in info.get("formats") or []:
            vcodec = fmt.get("vcodec") or "none"
            acodec = fmt.get("acodec") or "none"
            fid = str(fmt.get("format_id"))
            if vcodec == "none" and acodec != "none":
                abr = fmt.get("abr") or fmt.get("tbr")
                probe.audios.append(
                    AudioStream(
                        stream_id=fid,
                        codec_raw=acodec,
                        family=classify_audio_codec(acodec, abr),
                        kbps=abr,
                        sample_rate_hz=fmt.get("asr"),
                        channels=fmt.get("audio_channels"),
                        ext=fmt.get("ext") or "",
                    )
                )
            elif vcodec != "none":
                probe.videos.append(
                    VideoStream(
                        stream_id=fid,
                        codec_raw=vcodec,
                        width=fmt.get("width"),
                        height=fmt.get("height"),
                        fps=fmt.get("fps"),
                        kbps=fmt.get("vbr") or fmt.get("tbr"),
                        ext=fmt.get("ext") or "",
                    )
                )
        self._annotate(probe, info)
        return probe

    def download(
        self,
        target: ResolvedTarget,
        selection: StreamSelection,
        dest_dir: Path,
        progress_hook: Callable[[dict[str, Any]], None] | None = None,
    ) -> DownloadResult:
        """按选定的流下载并 remux 成 mkv（stream copy，不重编码）。"""
        yt_dlp = self._manager.module
        dest_dir.mkdir(parents=True, exist_ok=True)
        stem = f"{self.site}_{target.media_id}"
        opts = self._ydl_opts(
            {
                "format": selection.format_expr,
                "merge_output_format": "mkv",
                "outtmpl": str(dest_dir / f"{stem}.%(ext)s"),
                "overwrites": True,
            }
        )
        if progress_hook is not None:
            opts["progress_hooks"] = [progress_hook]

        def _run() -> tuple[int, dict[str, Any]]:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(target.canonical_url, download=True)
                return 0, info

        try:
            _, info = self._with_retry(_run, f"下载 {target.canonical_url}")
        except RuntimeError as exc:
            return DownloadResult(
                ok=False, site=self.site, media_id=target.media_id, path=None,
                title="", uploader=None, duration_s=None, upload_date=None,
                source_url=target.canonical_url, selected_video_id=None,
                selected_audio_id=None, audio_family=None, audio_kbps=None,
                audio_sample_rate_hz=None, error=str(exc),
            )

        hits = sorted(dest_dir.glob(stem + ".*"))
        path = next((p for p in hits if p.suffix == ".mkv"), hits[0] if hits else None)
        audio = selection.audio
        return DownloadResult(
            ok=path is not None,
            site=self.site,
            media_id=target.media_id,
            path=path,
            title=info.get("title") or "",
            uploader=info.get("uploader") or info.get("channel"),
            duration_s=info.get("duration"),
            upload_date=info.get("upload_date"),
            source_url=target.canonical_url,
            selected_video_id=selection.video.stream_id if selection.video else None,
            selected_audio_id=audio.stream_id if audio else None,
            audio_family=audio.family if audio else None,
            audio_kbps=audio.kbps if audio else None,
            audio_sample_rate_hz=audio.sample_rate_hz if audio else None,
            error=None if path else "下载完成但找不到产物",
            notes=list(selection.rationale),
        )

    def list_entries(self, target: ResolvedTarget, limit: int = 200) -> list[dict[str, Any]]:
        """展开一个集合（分P / 整季 / 合集 / 播放列表）供上层选集。

        故意做成显式调用：`probe()` 遇到集合应当报错而不是自作主张下载全部。
        """
        yt_dlp = self._manager.module
        opts = self._ydl_opts(
            {
                "skip_download": True,
                "extract_flat": "in_playlist",
                "playlist_items": f"1-{limit}",
            }
        )

        def _extract() -> dict[str, Any]:
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(target.canonical_url, download=False)

        info = self._with_retry(_extract, f"展开 {target.canonical_url}")
        entries: list[dict[str, Any]] = []
        for entry in info.get("entries") or []:
            url = entry.get("url") or entry.get("webpage_url") or ""
            entries.append(
                {
                    # 扁平展开时不是每个站都给 id：bilibili 的分P 条目只有 url，
                    # 此处统一回退到从 URL 反推，保证上层拿到的结构一致
                    "id": entry.get("id") or self._entry_id_from_url(url),
                    "title": entry.get("title"),
                    "duration": entry.get("duration"),
                    "url": url,
                }
            )
        return entries

    def _entry_id_from_url(self, url: str) -> str:
        """扁平条目缺 id 时的回退。默认取 URL 末段，站点可覆写。"""
        return url.rsplit("/", 1)[-1] if url else ""


class YouTubeProvider(VideoProvider):
    """YouTube。基准源：音频是 Opus，跨编码等效码率最高。"""

    site = "youtube"
    capabilities = SiteCapabilities(
        site="youtube",
        display_name="YouTube",
        anonymous_max_height=2160,
        # 实测 fmt 251（Opus）在验证曲上是 117.1 kbps ES，等效 ~176 kbps AAC-LC
        anonymous_max_audio_kbps=160.0,
        lossless_available=False,
        cookie_hint="通常不需要 cookie；触发 PO Token 风控时才需 --cookies-from-browser",
        min_request_interval_s=0.0,
        notes=[
            "抽取器因签名解密/PO Token 策略变化频繁失效，版本新鲜度是首要排障项",
            "官方 ja 人工字幕在 subtitles 而非 automatic_captions，是最稳的歌词兜底源",
        ],
    )

    _RE = re.compile(r"(youtube\.com|youtu\.be)", re.IGNORECASE)

    def match(self, url: str) -> bool:
        return bool(self._RE.search(url))

    def resolve(self, url: str) -> ResolvedTarget:
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.netloc.endswith("youtu.be"):
            video_id = parsed.path.lstrip("/")
        else:
            video_id = (query.get("v") or [""])[0]
        # 用户从播放列表里复制的链接会带 &list=，直接丢给 yt-dlp 会拖下整个列表。
        # 有 v= 时一律按单集处理，list 参数丢掉。
        if video_id:
            return ResolvedTarget(
                site=self.site,
                kind=TargetKind.SINGLE,
                canonical_url=f"https://www.youtube.com/watch?v={video_id}",
                media_id=video_id,
                raw_url=url,
                hint="已剥离 list/index 等播放列表参数" if "list" in query else "",
            )
        if "list" in query or "/playlist" in parsed.path:
            return ResolvedTarget(
                site=self.site,
                kind=TargetKind.COLLECTION,
                canonical_url=url,
                media_id=(query.get("list") or [""])[0],
                raw_url=url,
                hint="播放列表，需要上层选集",
            )
        return ResolvedTarget(
            site=self.site, kind=TargetKind.UNSUPPORTED, canonical_url=url,
            media_id="", raw_url=url, hint="无法从 URL 提取视频 id",
        )

    def _annotate(self, probe: MediaProbe, info: dict[str, Any]) -> None:
        if info.get("age_limit"):
            for stream in [*probe.audios, *probe.videos]:
                stream.requires_login = True
            probe.warnings.append("年龄限制内容，需要登录 cookie")
        if "ja" in probe.subtitle_langs:
            probe.warnings.append("存在官方 ja 人工字幕，可作为歌词兜底源（§5.2）")


class BilibiliProvider(VideoProvider):
    """bilibili。差异全部收敛在这里。"""

    site = "bilibili"
    capabilities = SiteCapabilities(
        site="bilibili",
        display_name="哔哩哔哩",
        # 实测：匿名裸请求只给到 480p；yt-dlp 默认带的 try_look=1（官方对游客
        # 开放的高画质试看）能拿到 1080p；1080P+ / 4K 始终不在返回列表里
        anonymous_max_height=1080,
        anonymous_max_audio_kbps=192.0,
        lossless_available=False,  # Hi-Res FLAC 需大会员且 UP 主开启，游客拿不到
        cookie_hint=(
            "1080P+ / 4K / Hi-Res FLAC / 杜比全景声需登录且多数需大会员；"
            "用 --cookies-from-browser 由用户自行提供，不内置任何绕过手段"
        ),
        min_request_interval_s=0.8,
        notes=[
            "音频档位是固定 id 命名空间而非连续量：30216/30232/30280/30250/30251",
            (
                "30280 标称 192K，但 UGC 实测在 81~201 kbps 之间浮动——转码是 VBR 且"
                "受 UP 主源文件质量限制，标称值不能当结论"
            ),
            "番剧（PGC）的音频是稳定的 191 kbps，UGC 则完全看投稿源",
            "裸 BV 号在多P 稿件上会展开成播放列表，必须显式带 ?p=N",
        ],
    )

    AUDIO_TIERS: ClassVar[dict[str, tuple[str, bool, bool]]] = {
        # id: (档位名, 是否需登录, 是否需大会员)
        "30216": ("64K 档", False, False),
        "30232": ("132K 档", False, False),
        "30280": ("192K 档", False, False),
        "30250": ("杜比全景声", True, True),
        "30251": ("Hi-Res 无损 FLAC", True, True),
    }
    # 视频档位 id → 清晰度名。1080P+ 及以上游客拿不到。
    VIDEO_TIERS: ClassVar[dict[int, tuple[str, bool, bool]]] = {
        16: ("360P 流畅", False, False),
        32: ("480P 清晰", False, False),
        64: ("720P 高清", False, False),
        80: ("1080P 高清", False, False),
        112: ("1080P+ 高码率", True, True),
        116: ("1080P60", True, True),
        120: ("4K 超清", True, True),
        125: ("HDR 真彩", True, True),
        126: ("杜比视界", True, True),
        127: ("8K 超高清", True, True),
    }

    _RE = re.compile(r"(bilibili\.com|b23\.tv)", re.IGNORECASE)
    _BV_RE = re.compile(r"/video/(BV[0-9A-Za-z]+)")
    _EP_RE = re.compile(r"/bangumi/play/(ep\d+)", re.IGNORECASE)
    _SS_RE = re.compile(r"/bangumi/play/(ss\d+)", re.IGNORECASE)
    _COLLECTION_RE = re.compile(
        r"space\.bilibili\.com/\d+/(channel/collectiondetail|lists)", re.IGNORECASE
    )

    def match(self, url: str) -> bool:
        return bool(self._RE.search(url))

    def resolve(self, url: str) -> ResolvedTarget:
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)

        if self._COLLECTION_RE.search(url):
            return ResolvedTarget(
                site=self.site, kind=TargetKind.COLLECTION, canonical_url=url,
                media_id=(query.get("sid") or [parsed.path.rsplit("/", 1)[-1]])[0],
                raw_url=url, hint="UP 主合集，需要上层选集",
            )
        ss_match = self._SS_RE.search(url)
        if ss_match:
            return ResolvedTarget(
                site=self.site, kind=TargetKind.COLLECTION,
                canonical_url=f"https://www.bilibili.com/bangumi/play/{ss_match.group(1)}",
                media_id=ss_match.group(1), raw_url=url, hint="番剧整季，需要上层选集",
            )
        ep_match = self._EP_RE.search(url)
        if ep_match:
            return ResolvedTarget(
                site=self.site, kind=TargetKind.SINGLE,
                canonical_url=f"https://www.bilibili.com/bangumi/play/{ep_match.group(1)}",
                media_id=ep_match.group(1), raw_url=url,
                hint="番剧单集；游客画质上限 480P，且多数需大会员才有高清",
            )
        bv_match = self._BV_RE.search(url)
        if bv_match:
            bvid = bv_match.group(1)
            page = (query.get("p") or [None])[0]
            if page is not None:
                # 只保留 p，丢掉 spm_id_from / vd_source 等跟踪参数：
                # 它们不影响解析但会让缓存键、日志、工程文件里的来源 URL 变脏
                return ResolvedTarget(
                    site=self.site, kind=TargetKind.SINGLE,
                    canonical_url=f"https://www.bilibili.com/video/{bvid}?p={page}",
                    media_id=f"{bvid}_p{page}", part_index=int(page), raw_url=url,
                    hint="已剥离跟踪参数，只保留分P 序号",
                )
            # 裸 BV 号：单P 稿件是单集，多P 稿件会展开成列表。
            # 这里不发网络请求判定，交给 probe/list_entries 时再定，
            # 但 hint 必须把风险说清楚。
            return ResolvedTarget(
                site=self.site, kind=TargetKind.SINGLE,
                canonical_url=f"https://www.bilibili.com/video/{bvid}",
                media_id=bvid, raw_url=url,
                hint="裸 BV 号：若为多P 稿件会展开成列表，须先 list_entries 再选 ?p=N",
            )
        return ResolvedTarget(
            site=self.site, kind=TargetKind.UNSUPPORTED, canonical_url=url,
            media_id="", raw_url=url, hint="无法识别的 bilibili URL 形态",
        )

    def _entry_id_from_url(self, url: str) -> str:
        """bilibili 的分P 扁平条目只带 `...?p=N` 的 URL，从中还原出 `BVxxx_pN`。"""
        bv_match = self._BV_RE.search(url)
        page = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("p")
        if bv_match and page:
            return f"{bv_match.group(1)}_p{page[0]}"
        return bv_match.group(1) if bv_match else super()._entry_id_from_url(url)

    def probe(self, target: ResolvedTarget) -> MediaProbe:
        """在通用探测之上加一层：裸 BV 号若展开成列表，明确报错而不是硬下。"""
        yt_dlp = self._manager.module

        def _extract() -> dict[str, Any]:
            with yt_dlp.YoutubeDL(self._ydl_opts({"skip_download": True})) as ydl:
                return ydl.extract_info(target.canonical_url, download=False)

        info = self._with_retry(_extract, f"探测 {target.canonical_url}")
        if info.get("_type") == "playlist":
            msg = (
                f"{target.canonical_url} 是多P 稿件（{len(info.get('entries') or [])} 个分P）。"
                "请先 list_entries() 让用户选集，再用 ?p=N 探测单集。"
            )
            raise RuntimeError(msg)
        return super().probe(target)

    def _annotate(self, probe: MediaProbe, info: dict[str, Any]) -> None:
        for audio in probe.audios:
            label, need_login, need_premium = self.AUDIO_TIERS.get(
                audio.stream_id, ("未知档位", False, False)
            )
            audio.tier_label = label
            audio.requires_login = need_login
            audio.requires_premium = need_premium

        if probe.audios and all(a.sample_rate_hz is None for a in probe.audios):
            probe.warnings.append(
                "bilibili 抽取器不填 asr：采样率只能下载后 ffprobe 确认。"
                "实测同为 30280 档，有的稿件 48 kHz、有的 44.1 kHz —— "
                "重采样到 16 kHz 喂对齐器前必须以实测值为准，不能假设 48 kHz"
            )

        heights = {v.height or 0 for v in probe.videos}
        if heights and max(heights) <= 480:
            probe.warnings.append(
                "只探到 ≤480P：番剧/受限稿件的游客上限就是这个，"
                "更高清晰度需要登录 cookie（多数还需大会员）"
            )
        elif heights and max(heights) <= 1080:
            probe.warnings.append(
                "游客上限 1080P。源片若为 4K，1080P+/4K 档需登录 cookie，"
                "本工具不做任何绕过"
            )
        best = max(probe.audios, key=lambda a: a.effective_kbps, default=None)
        if best is not None and (best.kbps or 0) < 100:
            probe.warnings.append(
                f"最高音频档只有 {best.kbps:.0f} kbps —— 这是 UP 主源文件本身就差，"
                "不是档位没选对。实测这种源会让去人声分离的 SI-SDR 掉约 1 dB，"
                "同曲若 YouTube 上也有，应优先走 YouTube"
            )


# ===========================================================================
# 第五部分：注册表
# ===========================================================================


class ProviderRegistry:
    """按 URL 派发到 provider。新增站点只需注册一个类。"""

    def __init__(self, providers: Iterable[VideoProvider]) -> None:
        self._providers = list(providers)

    def for_url(self, url: str) -> VideoProvider | None:
        return next((p for p in self._providers if p.match(url)), None)

    def all(self) -> list[VideoProvider]:
        return list(self._providers)


def build_registry(manager: YtDlpManager | None = None) -> ProviderRegistry:
    mgr = manager or YtDlpManager()
    return ProviderRegistry([YouTubeProvider(mgr), BilibiliProvider(mgr)])
