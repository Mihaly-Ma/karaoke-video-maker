"""编辑操作的单元测试。

重点不在"函数跑通了"，而在 CLAUDE.md §4.4 那条不变式上：
**任何手工编辑都必须把受影响项标成 `manual` 并 `locked`**。
它一旦破了，将来的强制对齐与注音重算会把用户的手工调整平掉，
而这种 bug 在跑通一遍出片流程时完全看不出来——只有等到重跑对齐才爆炸。

其次是时间不变式（非负、不倒挂）与注音索引迁移：注音的 `start`/`end` 是
**行内**字符索引，拆行/并行时算错一次，注音就会挂到别的字上。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.api.schemas import (  # noqa: E402
    LineDTO,
    LockItem,
    PaletteDTO,
    ProjectDTO,
    RubySpanDTO,
    TimingItem,
    TokenDTO,
)
from kvm.api.store import ProjectStore  # noqa: E402
from kvm.editing import ops  # noqa: E402

# ---- 夹具 ----


def _tok(text: str, start_ms: int, dur_ms: int) -> TokenDTO:
    return TokenDTO(text=text, start_ms=start_ms, dur_ms=dur_ms)


def _project() -> ProjectDTO:
    """两行的最小工程。

    第一行「桜舞って」：注音「桜→さくら」「舞→ま」，第二行「今日」注音「今日→きょう」。
    第二行整体在第一行之后，两行之间留 400ms 空档。
    """
    line_a = LineDTO(
        id="L1",
        tokens=[_tok("桜", 1000, 500), _tok("舞", 1500, 300), _tok("っ", 1800, 200), _tok("て", 2000, 400)],
        ruby=[
            RubySpanDTO(start=0, end=1, text="さくら"),
            RubySpanDTO(start=1, end=2, text="ま"),
        ],
    )
    line_b = LineDTO(
        id="L2",
        tokens=[_tok("今", 2800, 400), _tok("日", 3200, 600)],
        ruby=[RubySpanDTO(start=0, end=2, text="きょう")],
    )
    return ProjectDTO(id="P1", lines=[line_a, line_b])


def _assert_monotonic(line: LineDTO) -> None:
    """行内 token 必须非负且不倒挂。"""
    for i, tok in enumerate(line.tokens):
        assert tok.start_ms >= 0, f"第 {i} 个音节起点为负"
        assert tok.dur_ms >= ops.MIN_DUR_MS, f"第 {i} 个音节时长低于下限"
        if i + 1 < len(line.tokens):
            assert tok.start_ms + tok.dur_ms <= line.tokens[i + 1].start_ms, f"第 {i} 个音节与后一个倒挂"


# ---- 平移：locked / source 标记 ----


def test_line_shift_marks_manual_and_locked() -> None:
    p = _project()

    ops.shift(p, scope="line", delta_ms=120, line_id="L1")

    line = p.lines[0]
    assert [t.start_ms for t in line.tokens] == [1120, 1620, 1920, 2120]
    assert all(t.timing_source == "manual" for t in line.tokens)
    assert all(t.locked_timing for t in line.tokens)
    # 未被编辑的行不得受牵连，否则自动重算会连它一起跳过
    assert all(t.timing_source == "provider" for t in p.lines[1].tokens)
    assert not any(t.locked_timing for t in p.lines[1].tokens)


def test_token_shift_moves_block_and_absorbs_into_neighbours() -> None:
    """逐字轴首尾相接，单词平移必须由邻居的时长吸收，否则一步也动不了。"""
    p = _project()

    ops.shift(p, scope="token", delta_ms=-50, line_id="L1", token_index=2)

    line = p.lines[0]
    assert [(t.start_ms, t.dur_ms) for t in line.tokens] == [
        (1000, 500),  # 未受牵连
        (1500, 250),  # 前邻缩短，起点不动
        (1750, 200),  # 被平移的 token，时长不变
        (1950, 450),  # 后邻起点跟随，终点不动
    ]
    assert [t.locked_timing for t in line.tokens] == [False, True, True, True]
    assert [t.timing_source for t in line.tokens] == ["provider", "manual", "manual", "manual"]
    _assert_monotonic(line)


def test_token_shift_leaves_distant_tokens_untouched() -> None:
    """改动必须严格局限在三个 token 内，一次微调不该波及整行。"""
    p = _project()

    ops.shift(p, scope="token", delta_ms=60, line_id="L1", token_index=1)

    line = p.lines[0]
    assert (line.tokens[3].start_ms, line.tokens[3].dur_ms) == (2000, 400)
    assert not line.tokens[3].locked_timing
    assert line.tokens[0].start_ms == 1000, "行的起点不该被单词级调整改掉"
    _assert_monotonic(line)


def test_set_timing_marks_manual_and_locked() -> None:
    p = _project()

    ops.set_timing(p, line_id="L1", token_index=1, start_ms=1600, dur_ms=150)

    tok = p.lines[0].tokens[1]
    assert (tok.start_ms, tok.dur_ms) == (1600, 150)
    assert tok.timing_source == "manual"
    assert tok.locked_timing


# ---- 全局平移不改 token 时间 ----


def test_global_shift_only_changes_offset() -> None:
    p = _project()
    before = [(t.start_ms, t.dur_ms, t.timing_source, t.locked_timing) for ln in p.lines for t in ln.tokens]

    ops.shift(p, scope="global", delta_ms=-250)

    after = [(t.start_ms, t.dur_ms, t.timing_source, t.locked_timing) for ln in p.lines for t in ln.tokens]
    assert p.global_offset_ms == -250
    assert after == before, "整体平移必须只改 global_offset_ms，否则用户无法归零重来"


def test_global_shift_accumulates() -> None:
    p = _project()

    ops.shift(p, scope="global", delta_ms=300)
    ops.shift(p, scope="global", delta_ms=-100)

    assert p.global_offset_ms == 200


# ---- 边界夹紧 ----


def test_global_shift_clamped_at_first_token() -> None:
    """首个音节在 1000ms，整体最多前推 1000ms，再多就落到负时间。"""
    p = _project()

    out = ops.shift(p, scope="global", delta_ms=-5000)

    assert p.global_offset_ms == -1000
    assert out.warnings, "夹紧必须回报，静默夹紧会让用户以为旋钮坏了"


def test_line_shift_clamped_at_zero() -> None:
    p = _project()

    out = ops.shift(p, scope="line", delta_ms=-9999, line_id="L1")

    line = p.lines[0]
    assert line.tokens[0].start_ms == 0
    assert [t.start_ms for t in line.tokens] == [0, 500, 800, 1000], "夹紧后行内相对关系必须保持"
    assert out.warnings
    _assert_monotonic(line)


def test_token_shift_clamped_when_next_token_hits_minimum() -> None:
    """向右最多推到后邻只剩最短时长为止，再推就倒挂了。"""
    p = _project()

    out = ops.shift(p, scope="token", delta_ms=1000, line_id="L1", token_index=1)

    line = p.lines[0]
    assert line.tokens[1].start_ms == 1500 + 190
    assert line.tokens[2].dur_ms == ops.MIN_DUR_MS
    assert out.warnings, "夹紧必须回报"
    _assert_monotonic(line)


def test_token_shift_clamped_when_previous_token_hits_minimum() -> None:
    p = _project()

    ops.shift(p, scope="token", delta_ms=-1000, line_id="L1", token_index=1)

    line = p.lines[0]
    assert line.tokens[0].dur_ms == ops.MIN_DUR_MS
    assert line.tokens[1].start_ms == 1010
    _assert_monotonic(line)


def test_first_token_shift_clamped_at_zero() -> None:
    p = _project()

    ops.shift(p, scope="token", delta_ms=-9999, line_id="L1", token_index=0)

    assert p.lines[0].tokens[0].start_ms == 0, "首个音节不能落到负时间"
    _assert_monotonic(p.lines[0])


# ---- 时间不倒挂 ----


def test_set_timing_duration_clamped_by_next_token() -> None:
    """拖长首个音节会压缩后邻，但最多压到最短时长，不能把它吃掉。"""
    p = _project()

    out = ops.set_timing(p, line_id="L1", token_index=0, dur_ms=9999)

    line = p.lines[0]
    assert (line.tokens[0].start_ms, line.tokens[0].dur_ms) == (1000, 790)
    assert (line.tokens[1].start_ms, line.tokens[1].dur_ms) == (1790, ops.MIN_DUR_MS)
    assert (line.tokens[2].start_ms, line.tokens[2].dur_ms) == (1800, 200), "只牵动紧邻的一个"
    assert out.warnings
    _assert_monotonic(line)


def test_set_timing_start_clamped_by_previous_token() -> None:
    p = _project()

    out = ops.set_timing(p, line_id="L1", token_index=1, start_ms=-500)

    line = p.lines[0]
    assert line.tokens[1].start_ms == 1010, "前邻可以被压缩，但不能被压没"
    assert line.tokens[0].dur_ms == ops.MIN_DUR_MS
    assert line.tokens[1].dur_ms == 1800 - 1010, "拖起点时终点不动"
    assert out.warnings
    _assert_monotonic(line)


def test_set_timing_start_only_keeps_trailing_edge() -> None:
    """只给起点是"拖边界"而不是"搬块"：终点必须原地不动。"""
    p = _project()

    ops.set_timing(p, line_id="L1", token_index=1, start_ms=1600)

    line = p.lines[0]
    assert (line.tokens[1].start_ms, line.tokens[1].dur_ms) == (1600, 200)
    assert (line.tokens[0].start_ms, line.tokens[0].dur_ms) == (1000, 600)
    _assert_monotonic(line)


def test_set_timing_enforces_minimum_duration() -> None:
    p = _project()

    ops.set_timing(p, line_id="L1", token_index=0, dur_ms=0)

    assert p.lines[0].tokens[0].dur_ms == ops.MIN_DUR_MS, "零时长音节会命中 libass #124"


def test_last_token_duration_unbounded() -> None:
    """末个音节没有后邻，拖长不该被夹——间奏前的长音很常见。"""
    p = _project()

    ops.set_timing(p, line_id="L1", token_index=3, dur_ms=5000)

    assert p.lines[0].tokens[3].dur_ms == 5000


# ---- 注音 ----


def test_set_ruby_marks_manual_and_locked() -> None:
    p = _project()

    ops.set_ruby(p, line_id="L1", start=0, end=1, text="サクラ")

    spans = p.lines[0].ruby
    assert [(s.start, s.end, s.text) for s in spans] == [(0, 1, "サクラ"), (1, 2, "ま")]
    assert spans[0].source == "manual"
    assert spans[0].locked


def test_set_ruby_removes_overlapping_spans() -> None:
    p = _project()

    ops.set_ruby(p, line_id="L1", start=0, end=2, text="さくらま")

    assert [(s.start, s.end) for s in p.lines[0].ruby] == [(0, 2)]


def test_set_ruby_empty_text_clears_span() -> None:
    p = _project()

    ops.set_ruby(p, line_id="L1", start=0, end=1, text="")

    assert [(s.start, s.end, s.text) for s in p.lines[0].ruby] == [(1, 2, "ま")]


def test_set_ruby_range_clamped_to_line() -> None:
    p = _project()

    out = ops.set_ruby(p, line_id="L1", start=2, end=99, text="って")

    assert [(s.start, s.end) for s in p.lines[0].ruby] == [(0, 1), (1, 2), (2, 4)]
    assert out.warnings


def test_set_ruby_records_overwritten_locked_span_as_orphan() -> None:
    """被大区间吃掉的锁定注音，在界面上只表现为"注音变了"，不留痕迹就是静默丢弃。"""
    p = _project()
    p.lines[0].ruby = [RubySpanDTO(start=0, end=1, text="さくら", locked=True)]

    out = ops.set_ruby(p, line_id="L1", start=0, end=2, text="さくらま")

    assert len(p.orphans) == 1
    assert p.orphans[0].kind == "ruby"
    assert "さくら" in p.orphans[0].detail
    assert p.orphans[0].payload["locked"] is True
    assert out.warnings


def test_set_ruby_same_range_overwrite_is_not_an_orphan() -> None:
    """原地改一段自己锁过的注音是正常修订，不该往清单里塞东西。"""
    p = _project()
    p.lines[0].ruby = [RubySpanDTO(start=0, end=1, text="さくら", locked=True)]

    ops.set_ruby(p, line_id="L1", start=0, end=1, text="サクラ")

    assert p.orphans == []
    assert [(s.start, s.end, s.text) for s in p.lines[0].ruby] == [(0, 1, "サクラ")]


# ---- 拆行 ----


def test_split_line_migrates_ruby_indices() -> None:
    p = _project()

    ops.split_line(p, line_id="L1", token_index=1)

    head, tail = p.lines[0], p.lines[1]
    assert [t.text for t in head.tokens] == ["桜"]
    assert [t.text for t in tail.tokens] == ["舞", "っ", "て"]
    assert [(s.start, s.end, s.text) for s in head.ruby] == [(0, 1, "さくら")]
    # 「舞」在原行是第 1 个字符，拆行后是新行的第 0 个字符
    assert [(s.start, s.end, s.text) for s in tail.ruby] == [(0, 1, "ま")]


def test_split_line_keeps_first_id_and_locks_both() -> None:
    p = _project()

    ops.split_line(p, line_id="L1", token_index=2)

    assert p.lines[0].id == "L1", "前半段沿用原 id，前端的选中态才不会失效"
    assert p.lines[1].id not in {"L1", "L2"}
    assert p.lines[0].locked and p.lines[1].locked, "手工分行必须锁住，否则自动分行会覆盖"
    assert p.lines[2].id == "L2"


def test_split_line_preserves_token_times() -> None:
    p = _project()

    ops.split_line(p, line_id="L1", token_index=2)

    assert [t.start_ms for t in p.lines[0].tokens] == [1000, 1500]
    assert [t.start_ms for t in p.lines[1].tokens] == [1800, 2000]
    _assert_monotonic(p.lines[0])
    _assert_monotonic(p.lines[1])


def test_split_line_reports_dropped_crossing_ruby() -> None:
    """跨拆分点的注音无法保留，但绝不能静默丢弃（CLAUDE.md §4.4）。"""
    p = _project()
    p.lines[0].ruby = [RubySpanDTO(start=0, end=2, text="さくらま", locked=True)]

    out = ops.split_line(p, line_id="L1", token_index=1)

    assert p.lines[0].ruby == []
    assert p.lines[1].ruby == []
    assert len(out.warnings) == 1
    assert "さくらま" in out.warnings[0]


def test_split_line_records_dropped_ruby_as_orphan() -> None:
    """回执看完就没了，损失必须留在工程里等用户确认，而且要写得像人话。"""
    p = _project()
    p.lines[0].ruby = [RubySpanDTO(start=0, end=2, text="さくらま", locked=True)]

    ops.split_line(p, line_id="L1", token_index=1)

    assert len(p.orphans) == 1
    orphan = p.orphans[0]
    assert orphan.kind == "ruby"
    assert "「桜舞」" in orphan.detail and "さくらま" in orphan.detail
    # payload 要够前端一键重新应用
    assert orphan.payload["line_id"] == "L1"
    assert (orphan.payload["start"], orphan.payload["end"]) == (0, 2)
    assert orphan.payload["text"] == "さくらま"


def test_orphans_survive_project_roundtrip(tmp_path: Path) -> None:
    """失效修正是"下次打开还要处理"的待办，不落盘就等于没记。"""
    store = ProjectStore(root=tmp_path)
    created = store.create(title="t")
    store.mutate(created.id, lambda d: d.lines.extend(_project().lines))
    store.mutate(
        created.id,
        lambda d: d.lines[0].__setattr__(
            "ruby", [RubySpanDTO(start=0, end=2, text="さくらま", locked=True)]
        ),
    )
    store.mutate(created.id, lambda d: ops.split_line(d, line_id="L1", token_index=1))

    reopened = ProjectStore(root=tmp_path).get(created.id)

    assert len(reopened.orphans) == 1
    assert reopened.orphans[0].kind == "ruby"


def test_orphans_capped() -> None:
    """清单攒到几千条就没人看了，重要的那几条反而被淹掉。"""
    p = _project()
    out = ops.EditOutcome()
    for i in range(ops.MAX_ORPHANS + 30):
        ops._add_orphan(p, out, kind="ruby", detail=f"第 {i} 条", payload={"i": i})

    assert len(p.orphans) == ops.MAX_ORPHANS
    assert p.orphans[-1].payload["i"] == ops.MAX_ORPHANS + 29, "留新的，丢最旧的"


@pytest.mark.parametrize("bad_index", [0, 4, -1])
def test_split_line_rejects_out_of_range_cut(bad_index: int) -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.split_line(p, line_id="L1", token_index=bad_index)


# ---- 并行 ----


def test_merge_line_reindexes_ruby() -> None:
    p = _project()

    ops.merge_line(p, line_id="L1")

    assert len(p.lines) == 1
    merged = p.lines[0]
    assert [t.text for t in merged.tokens] == ["桜", "舞", "っ", "て", "今", "日"]
    # 「今日」在原行是 0-2，合并后前面多了 4 个字符
    assert [(s.start, s.end, s.text) for s in merged.ruby] == [
        (0, 1, "さくら"),
        (1, 2, "ま"),
        (4, 6, "きょう"),
    ]
    assert merged.locked


def test_merge_line_keeps_times_monotonic() -> None:
    """两行时间重叠时（模型允许）合并后必须把后半段推开，不能倒挂。"""
    p = _project()
    p.lines[1].tokens = [_tok("今", 1200, 400), _tok("日", 1600, 600)]

    out = ops.merge_line(p, line_id="L1")

    merged = p.lines[0]
    _assert_monotonic(merged)
    # 前一行终点 2400，后半段整体后推 1200ms
    assert [t.start_ms for t in merged.tokens[4:]] == [2400, 2800]
    assert all(t.timing_source == "manual" and t.locked_timing for t in merged.tokens[4:])
    assert out.warnings


def test_merge_line_no_shift_when_no_overlap() -> None:
    p = _project()

    out = ops.merge_line(p, line_id="L1")

    assert [t.start_ms for t in p.lines[0].tokens] == [1000, 1500, 1800, 2000, 2800, 3200]
    assert not out.warnings
    # 没有真正改动时间的 token 不该被标成手工，否则会白白挡住自动重算
    assert all(not t.locked_timing for t in p.lines[0].tokens)


def test_merge_line_pushes_voice_part_down_to_tokens() -> None:
    """模型有了 token 级声部，被合并行的声部就该完整保留而不是丢掉后回报。"""
    p = _project()
    p.lines[1].voice_part = "duet_b"

    out = ops.merge_line(p, line_id="L1")

    merged = p.lines[0]
    assert merged.voice_part == "main"
    assert [t.voice_part for t in merged.tokens] == [None, None, None, None, "duet_b", "duet_b"]
    assert all(t.locked_voice for t in merged.tokens[4:])
    assert len(out.warnings) == 1
    assert "duet_b" in out.warnings[0]
    # 数据没丢就不该往「失效修正」清单里塞东西，否则用户会学会无视整张清单
    assert p.orphans == []


def test_merge_last_line_rejected() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.merge_line(p, line_id="L2")


def test_split_then_merge_restores_ruby_indices() -> None:
    """拆完再并应当回到原样——注音索引一来一回都算对了才成立。"""
    p = _project()
    before = [(s.start, s.end, s.text) for s in p.lines[0].ruby]
    before_times = [t.start_ms for t in p.lines[0].tokens]

    ops.split_line(p, line_id="L1", token_index=2)
    ops.merge_line(p, line_id="L1")

    assert len(p.lines) == 2
    assert [(s.start, s.end, s.text) for s in p.lines[0].ruby] == before
    assert [t.start_ms for t in p.lines[0].tokens] == before_times


# ---- 声部 ----


def test_set_voice_part_whole_line() -> None:
    p = _project()

    out = ops.set_voice_part(p, line_id="L1", voice_part="duet_a")

    assert p.lines[0].voice_part == "duet_a"
    assert p.lines[0].locked
    assert len(p.lines) == 2
    assert not out.warnings


def test_set_voice_part_token_range_writes_token_fields() -> None:
    """区间指派必须直接写 token 字段：拆行会让这几段各占一个槽位，对唱观感全毁。"""
    p = _project()

    out = ops.set_voice_part(p, line_id="L1", voice_part="duet_b", token_range=(1, 3))

    assert len(p.lines) == 2, "区间指派不得拆行"
    line = p.lines[0]
    assert [t.voice_part for t in line.tokens] == [None, "duet_b", "duet_b", None]
    assert [t.locked_voice for t in line.tokens] == [False, True, True, False]
    assert line.voice_part == "main", "行声部不变，未覆盖的音节继续继承它"
    assert not out.warnings


def test_set_voice_part_range_covering_whole_line_does_not_split() -> None:
    p = _project()

    ops.set_voice_part(p, line_id="L1", voice_part="duet_a", token_range=(0, 4))

    assert len(p.lines) == 2
    assert p.lines[0].voice_part == "duet_a"
    assert all(t.voice_part is None for t in p.lines[0].tokens), "整行选中写成行属性即可"


def test_set_voice_part_range_keeps_ruby_intact() -> None:
    """不再拆行，注音索引就不必迁移，也就不会有跨分界的注音被丢掉。"""
    p = _project()
    before = [(s.start, s.end, s.text) for s in p.lines[0].ruby]

    ops.set_voice_part(p, line_id="L1", voice_part="duet_b", token_range=(1, 4))

    assert [(s.start, s.end, s.text) for s in p.lines[0].ruby] == before
    assert p.orphans == []


def test_set_voice_part_empty_string_clears_token_override() -> None:
    """指派错了总得有路撤回——再指派一次行声部并不能清掉音节级覆盖。"""
    p = _project()
    ops.set_voice_part(p, line_id="L1", voice_part="duet_b", token_range=(1, 3))

    ops.set_voice_part(p, line_id="L1", voice_part="", token_range=(1, 3))

    assert all(t.voice_part is None for t in p.lines[0].tokens)
    assert not any(t.locked_voice for t in p.lines[0].tokens)


def test_set_voice_part_whole_line_warns_about_token_overrides() -> None:
    """覆盖优先级高于行，不提醒的话用户会以为整行指派坏了。"""
    p = _project()
    ops.set_voice_part(p, line_id="L1", voice_part="duet_b", token_range=(1, 3))

    out = ops.set_voice_part(p, line_id="L1", voice_part="duet_a")

    assert p.lines[0].voice_part == "duet_a"
    assert [t.voice_part for t in p.lines[0].tokens] == [None, "duet_b", "duet_b", None]
    assert out.warnings


def test_set_voice_part_whole_line_rejects_empty() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.set_voice_part(p, line_id="L1", voice_part="")


def test_set_voice_part_range_clamped() -> None:
    p = _project()

    out = ops.set_voice_part(p, line_id="L1", voice_part="duet_b", token_range=(2, 99))

    assert len(p.lines) == 2
    assert [t.voice_part for t in p.lines[0].tokens] == [None, None, "duet_b", "duet_b"]
    assert out.warnings


# ---- 寻址错误 ----


def test_unknown_line_raises() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.shift(p, scope="line", delta_ms=10, line_id="nope")


def test_token_index_out_of_range_raises() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.set_timing(p, line_id="L1", token_index=99, start_ms=0)


def test_shift_scope_line_requires_line_id() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.shift(p, scope="line", delta_ms=10)


# ---- 批量调轴 ----


def test_set_timings_applies_every_item() -> None:
    """tap-to-time 一遍打完整行：整批一次写入，结果与逐个设定一致。"""
    p = _project()

    ops.set_timings(
        p,
        items=[
            TimingItem(line_id="L1", token_index=0, start_ms=900, dur_ms=600),
            TimingItem(line_id="L1", token_index=1, start_ms=1500, dur_ms=400),
            TimingItem(line_id="L1", token_index=2, start_ms=1900, dur_ms=300),
            TimingItem(line_id="L1", token_index=3, start_ms=2200, dur_ms=500),
        ],
    )

    line = p.lines[0]
    assert [(t.start_ms, t.dur_ms) for t in line.tokens] == [
        (900, 600),
        (1500, 400),
        (1900, 300),
        (2200, 500),
    ]
    assert all(t.timing_source == "manual" and t.locked_timing for t in line.tokens)
    _assert_monotonic(line)


def test_set_timings_spans_multiple_lines() -> None:
    p = _project()

    ops.set_timings(
        p,
        items=[
            TimingItem(line_id="L1", token_index=3, dur_ms=500),
            TimingItem(line_id="L2", token_index=0, start_ms=2900),
        ],
    )

    assert p.lines[0].tokens[3].dur_ms == 500
    assert p.lines[1].tokens[0].start_ms == 2900
    assert p.lines[1].tokens[0].locked_timing


def test_set_timings_is_one_undo_unit(tmp_path: Path) -> None:
    """一次操作占 N 步撤销就违反 §8：用户想撤回"刚才那一下"得按住 Ctrl+Z 不放。"""
    store = ProjectStore(root=tmp_path)
    created = store.create()
    store.mutate(created.id, lambda d: d.lines.extend(_project().lines))
    depth_before, _ = store.history_depth(created.id)

    items = [TimingItem(line_id="L1", token_index=i, dur_ms=150) for i in range(4)]
    store.mutate(created.id, lambda d: ops.set_timings(d, items=items))

    assert store.history_depth(created.id)[0] == depth_before + 1

    restored = store.undo(created.id)
    assert [t.dur_ms for t in restored.lines[0].tokens] == [500, 300, 200, 400], (
        "一次撤销要把整批还原干净"
    )


def test_set_timings_rejects_whole_batch_on_bad_item(tmp_path: Path) -> None:
    """半批生效比整批失败糟得多：轴改了一半，撤销栈里却没有对应的那一格。"""
    store = ProjectStore(root=tmp_path)
    created = store.create()
    store.mutate(created.id, lambda d: d.lines.extend(_project().lines))
    depth_before, _ = store.history_depth(created.id)

    items = [
        TimingItem(line_id="L1", token_index=0, dur_ms=200),
        TimingItem(line_id="L1", token_index=99, dur_ms=200),
    ]
    with pytest.raises(ops.EditError):
        store.mutate(created.id, lambda d: ops.set_timings(d, items=items))

    project = store.get(created.id)
    assert [t.dur_ms for t in project.lines[0].tokens] == [500, 300, 200, 400]
    assert store.history_depth(created.id)[0] == depth_before


def test_set_timings_empty_batch_rejected() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.set_timings(p, items=[])


# ---- 锁定开关 ----


def test_set_locks_sets_and_clears_timing_lock() -> None:
    p = _project()

    ops.set_locks(p, items=[LockItem(line_id="L1", token_index=1, locked=True)])
    assert p.lines[0].tokens[1].locked_timing

    ops.set_locks(p, items=[LockItem(line_id="L1", token_index=1, locked=False)])
    assert not p.lines[0].tokens[1].locked_timing


def test_set_locks_does_not_fake_manual_source() -> None:
    """只钉住边界不等于改了值。标成 manual 会伪造来源，§7.4 的来源配色就失去依据。"""
    p = _project()

    ops.set_locks(p, items=[LockItem(line_id="L1", token_index=0, locked=True)])

    tok = p.lines[0].tokens[0]
    assert tok.locked_timing
    assert tok.timing_source == "provider", "值没变，来源就没变"
    assert (tok.start_ms, tok.dur_ms) == (1000, 500)


def test_set_locks_batches_across_lines() -> None:
    p = _project()

    ops.set_locks(
        p,
        items=[
            LockItem(line_id="L1", token_index=0),
            LockItem(line_id="L1", token_index=3),
            LockItem(line_id="L2", token_index=1),
        ],
    )

    assert [t.locked_timing for t in p.lines[0].tokens] == [True, False, False, True]
    assert [t.locked_timing for t in p.lines[1].tokens] == [False, True]


def test_set_locks_toggles_ruby_lock() -> None:
    p = _project()

    ops.set_locks(
        p, items=[LockItem(line_id="L1", target="ruby", ruby_range=(0, 1), locked=True)]
    )

    assert p.lines[0].ruby[0].locked
    assert not p.lines[0].ruby[1].locked, "只动被点名的那一段"


def test_set_locks_ruby_requires_exact_range() -> None:
    """注音区间彼此不重叠，模糊匹配在相邻两段之间没有确定答案，锁错更难发现。"""
    p = _project()

    with pytest.raises(ops.EditError):
        ops.set_locks(p, items=[LockItem(line_id="L1", target="ruby", ruby_range=(0, 2))])


def test_set_locks_timing_requires_token_index() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.set_locks(p, items=[LockItem(line_id="L1")])


def test_set_locks_rejects_out_of_range_token() -> None:
    p = _project()

    with pytest.raises(ops.EditError):
        ops.set_locks(p, items=[LockItem(line_id="L1", token_index=99)])


# ---- 配色模板 ----


def _palettes() -> dict[str, PaletteDTO]:
    return {"main": PaletteDTO(name="main", sung_fill="&H0000FF00&")}


def test_builtin_palette_templates_are_complete() -> None:
    """内置至少三套，且每套都要给齐对唱声部——只给 main 的话一碰对唱就得自己配色。"""
    builtin = ops.builtin_palette_templates()

    assert len(builtin) >= 3
    assert {"NicoKara 经典白蓝", "高对比黄黑", "柔和粉白"} <= {t.name for t in builtin}
    for tpl in builtin:
        assert tpl.builtin
        assert {"main", "duet_a", "duet_b"} <= set(tpl.palettes)
        for pal in tpl.palettes.values():
            # 一个声部要四个颜色：描边跟着填充一起翻色，两层各需一组
            assert pal.unsung_fill and pal.unsung_outline
            assert pal.sung_fill and pal.sung_outline


def test_builtin_templates_are_fresh_copies() -> None:
    """调用方改坏了不能污染下一次。"""
    ops.builtin_palette_templates()[0].palettes["main"].sung_fill = "&H00000000&"

    assert ops.builtin_palette_templates()[0].palettes["main"].sung_fill != "&H00000000&"


def test_save_and_list_user_template(tmp_path: Path) -> None:
    path = tmp_path / "palettes.json"

    ops.save_palette_template("我的粉色", _palettes(), description="自用", path=path)
    names = [t.name for t in ops.load_palette_templates(path)]

    assert "我的粉色" in names
    assert names[: len(ops.builtin_palette_templates())] == [
        t.name for t in ops.builtin_palette_templates()
    ], "内置在前"


def test_user_template_survives_reload(tmp_path: Path) -> None:
    """配色调完刷新就丢，正是这次要补的缺口。"""
    path = tmp_path / "palettes.json"
    ops.save_palette_template("我的粉色", _palettes(), path=path)

    loaded = next(t for t in ops.load_palette_templates(path) if t.name == "我的粉色")

    assert loaded.palettes["main"].sung_fill == "&H0000FF00&"
    assert loaded.builtin is False


def test_save_template_overwrites_same_name(tmp_path: Path) -> None:
    path = tmp_path / "palettes.json"
    ops.save_palette_template("我的粉色", _palettes(), path=path)

    ops.save_palette_template(
        "我的粉色", {"main": PaletteDTO(name="main", sung_fill="&H00FF0000&")}, path=path
    )

    hits = [t for t in ops.load_palette_templates(path) if t.name == "我的粉色"]
    assert len(hits) == 1
    assert hits[0].palettes["main"].sung_fill == "&H00FF0000&"


def test_delete_user_template(tmp_path: Path) -> None:
    path = tmp_path / "palettes.json"
    ops.save_palette_template("我的粉色", _palettes(), path=path)

    ops.delete_palette_template("我的粉色", path=path)

    assert "我的粉色" not in {t.name for t in ops.load_palette_templates(path)}


def test_delete_builtin_template_rejected(tmp_path: Path) -> None:
    """内置删了就再也拿不回来。"""
    with pytest.raises(ops.EditError):
        ops.delete_palette_template("高对比黄黑", path=tmp_path / "palettes.json")


def test_delete_missing_template_raises_key_error(tmp_path: Path) -> None:
    with pytest.raises(KeyError):
        ops.delete_palette_template("不存在的", path=tmp_path / "palettes.json")


def test_save_template_rejects_builtin_name(tmp_path: Path) -> None:
    with pytest.raises(ops.EditError):
        ops.save_palette_template("柔和粉白", _palettes(), path=tmp_path / "palettes.json")


@pytest.mark.parametrize("bad_name", ["", "   ", "a/b"])
def test_save_template_rejects_unusable_name(bad_name: str, tmp_path: Path) -> None:
    """带斜杠的名字会让 DELETE 的路径段对不上，模板存进去就再也删不掉。"""
    with pytest.raises(ops.EditError):
        ops.save_palette_template(bad_name, _palettes(), path=tmp_path / "palettes.json")


def test_save_template_rejects_empty_palettes(tmp_path: Path) -> None:
    with pytest.raises(ops.EditError):
        ops.save_palette_template("空的", {}, path=tmp_path / "palettes.json")


def test_corrupt_template_file_degrades_to_builtin(tmp_path: Path) -> None:
    """配色是锦上添花的功能，一个坏文件不该让整个样式面板打不开（§2.5 失败要降级）。"""
    path = tmp_path / "palettes.json"
    path.write_text("{ 半截 JSON", encoding="utf-8")

    templates = ops.load_palette_templates(path)

    assert [t.name for t in templates] == [t.name for t in ops.builtin_palette_templates()]


def test_template_write_leaves_no_partial_file(tmp_path: Path) -> None:
    """原子写：临时文件必须换名顶替，不能在目录里留下半截产物。"""
    path = tmp_path / "palettes.json"

    ops.save_palette_template("我的粉色", _palettes(), path=path)

    assert path.exists()
    assert list(tmp_path.glob("*.tmp")) == []
