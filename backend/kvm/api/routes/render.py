"""渲染路由：工程 → ASS 文本（预览）/ 烧录成片（导出）。

CLAUDE.md §4.1：唯一真源是工程文件，ASS 只是渲染目标，从工程文件序列化产生，
永远不被反向解析回来。本文件是这条规则在 HTTP 层的落地：渲染路径只读工程
（`ProjectStore.get`），**从不调用 `store.mutate`** ——本模块唯一的写入是把
导出成片登记进 `ProjectDTO.exports`，走的是不进撤销栈的 `store.update_derived`
（CLAUDE.md §8「后台产物不进撤销栈」）。

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

import contextlib
import json
import mimetypes
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import FileResponse, PlainTextResponse
from kvm.api.routes.fonts import chain_font_bytes
from kvm.api.schemas import (
    AssResponse,
    ExportArtifactDTO,
    JobStatus,
    ProjectDTO,
    RenderRequest,
)
from kvm.api.store import ProjectStore, default_root
from kvm.media.download import _ffprobe_bin, _probe_duration
from kvm.media.ffmpeg import find_ffmpeg_with_libass
from kvm.models.karaoke import (
    ExportArtifact,
    KaraokeProject,
    KaraokeStyle,
    Line,
    ReadingSource,
    RubySpan,
    TimingSource,
    Token,
    VoicePalette,
)
from kvm.media import guide as guide_module
from kvm.pipeline.beat_detect import BeatGrid, detect_beats
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
    `VoicePalette` 字段名完全相同，可以直接 `**model_dump()` 展开），例外四处：

    - `LineDTO.id` 领域层不需要（渲染不关心编辑器用的稳定身份键）
    - `Token`/`RubySpan` 的 `source` 字段 API 层是裸字符串，领域层是枚举，需转换
    - `beat_grid` 不在 API 契约里，由调用方按需另行加载（见 `_load_beat_grid`）
    - `ExportArtifactDTO.variant_label` 是计算字段，转换时要排除掉

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
        # `variant_label` 是 DTO 侧的计算字段，领域层照三个布尔位自己派生，
        # 直接 `**model_dump()` 会把它当成构造参数传进去而报错。
        exports=[
            ExportArtifact(**item.model_dump(exclude={"variant_label"})) for item in dto.exports
        ],
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


def _build_ass_text(dto: ProjectDTO, *, embed_fonts: bool = False) -> str:
    """DTO → ASS 文本。`POST /ass` 与 `GET /preview.ass` 共用同一条路径，
    保证两个接口所见完全一致。

    `embed_fonts` **只在导出时开**：它把整条字体链的字节 UUEncode 进 `[Fonts]` 段，
    一份子集字体编码后约 6.8 MB，预览每编辑一下就要重传一次，塞不起。
    预览侧改由 ASS 头部的一行声明告诉前端该去取哪几个字体
    （`render.ass_builder.PREVIEW_FONTS_TAG`），取到的是同一批产物字节。

    导出侧非嵌不可：ffmpeg 用 `ASS_FONTPROVIDER_AUTODETECT`，系统字体回退
    **无法禁用**，不把字节摆在它面前就控制不住缺字时它选谁——
    同一个生僻字预览用链尾、成片用系统某个字体，正是 §5.12 要杜绝的分叉。
    """
    project = project_dto_to_domain(dto)
    project.beat_grid = _load_beat_grid(dto)
    try:
        metrics = _get_metrics()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    builder = AssBuilder(project, metrics)
    if not embed_fonts:
        return builder.build()
    embedded = chain_font_bytes(project.style.font_names, builder.rendered_charset())
    return AssBuilder(project, metrics, embedded_fonts=embedded).build()


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
def preview_ass(
    project_id: str, request: Request, embed_fonts: bool = False
) -> PlainTextResponse:
    """与 `/ass` 等价，但以 `text/plain` 返回，便于前端直接把响应体喂给
    JASSUB 的 `subContent`（JASSUB 吃的是原始 ASS 文本，不是 JSON 包装）。

    `embed_fonts=true` 返回**导出时那一份**（带 `[Fonts]` 内嵌字体，几 MB 起步）。
    界面不该用它——预览每编辑一下都要重取一次，塞不起。留这个开关是为了让
    "两端用的是不是同一批字体"这件事**可验证**：验证脚本拿它渲一帧，
    与浏览器预览逐字比对（`frontend/scripts/verify-font-chain.mjs`）。
    没有这个开关，导出侧的 ASS 只存在于烧录作业内部，验证只能靠跑完整出片。
    """
    dto = _get_project(request, project_id)
    ass_text = _build_ass_text(dto, embed_fonts=embed_fonts)
    return PlainTextResponse(content=ass_text, media_type="text/plain; charset=utf-8")


# ---- 导出产物登记 ----


def record_export(store: ProjectStore, project_id: str, artifact: ExportArtifactDTO) -> None:
    """把一件成片登记进工程——**走 `update_derived`，不占撤销格**。

    成片是后台作业的产物，不是用户的一次编辑意图（CLAUDE.md §8「后台产物不进
    撤销栈」）。烧录一条 4K 全片要跑几分钟，期间用户还在改轴；若这条登记压进
    撤销栈，用户按 Cmd+Z 想撤掉自己刚才那次改动，撤掉的会是"已导出"这件事。

    `update_derived` 就地只往 `exports` 追加一条，不整体替换工程状态，
    所以并发进行的编辑不会被这次写回卷掉。
    """

    def _apply(project: ProjectDTO) -> None:
        # 同一路径只保留一条：重复导出到同一个文件时该更新那条记录，
        # 而不是列出两条指向同一份成片、只有一条说得对的记录。
        project.exports = [item for item in project.exports if item.path != artifact.path]
        project.exports.append(artifact)

    store.update_derived(project_id, _apply, label="登记导出产物")


def list_exports(store: ProjectStore, project_id: str) -> list[ExportArtifactDTO]:
    """列出**仍然存在于磁盘上**的导出产物，最新的在前；顺带剔除已消失的记录。

    用户随时会把成片挪到别处或直接删掉。留着一条指向不存在文件的记录，点开只会
    报错——判据与 `ProxyStatus.ready` 一致：以文件实际存在为准，不以字段有没有值
    为准。剔除本身也走不入历史的写入路径，它是派生登记的维护，不该占用户一格撤销。
    """
    project = store.get(project_id)
    alive = [item for item in project.exports if Path(item.path).is_file()]
    if len(alive) != len(project.exports):
        alive_paths = {item.path for item in alive}

        def _prune(draft: ProjectDTO) -> None:
            draft.exports = [item for item in draft.exports if item.path in alive_paths]

        store.update_derived(project_id, _prune, label="清理已消失的导出产物")
    return list(reversed(alive))


# ---- POST /export、GET /export/{job_id}、GET /exports/{project_id} ----

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
            detail="工程未关联伴奏音轨，无法生成 OFF VOCAL",
        )
    if body.with_guide and not dto.vocals_path:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="工程未关联人声轨，无法合成引导声",
        )

    job_id = uuid.uuid4().hex[:12]
    job = JobStatus(job_id=job_id, kind="render_export", state="pending", message="排队中")
    with _jobs_lock:
        _jobs[job_id] = job

    # 传给后台线程的是深拷贝快照：导出可能要跑几分钟，期间用户仍可能在编辑器里
    # 继续改动同一个工程（`store` 的 `get()` 返回的是内存里的活对象，不是副本）。
    # `store` 本身仍要传下去：烧完要往工程里登记产物，而那次写回必须落在**当前**
    # 工程状态上，绝不能拿这份几分钟前的快照整体覆盖回去。
    snapshot = dto.model_copy(deep=True)
    thread = threading.Thread(
        target=_run_export, args=(job_id, _store(request), snapshot, body), daemon=True
    )
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


@router.get("/exports/{project_id}", response_model=list[ExportArtifactDTO])
def export_artifacts(project_id: str, request: Request) -> list[ExportArtifactDTO]:
    """列出该工程已导出、且文件仍在磁盘上的成片，最新的在前。

    单独开一个接口而不是让前端读 `ProjectDTO.exports`，理由与
    `GET /api/media/proxy/{project_id}` 完全相同：判断产物**现在能不能用**需要
    一次文件系统核对，而 `GET /api/projects/{id}` 是编辑器每次打开工程都要调的
    热路径，不该顺带去 stat 一串成片；反过来，工程 DTO 里若留着一条指向已删除
    文件的记录，前端照单渲染就会给用户一个点开必然报错的入口。
    """
    try:
        return list_exports(_store(request), project_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=exc.args[0]) from exc


def _download_filename(project: ProjectDTO, artifact: ExportArtifactDTO, path: Path) -> str:
    """给浏览器的落盘文件名。

    磁盘上的名字是 `{工程id}_{任务id}.mp4`，对人毫无意义——用户下完一堆成片，
    单看文件名分不出哪份是 OFF VOCAL、哪份带引导声。这里改用「曲名 歌手 变体名」，
    正是产物列表里用来区分它们的那三样东西。
    """
    parts = [project.title.strip(), project.artist.strip(), artifact.variant_label]
    name = " ".join(p for p in parts if p) or path.stem
    # 路径分隔符与控制字符必须去掉：它们会让下载端把文件写到别处，或写不出来
    cleaned = "".join(" " if ch in '/\\:*?"<>|' or ord(ch) < 32 else ch for ch in name)
    return f"{cleaned.strip() or path.stem}{path.suffix}"


@router.get("/exports/{project_id}/{artifact_id}/download")
def download_export(project_id: str, artifact_id: str, request: Request) -> FileResponse:
    """下载一条已登记的成片。

    ## 为什么按 artifact_id 查而不是收一个路径

    调用方**只能报 id**，真实路径由服务端从该工程自己的 `exports` 里查出来。
    收路径参数等于把「读服务器上任意文件」开成公开接口，而这个接口本身没有
    任何鉴权可言（桌面应用的后端就跑在 127.0.0.1 上）。id 来自导出任务的
    job_id，前端本来就是从 `GET /exports/{project_id}` 拿到的，没有额外成本。

    ## Range 与落盘

    成片实测 527 MB，必须支持断点续传与拖动——`FileResponse` 自带 Range 处理，
    不要改成一次性读进内存再返回。`Content-Disposition: attachment` 让浏览器
    落成文件而不是在标签页里播起来；`filename*` 用 RFC 5987 的 UTF-8 形式，
    否则中日文曲名会在响应头里变成乱码或直接被丢掉，只留下 ASCII 兜底名。
    """
    project = _get_project(request, project_id)
    artifact = next((item for item in project.exports if item.id == artifact_id), None)
    if artifact is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"工程 {project_id} 里没有登记 id 为 {artifact_id} 的成片",
        )

    path = Path(artifact.path)
    if not path.is_file():
        # 用户随时会把成片挪走或删掉。这不是服务端故障，别让它变成 500：
        # 说清楚"文件没了"，前端刷新一次列表这条记录就会被剔除。
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"成片文件已不存在（可能已被移动或删除）：{path.name}",
        )

    filename = _download_filename(project, artifact, path)
    ascii_fallback = path.name  # 磁盘名是 `{id}_{job}.mp4`，天然纯 ASCII
    disposition = (
        f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"
    )
    return FileResponse(
        str(path),
        media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        headers={
            "Content-Disposition": disposition,
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )


def _export_duration_ms(ffmpeg: str, out_path: Path, dto: ProjectDTO, req: RenderRequest) -> int:
    """成片实际时长。

    优先 ffprobe 实测：请求里的 `duration_s` 只是"要求截多长"，与实际产出可能差
    一帧到几百毫秒，截取范围超过片尾时更是差一大截。探测失败不该让一次成功的
    烧录变成失败，因此层层回退到请求值、再回退到工程时长。
    """
    try:
        return round(_probe_duration(_ffprobe_bin(ffmpeg), out_path) * 1000)
    except (
        subprocess.SubprocessError,
        OSError,
        json.JSONDecodeError,
        KeyError,
        ValueError,
    ):
        if req.duration_s is not None:
            return round(req.duration_s * 1000)
        return dto.duration_ms


def _run_export(job_id: str, store: ProjectStore, dto: ProjectDTO, req: RenderRequest) -> None:
    """后台线程实际执行的烧录流程，复用 `pipeline.make_video` 的烧录逻辑
    （`burn` / `_extract_audio` / `_mix_audio`），不重新实现一遍 ffmpeg 调用。

    任何一步失败都必须落到任务状态里而不是让线程静默死掉——自动环节的错误
    必须可见，这是"一站式"定位的硬要求（CLAUDE.md §2.5）。
    """
    try:
        if not dto.video_path:
            msg = "工程未关联视频文件，无法导出"
            raise RuntimeError(msg)
        # **导出永远烧在原始素材上**，绝不能用 `dto.proxy_video_path`：那份代理
        # 是 540p 无音轨的编辑器专用产物（见 kvm.media.proxy），拿它出片等于把
        # 成片画质砍掉一大截，而且是"导完才发现"的那种错误。
        video_path = Path(dto.video_path)

        _set_job(job_id, state="running", message="正在探测 ffmpeg…", progress=0.02)
        ffmpeg = _get_ffmpeg()

        _set_job(job_id, message="正在生成 ASS…", progress=0.1)
        ass_text = _build_ass_text(dto, embed_fonts=True)

        out_dir = default_root().parent / "exports"
        out_dir.mkdir(parents=True, exist_ok=True)
        ass_path = out_dir / f"{dto.id}_{job_id}.ass"
        ass_path.write_text(ass_text, encoding="utf-8")

        audio_track: Path | None = None
        if req.use_instrumental:
            if not dto.instrumental_path:
                msg = "工程未关联伴奏音轨，无法生成 OFF VOCAL"
                raise RuntimeError(msg)
            audio_track = Path(dto.instrumental_path)

        if req.with_guide:
            if not dto.vocals_path:
                msg = "工程未关联人声轨，无法合成引导声"
                raise RuntimeError(msg)

            _set_job(job_id, message="正在准备引导声…", progress=0.25)
            if audio_track is None:
                # 引导声要叠加在某条音轨上；未选伴奏时先从视频里抽出原始音轨作为底
                audio_track = _extract_audio(
                    ffmpeg, video_path, out_dir / f"{dto.id}_{job_id}_src_audio.wav"
                )
            # **一律按整曲时长**，即便这次只导一个片段：引导声的时间是绝对的，
            # 而 `burn` 用的是 output seek（`-ss` 在输入之后）。按片段时长合成会得到
            # 一条只覆盖 [0, duration_s] 的音轨，start_s 之后的片段里引导声整段消失。
            duration_s = dto.duration_ms / 1000.0
            # 优先复用素材页已经生成好的那一份——用户刚试听并认可的就是它，
            # 既省掉一次 CREPE，也保证"听到的"与"导出的"是同一条音轨。
            # 没有（或参数改过还没重新生成）时就地合成，不阻断导出（§2.5）。
            guide_path = guide_module.resolve_for_export(
                dto, out_dir / f"{dto.id}_{job_id}_guide.wav", duration_s
            )
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

        _set_job(job_id, message="正在登记成片…", progress=0.98)
        artifact = ExportArtifactDTO(
            id=job_id,
            path=str(out_path),
            created_at=time.time(),
            size_bytes=out_path.stat().st_size if out_path.is_file() else 0,
            duration_ms=_export_duration_ms(ffmpeg, out_path, dto, req),
            with_guide=req.with_guide,
            use_instrumental=req.use_instrumental,
            # 给了起点或时长就是片段试渲染。成片与试渲染在文件上无从分辨，
            # 不标出来用户过几天回看这一串 mp4 会分不清哪个能发出去。
            is_excerpt=req.start_s is not None or req.duration_s is not None,
        )
        # 登记必须在把任务标成 done **之前**：前端一看到 done 就会去拉产物列表，
        # 反过来的话那一拉必然是空的，用户会以为导出没产出东西。
        # KeyError = 工程在几分钟的烧录期间被删了：文件确实已经烧好，只是没有工程
        # 可登记，这次导出本身是成功的，不该翻成失败。
        with contextlib.suppress(KeyError):
            record_export(store, dto.id, artifact)

        _set_job(
            job_id,
            state="done",
            progress=1.0,
            message="完成",
            result={"output_path": str(out_path)},
        )
    except Exception as exc:  # 后台线程顶层兜底，见函数文档字符串
        _set_job(job_id, state="failed", error=str(exc), message="导出失败")
