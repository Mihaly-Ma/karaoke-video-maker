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

    index, target = next(
        (i, ln) for i, ln in enumerate(project.lines) if len(ln.tokens) >= 4
    )
    ops.split_line(project, line_id=target.id, token_index=2)
    assert _tids(project.lines) == before

    ops.merge_line(project, line_id=project.lines[index].id)
    after = _tids(project.lines)

    assert after == before
    assert len(after) == len(set(after)) == 633
