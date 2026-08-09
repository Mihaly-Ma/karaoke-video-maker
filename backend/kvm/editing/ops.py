"""编辑操作的纯逻辑层：三级调轴、注音、拆行/并行、声部指派。

本模块**不依赖 FastAPI，也不依赖工程存储**，只对传入的 `ProjectDTO` 就地求值。
路由层负责把每次调用包进 `store.mutate()`（一次调用 = 一个撤销单元），
单元测试则直接构造 DTO 调用这里的函数。

## 为什么每个操作都返回 `EditOutcome`，以及为什么还要写 `project.orphans`

拆行会让跨拆分点的注音无处安放。CLAUDE.md §4.4 明确要求
**重绑失败的锁定项不得静默丢弃**——静默丢弃等于用户调了 40 分钟的东西
莫名其妙消失。

两个出口各有分工，不是重复：`EditOutcome.warnings` 是**本次调用的回执**，
路由层写进日志、给出条数，用完即弃；`project.orphans` 是**留在工程里的待办**，
跟着工程一起存盘，用户下次打开还能看到并逐条确认。只有"用户的手工成果真的
没保住"才进 orphans——被夹紧的平移量、被推开的重叠行只是回执，不是损失。

## 配色模板为什么也在这一层

模板是跨工程的全局资源，本该有自己的模块，但它同样"不依赖 FastAPI、
可以直接单元测试"，与本模块的定位一致；分出去只会多一个二十行的文件。
它只借 `api.store.default_root()` 定位用户数据目录，不碰任何工程文件。

## `locked` 语义（本模块存在的理由）

CLAUDE.md §4.4：任何自动重算**只覆盖 `locked=False` 的项**。
反过来说，**任何手工编辑都必须把受影响项标成 `manual` 并 `locked`**，
否则将来的强制对齐、注音重算会把用户的手工调整平掉。
这条不是优化项，而是"用户手工调整绝不被覆盖"这条产品承诺的唯一技术保证，
所以每个改值的地方都紧跟着一次标记，不做"稍后统一标记"的聚合。

## 时间不变式

1. token 起点非负。渲染时还会叠加 `global_offset_ms`，因此**全局平移也必须
   保证叠加后非负**，不能只看 token 自身。
2. 同一行内 token 不倒挂：`tokens[i].end_ms <= tokens[i + 1].start_ms`。
3. token 时长不小于 `MIN_DUR_MS`。

**相邻 token 的边界是共享的**（§4.2：`mora[i].t_end_ms === mora[i+1].t_start_ms`），
QRC 逐字轴实测也是首尾相接。因此单词级的时间编辑必然牵动紧邻的一个 token：
动边界时由邻居的时长补偿，邻居的另一端不动。若不这么做，在首尾相接的数据上
任何单词级调整都会被夹紧成零位移——单词级调轴形同虚设。

**行与行之间不设时间约束**：CLAUDE.md §8.5 要求支持"同一时刻两个声部唱不同
歌词、同屏各走各的轴"，数据结构与编辑层都不得假设行之间时间互斥。

越界一律**夹紧而不是报错**：§2.5 的一站式定位下，用户按住方向键把某个音节
推到 0 之前，正确反应是停在 0，而不是弹一个对话框把他打断。
"""

from __future__ import annotations

import json
import logging
import tempfile
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from kvm.api.schemas import (
    CharSpanDTO,
    LineDTO,
    LockItem,
    OrphanedEdit,
    PaletteDTO,
    PaletteTemplate,
    PhoneticSpanDTO,
    ProjectDTO,
    RubySpanDTO,
    TimingItem,
    TokenDTO,
)
from kvm.api.store import default_root
from kvm.models.karaoke import (
    ReadingSource,
    TimingSource,
    derive_phonetic,
    is_kana,
    is_kana_text,
    to_katakana,
)

_log = logging.getLogger(__name__)

MIN_DUR_MS = 10
"""token 的最小时长。

ASS 的 `\\k` 单位是厘秒，低于 10ms 的块序列化后就是 0 厘秒，会命中
libass #124（行首零时长音节让整行卡在 SecondaryColour，至今未修）。
夹紧到一个厘秒既守住了这条底线，用户也察觉不到。
"""


class EditError(ValueError):
    """编辑请求本身不成立（行不存在、拆分点落在行外等）。

    与"值越界"严格区分：**值越界一律夹紧**（§2.5，一站式不该被边界情况打断），
    只有**寻址不成立**才抛错——那是调用方的 bug，静默吞掉反而更难查。
    """


@dataclass
class EditOutcome:
    """一次编辑的副作用说明。

    `warnings` 里是"做了但用户需要知道"的事：被夹紧的平移量、被推开的重叠行、
    丢失的注音。它不是错误，操作已经生效。

    其中"用户手工成果真的没保住"的那几条会同时写进 `project.orphans`，
    因为回执看完就没了，而这类损失需要用户事后逐条确认。
    """

    warnings: list[str] = field(default_factory=list)


MAX_ORPHANS = 200
"""失效修正清单的条数上限。

清单是给用户逐条确认用的。攒到几千条就没人看了，真正重要的那几条反而被淹掉，
于是超出后丢弃最旧的——新近的编辑更可能还留在用户的记忆里。
"""


# ---- 内部工具 ----


def _add_orphan(
    project: ProjectDTO,
    out: EditOutcome,
    *,
    kind: str,
    detail: str,
    payload: dict,
) -> None:
    """记录一条没能保住的手工修改，同时回报为本次调用的警告。

    §4.4 要求重绑失败的项不得静默丢弃。只写日志是不够的——日志只有开发者看得见，
    所以这里写进工程本身，让前端能把它摆到用户面前，`payload` 供用户一键重新应用。
    """
    project.orphans.append(OrphanedEdit(kind=kind, detail=detail, payload=payload))
    if len(project.orphans) > MAX_ORPHANS:
        del project.orphans[: len(project.orphans) - MAX_ORPHANS]
    out.warnings.append(detail)


def _new_line_id() -> str:
    """新行的 id。与 `ProjectStore.create` 的工程 id 取同样长度，便于肉眼区分。"""
    return uuid.uuid4().hex[:12]


def _find_line(project: ProjectDTO, line_id: str) -> tuple[int, LineDTO]:
    for i, ln in enumerate(project.lines):
        if ln.id == line_id:
            return i, ln
    msg = f"行不存在：{line_id}"
    raise EditError(msg)


def _line_text(line: LineDTO) -> str:
    """行的完整书写文本。注音区间用的就是这个串上的字符索引。"""
    return "".join(t.text for t in line.tokens)


def _mark_timing_manual(token: TokenDTO) -> None:
    """把 token 的时间标成手工。自动重算此后必须跳过它。"""
    token.timing_source = TimingSource.MANUAL.value
    token.locked_timing = True


def _ends_at(a: TokenDTO, b: TokenDTO) -> bool:
    """a 的终点是否正好是 b 的起点，即两者共享同一条边界。"""
    return a.start_ms + a.dur_ms == b.start_ms


def _shift_block(tokens: list[TokenDTO], index: int, delta_ms: int) -> tuple[int, set[int]]:
    """整体平移一个 token，由相邻 token 的时长吸收这次位移。

    **邻居必须跟着动，否则这个操作在真实数据上是死的**：QRC 逐字轴首尾相接
    （实测 `桜(774,665)舞(1439,188)`，774+665=1439），§4.2 也把相邻边界定义为
    同一个值。若坚持"只动自己、不碰邻居"，夹紧后位移量恒为 0，单词级调轴
    就完全动不了。

    摊法：前一个 token 的时长伸缩（起点不动），后一个 token 的起点平移、时长
    反向补偿（终点不动）。于是改动**严格局限在三个 token 内**，整行的首尾时间
    与其余 token 全不受影响，不会一次微调波及全行。

    与邻居之间原本留有空档时不牵动邻居，只把自己夹进空档里。
    返回实际位移量与真正被改动的 token 下标。
    """
    tok = tokens[index]
    tok_end = tok.start_ms + tok.dur_ms

    lower = -tok.start_ms
    lead_shared = False
    if index > 0:
        prev = tokens[index - 1]
        lead_shared = _ends_at(prev, tok)
        # 共享边界时前一个 token 可以被压缩到最短；有空档时只能顶到它的终点
        floor = prev.start_ms + MIN_DUR_MS if lead_shared else prev.start_ms + prev.dur_ms
        lower = max(lower, floor - tok.start_ms)

    upper: int | None = None
    trail_shared = False
    if index + 1 < len(tokens):
        nxt = tokens[index + 1]
        trail_shared = _ends_at(tok, nxt)
        ceil = nxt.start_ms + nxt.dur_ms - MIN_DUR_MS if trail_shared else nxt.start_ms
        upper = ceil - tok_end

    eff = max(delta_ms, lower)
    if upper is not None:
        eff = min(eff, max(upper, lower))

    tok.start_ms += eff
    touched = {index}
    if eff != 0:
        if lead_shared:
            tokens[index - 1].dur_ms += eff
            touched.add(index - 1)
        if trail_shared:
            tokens[index + 1].start_ms += eff
            tokens[index + 1].dur_ms -= eff
            touched.add(index + 1)
    return eff, touched


def _set_leading_edge(tokens: list[TokenDTO], index: int, value: int) -> tuple[int, set[int]]:
    """把某个 token 的起点设到 `value`，终点不动（拖动它与前一个之间的边界）。

    与前一个 token 共享边界时，那个 token 的时长跟着补偿，边界仍然是同一个值。
    """
    tok = tokens[index]
    tok_end = tok.start_ms + tok.dur_ms

    lower = 0
    lead_shared = False
    if index > 0:
        prev = tokens[index - 1]
        lead_shared = _ends_at(prev, tok)
        lower = max(0, prev.start_ms + MIN_DUR_MS if lead_shared else prev.start_ms + prev.dur_ms)
    upper = max(tok_end - MIN_DUR_MS, lower)

    val = min(max(value, lower), upper)
    delta = val - tok.start_ms
    tok.start_ms = val
    tok.dur_ms = max(MIN_DUR_MS, tok_end - val)
    touched = {index}
    if delta != 0 and lead_shared:
        tokens[index - 1].dur_ms += delta
        touched.add(index - 1)
    return val, touched


def _set_trailing_edge(tokens: list[TokenDTO], index: int, value: int) -> tuple[int, set[int]]:
    """把某个 token 的终点设到 `value`，起点不动（拖动它与后一个之间的边界）。"""
    tok = tokens[index]
    tok_end = tok.start_ms + tok.dur_ms

    lower = tok.start_ms + MIN_DUR_MS
    trail_shared = False
    upper: int | None = None
    if index + 1 < len(tokens):
        nxt = tokens[index + 1]
        trail_shared = _ends_at(tok, nxt)
        upper = nxt.start_ms + nxt.dur_ms - MIN_DUR_MS if trail_shared else nxt.start_ms

    val = max(value, lower)
    if upper is not None:
        val = min(val, max(upper, lower))
    delta = val - tok_end
    tok.dur_ms = val - tok.start_ms
    touched = {index}
    if delta != 0 and trail_shared:
        tokens[index + 1].start_ms += delta
        tokens[index + 1].dur_ms -= delta
        touched.add(index + 1)
    return val, touched


def _intersects(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """两个左闭右开区间是否相交。首尾相接不算相交。"""
    return a_start < b_end and a_end > b_start


def _partition_spans[S: CharSpanDTO](
    spans: Sequence[S], char_bounds: Sequence[int]
) -> tuple[list[list[S]], list[S]]:
    """按字符切点把读音区间分桶，并把跨切点的单列出来。

    对**表记读法与发音形一视同仁**（两者都是挂在行内字符区间上的读音，
    迁移规则完全相同），写成泛型是为了不让同一段索引运算存在两份——
    只改对一份的那天，注音迁对了而发音形挂到别的字上，症状还极难看出来。

    `char_bounds` 是升序的字符切点（含首尾），第 j 个桶覆盖
    `[char_bounds[j], char_bounds[j + 1])`。落入某个桶的区间，索引会减去该桶
    的起点——`start`/`end` 是**行内**字符索引，换了行就必须重算。

    跨切点的区间无法在任何一行内表达，只能丢弃，但**必须回报**（§4.4）。
    """
    buckets: list[list[S]] = [[] for _ in range(len(char_bounds) - 1)]
    dropped: list[S] = []
    for sp in spans:
        if sp.start >= sp.end:
            # 空区间本就不该存在，顺手清掉，不算丢失
            continue
        for j in range(len(buckets)):
            lo, hi = char_bounds[j], char_bounds[j + 1]
            if lo <= sp.start and sp.end <= hi:
                buckets[j].append(sp.model_copy(update={"start": sp.start - lo, "end": sp.end - lo}))
                break
        else:
            dropped.append(sp)
    return buckets, dropped


# ---- 读音单元与发音形推导 ----


@dataclass(frozen=True)
class _ReadingUnit:
    """行内的一个"读音单元"：注音区间，或注音之间的一段连续同类字符。

    这是发音形挂载的粒度，也正是注音编辑器里用户点一下选中的那个东西
    （前端 `RubyModel.buildUnits` 是同一套切分）。**不按 token 切**：
    token 是计时单元、多数是单个字符，「学校」的 ガッコウ 无法确定地劈成两半。
    """

    start: int
    end: int
    surface: str
    """书写形。助词替换只认它——「葉(は)」读音也是 は，但它读 /ha/。"""

    display: str
    """表记读法。纯假名单元就是书写形本身；未注音的汉字块与拉丁词为空串。"""


def _bare_units(surface: str, lo: int, hi: int) -> list[_ReadingUnit]:
    """把没有注音的一段 `[lo, hi)` 切成"假名串"与"非假名串"两类连续块。

    假名块自带读音（书写形即读音），非假名块（未注音的汉字、拉丁词）读音未知，
    留空让界面提示用户补，**不猜**。

    假名块整块处理而不是逐字处理，是助词规则能否成立的关键：`は` 只有在自成
    一个单元时（左右都是汉字或注音，日语歌词里助词的典型位置）才当助词换成 ワ；
    夹在 `はまだ` 里的 は 属于词的一部分，逐字处理会把它错换掉。
    """
    out: list[_ReadingUnit] = []
    i = lo
    while i < hi:
        kana = is_kana(surface[i])
        j = i + 1
        while j < hi and is_kana(surface[j]) == kana:
            j += 1
        text = surface[i:j]
        out.append(_ReadingUnit(start=i, end=j, surface=text, display=text if kana else ""))
        i = j
    return out


def _reading_units(line: LineDTO) -> list[_ReadingUnit]:
    """把一行切成读音单元：注音区间 + 注音之间的裸字符块。

    注音区间之间本不该重叠（§4.2 不变式），真重叠时以靠前的一条为准并跳过后一条：
    此处只是消费方，不该顺手改数据。
    """
    surface = _line_text(line)
    spans = sorted(
        (sp for sp in line.ruby if 0 <= sp.start < sp.end <= len(surface)),
        key=lambda sp: (sp.start, sp.end),
    )
    units: list[_ReadingUnit] = []
    cursor = 0
    for sp in spans:
        if sp.start < cursor:
            continue
        units.extend(_bare_units(surface, cursor, sp.start))
        units.append(
            _ReadingUnit(
                start=sp.start,
                end=sp.end,
                surface=surface[sp.start : sp.end],
                display=sp.text,
            )
        )
        cursor = sp.end
    units.extend(_bare_units(surface, cursor, len(surface)))
    return units


@dataclass
class _DeriveStats:
    """一次发音形推导的账目，用于给用户一句话回执。"""

    added: int = 0
    updated: int = 0
    kept_locked: int = 0
    """因为落在锁定项上而没碰的单元——§4.4 的硬边界，不是失败。"""

    undetermined: int = 0
    """推不出来的单元（未注音的汉字、拉丁词），需要用户手工填。"""

    def merge(self, other: _DeriveStats) -> None:
        self.added += other.added
        self.updated += other.updated
        self.kept_locked += other.kept_locked
        self.undetermined += other.undetermined


def _derive_span_range(line: LineDTO, lo: int, hi: int) -> _DeriveStats:
    """把 `[lo, hi)` 内每个读音单元的发音形重新推导一遍。

    这是 §4.4 意义上的"自动重算"，因此**只覆盖 `locked=False` 的项**：
    锁定的区间原样保留，与它相交的单元整个跳过（保住"发音形区间互不重叠"
    这条不变式；宁可少推一段，也不能在用户锁定的读音旁边再叠一段）。

    范围内没有对应单元的非锁定区间会被清掉——那是上一次分行/注音留下的陈迹，
    留着只会让后续消费方读到一段对不上任何词的读音。
    """
    stats = _DeriveStats()
    locked = [sp for sp in line.phonetics if sp.locked]
    kept = [
        sp for sp in line.phonetics if sp.locked or not _intersects(sp.start, sp.end, lo, hi)
    ]
    previous = {(sp.start, sp.end): sp.text for sp in line.phonetics if not sp.locked}

    for unit in _reading_units(line):
        if not _intersects(unit.start, unit.end, lo, hi):
            continue
        if any(_intersects(sp.start, sp.end, unit.start, unit.end) for sp in locked):
            stats.kept_locked += 1
            continue
        value = derive_phonetic(unit.display, surface=unit.surface)
        if not value:
            stats.undetermined += 1
            continue
        prev = previous.get((unit.start, unit.end))
        if prev is None:
            stats.added += 1
        elif prev != value:
            stats.updated += 1
        kept.append(
            PhoneticSpanDTO(
                start=unit.start,
                end=unit.end,
                text=value,
                source=ReadingSource.DERIVED.value,
                locked=False,
            )
        )

    kept.sort(key=lambda sp: (sp.start, sp.end))
    line.phonetics = kept
    return stats


def _rederive_phonetics(line: LineDTO, *, materialized: bool) -> _DeriveStats:
    """结构性编辑（拆行/并行/改注音）之后就地刷新整行的发音形。

    `materialized=False` 时直接返回：发音形层是**按需物化**的，一条都没有说明
    这首歌还没启用它。拆个行就凭空造出一堆读音，会让工程里半数行有、半数行没有，
    用户既看不懂也无从判断哪些该复核。
    """
    if not materialized:
        return _DeriveStats()
    return _derive_span_range(line, 0, len(_line_text(line)))


def _record_dropped_ruby(
    project: ProjectDTO,
    out: EditOutcome,
    *,
    line_id: str,
    surface: str,
    spans: Sequence[RubySpanDTO],
) -> None:
    """把拆行时无处安放的注音记进失效修正清单。

    文案里带上被注音的原文（`surface[start:end]`）而不是光秃秃的字符下标——
    用户看到"「明日」的注音 あした"能立刻知道是哪个词，看到"字符区间 3-5"
    还得回去数字符。
    """
    for sp in spans:
        base = surface[sp.start : sp.end]
        _add_orphan(
            project,
            out,
            kind="ruby",
            detail=(
                f"「{base}」的注音「{sp.text}」在拆行后跨越了分界，无法迁移，请重新标注"
                + ("（这条是你手工锁定过的）" if sp.locked else "")
            ),
            payload={
                "line_id": line_id,
                "start": sp.start,
                "end": sp.end,
                "text": sp.text,
                "source": sp.source,
                "locked": sp.locked,
                "base": base,
            },
        )


def _record_dropped_phonetics(
    project: ProjectDTO,
    out: EditOutcome,
    *,
    line_id: str,
    surface: str,
    spans: Sequence[PhoneticSpanDTO],
) -> None:
    """把拆行时无处安放的**发音形**记进失效修正清单——**只记锁定过的那些**。

    与注音不同：没锁的发音形是推导出来的，拆完行重新推导一遍就回来了，
    把它们塞进清单只会让真正需要用户确认的条目被淹掉（清单只装真的没保住的东西）。
    """
    for sp in spans:
        if not sp.locked:
            continue
        base = surface[sp.start : sp.end]
        _add_orphan(
            project,
            out,
            kind="phonetic",
            detail=(
                f"「{base}」上你锁定过的发音形「{sp.text}」在拆行后跨越了分界，"
                "无法迁移，请重新填写"
            ),
            payload={
                "line_id": line_id,
                "start": sp.start,
                "end": sp.end,
                "text": sp.text,
                "source": sp.source,
                "locked": sp.locked,
                "base": base,
            },
        )


def _split_tokens(
    line: LineDTO, cuts: Sequence[int]
) -> tuple[list[LineDTO], list[RubySpanDTO], list[PhoneticSpanDTO]]:
    """在给定的 token 下标处把一行切成若干行。

    第一段**沿用原行 id**，让前端已有的选中态、引用不至于失效；其余段取新 id。
    切出来的行一律 `locked=True`：手工分行是明确的用户意图，自动分行不得覆盖。

    `slot` 逐段交替只是个合理初值——渲染层的 `_assign_slots` 会按段落重新分配，
    这里不做全局重排。
    """
    n = len(line.tokens)
    bounds = [0, *cuts, n]
    char_bounds = [sum(len(t.text) for t in line.tokens[:b]) for b in bounds]
    ruby_buckets, dropped_ruby = _partition_spans(line.ruby, char_bounds)
    ph_buckets, dropped_ph = _partition_spans(line.phonetics, char_bounds)

    out: list[LineDTO] = []
    for j in range(len(bounds) - 1):
        part = LineDTO(
            id=line.id if j == 0 else _new_line_id(),
            tokens=[t.model_copy(deep=True) for t in line.tokens[bounds[j] : bounds[j + 1]]],
            ruby=ruby_buckets[j],
            phonetics=ph_buckets[j],
            voice_part=line.voice_part,
            slot=(line.slot + j) % 2,
            is_metadata=line.is_metadata,
            locked=True,
        )
        _rederive_phonetics(part, materialized=bool(line.phonetics))
        out.append(part)
    return out, dropped_ruby, dropped_ph


# ---- 平移（三级调轴） ----


def shift(
    project: ProjectDTO,
    *,
    scope: Literal["global", "line", "token"],
    delta_ms: int,
    line_id: str | None = None,
    token_index: int | None = None,
) -> EditOutcome:
    """三级调轴的统一入口：整体 / 单句 / 单词平移。

    **global 改的是 `project.global_offset_ms`，绝不逐个改 token 时间**——
    歌词源的轴对准的是商业发行录音、而我们贴的是 MV 音轨，这个偏差是全局性的，
    存成一个数用户随时能归零重来；一旦摊进每个 token，就再也回不去了。

    line / token 才真的改 token 时间，并把改到的 token 标成手工锁定。
    """
    out = EditOutcome()
    if scope == "global":
        _shift_global(project, delta_ms, out)
    elif scope == "line":
        if line_id is None:
            msg = "scope=line 必须给出 line_id"
            raise EditError(msg)
        _shift_line(project, line_id, delta_ms, out)
    else:
        if line_id is None or token_index is None:
            msg = "scope=token 必须同时给出 line_id 与 token_index"
            raise EditError(msg)
        _shift_token(project, line_id, token_index, delta_ms, out)
    return out


def _shift_global(project: ProjectDTO, delta_ms: int, out: EditOutcome) -> None:
    """整体平移：只动一个数。

    夹紧下界取"最早的 token 起点的相反数"——再往前推第一个字就落到负时间了，
    ASS 里表达不出来。工程尚无 token 时不设限，此时没有任何时间会变负。
    """
    starts = [t.start_ms for ln in project.lines for t in ln.tokens]
    want = project.global_offset_ms + delta_ms
    if starts:
        lower = -min(starts)
        clamped = max(want, lower)
    else:
        clamped = want
    if clamped != want:
        out.warnings.append(
            f"整体平移被夹紧：{want}ms → {clamped}ms（再往前推首个音节会落到负时间）"
        )
    project.global_offset_ms = clamped


def _shift_line(project: ProjectDTO, line_id: str, delta_ms: int, out: EditOutcome) -> None:
    """整句平移：行内所有 token 同量平移，行内相对关系天然保持。"""
    _, line = _find_line(project, line_id)
    if not line.tokens:
        out.warnings.append(f"行 {line_id} 没有音节，平移无效果")
        return
    lower_delta = -min(t.start_ms for t in line.tokens)
    eff = max(delta_ms, lower_delta)
    if eff != delta_ms:
        out.warnings.append(
            f"行 {line_id} 的平移被夹紧：{delta_ms}ms → {eff}ms（首个音节不能早于 0）"
        )
    for tok in line.tokens:
        tok.start_ms += eff
        _mark_timing_manual(tok)


def _shift_token(
    project: ProjectDTO, line_id: str, token_index: int, delta_ms: int, out: EditOutcome
) -> None:
    """单词平移：移动一个 token，位移由紧邻的 token 用时长吸收。

    改动范围严格限于最多三个 token（见 `_shift_block`），不会一次微调波及全行。
    被牵动的邻居同样标成手工锁定——它们的时间**确实变了**，若不锁，将来重跑
    强制对齐会把它们改回去，用户看到的就是"我调的那一下自己弹回去了"。
    """
    _, line = _find_line(project, line_id)
    if not 0 <= token_index < len(line.tokens):
        msg = f"行 {line_id} 只有 {len(line.tokens)} 个音节，下标 {token_index} 越界"
        raise EditError(msg)
    eff, touched = _shift_block(line.tokens, token_index, delta_ms)
    if eff != delta_ms:
        out.warnings.append(
            f"行 {line_id} 第 {token_index} 个音节的平移被夹紧："
            f"{delta_ms}ms → {eff}ms（相邻音节已压到最短，再让就会倒挂）"
        )
    for i in touched:
        _mark_timing_manual(line.tokens[i])


# ---- 精确设定时间 ----


def set_timing(
    project: ProjectDTO,
    *,
    line_id: str,
    token_index: int,
    start_ms: int | None = None,
    dur_ms: int | None = None,
) -> EditOutcome:
    """设定某个 token 的起点和/或时长（波形上拖边界、数字框直接输入）。

    **这是"拖边界"而不是"移动块"**：只给 `start_ms` 时终点不动（本 token 变长
    或变短），只给 `dur_ms` 时起点不动。共享边界的邻居用时长补偿，边界仍然
    是同一个值（§4.2）。想整块搬走请用 `shift(scope="token")`。
    """
    out = EditOutcome()
    _, line = _find_line(project, line_id)
    if not 0 <= token_index < len(line.tokens):
        msg = f"行 {line_id} 只有 {len(line.tokens)} 个音节，下标 {token_index} 越界"
        raise EditError(msg)
    if start_ms is None and dur_ms is None:
        msg = "start_ms 与 dur_ms 至少要给出一个"
        raise EditError(msg)

    touched: set[int] = {token_index}
    if start_ms is not None:
        val, hit = _set_leading_edge(line.tokens, token_index, start_ms)
        touched |= hit
        if val != start_ms:
            out.warnings.append(
                f"行 {line_id} 第 {token_index} 个音节的起点被夹紧：{start_ms}ms → {val}ms"
            )
    if dur_ms is not None:
        want_end = line.tokens[token_index].start_ms + dur_ms
        val, hit = _set_trailing_edge(line.tokens, token_index, want_end)
        touched |= hit
        if val != want_end:
            actual = line.tokens[token_index].dur_ms
            out.warnings.append(
                f"行 {line_id} 第 {token_index} 个音节的时长被夹紧：{dur_ms}ms → {actual}ms"
            )

    for i in touched:
        _mark_timing_manual(line.tokens[i])
    return out


def set_timings(project: ProjectDTO, *, items: Sequence[TimingItem]) -> EditOutcome:
    """批量设定音节时间。**整批是一次编辑**，路由层把它包成一个撤销单元。

    tap-to-time 打完一首歌是几百个音节，边界联动拖一次是两个音节。逐个调
    `set_timing` 会把一次用户操作摊成 N 步撤销，用户想撤回"刚才那一下"
    得按住 Ctrl+Z 不放——CLAUDE.md §8 把"重跑对齐是一个 undo 单元而不是 N 个"
    写成硬要求，正是这个道理。

    **任何一项寻址不成立就整批失败**（异常抛给 `store.mutate()`，它不会写历史
    也不会落盘）。半批生效比整批失败糟得多：用户看到的是一条被改了一半的轴，
    而撤销栈里没有对应的那一格可以退回去。
    """
    out = EditOutcome()
    if not items:
        msg = "批量调轴的 items 为空"
        raise EditError(msg)

    for i, item in enumerate(items):
        try:
            sub = set_timing(
                project,
                line_id=item.line_id,
                token_index=item.token_index,
                start_ms=item.start_ms,
                dur_ms=item.dur_ms,
            )
        except EditError as exc:
            msg = f"批量调轴第 {i} 项（行 {item.line_id} 第 {item.token_index} 个音节）不成立：{exc}"
            raise EditError(msg) from exc
        out.warnings.extend(sub.warnings)
    return out


# ---- 锁定 ----


def set_locks(project: ProjectDTO, *, items: Sequence[LockItem]) -> EditOutcome:
    """批量设置/清除锁定：音节的 `locked_timing`、注音的 `locked`、发音形的 `locked`。

    §4.4 的 `(value, source, locked)` 只有在用户**能自己动 locked** 时才成立。
    否则锁标记全由自动流程产生，用户看得到锁却钉不住自己的判断，
    重跑一次对齐就把他确认过的边界改回去了。

    **只改锁标记，绝不顺手把 `source` 标成 `manual`**：值没变，来源就没变。
    把歌词源给的时间标成手工是伪造来源，会让 §7.4「用颜色区分 source」
    这条可见反馈失去依据——用户再也分不清哪些数字是机器猜的。
    """
    out = EditOutcome()
    if not items:
        msg = "批量锁定的 items 为空"
        raise EditError(msg)

    for i, item in enumerate(items):
        _, line = _find_line(project, item.line_id)
        if item.target == "timing":
            _lock_timing(line, item, i)
        elif item.target == "ruby":
            _lock_ruby(line, item, i)
        else:
            _lock_phonetic(line, item, i)
    return out


def _lock_timing(line: LineDTO, item: LockItem, i: int) -> None:
    if item.token_index is None:
        msg = f"批量锁定第 {i} 项：target=timing 必须给出 token_index"
        raise EditError(msg)
    if not 0 <= item.token_index < len(line.tokens):
        msg = (
            f"批量锁定第 {i} 项：行 {item.line_id} 只有 {len(line.tokens)} 个音节，"
            f"下标 {item.token_index} 越界"
        )
        raise EditError(msg)
    line.tokens[item.token_index].locked_timing = item.locked


def _lock_ruby(line: LineDTO, item: LockItem, i: int) -> None:
    """锁定/解锁一段注音。区间必须与已有注音**完全一致**。

    不做"包含即命中"的模糊匹配：注音区间彼此不重叠，模糊匹配在相邻两段之间
    没有确定答案，锁错一段比锁不上更难被发现。
    """
    if item.ruby_range is None:
        msg = f"批量锁定第 {i} 项：target=ruby 必须给出 ruby_range"
        raise EditError(msg)
    lo, hi = item.ruby_range
    for sp in line.ruby:
        if (sp.start, sp.end) == (lo, hi):
            sp.locked = item.locked
            return
    existing = "、".join(f"{sp.start}-{sp.end}" for sp in line.ruby) or "（无）"
    msg = (
        f"批量锁定第 {i} 项：行 {item.line_id} 上没有字符区间 {lo}-{hi} 的注音，"
        f"现有区间为 {existing}"
    )
    raise EditError(msg)


def _lock_phonetic(line: LineDTO, item: LockItem, i: int) -> None:
    """锁定/解锁一段发音形。区间必须与已有发音形**完全一致**，理由同 `_lock_ruby`。

    锁上之后，`derive_phonetics` 与将来的 G2P 重算都必须绕开它——这是用户
    "我已经确认过这段读音"的唯一表达方式。
    """
    if item.phonetic_range is None:
        msg = f"批量锁定第 {i} 项：target=phonetic 必须给出 phonetic_range"
        raise EditError(msg)
    lo, hi = item.phonetic_range
    for sp in line.phonetics:
        if (sp.start, sp.end) == (lo, hi):
            sp.locked = item.locked
            return
    existing = "、".join(f"{sp.start}-{sp.end}" for sp in line.phonetics) or "（无）"
    msg = (
        f"批量锁定第 {i} 项：行 {item.line_id} 上没有字符区间 {lo}-{hi} 的发音形，"
        f"现有区间为 {existing}"
    )
    raise EditError(msg)


# ---- 注音 ----


def set_ruby(
    project: ProjectDTO, *, line_id: str, start: int, end: int, text: str
) -> EditOutcome:
    """给行内字符区间 `[start, end)` 设定注音；`text` 为空表示清除该区间的注音。

    注音区间之间**不得重叠**（§4.2 不变式：ruby span 与假名字符无缝无重叠地
    覆盖整个 surface），所以新区间会先吃掉所有与之相交的旧区间。被吃掉的旧区间
    里若有用户锁定过的，会回报——那是他之前的劳动成果。
    """
    out = EditOutcome()
    _, line = _find_line(project, line_id)
    surface = _line_text(line)
    if not surface:
        msg = f"行 {line_id} 没有文本，无法标注注音"
        raise EditError(msg)
    materialized = bool(line.phonetics)

    lo = min(max(start, 0), len(surface))
    hi = min(max(end, 0), len(surface))
    if lo != start or hi != end:
        out.warnings.append(
            f"注音区间被夹进行内范围：{start}-{end} → {lo}-{hi}（行长 {len(surface)}）"
        )
    if lo >= hi:
        msg = f"注音区间为空：{lo}-{hi}"
        raise EditError(msg)

    kept: list[RubySpanDTO] = []
    for sp in line.ruby:
        if sp.start < hi and sp.end > lo:
            if sp.locked and (sp.start, sp.end) != (lo, hi):
                # 用户锁过的注音被一个更大的新区间吃掉了：他之前的判断没保住，
                # 而这一步在界面上只表现为"注音变了"，不留痕迹就等于静默丢弃
                _add_orphan(
                    project,
                    out,
                    kind="ruby",
                    detail=(
                        f"「{surface[sp.start : sp.end]}」上你锁定过的注音「{sp.text}」"
                        f"被新注音「{text}」覆盖（新区间 {lo}-{hi} 与它相交）"
                    ),
                    payload={
                        "line_id": line_id,
                        "start": sp.start,
                        "end": sp.end,
                        "text": sp.text,
                        "source": sp.source,
                        "locked": True,
                        "base": surface[sp.start : sp.end],
                    },
                )
            continue
        kept.append(sp)

    if text:
        kept.append(
            RubySpanDTO(
                start=lo,
                end=hi,
                text=text,
                source=ReadingSource.MANUAL.value,
                locked=True,
            )
        )
    kept.sort(key=lambda sp: (sp.start, sp.end))
    line.ruby = kept

    # 表记读法一变，由它推出来的发音形立刻过期。不跟着刷新，界面上就会出现
    # 「注音改成 さだめ、发音形还写着 ウンメイ」这种自相矛盾的状态
    if materialized:
        stats = _derive_span_range(line, lo, hi)
        if stats.kept_locked:
            out.warnings.append(
                f"该区间上有 {stats.kept_locked} 段发音形是你锁定过的，未随注音更新；"
                "要让它跟着走请先解锁"
            )
    return out


# ---- 发音形（喂强制对齐的那一份读音） ----


def set_phonetic(
    project: ProjectDTO, *, line_id: str, start: int, end: int, text: str
) -> EditOutcome:
    """设定字符区间 `[start, end)` 的发音形；`text` 为空表示清除手工覆盖。

    §4.2 要求两份读音同时存在：注音行显示「は」，喂强制对齐的必须是 ワ。
    手填的发音形一律标 `manual` + `locked`——用户填它就是为了纠正自动推导，
    不锁住的话下一次推导原样把它换回去。

    清除时不是简单删掉，而是**就地重新推导**：用户的意思是"这里交还给自动"，
    留一个空洞会让界面显示"缺发音形"，看起来像坏了。推不出来才真的留空。

    发音形区间之间不得重叠（与注音同一条不变式），所以新区间会先吃掉与之相交的
    旧区间；其中锁定过的会进失效修正清单。
    """
    out = EditOutcome()
    _, line = _find_line(project, line_id)
    surface = _line_text(line)
    if not surface:
        msg = f"行 {line_id} 没有文本，无法标注发音形"
        raise EditError(msg)

    lo = min(max(start, 0), len(surface))
    hi = min(max(end, 0), len(surface))
    if lo != start or hi != end:
        out.warnings.append(
            f"发音形区间被夹进行内范围：{start}-{end} → {lo}-{hi}（行长 {len(surface)}）"
        )
    if lo >= hi:
        msg = f"发音形区间为空：{lo}-{hi}"
        raise EditError(msg)

    value = to_katakana(text.strip())
    if not value:
        _clear_phonetic(line, lo, hi, surface, out)
        return out

    kept: list[PhoneticSpanDTO] = []
    for sp in line.phonetics:
        if _intersects(sp.start, sp.end, lo, hi):
            if sp.locked and (sp.start, sp.end) != (lo, hi):
                _add_orphan(
                    project,
                    out,
                    kind="phonetic",
                    detail=(
                        f"「{surface[sp.start : sp.end]}」上你锁定过的发音形「{sp.text}」"
                        f"被新的发音形「{value}」覆盖（新区间 {lo}-{hi} 与它相交）"
                    ),
                    payload={
                        "line_id": line_id,
                        "start": sp.start,
                        "end": sp.end,
                        "text": sp.text,
                        "source": sp.source,
                        "locked": True,
                        "base": surface[sp.start : sp.end],
                    },
                )
            continue
        kept.append(sp)

    kept.append(
        PhoneticSpanDTO(
            start=lo,
            end=hi,
            text=value,
            source=ReadingSource.MANUAL.value,
            locked=True,
        )
    )
    kept.sort(key=lambda sp: (sp.start, sp.end))
    line.phonetics = kept

    if not is_kana_text(value):
        # 不拒绝——用户可能真有理由这么填（外来语、拟声词的特殊写法）。
        # 但强制对齐的 vocab 是假名，非假名字符到那一步会被丢掉，得让他现在就知道
        out.warnings.append(
            f"发音形「{value}」含非假名字符；强制对齐只认假名，这一段可能对不上"
        )
    return out


def _clear_phonetic(
    line: LineDTO, lo: int, hi: int, surface: str, out: EditOutcome
) -> None:
    """清除 `[lo, hi)` 上的发音形覆盖，并把这一段交还给自动推导。

    连锁定的一起删：清除是用户对自己那条覆盖的明确撤回，此时还拦着他反而怪。
    """
    before = len(line.phonetics)
    line.phonetics = [
        sp for sp in line.phonetics if not _intersects(sp.start, sp.end, lo, hi)
    ]
    removed = before - len(line.phonetics)
    stats = _derive_span_range(line, lo, hi)
    now = [sp.text for sp in line.phonetics if _intersects(sp.start, sp.end, lo, hi)]
    base = surface[lo:hi]
    if now:
        out.warnings.append(f"「{base}」的发音形已回到推导值「{''.join(now)}」")
    elif removed or stats.undetermined:
        out.warnings.append(f"「{base}」的发音形已清空；这一段推导不出来，需要手工填")


def derive_phonetics(
    project: ProjectDTO, *, line_ids: Sequence[str] | None = None
) -> EditOutcome:
    """由表记读法批量推导发音形。**只覆盖 `locked=False` 的项**（§4.4）。

    这是"发音形层"的物化入口：导入歌词后跑一遍，注音改过之后再跑一遍。
    推导规则只做确定的部分（片假名规范化 + 整词助词 は/へ/を），长音与「ん」的
    音位变体一律不猜——那取决于 `pyopenjtalk.g2p` 那项待实测（CLAUDE.md §9 第 7 项），
    猜错会把整句轴带偏，比留空更糟。见 `models.karaoke.derive_phonetic`。
    """
    out = EditOutcome()
    if line_ids is None:
        targets = list(project.lines)
    else:
        targets = [_find_line(project, lid)[1] for lid in line_ids]

    total = _DeriveStats()
    for line in targets:
        total.merge(_derive_span_range(line, 0, len(_line_text(line))))

    if total.kept_locked:
        out.warnings.append(f"{total.kept_locked} 段发音形已锁定，本次未改动（这是设计如此）")
    if total.undetermined:
        out.warnings.append(
            f"{total.undetermined} 处推导不出发音形（未注音的汉字或拉丁词），需要手工填"
        )
    return out


# ---- 制作名单标记 ----


def set_metadata(project: ProjectDTO, *, line_id: str, is_metadata: bool) -> EditOutcome:
    """把一行标记/取消标记为制作名单（词/曲/编曲/制作人……）。

    导入时的自动判定是条启发式（时间早于首句人声 **且** 文本形如 `词：xxx`），
    必然有误判：前奏里真唱的歌词、含 ` - ` 的歌名式歌词会被误伤；歌词源换个写法
    又会漏判，而漏判的后果是视频开头闪出五行像乱码一样的名单（§6.1）。
    §2.5 要求每个自动环节都有等价的手工旁路，这就是那条。

    连带把 `line.locked` 置真。本模型的行级锁是**单一标记**，因此这也顺手挡住了
    自动分行/段落归属——这是有意的保守选择：用户既然亲手判过这行是不是名单，
    自动分行把它拆开同样违背他的意图。
    """
    out = EditOutcome()
    _, line = _find_line(project, line_id)
    label = _preview_text(_line_text(line))

    if line.is_metadata == is_metadata:
        kind = "制作名单" if is_metadata else "正文歌词"
        out.warnings.append(f"「{label}」本来就是{kind}，本次没有变化")
        return out

    line.is_metadata = is_metadata
    line.locked = True
    if is_metadata:
        out.warnings.append(f"「{label}」不再作为歌词排版，改为并入制作名单屏")
    else:
        out.warnings.append(f"「{label}」将作为正文歌词参与排版与调轴")
    return out


def _preview_text(text: str, limit: int = 12) -> str:
    """给用户看的行文本摘要。整行贴进提示会把一条警告撑成两行。"""
    return text if len(text) <= limit else text[:limit] + "…"


# ---- 拆行 / 并行 ----


def split_line(project: ProjectDTO, *, line_id: str, token_index: int) -> EditOutcome:
    """在第 `token_index` 个 token 之前把一行拆成两行。

    token 时间原样保留（拆行改的是版面归属，不是轴）。注音索引按前半段字符数
    整体前移；跨拆分点的注音无处安放，丢弃并回报。
    """
    out = EditOutcome()
    idx, line = _find_line(project, line_id)
    n = len(line.tokens)
    if n < 2:
        msg = f"行 {line_id} 只有 {n} 个音节，无法拆分"
        raise EditError(msg)
    if not 0 < token_index < n:
        msg = f"拆分点必须落在 1..{n - 1}，收到 {token_index}"
        raise EditError(msg)

    surface = _line_text(line)
    parts, dropped_ruby, dropped_ph = _split_tokens(line, [token_index])
    _record_dropped_ruby(project, out, line_id=line_id, surface=surface, spans=dropped_ruby)
    _record_dropped_phonetics(project, out, line_id=line_id, surface=surface, spans=dropped_ph)
    project.lines[idx : idx + 1] = parts
    return out


def merge_line(project: ProjectDTO, *, line_id: str) -> EditOutcome:
    """把本行与**下一行**合并成一行。

    注音索引反向迁移：下一行的区间整体后移前一行的字符数。
    两行时间若有重叠（`Line` 之间本就允许重叠，见 §8.5），把后半段整体后推到
    不倒挂为止并标成手工——合并成一行之后，行内单调是硬约束，宁可推后也不能报错。
    """
    out = EditOutcome()
    idx, line = _find_line(project, line_id)
    if idx + 1 >= len(project.lines):
        msg = f"行 {line_id} 已经是最后一行，没有可合并的下一行"
        raise EditError(msg)
    nxt = project.lines[idx + 1]

    tail = [t.model_copy(deep=True) for t in nxt.tokens]
    if line.tokens and tail:
        last = line.tokens[-1]
        overlap = (last.start_ms + last.dur_ms) - tail[0].start_ms
        if overlap > 0:
            out.warnings.append(
                f"行 {nxt.id} 的起点早于行 {line_id} 的终点，合并后整体后推 {overlap}ms 以免倒挂"
            )
            for tok in tail:
                tok.start_ms += overlap
                _mark_timing_manual(tok)

    head_chars = len(_line_text(line))
    materialized = bool(line.phonetics or nxt.phonetics)
    merged_ruby = [sp.model_copy(deep=True) for sp in line.ruby]
    merged_ruby.extend(
        sp.model_copy(update={"start": sp.start + head_chars, "end": sp.end + head_chars})
        for sp in nxt.ruby
    )
    merged_ruby.sort(key=lambda sp: (sp.start, sp.end))

    merged_ph = [sp.model_copy(deep=True) for sp in line.phonetics]
    merged_ph.extend(
        sp.model_copy(update={"start": sp.start + head_chars, "end": sp.end + head_chars})
        for sp in nxt.phonetics
    )
    merged_ph.sort(key=lambda sp: (sp.start, sp.end))

    if nxt.voice_part != line.voice_part:
        # 模型已有 token 级声部，被合并行的声部**下沉到它自己的音节上**即可完整保留。
        # 从前这里只能整行统一、把声部丢掉并回报，那才是真正的损失；
        # 现在数据没丢，就不该往「失效修正」清单里塞东西——清单只装真的没保住的东西，
        # 掺进"其实已经处理好了"的条目会让用户学会无视整张清单。
        for tok in tail:
            if tok.voice_part is None:
                tok.voice_part = nxt.voice_part
                tok.locked_voice = True
        out.warnings.append(
            f"被合并行 {nxt.id} 的声部「{nxt.voice_part}」已下沉到音节级："
            f"合并后这段仍按原声部着色，整行声部为「{line.voice_part}」"
        )

    line.tokens.extend(tail)
    line.ruby = merged_ruby
    line.phonetics = merged_ph
    line.is_metadata = line.is_metadata and nxt.is_metadata
    line.locked = True
    del project.lines[idx + 1]

    # 接缝处的读音单元会重新划分（前一行末尾的假名与后一行开头的假名并成一串，
    # 独立的助词就不再独立了），所以合并完必须重推一次，锁定的照旧不动
    _rederive_phonetics(line, materialized=materialized)
    return out


# ---- 声部 ----


def set_voice_part(
    project: ProjectDTO,
    *,
    line_id: str,
    voice_part: str,
    token_range: tuple[int, int] | None = None,
) -> EditOutcome:
    """指派声部。给出 `token_range` 时只作用于该 token 区间 `[start, end)`。

    **区间指派直接写 `TokenDTO.voice_part`，不拆行。** 从前这里是拿拆行近似的
    （模型上没有 token 级声部字段），代价是「A: 君の / B: 声が / 合: 聞こえる」
    这类句子被拆成三行、各占一个槽位——屏幕上看起来是三句话而不是一句对唱，
    这恰恰是对唱最要紧的观感。模型补上字段后必须走真路径。

    `voice_part` 传空串表示**清除**区间内的 token 级覆盖，让这些音节回到继承
    行声部——用户指派错了总得有路撤回，而"再指派一次行声部"并不能清掉覆盖。
    整行指派（`token_range=None`）不接受空串：一行总得有个声部。
    """
    out = EditOutcome()
    _, line = _find_line(project, line_id)
    n = len(line.tokens)

    if token_range is None or n == 0:
        return _set_line_voice_part(line, line_id, voice_part, out)

    raw_start, raw_end = token_range
    start = min(max(raw_start, 0), n)
    end = min(max(raw_end, 0), n)
    if (start, end) != (raw_start, raw_end):
        out.warnings.append(
            f"声部区间被夹进行内范围：{raw_start}-{raw_end} → {start}-{end}（共 {n} 个音节）"
        )
    if start >= end:
        msg = f"声部区间为空：{start}-{end}"
        raise EditError(msg)

    if (start, end) == (0, n) and voice_part:
        # 选中整行等于行级指派。写成行属性比给每个音节各挂一份覆盖更好懂，
        # 也让后续"整行换声部"只需要改一个地方
        cleared = sum(1 for t in line.tokens if t.voice_part is not None)
        for tok in line.tokens:
            tok.voice_part = None
            tok.locked_voice = False
        if cleared:
            out.warnings.append(
                f"行 {line_id} 内原有 {cleared} 个音节的单独声部已被这次整行指派清除"
            )
        return _set_line_voice_part(line, line_id, voice_part, out)

    for tok in line.tokens[start:end]:
        tok.voice_part = voice_part or None
        tok.locked_voice = bool(voice_part)
    return out


def _set_line_voice_part(
    line: LineDTO, line_id: str, voice_part: str, out: EditOutcome
) -> EditOutcome:
    """整行指派声部，并提醒行内仍存在的 token 级覆盖。

    覆盖优先级高于行，所以整行指派之后那几个音节颜色不变。不提醒的话用户会以为
    功能坏了，而正确的做法（对这些音节指派空声部以清除覆盖）他猜不到。
    """
    if not voice_part:
        msg = "整行声部不能为空；要清除音节级覆盖请给出 token_range"
        raise EditError(msg)
    line.voice_part = voice_part
    line.locked = True
    overridden = sum(1 for t in line.tokens if t.voice_part is not None)
    if overridden:
        out.warnings.append(
            f"行 {line_id} 内有 {overridden} 个音节设了单独声部，仍按各自的设置着色；"
            "要让整行统一，请选中它们并指派空声部以清除覆盖"
        )
    return out


# ---- 配色模板（跨工程的全局资源） ----


def default_templates_path() -> Path:
    """用户配色模板的落盘位置。

    与工程目录**同级**而不是放在里面：模板是跨工程资产，塞进某个工程目录里，
    删掉那个工程就把用户攒的全部配色一起删了。
    """
    return default_root().parent / "palettes.json"


def _palette(
    name: str, unsung_fill: str, unsung_outline: str, sung_fill: str, sung_outline: str
) -> PaletteDTO:
    """一个声部的四色。

    四个而不是一个：描边跟着填充一起翻色（双层 clip 方案），未唱层与已唱层
    各需一组填充/描边。颜色是 ASS 的 `&HAABBGGRR&`，**BGR 序，与直觉的 RGB 相反**。
    """
    return PaletteDTO(
        name=name,
        unsung_fill=unsung_fill,
        unsung_outline=unsung_outline,
        sung_fill=sung_fill,
        sung_outline=sung_outline,
    )


def builtin_palette_templates() -> list[PaletteTemplate]:
    """内置配色模板。每次调用都重新构造，调用方改坏了也污染不到下一次。

    每套都给齐 `main` / `duet_a` / `duet_b` / `chorus` 四个声部——只给 main
    的话用户一碰对唱就得自己配色，模板也就白给了。未唱色在同一套模板内保持一致，
    只有已唱色分声部，这样同屏两个声部在唱之前看起来是同一首歌的歌词。
    """
    return [
        PaletteTemplate(
            name="NicoKara 经典白蓝",
            description="未唱白字近黑描边，已唱亮蓝配深蓝描边。同人 nicokara 的常见配色，默认起点。",
            builtin=True,
            palettes={
                "main": _palette("main", "&H00FFFFFF&", "&H00202020&", "&H00FF9010&", "&H00501800&"),
                "duet_a": _palette(
                    "duet_a", "&H00FFFFFF&", "&H00202020&", "&H00FF9010&", "&H00501800&"
                ),
                "duet_b": _palette(
                    "duet_b", "&H00FFFFFF&", "&H00202020&", "&H00B060FF&", "&H00320A50&"
                ),
                "chorus": _palette(
                    "chorus", "&H00FFFFFF&", "&H00202020&", "&H0028C8FF&", "&H00003048&"
                ),
            },
        ),
        PaletteTemplate(
            name="高对比黄黑",
            description="纯黑描边配高亮度填充。投影、老电视、弱视场景下压在任何画面上都读得出。",
            builtin=True,
            palettes={
                "main": _palette("main", "&H00FFFFFF&", "&H00000000&", "&H0000DDFF&", "&H00000000&"),
                "duet_a": _palette(
                    "duet_a", "&H00FFFFFF&", "&H00000000&", "&H0000DDFF&", "&H00000000&"
                ),
                "duet_b": _palette(
                    "duet_b", "&H00FFFFFF&", "&H00000000&", "&H00FFFF00&", "&H00000000&"
                ),
                "chorus": _palette(
                    "chorus", "&H00FFFFFF&", "&H00000000&", "&H0000FF00&", "&H00000000&"
                ),
            },
        ),
        PaletteTemplate(
            name="柔和粉白",
            description="米白配灰紫描边，已唱转粉。适合暖色调 MV，不与画面抢眼。",
            builtin=True,
            palettes={
                "main": _palette("main", "&H00F5F5FA&", "&H005A465A&", "&H00BE96FF&", "&H00461E78&"),
                "duet_a": _palette(
                    "duet_a", "&H00F5F5FA&", "&H005A465A&", "&H00BE96FF&", "&H00461E78&"
                ),
                "duet_b": _palette(
                    "duet_b", "&H00F5F5FA&", "&H005A465A&", "&H00FF96BE&", "&H006E1E3C&"
                ),
                "chorus": _palette(
                    "chorus", "&H00F5F5FA&", "&H005A465A&", "&H0096D7FF&", "&H0014506E&"
                ),
            },
        ),
    ]


def _read_user_templates(path: Path) -> list[PaletteTemplate]:
    """读用户模板。文件不存在或读不动时当作"还没存过模板"。

    损坏时降级而不是抛错：配色是锦上添花的功能，不该因为一个坏文件让整个样式
    面板打不开（§2.5：失败要降级、不能终止）。但**必须留下日志**——静默吞掉
    之后用户会以为模板凭空消失了，而没有任何线索可查。
    """
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        items = raw["templates"] if isinstance(raw, dict) else raw
        out = [PaletteTemplate.model_validate(it) for it in items]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        _log.warning("配色模板文件无法解析，已忽略全部用户模板：%s（%s）", path, exc)
        return []
    for tpl in out:
        tpl.builtin = False
    return out


def _write_templates(path: Path, templates: Sequence[PaletteTemplate]) -> None:
    """原子写盘：先写临时文件，再 rename 顶替。

    理由与 `api/store.py` 相同——直接覆盖写若在中途崩溃会留下半截 JSON，
    而半截文件比没有文件更糟：用户以为模板还在，打开才发现全毁。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        # 内置标记不落盘：它由代码决定，存进文件只会在改版后与代码打架
        "templates": [tpl.model_dump(exclude={"builtin"}) for tpl in templates],
    }
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp"
    ) as fh:
        fh.write(json.dumps(payload, ensure_ascii=False, indent=2))
        tmp = Path(fh.name)
    tmp.replace(path)


def load_palette_templates(path: Path | None = None) -> list[PaletteTemplate]:
    """内置模板 + 用户模板。内置在前，用户模板按名称排序。

    同名时内置优先——保存接口本来就拒绝占用内置名，这里只是防住手改文件的情况。
    """
    target = path or default_templates_path()
    builtin = builtin_palette_templates()
    reserved = {tpl.name for tpl in builtin}
    user = sorted(_read_user_templates(target), key=lambda tpl: tpl.name)
    return [*builtin, *(tpl for tpl in user if tpl.name not in reserved)]


def save_palette_template(
    name: str,
    palettes: dict[str, PaletteDTO],
    *,
    description: str = "",
    path: Path | None = None,
) -> PaletteTemplate:
    """保存/覆盖一个用户模板。同名的用户模板直接覆盖（"另存"就是这个意思）。"""
    clean = name.strip()
    if not clean:
        msg = "模板名不能为空"
        raise EditError(msg)
    if len(clean) > 64:
        msg = f"模板名过长（{len(clean)} 字），上限 64 字"
        raise EditError(msg)
    if "/" in clean:
        # 模板名是 DELETE /api/palettes/templates/{name} 的路径段，带斜杠就再也删不掉了
        msg = f"模板名不能包含斜杠：{clean}"
        raise EditError(msg)
    if clean in {tpl.name for tpl in builtin_palette_templates()}:
        msg = f"「{clean}」是内置模板，不能覆盖；请换一个名字"
        raise EditError(msg)
    if not palettes:
        msg = "模板至少要包含一个声部的配色"
        raise EditError(msg)

    target = path or default_templates_path()
    tpl = PaletteTemplate(
        name=clean,
        description=description,
        builtin=False,
        palettes={k: v.model_copy(deep=True) for k, v in palettes.items()},
    )
    kept = [t for t in _read_user_templates(target) if t.name != clean]
    kept.append(tpl)
    kept.sort(key=lambda t: t.name)
    _write_templates(target, kept)
    return tpl


def delete_palette_template(name: str, *, path: Path | None = None) -> None:
    """删除一个用户模板。内置模板不可删——删了就再也拿不回来了。

    模板不存在时抛 `KeyError`，与 `ProjectStore.get` 保持一致，路由层转 404。
    """
    if name in {tpl.name for tpl in builtin_palette_templates()}:
        msg = f"「{name}」是内置模板，不可删除"
        raise EditError(msg)
    target = path or default_templates_path()
    users = _read_user_templates(target)
    kept = [tpl for tpl in users if tpl.name != name]
    if len(kept) == len(users):
        msg = f"配色模板不存在：{name}"
        raise KeyError(msg)
    _write_templates(target, kept)
