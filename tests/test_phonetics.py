"""发音形（`reading_phonetic`）这一层的规则。

CLAUDE.md §4.2：**`reading_display` 与 `reading_phonetic` 必须同时存在**。
只存一份是系统性 bug 源——注音行显示成「わ」（应显示「は」），或者对齐器拿着
「は」去找 /h/ 音素而实际唱的是 /w/。

本文件钉死三件事，每一件坏掉的症状都不会在跑一遍出片流程时暴露：

1. **推导只做确定的部分**。长音（「おう」在「王」是长音、在「問う」是两拍）与
   「ん」的音位变体不猜（§9 第 7 项待实测）——猜错会把整句轴带偏，比留空更糟。
2. **助词替换看书写形而不是读音**。「葉(は)」的读音也是 は，但它是名词读 /ha/；
   只看读音就会把它错换成 ワ，而这种错误在注音行上完全看不出来。
3. **自动重算只覆盖 `locked=False` 的项**（§4.4）。用户改过并锁定的发音形，
   重推、拆行、改注音都不得碰——这是"手工修改绝不被覆盖"那条产品承诺的一部分。
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
    PhoneticSpanDTO,
    ProjectDTO,
    RubySpanDTO,
    TokenDTO,
)
from kvm.api.store import ProjectStore  # noqa: E402
from kvm.editing import ops  # noqa: E402
from kvm.models.karaoke import derive_phonetic, to_katakana  # noqa: E402

# ---- 夹具 ----


def _tok(text: str, start_ms: int, dur_ms: int) -> TokenDTO:
    return TokenDTO(text=text, start_ms=start_ms, dur_ms=dur_ms)


def _project() -> ProjectDTO:
    """两行的最小工程，刻意把每一类读音单元都摆进去。

    L1「君は運命を信じる」：注音区间（君/運命/信）、单字助词（は/を）、
    多字假名串（じる）各一。「運命」注音成「さだめ」是日语歌词里的当て字常态，
    正是 §4.5 把歌词源假名轨排在通用词典之上的理由。

    L2「夢を見て」没有注音：两个汉字推不出发音形，用来验证"推不出来就留空"。
    """
    line_a = LineDTO(
        id="L1",
        tokens=[
            _tok("君", 1000, 300),
            _tok("は", 1300, 200),
            _tok("運", 1500, 300),
            _tok("命", 1800, 300),
            _tok("を", 2100, 200),
            _tok("信", 2300, 300),
            _tok("じ", 2600, 200),
            _tok("る", 2800, 400),
        ],
        ruby=[
            RubySpanDTO(start=0, end=1, text="きみ"),
            RubySpanDTO(start=2, end=4, text="さだめ"),
            RubySpanDTO(start=5, end=6, text="しん"),
        ],
    )
    line_b = LineDTO(
        id="L2",
        tokens=[
            _tok("夢", 4000, 400),
            _tok("を", 4400, 200),
            _tok("見", 4600, 300),
            _tok("て", 4900, 300),
        ],
    )
    return ProjectDTO(id="P1", lines=[line_a, line_b])


def _spans(project: ProjectDTO, line_id: str) -> list[tuple[int, int, str]]:
    line = next(ln for ln in project.lines if ln.id == line_id)
    return [(sp.start, sp.end, sp.text) for sp in line.phonetics]


# ---- 推导规则（纯函数） ----


def test_reading_is_normalized_to_katakana() -> None:
    """发音形一律片假名存储：同一个读音不该在字段里存成两种形态。"""
    assert derive_phonetic("さくら", surface="桜") == "サクラ"
    assert derive_phonetic("サクラ", surface="桜") == "サクラ"
    assert to_katakana("がっこう") == "ガッコウ"


def test_particle_is_replaced_only_when_the_surface_is_the_particle() -> None:
    """「は」读 /wa/ 是因为它**是助词**，不是因为它读作 は。

    「葉(は)」的读音一模一样却读 /ha/。只看读音做替换会把它错成 ワ，
    而注音行上完全看不出来——错误要到对齐结果里才暴露。
    """
    assert derive_phonetic("は") == "ワ"
    assert derive_phonetic("へ") == "エ"
    assert derive_phonetic("を") == "オ"
    assert derive_phonetic("は", surface="葉") == "ハ"


def test_particle_rule_does_not_fire_inside_a_kana_run() -> None:
    """「はまだ」里的 は 是词的一部分。没有形态素分析就不该猜词边界。"""
    assert derive_phonetic("はまだ") == "ハマダ"


def test_long_vowel_is_not_guessed() -> None:
    """「おう」在「王」是长音、在「問う」是两拍，纯假名串无法确定性还原。

    这条是**刻意不做**：发音形喂的是强制对齐，猜错会把整句轴带偏（§9 第 7 项）。
    """
    assert derive_phonetic("おう", surface="王") == "オウ"


def test_undeterminable_reading_yields_empty() -> None:
    """含汉字/拉丁字母的"读音"不是读音，没有确定规则能变成假名串。"""
    assert derive_phonetic("明日", surface="明日") == ""
    assert derive_phonetic("sumika", surface="sumika") == ""
    assert derive_phonetic("") == ""


# ---- 批量推导 ----


def test_derive_materializes_one_span_per_reading_unit() -> None:
    """读音单元 = 注音区间 + 注音之间的连续同类字符块，不是 token。

    token 是计时单元、多数只有一个字符，「運命」的 サダメ 无法确定地劈成两半——
    §4.2 说的粒度冲突在这里同样成立。
    """
    p = _project()

    ops.derive_phonetics(p)

    assert _spans(p, "L1") == [
        (0, 1, "キミ"),
        (1, 2, "ワ"),
        (2, 4, "サダメ"),
        (4, 5, "オ"),
        (5, 6, "シン"),
        (6, 8, "ジル"),
    ]
    assert all(sp.source == "derived" and not sp.locked for sp in p.lines[0].phonetics)


def test_derive_leaves_unreadable_units_empty_and_says_so() -> None:
    """未注音的汉字推不出读音就留空，并且**必须让用户知道**有几处要补。"""
    p = _project()

    out = ops.derive_phonetics(p, line_ids=["L2"])

    assert _spans(p, "L2") == [(1, 2, "オ"), (3, 4, "テ")]
    assert any("推导不出" in w for w in out.warnings)
    assert _spans(p, "L1") == [], "只推指定行，其余行不得被顺手改掉"


def test_derive_is_idempotent() -> None:
    """重复推导必须收敛，否则每点一次按钮工程就变一次、撤销栈全是噪声。"""
    p = _project()

    ops.derive_phonetics(p)
    first = _spans(p, "L1")
    ops.derive_phonetics(p)

    assert _spans(p, "L1") == first


def test_derive_never_overwrites_locked_phonetic() -> None:
    """**本文件的核心不变式**：锁定的发音形，自动重算一个字都不能改。

    场景是真实的：「運命」唱作 さだめ，而实际发音带长音（サダメー）——推导规则
    刻意不猜长音，用户补上并锁定之后，再点一次"推导"绝不能把它换回 サダメ。
    """
    p = _project()
    ops.derive_phonetics(p)
    ops.set_phonetic(p, line_id="L1", start=2, end=4, text="サダメー")

    out = ops.derive_phonetics(p)

    span = next(sp for sp in p.lines[0].phonetics if (sp.start, sp.end) == (2, 4))
    assert span.text == "サダメー"
    assert span.source == "manual"
    assert span.locked
    assert any("已锁定" in w for w in out.warnings)
    # 其余单元照常重推，锁定只是局部的硬边界
    assert (1, 2, "ワ") in _spans(p, "L1")


def test_derive_reclaims_unlocked_manual_value() -> None:
    """反过来也要成立：解锁就是"交还给自动"，否则 `locked` 只是个只读徽章。"""
    p = _project()
    ops.derive_phonetics(p)
    ops.set_phonetic(p, line_id="L1", start=2, end=4, text="サダメー")
    ops.set_locks(
        p, items=[LockItem(line_id="L1", target="phonetic", phonetic_range=(2, 4), locked=False)]
    )

    ops.derive_phonetics(p)

    span = next(sp for sp in p.lines[0].phonetics if (sp.start, sp.end) == (2, 4))
    assert span.text == "サダメ"
    assert span.source == "derived"


def test_derive_rejects_unknown_line() -> None:
    p = _project()
    with pytest.raises(ops.EditError):
        ops.derive_phonetics(p, line_ids=["nope"])


# ---- 手工设定 ----


def test_set_phonetic_marks_manual_and_locked() -> None:
    """手填发音形就是为了纠正自动推导，不锁住的话下一次推导原样换回去。"""
    p = _project()

    ops.set_phonetic(p, line_id="L1", start=0, end=1, text="きみ")

    span = p.lines[0].phonetics[0]
    assert (span.start, span.end, span.text) == (0, 1, "キミ"), "手填的也按片假名规范存储"
    assert span.source == "manual"
    assert span.locked


def test_set_phonetic_clear_returns_to_derived_value() -> None:
    """清除的意思是"交还给自动"，不是"留一个空洞"。"""
    p = _project()
    ops.derive_phonetics(p)
    ops.set_phonetic(p, line_id="L1", start=1, end=2, text="ハ")

    out = ops.set_phonetic(p, line_id="L1", start=1, end=2, text="")

    span = next(sp for sp in p.lines[0].phonetics if (sp.start, sp.end) == (1, 2))
    assert (span.text, span.source, span.locked) == ("ワ", "derived", False)
    assert any("推导值" in w for w in out.warnings)


def test_set_phonetic_clear_on_unreadable_unit_leaves_it_empty() -> None:
    """推不出来就该空着，并说清楚"这一段要你自己填"。"""
    p = _project()
    ops.set_phonetic(p, line_id="L2", start=0, end=1, text="ユメ")

    out = ops.set_phonetic(p, line_id="L2", start=0, end=1, text="")

    assert _spans(p, "L2") == []
    assert any("手工填" in w for w in out.warnings)


def test_set_phonetic_overwriting_locked_span_is_recorded_as_orphan() -> None:
    """用户锁过的东西被吃掉必须留痕（§4.4：重绑失败的项不得静默丢弃）。"""
    p = _project()
    ops.set_phonetic(p, line_id="L1", start=2, end=4, text="サダメー")

    out = ops.set_phonetic(p, line_id="L1", start=1, end=5, text="ワサダメーオ")

    assert len(p.orphans) == 1
    assert p.orphans[0].kind == "phonetic"
    assert p.orphans[0].payload["text"] == "サダメー"
    assert out.warnings


def test_set_phonetic_same_range_overwrite_is_not_an_orphan() -> None:
    """改自己刚填的那一条不是损失，进清单只会让清单没人看。"""
    p = _project()
    ops.set_phonetic(p, line_id="L1", start=2, end=4, text="サダメ")

    ops.set_phonetic(p, line_id="L1", start=2, end=4, text="サダメー")

    assert p.orphans == []
    assert _spans(p, "L1") == [(2, 4, "サダメー")]


def test_set_phonetic_warns_on_non_kana() -> None:
    """强制对齐的 vocab 是假名。不拒绝，但得让用户现在就知道这一段可能对不上。"""
    p = _project()

    out = ops.set_phonetic(p, line_id="L1", start=0, end=1, text="kimi")

    assert any("非假名" in w for w in out.warnings)


def test_set_phonetic_range_clamped_to_line() -> None:
    p = _project()

    out = ops.set_phonetic(p, line_id="L1", start=-2, end=99, text="ア")

    assert _spans(p, "L1") == [(0, 8, "ア")]
    assert any("夹进行内范围" in w for w in out.warnings)


def test_set_phonetic_rejects_empty_range() -> None:
    p = _project()
    with pytest.raises(ops.EditError):
        ops.set_phonetic(p, line_id="L1", start=3, end=3, text="ア")


# ---- 锁定 ----


def test_lock_phonetic_sets_and_clears() -> None:
    """§4.4 的 `(value, source, locked)` 只有在用户能自己动 locked 时才成立。"""
    p = _project()
    ops.derive_phonetics(p)

    ops.set_locks(
        p, items=[LockItem(line_id="L1", target="phonetic", phonetic_range=(0, 1), locked=True)]
    )
    assert p.lines[0].phonetics[0].locked
    assert p.lines[0].phonetics[0].source == "derived", "只改锁标记不得伪造来源"

    ops.set_locks(
        p, items=[LockItem(line_id="L1", target="phonetic", phonetic_range=(0, 1), locked=False)]
    )
    assert not p.lines[0].phonetics[0].locked


def test_lock_phonetic_requires_exact_range() -> None:
    """不做"包含即命中"的模糊匹配：锁错一段比锁不上更难被发现。"""
    p = _project()
    ops.derive_phonetics(p)

    with pytest.raises(ops.EditError):
        ops.set_locks(
            p,
            items=[LockItem(line_id="L1", target="phonetic", phonetic_range=(0, 2), locked=True)],
        )


def test_lock_phonetic_requires_range() -> None:
    p = _project()
    with pytest.raises(ops.EditError):
        ops.set_locks(p, items=[LockItem(line_id="L1", target="phonetic")])


# ---- 与注音编辑的联动 ----


def test_set_ruby_refreshes_derived_phonetic() -> None:
    """表记读法一变，由它推出来的发音形立刻过期。

    不刷新就会出现「注音写着 さだめ、发音形还写着 ウンメイ」这种自相矛盾的状态，
    而错的那一份正是喂给对齐器的那一份。
    """
    p = _project()
    ops.derive_phonetics(p)

    ops.set_ruby(p, line_id="L1", start=2, end=4, text="うんめい")

    assert (2, 4, "ウンメイ") in _spans(p, "L1")


def test_set_ruby_does_not_materialize_phonetics_on_a_fresh_project() -> None:
    """发音形层是按需物化的。改个注音就凭空造出半首歌的读音，用户无从判断哪些该复核。"""
    p = _project()

    ops.set_ruby(p, line_id="L1", start=0, end=1, text="きみ")

    assert _spans(p, "L1") == []


def test_set_ruby_keeps_locked_phonetic_and_says_so() -> None:
    """锁定是硬边界，连"注音改了"也不能越过；但要告诉用户为什么它没跟着变。"""
    p = _project()
    ops.derive_phonetics(p)
    ops.set_phonetic(p, line_id="L1", start=2, end=4, text="サダメー")

    out = ops.set_ruby(p, line_id="L1", start=2, end=4, text="うんめい")

    assert (2, 4, "サダメー") in _spans(p, "L1")
    assert any("锁定" in w for w in out.warnings)


# ---- 拆行 / 并行 ----


def test_split_migrates_phonetic_indices() -> None:
    """`start`/`end` 是**行内**字符索引，换了行就必须重算，算错一次就挂到别的字上。"""
    p = _project()
    ops.derive_phonetics(p)

    ops.split_line(p, line_id="L1", token_index=4)

    assert _spans(p, "L1") == [(0, 1, "キミ"), (1, 2, "ワ"), (2, 4, "サダメ")]
    tail = p.lines[1]
    assert [(sp.start, sp.end, sp.text) for sp in tail.phonetics] == [
        (0, 1, "オ"),
        (1, 2, "シン"),
        (2, 4, "ジル"),
    ]


def test_split_rederives_crossing_derived_phonetic_without_orphan() -> None:
    """跨切点的推导值重推一遍就回来了，塞进失效清单只会淹掉真正要处理的条目。"""
    p = _project()
    ops.derive_phonetics(p)

    ops.split_line(p, line_id="L1", token_index=7)

    assert p.orphans == []
    assert (6, 7, "ジ") in _spans(p, "L1")
    assert [(sp.start, sp.end, sp.text) for sp in p.lines[1].phonetics] == [(0, 1, "ル")]


def test_split_records_crossing_locked_phonetic_as_orphan() -> None:
    """锁定的发音形是用户的劳动成果，跨越分界后必须让他知道（§4.4）。"""
    p = _project()
    ops.derive_phonetics(p)
    ops.set_phonetic(p, line_id="L1", start=3, end=5, text="メオ")

    ops.split_line(p, line_id="L1", token_index=4)

    assert [o.kind for o in p.orphans] == ["phonetic"]
    assert p.orphans[0].payload["text"] == "メオ"


def test_merge_reindexes_phonetics() -> None:
    """并行时后一行的区间要整体后移前一行的字符数。"""
    p = _project()
    ops.derive_phonetics(p)

    ops.merge_line(p, line_id="L1")

    assert _spans(p, "L1")[-2:] == [(9, 10, "オ"), (11, 12, "テ")]


def test_merge_does_not_materialize_when_both_lines_are_empty() -> None:
    p = _project()

    ops.merge_line(p, line_id="L1")

    assert _spans(p, "L1") == []


# ---- 持久化与向后兼容 ----


def test_locked_phonetic_survives_reload_and_rederive(tmp_path: Path) -> None:
    """真正要防的场景：用户改完读音、关掉工具，回来重跑一次推导就全没了。"""
    store = ProjectStore(root=tmp_path)
    created = store.create(title="t")
    store.mutate(created.id, lambda d: d.lines.extend(_project().lines))
    store.mutate(created.id, lambda d: ops.derive_phonetics(d))
    store.mutate(
        created.id,
        lambda d: ops.set_phonetic(d, line_id="L1", start=2, end=4, text="サダメー"),
    )

    reopened = ProjectStore(root=tmp_path)
    project = reopened.get(created.id)
    assert (2, 4, "サダメー") in _spans(project, "L1")

    after = reopened.mutate(created.id, lambda d: ops.derive_phonetics(d))

    assert (2, 4, "サダメー") in _spans(after, "L1")


def test_phonetic_edit_is_one_undo_unit(tmp_path: Path) -> None:
    """手填发音形是用户意图，占一格撤销（后台产物才走 `update_derived`，§8）。"""
    store = ProjectStore(root=tmp_path)
    created = store.create()
    store.mutate(created.id, lambda d: d.lines.extend(_project().lines))
    depth_before, _ = store.history_depth(created.id)

    store.mutate(
        created.id, lambda d: ops.set_phonetic(d, line_id="L1", start=0, end=1, text="キミ")
    )
    assert store.history_depth(created.id)[0] == depth_before + 1

    restored = store.undo(created.id)
    assert _spans(restored, "L1") == []


def test_old_project_json_without_phonetics_loads() -> None:
    """老工程 JSON 缺这个字段要能正常读——本模型一贯用默认值兼容，不写迁移函数。"""
    raw = (
        '{"id":"P0","lines":[{"id":"L1","tokens":[{"text":"桜","start_ms":0,"dur_ms":100}],'
        '"ruby":[{"start":0,"end":1,"text":"さくら"}]}]}'
    )

    project = ProjectDTO.model_validate_json(raw)

    assert project.lines[0].phonetics == []
    ops.derive_phonetics(project)
    assert _spans(project, "L1") == [(0, 1, "サクラ")]


def test_phonetics_are_not_written_into_the_ruby_list() -> None:
    """发音形绝不能混进 `ruby`：渲染层会把 `ruby` 里的每一条都排版到成片上。"""
    p = _project()
    ops.derive_phonetics(p)
    ops.set_phonetic(p, line_id="L1", start=1, end=2, text="ワ")

    assert [(sp.start, sp.end, sp.text) for sp in p.lines[0].ruby] == [
        (0, 1, "きみ"),
        (2, 4, "さだめ"),
        (5, 6, "しん"),
    ]
    assert all(isinstance(sp, PhoneticSpanDTO) for sp in p.lines[0].phonetics)
