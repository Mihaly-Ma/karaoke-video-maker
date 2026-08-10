"""卡拉OK 工程的核心数据模型（第一版最小可用子集）。

完整设计见 CLAUDE.md §4.2。这里只落地出片所必需的部分，
但**字段与语义与契约保持一致**，以免第一版形成技术债。

时间单位统一为毫秒整数。ASS 的厘秒只在序列化那一刻产生，
且用"对累积时间点取整再取差"而非逐个 round，避免误差累积。
"""

from __future__ import annotations

import enum
from collections.abc import Iterable
from dataclasses import InitVar, dataclass, field


class TimingSource(enum.StrEnum):
    """时间的来源，决定它在自动重算时是否可被覆盖。"""

    PROVIDER = "provider"
    """来自歌词源（QRC 逐字轴），可信度最高。"""

    ALIGNED = "aligned"
    """本地强制对齐推算。第一版不产生此来源，但保留位置。"""

    INTERPOLATED = "interpolated"
    """由上层时间按比例插值推算，仅作占位，**不得当作锚点**。"""

    MANUAL = "manual"
    """用户手工调整过。任何自动重算都必须跳过。"""


class ReadingSource(enum.StrEnum):
    """读音的来源。优先级见 CLAUDE.md §4.5。"""

    PROVIDER_KANA = "provider_kana"
    """歌词源自带的假名轨（QRC `[kana:]`）—— 该曲实际演唱读音，优先于通用词典。"""

    DICT = "dict"
    DICT_USER = "dict_user"
    MORPH = "morph"
    """形态素分析器自动推断，对当て字必错，兜底用。"""

    ACOUSTIC = "acoustic"
    """多候选读音 + 强制对齐声学似然消歧。第一版不实现，保留位置。"""

    DERIVED = "derived"
    """由**表记读法**按确定规则推出的发音形（片假名规范化 + 整词助词 は/へ/を）。

    与上面几档不同，它不是"查到的读音"而是"从已有读音换算的另一种形态"，
    因此可信度取决于表记读法本身，且只覆盖确定的部分——长音与「ん」的音位变体
    不在其中（见 `derive_phonetic`）。界面应按"需复核"处理。
    """

    MANUAL = "manual"


# ---------------------------------------------------------------------------
# 表记读法 → 发音形
#
# 这几个函数是**领域知识**而不是编辑逻辑，所以放在模型层：注音编辑器与将来的
# 强制对齐器都要用同一套规则，各写一份必然漂移（前端 lib/kana.ts 是它的对照实现）。
# 全部是本地纯函数，不引入任何依赖（CLAUDE.md §2.1 禁止云端推理；jaconv 也不装）。


_HIRAGANA_MIN = 0x3041
_HIRAGANA_MAX = 0x3096
_KANA_GAP = 0x60
"""平假名与片假名在 Unicode 上的固定间距。"""

_HIRA_ITERATION = (0x309D, 0x309E)
"""ゝゞ，与 ヽヾ 同样相隔 0x60。"""

PARTICLE_PHONETIC: dict[str, str] = {"ハ": "ワ", "ヘ": "エ", "ヲ": "オ"}
"""书写形与发音形不一致的三个助词。

这就是 CLAUDE.md §4.2 要求两份读音同时存在的直接理由：注音行要显示「は」，
喂给强制对齐的必须是 /wa/。
"""


def to_katakana(text: str) -> str:
    """平假名 → 片假名。其余字符原样保留。

    发音形一律按片假名规范存储（§4.2），这样「は」与「ハ」不会在同一个字段里
    表示成两种东西，比较与查表都只有一种形态。
    """
    out: list[str] = []
    for ch in text:
        code = ord(ch)
        if _HIRAGANA_MIN <= code <= _HIRAGANA_MAX or code in _HIRA_ITERATION:
            out.append(chr(code + _KANA_GAP))
        else:
            out.append(ch)
    return "".join(out)


def is_kana(ch: str) -> bool:
    """是否假名（含小写假名、长音符「ー」、叠字符 ゝゞヽヾ）。"""
    code = ord(ch)
    return (
        _HIRAGANA_MIN <= code <= _HIRAGANA_MAX
        or code in _HIRA_ITERATION
        or 0x30A1 <= code <= 0x30FA
        or code in (0x30FD, 0x30FE)
        or ch == "ー"
    )


def is_kana_text(text: str) -> bool:
    """整串是否只由假名组成。空串为假。"""
    return bool(text) and all(is_kana(ch) for ch in text)


def derive_phonetic(display: str, *, surface: str | None = None) -> str:
    """由表记读法推出发音形；**推不出来时返回空串**，由界面提示用户填。

    只做两件**确定**的事：

    1. 规范成片假名；
    2. 书写形整词就是助词 は/へ/を 时换成实际发音 ワ/エ/オ。

    刻意不做的事：**不猜长音，也不猜「ん」的音位变体**。「おう」在「王」是长音、
    在「問う」是两拍，纯假名串无法确定性还原（CLAUDE.md §9 第 7 项，要靠
    `pyopenjtalk.g2p` 才有定论）。发音形是喂强制对齐的，猜错会把整句轴带偏，
    比留空更糟——留空至少用户看得见"这里还没定"。

    `surface` 是该单元的**书写形**，助词替换只看它：「葉(は)」的读音同样是 は，
    但它是名词、读 /ha/，只按读音判断会把它错换成 ワ。缺省时表示书写形就是读音
    本身（纯假名单元）。
    """
    src = display.strip()
    if not is_kana_text(src):
        # 含汉字/拉丁字母的"读音"不是读音（如未注音的汉字块、`sumika` 这类原文），
        # 没有任何确定规则能把它变成假名串
        return ""
    base = to_katakana((surface if surface is not None else src).strip())
    return PARTICLE_PHONETIC.get(base, to_katakana(src))


@dataclass
class RubySpan:
    """一段注音（**表记读法**）：把行内字符区间 [start, end) 标注为 `text`。

    纯假名区间不应出现在这里，否则会渲染出「あ|あ」这种冗余标注。

    这是**要渲染出来的那一份读音**；喂强制对齐的发音形是另一份，见 `PhoneticSpan`。
    """

    start: int
    end: int
    text: str
    source: ReadingSource = ReadingSource.PROVIDER_KANA
    locked: bool = False
    """用户手工锁定后，自动重算不得覆盖。"""


@dataclass
class PhoneticSpan:
    """一段**发音形**：行内字符区间 [start, end) 实际唱出来的假名（片假名规范）。

    ## 为什么与 `RubySpan` 分开存，而不是给它加一个字段

    §4.2 要求 `reading_display` 与 `reading_phonetic` 同时存在，但本模型里
    **没有"词/词素"那一层**：`Token` 是计时单元（一个 `\\k` 块，实测 99% 是单个
    书写字符），把读音挂上去会立刻撞上 §4.2 说的粒度冲突——「学校」的
    ガッコウ 无法确定地劈成「学」「校」两半。真正承载读音的是**字符区间**，
    也就是这里的 span。

    而发音形不能挂在 `RubySpan` 上：契约给的那个例子——助词「は」读作 ワ——
    正好发生在**没有注音的纯假名字符**上（纯假名区间不允许出现在 `ruby` 里），
    挂上去就表达不了。反过来把无注音的 span 塞进 `ruby` 也不行：渲染层会把
    `ruby` 里的每一条都排版出来。

    分成两层还有一个好处：两份读音**各自带 source 与 locked**（§4.4）。
    用户常常认可歌词源给的注音、只想改发音形，两者共用一个锁就做不到。
    """

    start: int
    end: int
    text: str
    source: ReadingSource = ReadingSource.DERIVED
    locked: bool = False
    """用户手工锁定后，自动重算（推导、将来的 G2P）不得覆盖。"""


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

    phonetics: list[PhoneticSpan] = field(default_factory=list)
    """发音形覆盖层，与 `ruby` 同一套行内字符索引，区间之间不重叠。

    渲染层不消费它（成片上要显示的是 `ruby`），它服务于强制对齐与注音编辑器。
    老工程文件没有这个字段，`default_factory` 保证照常读取。
    """

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


DEFAULT_FONT_CHAIN = ("Noto Sans CJK JP",)
"""字体链的兜底取值。链**永远不为空**——空链等于没有字体，libass 会退到自带的
Liberation Sans，日文整片渲成豆腐块，而且不报错。"""


def normalize_font_chain(names: Iterable[str], legacy: str | None = None) -> list[str]:
    """把任意来源的字体链整理成规范形态：去空白、去空串、去重、保底非空。

    **这条规则必须只有一份实现。**领域模型（`KaraokeStyle`）与传输层
    （`api.schemas.StyleDTO`）各写一份的话，同一份工程经不同路径读出来会
    不一样，而这类漂移只在"用户配了两个字体、某个面板只认一个"这种场合
    偶然暴露一次，极难复现。

    `legacy` 是老工程里那个单个 `font_name`。**只在 `names` 整理后为空时才认它**：
    两者同时存在是常态（DTO 一直镜像着 `font_name`），规则含糊会让"打开工程
    少一个字体"随时序发生。

    去重保留首次出现的位置——链尾重复链首毫无意义，却会让"这个字体承担了
    几个字"的归属统计冒出两条同名条目。
    """
    chain: list[str] = []
    for candidate in names:
        name = (candidate or "").strip()
        if name and name not in chain:
            chain.append(name)
    if not chain and legacy and legacy.strip():
        chain = [legacy.strip()]
    return chain or list(DEFAULT_FONT_CHAIN)


@dataclass
class KaraokeStyle:
    """排版样式。与配色分离——换声部只换配色，不动排版。"""

    font_names: list[str] = field(default_factory=list)
    """有序字体候选链：链首缺哪个字形，就落到后面那个。

    **默认值是空列表而不是默认链**，因为构造时要分得清"调用方没给链"与
    "调用方给了链"——只有前者才轮得到兼容入口 `font_name` 说话。
    `__post_init__` 结束后本字段**恒非空**（空则填 `DEFAULT_FONT_CHAIN`）。

    ## 为什么是一条链而不是一个族名

    没有一个日文字体覆盖得全。「鷗」「𠮷」「①」「㍿」这类字在常见字体里
    时有时无，而缺字的后果是不对称的（CLAUDE.md §2.6 / §6.3）：预览走 JASSUB
    （`ASS_FONTPROVIDER_NONE`），手里只有我们喂进去的字体，缺了就是空白；
    导出走 ffmpeg，系统回退**无法禁用**，它会自己找个字体顶上。同一个字
    两端各画各的，WYSIWYG 当场失效，而这种事往往到成片才被发现。

    链把"缺字时用谁"从**两端各自的默认行为**变成了**工程里显式记着的一份数据**，
    两端照着同一份数据走，才谈得上同源。

    ## 顺序是怎么真正生效的（实测，别改成想当然的做法）

    libass **不会**在族名互不相同的已加载字体之间做缺字回退：内嵌一份
    带该字形的字体、族名与请求的不同时，ffmpeg 侧照样去用系统字体
    （`experiments/ass_embedded_fonts.py` 的 distinct 组）。

    真正生效的机制是：**把链上每个字体都改写成链首的族名**，让它们成为
    同一个族的多个字面，libass 于是在这几个字面里挑一个带该字形的——
    这是字体匹配的基本功能，不是回退启发式，两端一致。改写在
    `render.font_subset.subset_font(family_name=...)` 里做，同时把
    `usWeightClass` 归一到 400，否则字重距离会让链首失去优先权。

    因此本字段的**首项有特殊地位**：它既是 ASS `Fontname` 写的那个族名，
    也是全链改写后共用的族名。
    """

    font_name: InitVar[str | None] = None
    """**只读的兼容入口**，不是字段。老工程 JSON（以及为兼容而保留 `font_name`
    镜像的 `StyleDTO`）传进来的是单个族名，`__post_init__` 会把它升成单元素链。

    取当前主字体请用 `primary_font`。
    """

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

    fade_in_ms: int = 400
    """每句淡入时长（毫秒）。

    **每一句都淡，不只是段落首/末行。** 段内行硬切在换句密集处很跳——
    一句字忽然消失、另一句忽然顶上，比淡化难看得多。

    数值不取 nicokara 经典的 666ms：那个值是给段落首行的，那里有整段间奏可用；
    每句都淡的话，密集段（赤春花实测隔行同槽位间隔 p10 仅 2.3s）会有大半时间
    挂在半透明状态。400ms 在 30fps 下是 12 帧，足够看出是"浮现"而不是硬切，
    又短到不占用宝贵的阅读时间。

    **必须 ≤ `lead_in_ms`**，否则开唱时字还没完全浮现。
    """

    fade_out_ms: int = 400
    """每句淡出时长（毫秒）。与淡入取同值，进出观感对称。

    **必须 ≤ `lead_out_ms`**，否则最后一个字还在唱、字就开始变淡了。
    这也是同槽位换行的实际瓶颈：前一行最早只能在唱完后 `fade_out_ms` 才彻底消失。
    """

    lead_in_ms: int = 2000
    """行至少提前出现的时间（从开始淡入算起）。

    §5.8 记的经典 nicokara 提前量在不开引导点时是 2.0s。原来的 0.7s 太短——
    扣掉淡入几乎与人声同时冒出来，读不完一行 12–20 个全角字。
    2000 - `fade_in_ms` = 1.6s 完全不透明的阅读时间。

    这是**下限保证**而非目标值：段内行通常从上一行开唱起就已显示（见
    `max_lead_ms`），段落首行则按 `paragraph_lead_ms` 提前得更多。
    """

    max_lead_ms: int = 5000
    """段内行最多提前出现的时间。

    真实卡拉OK 中下一句在当前句还在唱时就已显示。段落首行不受此约束，
    走 `paragraph_lead_ms`。
    """

    lead_out_ms: int = 900
    """行唱完后到**完全消失**为止的停留时间。

    900 = 500ms 完全不透明的余韵 + 400ms 淡出。原来的 400 刚好等于淡出时长，
    等于最后一个字一唱完就立刻开始变淡，收尾显得急。
    同槽位挤不下时这段会被压缩，但压缩的下限是 `fade_out_ms`（见 `ass_builder`）。
    """

    paragraph_lead_ms: int = 4200
    """段落首行（连同它的第二行与引导点）提前出现的时间。

    §5.8 的经典总提前量 fade(0.666s) + 0.5s + indicator(3s) = 4.17s 取整。
    间奏之后屏幕本来就是空的，早点把接下来两句摆出来让演唱者预读，
    比卡着开唱前一两秒才冒出来从容得多。

    实际提前量还会被上一段最后一句的收尾时间顶回来——间奏只有
    `paragraph_gap_ms`（3.5s）那么长时，提前 4.2s 会压到上一句身上。
    """

    countdown_dots: int = 3
    """开唱引导点的数量。0 表示关闭。"""

    countdown_beat_ms: int = 550
    """引导点之间的间隔。仅在节拍检测失败、退回固定间隔时使用。

    有节拍网格时点踩在真实拍点上，间隔由 BPM 决定，本字段不参与。
    """

    countdown_lead_ms: int = 750
    """引导点在**第一个点熄灭之前**多久亮起。

    点的语义是倒计时，它该在快要开始数的时候才出现。跟着歌词一起浮现的话，
    段落首行提前 `paragraph_lead_ms`（4.2s）而熄灭只占最后几拍，点会先亮着
    不动两三秒——那就只是个静止装饰，读不出"要开始数了"。

    750ms 取自 §5.8 的经典指示灯：4 点、总时长 3s、每 0.75s 熄一个——
    换算下来点正是在第一个点熄灭前**一拍**亮起，够看见它出现，又立刻开始数。

    **刻意不复用 `countdown_beat_ms`**：那个字段现在只在节拍检测失败时决定
    熄灭间隔，与"提前多久亮"是两件事；混在一个字段上，用户调其中一个会
    莫名其妙地改到另一个。

    点**绝不会早于它所提示的那句歌词出现**——歌词还没浮现就先冒出三个点，
    观众不知道它们指向哪一句。所以实际提前量会被歌词的出现时刻夹住。
    """

    paragraph_gap_ms: int = 3500
    """判定为间奏的最小空档。间奏后重新从上行开始，并显示引导点。"""

    slot_gap_ms: int = 350
    """同一槽位上，前一行**完全消失**与后一行**开始淡入**之间必须留出的空档。

    槽位只有上下两个，隔一行就复用同一位置；不留空档时两行会短暂叠在一起。
    两端都按"完全消失/开始出现"计量，所以本字段不需要再额外容纳淡化时长——
    前一行淡完了后一行才开始淡入，两段淡化天然不重叠。
    """

    countdown_min_gap_ms: int = 3500
    """触发引导点所需的最小空档。

    只在第一句与间奏后出现；句与句之间的正常换行不该有点，否则满屏干扰。
    """

    def __post_init__(self, font_name: str | None) -> None:
        """把老工程的单个 `font_name` 升成链，并保证链非空、无重复、无空串。

        规则本身在 `normalize_font_chain`——传输层用的是同一个函数。
        """
        self.font_names = normalize_font_chain(self.font_names, font_name)

    @property
    def primary_font(self) -> str:
        """主字体族名：ASS `Fontname` 写的那个，也是全链改写后共用的族名。

        链恒非空（见 `__post_init__`），所以这里不必考虑空链。
        """
        return self.font_names[0]


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
        return self.palettes.get(voice_part) or self.palettes.get("main") or VoicePalette()
