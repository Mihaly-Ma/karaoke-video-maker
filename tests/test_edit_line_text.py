"""改写行文本（`ops.set_line_text`）的单元测试。

这个操作的难点不是换字符串，而是 **token 是计时单元**：改一个字会让 token 边界
变化，它的时间、注音、发音形与各种 `locked` 标记必须跟过去。所以测试按**改动幅度**
分三档，每一档的正确行为不同：

| 幅度 | 期望 |
|---|---|
| 改一个字 | 其余音节的时间/注音/声部**几乎全部原样保住**，只有被改的那个字重排 |
| 删掉几个字 | 剩下的照旧保住，被删字上的注音进「失效修正」清单 |
| 整行重写 | 大部分绑不上，锁定项进清单——**这是正确结果，不是失败** |

另外必须守住 CLAUDE.md §4.4 的两条底线：绑不上的手工修改绝不静默丢弃；
新打进去的字标 `interpolated` 而不是 provider/aligned（§4.2 禁止伪造粒度）。
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
    PhoneticSpanDTO,
    ProjectDTO,
    RubySpanDTO,
    TokenDTO,
)
from kvm.editing import ops  # noqa: E402

# ---- 夹具 ----


def _tok(text: str, start_ms: int, dur_ms: int) -> TokenDTO:
    return TokenDTO(text=text, start_ms=start_ms, dur_ms=dur_ms, tid=f"L1#{text}#0")


def _project() -> ProjectDTO:
    """一行「桜舞って」，逐字轴首尾相接，「桜」带注音「さくら」、「舞」带「ま」。"""
    line = LineDTO(
        id="L1",
        tokens=[
            _tok("桜", 1000, 500),
            _tok("舞", 1500, 300),
            _tok("っ", 1800, 200),
            _tok("て", 2000, 400),
        ],
        ruby=[
            RubySpanDTO(start=0, end=1, text="さくら"),
            RubySpanDTO(start=1, end=2, text="ま"),
        ],
    )
    return ProjectDTO(id="P1", lines=[line])


def _texts(line: LineDTO) -> list[str]:
    return [t.text for t in line.tokens]


def _assert_monotonic(line: LineDTO) -> None:
    for i, tok in enumerate(line.tokens):
        assert tok.start_ms >= 0, f"第 {i} 个音节起点为负"
        assert tok.dur_ms >= ops.MIN_DUR_MS, f"第 {i} 个音节时长低于下限"


# ---- 一档：改一个字 ----


def test_replace_one_char_keeps_everything_else() -> None:
    """改一个字，其余音节的时间、注音、tid 全部原样保住。

    这是本功能存在的理由：歌词源把「宙」写成别的字时，用户改一个字不应该赔上
    整行已经调好的轴。
    """
    p = _project()

    out = ops.set_line_text(p, line_id="L1", text="桜舞うて")

    line = p.lines[0]
    assert _texts(line) == ["桜", "舞", "う", "て"]
    # 未改动的三个字：时间、来源、tid 一个字节都没动
    assert [(t.start_ms, t.dur_ms) for t in line.tokens][:2] == [(1000, 500), (1500, 300)]
    assert line.tokens[3].start_ms == 2000
    assert line.tokens[3].dur_ms == 400
    assert [t.timing_source for t in line.tokens] == [
        "provider",
        "provider",
        "interpolated",  # 新打进去的字没有实测时间，只能标插值（§4.2）
        "provider",
    ]
    assert line.tokens[0].tid == "L1#桜#0"
    # 改出来的那个字落在被它替换掉的字原来的位置上
    assert line.tokens[2].start_ms == 1800
    assert line.tokens[2].dur_ms == 200
    assert not line.tokens[2].locked_timing
    # 注音跟着字走，一处都没丢
    assert [(sp.start, sp.end, sp.text) for sp in line.ruby] == [
        (0, 1, "さくら"),
        (1, 2, "ま"),
    ]
    assert not p.orphans
    assert out.warnings  # 回执里给出"保住了几个、推算了几个"
    _assert_monotonic(line)


def test_insert_char_borrows_time_from_neighbour() -> None:
    """纯插入没有空位，必须从没锁的邻居那里借时长，而不是造出零时长音节。

    零时长音节会命中 libass #124（行首零时长块让整行卡在 SecondaryColour）。
    """
    p = _project()

    ops.set_line_text(p, line_id="L1", text="桜が舞って")

    line = p.lines[0]
    assert _texts(line) == ["桜", "が", "舞", "っ", "て"]
    assert line.tokens[1].timing_source == "interpolated"
    _assert_monotonic(line)
    # 借时长只动没锁的那一侧，且借出方仍在下限之上
    assert line.tokens[0].dur_ms >= ops.MIN_DUR_MS
    # 注音「桜→さくら」仍在原位，「舞→ま」随着字后移一位
    assert [(sp.start, sp.end, sp.text) for sp in line.ruby] == [
        (0, 1, "さくら"),
        (2, 3, "ま"),
    ]


def test_locked_timing_is_never_touched() -> None:
    """§4.4 的底线：锁定过的时间，任何自动逻辑都不许动它。"""
    p = _project()
    p.lines[0].tokens[0].locked_timing = True
    p.lines[0].tokens[0].timing_source = "manual"

    ops.set_line_text(p, line_id="L1", text="桜が舞って")

    first = p.lines[0].tokens[0]
    assert (first.start_ms, first.dur_ms) == (1000, 500)
    assert first.locked_timing
    assert first.timing_source == "manual"


# ---- 二档：删掉几个字 ----


def test_delete_chars_keeps_survivors_and_orphans_the_lost_ruby() -> None:
    """删掉带注音的字：活下来的照旧保住，被删字上的注音进「失效修正」清单。

    §4.4：**重绑失败的项不得静默丢弃**——静默丢弃等于用户调过的东西莫名其妙消失。
    """
    p = _project()

    ops.set_line_text(p, line_id="L1", text="舞って")

    line = p.lines[0]
    assert _texts(line) == ["舞", "っ", "て"]
    assert [(t.start_ms, t.dur_ms) for t in line.tokens] == [
        (1500, 300),
        (1800, 200),
        (2000, 400),
    ]
    # 「舞→ま」跟着字前移到 0-1，「桜→さくら」所在的字没了
    assert [(sp.start, sp.end, sp.text) for sp in line.ruby] == [(0, 1, "ま")]
    assert [o.kind for o in p.orphans] == ["ruby"]
    assert "さくら" in p.orphans[0].detail
    assert p.orphans[0].payload["base"] == "桜"


def test_locked_phonetic_goes_to_orphans_but_derived_one_does_not() -> None:
    """发音形分两档：锁定过的丢了要进清单，推导出来的重推一遍就回来，不算损失。

    清单只装真的没保住的东西——掺进"其实已经处理好了"的条目会让用户学会无视整张清单。
    """
    p = _project()
    p.lines[0].phonetics = [
        PhoneticSpanDTO(start=0, end=1, text="サクラ", source="manual", locked=True),
        PhoneticSpanDTO(start=1, end=2, text="マ", source="derived", locked=False),
    ]

    ops.set_line_text(p, line_id="L1", text="舞って")

    kinds = [o.kind for o in p.orphans]
    assert kinds.count("phonetic") == 1
    assert "サクラ" in next(o for o in p.orphans if o.kind == "phonetic").detail


# ---- 三档：整行重写 ----


def test_full_rewrite_binds_nothing_and_reports_it() -> None:
    """整行重写：几乎没有东西能对上，锁定项进清单——这是正确结果，不是失败。"""
    p = _project()
    p.lines[0].ruby[0].locked = True

    ops.set_line_text(p, line_id="L1", text="全然違う歌詞")

    line = p.lines[0]
    assert "".join(_texts(line)) == "全然違う歌詞"
    # 没有一个字对得上，全行时间只能插值，且必须落在原来那一行的时间窗口里
    assert all(t.timing_source == "interpolated" for t in line.tokens)
    assert line.tokens[0].start_ms == 1000
    last = line.tokens[-1]
    assert last.start_ms + last.dur_ms == 2400
    assert [o.kind for o in p.orphans] == ["ruby", "ruby"]
    _assert_monotonic(line)


def test_unset_line_stays_unset() -> None:
    """从未打过轴的行改文本后仍是「未打轴」，不许伪造出插值时间。

    `unset` 的语义是"从未定过时"，`interpolated` 是"算出来的"。把待打轴的占位
    标成算出来的，用户就再也认不出哪些字还没打过轴。
    """
    p = ProjectDTO(
        id="P1",
        lines=[
            LineDTO(
                id="L1",
                tokens=[
                    TokenDTO(
                        text="桜舞って",
                        start_ms=0,
                        dur_ms=0,
                        timing_source="unset",
                        timing_granularity="line",
                    )
                ],
            )
        ],
    )

    ops.set_line_text(p, line_id="L1", text="桜舞うて")

    line = p.lines[0]
    # 整行只有一个 token 的（纯文本导入）不擅自切成逐字
    assert _texts(line) == ["桜舞うて"]
    assert line.tokens[0].timing_source == "unset"
    assert line.tokens[0].timing_granularity == "line"


# ---- 切分与校验 ----


def test_ascii_run_stays_one_token() -> None:
    """英文段落整块成词：逐字母切会得到逐字母扫光的滑稽效果（CLAUDE.md §6.2）。"""
    p = _project()

    ops.set_line_text(p, line_id="L1", text="桜舞ってsumika")

    assert _texts(p.lines[0])[-1] == "sumika"


def test_no_change_is_a_no_op() -> None:
    """文本没变就什么都不做：白占一格撤销会让用户按了 Cmd+Z 却什么也没发生。"""
    p = _project()
    before = p.model_dump()

    out = ops.set_line_text(p, line_id="L1", text="桜舞って")

    assert p.model_dump() == before
    assert not out.warnings


@pytest.mark.parametrize("bad", ["", "   ", "桜\n舞って"])
def test_rejects_empty_or_multiline(bad: str) -> None:
    """空文本与换行一律拒绝：删行是并行的事，分行是拆行的事。"""
    p = _project()
    with pytest.raises(ops.EditError):
        ops.set_line_text(p, line_id="L1", text=bad)


def test_unknown_line_raises() -> None:
    p = _project()
    with pytest.raises(ops.EditError):
        ops.set_line_text(p, line_id="nope", text="桜")
