"""视频下载（yt-dlp）：YouTube / bilibili。

复用 `kvm.media.providers` 的 provider 抽象与选流策略（音频优先于画质、
跨编码等效码率比较、bilibili 分P 拦截等，实测证据见
`experiments/download_provider.py`），本文件只做**编排**：

    解析链接 → 探测 → 选流 → 下载 → 核算时间基准 → 抽音频 → 写回工程

## 与 CLAUDE.md 硬性要求的对应关系

- **音频优先于画质**（§1/§5.1）：选流固定用 `StreamSelector`，音频永不设码率
  上限；`DownloadRequest.prefer_audio_quality` 只控制**视频**分辨率是否封顶
  1080p——这个字段的语义按 §5.1"音频没有上限参数，这个口子不给"来解释：它
  从不影响音频选择，只在用户明确想要更高画质背景时放开视频的分辨率上限。
- **必须锁定 format_id**（§11）：`ProjectDTO` 未预留字段存放它（不允许改
  schemas.py），因此写进工程媒体目录下的边车文件 `media_meta.json`。
- **ffmpeg 抽音频会静默吃掉容器起始偏移**（§6.2）：显式探测 `start_time`，
  并与抽取后的音频时长做启发式核对，据此预设 `global_offset_ms`（并把判断
  依据写进 notes，不静默生效——对应 §2.5"自动环节的错误必须可见"）。
- **分P 陷阱**（新增需求）：bilibili 裸 BV 号在多P 稿件上会被 yt-dlp 展开成
  播放列表，`BilibiliProvider.probe()` 已经拦截并抛错，这里把它转成"请在链接
  末尾加 `?p=N` 重试"的可操作提示，而不是替用户擅自选一集。

## 关于工程的创建

`DownloadRequest` 现在带 `project_id`：下载结果写入调用方指定的既有工程，
不再"下载即新建工程"——那样会让"先导入本地音频、再补下载视频"这类组合无法
表达（工作流上用户通常先建工程再往里放素材）。前端 `client.ts` 的
`download(projectId, url)` 已按 `{project_id, url}` 调用，本文件与之对齐。

## 手工旁路：本地文件导入

`import_local_media()` 是 CLAUDE.md §2.5 视频获取一行的手工旁路——与本文件的
自动下载并列可用，供 `kvm.api.routes.media` 的 `POST /api/media/import` 调用。
`video`/`audio` 两种含参考音轨的导入会复用下面这套容器 `start_time` 核算逻辑
（§6.2 点名的坑：ffmpeg 默认抽音频会静默吃掉容器起始偏移）；
`instrumental`/`vocals`/`drums` 是已分离好的单声部产物，直接落盘。
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import IO, Any

from kvm.api.schemas import DownloadRequest, ProjectDTO
from kvm.api.store import ProjectStore, default_root
from kvm.jobs import JobCancelled, JobHandle, run_cancelable
from kvm.media.ffmpeg import find_ffmpeg_with_libass
from kvm.media.providers import (
    SelectionPolicy,
    StreamSelector,
    TargetKind,
    YtDlpManager,
    build_registry,
)

# 借用 `kvm.media.providers` 的 `VideoProvider._with_retry()` 里对 "已失效"
# 关键字的 fatal 判定（见 `FATAL_ERROR_KEYWORDS`），让取消请求立刻终止重试
# 循环，而不是被当成瞬时网络错误重试数次、拖上几十秒才真正停下。
_CANCEL_SENTINEL = "已失效：用户已取消下载"


def app_data_root() -> Path:
    """应用数据根目录，与 `kvm.api.store` 的工程 JSON 共用同一个父目录
    （`~/.karaoke-video-maker/`），媒体文件另放一个子目录，不与工程 JSON 混放。
    """
    return default_root().parent


def project_media_dir(project_id: str) -> Path:
    """一个工程的媒体文件目录：下载产物、分离产物都放这里。"""
    return app_data_root() / "media" / project_id


def _ffprobe_bin(ffmpeg_bin: str) -> str:
    candidate = Path(ffmpeg_bin).with_name("ffprobe")
    return str(candidate) if candidate.is_file() else "ffprobe"


def _ffprobe_json(ffprobe_bin: str, path: Path) -> dict[str, Any]:
    proc = subprocess.run(
        [ffprobe_bin, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    return json.loads(proc.stdout or "{}")


def _probe_container_timing(ffprobe_bin: str, path: Path) -> dict[str, Any]:
    meta = _ffprobe_json(ffprobe_bin, path)
    fmt = meta.get("format", {})
    streams = meta.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    return {
        "container_start_time_s": float(fmt["start_time"]) if fmt.get("start_time") is not None else 0.0,
        "video_stream_start_time_s": (
            float(video["start_time"]) if video.get("start_time") is not None else None
        ),
        "audio_stream_start_time_s": (
            float(audio["start_time"]) if audio.get("start_time") is not None else None
        ),
        "audio_codec": audio.get("codec_name"),
        "audio_sample_rate_hz": int(audio["sample_rate"]) if audio.get("sample_rate") else None,
        "audio_channels": audio.get("channels"),
        # 本地导入（`import_local_media`）要回写工程的分辨率，下载路径目前不用这两项。
        "video_width": int(video["width"]) if video.get("width") else None,
        "video_height": int(video["height"]) if video.get("height") else None,
    }


def _probe_duration(ffprobe_bin: str, path: Path) -> float:
    return float(_ffprobe_json(ffprobe_bin, path)["format"]["duration"])


def _download_fraction(d: dict[str, Any]) -> float | None:
    downloaded = d.get("downloaded_bytes")
    total = d.get("total_bytes") or d.get("total_bytes_estimate")
    if downloaded is None or not total:
        return None
    return max(0.0, min(1.0, downloaded / total))


def _rmtree_ignore_errors(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _reconcile_start_offset(
    *, container_start_s: float, container_duration_s: float, extracted_audio_duration_s: float
) -> tuple[str, int]:
    """核算 ffmpeg 抽音频是否"吃掉"了容器起始偏移（CLAUDE.md §6.2 点名的未验证坑）。

    做法与 `experiments/download_mv.py` 的诊断一致：比较抽出的音频时长更接近
    "整体时长"还是"整体时长 − start_time"，从而判断 ffmpeg 默认行为有没有把
    起始偏移吃掉。**这是启发式判断，不是精确证明**——按 §2.5 的原则，判断
    结果与建议的补偿量都写进备注让用户/后续阶段能看见、能复核，不静默生效。
    """
    if container_start_s <= 0.005 or container_duration_s <= 0:
        return "容器 start_time ≈ 0，未观测到起始 PTS 偏移问题。", 0

    if extracted_audio_duration_s <= 0:
        return "抽音频时长探测失败，无法核算起始偏移，请人工核查。", 0

    expected_if_eaten = container_duration_s - container_start_s
    expected_if_kept = container_duration_s
    diff_eaten = abs(extracted_audio_duration_s - expected_if_eaten)
    diff_kept = abs(extracted_audio_duration_s - expected_if_kept)

    if diff_eaten <= diff_kept:
        offset_ms = round(container_start_s * 1000)
        note = (
            f"容器 start_time={container_start_s:.3f}s 非零，且抽出音频时长"
            f"（{extracted_audio_duration_s:.3f}s）更接近『整体时长-start_time』，"
            "判断 ffmpeg 抽音频时默认吃掉了起始偏移。已将 global_offset_ms 预设为 "
            f"{offset_ms}ms 作为起点——这是启发式估计，请在编辑器里核对首句是否对轴。"
        )
        return note, offset_ms

    note = (
        f"容器 start_time={container_start_s:.3f}s 非零，但抽出音频时长"
        f"（{extracted_audio_duration_s:.3f}s）更接近整体时长，判断起始偏移未被"
        "吃掉；未自动调整 global_offset_ms，但后续基于音频的时间轴分析可能与"
        f"视频轨错开约 {container_start_s * 1000:.0f}ms，建议人工核查。"
    )
    return note, 0


def run_download(handle: JobHandle, store: ProjectStore, req: DownloadRequest) -> dict[str, Any]:
    """下载编排主流程，运行在 `kvm.jobs.JobManager` 的工作线程里。"""
    try:
        project = store.get(req.project_id)
    except KeyError as exc:
        # 路由层的 `_project_or_404` 已经提前校验过一次；这里是防御性复查
        # （例如工程在任务排队期间被删除），失败时把它变成任务失败而不是崩线程。
        raise RuntimeError(str(exc)) from exc

    manager = YtDlpManager()
    status = manager.locate()
    try:
        # `status.available` 在只找到系统 PATH 里的 yt-dlp **命令行**、但没有
        # 可 `import` 的 yt_dlp **库**时也会是 True（见 YtDlpManager.locate()）。
        # 真正会被用到的是 `.module`（下载走的是
        # `import yt_dlp`，不是子进程调用命令行），这里显式把它当作权威判据。
        manager.module  # noqa: B018 —— 有意的探测性访问，触发其内部校验
    except RuntimeError as exc:
        msg = (
            f"yt-dlp 不可用：{status.message}。"
            "请运行 `uv sync --extra download`（或 `uv add yt-dlp`）后重试。"
        )
        raise RuntimeError(msg) from exc

    ffmpeg_bin = find_ffmpeg_with_libass()
    ffprobe_bin = _ffprobe_bin(ffmpeg_bin)

    registry = build_registry(manager)
    provider = registry.for_url(req.url)
    if provider is None:
        msg = f"无法识别的链接（目前支持 YouTube 与 bilibili）：{req.url}"
        raise RuntimeError(msg)

    target = provider.resolve(req.url)
    if target.kind is TargetKind.UNSUPPORTED:
        msg = f"无法解析该链接：{target.hint or '未知原因'}"
        raise RuntimeError(msg)
    if target.kind is TargetKind.COLLECTION:
        msg = f"该链接是一个播放列表/合集，请打开具体某一集后再粘贴单集链接。{target.hint}"
        raise RuntimeError(msg)

    handle.check_cancelled()
    handle.report(0.05, "正在探测视频信息…")

    try:
        probe = provider.probe(target)
    except RuntimeError as exc:
        # bilibili 裸 BV 号在多P 稿件上会被 yt-dlp 展开成播放列表，
        # BilibiliProvider.probe() 已拦截并抛错，这里转成可操作的提示，
        # 而不是替用户擅自选一集下载。
        entries: list[dict[str, Any]] = []
        try:
            entries = provider.list_entries(target, limit=50)
        except Exception:  # noqa: BLE001 —— 列分P 本身失败不应掩盖原始错误
            entries = []
        if entries:
            listing = "；".join(f"{e['id']}: {(e['title'] or '')[:24]}" for e in entries[:10])
            msg = (
                f"{exc}\n这是多P 稿件，请在链接末尾加上 `?p=N` 选择具体一集后重试。"
                f"可选分P（前 {len(entries[:10])} 个）：{listing}"
            )
        else:
            msg = str(exc)
        raise RuntimeError(msg) from exc

    handle.check_cancelled()

    # 音频优先于画质：视频按 prefer_audio_quality 决定是否封顶 1080p，
    # 音频始终不设上限（StreamSelector 的固定策略，见 kvm.media.providers）。
    policy = SelectionPolicy(max_video_height=1080 if req.prefer_audio_quality else None)
    selector = StreamSelector(policy)
    selection = selector.select(probe)
    if selection.audio is None:
        msg = "未找到可用的音频流，无法继续（分离与对齐都依赖音频）"
        raise RuntimeError(msg)

    handle.report(
        0.1,
        f"已选定 {provider.site} 音频流 {selection.audio.stream_id}"
        f"（{selection.audio.codec_raw} {selection.audio.kbps or 0:.0f}kbps），开始下载…",
    )

    media_dir = project_media_dir(project.id)
    media_dir.mkdir(parents=True, exist_ok=True)

    # `media_dir` 现在属于一个既有工程，可能已经装着之前下载/导入/分离的产物
    # ——不能再像"下载即新建工程"时那样把整个目录删掉、把工程一起删掉，那样会
    # 连带销毁与本次下载无关的素材。失败时只清理本次下载新产生的文件。
    created_paths: list[Path] = []

    def _cleanup_on_failure() -> None:
        for p in created_paths:
            p.unlink(missing_ok=True)

    handle.add_cleanup(_cleanup_on_failure)

    def _hook(d: dict[str, Any]) -> None:
        if handle.is_cancelled():
            raise RuntimeError(_CANCEL_SENTINEL)
        if d.get("status") == "downloading":
            frac = _download_fraction(d)
            if frac is not None:
                handle.report(0.1 + 0.6 * frac, f"下载中 {d.get('_percent_str', '').strip()}")

    try:
        result = provider.download(target, selection, media_dir, progress_hook=_hook)
    except Exception as exc:  # noqa: BLE001 —— download() 正常应返回 ok=False，这里兜底极端情况
        if handle.is_cancelled():
            raise JobCancelled(handle.job_id) from exc
        msg = f"下载失败：{exc}"
        raise RuntimeError(msg) from exc

    if not result.ok or result.path is None:
        if handle.is_cancelled():
            raise JobCancelled(handle.job_id)
        msg = f"下载失败：{result.error or '未知错误（yt-dlp 未报告具体原因）'}"
        raise RuntimeError(msg)

    created_paths.append(result.path)

    handle.check_cancelled()
    handle.report(0.75, "下载完成，正在核算时间基准并抽取音频…")

    audio_path = media_dir / "audio_44k.wav"
    created_paths.append(audio_path)
    try:
        timing = _probe_container_timing(ffprobe_bin, result.path)
        run_cancelable(
            handle,
            [
                ffmpeg_bin, "-y", "-i", str(result.path),
                "-vn", "-acodec", "pcm_s16le", "-ac", "2", str(audio_path),
            ],
        )
        handle.check_cancelled()
        audio_duration_s = _probe_duration(ffprobe_bin, audio_path)
    except JobCancelled:
        raise
    except (subprocess.CalledProcessError, OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
        msg = f"抽取音频或核算时间基准失败：{exc}"
        raise RuntimeError(msg) from exc

    offset_note, global_offset_ms = _reconcile_start_offset(
        container_start_s=timing.get("container_start_time_s") or 0.0,
        container_duration_s=probe.duration_s or result.duration_s or 0.0,
        extracted_audio_duration_s=audio_duration_s,
    )

    handle.report(0.95, "写入工程…")

    # 提前取成局部变量：`selection.audio` 的 None 性在函数顶部已经判过一次，
    # 但闭包捕获外层变量时 pyright 不会带着那次窄化，直接在闭包里访问
    # `selection.audio.stream_id` 会被当成 Optional 成员访问报错。
    audio_format_id = selection.audio.stream_id

    def _mutate(p: ProjectDTO) -> None:
        p.video_path = str(result.path)
        p.audio_path = str(audio_path)
        # 落进工程本身而非只落边车 media_meta.json——同一视频 opus(251)/aac(140)
        # 两条音频流实测原点相差 36.7ms（ProjectDTO.audio_format_id 文档字符串），
        # 只有随工程走（含 undo/redo）才能让下游"换流必须重跑重锚定"的判断成立。
        p.audio_format_id = audio_format_id
        if not p.title:
            p.title = result.title
        if not p.artist and result.uploader:
            p.artist = result.uploader
        p.duration_ms = round((audio_duration_s or probe.duration_s or result.duration_s or 0.0) * 1000)
        if global_offset_ms:
            p.global_offset_ms = global_offset_ms

    updated_project = store.mutate(project.id, _mutate, label="下载媒体")

    meta = {
        "source_url": target.canonical_url,
        "site": provider.site,
        "selected_video_format_id": selection.video.stream_id if selection.video else None,
        "selected_audio_format_id": selection.audio.stream_id,
        "audio_codec": selection.audio.codec_raw,
        "audio_declared_kbps": selection.audio.kbps,
        "audio_sample_rate_hz": selection.audio.sample_rate_hz,
        "container_timing": timing,
        "extracted_audio_duration_s": audio_duration_s,
        "offset_note": offset_note,
        "selection_rationale": selection.rationale,
    }
    (media_dir / "media_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 下载回来的最佳画质通常是 AV1 + Matroska + Opus，Safari 三重放不了，
    # 4K 长 GOP 在编辑器里 seek 也慢。紧接着排一个编辑用代理任务（异步，几毫秒
    # 返回），用户这就能一边等代理一边继续别的操作。**排队失败不算下载失败**：
    # 没有代理时预览会回退用原视频，不该让整次下载显示成红色。
    proxy_job_id: str | None = None
    proxy_note = ""
    try:
        from kvm.media.proxy import submit_proxy_job

        proxy_job_id = submit_proxy_job(store, project.id).job_id
        proxy_note = "已自动开始生成编辑用代理视频（Safari 需要它才能出画面）。"
    except Exception as exc:  # noqa: BLE001 —— 代理是可选增强，任何失败都只降级不阻断
        proxy_note = f"编辑用代理未能自动排队（{exc}），可在素材面板手动生成。"

    handle.report(1.0, "完成")
    return {
        "project_id": updated_project.id,
        "title": updated_project.title,
        "video_path": str(result.path),
        "audio_path": str(audio_path),
        "duration_ms": updated_project.duration_ms,
        "audio_format_id": selection.audio.stream_id,
        "video_format_id": selection.video.stream_id if selection.video else None,
        "proxy_job_id": proxy_job_id,
        "notes": [*selection.rationale, offset_note, proxy_note],
    }


# ============================================================================
# 手工旁路：本地文件导入（CLAUDE.md §2.5，见本文件头部说明）
# ============================================================================

_IMPORT_COPY_CHUNK = 1024 * 1024  # 流式拷贝/哈希的块大小，避免大文件整份进内存


def _stream_upload_to_file(src: IO[bytes], dest: Path) -> None:
    """把上传文件流式写盘。不用 `dest.write_bytes(src.read())`——4K MV 动辄数 GB，
    整份读进内存既慢又可能把后端进程 OOM 掉。
    """
    with dest.open("wb") as out:
        shutil.copyfileobj(src, out, length=_IMPORT_COPY_CHUNK)


def _sha256_prefix(path: Path, length: int = 16) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(_IMPORT_COPY_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()[:length]


def import_local_media(
    store: ProjectStore,
    project_id: str,
    kind: str,
    field: str,
    filename: str,
    fileobj: IO[bytes],
) -> ProjectDTO:
    """导入本地媒体文件并写回 `field` 指定的工程字段，返回更新后的完整工程。

    `kind` 为 `video`/`audio` 时，导入的是"参考音轨"的来源：会探测分辨率
    （仅 video）、时长、容器 `start_time`，并复用 `run_download` 同一套
    `_reconcile_start_offset` 核算逻辑——**必须显式处理**，因为实测 ffmpeg
    默认抽音频会静默吃掉容器起始偏移（CLAUDE.md §6.2），不处理会让抽出的
    wav 整轨短一截、字幕相对音频整体错位。`instrumental`/`vocals`/`drums`
    是已经分离好的单声部产物，直接落盘，不涉及这层时间基准问题。

    与下载路径共用同一个 `project_media_dir`，但文件名一律带 `import_` 前缀
    + 随机后缀，不会和下载路径固定使用的 `audio_44k.wav` 撞名。
    """
    try:
        store.get(project_id)
    except KeyError as exc:
        raise RuntimeError(str(exc)) from exc

    media_dir = project_media_dir(project_id)
    media_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(filename).suffix or ".bin"
    tag = uuid.uuid4().hex[:8]
    # `_raw_` 中缀是有意的：kind="audio" 时上传文件本来就可能已经是 .wav，
    # 若原始落盘文件名与下面的规范化输出 `import_audio_{tag}.wav` 撞了名，
    # ffmpeg 会因为"输入输出是同一个文件"直接报错拒绝原地改写。
    raw_path = media_dir / f"import_{kind}_raw_{tag}{suffix}"
    _stream_upload_to_file(fileobj, raw_path)

    ffmpeg_bin = find_ffmpeg_with_libass()
    ffprobe_bin = _ffprobe_bin(ffmpeg_bin)

    updates: dict[str, Any] = {field: str(raw_path)}

    if kind in ("video", "audio"):
        try:
            timing = _probe_container_timing(ffprobe_bin, raw_path)
            container_duration_s = _probe_duration(ffprobe_bin, raw_path)
        except (subprocess.CalledProcessError, OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
            raw_path.unlink(missing_ok=True)
            msg = f"探测导入文件信息失败（可能不是有效的媒体文件）：{exc}"
            raise RuntimeError(msg) from exc

        # 统一抽成规范 wav——哪怕上传的已经是 wav 也照走一遍，理由与
        # `run_download` 相同：容器 start_time 只有在这一步才会被 ffmpeg
        # 静默吃掉，必须紧接着用 `_reconcile_start_offset` 核算，不能省略。
        canonical_audio = media_dir / f"import_audio_{tag}.wav"
        proc = subprocess.run(
            [
                ffmpeg_bin, "-y", "-i", str(raw_path),
                "-vn", "-acodec", "pcm_s16le", "-ac", "2", str(canonical_audio),
            ],
            capture_output=True, text=True, timeout=1800,
        )
        if proc.returncode != 0:
            raw_path.unlink(missing_ok=True)
            msg = f"抽取/规范化音频失败：{proc.stderr[-2000:]}"
            raise RuntimeError(msg)
        try:
            audio_duration_s = _probe_duration(ffprobe_bin, canonical_audio)
        except (subprocess.CalledProcessError, OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
            raw_path.unlink(missing_ok=True)
            canonical_audio.unlink(missing_ok=True)
            msg = f"核算导入音频时长失败：{exc}"
            raise RuntimeError(msg) from exc

        offset_note, global_offset_ms = _reconcile_start_offset(
            container_start_s=timing.get("container_start_time_s") or 0.0,
            container_duration_s=container_duration_s,
            extracted_audio_duration_s=audio_duration_s,
        )

        updates["audio_path"] = str(canonical_audio)
        updates["duration_ms"] = round(audio_duration_s * 1000)
        # 见 ProjectDTO.audio_format_id 文档字符串：opus/aac 两条流原点能差
        # 36.7ms，换流必须重跑重锚定。本地导入没有"流选择"，用内容哈希做
        # 身份键——同一份文件重复导入哈希不变，不会触发不必要的重锚定提示；
        # 换成别的文件哈希必然不同，正确地表示"这是一条新的音频流"。
        updates["audio_format_id"] = f"local:{_sha256_prefix(canonical_audio)}"
        if global_offset_ms:
            updates["global_offset_ms"] = global_offset_ms

        if kind == "video":
            width = timing.get("video_width")
            height = timing.get("video_height")
            if width:
                updates["video_width"] = width
            if height:
                updates["video_height"] = height

        # ProjectDTO 没有通用的"诊断备注"字段（不在本任务授权改动 schemas.py
        # 的范围内），offset_note 按本文件已有的 media_meta.json 惯例落一份
        # 边车文件，保证"自动环节的错误必须可见"（CLAUDE.md §2.5）不会因为
        # 契约里没地方放就被悄悄丢掉。
        (media_dir / f"import_{kind}_{tag}.meta.json").write_text(
            json.dumps(
                {
                    "kind": kind,
                    "source_filename": filename,
                    "container_timing": timing,
                    "extracted_audio_duration_s": audio_duration_s,
                    "offset_note": offset_note,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    else:
        # instrumental / vocals / drums：已分离好的单声部产物，只做最基础的
        # 有效性探测（ffprobe 读不出时长基本就是文件损坏/选错了文件），
        # 不涉及 start_time 核算或额外转码。
        try:
            _probe_duration(ffprobe_bin, raw_path)
        except (subprocess.CalledProcessError, OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
            raw_path.unlink(missing_ok=True)
            msg = f"导入文件不是有效的音频文件（ffprobe 无法读取）：{exc}"
            raise RuntimeError(msg) from exc

    def _mutate(p: ProjectDTO) -> None:
        for f, v in updates.items():
            setattr(p, f, v)

    return store.mutate(project_id, _mutate, label=f"导入本地{kind}")
