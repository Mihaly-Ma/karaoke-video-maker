"""ASS 生成器的单元测试：**一行内的多声部分色** 与 **出入场时间编排**。

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

时间编排那一组测的是四条同样"错了才看得出来"的约束：每句都淡入淡出且
一行的各层淡得一模一样；段落头两行同时浮现；引导点与它提示的那句同时出现；
以及**同槽位的一进一出不许在时间上重叠**——槽位只有两个，隔一行就复用同一位置，
前一行还在原地淡出、后一行已经在同一位置淡入的话，两句字会互相穿透，
比硬切还难看。
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
from kvm.pipeline.beat_detect import BeatGrid  # noqa: E402
from kvm.render.ass_builder import (  # noqa: E402
    AssBuilder,
    _find_credit_window,
    _voice_segments,
)

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


# ---- 出入场时间编排 ----


def _ms(stamp: str) -> int:
    """ASS 的 `H:MM:SS.cc` → 毫秒。"""
    h, m, rest = stamp.split(":")
    s, cs = rest.split(".")
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(cs) * 10


_EVENT_RE = re.compile(r"^Dialogue: (\d+),([^,]+),([^,]+),([^,]+),")


def _window(event: str) -> tuple[int, int]:
    """事件的 (Start, End)，毫秒。"""
    m = _EVENT_RE.match(event)
    assert m is not None, event
    return _ms(m.group(2)), _ms(m.group(3))


_FAD_RE = re.compile(r"\\fad\((\d+),(\d+)\)")


def _fad(event: str) -> tuple[int, int] | None:
    m = _FAD_RE.search(event)
    return (int(m.group(1)), int(m.group(2))) if m else None


def _song(
    starts_ms: list[int],
    *,
    dur_ms: int = 2000,
    ruby: bool = False,
    **style_kw: object,
) -> KaraokeProject:
    """多行工程：每行 4 个 token 各 `dur_ms/4` 毫秒，行起点由 `starts_ms` 给定。

    行间距由调用方决定，因为被测的正是"间隔多大算间奏""挤不下时怎么让位"。
    """
    step = dur_ms // 4
    lines = []
    for base in starts_ms:
        tokens = [
            Token(text=chr(ord("あ") + i), start_ms=base + i * step, dur_ms=step)
            for i in range(4)
        ]
        ln = Line(tokens=tokens)
        if ruby:
            ln.ruby = [RubySpan(start=0, end=1, text="い")]
        lines.append(ln)
    style = KaraokeStyle(font_size=40, stagger=False, **style_kw)  # type: ignore[arg-type]
    return KaraokeProject(
        lines=lines,
        style=style,
        palettes=_palettes(),
        video_width=1920,
        video_height=1080,
    )


def _line_windows(ass: str) -> list[tuple[int, int]]:
    """逐行的 `(开始淡入, 完全消失)`，按行序。

    取 layer 0 的 Main 事件：一行的每个声部段各出一个，本组测试的夹具都是
    单声部，所以正好一行一个。**不能按 Start 去重**——段落头两行本来就共用
    同一个 Start，去重会把它们并成一行。
    """
    return [
        _window(e)
        for e in ass.splitlines()
        if e.startswith("Dialogue: 0,") and ",Main,," in e
    ]


def test_every_line_fades_in_and_out() -> None:
    """每句都淡入淡出——不再只给段落首/末行。段内硬切在换句密集处很跳。"""
    project = _song([2000, 6000, 10000], countdown_dots=0, ruby=True)
    st = project.style

    events = [
        e for e in _build(project).splitlines()
        if e.startswith("Dialogue:") and (",Main,," in e or ",Ruby,," in e)
    ]

    assert len(events) == 3 * (2 + 2), "每行 = 主行两层 + 注音两层"
    assert all(_fad(e) == (st.fade_in_ms, st.fade_out_ms) for e in events)


def test_all_layers_of_a_line_share_one_fade() -> None:
    """一行的各层必须淡得一模一样。

    有一层淡得不同步，淡化期间未唱色就会从已唱色底下透出来——
    双层 clip 方案下两层画的是同一段文本，只是颜色不同。
    """
    line = _line([None, "duet_a", "duet_b"])
    line.ruby = [RubySpan(start=0, end=1, text="い"), RubySpan(start=2, end=3, text="は")]
    project = _project(line)

    events = [e for e in _build(project).splitlines() if e.startswith("Dialogue:")]

    assert len(events) == 3 * 2 + 2 * 2
    assert len({(_window(e), _fad(e)) for e in events}) == 1


def test_fade_shrinks_to_fit_a_short_window() -> None:
    """窗口比 fade_in+fade_out 还短时按比例收窄。

    libass 不会自动截断：淡入淡出加起来超过事件时长的话，整行全程挂在
    半透明的爬升段上，永远淡不完。
    """
    project = _song(
        [10000], countdown_dots=0, dur_ms=200,
        lead_in_ms=100, lead_out_ms=100, paragraph_lead_ms=100,
    )
    project.style.fade_in_ms = 900
    project.style.fade_out_ms = 300

    under = _dialogues(_build(project), "Main")[0]

    show, hide = _window(under)
    fi, fo = _fad(under)  # type: ignore[misc]
    assert (fi, fo) == (300, 100), "按 900:300 的比例收窄到 400ms 的窗口里"
    assert fi + fo == hide - show


def test_first_two_lines_of_a_paragraph_appear_together() -> None:
    """开头两句、以及每段间奏之后的两句，要一起出现。

    只提前第一句的话第二句要等第一句开唱才浮现，观众看不到"接下来是这两句"。
    """
    # 第 0 段：0/1/2 行；间隔 21s 后第 1 段：3/4 行
    windows = _line_windows(_build(_song([5000, 8000, 11000, 34000, 37000], countdown_dots=0)))

    assert len(windows) == 5
    assert windows[0][0] == windows[1][0], "开头两句一起出现"
    assert windows[3][0] == windows[4][0], "间奏后的两句一起出现"
    assert windows[2][0] > windows[1][0], "段内第三句仍按常规顺次出现，不跟着并进来"


def test_paragraph_pair_leads_by_paragraph_lead_ms() -> None:
    """段落首两行提前 `paragraph_lead_ms` 出现，而不是只提前 `lead_in_ms`。"""
    project = _song([5000, 8000, 40000, 43000], countdown_dots=0)
    st = project.style

    windows = _line_windows(_build(project))

    assert windows[2][0] == 40000 - st.paragraph_lead_ms
    assert windows[3][0] == windows[2][0]
    # 第二行若走常规路径会晚得多，这里确实是被段落提前量拉早的
    assert windows[2][0] < 43000 - st.max_lead_ms


def test_paragraph_lead_never_overruns_the_previous_line() -> None:
    """间奏刚够 `paragraph_gap_ms` 时，提前量必须被上一句的收尾顶回来。

    否则新段落的两句会在上一句还没唱完（或还没淡完）时压上来。
    """
    st_probe = KaraokeStyle()
    # 间隔恰好等于间奏阈值：3500 < paragraph_lead_ms(4200)，必然触发夹紧
    project = _song([5000, 7000 + st_probe.paragraph_gap_ms], countdown_dots=0)
    st = project.style
    prev_end = 7000

    second_show = _line_windows(_build(project))[1][0]

    assert second_show >= prev_end + st.fade_out_ms + st.slot_gap_ms
    assert second_show > 7000 + st.paragraph_gap_ms - st.paragraph_lead_ms


def test_countdown_dots_light_up_shortly_before_they_start_ticking() -> None:
    """点在第一个点熄灭前 `countdown_lead_ms` 才亮，而不是跟着歌词一起浮现。

    跟着歌词浮现的话，段首提前 4.2s 而熄灭只占最后几拍，点会先亮着不动
    两三秒——读起来只是个静止装饰。
    """
    project = _song([12000, 15000], countdown_dots=3)
    project.beat_grid = BeatGrid(bpm=120.0, beats_ms=[10500, 11000, 11500, 11940, 20000])
    st = project.style

    ass = _build(project)
    dots = _dialogues(ass, "Dot")
    line_show = _line_windows(ass)[0][0]

    assert len(dots) == 3
    first_out = min(_window(d)[1] for d in dots)
    assert all(_window(d)[0] == first_out - st.countdown_lead_ms for d in dots)
    assert first_out - st.countdown_lead_ms > line_show, "点要晚于歌词才亮"
    assert all(_fad(d) == (st.fade_in_ms, 0) for d in dots), (
        "淡入仍然要有，别硬生生跳出来；熄灭则要干脆，不淡出——"
        "那一下'啪'地消失才是拍点的读数"
    )


def test_countdown_dots_never_precede_their_line() -> None:
    """提前量再大也不许早于歌词：歌词还没浮现就先冒三个点，
    观众不知道它们指向哪一句。
    """
    project = _song([12000, 15000], countdown_dots=3, countdown_lead_ms=100_000)

    ass = _build(project)
    line_show = _line_windows(ass)[0][0]

    assert all(_window(d)[0] == line_show for d in _dialogues(ass, "Dot"))


def test_countdown_drops_dots_that_no_longer_fit() -> None:
    """空档挤不下时的降级：先压缩提前量，再从**先熄灭的那一端**丢点。

    剩下的点仍然读得出倒计时，比整组不显示好（§2.5 失败要降级，不能终止）。
    """
    # 间奏只有 1s：歌词被上一句的收尾顶到 4700ms 才浮现，
    # 而三个点的熄灭时刻是 4500/4750/5000 —— 最早那个已经在歌词之前
    project = _song(
        [2000, 5000], dur_ms=2000, countdown_dots=3,
        countdown_min_gap_ms=800, paragraph_gap_ms=800,
        lead_in_ms=300, paragraph_lead_ms=300,
        fade_in_ms=100, fade_out_ms=100, slot_gap_ms=100,
    )

    ass = _build(project)
    dots = _dialogues(ass, "Dot")
    line_show = _line_windows(ass)[1][0]

    assert line_show == 4700
    # 首句（2000ms 开唱、提前量只有 300ms）同样挤不下，只剩最左那一个点
    assert [_window(d) for d in dots] == [(1700, 2000), (4700, 5000), (4700, 4750)], (
        "起亮被压到歌词的浮现时刻；熄灭时刻落在它之前的点被丢掉"
    )
    assert all(show >= line_show for show, _ in [_window(d) for d in dots[1:]])


def test_countdown_dots_extinguish_on_real_beats() -> None:
    """点必须踩在真实拍点上熄灭：固定间隔只是'三个会消失的点'，与音乐无关。"""
    project = _song([12000, 15000], countdown_dots=3)
    beats = [11000, 11500, 12000 - 60, 20000]
    project.beat_grid = BeatGrid(bpm=120.0, beats_ms=[*beats])

    dots = _dialogues(_build(project), "Dot")

    # 最左的点最后熄灭（开唱前一拍），最右的先熄灭
    assert [_window(d)[1] for d in dots] == [11940, 11500, 11000]


def test_countdown_falls_back_to_fixed_interval_without_a_beat_grid() -> None:
    """节拍检测失败不能变成"不显示引导点"（§2.5：失败要降级，不能终止）。"""
    project = _song([12000, 15000], countdown_dots=3)
    st = project.style

    dots = _dialogues(_build(project), "Dot")

    assert len(dots) == 3
    assert [_window(d)[1] for d in dots] == [
        12000 - st.countdown_beat_ms * i for i in range(3)
    ]


def test_same_slot_lines_never_overlap_in_time() -> None:
    """同槽位的一进一出不许重叠——两句字在同一位置互相穿透比硬切还难看。

    因为窗口两端都按"完全消失/开始淡入"计量，这条只需比较窗口本身，
    不必再各自加减淡化时长。
    """
    # 密集歌词：行间几乎没有空档，正是同槽位最容易撞车的情形
    project = _song([2000, 4200, 6400, 8600, 10800, 13000], dur_ms=2000, countdown_dots=0)
    st = project.style

    windows = _line_windows(_build(project))

    for prev, cur in zip(windows, windows[2:], strict=False):  # 隔一行 = 同槽位
        assert cur[0] - prev[1] >= st.slot_gap_ms, (
            f"同槽位重叠：前一行 {prev} 与后一行 {cur}"
        )


def test_fade_out_never_starts_before_the_line_is_sung() -> None:
    """挤位置时前一行可以早退，但下限是"唱完再加一个淡出"。

    按"唱完"去卡的话，最后一个字会一边唱一边褪色。
    """
    project = _song([2000, 4200, 6400, 8600, 10800], dur_ms=2000, countdown_dots=0)
    st = project.style

    windows = _line_windows(_build(project))

    for (_, hide), base in zip(windows, [2000, 4200, 6400, 8600, 10800], strict=True):
        assert hide - st.fade_out_ms >= base + 2000, "淡出不得在最后一个字唱完前开始"


def test_credit_window_does_not_collide_with_any_line() -> None:
    """制作名单窗口按**字幕实际出现/消失**算，不是按开唱时间。

    歌词提前量一改，"按开唱时间近似"立刻和实际脱节，名单会和歌词叠在一起。
    """
    project = _song([3000, 6000, 40000, 43000], countdown_dots=0)
    project.title = "赤春花"
    project.artist = "sumika"

    ass = _build(project)
    title = _dialogues(ass, "Title")
    assert len(title) == 1
    c0, c1 = _window(title[0])

    for show, hide in _line_windows(ass):
        assert hide <= c0 or show >= c1, f"制作名单 ({c0},{c1}) 撞上歌词 ({show},{hide})"


def test_find_credit_window_uses_the_union_of_line_windows() -> None:
    """行窗口允许互相重叠（同屏两槽位、以及数据结构允许的多声部同唱），
    所以必须先求并集再找空隙；逐对比较会把被后一行覆盖住的"空隙"误判成可用。
    """
    # 第 2 行整个包在第 1 行里：朴素的逐对比较会在 (3000, 20000) 处误报一个大空隙
    assert _find_credit_window([(0, 3000), (1000, 25000), (20000, 30000)]) is None
    assert _find_credit_window([(0, 3000), (1000, 12000), (20000, 30000)]) == (12600, 19400)
