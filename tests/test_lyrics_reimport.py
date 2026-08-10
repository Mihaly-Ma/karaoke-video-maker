"""重新导入歌词：`locked` 感知的合并，而不是整体替换。

这条路径此前是 `draft.lines = parsed.lines` —— 用户调过的轴、改过的注音、
填过的发音形、指派过的声部，连同它们的 `locked` 标记一起被无声抹掉。
CLAUDE.md §4.4 对此的措辞很直白：「静默丢弃 = 用户调了 40 分钟的轴莫名其妙消失」。

用例围绕**真实的重新导入动机**构造，而不是玩具数据：用户重新导入，十有八九是
因为歌词文本本身错了（送假名写法不同、半角空格变成全角读点、漏了一个词），
所以这里的"新歌词"与旧的**只差几个字**——这恰恰是最难的情形：行文本一改，
该行全部 tid 随之改变（tid 的第一维就是行文本 hash），主键重绑会一票都拿不到，
必须靠 §4.4 说的"次要模糊重绑：行内字符偏移"接住。

覆盖三条硬性质：

1. 文本略有差异地重新导入，锁定项仍在、值未被新导入覆盖；
2. 行数与分行都不同、真的绑不上时，锁定项进 `orphans` 且带可读中文说明，
   **不是消失**；
3. 显式「放弃我的修改」路径确实清空——推倒重来是正当诉求，但必须显式。
"""

from __future__ import annotations

import itertools
import re
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.api.schemas import LineDTO, LockItem, ProjectDTO  # noqa: E402
from kvm.editing import ops  # noqa: E402
from kvm.lyrics.importer import line_text, parse_qrc, parse_text, rebase_tids  # noqa: E402

_SEKISHUNKA_QRC = Path(__file__).resolve().parents[1] / "workspace" / "qrc" / "lyric_decrypted.xml"

# 逐字轴 + [kana:] 注音的 QRC 正文。
#
# 首行是被歌词源塞进正文的制作名单（CLAUDE.md §6.1 的实测形态），
# kana 轨里**包含它的汉字**——消费端必须先对全部行做位置展开再判定 credits，
# 顺序反了整首歌注音会整体错位。这里保留这个形态，好让用例踩在真实数据上。
_KANA = "1し1かた1おか1けん1た1さくら1ま1はる1きみ1ふ1きみ1み2うんめい"

_QRC_V1 = f"""[kana:{_KANA}]
[0,400]词(0,100)：(100,50)片(150,80)岡(230,80)健(310,50)太(360,40)
[500,2000]桜(500,600)舞(1100,500)っ(1600,400)て(2000,500)
[2500,2400]春(2500,500) (3000,100)君(3100,500)に(3600,400)触(4000,300)れ(4300,300)る(4600,300)
[5000,2600]ま(5000,300)だ(5300,300)君(5600,400)を(6000,300)見(6300,500)て(6800,300)い(7100,300)る(7400,200)
[7700,1800]運(7700,700)命(8400,600)を(9000,500)
"""

# 同一首歌，**文本略有差异**的另一版：
#
# - 「春 君に触れる」→「春、君にそっと触れる」：半角空格变全角读点 + 多了一个词，
#   注音「触」的字符下标从 4 挪到 7；
# - 「まだ君を見ている」→「まだ君を見てる」：送假名写法不同（§6.1 实测的跨源差异）。
#
# 两行的行文本 hash 都变了 ⇒ 这两行的 tid 全部作废，只能靠字符偏移重绑。
# 汉字的**个数与顺序**没变，所以 kana 轨原样可用。
#
# 第二行的逐字轴也与 v1 略有出入（「っ」提前了 100ms）——换个版本的歌词源本来就会
# 这样，正好用来验证搬回来的锁定时间与新导入的邻居冲突时是谁让路。
_QRC_V2 = f"""[kana:{_KANA}]
[0,400]词(0,100)：(100,50)片(150,80)岡(230,80)健(310,50)太(360,40)
[500,2000]桜(500,600)舞(1100,500)っ(1500,400)て(1900,600)
[2500,2400]春(2500,400)、(2900,100)君(3000,400)に(3400,300)そ(3700,200)っ(3900,100)と(4000,200)触(4200,300)れ(4500,200)る(4700,200)
[5000,2600]ま(5000,300)だ(5300,300)君(5600,400)を(6000,300)見(6300,500)て(6800,400)る(7200,400)
[7700,1800]運(7700,700)命(8400,600)を(9000,500)
"""

# 行数与分行都不同的第三版：整首歌被重写成两行，「運命を」整句消失。
# 用户挂在那一句上的手工成果**没有任何位置可以承接**，只能进「失效修正」清单。
_QRC_V3 = """[kana:1し1かた1おか1けん1た1さくら1ま]
[0,400]词(0,100)：(100,50)片(150,80)岡(230,80)健(310,50)太(360,40)
[500,2000]桜(500,600)舞(1100,500)っ(1600,400)て(2000,500)
[2500,3000]ラ(2500,600)ラ(3100,600)ラ(3700,600)と(4300,600)歌(4900,600)
"""


def _project(qrc: str) -> ProjectDTO:
    return ProjectDTO(id="reimport-test", lines=parse_qrc(qrc))


def _edited_project() -> ProjectDTO:
    """导入 v1 之后走一遍真实的手工收口，每一步都留下 `locked` 标记。

    六项手工成果分别代表契约要求覆盖的六个面：制作名单标记（行级）、时间轴、
    注音、发音形、行内 token 级声部，以及"自动判定被用户推翻"这件事本身。
    """
    project = _project(_QRC_V1)
    credits, _sakura, haru, mada, unmei = project.lines

    # 1. 制作名单误判的手工旁路（§2.5）：这一行自动判成了制作名单，用户说它是正文
    assert credits.is_metadata is True, "前提：首行会被自动判成制作名单"
    ops.set_metadata(project, line_id=credits.id, is_metadata=False)

    # 2. 单词级调轴：把「舞」的起点往后挪 50ms
    ops.set_timing(project, line_id=_sakura.id, token_index=1, start_ms=1150)

    # 3. 注音：歌词源给「触」注的是「ふ」，用户改成「さわ」并锁定
    ops.set_ruby(project, line_id=haru.id, start=4, end=5, text="さわ")

    # 4. 发音形：助词「を」写作 を、唱作 オ（§4.2 要求两份读音同时存在）
    ops.set_phonetic(project, line_id=mada.id, start=3, end=4, text="オ")

    # 5. 当て字：「運命」唱作 さだめ，歌词源的 kana 轨给的是 うんめい
    ops.set_ruby(project, line_id=unmei.id, start=0, end=2, text="さだめ")

    # 6. 行内声部：对唱句一行内男女交替，写在 token 上而不是拆行
    ops.set_voice_part(project, line_id=unmei.id, voice_part="duet_b", token_range=(0, 2))

    return project


def _find_ruby(line: LineDTO, text: str):
    return next((sp for sp in line.ruby if sp.text == text), None)


def _find_phonetic(line: LineDTO, start: int, end: int):
    return next((sp for sp in line.phonetics if (sp.start, sp.end) == (start, end)), None)


# ---------------------------------------------------------------------------
# 性质一：文本略有差异地重新导入，手工成果原样保留
# ---------------------------------------------------------------------------


def test_重新导入保留全部手工修改() -> None:
    project = _edited_project()
    moved_start = project.lines[1].tokens[1].start_ms
    assert moved_start == 1150

    ops.merge_imported_lines(project, parse_qrc(_QRC_V2))

    credits, sakura, haru, mada, unmei = project.lines
    # 文本确实换成了新版
    assert line_text(haru) == "春、君にそっと触れる"
    assert line_text(mada) == "まだ君を見てる"

    # 1. 行级：用户推翻的自动判定没有被重新判回去
    assert credits.is_metadata is False, "自动判定又把这行标成了制作名单，用户的判断被抹掉"
    assert credits.locked is True

    # 2. 时间轴：值与锁一起保留，来源也还是 manual（§7.4 的来源配色靠它）
    assert sakura.tokens[1].start_ms == 1150
    assert sakura.tokens[1].locked_timing is True
    assert sakura.tokens[1].timing_source == "manual"

    # 3. 注音：字符下标从 4 挪到了 7，值不变；歌词源那条「ふ」不得再压在同一位置
    sawa = _find_ruby(haru, "さわ")
    assert sawa is not None, "手工注音「さわ」在重新导入后消失了"
    assert (sawa.start, sawa.end) == (7, 8)
    assert line_text(haru)[sawa.start : sawa.end] == "触"
    assert sawa.locked is True
    assert sawa.source == "manual"
    assert _find_ruby(haru, "ふ") is None, "自动注音压回了用户锁定的位置"

    # 4. 发音形
    o = _find_phonetic(mada, 3, 4)
    assert o is not None and o.text == "オ"
    assert o.locked is True and o.source == "manual"

    # 5. 当て字注音
    sadame = _find_ruby(unmei, "さだめ")
    assert sadame is not None and (sadame.start, sadame.end) == (0, 2)
    assert sadame.locked is True
    assert _find_ruby(unmei, "うんめい") is None

    # 6. token 级声部
    assert [t.voice_part for t in unmei.tokens] == ["duet_b", "duet_b", None]
    assert unmei.tokens[0].locked_voice is True

    assert project.orphans == [], "什么都没丢，不该往失效修正清单里塞东西"


def test_重新导入后没有锁的值一律换成新歌词的() -> None:
    """§4.4 的另一半：自动重算**只跳过 locked=True 的项**，其余该换就换。

    只保不换会走向另一个极端——用户重新导入正是为了修歌词，结果时间轴还是旧的。
    """
    project = _edited_project()

    ops.merge_imported_lines(project, parse_qrc(_QRC_V2))

    mada = project.lines[3]
    # 「見」在两版里时间相同，改看「て」：v1 是 (6800,300)，v2 是 (6800,400)
    te = next(t for t in mada.tokens if t.text == "て")
    assert te.dur_ms == 400, "没锁的时间没有跟着新导入更新"
    assert te.locked_timing is False


def test_重新导入不改变行数与身份键的全局唯一性() -> None:
    project = _edited_project()

    ops.merge_imported_lines(project, parse_qrc(_QRC_V2))

    assert len(project.lines) == 5
    tids = [t.tid for ln in project.lines for t in ln.tokens]
    assert all(tids) and len(tids) == len(set(tids))


def test_合并后行内时间不倒挂且让路的是没锁的那一侧() -> None:
    """用户钉住的边界（1600ms）与新歌词源给「っ」的起点（1500ms）冲突。

    这在换歌词源版本时是常态。让路的必须是新导入的那一侧——去动锁定值就等于
    把用户的手工调整又平掉了一次，只是这次换了个更隐蔽的借口。
    """
    project = _project(_QRC_V1)
    sakura = project.lines[1]
    ops.set_locks(
        project,
        items=[LockItem(line_id=sakura.id, target="timing", token_index=1, locked=True)],
    )
    pinned = sakura.tokens[1].model_copy(deep=True)
    assert pinned.start_ms + pinned.dur_ms == 1600

    ops.merge_imported_lines(project, parse_qrc(_QRC_V2))

    tokens = project.lines[1].tokens
    for a, b in itertools.pairwise(tokens):
        assert a.start_ms + a.dur_ms <= b.start_ms, "合并后出现时间倒挂"
    assert tokens[1].locked_timing is True
    assert (tokens[1].start_ms, tokens[1].dur_ms) == (pinned.start_ms, pinned.dur_ms), (
        "为了消解冲突去动了用户锁定的值"
    )
    assert tokens[2].start_ms == 1600, "让路的应当是新导入的「っ」"


# ---------------------------------------------------------------------------
# 性质二：真的绑不上时进 orphans，不是消失
# ---------------------------------------------------------------------------


def test_分行完全不同时绑不上的锁定项进失效修正清单() -> None:
    project = _edited_project()

    ops.merge_imported_lines(project, parse_qrc(_QRC_V3))

    assert len(project.lines) == 3, "新歌词只有三行"
    assert project.orphans, "整句消失的手工成果被静默丢弃了"

    kinds = {o.kind for o in project.orphans}
    assert {"ruby", "voice_part"} <= kinds, f"清单里缺了条目：{kinds}"

    # 两条手工注音都在，且说明里带着原文——用户看「运命」能立刻认出是哪个词，
    # 看"第 5 行字符 0-2"还得回去数
    details = [o.detail for o in project.orphans if o.kind == "ruby"]
    assert any("さわ" in d and "触" in d for d in details), details
    assert any("さだめ" in d and "運命" in d for d in details), details

    ruby_orphan = next(o for o in project.orphans if o.payload.get("text") == "さだめ")
    assert ruby_orphan.payload["base"] == "運命"
    assert ruby_orphan.payload["locked"] is True

    voice_orphan = next(o for o in project.orphans if o.kind == "voice_part")
    assert "duet_b" in voice_orphan.detail
    assert voice_orphan.payload["tid"], "payload 里没留 tid，用户想重新应用也无从定位"


def test_绑不上的时间轴也进清单且带得回原值() -> None:
    project = _project(_QRC_V1)
    unmei = project.lines[4]
    ops.set_timing(project, line_id=unmei.id, token_index=0, start_ms=7800)

    ops.merge_imported_lines(project, parse_qrc(_QRC_V3))

    timing = [o for o in project.orphans if o.kind == "timing"]
    assert timing, "手工调过的时间在整句消失后被静默丢弃"
    first = timing[0]
    assert "運" in first.detail and "ms" in first.detail
    assert first.payload["start_ms"] == 7800
    assert first.payload["text"] == "運"


def test_歌词整体换成另一首歌时全部锁定项都进清单() -> None:
    """极端情形：新旧毫无关系。此时一条都绑不上，但一条都不能丢。"""
    project = _edited_project()
    before = sum(
        sum(1 for t in ln.tokens if t.locked_timing)
        + sum(1 for t in ln.tokens if t.voice_part is not None)
        + sum(1 for sp in ln.ruby if sp.locked)
        + sum(1 for sp in ln.phonetics if sp.locked)
        for ln in project.lines
    )

    ops.merge_imported_lines(
        project, parse_text("Never gonna give you up\nNever gonna let you down\n")
    )

    assert before > 0
    assert len(project.orphans) >= before, (
        f"手工成果 {before} 项，清单里只有 {len(project.orphans)} 条"
    )
    assert all(o.detail for o in project.orphans), "清单条目没有中文说明"


# ---------------------------------------------------------------------------
# 性质三：显式「放弃我的修改」
# ---------------------------------------------------------------------------


def test_显式放弃修改时整体替换且不留清单() -> None:
    project = _edited_project()

    ops.merge_imported_lines(project, parse_qrc(_QRC_V2), keep_manual_edits=False)

    assert [line_text(ln) for ln in project.lines] == [
        "词：片岡健太",
        "桜舞って",
        "春、君にそっと触れる",
        "まだ君を見てる",
        "運命を",
    ]
    assert project.lines[0].is_metadata is True, "放弃修改后自动判定重新接管"
    assert all(not t.locked_timing for ln in project.lines for t in ln.tokens)
    assert all(not sp.locked for ln in project.lines for sp in ln.ruby)
    assert all(sp.text != "さわ" for ln in project.lines for sp in ln.ruby)
    assert project.orphans == [], "用户明确要求丢弃，不该再让他逐条确认一遍"


def test_放弃修改的回执说清了丢掉多少项() -> None:
    project = _edited_project()

    outcome = ops.merge_imported_lines(project, parse_qrc(_QRC_V2), keep_manual_edits=False)

    assert outcome.warnings, "整体替换是破坏性操作，至少要有一句回执"
    assert "放弃" in outcome.warnings[0]


# ---------------------------------------------------------------------------
# 追加导入（replace=False）
# ---------------------------------------------------------------------------


def test_追加导入不与既有行撞身份键() -> None:
    """同一份内容追加两次，tid 必须仍然全局唯一。

    tid 每次导入都从 0 开始数行出现序号，不重排就会得到两组一模一样的 tid——
    而重绑一旦撞号就会把用户的轴搬到另一段副歌上，**绑错比绑不上更糟**。
    """
    project = _project(_QRC_V1)
    added = parse_qrc(_QRC_V1)

    rebase_tids(project.lines, added)
    project.lines = [*project.lines, *added]

    tids = [t.tid for ln in project.lines for t in ln.tokens]
    assert len(tids) == len(set(tids)), "追加进来的行与既有行撞了 tid"


def test_追加导入不动既有行的任何内容() -> None:
    project = _edited_project()
    before = [ln.model_copy(deep=True) for ln in project.lines]
    added = parse_text("追加的一句\n")

    rebase_tids(project.lines, added)
    project.lines = [*project.lines, *added]

    assert project.lines[: len(before)] == before
    assert project.orphans == []


# ---------------------------------------------------------------------------
# 路由层：POST /api/lyrics/import
# ---------------------------------------------------------------------------


@pytest.fixture
def client_and_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("KVM_DATA_DIR", str(tmp_path / "projects"))
    from fastapi.testclient import TestClient
    from kvm.api.app import app

    with TestClient(app) as client:
        resp = client.post("/api/projects/", json={"title": "重新导入测试"})
        assert resp.status_code == 201, resp.text
        yield client, resp.json()["id"]


def _import(client, project_id: str, content: str, **extra):
    body = {"project_id": project_id, "kind": "qrc", "content": content, **extra}
    resp = client.post("/api/lyrics/import", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_路由默认合并而不是整体替换(client_and_project) -> None:
    client, project_id = client_and_project
    _import(client, project_id, _QRC_V1)

    lines = client.get(f"/api/projects/{project_id}").json()["lines"]
    resp = client.post(
        "/api/editor/ruby",
        json={
            "project_id": project_id,
            "line_id": lines[2]["id"],
            "start": 4,
            "end": 5,
            "text": "さわ",
        },
    )
    assert resp.status_code == 200, resp.text

    after = _import(client, project_id, _QRC_V2)

    haru = after["lines"][2]
    assert "".join(t["text"] for t in haru["tokens"]) == "春、君にそっと触れる"
    sawa = next((sp for sp in haru["ruby"] if sp["text"] == "さわ"), None)
    assert sawa is not None, "重新导入把用户的手工注音抹掉了"
    assert (sawa["start"], sawa["end"]) == (7, 8)
    assert sawa["locked"] is True


def test_路由上的放弃修改开关(client_and_project) -> None:
    client, project_id = client_and_project
    _import(client, project_id, _QRC_V1)
    lines = client.get(f"/api/projects/{project_id}").json()["lines"]
    client.post(
        "/api/editor/ruby",
        json={
            "project_id": project_id,
            "line_id": lines[2]["id"],
            "start": 4,
            "end": 5,
            "text": "さわ",
        },
    )

    after = _import(client, project_id, _QRC_V2, keep_manual_edits=False)

    assert all(sp["text"] != "さわ" for ln in after["lines"] for sp in ln["ruby"]), (
        "显式放弃后手工注音应当消失"
    )
    assert after["orphans"] == []


def test_重新导入占一格撤销可以整体退回(client_and_project) -> None:
    """§8：重跑是**一个** undo 单元。按错了「放弃我的修改」必须能一步退回去。"""
    client, project_id = client_and_project
    _import(client, project_id, _QRC_V1)
    lines = client.get(f"/api/projects/{project_id}").json()["lines"]
    client.post(
        "/api/editor/ruby",
        json={
            "project_id": project_id,
            "line_id": lines[2]["id"],
            "start": 4,
            "end": 5,
            "text": "さわ",
        },
    )
    _import(client, project_id, _QRC_V2, keep_manual_edits=False)

    resp = client.post(f"/api/projects/{project_id}/undo")
    assert resp.status_code == 200, resp.text

    restored = resp.json()
    assert any(sp["text"] == "さわ" for ln in restored["lines"] for sp in ln["ruby"]), (
        "撤销没有把手工注音带回来"
    )


# ---------------------------------------------------------------------------
# 重复副歌：**绑错比绑不上更糟**
# ---------------------------------------------------------------------------

# 「あいう」唱三遍，时间各不相同。这是 tid 的软肋：tid 的行维是
# `(行文本 hash, 该文本在全曲的第几次出现)`，第一遍一旦被改写，后两遍的出现序号
# 就整体前移一位——老的第 1 遍拿着 `hash.0`，而新导入里 `hash.0` 已经是第 2 遍了。
_CHORUS_V1 = """[0,1000]あ(0,300)い(300,300)う(600,400)
[2000,1000]さ(2000,300)く(2300,300)ら(2600,400)
[4000,1000]あ(4000,300)い(4300,300)う(4600,400)
[6000,1000]こ(6000,300)こ(6300,300)ろ(6600,400)
[8000,1000]あ(8000,300)い(8300,300)う(8600,400)
"""

# 只把**第一遍**改成长音写法，后两遍一字不动
_CHORUS_V2 = """[0,1200]あ(0,300)い(300,300)う(600,400)ー(1000,200)
[2000,1000]さ(2000,300)く(2300,300)ら(2600,400)
[4000,1000]あ(4000,300)い(4300,300)う(4600,400)
[6000,1000]こ(6000,300)こ(6300,300)ろ(6600,400)
[8000,1000]あ(8000,300)い(8300,300)う(8600,400)
"""


def test_重复副歌被改写一句后其余几遍不会被错绑() -> None:
    """用户在第 1 遍副歌调的轴，绝不能被搬到第 3 遍上。

    绑错比绑不上更糟：绑不上还会进「失效修正」清单让用户看见，绑错则是悄悄
    把他的判断挪到了别处，而两段副歌的歌词一模一样，肉眼根本发现不了。
    """
    project = _project(_CHORUS_V1)
    for line in project.lines:
        for tok in line.tokens:
            tok.locked_timing = True
            tok.timing_source = "manual"
            tok.start_ms += 7  # 留个可核对的手工痕迹

    ops.merge_imported_lines(project, parse_qrc(_CHORUS_V2))

    starts = [[t.start_ms for t in ln.tokens] for ln in project.lines]
    assert starts[0][:3] == [7, 307, 607]
    assert starts[2] == [4007, 4307, 4607], f"第 2 遍副歌拿到了别人的轴：{starts[2]}"
    assert starts[4] == [8007, 8307, 8607], f"第 3 遍副歌拿到了别人的轴：{starts[4]}"


# ---------------------------------------------------------------------------
# 实测样本回归：赤春花 633 个 token / 178 段注音
# ---------------------------------------------------------------------------


def _lock_everything(project: ProjectDTO) -> int:
    """把整曲每个音节的时间与每段注音都锁死，相当于用户 tap-to-time 打完一整首。"""
    total = 0
    for line in project.lines:
        for tok in line.tokens:
            tok.locked_timing = True
            tok.timing_source = "manual"
            tok.start_ms += 7  # 留个可核对的手工痕迹
            total += 1
        for span in line.ruby:
            span.locked = True
    return total


def _rewrite_lines(qrc: str, count: int) -> str:
    """把前 `count` 行里的「て」改写成「てー」，模拟跨源的送假名/长音写法差异。

    改的是 **QRC 源文本**再重新解析，所以 tid 会跟着行文本 hash 一起真的变掉——
    直接改解析后的 token 文本会留着旧 tid，用例就会假装通过。
    """
    out: list[str] = []
    hit = 0
    for raw_line in qrc.splitlines():
        m = re.match(r"^\[(\d+),(\d+)\](.*)$", raw_line)
        if m and hit < count and "て(" in m.group(3):
            raw_line = raw_line.replace("て(", "てー(", 1)
            hit += 1
        out.append(raw_line)
    assert hit == count, f"样本里只找到 {hit} 行可改写，要求 {count} 行"
    return "\n".join(out)


def _misbound(project: ProjectDTO, expected: list[LineDTO]) -> int:
    """数出"值落到了不该在的位置"的音节。

    新旧两版除被改写的那几行外时间完全一致，而工程里每个音节都被 +7ms，
    所以正确的结果必然是"每个音节 = 它自己那一版的时间 + 7"。对不上就是错绑。
    """
    bad = 0
    for line, want in zip(project.lines, expected, strict=True):
        for tok, ref in zip(line.tokens, want.tokens, strict=True):
            if tok.locked_timing and tok.start_ms != ref.start_ms + 7:
                bad += 1
    return bad


@pytest.mark.skipif(not _SEKISHUNKA_QRC.is_file(), reason="缺少实测样本 workspace/qrc/")
def test_实测样本上一字不改地重新导入不丢任何手工成果() -> None:
    raw = _SEKISHUNKA_QRC.read_text(encoding="utf-8")
    project = ProjectDTO(id="sekishunka", lines=parse_qrc(raw))
    total = _lock_everything(project)
    rubies = sum(len(ln.ruby) for ln in project.lines)
    assert (total, rubies) == (633, 178)

    ops.merge_imported_lines(project, parse_qrc(raw))

    assert sum(1 for ln in project.lines for t in ln.tokens if t.locked_timing) == total
    assert sum(1 for ln in project.lines for sp in ln.ruby if sp.locked) == rubies
    assert _misbound(project, parse_qrc(raw)) == 0
    assert project.orphans == []


@pytest.mark.skipif(not _SEKISHUNKA_QRC.is_file(), reason="缺少实测样本 workspace/qrc/")
@pytest.mark.parametrize(("rewritten", "min_rebound"), [(1, 632), (5, 628), (20, 613)])
def test_实测样本上改写若干行的写法后重绑命中率(rewritten: int, min_rebound: int) -> None:
    """改写 N 行 ⇒ 那 N 行里被改的音节绑不上，**其余一个都不能掉**，且一个都不能绑错。

    这首歌有 8 组文本完全相同的重复行（「桜舞って宙を舞って宙を舞って」重复 4 次），
    正是最容易错绑的形态：按 tid 定行时实测会有 42 个音节被搬到别的副歌段上。
    """
    raw = _SEKISHUNKA_QRC.read_text(encoding="utf-8")
    variant = _rewrite_lines(raw, rewritten)
    project = ProjectDTO(id="sekishunka", lines=parse_qrc(raw))
    total = _lock_everything(project)

    ops.merge_imported_lines(project, parse_qrc(variant))

    rebound = sum(1 for ln in project.lines for t in ln.tokens if t.locked_timing)
    assert rebound >= min_rebound, f"{total - rebound} 个音节掉出了重绑"
    assert _misbound(project, parse_qrc(variant)) == 0, "有音节的手工时间被搬到了别的位置"
    assert len(project.orphans) == total - rebound, "掉出重绑的项没有全部进清单"


@pytest.mark.skipif(not _SEKISHUNKA_QRC.is_file(), reason="缺少实测样本 workspace/qrc/")
def test_实测样本上用户拆过行之后重新导入仍然绑得回来() -> None:
    """用户把整曲拆成 117 行，重新导入的歌词还是原来的 60 行分行。

    这是 tid 真正不可替代的地方：拆出来的两个半行仍带着**原行**的 tid，
    `#っ#1` 明确指向"本行第 2 个っ"，比任何字符相似度都准。
    """
    raw = _SEKISHUNKA_QRC.read_text(encoding="utf-8")
    project = ProjectDTO(id="sekishunka", lines=parse_qrc(raw))
    total = _lock_everything(project)
    for line in list(project.lines):
        if len(line.tokens) >= 6:
            ops.split_line(project, line_id=line.id, token_index=len(line.tokens) // 2)
    assert len(project.lines) > 100, "前提：确实拆开了很多行"

    ops.merge_imported_lines(project, parse_qrc(raw))

    assert len(project.lines) == 60, "重新导入后应当回到新歌词的分行"
    assert sum(1 for ln in project.lines for t in ln.tokens if t.locked_timing) == total
    assert _misbound(project, parse_qrc(raw)) == 0
    assert project.orphans == []
