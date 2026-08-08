"""渲染路由：工程 → ASS 文本（预览）/ 烧录成片（导出）。

CLAUDE.md §4.1：唯一真源是工程文件，ASS 只是渲染目标，从工程文件序列化产生，
永远不被反向解析回来。本文件是这条规则在 HTTP 层的落地：三个接口全部只读
工程（`ProjectStore.get`），从不调用 `store.mutate`。

## `/ass` 为什么必须快，以及怎么做到

`POST /ass` 是前端预览（JASSUB）的数据源，用户每编辑一下（拖一个时间点、改一个
字号）就会重新调用一次。`AssBuilder` 内部要用 `LibassMetrics` 向 libass 实测上千个
前缀的 advance（CLAUDE.md §9 P0-2），单次测量本身不便宜。真正的优化点不是让单次
测量更快，而是**跨请求复用同一个 `LibassMetrics` 实例**——它按
`(字体, 字号, 粗体…) + 文本` 缓存结果，同一工程反复预览时，没变过的文本行直接命中
缓存，只有真正编辑过的行需要重新渲染。所以本模块用进程级单例（见 `_get_metrics`），
绝不在每次请求里 `LibassMetrics(...)` 现造一个。

## `jobs.py` 缺失时的占位

CLAUDE.md §5.13 定义的通用长任务编排（独立子进程 + JSON-lines 进度协议 + 可取消）
预期落在 `kvm.jobs`，但写这个文件时该模块尚不存在。`POST /export` 因此用一个
进程内的后台线程 + 字典状态表代替——**只是占位**，不支持真正取消、不能跨进程重启
存活。`kvm.jobs` 落地后应整体替换掉本文件里 `_jobs` / `_set_job` / `_run_export`
这一段，路由本身的形状（提交返回 `JobStatus`、轮询 `GET /export/{job_id}`）不必变。
"""

from __future__ import annotations

import threading
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import PlainTextResponse
from kvm.api.schemas import AssResponse, JobStatus, ProjectDTO, RenderRequest
from kvm.api.store import ProjectStore, default_root
from kvm.media.ffmpeg import find_ffmpeg_with_libass
from kvm.models.karaoke import (
    KaraokeProject,
    KaraokeStyle,
    Line,
    ReadingSource,
    RubySpan,
    TimingSource,
    Token,
    VoicePalette,
)
from kvm.pipeline.beat_detect import BeatGrid, detect_beats
from kvm.pipeline.guide_melody import build_guide_track
from kvm.pipeline.make_video import _extract_audio, _mix_audio, burn
from kvm.render.ass_builder import AssBuilder
from kvm.render.text_metrics import LibassMetrics
from pydantic import BaseModel

router = APIRouter(prefix="/api/render", tags=["render"])


# ---- 工程存取 ----


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _get_project(request: Request, project_id: str) -> ProjectDTO:
    """按 id 取工程；不存在则转换成 404（`store` 抛的是 KeyError）。"""
    try:
        return _store(request).get(project_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=exc.args[0]) from exc


# ---- ProjectDTO（API 层）→ KaraokeProject（领域层） ----


def _timing_source(value: str) -> TimingSource:
    """把 API 层的裸字符串转成领域层枚举。

    渲染只读 `start_ms`/`dur_ms`，不消费这个字段，因此未知取值不影响出片结果；
    保守归为 `manual` 只是为了不让无效字符串在别处（如未来的编辑器合并逻辑）
    引发歧义。
    """
    try:
        return TimingSource(value)
    except ValueError:
        return TimingSource.MANUAL


def _reading_source(value: str) -> ReadingSource:
    """同 `_timing_source`：ruby 的来源字段渲染同样不消费，仅为类型对齐。"""
    try:
        return ReadingSource(value)
    except ValueError:
        return ReadingSource.MANUAL


def project_dto_to_domain(dto: ProjectDTO) -> KaraokeProject:
    """API 层 `ProjectDTO` → 领域层 `KaraokeProject`。

    渲染只需要这一个方向——ASS 是终点产物，不回写工程（CLAUDE.md §4.1）。
    两套类型的字段基本一一对应（`StyleDTO`/`PaletteDTO` 与 `KaraokeStyle`/
    `VoicePalette` 字段名完全相同，可以直接 `**model_dump()` 展开），例外三处：

    - `LineDTO.id` 领域层不需要（渲染不关心编辑器用的稳定身份键）
    - `Token`/`RubySpan` 的 `source` 字段 API 层是裸字符串，领域层是枚举，需转换
    - `beat_grid` 不在 API 契约里，由调用方按需另行加载（见 `_load_beat_grid`）

    `TokenDTO.voice_part` **必须往下传**：一行内的声部交替全靠它，
    只传行级声部的话用户标好的对唱分色在成片里看不出任何效果。
    """
    lines = [
        Line(
            tokens=[
                Token(
                    text=tok.text,
                    start_ms=tok.start_ms,
                    dur_ms=tok.dur_ms,
                    timing_source=_timing_source(tok.timing_source),
                    locked_timing=tok.locked_timing,
                    voice_part=tok.voice_part,
                )
                for tok in ln.tokens
            ],
            ruby=[
                RubySpan(
                    start=r.start,
                    end=r.end,
                    text=r.text,
                    source=_reading_source(r.source),
                    locked=r.locked,
                )
                for r in ln.ruby
            ],
            voice_part=ln.voice_part,
            slot=ln.slot,
            is_metadata=ln.is_metadata,
            locked=ln.locked,
        )
        for ln in dto.lines
    ]
    return KaraokeProject(
        title=dto.title,
        artist=dto.artist,
        lines=lines,
        style=KaraokeStyle(**dto.style.model_dump()),
        palettes={name: VoicePalette(**pal.model_dump()) for name, pal in dto.palettes.items()},
        video_width=dto.video_width,
        video_height=dto.video_height,
        global_offset_ms=dto.global_offset_ms,
    )


# ---- 跨请求复用的单例：ffmpeg 路径 / LibassMetrics / 节拍网格缓存 ----

_singleton_lock = threading.RLock()
_ffmpeg_path: str | None = None
_metrics: LibassMetrics | None = None
_beat_cache: dict[tuple[str | None, str | None, str | None], BeatGrid | None] = {}


def _get_ffmpeg() -> str:
    """探测带 libass 的 ffmpeg，进程内只探测一次并缓存路径。

    判据是 `ass` 滤镜是否注册，而非版本号（Homebrew 主线 ffmpeg 不含 libass，
    见 CLAUDE.md §2.4 / §6.4），实现在 `kvm.media.ffmpeg`。
    """
    global _ffmpeg_path
    with _singleton_lock:
        if _ffmpeg_path is None:
            _ffmpeg_path = find_ffmpeg_with_libass()
        return _ffmpeg_path


def _get_metrics() -> LibassMetrics:
    """取跨请求复用的 `LibassMetrics` 单例（见模块文档字符串"`/ass` 为什么必须快"）。

    绝不能在每次请求里现造一个新实例——那样它内部的度量缓存永远是空的，
    起不到任何加速作用，编辑器每次预览都要重新渲染上千个前缀。
    """
    global _metrics
    with _singleton_lock:
        if _metrics is None:
            _metrics = LibassMetrics(_get_ffmpeg())
        return _metrics


def _load_beat_grid(dto: ProjectDTO) -> BeatGrid | None:
    """按工程关联的音频加载节拍网格，供开唱引导点踩拍（CLAUDE.md §8.5）。

    节拍检测要用 librosa 解码整条音轨再跑 beat tracking，不是免费操作，
    所以按音频来源缓存——道理与复用 `LibassMetrics` 相同，否则 `/ass` 每次
    编辑后都要重新分析一遍节拍。优先用鼓组 stem（节拍证据最强，人声分离阶段
    本来就会产出这条轨，是免费信号）；没有可用音频源或检测失败都返回 None，
    `AssBuilder` 会自动退化为固定间隔倒计时——不能因为节拍检测失败就不显示
    引导点（CLAUDE.md §2.5）。
    """
    audio_src = dto.audio_path or dto.video_path
    if not audio_src:
        return None
    key = (dto.audio_path, dto.drums_path, dto.video_path)
    with _singleton_lock:
        if key in _beat_cache:
            return _beat_cache[key]
    grid = detect_beats(
        Path(audio_src),
        drums_path=Path(dto.drums_path) if dto.drums_path else None,
    )
    with _singleton_lock:
        _beat_cache[key] = grid
    return grid


def _build_ass_text(dto: ProjectDTO) -> str:
    """DTO → ASS 文本。`POST /ass` 与 `GET /preview.ass` 共用同一条路径，
    保证两个接口所见完全一致。
    """
    project = project_dto_to_domain(dto)
    project.beat_grid = _load_beat_grid(dto)
    try:
        metrics = _get_metrics()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    return AssBuilder(project, metrics).build()


# ---- POST /ass、GET /preview.ass ----


class AssRequest(BaseModel):
    """生成 ASS 预览的请求体。

    只需要工程 id——引导声/伴奏开关只影响导出时选用的音轨，不影响字幕文本本身，
    因此不复用 `RenderRequest`，避免调用方误以为这些字段对预览有意义。
    """

    project_id: str


@router.post("/ass", response_model=AssResponse)
def generate_ass(body: AssRequest, request: Request) -> AssResponse:
    """由工程生成 ASS 文本，供前端预览（JASSUB）使用。

    这是编辑器的高频调用路径，每次编辑后都会触发；性能关键点全部落在
    `_get_metrics()` 复用的 `LibassMetrics` 单例上。
    """
    dto = _get_project(request, body.project_id)
    ass_text = _build_ass_text(dto)
    return AssResponse(ass=ass_text, event_count=ass_text.count("Dialogue:"))


@router.get("/preview.ass", response_class=PlainTextResponse)
def preview_ass(project_id: str, request: Request) -> PlainTextResponse:
    """与 `/ass` 等价，但以 `text/plain` 返回，便于前端直接把响应体喂给
    JASSUB 的 `subContent`（JASSUB 吃的是原始 ASS 文本，不是 JSON 包装）。
    """
    dto = _get_project(request, project_id)
    ass_text = _build_ass_text(dto)
    return PlainTextResponse(content=ass_text, media_type="text/plain; charset=utf-8")


# ---- POST /export、GET /export/{job_id} ----

_jobs: dict[str, JobStatus] = {}
_jobs_lock = threading.Lock()


def _set_job(job_id: str, **updates: object) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        _jobs[job_id] = job.model_copy(update=updates)


@router.post("/export", response_model=JobStatus, status_code=status.HTTP_202_ACCEPTED)
def export_video(body: RenderRequest, request: Request) -> JobStatus:
    """启动烧录任务，立即返回 `JobStatus`，实际烧录在后台线程执行。

    不能直接在这个请求处理函数里同步跑烧录：ffmpeg 烧一条 4K 全片要几分钟，
    同步阻塞会让后端在这几分钟里没法响应其他请求（CLAUDE.md §5.13：几十秒到
    几分钟的阻塞会让后端假死）。`kvm.jobs` 落地前，这里用后台线程做最小替代，
    见模块文档字符串。
    """
    dto = _get_project(request, body.project_id)

    if not dto.video_path:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="工程未关联视频文件，无法导出"
        )
    if body.use_instrumental and not dto.instrumental_path:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="工程未关联伴奏音轨（instrumental_path），无法生成 OFF VOCAL",
        )
    if body.with_guide and not dto.vocals_path:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="工程未关联人声轨（vocals_path），无法合成引导声",
        )

    job_id = uuid.uuid4().hex[:12]
    job = JobStatus(job_id=job_id, kind="render_export", state="pending", message="排队中")
    with _jobs_lock:
        _jobs[job_id] = job

    # 传给后台线程的是深拷贝快照：导出可能要跑几分钟，期间用户仍可能在编辑器里
    # 继续改动同一个工程（`store` 的 `get()` 返回的是内存里的活对象，不是副本）。
    snapshot = dto.model_copy(deep=True)
    thread = threading.Thread(target=_run_export, args=(job_id, snapshot, body), daemon=True)
    thread.start()
    return job


@router.get("/export/{job_id}", response_model=JobStatus)
def export_status(job_id: str) -> JobStatus:
    """轮询导出任务进度。

    `POST /export` 返回的 `JobStatus` 只是任务刚提交时的快照，前端要继续跟进
    必须有地方可查——`kvm.jobs` 落地前这个接口就是那个地方。
    """
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"任务不存在：{job_id}")
    return job


def _run_export(job_id: str, dto: ProjectDTO, req: RenderRequest) -> None:
    """后台线程实际执行的烧录流程，复用 `pipeline.make_video` 的烧录逻辑
    （`burn` / `_extract_audio` / `_mix_audio`），不重新实现一遍 ffmpeg 调用。

    任何一步失败都必须落到任务状态里而不是让线程静默死掉——自动环节的错误
    必须可见，这是"一站式"定位的硬要求（CLAUDE.md §2.5）。
    """
    try:
        if not dto.video_path:
            msg = "工程未关联视频文件，无法导出"
            raise RuntimeError(msg)
        video_path = Path(dto.video_path)

        _set_job(job_id, state="running", message="探测 ffmpeg…", progress=0.02)
        ffmpeg = _get_ffmpeg()

        _set_job(job_id, message="生成 ASS…", progress=0.1)
        ass_text = _build_ass_text(dto)

        out_dir = default_root().parent / "exports"
        out_dir.mkdir(parents=True, exist_ok=True)
        ass_path = out_dir / f"{dto.id}_{job_id}.ass"
        ass_path.write_text(ass_text, encoding="utf-8")

        audio_track: Path | None = None
        if req.use_instrumental:
            if not dto.instrumental_path:
                msg = "工程未关联伴奏音轨（instrumental_path），无法生成 OFF VOCAL"
                raise RuntimeError(msg)
            audio_track = Path(dto.instrumental_path)

        if req.with_guide:
            if not dto.vocals_path:
                msg = "工程未关联人声轨（vocals_path），无法合成引导声"
                raise RuntimeError(msg)
            vocals_path = Path(dto.vocals_path)

            _set_job(job_id, message="合成引导声…", progress=0.25)
            if audio_track is None:
                # 引导声要叠加在某条音轨上；未选伴奏时先从视频里抽出原始音轨作为底
                audio_track = _extract_audio(
                    ffmpeg, video_path, out_dir / f"{dto.id}_{job_id}_src_audio.wav"
                )
            duration_s = req.duration_s if req.duration_s is not None else dto.duration_ms / 1000.0
            guide_path = out_dir / f"{dto.id}_{job_id}_guide.wav"
            build_guide_track(vocals_path, guide_path, duration_s)
            mixed_path = out_dir / f"{dto.id}_{job_id}_audio_mixed.wav"
            audio_track = _mix_audio(ffmpeg, audio_track, guide_path, mixed_path)

        _set_job(job_id, message="烧录中（4K 全片约需数分钟）…", progress=0.35)
        out_path = out_dir / f"{dto.id}_{job_id}.mp4"
        burn(
            ffmpeg,
            video_path,
            ass_path,
            out_path,
            audio=audio_track,
            start_s=req.start_s,
            duration_s=req.duration_s,
        )

        _set_job(
            job_id,
            state="done",
            progress=1.0,
            message="完成",
            result={"output_path": str(out_path)},
        )
    except Exception as exc:  # 后台线程顶层兜底，见函数文档字符串
        _set_job(job_id, state="failed", error=str(exc), message="导出失败")
