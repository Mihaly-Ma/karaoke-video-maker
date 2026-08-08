"""歌词路由：多源并行搜索、预览、应用到工程、手工导入。

CLAUDE.md §5.2（已定）：provider 只负责"取回并归一化"，不负责选择——
`/search` 把候选摆出来（带 `granularity`/`has_ruby`）让用户挑，不自动替他选。

CLAUDE.md §2.5：手工导入不是"搜索失败后的惩罚性回退"，`/import` 必须随时可用；
`/search` 部分歌词源失败时，其余源的结果照常返回，失败原因进 `errors`，
不能让一个源的故障拖垮整个搜索请求。
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import APIRouter, HTTPException, Request
from kvm.api.schemas import (
    LyricCandidate,
    LyricFetchRequest,
    LyricImportRequest,
    LyricPreview,
    LyricSearchRequest,
    LyricSearchResponse,
    ProjectDTO,
)
from kvm.api.store import ProjectStore
from kvm.lyrics.base import LyricProvider, LyricProviderError, TrackMatch
from kvm.lyrics.importer import parse_import
from kvm.lyrics.qq import QqMusicProvider

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/lyrics", tags=["lyrics"])

# provider 注册表：当前只接入 QQ音乐（CLAUDE.md §5.2 的第一版主源，已实测端到端闭环）。
# 其余 provider（酷狗 KRC / 网易云 / LRCLIB / YouTube 官方字幕 / UtaTen）陆续接入时，
# 只需实现 `LyricProvider` 接口并在这里追加一个条目，`/search` 的并行扇出与
# "部分源失败不影响其余"逻辑不用改。
PROVIDERS: dict[str, LyricProvider] = {
    "qq": QqMusicProvider(),
}


class LyricApplyRequest(LyricFetchRequest):
    """`/apply` 请求体：在 `schemas.LyricFetchRequest` 基础上加 `project_id`。

    预览阶段（`/preview`）不需要知道写到哪个工程，所以契约里的
    `LyricFetchRequest` 没带 `project_id`；应用阶段必须知道，这里在路由层
    组合出一个新类型，不修改 `schemas.py`。
    """

    project_id: str


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _not_found(exc: KeyError) -> HTTPException:
    """把 store 抛出的 KeyError 转成 404（`exc.args[0]` 是原始中文文案，`str()` 会多套一层引号）。"""
    return HTTPException(status_code=404, detail=exc.args[0])


def _score(match: TrackMatch, req: LyricSearchRequest) -> float:
    """resolver 打分：粒度 × 时长差 × 标题/歌手模糊匹配（CLAUDE.md §5.2）。

    只用来决定候选的展示顺序，**不裁决**——全部候选原样返回给用户。
    """
    granularity_weight = {"word": 3.0, "line": 2.0, "plain": 1.0}
    score = granularity_weight.get(match.granularity, 1.0)

    if req.duration_hint_ms and match.duration_ms:
        diff_s = abs(match.duration_ms - req.duration_hint_ms) / 1000.0
        score += 2.0 if diff_s < 3 else -min(diff_s / 10.0, 2.0)

    query = req.query.strip().lower()
    if query and query in match.title.lower():
        score += 1.0
    if query and query in match.artist.lower():
        score += 0.5
    return score


def _match_to_candidate(match: TrackMatch, req: LyricSearchRequest) -> LyricCandidate:
    return LyricCandidate(
        provider=match.provider,
        song_id=match.song_id,
        title=match.title,
        artist=match.artist,
        album=match.album,
        duration_ms=match.duration_ms,
        granularity=match.granularity,
        has_ruby=match.has_ruby,
        has_translation=match.has_translation,
        score=_score(match, req),
        note=match.note,
    )


@router.post("/search", response_model=LyricSearchResponse)
def search(req: LyricSearchRequest) -> LyricSearchResponse:
    """多源并行搜索。单个源的故障进 `errors`，不影响其余源的候选照常返回。"""
    names = req.providers or list(PROVIDERS)
    active = [(name, PROVIDERS[name]) for name in names if name in PROVIDERS]
    errors: dict[str, str] = {name: "未知歌词源" for name in names if name not in PROVIDERS}

    candidates: list[LyricCandidate] = []
    if active:
        with ThreadPoolExecutor(max_workers=len(active)) as pool:
            futures = {
                pool.submit(
                    provider.search, req.query, duration_hint_ms=req.duration_hint_ms
                ): name
                for name, provider in active
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    matches = future.result()
                except LyricProviderError as exc:
                    errors[name] = str(exc)
                    continue
                except Exception as exc:
                    # 单个 provider 的意外异常（非预期的 bug）不能拖垮整个搜索请求——
                    # CLAUDE.md §2.5：自动环节失败要降级、不能终止。
                    _log.exception("歌词源 %s 搜索时发生未预期异常", name)
                    errors[name] = f"未预期错误：{exc}"
                    continue
                candidates.extend(_match_to_candidate(m, req) for m in matches)

    candidates.sort(key=lambda c: c.score, reverse=True)
    return LyricSearchResponse(candidates=candidates, errors=errors)


@router.post("/preview", response_model=LyricPreview)
def preview(req: LyricFetchRequest) -> LyricPreview:
    """下载但不应用，返回解析后的行供用户预览再决定用哪条候选。"""
    provider = PROVIDERS.get(req.provider)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"未知歌词源：{req.provider}")
    try:
        parsed = provider.fetch(req.song_id)
    except LyricProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return LyricPreview(
        lines=parsed.lines,
        granularity=parsed.granularity,
        has_ruby=parsed.has_ruby,
        raw_excerpt=parsed.raw_excerpt,
    )


@router.post("/apply", response_model=ProjectDTO)
def apply_lyric(req: LyricApplyRequest, request: Request) -> ProjectDTO:
    """下载并写入工程，走 `store.mutate` 进撤销栈——用户随时能撤销这次替换。"""
    provider = PROVIDERS.get(req.provider)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"未知歌词源：{req.provider}")
    try:
        parsed = provider.fetch(req.song_id)
    except LyricProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    def _mutator(draft: ProjectDTO) -> None:
        draft.lines = parsed.lines

    try:
        return _store(request).mutate(
            req.project_id, _mutator, label=f"导入歌词（{req.provider}）"
        )
    except KeyError as exc:
        raise _not_found(exc) from exc


@router.post("/import", response_model=ProjectDTO)
def import_lyric(req: LyricImportRequest, request: Request) -> ProjectDTO:
    """手工导入 text / lrc / qrc——不是搜索失败后的惩罚性回退，随时可用。"""
    try:
        lines = parse_import(req.kind, req.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _mutator(draft: ProjectDTO) -> None:
        draft.lines = lines if req.replace else [*draft.lines, *lines]

    try:
        return _store(request).mutate(req.project_id, _mutator, label="手工导入歌词")
    except KeyError as exc:
        raise _not_found(exc) from exc
