"""工程管理路由：创建 / 列表 / 读取 / 删除 / 撤销重做 / 样式 / 配色 / 备份导出，
外加跨工程的配色模板。

不做任何业务判断，全部委托给 `ProjectStore`（持久化 + undo/redo 见
`kvm.api.store`）与 `kvm.editing.ops`（配色模板的读写规则）。本文件只负责
HTTP 语义（状态码、404）与请求/响应的 DTO 转换。

## 为什么这里挂了两个前缀不同的子路由

配色模板是**跨工程的全局资源**，挂在 `/api/projects/{id}/...` 下面会暗示它属于
某个工程，用户删掉那个工程就有理由担心模板也没了。所以它走 `/api/palettes`。
本模块导出的 `router` 因此是个空前缀的壳，底下装 `/api/projects` 与
`/api/palettes` 两个子路由——`app.py` 那边仍然只需 include 一次。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from kvm.api.schemas import (
    PaletteDTO,
    PaletteTemplate,
    PaletteTemplateSaveRequest,
    PaletteUpdateRequest,
    ProjectDTO,
    ProjectSummary,
)
from kvm.api.store import ProjectStore
from kvm.editing import ops
from pydantic import BaseModel

projects_router = APIRouter(prefix="/api/projects", tags=["projects"])
palettes_router = APIRouter(prefix="/api/palettes", tags=["palettes"])

router = APIRouter()
"""对外唯一的装配点，见模块文档。子路由在文件末尾挂载。"""


class ProjectCreateRequest(BaseModel):
    """创建工程请求体。"""

    title: str = ""
    artist: str = ""


class StylePatchDTO(BaseModel):
    """样式局部更新请求体：字段与 `schemas.StyleDTO` 一一对应，但全部可选。

    未出现在请求体里的字段保持工程原值不变——路由用 `exclude_unset=True`
    识别"用户到底提供了哪些字段"，因此这里不能给字段设非 None 的默认值，
    否则会分不清"用户传了默认值"与"用户压根没传这个字段"。
    """

    font_name: str | None = None
    font_size: int | None = None
    bold: bool | None = None
    outline: float | None = None
    shadow: float | None = None
    ruby_scale: float | None = None
    ruby_gap: int | None = None
    margin_v: int | None = None
    margin_h: int | None = None
    line_gap: int | None = None
    stagger: bool | None = None
    lead_in_ms: int | None = None
    max_lead_ms: int | None = None
    lead_out_ms: int | None = None
    paragraph_gap_ms: int | None = None
    slot_gap_ms: int | None = None
    countdown_dots: int | None = None
    countdown_beat_ms: int | None = None
    countdown_min_gap_ms: int | None = None


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _not_found(exc: KeyError) -> HTTPException:
    """把 store 抛出的 KeyError 转成 404。

    `str(KeyError(...))` 会给消息套一层引号（repr 语义），改用
    `exc.args[0]` 拿到原始中文文案。
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=exc.args[0])


@projects_router.get("/", response_model=list[ProjectSummary])
def list_projects(request: Request) -> list[ProjectSummary]:
    """列出全部工程摘要，按最近修改时间倒序（见 `ProjectStore.list_all`）。"""
    return _store(request).list_all()


@projects_router.post("/", response_model=ProjectDTO, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreateRequest, request: Request) -> ProjectDTO:
    """新建工程并立即落盘。"""
    return _store(request).create(title=body.title, artist=body.artist)


@projects_router.get("/{project_id}", response_model=ProjectDTO)
def get_project(project_id: str, request: Request) -> ProjectDTO:
    try:
        return _store(request).get(project_id)
    except KeyError as exc:
        raise _not_found(exc) from exc


@projects_router.delete("/{project_id}")
def delete_project(project_id: str, request: Request) -> dict[str, bool]:
    store = _store(request)
    try:
        store.get(project_id)
    except KeyError as exc:
        raise _not_found(exc) from exc
    store.delete(project_id)
    return {"ok": True}


@projects_router.get("/{project_id}/history")
def get_history(project_id: str, request: Request) -> dict[str, int]:
    """撤销/重做栈深度，供前端决定按钮是否可点。"""
    try:
        undo_depth, redo_depth = _store(request).history_depth(project_id)
    except KeyError as exc:
        raise _not_found(exc) from exc
    return {"undo": undo_depth, "redo": redo_depth}


@projects_router.post("/{project_id}/undo", response_model=ProjectDTO)
def undo_project(project_id: str, request: Request) -> ProjectDTO:
    try:
        return _store(request).undo(project_id)
    except KeyError as exc:
        raise _not_found(exc) from exc


@projects_router.post("/{project_id}/redo", response_model=ProjectDTO)
def redo_project(project_id: str, request: Request) -> ProjectDTO:
    try:
        return _store(request).redo(project_id)
    except KeyError as exc:
        raise _not_found(exc) from exc


@projects_router.post("/{project_id}/style", response_model=ProjectDTO)
def update_style(project_id: str, patch: StylePatchDTO, request: Request) -> ProjectDTO:
    """局部更新样式，走 `store.mutate()` 以进入撤销栈。

    只覆盖请求体里显式出现的字段（`exclude_unset=True`），未提供的字段
    保留工程原值，不会被 `StylePatchDTO` 的默认值（None）误覆盖。
    """
    updates = patch.model_dump(exclude_unset=True)

    def _apply(draft: ProjectDTO) -> None:
        for key, value in updates.items():
            setattr(draft.style, key, value)

    try:
        return _store(request).mutate(project_id, _apply, label="更新样式")
    except KeyError as exc:
        raise _not_found(exc) from exc


@projects_router.get("/{project_id}/export")
def export_project(project_id: str, request: Request) -> Response:
    """导出工程 JSON 供用户自行备份。

    内容与 `GET /{project_id}` 一致，但附带 `Content-Disposition`，
    便于前端直接触发浏览器"另存为"下载，而不是喂进编辑器状态。
    """
    try:
        project = _store(request).get(project_id)
    except KeyError as exc:
        raise _not_found(exc) from exc
    payload = project.model_dump_json(indent=2)
    return Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{project_id}.kvm.json"'},
    )


# ---- 工程配色 ----


def _lookup_template(name: str) -> PaletteTemplate:
    for tpl in ops.load_palette_templates():
        if tpl.name == name:
            return tpl
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail=f"配色模板不存在：{name}"
    )


@projects_router.post("/{project_id}/palettes", response_model=ProjectDTO)
def update_palettes(
    project_id: str, body: PaletteUpdateRequest, request: Request
) -> ProjectDTO:
    """更新工程配色，走 `store.mutate()` 以进入撤销栈。

    配色此前只能读不能写，用户调完一刷新就回到默认色——样式面板里唯一没有出口
    的一块。走 mutate 而不是直接改对象，是因为调色本来就要反复试，能撤回才敢试。

    `template` 与 `palettes` 同时给出时先套模板、再用 `palettes` 覆盖其中几项，
    于是"套用模板后微调"仍然是一步操作、一格撤销。
    """
    incoming: dict[str, PaletteDTO] = {}
    if body.template is not None:
        tpl = _lookup_template(body.template)
        incoming.update({k: v.model_copy(deep=True) for k, v in tpl.palettes.items()})
    if body.palettes:
        incoming.update(body.palettes)
    if not incoming and not body.replace:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请求既没有给出 palettes 也没有指定 template，无事可做",
        )

    def _apply(draft: ProjectDTO) -> None:
        # 深拷贝而不是直接挂请求体里的对象：工程会长期留在 store 的内存缓存里，
        # 与一次性的请求对象共享实例迟早会咬人
        fresh = {k: v.model_copy(deep=True) for k, v in incoming.items()}
        if body.replace:
            # 整体替换：未出现的声部配色被删掉，用于"换一套模板"而非"改一个声部"
            draft.palettes = fresh
        else:
            draft.palettes.update(fresh)

    label = f"套用配色模板「{body.template}」" if body.template else "更新配色"
    try:
        return _store(request).mutate(project_id, _apply, label=label)
    except KeyError as exc:
        raise _not_found(exc) from exc


@projects_router.delete("/{project_id}/orphans", response_model=ProjectDTO)
def clear_orphans(project_id: str, request: Request, index: int | None = None) -> ProjectDTO:
    """确认（移除）失效修正清单里的条目；不给 `index` 就整张清空。

    §4.4 要求这些条目"让用户确认"，那就必须能被消化掉。只能看不能消的提示，
    用户第二次看到就会开始整体无视它，清单也就白设了。

    走 mutate 进撤销栈：误点"全部确认"之后总得能退回去再看一眼。
    """

    def _apply(draft: ProjectDTO) -> None:
        if index is None:
            draft.orphans.clear()
            return
        if not 0 <= index < len(draft.orphans):
            msg = f"失效修正清单只有 {len(draft.orphans)} 条，下标 {index} 越界"
            raise ops.EditError(msg)
        del draft.orphans[index]

    try:
        return _store(request).mutate(project_id, _apply, label="确认失效修正")
    except KeyError as exc:
        raise _not_found(exc) from exc
    except ops.EditError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


# ---- 配色模板（跨工程） ----


@palettes_router.get("/templates", response_model=list[PaletteTemplate])
def list_palette_templates() -> list[PaletteTemplate]:
    """列出内置 + 用户保存的配色模板，内置在前。

    模板文件损坏时只会少掉用户模板（`ops` 那边降级并记日志），内置的照常返回——
    样式面板不该因为一个坏文件整个打不开。
    """
    return ops.load_palette_templates()


@palettes_router.post(
    "/templates", response_model=PaletteTemplate, status_code=status.HTTP_201_CREATED
)
def save_palette_template(body: PaletteTemplateSaveRequest, request: Request) -> PaletteTemplate:
    """把一套配色存成模板。给出 `project_id` 就直接取该工程当前的配色。

    "保存当前配色为模板"是主路径：用户刚在某个工程里调好颜色，不该为了存个模板
    再把四组色号抄一遍。
    """
    palettes = body.palettes
    if body.project_id:
        try:
            project = _store(request).get(body.project_id)
        except KeyError as exc:
            raise _not_found(exc) from exc
        palettes = {k: v.model_copy(deep=True) for k, v in project.palettes.items()}
    if not palettes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="没有可保存的配色：工程尚未设置配色，请求体里也没有给出 palettes",
        )
    try:
        return ops.save_palette_template(body.name, palettes, description=body.description)
    except ops.EditError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@palettes_router.delete("/templates/{name}")
def delete_palette_template(name: str) -> dict[str, bool]:
    """删除一个用户模板。内置模板不可删（400），模板不存在返回 404。"""
    try:
        ops.delete_palette_template(name)
    except KeyError as exc:
        raise _not_found(exc) from exc
    except ops.EditError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"ok": True}


router.include_router(projects_router)
router.include_router(palettes_router)
