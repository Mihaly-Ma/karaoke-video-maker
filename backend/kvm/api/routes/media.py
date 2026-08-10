"""媒体路由：下载、本地文件导入、人声分离、长任务查询/取消、媒体文件流式访问。

真正的下载/导入/分离逻辑在 `kvm.media.download` / `kvm.media.separate`；长任务的
调度（进度、取消、清理）统一走 `kvm.jobs.job_manager`（CLAUDE.md §5.13，
已定 D5）。本文件只做路由层的编排与参数校验。

`/download` 与 `/import` 是"视频获取"这一环节的一对自动/手工旁路
（CLAUDE.md §2.5），两者并列可用；`/import` 走同步返回而非任务轮询，因为
本地拷贝 + 探测的耗时远小于下载/分离。
"""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from kvm.api.schemas import (
    DownloadRequest,
    GuideParamsRequest,
    GuideRequest,
    GuideStatus,
    JobStatus,
    MediaProbeResponse,
    MediaTrackInfo,
    ProjectDTO,
    ProxyRequest,
    ProxyStatus,
    SeparateModelTier,
    SeparateRequest,
    WaveformLevelInfo,
    WaveformMetaDTO,
)
from kvm.api.store import ProjectStore
from kvm.jobs import job_manager
from kvm.media import download as download_module
from kvm.media import guide as guide_module
from kvm.media import probe as probe_module
from kvm.media import proxy as proxy_module
from kvm.media import separate as separate_module
from kvm.media import waveform as waveform_module
from kvm.media.download import _ffprobe_bin, project_media_dir
from kvm.media.ffmpeg import find_ffmpeg_with_libass
from starlette.responses import FileResponse

router = APIRouter(prefix="/api/media", tags=["media"])

# kind → ProjectDTO 上对应的媒体路径字段（可下发给前端播放的全部媒体）。
_MEDIA_FIELDS: dict[str, str] = {
    "video": "video_path",
    # 编辑用代理：Safari 放得动的 H.264/MP4 低分辨率短 GOP 版本。
    # **只用于编辑器预览**，导出成片走的是 `video` 那份原始素材（见 kvm.media.proxy）。
    "proxy": "proxy_video_path",
    "audio": "audio_path",
    "instrumental": "instrumental_path",
    "vocals": "vocals_path",
    "drums": "drums_path",
    # 合成的引导声（ガイドメロディ）。放进这张表就等于给了它一个可播放端点——
    # 素材页要试听、导出预览要真的把它放出来，都靠这一条（见 kvm.media.guide）。
    "guide": "guide_audio_path",
}

# 允许**手工导入**的 kind。比 `_MEDIA_FIELDS` 少 proxy 与 guide：这两者是本工具从
# 别的素材派生出来的中间产物，不是用户素材——放开导入只会让它们与源对不上号
# （代理与原视频、引导声与人声轨）。
_IMPORT_FIELDS: dict[str, str] = {
    k: v for k, v in _MEDIA_FIELDS.items() if k not in ("proxy", "guide")
}

# project_id → {kind: job_id}，该工程最近一次下载/分离任务。
#
# 存在的理由是**「素材还没准备好」和「素材出问题了」在工程 JSON 上长得一模一样**：
# 正在下载时 `video_path` 是空的，从没下载过时也是空的。消费方（预览区）必须能
# 分清这两者，否则只能把正常的中间状态报成故障。
#
# 记在这里而不是塞进 `JobStatus`：任务表本身与工程无关（导出任务就不属于任何一次
# 素材准备），而"哪个工程正在准备素材"是路由层才有的知识。代理与引导声任务各自
# 由 `kvm.media.proxy` / `kvm.media.guide` 记着（它们各有一个"就绪状态"接口要用），
# 这里不重复登记，否则 `/activity` 会把同一个任务列两遍。
_LATEST_JOBS: dict[str, dict[str, str]] = {}

# 允许算波形峰值的 kind：只有纯音频轨（CLAUDE.md §5.10）。video/proxy 是画面轨，
# 波形调轴用的是分离产物或原始参考音轨，不对着视频容器里的音频流重新算一遍。
_WAVEFORM_KINDS: dict[str, str] = {
    k: v
    for k, v in _MEDIA_FIELDS.items()
    if k in ("audio", "vocals", "instrumental", "drums", "guide")
}

# Python 的 `mimetypes` 默认不认识这几种常见容器/编码，显式补上，否则
# `<video>`/`<audio>` 标签可能因为 Content-Type 缺失/错误而拒绝播放。
_EXTRA_MEDIA_TYPES: dict[str, str] = {
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


def get_store(request: Request) -> ProjectStore:
    return request.app.state.store


def _project_or_404(store: ProjectStore, project_id: str) -> ProjectDTO:
    try:
        return store.get(project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _remember_job(project_id: str, job: JobStatus) -> JobStatus:
    """记下"这个工程正在跑这类素材任务"，见 `_LATEST_JOBS` 的说明。"""
    _LATEST_JOBS.setdefault(project_id, {})[job.kind] = job.job_id
    return job


@router.post("/download", response_model=JobStatus)
def start_download(req: DownloadRequest, store: ProjectStore = Depends(get_store)) -> JobStatus:
    """启动下载任务，写入 `req.project_id` 指定的既有工程，立即返回 `JobStatus`
    （异步执行）。

    **下载不新建工程**——工作流上用户会先建工程再往里放素材，且这样"先导入
    本地音频、再补下载视频"这类组合才能被表达（CLAUDE.md §2.5：自动环节
    yt-dlp 下载与手工旁路"选本地文件"必须并列可用，不是互斥的两条路）。
    提前校验工程存在，避免任务排上队才在后台报 404。
    """
    _project_or_404(store, req.project_id)
    return _remember_job(
        req.project_id,
        job_manager.submit(
            kind="media.download",
            run=lambda handle: download_module.run_download(handle, store, req),
        ),
    )


@router.post("/import", response_model=ProjectDTO)
def import_media(
    project_id: str = Form(...),
    kind: str = Form(...),
    file: UploadFile = File(...),
    store: ProjectStore = Depends(get_store),
) -> ProjectDTO:
    """手工导入本地媒体文件（CLAUDE.md §2.5"视频获取"一行的手工旁路——与
    yt-dlp 自动下载并列可用，随时可用，不是搜索/下载失败后才露出的降级）。

    契约对齐前端 `MediaPanel.tsx` 里 `importLocalFile()` 已经按假设写好的
    调用：multipart 字段 `project_id` / `kind` / `file`，直接返回完整
    `ProjectDTO`（不是 `JobStatus`——导入是本地磁盘拷贝 + 探测，量级远小于
    下载/分离，不需要走长任务轮询）。

    大文件（4K MV 数 GB）在 `download_module.import_local_media` 内部流式
    写盘，这里不读取 `file` 的完整内容进内存。
    """
    _project_or_404(store, project_id)
    field = _IMPORT_FIELDS.get(kind)
    if field is None:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的导入类型：{kind}（应为 {'/'.join(_IMPORT_FIELDS)} 之一）",
        )
    try:
        project = download_module.import_local_media(
            store, project_id, kind, field, file.filename or "", file.file
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if kind == "video":
        # 导入本地视频后自动补一份编辑用代理（与下载路径同一条自动化）。
        # 这一步只是排队，几毫秒返回，不拖慢导入本身的响应；失败也不影响导入结果——
        # 没有代理时预览会回退用原视频（Safari 上表现为只有声音）。
        proxy_module.submit_proxy_job(store, project_id)
    return project


@router.get("/separate/models", response_model=list[SeparateModelTier])
def list_separate_models() -> list[SeparateModelTier]:
    """列出可用的人声分离档位（CLAUDE.md §5.4 的三档）。

    前端据此渲染选项并把 `id` 原样回传给 `POST /separate`，**不再硬编码模型
    文件名**——此前前端传的是去掉扩展名的模型文件名，与后端的档位别名表对不上，
    "标准"和"最佳"两档必然报错。换模型/调档位现在只改 `kvm.media.separate` 一处。

    纯常量，不读磁盘也不联网，因此不需要走长任务。
    """
    return list(separate_module.MODEL_TIERS)


@router.post("/separate", response_model=JobStatus)
def start_separate(req: SeparateRequest, store: ProjectStore = Depends(get_store)) -> JobStatus:
    """启动分离任务。提前校验工程存在且已有音频，避免任务排上队才在后台报错。"""
    project = _project_or_404(store, req.project_id)
    if not project.audio_path:
        raise HTTPException(status_code=400, detail="工程没有可用音频。需要先下载或导入素材")
    return _remember_job(
        req.project_id,
        job_manager.submit(
            kind="media.separate",
            run=lambda handle: separate_module.run_separate(handle, store, req),
        ),
    )


@router.post("/proxy", response_model=JobStatus)
def start_proxy(req: ProxyRequest, store: ProjectStore = Depends(get_store)) -> JobStatus:
    """手动生成编辑用代理视频。

    自动路径在下载完成 / 导入本地视频之后由后端自行发起，这个接口是与之等价的
    手工入口（CLAUDE.md §2.5：每个自动环节都要有手工旁路），也用于给**已经有
    原视频但还没有代理**的老工程补一份。
    """
    project = _project_or_404(store, req.project_id)
    if not project.video_path:
        raise HTTPException(
            status_code=400,
            detail="工程没有视频文件，无法生成编辑代理",
        )
    return proxy_module.submit_proxy_job(
        store, req.project_id, max_height=req.max_height, force=req.force
    )


@router.get("/proxy/{project_id}", response_model=ProxyStatus)
def get_proxy_status(project_id: str, store: ProjectStore = Depends(get_store)) -> ProxyStatus:
    """代理是否就绪 + 最近一次代理任务的状态。

    前端靠它决定 `<video>` 的 src 用代理还是原视频，并在下载/导入之后自动发起的
    那次代理任务上显示进度——那个 job_id 只有后端知道。
    """
    project = _project_or_404(store, project_id)
    job = proxy_module.latest_job(project_id)
    path = project.proxy_video_path
    ready = bool(path) and Path(path or "").is_file()

    # note 是界面上的状态说明：只讲现在是什么状态、下一步能做什么。
    # 原先这几条把 Safari / MKV / AV1 / seek 这些内部理由摆给了用户，
    # 而他能做的只有"生成"或"重新生成"这一个动作。
    if ready:
        note = "编辑代理已就绪，预览使用代理"
    elif not project.video_path:
        note = "工程没有视频，无需代理"
    elif job is not None and job.state in ("pending", "running"):
        note = "正在生成编辑代理…"
    elif job is not None and job.state == "failed":
        note = f"编辑代理生成失败，预览回退为原视频：{job.error}"
    elif path:
        note = "编辑代理文件已不存在，需要重新生成"
    else:
        note = "尚未生成编辑代理。部分浏览器需要它才能显示画面"

    return ProxyStatus(project_id=project_id, ready=ready, path=path, job=job, note=note)


@router.post("/guide/params", response_model=ProjectDTO)
def set_guide_params(
    req: GuideParamsRequest, store: ProjectStore = Depends(get_store)
) -> ProjectDTO:
    """只改引导声参数，不触发合成。

    **占一格撤销**（走 `store.mutate`）：参数是用户拖滑块表达的意图，撤销回去
    理应回到上一组参数。产物路径则相反，由合成作业经 `update_derived` 登记，
    不占撤销格（CLAUDE.md §8「后台产物不进撤销栈」）。

    与合成分开成两个动作，是因为**不能每拖一下滑块就跑一次 CREPE**——整曲十几到
    几十秒。所以这里只存，重新合成由用户显式按按钮触发，中间那段"参数已改、
    产物还是旧的"由 `GET /guide/{project_id}` 的 `stale` 如实报出来。
    """
    _project_or_404(store, req.project_id)

    def _apply(draft: ProjectDTO) -> None:
        draft.guide = req.params

    return store.mutate(req.project_id, _apply, label="调整引导声参数")


@router.post("/guide", response_model=JobStatus)
def start_guide(req: GuideRequest, store: ProjectStore = Depends(get_store)) -> JobStatus:
    """合成引导声（ガイドメロディ）。提前校验人声轨存在，避免排上队才在后台报错。

    带了 `params` 就先存进工程（与 `POST /guide/params` 同一条路径，同样占一格
    撤销），再按存下来的那组参数合成——**界面上"改参数 + 重新生成"是一个动作**，
    分成两次请求只会在中间留下一个两者不一致的窗口。
    """
    project = _project_or_404(store, req.project_id)
    if not project.vocals_path:
        raise HTTPException(
            status_code=400,
            detail="工程没有人声轨。需要先完成人声分离，或手工导入人声轨",
        )
    if req.params is not None:
        set_guide_params(GuideParamsRequest(project_id=req.project_id, params=req.params), store)
    # 不走 `_remember_job`：引导声任务由 `kvm.media.guide` 自己记着（`GET /guide/{id}`
    # 要用），两处都登记会让 `/activity` 把同一个任务列两遍。
    return guide_module.submit_guide_job(store, req)


@router.get("/guide/{project_id}", response_model=GuideStatus)
def get_guide_status(project_id: str, store: ProjectStore = Depends(get_store)) -> GuideStatus:
    """引导声是否就绪、是不是旧参数产出的，以及最近一次合成任务的状态。

    `stale` 存在的理由见 `GuideStatus`：合成太贵，"参数改了但还没重新生成"
    是一个必然存在的中间态，不报出来用户会以为参数根本没生效。
    """
    project = _project_or_404(store, project_id)
    job = guide_module.latest_job(project_id)
    path = project.guide_audio_path
    ready = bool(path) and Path(path or "").is_file()
    current = guide_module.project_signature(project)
    stale = ready and project.guide_signature != current

    if not project.vocals_path:
        note = "需要先完成人声分离"
    elif job is not None and job.state in ("pending", "running"):
        note = "正在合成引导声…"
    elif job is not None and job.state == "failed":
        note = f"引导声合成失败：{job.error}"
    elif stale:
        note = "参数已变更，重新生成后生效"
    elif ready:
        note = "引导声已就绪，预览与导出均使用此文件"
    elif path:
        note = "引导声文件已不存在，需要重新生成"
    else:
        note = "尚未生成引导声。生成后可试听，导出时一并使用"

    return GuideStatus(
        project_id=project_id, ready=ready, stale=stale, path=path, job=job, note=note
    )


@router.get("/activity/{project_id}", response_model=list[JobStatus])
def get_media_activity(
    project_id: str, store: ProjectStore = Depends(get_store)
) -> list[JobStatus]:
    """该工程**此刻正在跑**的素材准备任务（下载 / 分离 / 代理 / 引导声），没有就是空数组。

    预览区靠它把"素材还没准备好"和"真的降级了"分开：前者是正常的中间状态，
    用户什么都不用做，报成警告只会让人以为出了故障。工程 JSON 回答不了这个问题
    ——正在下载和从没下载过，`video_path` 都是空的。

    与 `GET /jobs/{job_id}` 的分工：那个按 id 查单个任务，要求调用方**已经知道**
    id；本接口按工程反查，因此**页面刷新后依然有效**，也认得后端在下载/导入之后
    自动发起的那次代理任务——这两种情况下前端手里都没有 job_id。
    """
    _project_or_404(store, project_id)

    active: list[JobStatus] = []
    for job_id in _LATEST_JOBS.get(project_id, {}).values():
        try:
            job = job_manager.get(job_id)
        except KeyError:
            # 任务表是内存态，后端重启过就查不到了——当作"没有任务在跑"
            continue
        if job.state in ("pending", "running"):
            active.append(job)

    for job in (proxy_module.latest_job(project_id), guide_module.latest_job(project_id)):
        if job is not None and job.state in ("pending", "running"):
            active.append(job)

    return active


@router.get("/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    try:
        return job_manager.get(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/cancel", response_model=JobStatus)
def cancel_job(job_id: str) -> JobStatus:
    """取消任务：真正 kill 已登记的子进程（`kvm.jobs` 的进程组 kill），并按
    runner 注册的清理回调删除临时文件/半成品工程。
    """
    try:
        return job_manager.cancel(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/file/{project_id}/{kind}")
def get_media_file(
    project_id: str, kind: str, store: ProjectStore = Depends(get_store)
) -> FileResponse:
    """流式返回媒体文件，支持 Range 请求（拖动播放走 Starlette `FileResponse`
    内置的 Range 处理）。

    `Cross-Origin-Resource-Policy: cross-origin` 这里显式设置一遍：
    `kvm.api.app` 的全局中间件也会用 `setdefault` 兜底加上，这里写明是为了让
    这条路由自身的跨源行为不依赖调用方去读 app.py 才能确认。
    """
    project = _project_or_404(store, project_id)
    field = _MEDIA_FIELDS.get(kind)
    if field is None:
        raise HTTPException(
            status_code=404,
            detail=f"不支持的媒体类型：{kind}（应为 {'/'.join(_MEDIA_FIELDS)} 之一）",
        )
    path_str: str | None = getattr(project, field)
    if not path_str:
        raise HTTPException(status_code=404, detail=f"工程 {project_id} 没有 {kind} 媒体")
    path = Path(path_str)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"媒体文件已不存在（可能被移动或清理）：{path}")

    media_type = _EXTRA_MEDIA_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0]
    return FileResponse(
        str(path),
        media_type=media_type or "application/octet-stream",
        headers={"Cross-Origin-Resource-Policy": "cross-origin"},
    )


# ---------------------------------------------------------------------------
# 媒体探测（ffprobe）
# ---------------------------------------------------------------------------


def _track_info(ffprobe_bin: str, media_dir: Path, kind: str, path_str: str) -> MediaTrackInfo:
    info = probe_module.probe_track_cached(ffprobe_bin, media_dir, Path(path_str))
    return MediaTrackInfo(
        kind=kind,
        path=path_str,
        exists=info.exists,
        error=info.error,
        duration_ms=info.duration_ms,
        size_bytes=info.size_bytes,
        sample_rate_hz=info.sample_rate_hz,
        channels=info.channels,
        audio_codec=info.audio_codec,
        width=info.width,
        height=info.height,
        fps=info.fps,
        video_codec=info.video_codec,
    )


@router.get("/probe/{project_id}", response_model=MediaProbeResponse)
def probe_all_media(
    project_id: str, store: ProjectStore = Depends(get_store)
) -> MediaProbeResponse:
    """一次性探测工程当前拥有的全部媒体轨（时长/采样率/声道/体积，视频/代理
    另加分辨率/帧率）。用 ffprobe，不在后端手搓任何格式解析。

    只返回工程里**已经有路径**的 kind——素材面板要展示"目前有哪些轨"，
    不逐一对着还没导入的轨报 404；某条轨路径还在但文件已被移动/清理时，
    这条记录仍会出现，只是 `exists=False` 带着中文错误说明（CLAUDE.md §2.5：
    自动环节的错误必须可见，不能终止，不能因为一条轨读失败就搭上整个响应）。
    """
    project = _project_or_404(store, project_id)
    ffmpeg_bin = find_ffmpeg_with_libass()
    ffprobe_bin = _ffprobe_bin(ffmpeg_bin)
    media_dir = project_media_dir(project_id)

    tracks: dict[str, MediaTrackInfo] = {}
    for kind, field in _MEDIA_FIELDS.items():
        path_str: str | None = getattr(project, field)
        if not path_str:
            continue
        tracks[kind] = _track_info(ffprobe_bin, media_dir, kind, path_str)
    return MediaProbeResponse(project_id=project_id, tracks=tracks)


@router.get("/probe/{project_id}/{kind}", response_model=MediaTrackInfo)
def probe_one_media(
    project_id: str, kind: str, store: ProjectStore = Depends(get_store)
) -> MediaTrackInfo:
    """探测单条媒体轨。与 `GET /api/media/file/{project_id}/{kind}` 用同一套
    kind 命名与"kind 不支持/路径未设置"的 404 判据；文件路径已设置但磁盘上
    不存在时不 404，而是带 `exists=False` 正常返回（见 `probe_all_media`）。
    """
    project = _project_or_404(store, project_id)
    field = _MEDIA_FIELDS.get(kind)
    if field is None:
        raise HTTPException(
            status_code=404,
            detail=f"不支持的媒体类型：{kind}（应为 {'/'.join(_MEDIA_FIELDS)} 之一）",
        )
    path_str: str | None = getattr(project, field)
    if not path_str:
        raise HTTPException(status_code=404, detail=f"工程 {project_id} 没有 {kind} 媒体")

    ffmpeg_bin = find_ffmpeg_with_libass()
    ffprobe_bin = _ffprobe_bin(ffmpeg_bin)
    media_dir = project_media_dir(project_id)
    return _track_info(ffprobe_bin, media_dir, kind, path_str)


# ---------------------------------------------------------------------------
# 波形峰值（CLAUDE.md §5.10）
# ---------------------------------------------------------------------------


def _resolve_waveform_source(store: ProjectStore, project_id: str, kind: str) -> Path:
    """校验 kind 合法、工程有该轨、文件确实在磁盘上，返回其路径；否则抛 404。"""
    project = _project_or_404(store, project_id)
    field = _WAVEFORM_KINDS.get(kind)
    if field is None:
        raise HTTPException(
            status_code=404,
            detail=f"不支持的波形轨类型：{kind}（应为 {'/'.join(_WAVEFORM_KINDS)} 之一）",
        )
    path_str: str | None = getattr(project, field)
    if not path_str:
        raise HTTPException(status_code=404, detail=f"工程 {project_id} 没有 {kind} 媒体")
    path = Path(path_str)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"媒体文件已不存在（可能被移动或清理）：{path}")
    return path


@router.get("/waveform/{project_id}/{kind}", response_model=WaveformMetaDTO)
def get_waveform_meta(
    project_id: str, kind: str, store: ProjectStore = Depends(get_store)
) -> WaveformMetaDTO:
    """波形峰值的分级元信息：采样率/声道数/时长 + 每一级 LOD 的 (spp, 点数)。

    前端据此换算"当前 pxPerSec 该请求哪一级"，再拿着 level 序号去下面那个
    接口要该级的二进制峰值数据。未缓存时会在这次请求里同步完成解码与分级计算
    （实测耗时见 `kvm.media.waveform` 模块与本次交付报告——5 分钟量级的音频
    在几百毫秒到一点几秒之间，够快，没有必要为它另起一整套子进程 + 进度协议）。
    """
    path = _resolve_waveform_source(store, project_id, kind)
    ffmpeg_bin = find_ffmpeg_with_libass()
    ffprobe_bin = _ffprobe_bin(ffmpeg_bin)
    media_dir = project_media_dir(project_id)
    try:
        meta = waveform_module.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, kind, path)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return WaveformMetaDTO(
        project_id=project_id,
        kind=kind,
        sample_rate_hz=meta.sample_rate,
        channels=meta.channels,
        duration_ms=meta.duration_ms,
        levels=[WaveformLevelInfo(**lv) for lv in meta.levels],
        cached=meta.cached,
        elapsed_s=round(meta.elapsed_s, 3),
    )


@router.get("/waveform/{project_id}/{kind}/{level}")
def get_waveform_level(
    project_id: str, kind: str, level: int, store: ProjectStore = Depends(get_store)
) -> Response:
    """某一级 LOD 的峰值二进制数据：BBC waveform-data 二进制 v2 格式
    （版本号、采样率、声道数、samples_per_pixel、点数全部编在头里，
    前端可直接用 `waveform-data` 这个 npm 包解析，见 `kvm.media.waveform`
    模块文档）。
    """
    path = _resolve_waveform_source(store, project_id, kind)
    ffmpeg_bin = find_ffmpeg_with_libass()
    ffprobe_bin = _ffprobe_bin(ffmpeg_bin)
    media_dir = project_media_dir(project_id)
    try:
        # 按内容哈希缓存：未命中才会真正解码。前端一般先调过一次上面的元信息
        # 接口，这里几乎总是缓存命中（只需读取磁盘上已经算好的 .dat 文件）。
        meta = waveform_module.get_or_compute(ffmpeg_bin, ffprobe_bin, media_dir, kind, path)
        data = waveform_module.read_level_bytes(media_dir, kind, meta.source_sha256, level)
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Cross-Origin-Resource-Policy": "cross-origin"},
    )
