"""工程管理路由：创建 / 列表 / 读取 / 删除 / 撤销重做 / 样式 / 配色 / 备份导出，
外加跨工程的配色方案库。

不做任何业务判断，全部委托给 `ProjectStore`（持久化 + undo/redo 见
`kvm.api.store`）与 `kvm.editing.ops`（配色方案的读写规则）。本文件只负责
HTTP 语义（状态码、404）与请求/响应的 DTO 转换。

## 为什么这里挂了两个前缀不同的子路由

配色方案是**跨工程的全局资源**，挂在 `/api/projects/{id}/...` 下面会暗示它属于
某个工程，用户删掉那个工程就有理由担心方案也没了。所以它走 `/api/palettes`。
本模块导出的 `router` 因此是个空前缀的壳，底下装 `/api/projects` 与
`/api/palettes` 两个子路由——`app.py` 那边仍然只需 include 一次。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from kvm.api.schemas import (
    PaletteDTO,
    PaletteScheme,
    PaletteSchemeRenameRequest,
    PaletteSchemeSaveRequest,
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


def _lookup_scheme(name: str) -> PaletteScheme:
    for scheme in ops.load_palette_schemes():
        if scheme.name == name:
            return scheme
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"配色方案不存在：{name}")


@projects_router.post("/{project_id}/palettes", response_model=ProjectDTO)
def update_palettes(project_id: str, body: PaletteUpdateRequest, request: Request) -> ProjectDTO:
    """更新工程配色，走 `store.mutate()` 以进入撤销栈。

    配色此前只能读不能写，用户调完一刷新就回到默认色——样式面板里唯一没有出口
    的一块。走 mutate 而不是直接改对象，是因为调色本来就要反复试，能撤回才敢试。

    `scheme` + `apply_to` 是界面的主路径：**把一套方案的四色写给某一个声部**，
    别的声部原样不动。方案本身不带声部（见 `schemas.PaletteScheme`），所以
    `apply_to` 是必需的；`apply_to` 接受**任意用户自定义的声部名**，后端不做白名单，
    因为声部由用户在编辑舞台自由新建与改名。

    `scheme` 与 `palettes` 同时给出时先施加方案、再用 `palettes` 覆盖，
    于是"套用方案后微调"仍然是一步操作、一格撤销。
    """
    if bool(body.scheme) != bool(body.apply_to):
        # 两个必须成对出现。少一个就静默忽略的话，前端拼错参数会表现成"点了没反应"，
        # 比直接报错难查得多
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="scheme 与 apply_to 必须成对给出：方案是一组四色，要指明写给哪个声部",
        )

    incoming: dict[str, PaletteDTO] = {}
    if body.scheme and body.apply_to:
        scheme = _lookup_scheme(body.scheme)
        one = scheme.colors.model_copy(deep=True)
        one.name = body.apply_to
        incoming[body.apply_to] = one
    if body.palettes:
        incoming.update(body.palettes)
    if not incoming and not body.replace:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请求既没有给出 palettes 也没有指定 scheme，无事可做",
        )

    def _apply(draft: ProjectDTO) -> None:
        # 深拷贝而不是直接挂请求体里的对象：工程会长期留在 store 的内存缓存里，
        # 与一次性的请求对象共享实例迟早会咬人
        fresh = {k: v.model_copy(deep=True) for k, v in incoming.items()}
        if body.replace:
            # 整体替换：未出现的声部配色被删掉，用于"重置整首歌"而非"改一个声部"
            draft.palettes = fresh
        else:
            draft.palettes.update(fresh)

    label = f"配色方案「{body.scheme}」→ 声部「{body.apply_to}」" if body.scheme else "更新配色"
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


# ---- 配色方案（跨工程的全局资源） ----
#
# 方案是**一组四色**，不带声部：声部名由用户自定义（编辑舞台可新建、可改名），
# 把声部键焊进方案会让"按名字取色"在真实工程里全部落空。详见 `schemas.PaletteScheme`。


@palettes_router.get("/schemes", response_model=list[PaletteScheme])
def list_palette_schemes() -> list[PaletteScheme]:
    """列出内置 + 用户保存的配色方案，内置在前。

    方案文件损坏时只会少掉用户方案（`ops` 那边降级并记日志），内置的照常返回——
    样式面板不该因为一个坏文件整个打不开。
    """
    return ops.load_palette_schemes()


@palettes_router.post("/schemes", response_model=PaletteScheme, status_code=status.HTTP_201_CREATED)
def save_palette_scheme(body: PaletteSchemeSaveRequest, request: Request) -> PaletteScheme:
    """把一组四色存成方案。给出 `project_id` + `part` 就直接取该声部当前生效的四色。

    "把我现在调的这套存下来"是主路径：用户刚在某个工程里调好颜色，
    不该为了存个方案再把四个色号抄一遍。

    取色用的是**生效值**（该声部 → main → 默认）而不是"该声部自己的配色"：
    用户看到的就是生效值，存下来的必须与他看到的一致。
    """
    colors = body.colors
    if body.project_id:
        try:
            project = _store(request).get(body.project_id)
        except KeyError as exc:
            raise _not_found(exc) from exc
        part = body.part or "main"
        picked = project.palettes.get(part) or project.palettes.get("main")
        if picked is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"工程里声部「{part}」还没有配色可存",
            )
        colors = picked.model_copy(deep=True)
    if colors is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="没有可保存的配色：请求体里既没有 colors，也没有给出 project_id",
        )
    try:
        return ops.save_palette_scheme(body.name, colors, description=body.description)
    except ops.EditError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@palettes_router.patch("/schemes/{name}", response_model=PaletteScheme)
def rename_palette_scheme(name: str, body: PaletteSchemeRenameRequest) -> PaletteScheme:
    """给用户配色方案改名。内置不可改名（400），不存在返回 404。

    单独一个端点而不是让前端拼 delete + save：后者是两次写盘，中间断掉就把用户
    的配色弄丢了。这里落到 `ops.rename_palette_scheme` 的一次原子写。
    """
    try:
        return ops.rename_palette_scheme(name, body.new_name)
    except KeyError as exc:
        raise _not_found(exc) from exc
    except ops.EditError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@palettes_router.delete("/schemes/{name}")
def delete_palette_scheme(name: str) -> dict[str, bool]:
    """删除一个用户方案。内置不可删（400），方案不存在返回 404。"""
    try:
        ops.delete_palette_scheme(name)
    except KeyError as exc:
        raise _not_found(exc) from exc
    except ops.EditError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"ok": True}


router.include_router(projects_router)
router.include_router(palettes_router)
