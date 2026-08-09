"""编辑操作路由：三级调轴、注音、拆行/并行、声部。

这是编辑器的逻辑核心，但本文件刻意很薄——真正的规则全在
`kvm.editing.ops` 里，因为那一层不依赖 HTTP，可以直接单元测试。
路由只做三件事：解析请求、包一层 `store.mutate()`、把副作用回报出去。

## 为什么每个操作都返回完整的 `ProjectDTO`

工程 JSON 只有几十 KB，返回全量比返回增量补丁省掉了一整类"前后端状态漂移"
的 bug；`store.mutate()` 也正好以整份快照为撤销单元（见 `store.py` 的说明），
两边的粒度对齐，不需要额外的合并逻辑。

## 副作用有两个出口，分工不同

拆行会丢弃跨拆分点的注音。CLAUDE.md §4.4 要求**重绑失败的项不得静默丢弃**，
所以真正没保住的手工修改由 `ops` 写进 `ProjectDTO.orphans`，随响应体一起回到
前端、也随工程一起存盘，用户下次打开还能逐条确认。

`X-Kvm-Warning-Count` 头与日志则是**本次调用的回执**：被夹紧的平移量、被推开
的重叠行这类"做了但你该知道"的事不构成损失，塞进 orphans 只会把清单撑满、
让用户学会无视它。

## 批量接口为什么必须存在

`/timings` 与 `/lock` 收 items 数组，整批只调一次 `store.mutate()`。
tap-to-time 打完一首歌是几百个音节，逐个发请求就是几百步撤销——CLAUDE.md §8
把"重跑对齐是**一个** undo 单元而不是 N 个"写成硬要求，正是这个道理。
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request, Response
from kvm.api.schemas import (
    DerivePhoneticsRequest,
    MergeLineRequest,
    ProjectDTO,
    SetLockRequest,
    SetMetadataRequest,
    SetPhoneticRequest,
    SetRubyRequest,
    SetTimingRequest,
    SetTimingsRequest,
    SetVoicePartRequest,
    ShiftRequest,
    SplitLineRequest,
)
from kvm.api.store import ProjectStore
from kvm.editing import ops

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/editor", tags=["editor"])

_WARNING_HEADER = "X-Kvm-Warning-Count"


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _apply(
    request: Request,
    response: Response,
    project_id: str,
    label: str,
    run: Callable[[ProjectDTO], ops.EditOutcome],
) -> ProjectDTO:
    """把一次编辑包进撤销单元，并把警告导出去。

    `store.mutate()` 在 mutator 抛异常时不写历史也不落盘，所以校验失败的请求
    不会在撤销栈里留下空转的一格——用户按撤销时不该先撤掉一个"什么都没发生"。
    """
    store = _store(request)
    warnings: list[str] = []

    def _mutator(draft: ProjectDTO) -> None:
        warnings.extend(run(draft).warnings)

    try:
        project = store.mutate(project_id, _mutator, label=label)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"工程不存在：{project_id}") from exc
    except ops.EditError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    for text in warnings:
        _log.warning("[%s] 工程 %s：%s", label, project_id, text)
    response.headers[_WARNING_HEADER] = str(len(warnings))
    return project


@router.post("/shift", response_model=ProjectDTO)
def shift(req: ShiftRequest, request: Request, response: Response) -> ProjectDTO:
    """三级调轴：整体 / 单句 / 单词平移。

    `scope=global` 只改 `global_offset_ms`，不动任何 token 时间，用户随时能归零重来。
    """
    return _apply(
        request,
        response,
        req.project_id,
        f"平移（{req.scope}）",
        lambda draft: ops.shift(
            draft,
            scope=req.scope,
            delta_ms=req.delta_ms,
            line_id=req.line_id,
            token_index=req.token_index,
        ),
    )


@router.post("/timing", response_model=ProjectDTO)
def set_timing(req: SetTimingRequest, request: Request, response: Response) -> ProjectDTO:
    """设定某个音节的起点或时长（波形拖边界 / 数字直接输入）。"""
    return _apply(
        request,
        response,
        req.project_id,
        "设定音节时间",
        lambda draft: ops.set_timing(
            draft,
            line_id=req.line_id,
            token_index=req.token_index,
            start_ms=req.start_ms,
            dur_ms=req.dur_ms,
        ),
    )


@router.post("/timings", response_model=ProjectDTO)
def set_timings(req: SetTimingsRequest, request: Request, response: Response) -> ProjectDTO:
    """批量设定音节时间：**整批是一个撤销单元**。

    tap-to-time 打完一整首歌、或开启边界联动拖一次边界，都会一次改到多个音节。
    走逐个 `/timing` 的话，用户想撤回"刚才那一下"得按住 Ctrl+Z 不放。

    任一项寻址不成立则整批失败：`store.mutate()` 在 mutator 抛异常时既不写历史
    也不落盘，所以工程会原样留在批量执行之前，不会出现改了一半的轴。
    """
    return _apply(
        request,
        response,
        req.project_id,
        f"批量调轴（{len(req.items)} 项）",
        lambda draft: ops.set_timings(draft, items=req.items),
    )


@router.post("/lock", response_model=ProjectDTO)
def set_lock(req: SetLockRequest, request: Request, response: Response) -> ProjectDTO:
    """批量设置/清除锁定：音节时间锁、注音锁与发音形锁。

    §4.4 的 `(value, source, locked)` 只有在用户**能自己动 locked** 时才成立——
    否则界面上的 🔒 只是个只读徽章，重跑一次对齐就把他确认过的边界改回去了。

    只改锁标记、不改值，因此 `source` 保持原样：把歌词源给的时间标成 `manual`
    是伪造来源，会让 §7.4「用颜色区分 source」这条可见反馈失去依据。
    """
    return _apply(
        request,
        response,
        req.project_id,
        f"批量锁定（{len(req.items)} 项）",
        lambda draft: ops.set_locks(draft, items=req.items),
    )


@router.post("/ruby", response_model=ProjectDTO)
def set_ruby(req: SetRubyRequest, request: Request, response: Response) -> ProjectDTO:
    """设定行内字符区间的注音；`text` 为空表示清除该区间的注音。"""
    return _apply(
        request,
        response,
        req.project_id,
        "设定注音",
        lambda draft: ops.set_ruby(
            draft, line_id=req.line_id, start=req.start, end=req.end, text=req.text
        ),
    )


@router.post("/phonetic", response_model=ProjectDTO)
def set_phonetic(req: SetPhoneticRequest, request: Request, response: Response) -> ProjectDTO:
    """设定字符区间的**发音形**；`text` 为空表示清除覆盖、交还给自动推导。

    与 `/ruby` 分成两个端点，是因为它们是两份独立的读音（§4.2）：注音行显示「は」，
    喂强制对齐的必须是 ワ。各自带 `source` 与 `locked`，用户常常认可歌词源给的
    注音而只想改发音形。
    """
    return _apply(
        request,
        response,
        req.project_id,
        "设定发音形",
        lambda draft: ops.set_phonetic(
            draft, line_id=req.line_id, start=req.start, end=req.end, text=req.text
        ),
    )


@router.post("/phonetics/derive", response_model=ProjectDTO)
def derive_phonetics(
    req: DerivePhoneticsRequest, request: Request, response: Response
) -> ProjectDTO:
    """由表记读法批量推导发音形：整首歌（或指定几行）**一个撤销单元**。

    这是 §4.4 意义上的自动重算，**只覆盖 `locked=False` 的项**。它走 `store.mutate()`
    而不是 `update_derived()`：推导是用户点的按钮、会一次改到几百段读音，
    不进撤销栈就等于不可逆（`update_derived()` 是留给后台作业产物的，见 §8）。
    """
    return _apply(
        request,
        response,
        req.project_id,
        "推导发音形",
        lambda draft: ops.derive_phonetics(draft, line_ids=req.line_ids),
    )


@router.post("/metadata", response_model=ProjectDTO)
def set_metadata(req: SetMetadataRequest, request: Request, response: Response) -> ProjectDTO:
    """标记/取消标记一行为制作名单。

    导入时的自动判定必然有误判（§6.1），而误判的两个方向都很难看：漏判会让视频
    开头闪出五行像乱码一样的名单，误判会让真正在前奏里唱的那句歌词消失。
    §2.5 要求每个自动环节都有等价的手工旁路，这就是那条旁路，因此**进撤销栈**。
    """
    return _apply(
        request,
        response,
        req.project_id,
        "标记制作名单" if req.is_metadata else "取消制作名单标记",
        lambda draft: ops.set_metadata(
            draft, line_id=req.line_id, is_metadata=req.is_metadata
        ),
    )


@router.post("/split", response_model=ProjectDTO)
def split_line(req: SplitLineRequest, request: Request, response: Response) -> ProjectDTO:
    """在指定音节处拆行。跨拆分点的注音无法保留，会进 `ProjectDTO.orphans` 等用户确认。"""
    return _apply(
        request,
        response,
        req.project_id,
        "拆行",
        lambda draft: ops.split_line(draft, line_id=req.line_id, token_index=req.token_index),
    )


@router.post("/merge", response_model=ProjectDTO)
def merge_line(req: MergeLineRequest, request: Request, response: Response) -> ProjectDTO:
    """与下一行合并。注音索引反向迁移，时间重叠时后半段整体后推。"""
    return _apply(
        request,
        response,
        req.project_id,
        "并行",
        lambda draft: ops.merge_line(draft, line_id=req.line_id),
    )


@router.post("/voice-part", response_model=ProjectDTO)
def set_voice_part(req: SetVoicePartRequest, request: Request, response: Response) -> ProjectDTO:
    """指派声部。给出 `token_range` 时**直接写 token 字段**，不再拆行。

    拆行近似会让「A: 君の / B: 声が / 合: 聞こえる」这类句子各占一个槽位，
    屏幕上看起来是三句话而不是一句对唱——恰恰毁掉对唱最要紧的观感。

    `voice_part` 传空串表示清除区间内的音节级覆盖，让它们回到继承行声部。
    """
    return _apply(
        request,
        response,
        req.project_id,
        "指派声部",
        lambda draft: ops.set_voice_part(
            draft,
            line_id=req.line_id,
            voice_part=req.voice_part,
            token_range=req.token_range,
        ),
    )
