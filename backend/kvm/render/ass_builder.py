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

## 一行内的多声部分色

声部标识行级是默认值、**Token 级可覆盖**（CLAUDE.md §8.5）——
对唱歌曲一行内男女交替是常态（`A: 君の / B: 声が / 合: 聞こえる`）。
一个 Dialogue 只能有一组颜色，所以按有效声部把 token 切成**连续段**，
每段各出一对（未唱层 + 已唱层）Dialogue。

每段画的仍是**整行文本**、用同一个 `\\pos` —— 只靠 `\\clip` 把它限制在
本段的 x 区间内。不切文本是刻意的：切了就等于让 libass 分别排版几个片段，
字距与整行排版不再一致，段与段的接缝会错位。

段界取 token 的 advance 边界，各段 clip 区间**严丝合缝且互不重叠**；
首段左界与末段右界放开到画面边缘，免得把首尾字符溢出 advance 盒的描边裁掉。
单声部行（绝大多数）只有一段，此时**不输出这个区间 clip**，
输出与未支持多声部时逐字节一致。

## 淡入淡出与窗口语义

**每一句都淡入淡出**，不只是段落首/末行——段内硬切在换句密集处很跳。

一行会拆成好几个 Dialogue（多声部分段 ×2 层 + 每段注音 ×2 层），
它们**共用同一个 `(show, hide)` 窗口和同一组 `\\fad` 参数**，
否则淡化期间几层会各淡各的，未唱色与已唱色互相透出来打架。

窗口的两端都按"肉眼看到的状态"定义：`show` 是开始淡入的时刻（此刻全透明），
`hide` 是**完全消失**的时刻（Dialogue 的 End）。这样"前一行没了"与
"后一行开始出现"仍是两个能直接比大小的时间点，同槽位的空档判断
（`_compute_times`）不必再各自减去淡化时长。代价是不透明区间被两头各吃掉一截，
所以 `lead_in_ms >= fade_in_ms`、`lead_out_ms >= fade_out_ms` 是硬性要求。

## 坐标策略

一律用 `\\an7`（左上）+ 显式 `\\pos`，自己算居中，而不是用 `\\an2` 让 libass 居中。
因为 clip 用的是**绝对屏幕坐标**，必须由我们掌握行的确切 x 范围。
"""

from __future__ import annotations

from dataclasses import dataclass

from kvm.models.karaoke import KaraokeProject, Line, RubySpan, Token
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
        para_starts = _assign_slots(singable, st.paragraph_gap_ms)
        laid = self._layout(singable)

        times = self._compute_times(laid, para_starts)

        # 制作名单要放进"屏幕上真的没有歌词"的空档，所以必须拿最终窗口去找，
        # 不能拿开唱时间近似——歌词提前量一改，近似值立刻和实际脱节。
        events: list[str] = list(self._emit_credits(times))
        for i, lo in enumerate(laid):
            prev_end = laid[i - 1].line.end_ms if i > 0 else None
            events.extend(self._emit_countdown(lo, prev_end, ruby_size, times[i]))
            events.extend(self._emit_line(lo, ruby_size, times[i]))
        return head + "".join(events)

    def _fade_tag(self, window: tuple[int, int]) -> str:
        """本行的 `\\fad`。所有层共用同一个，淡化才会同步。

        窗口比 `fade_in + fade_out` 还短时按比例收窄：libass 不会自动截断，
        真塞进去的话整行全程处在半透明的爬升段，永远淡不完。
        """
        st = self._p.style
        dur = max(0, window[1] - window[0])
        fi = max(0, st.fade_in_ms)
        fo = max(0, st.fade_out_ms)
        if fi + fo <= 0:
            return ""
        if fi + fo > dur:
            fi = dur * fi // (fi + fo)
            fo = dur - fi
        return f"\\fad({fi},{fo})"

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

    def _compute_times(
        self, laid: list[_LaidOutLine], para_starts: list[int]
    ) -> list[tuple[int, int]]:
        """算出每行的 `(开始淡入, 完全消失)` 窗口，并消解同槽位相邻行的重叠。

        窗口语义见模块文档字符串的"淡入淡出与窗口语义"一节——
        `hide` 是完全消失的时刻，不是开始淡出的时刻。

        三条规则叠在一起：

        1. **段落首行连同它的下一行一起提前 `paragraph_lead_ms` 出现。**
           间奏之后屏幕本来就空着，上下两个槽位一次摆满，演唱者能一眼看到
           接下来两句；只提前第一句的话第二句要等第一句开唱才冒出来。
        2. **段内行从上一行开唱起就显示**（上限 `max_lead_ms`），
           且无论如何至少提前 `lead_in_ms`。
        3. **同槽位不许叠字。** 槽位只有两个，隔一行就回到同一位置；
           歌词密集时前一个同槽位的行尚未消失，新行就压上来。
           消解策略：优先让前一行提前消失，实在腾不出位置时再把新行推后出现。

        前一行"提前消失"的下限是**唱完再加一个淡出时长**，不是唱完就算——
        `hide` 减去 `fade_out_ms` 才是开始变淡的时刻，按唱完去卡会让最后一个字
        一边唱一边褪色。
        """
        p = self._p
        st = p.style
        off = p.global_offset_ms
        gap = st.slot_gap_ms
        fade_out = max(0, st.fade_out_ms)
        starts = set(para_starts)

        times: list[list[int]] = []
        for i, lo in enumerate(laid):
            start = lo.line.start_ms + off
            end = lo.line.end_ms + off
            if i in starts:
                show = start - max(st.paragraph_lead_ms, st.lead_in_ms)
                if i > 0:
                    # 间奏只有 paragraph_gap_ms 那么长时，提前 4.2s 会压到
                    # 上一段最后一句身上：那一句得唱完、淡完，还要留同槽位空档
                    show = max(show, laid[i - 1].line.end_ms + off + fade_out + gap)
            else:
                prev_start = laid[i - 1].line.start_ms + off
                show = max(prev_start, start - st.max_lead_ms)
                show = min(show, start - st.lead_in_ms)
            # 负的 show 必须夹到 0：`_ass_time` 会把负时间钳成 0，而 `\t` 的相对
            # 时间是按 show 算的，两者对不上就会让整行动画整体偏移
            times.append([max(0, show), end + st.lead_out_ms])

        def sync_paragraph_pairs(*, earliest: bool) -> None:
            """让段落头两行取相同的出现时刻。

            冲突消解**之前**取两者较早的那个（`earliest=True`）：第二行本来要等
            第一行开唱才浮现，这里把它拉到与第一行同时。拉早是安全的——
            第一行的时刻已经按上一段最后一句的收尾做过下限约束，而那一句
            结束得最晚，两个槽位都够用。

            冲突消解**之后**只能取较晚的那个：此时再往前拉会把刚消解掉的重叠
            又放回去。这一步通常什么都不做，只是兜住消解过程恰好推后了一对里
            某一行的情况。
            """
            pick = min if earliest else max
            for k in para_starts:
                j = k + 1
                if j < len(times) and j not in starts:
                    s = pick(times[k][0], times[j][0])
                    times[k][0] = times[j][0] = s

        sync_paragraph_pairs(earliest=True)

        last_in_slot: dict[int, int] = {}
        for i, lo in enumerate(laid):
            slot = lo.line.slot % 2
            j = last_in_slot.get(slot)
            if j is not None and times[j][1] > times[i][0] - gap:
                sung_end = laid[j].line.end_ms + off
                # 先尝试让前一行早点退场。下限是"唱完 + 一个淡出"，
                # 再早就会在最后一个字还没唱完时开始褪色
                times[j][1] = max(sung_end + fade_out, times[i][0] - gap)
                # 前一行还没让开就被顶了 —— 只能让新行晚点进场
                if times[j][1] > times[i][0] - gap:
                    times[i][0] = times[j][1] + gap
            last_in_slot[slot] = i

        # 冲突消解可能只推后了一对里的一行，重新对齐一次
        sync_paragraph_pairs(earliest=False)

        return [(t[0], t[1]) for t in times]

    def _emit_countdown(
        self,
        lo: _LaidOutLine,
        prev_end_ms: int | None,
        ruby_size: int,
        window: tuple[int, int],
    ) -> list[str]:
        """开唱引导点（nicokara 的标志性倒计时指示灯）。

        点与**它所提示的那句歌词同时浮现**（同一个 `show`、同一个淡入时长），
        然后**自右向左**依次熄灭，最左那点消失的瞬间开唱——
        屏幕上剩几个点就是还剩几拍，这样才读得出倒计时的意思。
        只在**第一句**与**每段间奏之后**出现——句与句之间的正常换行不需要，
        否则满屏都是点，反而干扰。

        点亮起后会先静止一段（歌词提前 `paragraph_lead_ms` 出现，而熄灭只占
        最后 n 拍），这是刻意的：点先是"这段要开始了"的准备标记，
        最后几拍才变成倒计时。让点晚于歌词才亮虽然能去掉静止期，
        但那就不是"同步出现"了，而且两个元素先后冒出来更碎。

        熄灭时刻必须踩在**真实拍点**上：固定间隔只是"三个会消失的点"，
        与音乐无关，演唱者跟不进（CLAUDE.md §8.5）。没有节拍网格才退回固定间隔。
        """
        p = self._p
        st = p.style
        if not st.countdown_dots:
            return []

        start = lo.line.start_ms + p.global_offset_ms
        if prev_end_ms is not None:
            gap_start = prev_end_ms + p.global_offset_ms
            if start - gap_start < st.countdown_min_gap_ms:
                return []

        n = st.countdown_dots
        t_begin = window[0]

        # 优先让点踩在真实拍点上；没有节拍网格时退回固定间隔。
        # 取开唱前最近的 n 个拍点，最左的点在最晚那拍（即开唱前一拍）熄灭。
        ends: list[int] = []
        if p.beat_grid is not None:
            beats = p.beat_grid.beats_before(start, n)
            if len(beats) == n and beats[0] > t_begin:
                ends = list(reversed(beats))  # ends[i] 是第 i 个点的熄灭时刻

        if not ends:
            beat = min(st.countdown_beat_ms, max(120, (start - t_begin) // (n + 1)))
            ends = [start - beat * i for i in range(n)]

        fade_in = max(0, st.fade_in_ms)
        dot_w = int(ruby_size * 1.35)
        y = lo.y - int(ruby_size * 2.4)
        out: list[str] = []
        for i in range(n):
            # 自右向左依次熄灭：最右的点先灭，最左的点在开唱瞬间灭掉。
            # 剩余点数即剩余拍数，读起来就是倒计时。
            if ends[i] <= t_begin:
                # 空档塞不下这么多点。丢最右边的（先熄灭的那几个），
                # 剩下的仍然读得出倒计时，比整组不显示好（§2.5 失败要降级）
                continue
            x = lo.x0 + i * dot_w
            # 熄灭要干脆，不淡出——那一下"啪"地消失才是拍点的读数。
            # 淡入则与歌词同参数，两者才像是一起浮现的
            fi = min(fade_in, ends[i] - t_begin)
            out.append(
                f"Dialogue: 0,{_ass_time(t_begin)},{_ass_time(ends[i])},Dot,,0,0,0,,"
                f"{{\\an7\\pos({x},{y})\\fad({fi},0)}}●\n"
            )
        return out

    def _emit_credits(self, line_windows: list[tuple[int, int]]) -> list[str]:
        """开头的曲名 / 歌手 / 制作名单字幕。

        **不能沿用歌词源给的时间**：QRC 把这些行塞在正文里，实测每行只有
        几十毫秒（0/222/355/518/577ms），照搬根本来不及阅读。
        这里改为自行排版——放进第一段屏幕上没有歌词的区间，居画面正中。
        """
        p = self._p
        st = p.style
        if not p.title and not p.artist:
            return []

        window = _find_credit_window(line_windows)
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
        off = p.global_offset_ms

        show, hide = window
        t_show, t_hide = _ass_time(show), _ass_time(hide)

        body = _escape(ln.text)
        h = p.video_height

        sc = f"\\fscx{lo.scale}" if lo.scale != 100 else ""
        # 一行拆出的所有 Dialogue（各声部段的两层 + 各条注音的两层）共用同一个
        # `\fad`：只要有一层淡得不一样，淡化期间未唱色与已唱色就会互相透出来
        fad = self._fade_tag(window)

        segments = _voice_segments(ln)
        multi = len(segments) > 1

        events: list[str] = []
        for si, (i0, i1, voice) in enumerate(segments):
            pal = p.palette_for(voice)
            seg_x0 = lo.token_x[i0]

            # 只有真的分了段才加区间 clip：单声部行不加，输出与旧版逐字节一致。
            # 首段左界与末段右界放开到画面边缘，否则首尾字符溢出 advance 盒的
            # 描边会被裁掉，行的两端看起来像被削平了一层。
            if multi:
                bound_l = 0 if si == 0 else seg_x0
                bound_r = p.video_width if si == len(segments) - 1 else lo.token_x[i1]
                seg_clip = f"\\clip({bound_l},0,{bound_r},{h})"
            else:
                seg_clip = ""

            # 底层：未唱色整行（按段裁出本段区间）
            base_tags = (
                f"\\an7\\pos({lo.x0},{lo.y}){sc}{fad}"
                f"\\1c{pal.unsung_fill}\\3c{pal.unsung_outline}{seg_clip}"
            )
            events.append(
                f"Dialogue: 0,{t_show},{t_hide},Main,,0,0,0,,"
                f"{{{base_tags}}}{body}\n"
            )

            # 顶层：已唱色 + 逐 token 推进的 clip。
            # 推进起点取本段左界、终点最远只到本段右界，所以这一个 clip
            # 同时承担了"扫描进度"与"限制在本段内"两件事，不需要额外的区间 clip。
            clip_tags = [
                f"\\an7\\pos({lo.x0},{lo.y}){sc}{fad}",
                f"\\1c{pal.sung_fill}\\3c{pal.sung_outline}",
                f"\\clip({seg_x0},0,{seg_x0},{h})",
            ]
            for i in range(i0, i1):
                tk = ln.tokens[i]
                # dur=0 的块（QRC 实测存在，多为半角空格）会触发 libass #124，
                # 必须跳过而不是输出零时长动画
                if tk.dur_ms <= 0:
                    continue
                rel_a = max(0, tk.start_ms + off - show)
                rel_b = max(rel_a + 1, tk.end_ms + off - show)
                x_to = lo.token_x[i + 1]
                clip_tags.append(f"\\t({rel_a},{rel_b},\\clip({seg_x0},0,{x_to},{h}))")
            events.append(
                f"Dialogue: 1,{t_show},{t_hide},Main,,0,0,0,,"
                f"{{{''.join(clip_tags)}}}{body}\n"
            )

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
            char_voice = _char_voice(ln)
            for r, rw, rx in placed:
                rtext = _escape(r.text)
                # 注音跟随其**基字所属声部**的配色，而不是行声部——
                # 一行内分色时注音若还用行的颜色，会与它标注的基字对不上。
                # 注音区间理论上可能横跨段界（实际不会：段界取在 token 边界，
                # 而一条注音总落在同一个词里），真跨了就随首个基字所在的段。
                pal = p.palette_for(
                    char_voice[r.start] if 0 <= r.start < len(char_voice) else ln.voice_part
                )
                # 底层：未唱色
                events.append(
                    f"Dialogue: 2,{t_show},{t_hide},Ruby,,0,0,0,,"
                    f"{{\\an7\\pos({rx},{ruby_y}){fad}"
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
                    f"{{\\an7\\pos({rx},{ruby_y}){fad}"
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


def _effective_voice(line: Line, token: Token) -> str:
    """Token 的有效声部：token 级覆盖优先，缺省继承行级（CLAUDE.md §8.5）。"""
    return token.voice_part or line.voice_part


def _voice_segments(line: Line) -> list[tuple[int, int, str]]:
    """按有效声部把行内 token 切成连续段：`[(起始下标, 结束下标（不含）, 声部)]`。

    相邻同声部的 token 并成一段，段数因此等于行内的**换声次数 + 1**；
    绝大多数行只换 0 次，返回单段，渲染层据此走与旧版完全相同的输出路径。

    没有 token 的行（理论上不会进到这里）返回一个空段，
    保证调用方仍会输出那对空文本 Dialogue，行为与旧版一致。
    """
    segs: list[tuple[int, int, str]] = []
    for i, tk in enumerate(line.tokens):
        voice = _effective_voice(line, tk)
        if segs and segs[-1][2] == voice:
            segs[-1] = (segs[-1][0], i + 1, voice)
        else:
            segs.append((i, i + 1, voice))
    return segs or [(0, 0, line.voice_part)]


def _char_voice(line: Line) -> list[str]:
    """行内每个**字符**的有效声部（长度 = 字符数）。

    注音挂在字符区间上而不是 token 上，要判断一段注音归哪个声部，
    得先把 token 级声部摊到字符级。
    """
    out: list[str] = []
    for tk in line.tokens:
        out.extend([_effective_voice(line, tk)] * len(tk.text))
    return out


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


def _assign_slots(lines: list[Line], paragraph_gap_ms: int) -> list[int]:
    """分配上下槽位；间奏之后重新从上行开始。返回各段落首行的下标。

    拆行会改变行数，所以槽位必须在拆行之后重算，不能沿用导入时的结果。

    段落首行的下标要返回出去而不是让调用方回头去猜：槽位是 0/1 交替的，
    `slot == 0` 每隔一行就出现一次，不能拿它反推段落边界。
    """
    starts: list[int] = []
    slot = 0
    prev_end: int | None = None
    for i, ln in enumerate(lines):
        if not ln.tokens:
            continue
        if prev_end is None or ln.start_ms - prev_end >= paragraph_gap_ms:
            slot = 0
            starts.append(i)
        ln.slot = slot % 2
        slot += 1
        prev_end = ln.end_ms
    return starts


def _find_credit_window(
    line_windows: list[tuple[int, int]],
    *,
    min_dur_ms: int = 4500,
    pad_ms: int = 600,
) -> tuple[int, int] | None:
    """找第一段屏幕上没有歌词的区间，用来展示曲名与制作名单。

    不能假设片头一定有前奏——实测赤春花首句在 774ms，开头几乎没有空档，
    所以片头放不下时要顺着找行间的第一个间隙（通常是间奏）。

    输入是每行**最终的 `(开始淡入, 完全消失)` 窗口**，不是开唱时间：
    行会提前显示出来预读、唱完后还会停留，拿开唱时间近似必然把制作名单
    和歌词叠在一起。取窗口的并集再找空隙，因为行之间允许时间重叠
    （同屏两个槽位、以及数据结构上允许的多声部同唱），逐对比较会漏判。
    """
    if not line_windows:
        return None

    ordered = sorted(line_windows)
    if ordered[0][0] >= min_dur_ms + pad_ms:
        return (0, ordered[0][0] - pad_ms)

    covered_to = ordered[0][1]
    for show, hide in ordered[1:]:
        if show - covered_to >= min_dur_ms + pad_ms * 2:
            return (covered_to + pad_ms, show - pad_ms)
        covered_to = max(covered_to, hide)
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
