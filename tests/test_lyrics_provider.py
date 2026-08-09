"""歌词候选 `granularity` / `has_ruby` 的三态语义回归测试。

背景（实测发现，2026-08-09）：`/api/lyrics/search` 返回的候选在界面上标"含注音"，
但取回正文预览后 `has_ruby=False`、实际 0 个 ruby ——搜索阶段的这两个字段是**猜的**，
不是真实解析结果。根因在 `kvm.lyrics.qq._to_match()`：QQ 音乐的搜索接口
（smartbox / soso）只给曲目元信息，不含歌词正文，之前却无条件给每条结果标
`granularity="word", has_ruby=True`，把"QQ 音乐这个 provider 理论上支持逐字+
注音"当成了"这一条搜索结果确实有"——这正是 CLAUDE.md §5.2 铁律要防的事：
**粒度可以被提升，不能被伪造**。

修复：`granularity`/`has_ruby` 改成三态。`search()` 阶段确实不知道就诚实给
`"unknown"` / `None`；只有 `fetch()` 解析出正文后才给确定值。这里测的是这套
三态语义在数据结构（`TrackMatch`）、provider 实现（`_to_match`）、API 契约
（`LyricCandidate`）三层都成立，不依赖网络——真实网络回归见下方模块末尾的
`test_qq_search_then_fetch_matches_real_api`（跳过条件见其文档字符串）。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.api.schemas import LyricCandidate  # noqa: E402
from kvm.lyrics.base import ParsedLyric, TrackMatch  # noqa: E402
from kvm.lyrics.qq import QqMusicProvider, _to_match  # noqa: E402
from pydantic import ValidationError  # noqa: E402

# ---------------------------------------------------------------------------
# TrackMatch：默认值必须诚实，不能替 fetch() 打包票
# ---------------------------------------------------------------------------


def test_trackmatch_defaults_are_honestly_unknown() -> None:
    """search 阶段没有额外信息时，`TrackMatch` 的默认值必须是"不知道"，
    不能悄悄退化成某个具体粒度/布尔值——那样任何忘记显式赋值的 provider
    都会在不知情的情况下向用户撒谎。"""
    m = TrackMatch(provider="x", song_id="1", title="t", artist="a")

    assert m.granularity == "unknown"
    assert m.has_ruby is None


def test_parsed_lyric_defaults_stay_concrete() -> None:
    """`ParsedLyric` 是 fetch() 的产物，拿到正文后没有"不知道"的余地，
    默认值理应是具体值而不是 unknown/None（与 TrackMatch 刻意不同）。"""
    p = ParsedLyric()

    assert p.granularity != "unknown"
    assert p.has_ruby is False


# ---------------------------------------------------------------------------
# QqMusicProvider._to_match：回归本次实测发现的 bug 本身
# ---------------------------------------------------------------------------


def test_qq_to_match_does_not_guess_ruby_or_granularity() -> None:
    """核心回归用例：QQ 搜索接口返回的元信息（不含歌词正文）转成 `TrackMatch`
    时，不得声称"含注音/逐字"。旧实现在这里无条件写 `granularity="word",
    has_ruby=True`，是本次修复要根治的撒谎源头。"""
    hit = {
        "songmid": "002x9zUK0KrKXH",
        "name": "赤春花",
        "singer": "sumika/幾田りら",
        "interval": 260,
        "album": "",
    }

    m = _to_match(hit)

    assert m.granularity == "unknown", "搜索阶段不该在没看到正文时就断言粒度"
    assert m.has_ruby is None, "搜索阶段不该在没看到正文时就断言有没有注音"
    assert m.provider == "qq"
    assert m.song_id == "002x9zUK0KrKXH"
    assert m.duration_ms == 260_000


def test_qq_to_match_note_points_to_preview() -> None:
    """诚实标了"不知道"之后，note 里必须告诉用户去哪儿能拿到真实值，
    不能让"不知道"变成死胡同。"""
    hit = {"songmid": "x", "name": "t", "singer": "a", "interval": None, "album": ""}

    m = _to_match(hit)

    assert "preview" in m.note.lower() or "取回" in m.note or "正文" in m.note


# ---------------------------------------------------------------------------
# LyricCandidate（API 契约）：三态必须能装进去、也必须拒绝乱写的值
# ---------------------------------------------------------------------------


def test_lyric_candidate_accepts_unknown_tristate() -> None:
    """API 层必须放行 unknown/None——这是前端用来渲染"未知，需预览确认"
    徽章的信号，不能在 schema 这一层就被强行拍成 True/False 或某个具体粒度。"""
    c = LyricCandidate(provider="qq", song_id="1", title="t", artist="a")

    assert c.granularity == "unknown"
    assert c.has_ruby is None

    dumped = c.model_dump(mode="json")
    assert dumped["granularity"] == "unknown"
    assert dumped["has_ruby"] is None

    # 往返：前端拿到的 JSON 能原样构造回同一个模型，null 不会被吞掉或改写。
    restored = LyricCandidate.model_validate(dumped)
    assert restored.has_ruby is None
    assert restored.granularity == "unknown"


def test_lyric_candidate_rejects_bogus_granularity() -> None:
    """`granularity` 仍是受限的 Literal 集合，"unknown" 是新增的合法值之一，
    不是把这个字段松绑成任意字符串——写错值应该在 API 边界就报错，而不是
    悄悄进入工程数据。"""
    with pytest.raises(ValidationError):
        # 故意传一个 Literal 之外的值来验证运行时校验；静态类型检查会（正确地）
        # 认为这行有类型错误，用 type: ignore 显式承认这是测试的一部分，不是笔误。
        LyricCandidate(
            provider="qq",
            song_id="1",
            title="t",
            artist="a",
            granularity="bogus",  # type: ignore[arg-type]
        )


def test_lyric_candidate_confirmed_values_still_round_trip() -> None:
    """确认过的真实值（fetch() 之后）必须照常工作——三态语义只影响"不知道"
    这一种情况，不能连带破坏原有的 True/False/"word"/"line"/"plain"。"""
    c = LyricCandidate(
        provider="qq", song_id="1", title="t", artist="a", granularity="word", has_ruby=True
    )

    assert c.granularity == "word"
    assert c.has_ruby is True


# ---------------------------------------------------------------------------
# 真实网络回归（可选）：实打 QQ 搜索接口，核对搜索阶段与取回阶段确实不一致
# ---------------------------------------------------------------------------

_RUN_LIVE = os.environ.get("KVM_TEST_LIVE_LYRICS") == "1"


@pytest.mark.skipif(
    not _RUN_LIVE,
    reason="需要真实网络访问 QQ 音乐接口，默认跳过；设 KVM_TEST_LIVE_LYRICS=1 启用",
)
def test_qq_search_then_fetch_matches_real_api() -> None:
    """端到端实测：搜索阶段必须诚实（unknown/None），取回阶段给出与实际
    ruby 数量一致的确定值。用一首已知没有假名注音的纯中文歌（周杰伦《晴天》）
    验证——旧代码在搜索阶段会无条件声称 has_ruby=True，这首歌就是反例。
    """
    provider = QqMusicProvider()
    matches = provider.search("晴天 周杰伦")
    assert matches, "QQ 音乐搜索无结果，可能是网络问题而非本用例要验证的逻辑"

    for m in matches:
        assert m.granularity == "unknown"
        assert m.has_ruby is None

    parsed = provider.fetch(matches[0].song_id)
    ruby_count = sum(len(ln.ruby) for ln in parsed.lines)
    assert parsed.has_ruby == (ruby_count > 0), "has_ruby 必须与实际解析出的 ruby 数量一致"
