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

import difflib
import json
import logging
import tempfile
import uuid
from collections import Counter
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


# ---- 改行文本 ----
#
# 这是 §2.5「每个自动环节都必须有等价的手工旁路」里此前唯一空着的一档：歌词文本
# 本身。歌词源认错版本、送假名写法不同、当て字被写成别的字——这些都不是罕见情况，
# 而在此之前唯一的改法是把整首歌重新粘贴一遍（连带丢掉全部手工成果）。
#
# 难点不在于换字符串，而在于 **token 是计时单元**：改一个字会让 token 边界变化，
# 它的时间、注音、发音形、各种 locked 标记必须跟过去。这与"重新导入歌词"是同一个
# 问题的单行版本，所以下面全程复用那一套（`_build_geometry` / `_map_tokens` /
# `_map_local_span` / `_place_span`），不另写一套重绑逻辑。
#
# §4.4 的两条纪律照旧：行内落点以 tid 为主、字符偏移兜底且要求**严格重合**，
# 差一个字就宁可不绑；绑不上的手工修改一律进「失效修正」清单，绝不静默丢弃。
# （改文本这一步 tid 帮不上忙——行文本一变，该行全部 tid 就都变了，
# 所以这里直接走字符偏移那条兜底，见 `_map_tokens` 的说明。）


_UNSET_TIMING = "unset"
"""「从未定过时」。`TimingSource` 枚举里没有这一档（它描述的是"时间从哪来"，
而这一档的含义是"还没有时间"），DTO 侧一直用的就是这个字面量。"""

_LINE_GRANULARITY = "line"
"""时间的权威粒度只到行级。纯文本导入的行就是这一档（见 `lyrics.importer.parse_text`）。"""


def _is_ascii_word_char(ch: str) -> bool:
    return ch.isascii() and (ch.isalnum() or ch in "'’-")


def _split_units(text: str) -> list[str]:
    """把一段新输入切成 token：逐字一个，但**连续的 ASCII 词整块成词**。

    CLAUDE.md §6.2：日语歌词里的英文段落不能按字符切 `\\k`，`sumika` 逐字母
    扫光是滑稽的，歌词源给出来的也是整块。
    """
    units: list[str] = []
    buf = ""
    for ch in text:
        if _is_ascii_word_char(ch):
            buf += ch
            continue
        if buf:
            units.append(buf)
            buf = ""
        units.append(ch)
    if buf:
        units.append(buf)
    return units


def _retokenize(old_line: LineDTO, new_text: str) -> list[str]:
    """新行的 token 切分：**改动之外的地方一律沿用老边界**。

    这是"改一个字、其余全都保住"的前提。`_map_tokens` 要求映射后的字符区间与
    某个新 token **严格重合**才肯绑（§4.4：差一个字宁可不绑），所以边界只要
    整体重切一遍，整行的时间与声部就会全部绑不上——明明只改了一个字。

    改动区域没有老边界可依，按逐字（ASCII 词整块）切；整行只有一个 token 的
    （纯文本导入的行）保持整行一个 token，不要替用户擅自切成逐字。
    """
    old_text = _line_text(old_line)
    if len(old_line.tokens) <= 1:
        # 整行装在一个 token 里（纯文本 / LRC 导入的行，权威粒度只到行级）：
        # 保持整行一个 token。替用户擅自切成逐字等于凭空宣称有了逐字权威。
        return [new_text]
    starts = set(_token_char_offsets(old_line))
    matcher = difflib.SequenceMatcher(a=old_text, b=new_text, autojunk=False)

    pieces: list[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "delete":
            continue
        chunk = new_text[j1:j2]
        if not chunk:
            continue
        if tag != "equal":
            pieces.extend(_split_units(chunk))
            continue
        cut = 0
        for k in range(1, i2 - i1):
            if i1 + k in starts:
                pieces.append(chunk[cut:k])
                cut = k
        pieces.append(chunk[cut:])
    return [p for p in pieces if p]


def _carry_edited_token(old: TokenDTO, new: TokenDTO) -> None:
    """把老 token 的全部时间与声部搬到文本未变的新 token 上。

    与重新导入时的 `_carry_token` 有一处关键不同：**连没锁的时间也搬**。
    重新导入带来了歌词源自己的逐字轴，没锁的旧值本就该被新值覆盖；而改文本
    不产生任何新时间，此处没有"新值"可言，只搬锁定项等于把用户已经打好的轴
    清成一片未打轴。

    `tid` 一并搬过来：tid 只在导入那一刻生成一次（见 `lyrics.importer._assign_tids`），
    此后拆行/并行都是搬运既有 token，改文本对未变的字也应当如此，
    将来重新导入歌词时它们才仍有主键可依。
    """
    new.start_ms = old.start_ms
    new.dur_ms = old.dur_ms
    new.timing_source = old.timing_source
    new.timing_granularity = old.timing_granularity
    new.locked_timing = old.locked_timing
    new.voice_part = old.voice_part
    new.locked_voice = old.locked_voice
    new.tid = old.tid


def _fill_unbound_timing(
    line: LineDTO, *, bound: set[int], window: tuple[int, int] | None, out: EditOutcome
) -> int:
    """给新打进去的字补时间：在两侧已绑音节之间等分。

    标 `interpolated` 而不是别的（§4.2）：这个字从来没被实测过，标成
    provider/aligned 就是伪造粒度，界面上"哪些数字可信"这条反馈会随之失效；
    标成 manual 更糟——用户并没有确认过这个时间。整行原本就没打过轴时
    （`window is None`）保持 `unset`，那是"从未定过时"，与"算出来的"不是一回事。

    没有空位时（前后都被锁死、且首尾相接）宁可挤在一起并回报，也不动锁定值：
    §4.4 的底线是自动逻辑绝不覆盖用户锁定的项。
    """
    n = len(line.tokens)
    free = [i for i in range(n) if i not in bound]
    if not free or window is None:
        return 0

    filled = 0
    tight = 0
    i = 0
    while i < n:
        if i in bound:
            i += 1
            continue
        j = i
        while j < n and j not in bound:
            j += 1
        run = list(range(i, j))
        prev = line.tokens[i - 1] if i > 0 else None
        nxt = line.tokens[j] if j < n else None
        lo = prev.start_ms + prev.dur_ms if prev is not None else window[0]
        hi = nxt.start_ms if nxt is not None else window[1]
        need = len(run) * MIN_DUR_MS

        # 纯插入（老文本里没有对应的字被删掉）时前后是首尾相接的，空位为 0，
        # 只能从没锁的邻居那里借一点时长出来
        if hi - lo < need and prev is not None and not prev.locked_timing:
            take = min(need - (hi - lo), max(0, prev.dur_ms - MIN_DUR_MS))
            prev.dur_ms -= take
            lo -= take
        if hi - lo < need and nxt is not None and not nxt.locked_timing:
            take = min(need - (hi - lo), max(0, nxt.dur_ms - MIN_DUR_MS))
            nxt.start_ms += take
            nxt.dur_ms -= take
            hi += take

        lo = max(0, lo)
        span = hi - lo
        if span < need:
            tight += len(run)
            span = need
        for k, ti in enumerate(run):
            tok = line.tokens[ti]
            start = lo + span * k // len(run)
            end = lo + span * (k + 1) // len(run)
            tok.start_ms = start
            tok.dur_ms = max(MIN_DUR_MS, end - start)
            tok.timing_source = TimingSource.INTERPOLATED.value
            tok.locked_timing = False
            filled += 1
        i = j

    if tight:
        out.warnings.append(
            f"{tight} 个新增音节两侧都被锁定的时间夹住，没有空位，已按最小时长排开，请手工调整"
        )
    return filled


def set_line_text(project: ProjectDTO, *, line_id: str, text: str) -> EditOutcome:
    """改写一行的书写文本，尽最大可能保住这一行上的手工成果。

    行为按改动幅度自然分档，不需要用户选：改一个字时其余音节的时间、注音、
    发音形、声部全部原样跟过来；整行重写时几乎没有东西能对上，那些锁定过的
    修改会进「失效修正」清单——那正是正确结果，不是失败。

    `text` 不允许为空（要删掉一行请与相邻行合并），也不允许含换行
    （一次只改一行；分行是拆行/并行的事，两件事混在一个接口里会让撤销粒度失控）。
    """
    out = EditOutcome()
    idx, old_line = _find_line(project, line_id)

    if "\n" in text or "\r" in text:
        msg = "行文本不能含换行：分行请用拆行"
        raise EditError(msg)
    new_text = text.strip()
    if not new_text:
        msg = "行文本不能为空：要去掉这一行请与相邻行合并"
        raise EditError(msg)

    old_text = _line_text(old_line)
    if new_text == old_text:
        return out

    granularity = (
        old_line.tokens[0].timing_granularity if old_line.tokens else _LINE_GRANULARITY
    )
    unset_line = bool(old_line.tokens) and all(
        t.timing_source == _UNSET_TIMING for t in old_line.tokens
    )
    window: tuple[int, int] | None = None
    if old_line.tokens and not unset_line:
        first, last = old_line.tokens[0], old_line.tokens[-1]
        window = (first.start_ms, last.start_ms + last.dur_ms)

    new_line = old_line.model_copy(
        deep=True,
        update={
            "tokens": [
                TokenDTO(
                    text=piece,
                    start_ms=0,
                    dur_ms=0,
                    timing_source=_UNSET_TIMING,
                    timing_granularity=granularity,
                )
                for piece in _retokenize(old_line, new_text)
            ],
            # 注音与发音形先清空，下面按字符区间逐条搬回来：直接留着会用老下标
            # 指向新文本，「明日」的注音可能落到别的两个字上——绑错比绑不上更糟
            "ruby": [],
            "phonetics": [],
        },
    )

    # 整曲对齐的单行退化：`_build_geometry` 收的就是行序列，传一行进去得到的
    # 正是"这一行改了什么"的字符对应关系，无需另写一份
    geo = _build_geometry([old_line], [new_line])
    # tid 在这里帮不上忙（行文本一变，该行全部 tid 就都变了），直接走字符偏移兜底
    token_map = _map_tokens(old_line, 0, 0, {}, geo, new_line)

    if not token_map and len(old_line.tokens) == 1 and len(new_line.tokens) == 1:
        # 整行一个 token 的行（纯文本 / LRC 导入）：token 就是这一行，它的时间说的是
        # **这一行**什么时候唱，与写了哪几个字无关。改字不该把它降级成插值，
        # 更不该把「尚未打轴」变成「算出来的」。
        token_map = {0: 0}
    for ti, target in token_map.items():
        _carry_edited_token(old_line.tokens[ti], new_line.tokens[target])

    lost_ruby: list[RubySpanDTO] = []
    for sp in old_line.ruby:
        target_span = _map_local_span(geo, 0, 0, sp.start, sp.end)
        if target_span is None:
            lost_ruby.append(sp)
            continue
        new_line.ruby = _place_span(new_line.ruby, sp, target_span)

    lost_phonetics: list[PhoneticSpanDTO] = []
    for sp in old_line.phonetics:
        target_span = _map_local_span(geo, 0, 0, sp.start, sp.end)
        if target_span is None:
            # 没锁的发音形是推导出来的，下面重推一遍就回来了，不算损失
            if sp.locked:
                lost_phonetics.append(sp)
            continue
        new_line.phonetics = _place_span(new_line.phonetics, sp, target_span)

    filled = _fill_unbound_timing(
        new_line, bound=set(token_map.values()), window=window, out=out
    )
    project.lines[idx] = new_line

    # 改过字的地方读音单元会重新划分，锁定的照旧不动（§4.4）
    _rederive_phonetics(new_line, materialized=bool(old_line.phonetics))

    _record_retext_orphans(
        project,
        out,
        line_id=line_id,
        old_text=old_text,
        ruby=lost_ruby,
        phonetics=lost_phonetics,
    )
    out.warnings.append(
        f"「{_preview_text(old_text)}」→「{_preview_text(new_text)}」："
        f"{len(token_map)} 个音节的时间原样保留，{filled} 个新音节的时间由插值推算"
    )
    return out


def _record_retext_orphans(
    project: ProjectDTO,
    out: EditOutcome,
    *,
    line_id: str,
    old_text: str,
    ruby: Sequence[RubySpanDTO],
    phonetics: Sequence[PhoneticSpanDTO],
) -> None:
    """把改文本后无处安放的注音与发音形逐条记进「失效修正」清单（§4.4）。

    文案带上被注音的**原文**：用户看到「『明日』的注音『あした』」能立刻认出是
    哪个词，看到"字符区间 3-5"还得回去数。`payload` 留够重新应用所需的原始数据。
    """
    for sp in ruby:
        base = old_text[sp.start : sp.end]
        _add_orphan(
            project,
            out,
            kind="ruby",
            detail=(
                f"「{base}」的注音「{sp.text}」所在的字已被改写，无法迁移，请重新标注"
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
    for sp in phonetics:
        base = old_text[sp.start : sp.end]
        _add_orphan(
            project,
            out,
            kind="phonetic",
            detail=(
                f"「{base}」上你锁定过的发音形「{sp.text}」所在的字已被改写，"
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


# ---- 重新导入歌词：locked 感知的合并 ----
#
# 用户重新导入歌词，十有八九是因为**歌词文本错了**（漏字、错字、断句不对、
# 换了个更好的源），而不是因为想丢掉自己调了四十分钟的轴。所以"重新导入"
# 的正确语义是**换文本、留手工成果**，不是整体替换。
#
# CLAUDE.md §4.4 给的做法照办：主键用内容寻址的 tid，次要模糊重绑用字符偏移，
# **重绑失败的锁定项不得静默丢弃**，收进 `orphans` 让用户确认。
# §7.3 的那句话也在这里兑现：绝不用"第几行第几个 token"定位——重新导入的歌词
# 分行常常与旧的不同，按下标搬运会让每一条锁定项都落到别的字上。
#
# 两层结构：
#
# 1. **行的对应关系**由整曲字符对齐给出（`_Geometry`）。它按位置走，
#    因此同一句副歌唱四遍也分得清是哪一遍。
# 2. **行内的落点**以 tid 为主键、字符偏移为兜底（`_map_tokens` / `_map_span`），
#    且一律要求"映射后的区间与目标严格重合"，只差一个字就宁可不绑。


@dataclass
class _MergeStats:
    """一次合并的账目，用于给用户一句话回执。"""

    timing: int = 0
    voice: int = 0
    ruby: int = 0
    phonetic: int = 0
    line_attr: int = 0
    lost: int = 0

    @property
    def carried(self) -> int:
        return self.timing + self.voice + self.ruby + self.phonetic + self.line_attr


def _manual_items(line: LineDTO) -> int:
    """一行里"用户手工成果"的条数。清点的口径与合并时要搬运的口径必须一致。"""
    return (
        sum(1 for t in line.tokens if t.locked_timing)
        + sum(1 for t in line.tokens if t.voice_part is not None)
        + sum(1 for sp in line.ruby if sp.locked)
        + sum(1 for sp in line.phonetics if sp.locked)
        + (1 if line.locked else 0)
    )


def _char_map(old_text: str, new_text: str) -> dict[int, int]:
    """老行字符下标 → 新行字符下标，**只映射两边完全一致的那些字符**。

    用 difflib 的匹配块而不是自己算偏移：重新导入的歌词与旧文本之间可能有
    插入、删除、替换（送假名写法不同、半角空格变成全角读点），单一的整体偏移
    表达不了这些。匹配块天然保证映射出来的字符两边完全相同，
    因此凡是能整段映射的区间，其底下的书写文本必然没变——注音/发音形挂上去才安全。
    """
    matcher = difflib.SequenceMatcher(a=old_text, b=new_text, autojunk=False)
    out: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            out[block.a + k] = block.b + k
    return out


def _map_span(cmap: dict[int, int], start: int, end: int) -> tuple[int, int] | None:
    """把老行的字符区间 `[start, end)` 映射到新行；**必须整段连续**，否则不映射。

    只要中间有一个字被改动或被拆开，这段读音的落点就不再确定，宁可让它进
    「失效修正」清单，也不要挪到一个看着差不多的位置上。
    """
    if end <= start:
        return None
    base = cmap.get(start)
    if base is None:
        return None
    for k in range(1, end - start):
        if cmap.get(start + k) != base + k:
            return None
    return base, base + (end - start)


def _token_char_offsets(line: LineDTO) -> list[int]:
    """各 token 在行文本中的起始字符下标。"""
    offsets: list[int] = []
    cursor = 0
    for tok in line.tokens:
        offsets.append(cursor)
        cursor += len(tok.text)
    return offsets


def _token_span_index(line: LineDTO) -> dict[tuple[int, int], int]:
    """行内字符区间 → token 下标，供字符偏移重绑反查。"""
    out: dict[tuple[int, int], int] = {}
    cursor = 0
    for i, tok in enumerate(line.tokens):
        out[(cursor, cursor + len(tok.text))] = i
        cursor += len(tok.text)
    return out


def _tid_index(lines: Sequence[LineDTO]) -> dict[str, tuple[int, int]]:
    """tid → (行下标, token 下标)。**重复的 tid 一律剔除**。

    tid 本该全局唯一（见 `lyrics.importer._assign_tids`），真撞号时无从判断该绑
    哪一个，绑错行会把用户的轴搬到另一段副歌上——此时退回字符偏移重绑更安全。
    """
    seen: dict[str, tuple[int, int] | None] = {}
    for li, line in enumerate(lines):
        for ti, tok in enumerate(line.tokens):
            if not tok.tid:
                continue
            seen[tok.tid] = None if tok.tid in seen else (li, ti)
    return {tid: pos for tid, pos in seen.items() if pos is not None}


def _flatten(lines: Sequence[LineDTO]) -> tuple[str, list[int], list[tuple[int, int]]]:
    """把整首歌的行文本拼成一条长串。

    返回 `(全曲文本, 每个字符所属的行下标, 每行占据的全局区间)`。行与行之间插入
    换行符作分隔，它不属于任何行（行下标记 -1），也保证一行的字符不会与相邻行
    的字符连成一片被当成同一段。
    """
    parts: list[str] = []
    owners: list[int] = []
    ranges: list[tuple[int, int]] = []
    cursor = 0
    for li, line in enumerate(lines):
        if li:
            parts.append("\n")
            owners.append(-1)
            cursor += 1
        text = _line_text(line)
        ranges.append((cursor, cursor + len(text)))
        parts.append(text)
        owners.extend([li] * len(text))
        cursor += len(text)
    return "".join(parts), owners, ranges


@dataclass(frozen=True)
class _Geometry:
    """新旧歌词之间的**唯一一份**字符对应关系，以及由它得出的行候选。

    ## 为什么是"整曲一份"而不是"逐行一份"

    逐行各算一份看起来更省事，但在**重复片段**上会给出错误答案：用户把
    「桜舞って宙を舞って」拆成两半之后，后半段「宙を舞って」单独拿去和整行比，
    difflib 只会认第一处「舞って」——用户在后半段调的轴就搬到了前半段上。
    整曲一份对齐按**位置**走，同一个词出现几次都分得清是第几次。

    ## 为什么行的对应关系不能靠 tid 投票来定

    tid 是 token 级的**内容寻址主键**（§4.4），这里照旧把它用在那一层
    （见 `_map_tokens`）；但拿它来定**行**的对应关系会错得很难看。tid 的行维是
    `(行文本 hash, 该文本在全曲的第几次出现)`，副歌重复行只要有一句被改动，
    后面几句的出现序号就整体前移一位——老的第 1 段副歌拿着 `hash.0`，
    而新导入里 `hash.0` 已经落到第 2 段副歌上了。赤春花实测（633 个音节全部锁定、
    只改写 1 行、「桜舞って宙を舞って宙を舞って」重复 4 次）下，按 tid 投票定行
    会造成 **42 个音节错绑**：用户在第一段副歌调的轴被搬到了第四段上。
    **绑错比绑不上更糟**——绑不上还会进「失效修正」清单让他看见，
    绑错则是悄悄把他的判断挪到了别的地方。

    代价只是一次 difflib：赤春花全曲 716 字，整个合并实测 7ms。
    """

    gmap: dict[int, int]
    """老行的全局字符下标 → 新歌词的全局字符下标。只含两边完全一致的字符。"""

    old_ranges: list[tuple[int, int]]
    new_ranges: list[tuple[int, int]]
    candidates: list[list[int]]
    """每个老行对应的新行候选，按落进去的字符数降序。

    一个老行可以有多个候选：用户此前把两行并成一行、如今新歌词又把它拆回两行时，
    它的字符本来就分布在两个新行里。
    """


def _build_geometry(
    old_lines: Sequence[LineDTO], new_lines: Sequence[LineDTO]
) -> _Geometry:
    old_text, _old_owners, old_ranges = _flatten(old_lines)
    new_text, new_owners, new_ranges = _flatten(new_lines)
    gmap = _char_map(old_text, new_text)

    candidates: list[list[int]] = []
    for lo, hi in old_ranges:
        votes: Counter[int] = Counter()
        for g in range(lo, hi):
            target = gmap.get(g)
            if target is None:
                continue
            owner = new_owners[target]
            if owner >= 0:
                votes[owner] += 1
        # 只落进去零星几个字的新行不算候选：那种命中多半是「の」「て」这类高频字
        # 的巧合，让它进候选只会给后面的重绑制造误绑机会
        floor = max(1, (hi - lo) // 4)
        candidates.append([ni for ni, count in votes.most_common() if count >= floor])
    return _Geometry(
        gmap=gmap,
        old_ranges=old_ranges,
        new_ranges=new_ranges,
        candidates=candidates,
    )


def _map_local_span(
    geo: _Geometry, old_index: int, new_index: int, start: int, end: int
) -> tuple[int, int] | None:
    """把老行内的字符区间 `[start, end)` 映射到指定新行的行内区间。

    整段必须连续地落在**同一个新行**里，否则不映射：跨行的注音在任何一行内
    都表达不了，宁可让它进「失效修正」清单，也不要挪到一个看着差不多的位置上。
    """
    base = geo.old_ranges[old_index][0]
    target = _map_span(geo.gmap, base + start, base + end)
    if target is None:
        return None
    lo, hi = geo.new_ranges[new_index]
    if not (lo <= target[0] and target[1] <= hi):
        return None
    return target[0] - lo, target[1] - lo


def _place_span[S: CharSpanDTO](
    spans: list[S], span: S, target: tuple[int, int]
) -> list[S]:
    """把一段用户锁定的读音放进新行，吃掉与它相交的自动值。

    §4.2 要求读音区间无缝无重叠，而新导入自带的注音（`[kana:]`）与用户锁定的
    那一段可能只差一个字的范围。§4.4 的裁决很明确：自动重算只覆盖 `locked=False`
    的项，所以让路的是自动值。
    """
    kept = [
        sp
        for sp in spans
        if sp.locked or not _intersects(sp.start, sp.end, target[0], target[1])
    ]
    kept.append(span.model_copy(update={"start": target[0], "end": target[1]}))
    kept.sort(key=lambda sp: (sp.start, sp.end))
    return kept


def _repair_timing(lines: Sequence[LineDTO], out: EditOutcome) -> None:
    """修掉合并后行内可能出现的时间倒挂，**只动没锁的那一侧**。

    用户锁定的时间是他自己调出来的值，新导入的时间是歌词源给的值，两者在同一行里
    首尾相接时可能差出几十毫秒（`ops` 模块文档的时间不变式 2）。让路的必须是
    没锁的那一个——去动锁定值就等于把用户的手工调整又平掉了一次。
    两侧都锁或两侧都没锁时不管：那是同一来源内部本就自洽的数据。
    """
    fixed = 0
    for line in lines:
        for i in range(len(line.tokens) - 1):
            a, b = line.tokens[i], line.tokens[i + 1]
            overlap = a.start_ms + a.dur_ms - b.start_ms
            if overlap <= 0:
                continue
            if a.locked_timing and not b.locked_timing:
                b.start_ms += overlap
                b.dur_ms = max(MIN_DUR_MS, b.dur_ms - overlap)
                fixed += 1
            elif b.locked_timing and not a.locked_timing:
                a.dur_ms = max(MIN_DUR_MS, b.start_ms - a.start_ms)
                fixed += 1
    if fixed:
        out.warnings.append(
            f"{fixed} 处新导入的时间与你锁定的音节首尾冲突，已让新导入的那一侧避让"
        )


def merge_imported_lines(
    project: ProjectDTO,
    new_lines: Sequence[LineDTO],
    *,
    keep_manual_edits: bool = True,
) -> EditOutcome:
    """把新导入的歌词并进工程：**换文本、留手工成果**。

    `keep_manual_edits=False` 才是从前那个"整体替换"的行为——它仍然是正当诉求
    （用户就是要推倒重来），但必须由用户**显式**要求，不能是默认。默认整体替换
    会把调过的轴、改过的注音、填过的发音形、指派过的声部连同它们的 `locked`
    标记一起无声抹掉，正是 §4.4 点名的"用户调了 40 分钟的轴莫名其妙消失"。

    搬运的口径就是 §4.4 的 `locked`：**只搬用户锁定过的项**，其余一律以新导入
    的值为准（歌词源的注音、逐字轴本来就该被新的覆盖）。发音形是个例外，
    连没锁的也一并搬——新导入根本不产生发音形，此处没有"新值"可言，
    丢掉只是白白清空一层。

    绑不上的锁定项**全部进 `project.orphans`**，带人类可读的中文说明。
    """
    out = EditOutcome()
    fresh = [ln.model_copy(deep=True) for ln in new_lines]
    old_lines = list(project.lines)

    if not keep_manual_edits:
        dropped = sum(_manual_items(ln) for ln in old_lines)
        project.lines = fresh
        if dropped:
            out.warnings.append(
                f"已按你的选择放弃全部手工修改：{dropped} 项（调过的轴、注音、"
                "发音形、声部标记）随旧歌词一并丢弃，本次导入可以整体撤销"
            )
        return out

    if not old_lines:
        project.lines = fresh
        return out

    tid_index = _tid_index(fresh)
    geo = _build_geometry(old_lines, fresh)
    stats = _MergeStats()
    # 新行下标 → 已认领它行级属性的老行下标。用户此前拆过行时会有两个老行指向
    # 同一个新行，而行级属性只能有一份主人，第二份走"声部下沉到 token"
    owner: dict[int, int] = {}
    # 已经被认领的 (新行下标, token 下标)，防止两个老 token 抢同一个落点
    claimed_tokens: set[tuple[int, int]] = set()

    for oi, old_line in enumerate(old_lines):
        _merge_one_line(
            project,
            out,
            old_line=old_line,
            old_index=oi,
            fresh=fresh,
            geo=geo,
            tid_index=tid_index,
            owner=owner,
            claimed_tokens=claimed_tokens,
            stats=stats,
        )

    project.lines = fresh
    _repair_timing(fresh, out)

    # 注音已经整体换成新导入的那一份，由它推出来的发音形立刻过期。物化与否按
    # **整个工程**判断而不是逐行：用户是对整首歌启用了这一层，不该因为某一行
    # 一条都没搬过来就把那行永久留空。锁定的发音形照旧不动（§4.4）。
    materialized = any(ln.phonetics for ln in old_lines) or any(
        ln.phonetics for ln in fresh
    )
    for line in fresh:
        _rederive_phonetics(line, materialized=materialized)

    if stats.carried:
        out.warnings.append(
            f"已保留你的手工修改 {stats.carried} 项（时间 {stats.timing}、"
            f"注音 {stats.ruby}、发音形 {stats.phonetic}、声部 {stats.voice}、"
            f"行标记 {stats.line_attr}）"
        )
    if stats.lost:
        out.warnings.append(
            f"{stats.lost} 项手工修改在新歌词里找不到对应位置，已收进「失效修正」"
            "清单等你确认——它们没有被丢掉，但也没有自动落到新歌词上"
        )
    return out


def _merge_one_line(
    project: ProjectDTO,
    out: EditOutcome,
    *,
    old_line: LineDTO,
    old_index: int,
    fresh: list[LineDTO],
    geo: _Geometry,
    tid_index: dict[str, tuple[int, int]],
    owner: dict[int, int],
    claimed_tokens: set[tuple[int, int]],
    stats: _MergeStats,
) -> None:
    """把一个老行的手工成果搬到它的候选新行上，搬不动的记进失效修正清单。

    候选可能不止一个（用户此前把两行并成了一行，如今又被拆回两行），
    所以每一项都按"第一个能接住它的候选"落位，落过就不再参与后续候选。
    """
    old_text = _line_text(old_line)
    done_tokens: set[int] = set()
    done_ruby: set[int] = set()
    done_phonetics: set[int] = set()

    for ni in geo.candidates[old_index]:
        new_line = fresh[ni]
        token_map = _map_tokens(old_line, old_index, ni, tid_index, geo, new_line)

        for ti, target in token_map.items():
            tok = old_line.tokens[ti]
            if ti in done_tokens or (ni, target) in claimed_tokens:
                continue
            if not tok.locked_timing and tok.voice_part is None:
                continue
            claimed_tokens.add((ni, target))
            done_tokens.add(ti)
            _carry_token(tok, new_line.tokens[target], stats)

        for si, sp in enumerate(old_line.ruby):
            if si in done_ruby or not sp.locked:
                continue
            target_span = _map_local_span(geo, old_index, ni, sp.start, sp.end)
            if target_span is None:
                continue
            new_line.ruby = _place_span(new_line.ruby, sp, target_span)
            done_ruby.add(si)
            stats.ruby += 1

        for si, sp in enumerate(old_line.phonetics):
            # 发音形连没锁的也搬：新导入不产生这一层，此处没有"新值"可以覆盖它，
            # 丢掉只是白白清空。只有锁定的那些才计入"保住了多少手工成果"
            if si in done_phonetics:
                continue
            target_span = _map_local_span(geo, old_index, ni, sp.start, sp.end)
            if target_span is None:
                continue
            new_line.phonetics = _place_span(new_line.phonetics, sp, target_span)
            done_phonetics.add(si)
            if sp.locked:
                stats.phonetic += 1

        if old_line.locked:
            _carry_line_attrs(
                project,
                out,
                old_line=old_line,
                old_index=old_index,
                new_line=new_line,
                new_index=ni,
                mapped=set(token_map.values()),
                owner=owner,
                stats=stats,
            )

    _record_merge_orphans(
        project,
        out,
        old_line=old_line,
        old_text=old_text,
        bound=bool(geo.candidates[old_index]),
        done_tokens=done_tokens,
        done_ruby=done_ruby,
        done_phonetics=done_phonetics,
        stats=stats,
    )


def _map_tokens(
    old_line: LineDTO,
    old_index: int,
    new_index: int,
    tid_index: dict[str, tuple[int, int]],
    geo: _Geometry,
    new_line: LineDTO,
) -> dict[int, int]:
    """老行 token 下标 → 新行 token 下标。

    主键是 tid（内容寻址三元组 + 行出现序号，§4.4/§7.3），它在这一层最强：
    用户拆开的两个半行仍带着**原行**的 tid，`#っ#1` 明确指向"本行第 2 个っ"，
    比任何字符相似度都准。而候选行已经由整曲字符对齐圈定，tid 只在这一行内
    起作用，副歌重复行那种跨段错绑在这里不可能发生。

    tid 对不上——行文本改过一个字，该行全部 tid 就都变了——退回字符偏移这条
    次要模糊重绑，且要求映射后的区间与某个新 token **严格重合**：只差一个字
    就宁可不绑，让它进「失效修正」清单。

    这里**不做认领**，全部 token 都算：认领与否取决于这个 token 上有没有东西
    要搬，而声部下沉还需要知道"这个老行落在新行的哪几个音节上"。
    """
    span_index = _token_span_index(new_line)
    offsets = _token_char_offsets(old_line)
    out: dict[int, int] = {}
    for ti, tok in enumerate(old_line.tokens):
        if not tok.text:
            continue
        hit = tid_index.get(tok.tid) if tok.tid else None
        if hit is not None and hit[0] == new_index:
            out[ti] = hit[1]
            continue
        target_span = _map_local_span(
            geo, old_index, new_index, offsets[ti], offsets[ti] + len(tok.text)
        )
        if target_span is None:
            continue
        target = span_index.get(target_span)
        if target is not None:
            out[ti] = target
    return out


def _carry_token(old: TokenDTO, new: TokenDTO, stats: _MergeStats) -> None:
    """把老 token 上锁定过的时间与声部覆盖搬到新 token 上。

    连 `timing_source` 一起搬：§7.4 要求界面用颜色区分来源，搬了值不搬来源，
    用户就会看到一个"歌词源给的"颜色配着自己调出来的数字。
    """
    if old.locked_timing:
        new.start_ms = old.start_ms
        new.dur_ms = old.dur_ms
        new.timing_source = old.timing_source
        new.timing_granularity = old.timing_granularity
        new.locked_timing = True
        stats.timing += 1
    if old.voice_part is not None:
        new.voice_part = old.voice_part
        new.locked_voice = old.locked_voice
        stats.voice += 1


def _carry_line_attrs(
    project: ProjectDTO,
    out: EditOutcome,
    *,
    old_line: LineDTO,
    old_index: int,
    new_line: LineDTO,
    new_index: int,
    mapped: set[int],
    owner: dict[int, int],
    stats: _MergeStats,
) -> None:
    """搬运行级手工成果：制作名单标记、行声部、行级锁。

    一个新行只能有一位"主人"。用户此前把一行拆成两半、又给两半指派了不同声部时，
    第二半的声部**下沉到 token 级**保住——模型本来就支持 token 级声部
    （对唱一行内男女交替是常态），`merge_line` 走的也是这条路。数据没丢就不该
    往清单里塞东西，清单只装真的没保住的东西。

    制作名单标记没有 token 级的落点，两个老行判得不一样时只能留一份，
    另一份进清单——它是用户亲手判过的一位信息，静默取其一等于替他做主。
    """
    if new_index not in owner:
        owner[new_index] = old_index
        new_line.is_metadata = old_line.is_metadata
        new_line.voice_part = old_line.voice_part
        new_line.locked = True
        stats.line_attr += 1
        return

    if old_line.voice_part != new_line.voice_part:
        sunk = 0
        for ti in sorted(mapped):
            tok = new_line.tokens[ti]
            if tok.voice_part is None:
                tok.voice_part = old_line.voice_part
                tok.locked_voice = True
                sunk += 1
        if sunk:
            stats.line_attr += 1
            out.warnings.append(
                f"「{_preview_text(_line_text(old_line))}」的声部「{old_line.voice_part}」"
                f"与并到同一新行上的另一段不同，已下沉到 {sunk} 个音节上，着色不变"
            )

    if old_line.is_metadata != new_line.is_metadata:
        was = "制作名单" if old_line.is_metadata else "正文歌词"
        now = "制作名单" if new_line.is_metadata else "正文歌词"
        _add_orphan(
            project,
            out,
            kind="line",
            detail=(
                f"「{_preview_text(_line_text(old_line))}」你标过{was}，"
                f"但新歌词把它与另一句并成了同一行，那一句是{now}，只能保留一种"
            ),
            payload={
                "line_id": old_line.id,
                "text": _line_text(old_line),
                "is_metadata": old_line.is_metadata,
                "voice_part": old_line.voice_part,
            },
        )
        stats.lost += 1


def _record_merge_orphans(
    project: ProjectDTO,
    out: EditOutcome,
    *,
    old_line: LineDTO,
    old_text: str,
    bound: bool,
    done_tokens: set[int],
    done_ruby: set[int],
    done_phonetics: set[int],
    stats: _MergeStats,
) -> None:
    """把这一行里没能落到新歌词上的手工成果逐条记进「失效修正」清单。

    §4.4：**重绑失败的锁定项不得静默丢弃**。文案一律带上原文——用户看到
    「『明日』的注音『あした』」能立刻认出是哪个词，看到"第 7 行第 3 个音节"
    还得回去数。`payload` 留够重新应用所需的原始数据。
    """
    label = _preview_text(old_text)
    where = "在新歌词里找不到对应位置" if bound else "在新歌词里找不到对应的这一句"

    for ti, tok in enumerate(old_line.tokens):
        if ti in done_tokens:
            continue
        if tok.locked_timing:
            _add_orphan(
                project,
                out,
                kind="timing",
                detail=(
                    f"「{label}」中「{tok.text}」的时间（{tok.start_ms}ms 起、"
                    f"长 {tok.dur_ms}ms）是你手工调过的，{where}，需要重新调"
                ),
                payload={
                    "line_id": old_line.id,
                    "line_text": old_text,
                    "tid": tok.tid,
                    "text": tok.text,
                    "start_ms": tok.start_ms,
                    "dur_ms": tok.dur_ms,
                    "timing_source": tok.timing_source,
                },
            )
            stats.lost += 1
        if tok.voice_part is not None:
            _add_orphan(
                project,
                out,
                kind="voice_part",
                detail=(
                    f"「{label}」中「{tok.text}」你指派的声部「{tok.voice_part}」"
                    f"{where}，需要重新指派"
                ),
                payload={
                    "line_id": old_line.id,
                    "line_text": old_text,
                    "tid": tok.tid,
                    "text": tok.text,
                    "voice_part": tok.voice_part,
                },
            )
            stats.lost += 1

    for si, sp in enumerate(old_line.ruby):
        if si in done_ruby or not sp.locked:
            continue
        base = old_text[sp.start : sp.end]
        _add_orphan(
            project,
            out,
            kind="ruby",
            detail=(
                f"「{base}」的注音「{sp.text}」是你锁定过的，{where}（原句"
                f"「{label}」），请重新标注"
            ),
            payload={
                "line_id": old_line.id,
                "line_text": old_text,
                "start": sp.start,
                "end": sp.end,
                "text": sp.text,
                "source": sp.source,
                "locked": True,
                "base": base,
            },
        )
        stats.lost += 1

    for si, sp in enumerate(old_line.phonetics):
        if si in done_phonetics or not sp.locked:
            # 没锁的发音形是推导出来的，重新推一遍就回来了，进清单只会把真正
            # 需要用户确认的条目淹掉
            continue
        base = old_text[sp.start : sp.end]
        _add_orphan(
            project,
            out,
            kind="phonetic",
            detail=(
                f"「{base}」上你锁定过的发音形「{sp.text}」{where}（原句"
                f"「{label}」），请重新填写"
            ),
            payload={
                "line_id": old_line.id,
                "line_text": old_text,
                "start": sp.start,
                "end": sp.end,
                "text": sp.text,
                "source": sp.source,
                "locked": True,
                "base": base,
            },
        )
        stats.lost += 1

    if bound or not old_line.locked:
        return
    if not old_line.is_metadata and old_line.voice_part == "main":
        # 行级锁本身是"别让自动分行动这一行"的标记，不承载别的信息。整行都不在
        # 新歌词里了，这个标记也就无所指——为它写一条清单只会制造噪声
        return
    _add_orphan(
        project,
        out,
        kind="line",
        detail=(
            f"「{label}」你标过的"
            + ("制作名单" if old_line.is_metadata else f"声部「{old_line.voice_part}」")
            + f"{where}，需要重新标记"
        ),
        payload={
            "line_id": old_line.id,
            "text": old_text,
            "is_metadata": old_line.is_metadata,
            "voice_part": old_line.voice_part,
        },
    )
    stats.lost += 1


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
