"""ASS 生成器：把工程文件序列化为 libass 可渲染的字幕。

工程文件是唯一真源，ASS 只是渲染目标，**永远不被反向解析回来**（CLAUDE.md §4.1）。

## 描边同步翻色的实现

日式 nicokara 的招牌观感是填充与描边**一起**翻色。ASS 的 `\\kf` 只扫填充，
描边不动。所以这里用"双层 + 渐进 clip"：

- 底层 Dialogue：整行画未唱色（含未唱描边）
- 顶层 Dialogue：整行画已唱色（含已唱描边），再用一个**逐字推进的矩形 clip**
  把它一点点露出来

关键在于**不能用一个 `\\t` 扫完整行**——那样速度均匀，不是卡拉OK。
必须每个 token 一个 `\\t`，clip 从上一个 token 的右边界扫到本 token 的右边界，
各自按自己的时长。这要求知道每个字的精确 x 坐标，由 `text_metrics` 提供。

`\\t` 内的矩形 `\\clip` 动画已实测可用（CLAUDE.md §9 P0-1 结项）。

## 坐标策略

一律用 `\\an7`（左上）+ 显式 `\\pos`，自己算居中，而不是用 `\\an2` 让 libass 居中。
因为 clip 用的是**绝对屏幕坐标**，必须由我们掌握行的确切 x 范围。
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise

from kvm.models.karaoke import KaraokeProject, Line, RubySpan
from kvm.render.text_metrics import FontSpec, LibassMetrics

_HEADER_TMPL = """[Script Info]
; 由 karaoke-video-maker 生成 —— 请勿手工编辑，改动会在下次生成时丢失
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
LayoutResX: {w}
LayoutResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{font},{size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,{bold},0,0,0,100,100,0,0,1,{outline},{shadow},7,0,0,0,1
Style: Ruby,{font},{ruby_size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,{bold},0,0,0,100,100,0,0,1,{ruby_outline},0,7,0,0,0,1
Style: Title,{font},{title_size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,{outline},{shadow},8,0,0,0,1
Style: Credit,{font},{credit_size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,{ruby_outline},0,8,0,0,0,1
Style: Dot,{font},{dot_size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,{ruby_outline},0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _ass_time(ms: int) -> str:
    """毫秒 → ASS 的 `H:MM:SS.cc`（厘秒精度）。"""
    ms = max(0, ms)
    cs = round(ms / 10.0)
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _escape(s: str) -> str:
    """转义 ASS 事件文本。`{` 会开启 override block，必须处理。"""
    return s.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


@dataclass
class _LaidOutLine:
    """完成布局计算的一行：绝对坐标 + 逐 token 的 x 边界。"""

    line: Line
    x0: int
    y: int
    token_x: list[int]
    """长度 = len(tokens)+1；token_x[i] 是第 i 个 token 的左边界绝对 x。"""

    scale: int = 100
    """水平缩放百分比。超宽的行按此压缩，避免被裁出画面。"""


class AssBuilder:
    """把 KaraokeProject 渲染成 ASS 文本。"""

    def __init__(self, project: KaraokeProject, metrics: LibassMetrics) -> None:
        self._p = project
        self._m = metrics

    def build(self) -> str:
        p = self._p
        st = p.style
        ruby_size = max(1, int(st.font_size * st.ruby_scale))

        head = _HEADER_TMPL.format(
            w=p.video_width,
            h=p.video_height,
            font=st.font_name,
            size=st.font_size,
            ruby_size=ruby_size,
            title_size=int(st.font_size * 1.15),
            credit_size=int(st.font_size * 0.55),
            dot_size=int(st.font_size * 0.5),
            bold=-1 if st.bold else 0,
            outline=st.outline,
            shadow=st.shadow,
            ruby_outline=round(max(1.0, st.outline * 0.55), 1),
        )

        singable = [ln for ln in p.lines if not ln.is_metadata and ln.tokens]
        singable = self._split_wide_lines(singable)
        _assign_slots(singable, st.paragraph_gap_ms)
        laid = self._layout(singable)

        times = self._compute_times(laid)

        events: list[str] = list(self._emit_credits(singable))
        for i, lo in enumerate(laid):
            prev_end = laid[i - 1].line.end_ms if i > 0 else None
            events.extend(self._emit_countdown(lo, prev_end, ruby_size))
            events.extend(self._emit_line(lo, ruby_size, times[i]))
        return head + "".join(events)

    def _split_wide_lines(self, lines: list[Line]) -> list[Line]:
        """把放不下的行拆成两行，而不是水平压扁。

        歌词源的分行是按歌曲结构来的，跟"一屏能放多宽"无关；
        长句直接压缩会让字变形，观感明显劣化。nicokara 的做法是拆成两行
        各占一个槽位。

        拆分点优先选**时间间隙最大处**——那是演唱中的自然停顿，
        比机械取字数中点更贴合听感。
        """
        p = self._p
        st = p.style
        font = FontSpec(name=st.font_name, size=st.font_size, bold=st.bold)
        avail = p.video_width - st.margin_h * 2

        out: list[Line] = []
        queue = list(lines)
        guard = 0
        while queue:
            guard += 1
            if guard > 4000:
                out.extend(queue)
                break
            ln = queue.pop(0)
            adv = self._m.advances(ln.text, font)
            if not adv or adv[-1] <= avail or len(ln.tokens) < 2:
                out.append(ln)
                continue

            cut = _choose_split(ln, adv, avail)
            if cut <= 0 or cut >= len(ln.tokens):
                out.append(ln)
                continue

            head_chars = sum(len(t.text) for t in ln.tokens[:cut])
            a = Line(
                tokens=ln.tokens[:cut],
                ruby=[r for r in ln.ruby if r.end <= head_chars],
                voice_part=ln.voice_part,
                is_metadata=ln.is_metadata,
            )
            b = Line(
                tokens=ln.tokens[cut:],
                ruby=[
                    RubySpan(
                        start=r.start - head_chars,
                        end=r.end - head_chars,
                        text=r.text,
                        source=r.source,
                        locked=r.locked,
                    )
                    for r in ln.ruby
                    if r.start >= head_chars
                ],
                voice_part=ln.voice_part,
                is_metadata=ln.is_metadata,
            )
            out.append(a)
            # 后半可能仍然过宽，放回队列继续拆
            queue.insert(0, b)
        return out

    def _compute_times(self, laid: list[_LaidOutLine]) -> list[tuple[int, int]]:
        """算出每行的显示与消失时刻，并消解同槽位相邻行的重叠。

        真实卡拉OK 的行为是下一句在当前句还在唱时就已显示，观众能预读。
        但槽位只有两个（上/下交替），**隔一行就回到同一槽位** ——
        歌词密集时前一个同槽位的行尚未消失，新行就压上来，字会叠在一起。

        消解策略：优先让前一行提前消失（但不早于它自己唱完），
        实在腾不出位置时再把新行推后出现。
        """
        p = self._p
        st = p.style
        off = p.global_offset_ms
        gap = st.slot_gap_ms

        times: list[list[int]] = []
        for i, lo in enumerate(laid):
            start = lo.line.start_ms + off
            end = lo.line.end_ms + off
            if i == 0:
                show = start - st.lead_in_ms
            else:
                prev_start = laid[i - 1].line.start_ms + off
                show = max(prev_start, start - st.max_lead_ms)
                show = min(show, start - st.lead_in_ms)
            times.append([show, end + st.lead_out_ms])

        last_in_slot: dict[int, int] = {}
        for i, lo in enumerate(laid):
            slot = lo.line.slot % 2
            j = last_in_slot.get(slot)
            if j is not None and times[j][1] > times[i][0] - gap:
                sung_end = laid[j].line.end_ms + off
                # 先尝试让前一行早点退场
                times[j][1] = max(sung_end, times[i][0] - gap)
                # 前一行还没唱完就被顶了 —— 只能让新行晚点进场
                if times[j][1] > times[i][0] - gap:
                    times[i][0] = times[j][1] + gap
            last_in_slot[slot] = i

        return [(t[0], t[1]) for t in times]

    def _emit_countdown(
        self, lo: _LaidOutLine, prev_end_ms: int | None, ruby_size: int
    ) -> list[str]:
        """开唱引导点（nicokara 的标志性倒计时指示灯）。

        三点同时亮起，**自右向左**依次熄灭，最左那点消失的瞬间开唱——
        屏幕上剩几个点就是还剩几拍，这样才读得出倒计时的意思。
        只在**第一句**与**每段间奏之后**出现——句与句之间的正常换行不需要，
        否则满屏都是点，反而干扰。
        """
        p = self._p
        st = p.style
        if not st.countdown_dots:
            return []

        start = lo.line.start_ms + p.global_offset_ms
        if prev_end_ms is None:
            gap_start = 0
        else:
            gap_start = prev_end_ms + p.global_offset_ms
            if start - gap_start < st.countdown_min_gap_ms:
                return []

        n = st.countdown_dots

        # 优先让点踩在真实拍点上；没有节拍网格时退回固定间隔。
        # 取开唱前最近的 n 个拍点，最左的点在最早那拍熄灭。
        ends: list[int] = []
        if p.beat_grid is not None:
            beats = p.beat_grid.beats_before(start, n)
            if len(beats) == n and beats[0] > gap_start:
                ends = list(reversed(beats))  # ends[i] 是第 i 个点的熄灭时刻

        if not ends:
            beat = min(st.countdown_beat_ms, max(120, (start - gap_start) // (n + 1)))
            ends = [start - beat * i for i in range(n)]

        t_begin = max(gap_start, min(ends) - st.countdown_beat_ms)

        dot_w = int(ruby_size * 1.35)
        y = lo.y - int(ruby_size * 2.4)
        out: list[str] = []
        for i in range(n):
            # 自右向左依次熄灭：最右的点先灭，最左的点在开唱瞬间灭掉。
            # 剩余点数即剩余拍数，读起来就是倒计时。
            x = lo.x0 + i * dot_w
            out.append(
                f"Dialogue: 0,{_ass_time(t_begin)},{_ass_time(ends[i])},Dot,,0,0,0,,"
                f"{{\\an7\\pos({x},{y})\\fad(180,0)}}●\n"
            )
        return out

    def _emit_credits(self, singable: list[Line]) -> list[str]:
        """开头的曲名 / 歌手 / 制作名单字幕。

        **不能沿用歌词源给的时间**：QRC 把这些行塞在正文里，实测每行只有
        几十毫秒（0/222/355/518/577ms），照搬根本来不及阅读。
        这里改为自行排版——从片头持续到首句人声之前，并置于画面上方，
        避开底部的歌词区。
        """
        p = self._p
        st = p.style
        if not p.title and not p.artist:
            return []

        window = _find_credit_window(singable, p.global_offset_ms, st)
        if window is None:
            return []
        start_ms, end_ms = window

        credits = [
            ln.text for ln in p.lines if ln.is_metadata and " - " not in ln.text
        ]
        t0, t1 = _ass_time(start_ms), _ass_time(end_ms)
        cx = p.video_width // 2

        # 整块垂直居中于画面。先量总高再定起点，避免行数变化时偏上或偏下。
        h_title = int(st.font_size * 1.5)
        h_artist = int(st.font_size * 0.78) if p.artist else 0
        h_credit = int(st.font_size * 0.68)
        total = h_title + h_artist + h_credit * len(credits)
        y = (p.video_height - total) // 2

        out = [
            f"Dialogue: 0,{t0},{t1},Title,,0,0,0,,"
            f"{{\\an8\\pos({cx},{y})\\fad(500,500)}}{_escape(p.title)}\n"
        ]
        y += h_title
        if p.artist:
            out.append(
                f"Dialogue: 0,{t0},{t1},Credit,,0,0,0,,"
                f"{{\\an8\\pos({cx},{y})\\fad(500,500)}}{_escape(p.artist)}\n"
            )
            y += h_artist
        for c in credits:
            out.append(
                f"Dialogue: 0,{t0},{t1},Credit,,0,0,0,,"
                f"{{\\an8\\pos({cx},{y})\\fad(500,500)}}{_escape(c)}\n"
            )
            y += h_credit
        return out

    # ---- 布局 ----

    def _layout(self, lines: list[Line]) -> list[_LaidOutLine]:
        p = self._p
        st = p.style
        font = FontSpec(name=st.font_name, size=st.font_size, bold=st.bold)

        texts = [ln.text for ln in lines]
        all_adv = self._m.advances_many(texts, font)

        # 主文字基线：两个槽位从底部向上排
        row_h = int(st.font_size * 1.35) + st.line_gap
        base_y = p.video_height - st.margin_v - row_h * 2

        avail = p.video_width - st.margin_h * 2

        out: list[_LaidOutLine] = []
        for ln, adv in zip(lines, all_adv, strict=False):
            raw_w = adv[-1] if adv else 0

            # 超宽的行水平压缩而不是任其溢出。压缩后所有 x 同比缩放，
            # clip 与注音坐标才不会与实际渲染脱节。
            scale = 100
            if raw_w > avail > 0:
                scale = max(60, int(avail * 100 / raw_w))
            f = scale / 100.0
            width = int(raw_w * f)
            sadv = [int(a * f) for a in adv]

            if st.stagger and width < avail:
                # 上行贴左、下行贴右 —— 日式卡拉OK 的经典错开布局
                x0 = st.margin_h if ln.slot % 2 == 0 else p.video_width - st.margin_h - width
            else:
                x0 = max(0, (p.video_width - width) // 2)

            # 由字符级 advance 累加出 token 级边界
            token_x = [x0]
            ci = 0
            for tk in ln.tokens:
                ci += len(tk.text)
                token_x.append(x0 + (sadv[ci - 1] if 0 < ci <= len(sadv) else 0))

            y = base_y + (ln.slot % 2) * row_h
            out.append(
                _LaidOutLine(line=ln, x0=x0, y=y, token_x=token_x, scale=scale)
            )
        return out

    # ---- 事件生成 ----

    def _emit_line(
        self, lo: _LaidOutLine, ruby_size: int, window: tuple[int, int]
    ) -> list[str]:
        p = self._p
        st = p.style
        ln = lo.line
        pal = p.palette_for(ln.voice_part)
        off = p.global_offset_ms

        show, hide = window
        t_show, t_hide = _ass_time(show), _ass_time(hide)

        body = _escape(ln.text)
        h = p.video_height

        sc = f"\\fscx{lo.scale}" if lo.scale != 100 else ""

        # 底层：未唱色整行
        base_tags = (
            f"\\an7\\pos({lo.x0},{lo.y}){sc}"
            f"\\1c{pal.unsung_fill}\\3c{pal.unsung_outline}"
        )
        under = (
            f"Dialogue: 0,{t_show},{t_hide},Main,,0,0,0,,"
            f"{{{base_tags}}}{body}\n"
        )

        # 顶层：已唱色 + 逐 token 推进的 clip
        clip_tags = [
            f"\\an7\\pos({lo.x0},{lo.y}){sc}",
            f"\\1c{pal.sung_fill}\\3c{pal.sung_outline}",
            f"\\clip({lo.x0},0,{lo.x0},{h})",
        ]
        for i, tk in enumerate(ln.tokens):
            # dur=0 的块（QRC 实测存在，多为半角空格）会触发 libass #124，
            # 必须跳过而不是输出零时长动画
            if tk.dur_ms <= 0:
                continue
            rel_a = max(0, tk.start_ms + off - show)
            rel_b = max(rel_a + 1, tk.end_ms + off - show)
            x_to = lo.token_x[i + 1]
            clip_tags.append(f"\\t({rel_a},{rel_b},\\clip({lo.x0},0,{x_to},{h}))")
        over = (
            f"Dialogue: 1,{t_show},{t_hide},Main,,0,0,0,,"
            f"{{{''.join(clip_tags)}}}{body}\n"
        )

        events = [under, over]

        # 注音行
        ruby_y = lo.y - ruby_size - st.ruby_gap
        font_ruby = FontSpec(name=st.font_name, size=ruby_size, bold=st.bold)
        if ln.ruby:
            rubies = [r.text for r in ln.ruby]
            widths = [a[-1] if a else 0 for a in self._m.advances_many(rubies, font_ruby)]
            char_x = self._char_x(lo)
            min_gap = max(4, ruby_size // 5)
            placed = _layout_ruby(ln.ruby, widths, char_x, min_gap)

            char_time = self._char_time(ln)
            for r, rw, rx in placed:
                rtext = _escape(r.text)
                # 底层：未唱色
                events.append(
                    f"Dialogue: 2,{t_show},{t_hide},Ruby,,0,0,0,,"
                    f"{{\\an7\\pos({rx},{ruby_y})"
                    f"\\1c{pal.unsung_fill}\\3c{pal.unsung_outline}}}{rtext}\n"
                )
                # 顶层：已唱色 + clip 扫过。注音整体跟随其基字区间的时间，
                # 不逐假名扫 —— 基字与注音的拍数往往不等（如「時」对「とき」），
                # 强行逐假名会与主行走字脱节
                span = char_time[r.start : r.end]
                if not span:
                    continue
                a_ms = min(s for s, _ in span)
                b_ms = max(e for _, e in span)
                rel_a = max(0, a_ms + off - show)
                rel_b = max(rel_a + 1, b_ms + off - show)
                events.append(
                    f"Dialogue: 3,{t_show},{t_hide},Ruby,,0,0,0,,"
                    f"{{\\an7\\pos({rx},{ruby_y})"
                    f"\\1c{pal.sung_fill}\\3c{pal.sung_outline}"
                    f"\\clip({rx},0,{rx},{h})"
                    f"\\t({rel_a},{rel_b},\\clip({rx},0,{rx + rw},{h}))}}{rtext}\n"
                )
        return events

    def _char_time(self, ln: Line) -> list[tuple[int, int]]:
        """行内每个字符的 (start_ms, end_ms)。

        多字符 token（实测基本是 ASCII 词）内部按等分插值——
        这只用于决定注音何时变色，不写回工程文件，
        因此不违反"禁止伪造粒度"的规则。
        """
        out: list[tuple[int, int]] = []
        for tk in ln.tokens:
            n = len(tk.text)
            if n <= 0:
                continue
            if n == 1:
                out.append((tk.start_ms, tk.end_ms))
                continue
            step = tk.dur_ms / n
            for i in range(n):
                out.append(
                    (int(tk.start_ms + step * i), int(tk.start_ms + step * (i + 1)))
                )
        return out

    def _char_x(self, lo: _LaidOutLine) -> list[int]:
        """行内每个字符边界的绝对 x（长度 = 字符数+1）。

        必须应用该行的水平缩放，否则超宽行的注音会与压缩后的基字错位。
        """
        st = self._p.style
        font = FontSpec(name=st.font_name, size=st.font_size, bold=st.bold)
        adv = self._m.advances(lo.line.text, font)
        f = lo.scale / 100.0
        return [lo.x0] + [lo.x0 + int(a * f) for a in adv]


def _choose_split(line: Line, adv: list[int], avail: int) -> int:
    """为过宽的行选一个 token 分割下标。

    先框出"前半放得下"的可行范围，再在范围内挑**时间间隙最大**的边界——
    演唱中的停顿处断句最自然。若没有明显停顿（间隙全为 0），
    退化为取可行范围内最靠近字数中点的位置。
    """
    n = len(line.tokens)
    if n < 2:
        return 0

    # 每个 token 边界处的累计宽度
    cum: list[int] = []
    ci = 0
    for tk in line.tokens:
        ci += len(tk.text)
        cum.append(adv[ci - 1] if 0 < ci <= len(adv) else 0)

    total = cum[-1]
    feasible = [
        i for i in range(1, n)
        if cum[i - 1] <= avail and (total - cum[i - 1]) <= avail
    ]
    if not feasible:
        # 一刀切不开，就在放得下的最远处切，剩下的交给下一轮继续拆
        feasible = [i for i in range(1, n) if cum[i - 1] <= avail]
        if not feasible:
            return 0
        return feasible[-1]

    best, best_key = feasible[0], None
    mid = total / 2.0
    for i in feasible:
        gap = line.tokens[i].start_ms - line.tokens[i - 1].end_ms
        key = (gap, -abs(cum[i - 1] - mid))
        if best_key is None or key > best_key:
            best, best_key = i, key
    return best


def _assign_slots(lines: list[Line], paragraph_gap_ms: int) -> None:
    """分配上下槽位；间奏之后重新从上行开始。

    拆行会改变行数，所以槽位必须在拆行之后重算，不能沿用导入时的结果。
    """
    slot = 0
    prev_end: int | None = None
    for ln in lines:
        if not ln.tokens:
            continue
        if prev_end is not None and ln.start_ms - prev_end >= paragraph_gap_ms:
            slot = 0
        ln.slot = slot % 2
        slot += 1
        prev_end = ln.end_ms


def _find_credit_window(
    singable: list[Line],
    offset_ms: int,
    style,
    *,
    min_dur_ms: int = 4500,
    pad_ms: int = 600,
) -> tuple[int, int] | None:
    """找第一段屏幕上没有歌词的区间，用来展示曲名与制作名单。

    不能假设片头一定有前奏——实测赤春花首句在 774ms，开头几乎没有空档，
    所以片头放不下时要顺着找行间的第一个间隙（通常是间奏）。

    关键：边界必须按**字幕实际出现/消失**算，而不是按开唱时间。
    下一句会提前最多 `max_lead_ms` 显示出来预读，前一句唱完后还会停留
    `lead_out_ms`；只看开唱时间会让制作名单和歌词叠在一起。
    """
    if not singable:
        return None

    head_end = singable[0].start_ms + offset_ms - style.lead_in_ms
    if head_end >= min_dur_ms + pad_ms:
        return (0, head_end - pad_ms)

    for a, b in pairwise(singable):
        g0 = a.end_ms + offset_ms + style.lead_out_ms
        g1 = b.start_ms + offset_ms - style.max_lead_ms
        if g1 - g0 >= min_dur_ms + pad_ms * 2:
            return (g0 + pad_ms, g1 - pad_ms)
    return None


def _layout_ruby(
    spans: list, widths: list[int], char_x: list[int], min_gap: int
) -> list[tuple]:
    """解决注音溢出（spill）：注音比基字宽时的重排。

    注音理想上居中于基字格位，但假名往往比汉字宽（「桜」82px 对「さくら」111px），
    居中后会向两侧溢出并紧贴相邻注音，视觉上糊成一团。

    Aegisub 的 karaskel 用 layout group 解决：把互相冲突的注音归为一组，
    组内紧凑排列，**整组**居中于该组基字的整体范围。这样溢出被均摊，
    而不是单向累积右移（后者会让行尾注音明显偏离基字）。

    分组需要迭代——组内重排后可能与下一组产生新冲突。
    """
    items = []
    n_chars = len(char_x) - 1
    for r, w in zip(spans, widths, strict=False):
        if not (0 <= r.start < r.end <= n_chars) or w <= 0:
            continue
        bx0, bx1 = char_x[r.start], char_x[r.end]
        center = (bx0 + bx1) / 2.0
        items.append(
            {"r": r, "w": w, "x0": center - w / 2.0, "bx0": bx0, "bx1": bx1}
        )
    if not items:
        return []

    items.sort(key=lambda it: it["bx0"])

    for _ in range(8):
        groups: list[list[dict]] = [[items[0]]]
        for it in items[1:]:
            prev = groups[-1][-1]
            if it["x0"] < prev["x0"] + prev["w"] + min_gap:
                groups[-1].append(it)
            else:
                groups.append([it])

        changed = False
        for g in groups:
            if len(g) == 1:
                continue
            total = sum(x["w"] for x in g) + min_gap * (len(g) - 1)
            gc = (g[0]["bx0"] + g[-1]["bx1"]) / 2.0
            cur = gc - total / 2.0
            for x in g:
                if abs(x["x0"] - cur) > 0.5:
                    changed = True
                x["x0"] = cur
                cur += x["w"] + min_gap
        if not changed:
            break

    return [(it["r"], it["w"], round(max(0, it["x0"]))) for it in items]
