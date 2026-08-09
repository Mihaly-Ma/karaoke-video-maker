"""卡拉OK 工程的核心数据模型（第一版最小可用子集）。

完整设计见 CLAUDE.md §4.2。这里只落地出片所必需的部分，
但**字段与语义与契约保持一致**，以免第一版形成技术债。

时间单位统一为毫秒整数。ASS 的厘秒只在序列化那一刻产生，
且用"对累积时间点取整再取差"而非逐个 round，避免误差累积。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class TimingSource(str, enum.Enum):
    """时间的来源，决定它在自动重算时是否可被覆盖。"""

    PROVIDER = "provider"
    """来自歌词源（QRC 逐字轴），可信度最高。"""

    ALIGNED = "aligned"
    """本地强制对齐推算。第一版不产生此来源，但保留位置。"""

    INTERPOLATED = "interpolated"
    """由上层时间按比例插值推算，仅作占位，**不得当作锚点**。"""

    MANUAL = "manual"
    """用户手工调整过。任何自动重算都必须跳过。"""


class ReadingSource(str, enum.Enum):
    """读音的来源。优先级见 CLAUDE.md §4.5。"""

    PROVIDER_KANA = "provider_kana"
    """歌词源自带的假名轨（QRC `[kana:]`）—— 该曲实际演唱读音，优先于通用词典。"""

    DICT = "dict"
    DICT_USER = "dict_user"
    MORPH = "morph"
    """形态素分析器自动推断，对当て字必错，兜底用。"""

    ACOUSTIC = "acoustic"
    """多候选读音 + 强制对齐声学似然消歧。第一版不实现，保留位置。"""

    MANUAL = "manual"


@dataclass
class RubySpan:
    """一段注音：把行内字符区间 [start, end) 标注为 `text`。

    纯假名区间不应出现在这里，否则会渲染出「あ|あ」这种冗余标注。
    """

    start: int
    end: int
    text: str
    source: ReadingSource = ReadingSource.PROVIDER_KANA
    locked: bool = False
    """用户手工锁定后，自动重算不得覆盖。"""


@dataclass
class Token:
    """一个计时单元，对应 ASS 里的一个 `\\k` 块。

    QRC 实测 99.1% 的块是单个书写字符，日文正文中无多字符块；
    多字符块基本是 ASCII 词（如 `sumika`），整体作为一个 `\\k` 块处理。
    """

    text: str
    start_ms: int
    dur_ms: int
    timing_source: TimingSource = TimingSource.PROVIDER
    locked_timing: bool = False

    voice_part: str | None = None
    """声部覆盖。为 None 时继承所在行的 `voice_part`。

    对唱歌曲一行内男女交替是常态（`A: 君の / B: 声が / 合: 聞こえる`），
    只有行级声部的话这类句子无法正确分色，所以渲染层按本字段把行切成
    若干连续段、每段一组 Dialogue（见 `render.ass_builder`）。
    """

    @property
    def end_ms(self) -> int:
        return self.start_ms + self.dur_ms


@dataclass
class Line:
    """一行歌词。

    **时间允许与其他行重叠**——这是为"同一时刻两个声部唱不同歌词、
    同屏各走各的轴"预留的（CLAUDE.md 声部需求）。第一版编辑器不支持
    编辑重叠行，但数据结构与渲染层不得假设行之间时间互斥。
    """

    tokens: list[Token] = field(default_factory=list)
    ruby: list[RubySpan] = field(default_factory=list)

    voice_part: str = "main"
    """声部标识。驱动分色；`main` / `duet_a` / `duet_b` / `chorus` / 自定义。

    行级是默认值，**Token 级可覆盖**（对唱歌曲一行内男女交替是常态）。
    """

    slot: int = 0
    """同屏槽位（nicokara 上下两行交替）。"""

    is_metadata: bool = False
    """标记被歌词源塞进正文的制作名单行（词/曲/编曲/制作人）。"""

    locked: bool = False

    @property
    def text(self) -> str:
        return "".join(t.text for t in self.tokens)

    @property
    def start_ms(self) -> int:
        return self.tokens[0].start_ms if self.tokens else 0

    @property
    def end_ms(self) -> int:
        return self.tokens[-1].end_ms if self.tokens else 0


@dataclass
class VoicePalette:
    """一个声部的配色。

    注意是**四个颜色而不是一个**：因为描边会跟着填充一起翻色
    （双层 + 渐进 clip 方案），未唱层与已唱层各需一组填充/描边。
    颜色为 ASS 的 `&HAABBGGRR&` 格式（BGR 序，与直觉的 RGB 相反）。
    """

    name: str = "main"
    unsung_fill: str = "&H00F0F0F0&"
    unsung_outline: str = "&H00303030&"
    sung_fill: str = "&H0040C0FF&"
    sung_outline: str = "&H00202020&"


@dataclass
class KaraokeStyle:
    """排版样式。与配色分离——换声部只换配色，不动排版。"""

    font_name: str = "Noto Sans CJK JP"
    font_size: int = 64
    outline: float = 3.0
    shadow: float = 1.0
    bold: bool = False

    ruby_scale: float = 0.45
    """注音相对主文字的字号比例。"""

    ruby_gap: int = 6
    """注音基线与主文字顶部的间距（像素）。"""

    margin_v: int = 60
    """底部边距。"""

    margin_h: int = 90
    """左右边距。上行贴左边距，下行贴右边距。"""

    line_gap: int = 12
    """同屏两行之间的间距。"""

    stagger: bool = True
    """上下行左右错开排布。

    日式卡拉OK 的标志性布局：上行偏左、下行偏右。两行错开后即便同屏
    也能一眼分清哪句在唱，比两行都居中清晰得多。
    """

    lead_in_ms: int = 700
    """行至少提前出现的时间，保证不会与开唱同时冒出来。"""

    max_lead_ms: int = 5000
    """行最多提前出现的时间。

    真实卡拉OK 中下一句在当前句还在唱时就已显示，但间奏后不宜提前太久，
    否则一句歌词会孤零零挂在屏幕上。
    """

    lead_out_ms: int = 400
    """行唱完后的停留时间。"""

    countdown_dots: int = 3
    """开唱引导点的数量。0 表示关闭。"""

    countdown_beat_ms: int = 550
    """引导点之间的间隔。总倒计时时长 = 数量 × 间隔。"""

    paragraph_gap_ms: int = 3500
    """判定为间奏的最小空档。间奏后重新从上行开始，并显示引导点。"""

    slot_gap_ms: int = 350
    """同一槽位上，前一行消失与后一行出现之间必须留出的空档。

    槽位只有上下两个，隔一行就复用同一位置；不留空档时两行会短暂叠在一起。
    """

    countdown_min_gap_ms: int = 3500
    """触发引导点所需的最小空档。

    只在第一句与间奏后出现；句与句之间的正常换行不该有点，否则满屏干扰。
    """


@dataclass
class ExportArtifact:
    """一次导出产出的成片。

    工程要记住"已经导出过什么"：导出是这条管线的终点，而终点的完成状态此前
    只活在前端本次会话的内存里，刷新一次页面就退回"未完成"。

    变体不用一个枚举而用三个正交布尔位表示：ON/OFF VOCAL、引导声、片段试渲染
    可以任意组合（OFF VOCAL + 引导声正是最常用的那一种），枚举会被组合数撑爆。
    """

    path: str
    created_at: float
    """生成时刻的 Unix 时间戳（秒）。"""

    id: str = ""
    """生成它的那次导出任务的 job_id。"""

    size_bytes: int = 0
    duration_ms: int = 0
    with_guide: bool = False
    use_instrumental: bool = False
    is_excerpt: bool = False


@dataclass
class KaraokeProject:
    """一个完整的卡拉OK 工程。"""

    title: str = ""
    artist: str = ""
    lines: list[Line] = field(default_factory=list)
    style: KaraokeStyle = field(default_factory=KaraokeStyle)
    palettes: dict[str, VoicePalette] = field(default_factory=dict)

    exports: list[ExportArtifact] = field(default_factory=list)
    """已导出的成片记录。渲染层不消费它——ASS 生成与成片登记互不相干，
    但工程模型是 §4.2 的那份完整状态，不该缺一块只有 API 层知道的东西。
    """

    video_width: int = 1920
    video_height: int = 1080

    beat_grid: object | None = None
    """节拍网格（`pipeline.beat_detect.BeatGrid`），用于让引导点踩在拍子上。

    类型标注为 object 以免核心模型依赖检测实现；为 None 时渲染层退回固定间隔。
    """

    global_offset_ms: int = 0
    """整体时间轴偏移，渲染时叠加，不改写 token 时间。

    这样用户随时可以归零重来。歌词源时间轴对准的是商业发行录音，
    而我们贴的是 MV 音轨，两者存在偏移（实测赤春花 Art→MV 为 +62ms）。
    """

    def palette_for(self, voice_part: str) -> VoicePalette:
        """按声部取配色，缺失时回退到 main —— 声部可能被删但仍被行引用。"""
        return (
            self.palettes.get(voice_part)
            or self.palettes.get("main")
            or VoicePalette()
        )
