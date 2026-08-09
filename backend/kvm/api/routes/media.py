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

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from starlette.responses import FileResponse

from kvm.api.schemas import (
    DownloadRequest,
    JobStatus,
    ProjectDTO,
    SeparateModelTier,
    SeparateRequest,
)
from kvm.api.store import ProjectStore
from kvm.jobs import job_manager
from kvm.media import download as download_module
from kvm.media import separate as separate_module

router = APIRouter(prefix="/api/media", tags=["media"])

# kind → ProjectDTO 上对应的媒体路径字段。
_MEDIA_FIELDS: dict[str, str] = {
    "video": "video_path",
    "audio": "audio_path",
    "instrumental": "instrumental_path",
    "vocals": "vocals_path",
    "drums": "drums_path",
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
    return job_manager.submit(
        kind="media.download",
        run=lambda handle: download_module.run_download(handle, store, req),
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
    field = _MEDIA_FIELDS.get(kind)
    if field is None:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的导入类型：{kind}（应为 {'/'.join(_MEDIA_FIELDS)} 之一）",
        )
    try:
        return download_module.import_local_media(
            store, project_id, kind, field, file.filename or "", file.file
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
        raise HTTPException(
            status_code=400, detail="工程还没有可用音频，请先下载或导入媒体后再分离"
        )
    return job_manager.submit(
        kind="media.separate",
        run=lambda handle: separate_module.run_separate(handle, store, req),
    )


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
        raise HTTPException(status_code=404, detail=f"工程 {project_id} 还没有 {kind} 媒体")
    path = Path(path_str)
    if not path.is_file():
        raise HTTPException(
            status_code=404, detail=f"媒体文件不存在（可能已被移动/清理）：{path}"
        )

    media_type = _EXTRA_MEDIA_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0]
    return FileResponse(
        str(path),
        media_type=media_type or "application/octet-stream",
        headers={"Cross-Origin-Resource-Policy": "cross-origin"},
    )
