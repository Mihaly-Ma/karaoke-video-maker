"""ASS 生成器的单元测试，重点是**一行内的多声部分色**。

关注点不是"能生成 ASS"，而是三条会直接毁掉成片观感的不变式：

1. **单声部行的输出不能因为新增多声部能力而改变。** 绝大多数行只有一个声部，
   这条一破，所有既有成片的渲染结果都会变；测试里表现为"单段行不带区间 clip"。
2. **段与段的 clip 区间必须严丝合缝且互不重叠。** 重叠会让相邻段互相盖住，
   屏幕上是一条颜色错乱的接缝；留空会露出底色形成缝隙。
3. **注音跟随基字所属的声部。** 注音是另一组 Dialogue，不受主行分段 clip 约束，
   颜色只能自己算对；算错的话一行内分色时注音会和它标注的字对不上。

外加两条既有行为的回归保护：`dur_ms<=0` 的 token 必须跳过（QRC 实测存在零时长块，
会触发 libass #124），以及每个 token 一个 `\\t`（不能用一个 `\\t` 扫整行，
那样速度均匀就不是卡拉OK 了）。
"""

from __future__ import annotations

import re
import sys
from itertools import pairwise
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

from kvm.models.karaoke import (  # noqa: E402
    KaraokeProject,
    KaraokeStyle,
    Line,
    RubySpan,
    Token,
    VoicePalette,
)
from kvm.render.ass_builder import AssBuilder, _voice_segments  # noqa: E402

# ---- 夹具 ----

_CHAR_W = 40
"""替身度量里每个字符的宽度。取整数是为了让断言里的坐标可以手算。"""


class _FakeMetrics:
    """等宽的度量替身。

    真的 `LibassMetrics` 要起 ffmpeg 向 libass 实测每个前缀的 advance，
    慢且依赖外部环境；本文件验证的是分段与 clip 的算法，与真实字宽无关。
    """

    def advances(self, text: str, font: object) -> list[int]:
        return [_CHAR_W * (i + 1) for i in range(len(text))]

    def advances_many(self, texts: list[str], font: object) -> list[list[int]]:
        return [self.advances(t, font) for t in texts]


def _palettes() -> dict[str, VoicePalette]:
    """三个声部各一套配色，四个颜色两两不同，便于断言"这段用的是哪套"。"""
    return {
        "main": VoicePalette(
            name="main",
            unsung_fill="&H00FFFFFF&",
            unsung_outline="&H00202020&",
            sung_fill="&H00FF9010&",
            sung_outline="&H00501800&",
        ),
        "duet_a": VoicePalette(
            name="duet_a",
            unsung_fill="&H00EEEEEE&",
            unsung_outline="&H00212121&",
            sung_fill="&H004080FF&",
            sung_outline="&H00102040&",
        ),
        "duet_b": VoicePalette(
            name="duet_b",
            unsung_fill="&H00DDDDDD&",
            unsung_outline="&H00222222&",
            sung_fill="&H00FF40C0&",
            sung_outline="&H00401030&",
        ),
    }


def _project(line: Line) -> KaraokeProject:
    """单行工程。关掉引导点与错开排布，让断言只面对被测行本身。"""
    style = KaraokeStyle(font_size=40, countdown_dots=0, stagger=False)
    return KaraokeProject(
        lines=[line],
        style=style,
        palettes=_palettes(),
        video_width=1920,
        video_height=1080,
    )


def _line(voices: list[str | None], *, line_voice: str = "main") -> Line:
    """按声部列表造一行：每个 token 一个字，各 500ms 顺次排开。"""
    tokens = [
        Token(text=chr(ord("あ") + i), start_ms=1000 + i * 500, dur_ms=500, voice_part=v)
        for i, v in enumerate(voices)
    ]
    return Line(tokens=tokens, voice_part=line_voice)


def _build(project: KaraokeProject) -> str:
    return AssBuilder(project, _FakeMetrics()).build()


def _dialogues(ass: str, style: str) -> list[str]:
    return [ln for ln in ass.splitlines() if ln.startswith("Dialogue:") and f",{style},," in ln]


def _layer(events: list[str], layer: int) -> list[str]:
    return [e for e in events if e.startswith(f"Dialogue: {layer},")]


_CLIP_RE = re.compile(r"\\clip\((\d+),0,(\d+),\d+\)")


def _clips(event: str) -> list[tuple[int, int]]:
    """事件里出现的所有矩形 clip 的 (左界, 右界)，按出现顺序。"""
    return [(int(a), int(b)) for a, b in _CLIP_RE.findall(event)]


def _x0(project: KaraokeProject) -> int:
    """关掉错开排布后行的左边界：整行居中。"""
    width = _CHAR_W * len(project.lines[0].tokens)
    return max(0, (project.video_width - width) // 2)


# ---- 单声部：不能因为新增能力而改变输出 ----


def test_single_voice_line_emits_one_pair_without_range_clip() -> None:
    project = _project(_line([None, None, None, None]))

    events = _dialogues(_build(project), "Main")

    assert len(events) == 2, "单声部行只有一段，仍然是底层 + 顶层两个 Dialogue"
    under, over = events
    assert "\\clip" not in under, "单段行的底层不加区间 clip，否则输出与旧版不再一致"
    assert under.startswith("Dialogue: 0,")
    assert over.startswith("Dialogue: 1,")


def test_single_voice_line_uses_line_palette() -> None:
    project = _project(_line([None, None], line_voice="duet_b"))

    under, over = _dialogues(_build(project), "Main")

    assert "\\1c&H00DDDDDD&\\3c&H00222222&" in under
    assert "\\1c&H00FF40C0&\\3c&H00401030&" in over


def test_sung_layer_has_one_transform_per_token() -> None:
    """每个 token 一个 `\\t`——用一个 `\\t` 扫整行的话速度均匀，就不是卡拉OK 了。"""
    project = _project(_line([None, None, None]))

    _, over = _dialogues(_build(project), "Main")

    assert over.count("\\t(") == 3


def test_zero_duration_token_is_skipped() -> None:
    """QRC 实测存在零时长块，输出零时长动画会触发 libass #124。"""
    line = _line([None, None, None])
    line.tokens[1].dur_ms = 0
    project = _project(line)

    _, over = _dialogues(_build(project), "Main")

    assert over.count("\\t(") == 2


# ---- 一行内多声部：切段 ----


def test_voice_segments_groups_adjacent_tokens() -> None:
    line = _line([None, "duet_a", "duet_a", "duet_b", None])

    assert _voice_segments(line) == [
        (0, 1, "main"),
        (1, 3, "duet_a"),
        (3, 4, "duet_b"),
        (4, 5, "main"),
    ]


def test_voice_segments_token_override_equal_to_line_voice_does_not_split() -> None:
    """显式写成与行声部相同的值不该凭空多切一段——颜色一样，多一段只是白费事件。"""
    line = _line([None, "main", None], line_voice="main")

    assert _voice_segments(line) == [(0, 3, "main")]


def test_multi_voice_line_emits_one_pair_per_segment() -> None:
    project = _project(_line([None, "duet_a", "duet_a", "duet_b"]))

    events = _dialogues(_build(project), "Main")

    assert len(events) == 6, "三段各出底层 + 顶层一对"
    assert [e.split(",")[0] for e in events] == [
        "Dialogue: 0",
        "Dialogue: 1",
        "Dialogue: 0",
        "Dialogue: 1",
        "Dialogue: 0",
        "Dialogue: 1",
    ]


def test_multi_voice_segments_use_their_own_palettes() -> None:
    project = _project(_line([None, "duet_a", "duet_b"]))

    over = _layer(_dialogues(_build(project), "Main"), 1)

    assert "\\1c&H00FF9010&\\3c&H00501800&" in over[0]
    assert "\\1c&H004080FF&\\3c&H00102040&" in over[1]
    assert "\\1c&H00FF40C0&\\3c&H00401030&" in over[2]


def test_multi_voice_underlay_clips_tile_the_line_without_overlap() -> None:
    """底层各段的区间必须严丝合缝：重叠会互相盖住，留空会露出底色。"""
    project = _project(_line([None, "duet_a", "duet_a", "duet_b"]))
    x0 = _x0(project)

    under = _layer(_dialogues(_build(project), "Main"), 0)
    ranges = [_clips(e)[0] for e in under]

    # 首段左界与末段右界放开到画面边缘，免得把首尾字符的描边裁掉
    assert ranges == [
        (0, x0 + _CHAR_W),
        (x0 + _CHAR_W, x0 + _CHAR_W * 3),
        (x0 + _CHAR_W * 3, project.video_width),
    ]
    for (_, prev_right), (next_left, _) in pairwise(ranges):
        assert prev_right == next_left, "相邻段必须首尾相接，既不重叠也不留缝"


def test_multi_voice_sung_sweep_stays_inside_its_segment() -> None:
    """顶层的推进 clip 从本段左界起、最远只到本段右界，不会扫进邻段。"""
    project = _project(_line([None, "duet_a", "duet_a", "duet_b"]))
    x0 = _x0(project)
    bounds = [
        (x0, x0 + _CHAR_W),
        (x0 + _CHAR_W, x0 + _CHAR_W * 3),
        (x0 + _CHAR_W * 3, x0 + _CHAR_W * 4),
    ]

    over = _layer(_dialogues(_build(project), "Main"), 1)

    for event, (left, right) in zip(over, bounds, strict=True):
        clips = _clips(event)
        assert clips[0] == (left, left), "起始 clip 宽度为零：本段还没开始唱"
        assert all(c[0] == left for c in clips), "推进过程中左界固定在本段左界"
        assert max(c[1] for c in clips) == right, "扫到本段右界为止"


def test_multi_voice_each_segment_keeps_per_token_transforms() -> None:
    """分段之后每个 token 仍各有一个 `\\t`，描边同步翻色的实现方式不变。"""
    project = _project(_line([None, "duet_a", "duet_a", "duet_b"]))

    over = _layer(_dialogues(_build(project), "Main"), 1)

    assert [e.count("\\t(") for e in over] == [1, 2, 1]


def test_multi_voice_segments_all_render_full_line_text() -> None:
    """每段画的都是整行文本，只靠 clip 限制可见范围——切文本会让字距与整行排版脱节。"""
    line = _line([None, "duet_a", "duet_b"])
    project = _project(line)

    events = _dialogues(_build(project), "Main")

    for e in events:
        assert e.endswith(line.text)


# ---- 注音跟随基字的声部 ----


def test_ruby_follows_base_character_voice_part() -> None:
    line = _line([None, "duet_a", "duet_b"])
    line.ruby = [
        RubySpan(start=0, end=1, text="い"),
        RubySpan(start=1, end=2, text="ろ"),
        RubySpan(start=2, end=3, text="は"),
    ]
    project = _project(line)

    ruby_over = _layer(_dialogues(_build(project), "Ruby"), 3)

    assert "\\1c&H00FF9010&\\3c&H00501800&" in ruby_over[0]
    assert "\\1c&H004080FF&\\3c&H00102040&" in ruby_over[1]
    assert "\\1c&H00FF40C0&\\3c&H00401030&" in ruby_over[2]


def test_ruby_uses_line_palette_when_no_token_override() -> None:
    line = _line([None, None], line_voice="duet_a")
    line.ruby = [RubySpan(start=1, end=2, text="ろ")]
    project = _project(line)

    ruby = _dialogues(_build(project), "Ruby")

    assert "\\1c&H00EEEEEE&\\3c&H00212121&" in ruby[0]
    assert "\\1c&H004080FF&\\3c&H00102040&" in ruby[1]


# ---- 拆行 ----


def test_wide_line_split_keeps_token_voice_parts() -> None:
    """超宽行会被拆成两行，token 级声部必须跟着走，不能在拆行时丢掉。"""
    n = 60  # 60 字 × 40px = 2400px，超过 1920 减去左右边距后的可用宽度
    voices: list[str | None] = [None] * n
    voices[40] = "duet_b"
    line = _line(voices)
    project = _project(line)

    events = _dialogues(_build(project), "Main")

    # 拆成两行：前半整行同一声部（1 段 = 2 个事件），
    # 后半含 duet_b 的那个 token，被切成 main / duet_b / main 三段（6 个事件）
    assert len(events) == 8
    assert sum("\\1c&H00FF40C0&\\3c&H00401030&" in e for e in events) == 1, (
        "拆行后 duet_b 那一段必须还在——token 级声部不能在拆行时丢掉"
    )
