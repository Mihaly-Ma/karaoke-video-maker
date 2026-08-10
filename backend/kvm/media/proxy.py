"""编辑用代理视频（proxy video）：把工程的原始视频转成编辑器放得动的低分辨率短 GOP MP4。

## 为什么必须有这一层

yt-dlp 拿回来的最佳画质通常是 **AV1 / 3840×2160 / Matroska + Opus**。这份文件
在编辑器里有两重问题：

1. **Safari 根本放不了**。WebKit 没有 Matroska 解复用器，MKV 里的 Opus 也不认，
   而且 AV1 在 M1/M2 上没有解码支持（Apple 从 M3 / A17 Pro 才有 AV1 硬解）。
   所以"只换个容器（remux 成 MP4）"救不了，**必须转码成 H.264**。
2. **seek 慢**。4K 长 GOP 源上逐帧步进核对音节边界会卡到没法用（CLAUDE.md §9
   第 18 项预留的正是这件事）。代理按源帧率取约 1 秒的 GOP，seek 只需回退一个
   很短的 GOP。

## 代理只服务于编辑器，绝不参与导出

**成片导出必须继续用原始 4K 源**（`ProjectDTO.video_path`），代理写在
`ProjectDTO.proxy_video_path` 这个独立字段里，两者永不混用。字段名、本模块名与
`kvm.api.routes.render` 导出路径上的注释都在重复这件事：拿 540p 的代理去烧录
等于把成片画质砍掉一大截，而且是那种"导完才发现"的错误。

## 没有音轨

编辑器里的 `<video>` **永远是静音的**，声音全部走 Web Audio（CLAUDE.md §5.10
已定 D15）。所以代理一律 `-an`：既快又小，也不会有第二条音轨跟 Web Audio 抢
时间基准。

## 与长任务架构的关系

按 CLAUDE.md §5.13 走统一形态：独立子进程（ffmpeg）+ 进度事件 + 可取消 +
按输入哈希缓存。进度用 ffmpeg 的 `-progress pipe:1 -nostats`，解析 `out_time_us`
除以 ffprobe 得到的总时长（§5.11）。
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from kvm.api.schemas import JobStatus, ProjectDTO, ProxyRequest
from kvm.api.store import ProjectStore
from kvm.jobs import JobHandle, job_manager, run_cancelable

# 代理文件名固定：一个工程只保留一份代理，重生成直接原子替换掉旧的。
PROXY_FILENAME = "proxy.mp4"

# 缓存键里的实现版本。**改了编码参数或判定逻辑就要 +1**，
# 否则旧参数产出的代理会被当成命中而继续沿用。
PROXY_VERSION = "1"

# 默认高度上限。540p 在 16:9 下是 960×540，实测足够核对口型、字幕位置与画面切点，
# 而 4K 源转它只要十几秒。用户想要更清晰的画面可以调高（`ProxyRequest.max_height`）。
DEFAULT_MAX_HEIGHT = 540

# 直接 remux 复用源视频流的门槛：源的关键帧间隔超过这个值就宁可重编码，
# 否则"代理"只解决了容器问题、没解决 seek 慢（见 `plan_proxy`）。
REMUX_MAX_KEYFRAME_INTERVAL_S = 4.0

# 判定"容器本身 Safari 就能放"的后缀。WebM 不列在这里：它虽然是标准容器，
# 但里面几乎一定是 VP9/AV1 + Opus，Safari 侧的解码支持并不可靠。
_BROWSER_SAFE_SUFFIXES: frozenset[str] = frozenset({".mp4", ".m4v", ".mov"})

# 编码器探测结果缓存：键是 (ffmpeg 路径, 编码器名)。探测要真跑一次 ffmpeg，
# 每次生成代理都重跑一遍纯属浪费。
_ENCODER_PROBE_CACHE: dict[tuple[str, str], bool] = {}

# 每个工程最近一次代理任务的 job_id。前端要能在**后端自动发起**代理任务
# （下载完成 / 导入本地视频之后）时也看到进度——它没有别的途径知道那个 job_id。
_LATEST_JOBS: dict[str, str] = {}


ProxyMode = Literal["remux", "transcode"]


@dataclass(frozen=True)
class SourceInfo:
    """源视频里与代理决策相关的属性。"""

    width: int
    height: int
    fps: float
    codec_name: str
    duration_s: float
    suffix: str
    keyframe_interval_s: float | None
    """探测窗口内的平均关键帧间隔（秒）。探不出来时为 None，按"不满足 remux 条件"处理。"""


@dataclass(frozen=True)
class ProxyPlan:
    """一次代理生成的完整决策，`build_proxy_command` 只是把它翻译成 ffmpeg 参数。

    拆成独立的数据类是为了让决策可以被单测直接验证——判断逻辑（要不要转码、
    转成多高、GOP 多少）比 ffmpeg 参数拼接更容易出错，也更值得测。
    """

    mode: ProxyMode
    encoder: str
    """`mode="remux"` 时为 `copy`。"""

    target_height: int
    target_width: int
    gop: int
    bitrate_kbps: int
    """`mode="remux"` 或用 libx264（走 CRF）时为 0。"""

    reason: str
    """给用户看的中文说明，直接作为进度文案。"""


# ---------------------------------------------------------------------------
# 探测
# ---------------------------------------------------------------------------


def _ffprobe_json(ffprobe_bin: str, args: list[str]) -> dict[str, Any]:
    proc = subprocess.run(
        [ffprobe_bin, "-v", "error", "-of", "json", *args],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    return json.loads(proc.stdout or "{}")


def _parse_fraction(value: str | None) -> float:
    """把 ffprobe 的 `24000/1001` 这类分数帧率转成浮点。"""
    if not value:
        return 0.0
    if "/" in value:
        num, _, den = value.partition("/")
        try:
            denominator = float(den)
            return float(num) / denominator if denominator else 0.0
        except ValueError:
            return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def _probe_keyframe_interval_s(ffprobe_bin: str, path: Path, window_s: float = 30.0) -> float | None:
    """估算源视频前 `window_s` 秒里的平均关键帧间隔。

    这是"要不要重编码"的判据之一：只读开头一小段包头，代价是毫秒级，
    比整份文件扫一遍便宜得多，对判断 GOP 量级已经足够。
    """
    try:
        meta = _ffprobe_json(
            ffprobe_bin,
            [
                "-select_streams", "v:0",
                "-show_entries", "packet=pts_time,flags",
                "-read_intervals", f"%+{window_s:.0f}",
                str(path),
            ],
        )
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
        return None

    key_times = [
        float(pkt["pts_time"])
        for pkt in meta.get("packets", [])
        if isinstance(pkt.get("flags"), str)
        and "K" in pkt["flags"]
        and pkt.get("pts_time") is not None
    ]
    if len(key_times) < 2:
        # 窗口里只有一个关键帧 = 间隔至少和窗口一样长，这本身就是"GOP 很长"的证据
        return None if not key_times else window_s
    span = key_times[-1] - key_times[0]
    return span / (len(key_times) - 1) if span > 0 else None


def probe_source(ffprobe_bin: str, path: Path) -> SourceInfo:
    """读出源视频的分辨率、帧率、编码与关键帧间隔。

    探测失败（文件损坏、根本不是媒体文件）时抛中文说明而不是让
    `CalledProcessError` 原样冒到任务状态里——那条英文异常会被直接贴到界面上，
    用户看不出该怎么办。
    """
    try:
        meta = _ffprobe_json(ffprobe_bin, ["-show_format", "-show_streams", str(path)])
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as exc:
        msg = f"探测视频失败（文件可能已损坏，或根本不是媒体文件）：{path}"
        raise RuntimeError(msg) from exc
    streams = meta.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        msg = f"这个文件里没有视频流，无法生成编辑代理：{path}"
        raise RuntimeError(msg)

    fps = _parse_fraction(video.get("avg_frame_rate")) or _parse_fraction(video.get("r_frame_rate"))
    duration_raw = meta.get("format", {}).get("duration") or video.get("duration")
    return SourceInfo(
        width=int(video.get("width") or 0),
        height=int(video.get("height") or 0),
        fps=fps,
        codec_name=str(video.get("codec_name") or ""),
        duration_s=float(duration_raw) if duration_raw else 0.0,
        suffix=path.suffix.lower(),
        keyframe_interval_s=_probe_keyframe_interval_s(ffprobe_bin, path),
    )


# ---------------------------------------------------------------------------
# 编码器选择
# ---------------------------------------------------------------------------


def encoder_candidates(platform: str | None = None) -> tuple[str, ...]:
    """按平台给出 H.264 编码器的尝试顺序，最后一项永远是纯软件的 libx264。

    硬件编码在这里是**纯粹的省时手段**：代理是一次性的中间产物，画质只要够看清
    口型和字幕位置即可，用不着为它纠结硬编的质量上限（那条纪律属于成片导出，
    见 CLAUDE.md §5.11 已定 D9）。
    """
    system = platform or sys.platform
    if system == "darwin":
        return ("h264_videotoolbox", "libx264")
    if system.startswith("win"):
        return ("h264_nvenc", "h264_qsv", "libx264")
    # Linux：NVENC 可用就用；VAAPI 需要显式指定 render node 且参数形态完全不同，
    # 不值得为一个非目标平台（CLAUDE.md §2.2 只承诺 Windows/macOS）引入分支。
    return ("h264_nvenc", "libx264")


def _encoder_works(ffmpeg_bin: str, encoder: str) -> bool:
    """判据是**真的能编出几帧**，不是 `-encoders` 里列没列。

    与 `kvm.media.ffmpeg` 用"ass 滤镜是否注册"判 libass 是同一个原则
    （CLAUDE.md §2.6：查找阶段看实际能力而非存在性）：h264_nvenc / h264_qsv
    在没有对应显卡或驱动的机器上照样被编进 ffmpeg 并列在 `-encoders` 里，
    只有真跑一次才会暴露"运行时打不开设备"。
    """
    cached = _ENCODER_PROBE_CACHE.get((ffmpeg_bin, encoder))
    if cached is not None:
        return cached
    cmd = [
        ffmpeg_bin, "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=128x128:rate=5",
        "-frames:v", "3", "-an", "-c:v", encoder, "-b:v", "500k",
        "-f", "null", "-",
    ]
    try:
        ok = subprocess.run(cmd, capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.SubprocessError):
        ok = False
    _ENCODER_PROBE_CACHE[(ffmpeg_bin, encoder)] = ok
    return ok


def detect_h264_encoder(ffmpeg_bin: str) -> str:
    """挑一个本机真正可用的 H.264 编码器；一个都跑不通才抛错。"""
    for encoder in encoder_candidates():
        if _encoder_works(ffmpeg_bin, encoder):
            return encoder
    msg = (
        "这个 ffmpeg 没有可用的 H.264 编码器（已试："
        f"{'、'.join(encoder_candidates())}），无法生成编辑代理。"
    )
    raise RuntimeError(msg)


# ---------------------------------------------------------------------------
# 决策与命令
# ---------------------------------------------------------------------------


def target_bitrate_kbps(width: int, height: int) -> int:
    """代理的目标码率。

    基准来自本机实测：960×540 的 H.264 代理在 1.87 Mbps 下画面足够核对
    口型与字幕位置。按像素面积等比缩放到其它分辨率，并夹在一个合理区间里，
    免得极端分辨率算出荒唐的数值。
    """
    pixels = max(1, width * height)
    kbps = round(1800 * pixels / (960 * 540) / 100) * 100
    return max(600, min(8000, kbps))


def target_gop(fps: float) -> int:
    """约 1 秒一个关键帧。

    **按源帧率算，不写死 24**：源可能是 30 / 60 / 23.976fps，写死会让 GOP
    在不同源上从 0.4 秒到 1.25 秒乱飘，而这里要的恰恰是一个稳定的 1 秒。
    帧率探不出来（fps<=0）时退回 24，那是本项目最常见的源帧率量级。
    """
    if fps <= 0:
        return 24
    return max(1, min(120, round(fps)))


def plan_proxy(src: SourceInfo, max_height: int, encoder: str) -> ProxyPlan:
    """决定这次代理是转码还是仅 remux，以及转成什么规格。

    **源已经符合代理规格时不要白转。** 三个条件同时成立才允许 remux：

    1. 视频编码已经是 H.264（Safari 一定认，且 M1 起全系有硬解）；
    2. 高度不超过上限（再缩小画面对 seek 没有帮助，只是白白掉画质）；
    3. 关键帧间隔已经够短（代理存在的另一半理由就是 seek 要快——直接
       `-c:v copy` 会原样继承源的 GOP，长 GOP 源 copy 出来仍然卡）。

    容器不作为 remux 的**前置**条件：MKV 里的 H.264 短 GOP 流换个 MP4 壳
    就能放，没有理由重编码。容器只决定"要不要动"，不决定"能不能 copy"。
    """
    target_h = min(src.height, max_height) if src.height > 0 else max_height
    target_h -= target_h % 2  # H.264 的 yuv420p 要求宽高都是偶数
    target_h = max(2, target_h)
    scale = target_h / src.height if src.height > 0 else 1.0
    target_w = max(2, round(src.width * scale / 2) * 2) if src.width > 0 else 0

    keyframe_ok = (
        src.keyframe_interval_s is not None
        and src.keyframe_interval_s <= REMUX_MAX_KEYFRAME_INTERVAL_S
    )
    if src.codec_name == "h264" and src.height <= max_height and keyframe_ok:
        return ProxyPlan(
            mode="remux",
            encoder="copy",
            target_height=src.height,
            target_width=src.width,
            gop=0,
            bitrate_kbps=0,
            reason=(
                f"源已是 H.264 {src.width}×{src.height}，关键帧间隔约 "
                f"{src.keyframe_interval_s:.1f}s，转换为 MP4 容器，不重新编码"
            ),
        )

    gop = target_gop(src.fps)
    hint = "、".join(
        part
        for part in (
            f"{src.codec_name or '未知编码'} 不是 H.264" if src.codec_name != "h264" else "",
            f"{src.height}p 高于 {max_height}p 上限" if src.height > max_height else "",
            (
                "源关键帧间隔过长（"
                + (
                    f"约 {src.keyframe_interval_s:.1f}s"
                    if src.keyframe_interval_s is not None
                    else "探测不到关键帧"
                )
                + "），复制视频流无法提升跳转速度"
            )
            if not keyframe_ok
            else "",
        )
        if part
    )
    return ProxyPlan(
        mode="transcode",
        encoder=encoder,
        target_height=target_h,
        target_width=target_w,
        gop=gop,
        bitrate_kbps=target_bitrate_kbps(target_w or target_h * 16 // 9, target_h),
        reason=f"转码为 H.264 {target_w or '?'}×{target_h}（GOP {gop} 帧 ≈1 秒）：{hint}",
    )


def build_proxy_command(ffmpeg_bin: str, src: Path, dest: Path, plan: ProxyPlan) -> list[str]:
    """把 `ProxyPlan` 翻译成一条 ffmpeg 命令。

    固定项：
    - `-an -sn -dn`：代理不带音轨（`<video>` 永远静音，声音走 Web Audio）与任何
      附加流，纯粹是一条画面轨。
    - `-progress pipe:1 -nostats`：进度以 key=value 形式打到 stdout，供
      `_progress_seconds` 解析（CLAUDE.md §5.11）。
    - `-movflags +faststart`：moov 前置，浏览器不必先下完整个文件才能起播。
    """
    cmd = [
        ffmpeg_bin, "-hide_banner", "-nostats", "-progress", "pipe:1",
        "-y", "-i", str(src),
        "-map", "0:v:0", "-an", "-sn", "-dn",
    ]
    if plan.mode == "remux":
        cmd += ["-c:v", "copy"]
    else:
        cmd += [
            "-vf", f"scale=-2:{plan.target_height}",
            "-c:v", plan.encoder,
            "-pix_fmt", "yuv420p",
            "-g", str(plan.gop),
        ]
        if plan.encoder == "libx264":
            # 软件编码用 CRF 控质量；veryfast 是"代理要快"与"别糊"之间的折中。
            # sc_threshold=0 关掉场景切换插入的额外关键帧，让 GOP 真的固定在 1 秒。
            cmd += ["-preset", "veryfast", "-crf", "23", "-sc_threshold", "0"]
        else:
            # **硬件编码必须显式给码率**：videotoolbox 不给 -b:v 时会落到约
            # 200 kb/s 的默认值，画面糊到没法核对口型（CLAUDE.md §5.11 记载的坑）。
            cmd += ["-b:v", f"{plan.bitrate_kbps}k"]
    cmd += ["-movflags", "+faststart", "-f", "mp4", str(dest)]
    return cmd


def progress_seconds(line: str) -> float | None:
    """从 ffmpeg `-progress` 的一行里取出已编码时长（秒）。

    `out_time_us` 在还没有输出帧时会是 `N/A`（早期版本给负数），必须容错，
    否则第一行进度就会把整条流水线炸掉。
    """
    key, sep, value = line.strip().partition("=")
    if not sep or key not in ("out_time_us", "out_time_ms"):
        return None
    try:
        raw = int(value)
    except ValueError:
        return None
    if raw < 0:
        return None
    # 注意 ffmpeg 的 out_time_ms 实际也是微秒（历史遗留的命名错误），两者同单位
    return raw / 1_000_000


# ---------------------------------------------------------------------------
# 缓存
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cache_key(video_sha256: str, plan: ProxyPlan) -> str:
    """`(输入哈希, 参数, 实现版本)`——CLAUDE.md §5.13 规定的缓存键形态。"""
    return (
        f"{video_sha256}:{plan.mode}:{plan.encoder}:"
        f"{plan.target_height}:{plan.gop}:{plan.bitrate_kbps}:{PROXY_VERSION}"
    )


def _manifest_path(media_dir: Path) -> Path:
    return media_dir / "proxy_manifest.json"


def _load_cache_entry(media_dir: Path, key: str) -> str | None:
    path = _manifest_path(media_dir)
    if not path.is_file():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    entry = manifest.get(key)
    if not isinstance(entry, str) or not Path(entry).is_file():
        return None  # 命中键但产物已经不在了（被手动清理过），不算命中
    return entry


def _save_cache_entry(media_dir: Path, key: str, proxy_path: str) -> None:
    """写入清单。**整体覆盖，不与旧条目合并。**

    一个工程只保留一份代理（固定文件名 `proxy.mp4`），所以清单里最多只能有一条
    有效记录——新代理一落盘，之前所有键指向的就都是这个新文件了。曾经在这里做
    合并，结果是：先出 540p、再出 360p（覆盖同一个文件）、再切回 540p 时旧键
    仍在，被判成缓存命中，于是拿到的其实是 360p 那份。实测复现过，
    症状是"改了分辨率却没变化"。
    """
    _manifest_path(media_dir).write_text(
        json.dumps({key: proxy_path}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# 任务
# ---------------------------------------------------------------------------


def _write_back(store: ProjectStore, project_id: str, proxy_path: str) -> None:
    """登记代理路径。**走 `update_derived`，不占撤销格。**

    代理是后台作业的派生产物，不是用户的一次编辑意图（CLAUDE.md §8「后台产物
    不进撤销栈」）。转码常常正好在用户改完一处时间轴之后完成——若这条登记压进
    撤销栈，用户按 Cmd+Z 撤掉的会是"代理已就绪"，而不是他自己那次修改。

    `update_derived` 另有一层意义：它就地只改这一个字段，不像 `mutate` 那样
    "深拷贝 draft → 整体替换"。代理转码要十几秒到几分钟，期间用户很可能一直在
    编辑，整体替换会把这段时间里的编辑一起吞掉。
    """

    def _apply(p: ProjectDTO) -> None:
        p.proxy_video_path = proxy_path

    store.update_derived(project_id, _apply, label="登记编辑用代理视频")


def run_proxy(handle: JobHandle, store: ProjectStore, req: ProxyRequest) -> dict[str, Any]:
    """代理生成主流程，运行在 `kvm.jobs.JobManager` 的工作线程里。"""
    from kvm.media.download import _ffprobe_bin, project_media_dir
    from kvm.media.ffmpeg import find_ffmpeg_with_libass

    started = time.monotonic()
    try:
        project = store.get(req.project_id)
    except KeyError as exc:
        raise RuntimeError(str(exc)) from exc

    if not project.video_path:
        msg = "工程还没有视频文件，无法生成编辑代理（只有音轨的工程不需要代理）"
        raise RuntimeError(msg)
    source = Path(project.video_path)
    if not source.is_file():
        msg = f"工程记录的视频文件不存在（可能已被移动/清理）：{source}"
        raise RuntimeError(msg)

    handle.report(0.02, "正在探测源视频…")
    # 复用项目统一的 ffmpeg 解析层，不散落 "ffmpeg" 字面量（CLAUDE.md §2.6）。
    # 代理本身用不到 libass，但全后端只有这一个解析入口，用同一个二进制也能保证
    # 预览与导出面对的是同一套解码器行为。
    ffmpeg_bin = find_ffmpeg_with_libass()
    ffprobe_bin = _ffprobe_bin(ffmpeg_bin)
    info = probe_source(ffprobe_bin, source)

    handle.check_cancelled()
    handle.report(0.05, "正在挑选可用的 H.264 编码器…")
    encoder = detect_h264_encoder(ffmpeg_bin)
    plan = plan_proxy(info, req.max_height, encoder)

    media_dir = project_media_dir(project.id)
    media_dir.mkdir(parents=True, exist_ok=True)
    dest = media_dir / PROXY_FILENAME

    handle.report(0.08, f"正在核对编辑代理缓存（{plan.reason}）…")
    key = cache_key(_sha256_file(source), plan)
    if not req.force:
        cached = _load_cache_entry(media_dir, key)
        if cached is not None:
            _write_back(store, project.id, cached)
            handle.report(1.0, "完成（缓存命中，未重新编码）")
            return {
                "project_id": project.id,
                "proxy_video_path": cached,
                "cached": True,
                "mode": plan.mode,
                "encoder": plan.encoder,
            }

    handle.check_cancelled()
    # 先写临时文件再原子替换：重生成期间旧代理一直可用，中途取消/失败也不会
    # 留下一个能被 `<video>` 打开却只有半截的 proxy.mp4。
    tmp = media_dir / f"proxy.{uuid.uuid4().hex[:8]}.part.mp4"
    handle.add_cleanup(lambda: tmp.unlink(missing_ok=True))

    total_s = info.duration_s or (project.duration_ms / 1000.0)
    handle.report(0.1, plan.reason)

    def _on_line(line: str) -> None:
        done_s = progress_seconds(line)
        if done_s is None or total_s <= 0:
            return
        # 映射到 [0.1, 0.95]，给探测与收尾留出可见的头尾
        handle.report(
            0.1 + 0.85 * max(0.0, min(1.0, done_s / total_s)),
            f"{'重封装' if plan.mode == 'remux' else '转码'}中 {done_s:.0f}s / {total_s:.0f}s",
        )

    run_cancelable(handle, build_proxy_command(ffmpeg_bin, source, tmp, plan), on_line=_on_line)

    handle.check_cancelled()
    handle.report(0.96, "正在校验编辑代理…")
    out_info = probe_source(ffprobe_bin, tmp)
    tmp.replace(dest)

    _save_cache_entry(media_dir, key, str(dest))
    _write_back(store, project.id, str(dest))

    elapsed = time.monotonic() - started
    handle.report(1.0, f"完成（{out_info.width}×{out_info.height}，耗时 {elapsed:.1f}s）")
    return {
        "project_id": project.id,
        "proxy_video_path": str(dest),
        "cached": False,
        "mode": plan.mode,
        "encoder": plan.encoder,
        "width": out_info.width,
        "height": out_info.height,
        "codec": out_info.codec_name,
        "size_bytes": dest.stat().st_size,
        "elapsed_s": round(elapsed, 2),
        "reason": plan.reason,
    }


def submit_proxy_job(
    store: ProjectStore, project_id: str, *, max_height: int = DEFAULT_MAX_HEIGHT, force: bool = False
) -> JobStatus:
    """把代理生成排进统一任务队列，并记住 job_id 供前端查询进度。

    下载完成、导入本地视频之后由后端自动调用（CLAUDE.md §2.5 要求自动环节要
    "顺手就有"），用户也能从素材面板手动触发同一条路径。
    """
    req = ProxyRequest(project_id=project_id, max_height=max_height, force=force)
    job = job_manager.submit(kind="media.proxy", run=lambda handle: run_proxy(handle, store, req))
    _LATEST_JOBS[project_id] = job.job_id
    return job


def latest_job(project_id: str) -> JobStatus | None:
    """该工程最近一次代理任务的状态；从未跑过或后端重启过则为 None。"""
    job_id = _LATEST_JOBS.get(project_id)
    if job_id is None:
        return None
    try:
        return job_manager.get(job_id)
    except KeyError:
        return None
