"""歌词导入的单元测试，重点是 **token 身份键 `tid` 的两条不变式**。

`tid` 的唯一用途是"重新分行之后重新绑定用户的手工修改"（CLAUDE.md §4.4），
由此推出两条硬性质，破一条这个机制就失效：

1. **全局唯一。** 副歌重复行的文本完全相同，只按
   `(行文本hash, surface, 该 surface 在本行第 n 次出现)` 三元组算，
   四行副歌会得到完全相同的一组 tid ——重绑时无从判断该落到哪一行，
   而**绑错行比绑不上更糟**（绑不上还会进「失效修正」清单让用户确认）。
   所以 tid 多带一维"该行文本在全曲的第几次出现"。
2. **拆行/合并后不变。** 这是重绑的依据本身：tid 只在导入这一刻生成一次，
   之后 `editing.ops` 只搬运 token（`model_copy`），不重算。若拆行后 tid 变了，
   那就等于每次调整分行都把用户的锁定项全部作废。

实测样本（赤春花，633 个 token）在 `workspace/` 下，该目录不随仓库分发，
缺失时相关用例跳过，同样的性质由不依赖外部数据的合成用例兜底。
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.api.schemas import ProjectDTO  # noqa: E402
from kvm.editing import ops  # noqa: E402
from kvm.lyrics.importer import (  # noqa: E402
    line_text,
    parse_import,
    parse_lrc,
    parse_qrc,
    parse_text,
)

_SEKISHUNKA_QRC = Path(__file__).resolve().parents[1] / "workspace" / "qrc" / "lyric_decrypted.xml"

# 副歌重复：三行文本完全相同，且行内还有重复 token（「舞って」出现两次）。
# 这正是旧三元组方案会整组撞车的形态。
_CHORUS_TEXT = """桜舞って宙を舞って
春 君に触れる
桜舞って宙を舞って
夏 君を想う
桜舞って宙を舞って
"""


def _tids(lines) -> list[str]:
    return [tok.tid for ln in lines for tok in ln.tokens]


def _project(lines) -> ProjectDTO:
    return ProjectDTO(id="test-project", lines=lines)


# ---------------------------------------------------------------------------
# 性质一：全局唯一
# ---------------------------------------------------------------------------


def test_tid_unique_across_repeated_chorus_lines() -> None:
    """文本完全相同的重复行，其 token 的 tid 必须互不相同。"""
    lines = parse_text(_CHORUS_TEXT)

    tids = _tids(lines)

    assert len(tids) == len(set(tids)), "副歌重复行算出了相同的 tid，重绑会绑错行"


def test_tid_unique_within_line_for_repeated_surface() -> None:
    """同一行内重复出现的 surface 仍靠"本行第 n 次出现"区分（原三元组的性质不能丢）。"""
    lines = parse_lrc("[00:01.00]ゆらゆら\n[00:03.00]ゆらゆら\n")

    tids = _tids(lines)

    assert len(tids) == len(set(tids))


def test_tid_is_deterministic_across_imports() -> None:
    """同一份内容重复导入必须算出同一组 tid ——tid 不含随机成分，
    否则重新导入歌词后再也绑不回原来的手工修改。"""
    first = _tids(parse_text(_CHORUS_TEXT))
    second = _tids(parse_text(_CHORUS_TEXT))

    assert first == second


@pytest.mark.skipif(not _SEKISHUNKA_QRC.is_file(), reason="缺少实测样本 workspace/qrc/")
def test_tid_unique_on_real_qrc_sample() -> None:
    """实测回归：赤春花 633 个 token 的 tid 全局唯一。

    该曲有 8 组重复行文本，其中「桜舞って宙を舞って宙を舞って」重复 4 次；
    旧三元组方案下 633 个 token 只能算出 508 个不同的 tid。
    """
    lines = parse_qrc(_SEKISHUNKA_QRC.read_text(encoding="utf-8"))
    tids = _tids(lines)

    assert len(tids) == 633
    duplicated = [tid for tid, count in Counter(tids).items() if count > 1]
    assert not duplicated, f"{len(duplicated)} 个 tid 在全曲范围内重复"


@pytest.mark.skipif(not _SEKISHUNKA_QRC.is_file(), reason="缺少实测样本 workspace/qrc/")
def test_real_qrc_sample_has_duplicated_line_texts() -> None:
    """守住上面那条用例的前提：样本里确实存在文本完全相同的重复行。

    若哪天换了样本、重复行没了，上一条用例会退化成"什么都没检验"却依旧通过。
    """
    lines = parse_qrc(_SEKISHUNKA_QRC.read_text(encoding="utf-8"))

    texts = Counter(line_text(ln) for ln in lines)

    assert any(count > 1 for count in texts.values())


# ---------------------------------------------------------------------------
# 性质二：拆行 / 合并后 tid 不变
# ---------------------------------------------------------------------------


def test_tid_survives_split_and_merge() -> None:
    """走一遍 `ops.split_line` + `ops.merge_line`，tid 序列必须原样保留。

    用两行内容完全相同的 QRC（逐字轴，一行多个 token）构造：既能拆，
    又覆盖了"重复行"这个最容易出问题的形态。
    """
    project = _project(
        parse_import(
            "qrc",
            "[0,2000]桜(0,500)舞(500,500)っ(1000,500)て(1500,500)\n"
            "[2000,2000]桜(2000,500)舞(2500,500)っ(3000,500)て(3500,500)\n",
        )
    )
    before = _tids(project.lines)
    assert len(before) == len(set(before)) == 8

    ops.split_line(project, line_id=project.lines[0].id, token_index=2)
    assert _tids(project.lines) == before, "拆行改变了 tid，用户的锁定项会全部失去依据"

    ops.merge_line(project, line_id=project.lines[0].id)
    after = _tids(project.lines)

    assert after == before, "合并改变了 tid"
    assert len(after) == len(set(after)), "编辑之后 tid 不再全局唯一"
    assert len(project.lines) == 2, "拆完再合应当回到两行"


@pytest.mark.skipif(not _SEKISHUNKA_QRC.is_file(), reason="缺少实测样本 workspace/qrc/")
def test_tid_survives_split_and_merge_on_real_sample() -> None:
    """实测回归：赤春花整曲拆一行再合回去，633 个 tid 不变且仍然全局唯一。"""
    project = _project(parse_qrc(_SEKISHUNKA_QRC.read_text(encoding="utf-8")))
    before = _tids(project.lines)

    index, target = next((i, ln) for i, ln in enumerate(project.lines) if len(ln.tokens) >= 4)
    ops.split_line(project, line_id=target.id, token_index=2)
    assert _tids(project.lines) == before

    ops.merge_line(project, line_id=project.lines[index].id)
    after = _tids(project.lines)

    assert after == before
    assert len(after) == len(set(after)) == 601
    assert len(after) + len(_tids(project.credits)) == 633


def test_qrc_numeric_credit_placeholders_do_not_shift_ruby() -> None:
    content = (
        "[kana:1111111お1き1い]\n"
        "[0,500]lulu. - Mrs. GREEN APPLE(0,500)\n"
        "[500,500]1st Violin：室屋(500,500)\n"
        "[1000,500]2nd Violin：小寺(1000,500)\n"
        "[8000,3000]終(8000,1000)わりが来(9000,1000)たら言(10000,1000)おう"
    )
    lines = parse_qrc(content)
    assert all(line.is_metadata for line in lines[:3])
    assert not lines[3].is_metadata
    text = line_text(lines[3])
    assert [(text[r.start : r.end], r.text) for r in lines[3].ruby] == [
        ("終", "お"),
        ("来", "き"),
        ("言", "い"),
    ]


def test_qrc_invalid_coverage_does_not_attach_shifted_ruby() -> None:
    lines = parse_qrc("[kana:1ひ1つき1ほし]\n[1000,1000]日(1000,500)月(1500,500)")
    assert not lines[0].ruby


@pytest.mark.parametrize(
    ("label", "expected"),
    [("词", "詞"), ("作词", "作詞"), ("编曲", "編曲"), ("监制", "監制"), ("母带", "母帯")],
)
def test_qrc_credit_labels_use_japanese_glyphs(label: str, expected: str) -> None:
    lines = parse_qrc(
        f"[0,500]{label}：(0,100)大森(100,200)元貴(300,200)\n[8000,1000]言葉(8000,1000)"
    )
    assert line_text(lines[0]) == f"{expected}：大森元貴"
    assert [token.start_ms for token in lines[0].tokens] == [0, 100, 300]
    assert [token.dur_ms for token in lines[0].tokens] == [100, 200, 200]
    assert line_text(lines[1]) == "言葉"
    # 日文字形的名单再次导入时仍应被识别为名单。
    normalized = parse_qrc(f"[0,500]{expected}：大森元貴(0,500)\n[8000,1000]言葉(8000,1000)")
    assert normalized[0].is_metadata


def test_loading_legacy_credits_changes_only_labels_and_preserves_identity() -> None:
    from kvm.api.schemas import LineDTO, RubySpanDTO, TokenDTO

    original = LineDTO(
        id="credit",
        tokens=[
            TokenDTO(text="编", start_ms=0, dur_ms=100, tid="old-1"),
            TokenDTO(text="曲：词编", start_ms=100, dur_ms=100, tid="old-2", locked_timing=True),
        ],
        ruby=[RubySpanDTO(start=3, end=4, text="なまえ", locked=True)],
    )
    raw = original.model_dump()
    raw["is_metadata"] = True
    loaded = LineDTO.model_validate(raw)
    assert line_text(loaded) == "編曲：词编"
    assert loaded.id == original.id
    assert loaded.ruby == original.ruby
    assert [
        (token.tid, token.start_ms, token.dur_ms, token.locked_timing) for token in loaded.tokens
    ] == [
        (token.tid, token.start_ms, token.dur_ms, token.locked_timing) for token in original.tokens
    ]
    assert LineDTO.model_validate(loaded.model_dump()) == loaded
    assert line_text(original) == "编曲：词编"


def test_qrc_credit_normalization_does_not_shift_kana_or_change_lyrics() -> None:
    lines = parse_qrc("[kana:1111はな]\n[0,500]词：编词(0,500)\n[8000,1000]花(8000,1000)")
    assert line_text(lines[0]) == "詞：编词"
    assert [(ruby.start, ruby.end, ruby.text) for ruby in lines[1].ruby] == [(0, 1, "はな")]
    sung = parse_qrc("[8000,1000]词：编曲(8000,1000)")
    assert not sung[0].is_metadata
    assert line_text(sung[0]) == "词：编曲"


def test_custom_credit_content_is_not_normalized() -> None:
    project = ProjectDTO(id="custom-credit")
    project.style.credits_text = "词：甲\n编曲：乙"
    restored = ProjectDTO.model_validate_json(project.model_dump_json())
    assert restored.style.credits_text == "词：甲\n编曲：乙"
