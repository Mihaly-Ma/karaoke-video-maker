"""HTTP API 的数据契约。

前端类型由 FastAPI 导出的 OpenAPI 自动生成（见 frontend/package.json 的 gen:api），
**不要手写两份类型**——手写必然漂移。

命名与 `models.karaoke` 保持一致：API 是工程模型的传输表示，不是另一套概念。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, computed_field

# ---- 工程 ----


class CharSpanDTO(BaseModel):
    """挂在行内字符区间 `[start, end)` 上的一段读音。

    抽出公共基类是为了让"拆行时按字符切点迁移区间"这套逻辑只写一遍
    （见 `editing.ops._partition_spans`）：表记读法与发音形的迁移规则完全一样，
    各写一份必然在某次改动后只改对一个。
    """

    start: int
    end: int
    text: str
    source: str = "provider_kana"
    locked: bool = False


class RubySpanDTO(CharSpanDTO):
    """**表记读法**（振り仮名）：要渲染到成片上的那一份读音。

    纯假名区间不出现在这里（会渲染成「あ|あ」这种冗余标注）。
    """


class PhoneticSpanDTO(CharSpanDTO):
    """**发音形**：这段字实际唱出来的假名，片假名规范存储。

    §4.2 要求两份读音同时存在：注音行显示「は」，喂强制对齐的必须是 ワ。
    只存一份是系统性 bug 源——要么注音显示错，要么对齐器拿着 /h/ 去找实际唱的 /w/。

    **单独成一层而不是给 `RubySpanDTO` 加字段**：助词 は→ワ 恰恰发生在没有注音的
    纯假名字符上，挂在注音上表达不了；而把无注音的条目塞进 `ruby` 会被渲染层
    当成要画出来的注音。理由详见 `models.karaoke.PhoneticSpan`。

    区间与 `ruby` 用同一套行内字符索引，彼此不重叠。缺省 `source` 是 `derived`
    （由表记读法按确定规则推出），用户手填的是 `manual`。
    """

    source: str = "derived"


class TokenDTO(BaseModel):
    text: str
    start_ms: int
    dur_ms: int

    timing_source: str = "provider"
    """`provider` / `aligned` / `interpolated` / `manual` / `unset`。

    `unset` 表示**从未定过时**（如纯文本导入后等待手工打轴），
    与 `manual`（用户确实调过）语义不同——混用会让人误以为这个时间是用户认可的。
    """

    locked_timing: bool = False

    timing_granularity: str = "provider_char"
    """该 token 时间的**权威粒度**：`provider_char` / `mora` / `line`。

    低于权威粒度的时间由插值产生，禁止标成 provider/aligned（CLAUDE.md §4.2）。
    """

    voice_part: str | None = None
    """声部覆盖。为 None 时继承所在行的 `voice_part`。

    对唱歌曲一行内男女交替是常态（`A: 君の / B: 声が / 合: 聞こえる`），
    只支持行级声部的话这类句子无法正确分色。
    """

    locked_voice: bool = False

    tid: str = ""
    """内容寻址身份键，用于在重新分行后重新绑定手工修改。

    CLAUDE.md §4.4 明确禁止用"第几行第几个 token"做主键——重新分行后必然漂移，
    锁定项会全部错位。API 出于易用性仍接受 `token_index` 定位，
    但**跨越重新分行的引用必须用 tid**。
    """


class LineDTO(BaseModel):
    id: str
    tokens: list[TokenDTO] = Field(default_factory=list)
    ruby: list[RubySpanDTO] = Field(default_factory=list)

    phonetics: list[PhoneticSpanDTO] = Field(default_factory=list)
    """发音形覆盖层（见 `PhoneticSpanDTO`）。与 `ruby` 同一套行内字符索引。

    **按需物化**：只有推导过或用户填过的工程才有内容，空列表表示这首歌还没启用
    这一层——所以结构性编辑（拆行/并行/改注音）不会凭空替空列表造出发音形。

    老工程 JSON 没有这个字段，`default_factory` 保证照常读取（与本模型其余字段
    一致的兼容做法，不需要迁移函数）。
    """

    voice_part: str = "main"
    slot: int = 0
    is_metadata: bool = False
    locked: bool = False


class PaletteDTO(BaseModel):
    name: str = "main"
    unsung_fill: str = "&H00FFFFFF&"
    unsung_outline: str = "&H00202020&"
    sung_fill: str = "&H00FF9010&"
    sung_outline: str = "&H00501800&"


class StyleDTO(BaseModel):
    font_name: str = "Noto Sans CJK JP"
    font_size: int = 64
    bold: bool = True
    outline: float = 3.0
    shadow: float = 1.0
    ruby_scale: float = 0.45
    ruby_gap: int = 6
    margin_v: int = 60
    margin_h: int = 90
    line_gap: int = 12
    stagger: bool = True
    lead_in_ms: int = 700
    max_lead_ms: int = 5000
    lead_out_ms: int = 400
    paragraph_gap_ms: int = 3500
    slot_gap_ms: int = 350
    countdown_dots: int = 3
    countdown_beat_ms: int = 550
    countdown_min_gap_ms: int = 3500


class OrphanedEdit(BaseModel):
    """一条无法重新绑定的手工修改。

    CLAUDE.md §4.4：重绑失败的锁定项**不得静默丢弃** ——
    用户调了 40 分钟的轴莫名消失，比报错更糟。这些条目要浮到界面上让用户确认。
    """

    kind: str
    """`ruby` / `phonetic` / `timing` / `voice_part`。"""

    detail: str
    """人类可读的中文说明，例如"「明日」的注音 あした 在拆行后跨越了分界"。"""

    payload: dict = Field(default_factory=dict)
    """原始数据，供用户选择重新应用。"""


class ExportArtifactDTO(BaseModel):
    """一条已导出的成片记录。

    工程此前完全不知道"导出过什么"：导出步骤的完成状态只活在前端本次会话的内存里，
    刷新一次页面就退回"未完成"，历史产物也列不出来。一次 4K 全片烧录要几分钟，
    这种状态不该随刷新蒸发。

    **不要直接拿 `ProjectDTO.exports` 当"产物可用"的依据**——用户随时会把成片
    挪走或删掉。走 `GET /api/render/exports/{project_id}`，那里会核对文件是否还在
    （与 `ProxyStatus.ready` 同一判据：以文件实际存在为准，不以字段有没有值为准）。
    """

    id: str
    """产物 id，取自生成它的那次导出任务的 job_id，便于把记录与任务日志对上。"""

    path: str
    """成片的绝对路径。"""

    created_at: float
    """生成时刻的 Unix 时间戳（秒）。"""

    size_bytes: int = 0
    duration_ms: int = 0
    """成片实际时长（ffprobe 实测）。探测失败时回退到请求/工程时长。"""

    with_guide: bool = False
    """混入了引导声（ガイドメロディ）。"""

    use_instrumental: bool = False
    """True = OFF VOCAL（伴奏轨），False = ON VOCAL（含人声的原音轨）。"""

    is_excerpt: bool = False
    """片段试渲染（导出时给了 start/duration），不是整首成片。

    单独标出来是因为它与整片在文件上无从分辨，用户一周后回来看到两个 mp4
    没办法知道哪个是能发出去的那份。
    """

    @computed_field
    @property
    def variant_label(self) -> str:
        """给界面直接显示的中文变体名，如「OFF VOCAL + 引导声」。

        由上面三个布尔位派生而不是另存一个字段：存文案会和布尔位漂移，
        改文案还得迁移老工程。
        """
        parts = ["OFF VOCAL" if self.use_instrumental else "ON VOCAL"]
        if self.with_guide:
            parts.append("引导声")
        if self.is_excerpt:
            parts.append("片段")
        return " + ".join(parts)


class ProjectDTO(BaseModel):
    """完整工程。前端的唯一真源，编辑器所有操作都作用于它。"""

    id: str
    title: str = ""
    artist: str = ""
    lines: list[LineDTO] = Field(default_factory=list)
    style: StyleDTO = Field(default_factory=StyleDTO)
    palettes: dict[str, PaletteDTO] = Field(default_factory=dict)
    video_width: int = 1920
    video_height: int = 1080
    global_offset_ms: int = 0

    video_path: str | None = None
    """**原始**视频文件。导出成片一律用它，绝不用 `proxy_video_path`。"""

    proxy_video_path: str | None = None
    """编辑用代理视频（H.264 / MP4 / 短 GOP / 无音轨），**只服务于编辑器预览**。

    原始视频常是 AV1 + Matroska + Opus：Safari 三重放不了（没有 Matroska 解复用器、
    不认 MKV 里的 Opus、M1/M2 也没有 AV1 硬解），4K 长 GOP 还会让逐帧核对音节边界
    卡到没法用。代理解决这两件事，见 `kvm.media.proxy`。

    为 None 表示还没生成（老工程文件缺这个字段也会落到 None，可正常读取）；
    前端据此判断"代理是否已就绪"，未就绪就回退用原视频，**不因此阻断预览**。
    """

    audio_path: str | None = None
    instrumental_path: str | None = None
    vocals_path: str | None = None
    drums_path: str | None = None
    duration_ms: int = 0

    audio_format_id: str = ""
    """实际使用的音频流标识。

    实测同一 YouTube 视频的 opus(251) 与 aac(140) **原点相差 36.7ms**，
    所以下载、分离、重锚定、烧录必须锁同一条流；换流必须重跑重锚定。
    """

    orphans: list[OrphanedEdit] = Field(default_factory=list)
    """重绑失败的手工修改，等待用户确认。见 `OrphanedEdit`。"""

    exports: list[ExportArtifactDTO] = Field(default_factory=list)
    """已导出的成片记录，按生成先后追加（新的在末尾）。见 `ExportArtifactDTO`。

    老工程 JSON 里没有这个字段，`default_factory` 保证它们照常读取（与本模型
    其余字段一致的兼容做法，不需要迁移函数）。

    由导出作业经 `ProjectStore.update_derived()` 写入，**不占撤销格**：
    成片是后台产物，不是用户的一次编辑意图（CLAUDE.md §8）。
    """


class ProjectSummary(BaseModel):
    id: str
    title: str
    artist: str
    updated_at: float
    duration_ms: int
    line_count: int


# ---- 歌词搜索 ----


class LyricCandidate(BaseModel):
    """一条歌词候选。

    展示给用户挑选，**不自动替他选**（CLAUDE.md §5.2：resolver 只排序不裁决）。
    界面必须显示 granularity 与 has_ruby——这两项决定用户还要不要手工打轴/注音。

    这条来自 `/search`，provider 此时通常只看到曲目元信息、还没下载歌词正文，
    因此 `granularity`/`has_ruby` 在这一阶段可能确实无法确定——**三态而非
    二态**：`granularity="unknown"` / `has_ruby=None` 表示"还不知道，需要
    `/preview` 才能确认"，不是"没有"。之前的实现把 provider 的整体能力
    （"QQ 音乐一般有逐字注音"）当成了每条结果的确定事实，导致徽章与
    `/preview` 实际解析结果不一致（CLAUDE.md §5.2 铁律：粒度可以被提升，
    不能被伪造）。前端拿到 `unknown`/`None` 时应显示"未知，需预览确认"，
    不能当作 False 直接隐藏"含注音"徽章，也不能当作 True 直接显示它。
    `/preview`、`/apply` 返回的 `LyricPreview.granularity`/`has_ruby` 永远是
    确定值（fetch() 已解析出正文），不受这条三态语义影响。
    """

    provider: str
    song_id: str
    title: str
    artist: str
    album: str = ""
    duration_ms: int = 0
    granularity: Literal["word", "line", "plain", "unknown"] = "unknown"
    has_ruby: bool | None = None
    """`None` = 搜索阶段未知，需 `/preview` 确认；`True`/`False` = 确认过的真实值。"""
    has_translation: bool = False
    score: float = 0.0
    note: str = ""


class LyricSearchRequest(BaseModel):
    query: str
    providers: list[str] | None = None
    duration_hint_ms: int | None = None
    """视频时长。用于识别错配版本（live/remix），只影响排序不做过滤。"""


class LyricSearchResponse(BaseModel):
    candidates: list[LyricCandidate]
    errors: dict[str, str] = Field(default_factory=dict)
    """按 provider 记录失败原因。**部分源失败不影响其余结果**。"""


class LyricFetchRequest(BaseModel):
    provider: str
    song_id: str


class LyricApplyRequest(LyricFetchRequest):
    """把歌词写入指定工程。"""

    project_id: str


class LyricPreview(BaseModel):
    """下载前的预览。用户要能看到实际内容再决定用哪条。"""

    lines: list[LineDTO]
    granularity: str
    has_ruby: bool
    raw_excerpt: str = ""


class LyricImportRequest(BaseModel):
    """手工导入歌词。

    搜索是日常主路径，但**通用性来自手工能力而非自动覆盖率**——
    冷门曲、同人曲、翻唱在任何歌词库都可能查不到，这条路必须始终可用，
    且不能是"搜索失败后的惩罚性回退"，要能随时主动使用。

    - `text`：纯文本，一行一句，无时间轴，导入后靠手工打轴
    - `lrc`：LRC 格式，带行级时间轴
    - `qrc`：已解密的 QRC XML，带逐字轴与假名
    """

    project_id: str
    kind: Literal["text", "lrc", "qrc"]
    content: str
    replace: bool = True
    """False 表示追加到现有歌词之后。"""


# ---- 媒体 ----


class DownloadRequest(BaseModel):
    project_id: str
    """下载结果写入的目标工程。下载不再隐式新建工程——用户通常先建工程再往里
    放素材，且"先导入本地音频、再补下载视频"这类组合需要一个既有工程 id 才能
    表达（前端 `client.ts` 的 `download()` 已按此签名调用）。
    """

    url: str
    prefer_audio_quality: bool = True
    """选流时音频优先于画质——音频质量决定分离与对齐上限，视频只是背景。"""


class SeparateRequest(BaseModel):
    project_id: str
    model: str = "standard"
    """人声分离档位 id（`fast` / `standard` / `best`，见 `SeparateModelTier`）。

    默认值必须与 `MODEL_TIERS` 里标了 `recommended` 的那档一致，否则不带 `model`
    字段的 API 直调会跑出与 UI 默认不同的档位。

    **传档位名而不是模型文件名**：模型文件名属于 audio-separator 的命名空间，
    换模型时不该逼前端跟着改。为兼容高级用户与历史调用，后端也接受字面模型
    文件名（甚至不带扩展名的写法），由 `kvm.media.separate` 的子进程在
    audio-separator 的受支持列表里做一次容错匹配。
    """


class SeparateModelTier(BaseModel):
    """一个人声分离档位（CLAUDE.md §5.4 的三档）。

    由 `GET /api/media/separate/models` 返回，让前端不必硬编码模型文件名——
    前端只认 `id`，展示用 `label` / `hint`，换模型只改后端一处。
    """

    id: str
    """前后端约定的传输值，也就是 `SeparateRequest.model` 该填的东西。"""

    label: str
    model_filename: str
    """实际传给 audio-separator 的文件名，仅供展示/排查，前端不要拿它当传输值。"""

    hint: str
    recommended: bool = False
    """默认选中的档位。同一时刻只应有一个档位为真。"""

    warning: str = ""
    """已知问题提示（本机实测有问题的档位），为空表示没有已知问题。"""


class JobStatus(BaseModel):
    """长任务状态。所有耗时操作都走这个统一形态。"""

    job_id: str
    kind: str
    state: Literal["pending", "running", "done", "failed", "cancelled"]
    progress: float = 0.0
    message: str = ""
    error: str = ""
    result: dict = Field(default_factory=dict)


class ProxyRequest(BaseModel):
    """生成编辑用代理视频（见 `kvm.media.proxy`）。"""

    project_id: str

    max_height: int = 540
    """代理画面的高度上限，按宽高比等比缩小。540p 实测足够核对口型与字幕位置。"""

    force: bool = False
    """True 表示忽略缓存强制重新生成（换了编码器或想换分辨率时用）。"""


class ProxyStatus(BaseModel):
    """工程的代理视频状态。

    前端需要一个入口同时回答两个问题：代理**现在能不能用**（决定 `<video>` 的
    src 取代理还是原视频），以及**有没有任务正在跑**——后者尤其重要，因为下载
    / 导入之后的代理任务是后端自动发起的，前端没有别的途径知道那个 job_id。
    """

    project_id: str
    ready: bool
    """代理文件已生成且确实存在。为 False 时前端回退用原视频，不阻断预览。"""

    path: str | None = None
    job: JobStatus | None = None
    """最近一次代理任务，用于展示进度/失败原因。后端重启后为 None。"""

    note: str = ""
    """给用户看的一句话中文说明。"""


# ---- 渲染 ----


class RenderRequest(BaseModel):
    project_id: str
    start_s: float | None = None
    duration_s: float | None = None
    with_guide: bool = False
    use_instrumental: bool = False


class AssResponse(BaseModel):
    ass: str
    event_count: int


# ---- 编辑操作 ----


class ShiftRequest(BaseModel):
    """时间平移。三级调轴的统一入口。

    scope=global 忽略 target；scope=line 用 line_id；scope=token 用 line_id+token_index。
    **平移会把受影响项标记为 manual 并锁定**，此后自动重算不得覆盖。
    """

    project_id: str
    scope: Literal["global", "line", "token"]
    delta_ms: int
    line_id: str | None = None
    token_index: int | None = None


class SetTimingRequest(BaseModel):
    project_id: str
    line_id: str
    token_index: int
    start_ms: int | None = None
    dur_ms: int | None = None


class TimingItem(BaseModel):
    """批量调轴里的一项。`start_ms` 与 `dur_ms` 至少要给一个。"""

    line_id: str
    token_index: int
    start_ms: int | None = None
    dur_ms: int | None = None


class SetTimingsRequest(BaseModel):
    """批量设定音节时间。

    tap-to-time 打完一整首歌、或开启边界联动拖一次边界，一次操作本来就会
    改到多个音节。逐个调 `/timing` 会让这一次操作占掉 N 步撤销，
    与「重跑对齐是**一个** undo 单元而不是 N 个」（CLAUDE.md §8）直接冲突，
    因此批量入口是必需项而不是性能优化。

    `items` 按给出的顺序**依次**应用，越界夹紧以「应用到该项时的状态」为准。
    重写整行时请按 token 顺序给出，否则夹紧会参照尚未更新的邻居。
    """

    project_id: str
    items: list[TimingItem] = Field(default_factory=list)


class LockItem(BaseModel):
    """一条锁定变更。`target` 决定改的是音节时间锁、注音锁还是发音形锁。"""

    line_id: str
    target: Literal["timing", "ruby", "phonetic"] = "timing"
    locked: bool = True
    """False 表示解锁，让自动重算重新接管这一项。"""

    token_index: int | None = None
    """`target=timing` 时必填。"""

    ruby_range: tuple[int, int] | None = None
    """`target=ruby` 时必填，须与已有注音的字符区间**完全一致**。"""

    phonetic_range: tuple[int, int] | None = None
    """`target=phonetic` 时必填，须与已有发音形的字符区间**完全一致**。

    与 `ruby_range` 分成两个字段而不是共用一个：同一个字符区间上通常两份读音
    都在，共用字段就无法表达"只锁发音形、注音仍交给自动流程"——而这恰恰是
    §4.4 把两份读音各配一个 `locked` 的意义。
    """


class SetLockRequest(BaseModel):
    """批量设置/清除锁定。

    §4.4：自动重算只覆盖 `locked=False` 的项。用户必须能主动钉住某条边界或
    某段注音，否则界面上的 🔒 只是个只读徽章——重跑一次对齐就把他的判断抹掉了。

    **本操作只改锁标记、不改值，因此不把 `source` 标成 manual**：
    把歌词源给的时间标成手工会伪造来源，让 §7.4 的来源配色失去依据。
    """

    project_id: str
    items: list[LockItem] = Field(default_factory=list)


class SetRubyRequest(BaseModel):
    project_id: str
    line_id: str
    start: int
    end: int
    text: str


class SetPhoneticRequest(BaseModel):
    """设定某个字符区间的**发音形**（§4.2 的 `reading_phonetic`）。

    区间口径与 `SetRubyRequest` 完全一致（行内字符索引，左闭右开），
    通常就是注音区间本身；助词那一类则是没有注音的单个假名。
    """

    project_id: str
    line_id: str
    start: int
    end: int

    text: str
    """空串表示**清除手工覆盖**，让这一段回到自动推导值（推不出来就留空）。

    非空时按片假名规范化后存储，并标成 `manual` + `locked`——用户手填发音形
    正是为了纠正自动推导，不锁住的话下一次推导就把它换回去了。
    """


class DerivePhoneticsRequest(BaseModel):
    """由表记读法批量推导发音形。

    这是 §4.4 意义上的"自动重算"：**只覆盖 `locked=False` 的项**，
    用户锁过的发音形一个字都不动。推不出来的（未注音的汉字、拉丁词）留空，
    界面据此提示用户补。

    是用户主动点的按钮，所以照常占一格撤销——推导会一次改到几百段发音形，
    没有撤销就等于不可逆。
    """

    project_id: str
    line_ids: list[str] | None = None
    """只推导这几行；缺省表示整首歌。"""


class SplitLineRequest(BaseModel):
    project_id: str
    line_id: str
    token_index: int


class MergeLineRequest(BaseModel):
    project_id: str
    line_id: str
    """与下一行合并。"""


class SetMetadataRequest(BaseModel):
    """标记/取消标记一行为制作名单（词/曲/编曲/制作人……）。

    导入时按"时间早于首句人声 **且** 文本形如 `词：xxx`"自动判定，而这条启发式
    必然有误判：真正在前奏里唱的歌词、含 ` - ` 的歌名式歌词都会被误伤，
    反过来歌词源把名单写成别的格式时又会漏判——漏判的后果是视频开头闪出五行
    像乱码一样的名单（CLAUDE.md §6.1）。

    §2.5：每个自动环节都必须有等价的手工旁路，这就是那条旁路。
    """

    project_id: str
    line_id: str
    is_metadata: bool


class SetVoicePartRequest(BaseModel):
    project_id: str
    line_id: str

    voice_part: str
    """空串表示**清除**区间内的 token 级覆盖，让这些音节回到继承行声部。

    只有给出 `token_range` 时才允许传空串：一行总得有个声部。
    """

    token_range: tuple[int, int] | None = None
    """给定则只作用于该 token 区间——对唱歌曲一行内男女交替是常态。

    区间指派**直接写 `TokenDTO.voice_part`**，不拆行：拆行会让这几段各占一个
    槽位，屏幕上看起来是三句话而不是一句对唱。
    """


# ---- 配色 ----


class PaletteTemplate(BaseModel):
    """一套可跨工程复用的配色。

    模板是**全局资源，不属于任何工程**：用户调出一套满意的配色之后，
    下一首歌还要用同一套，存进工程文件等于每首歌都要重调一遍。

    每个声部需要**四个颜色**（未唱填充/未唱描边/已唱填充/已唱描边），
    因为描边跟着填充一起翻色（双层 clip 方案），两层各需一组。
    """

    name: str
    description: str = ""
    builtin: bool = False
    """内置模板：不可删除、不可被同名覆盖。"""

    palettes: dict[str, PaletteDTO] = Field(default_factory=dict)
    """按声部名索引，如 `main` / `duet_a` / `duet_b` / `chorus`。"""


class PaletteUpdateRequest(BaseModel):
    """更新工程配色。

    `template` 与 `palettes` 可以同时给出：先套模板，再用 `palettes` 覆盖其中几项。
    这样"套用模板后微调"仍然是一步操作、一格撤销。
    """

    template: str | None = None
    """模板名。给出则先把该模板的配色并进来。"""

    palettes: dict[str, PaletteDTO] | None = None

    replace: bool = False
    """True 表示整体替换（未出现的声部配色被删掉），False 表示按声部合并。"""


class PaletteTemplateSaveRequest(BaseModel):
    """把一套配色保存为模板。

    给出 `project_id` 时直接取该工程当前的配色（"保存当前配色为模板"是主路径，
    用户不该为了存个模板再把颜色抄一遍）；否则用请求体里的 `palettes`。
    """

    name: str
    description: str = ""
    project_id: str | None = None
    palettes: dict[str, PaletteDTO] = Field(default_factory=dict)


# ---- 媒体探测 / 波形峰值 ----
#
# 补齐 CLAUDE.md §5.10（波形峰值预计算）与探测两个媒体接口。前端此前分别用
# 手写 Range + RIFF chunk 遍历、以及整段解码 PCM 凑合，见 `kvm.media.probe`
# 与 `kvm.media.waveform` 模块文档。


class MediaTrackInfo(BaseModel):
    """一条媒体轨的 ffprobe 探测结果。

    `exists=False` 时只有 `error` 有意义——工程记录着路径但文件已经不在磁盘上
    （被移动/清理），这不是"这个 kind 从未有过素材"（那种情况路由层直接 404，
    与 `GET /api/media/file/{project_id}/{kind}` 同一判据），而是"自动环节的
    错误必须可见，不能终止"（CLAUDE.md §2.5）的一个具体样例：批量探测时一条
    轨读失败不该连累其余轨。
    """

    kind: str
    path: str
    exists: bool = True
    error: str = ""

    duration_ms: int = 0
    size_bytes: int = 0

    sample_rate_hz: int | None = None
    channels: int | None = None
    audio_codec: str = ""

    width: int | None = None
    height: int | None = None
    fps: float | None = None
    video_codec: str = ""


class MediaProbeResponse(BaseModel):
    """一个工程当前全部媒体轨的探测结果，按 kind 索引。

    只包含工程里**已经有路径**的 kind——素材面板要展示"目前有哪些轨"，
    不该对着还没导入的轨逐一报 404。
    """

    project_id: str
    tracks: dict[str, MediaTrackInfo] = Field(default_factory=dict)


class WaveformLevelInfo(BaseModel):
    """一级 LOD 的规格：多少个原始采样合并成一个像素点、这一级总共有多少个点。"""

    level: int
    samples_per_pixel: int
    length: int


class WaveformMetaDTO(BaseModel):
    """波形峰值的分级元信息。

    前端按当前 `pxPerSec` 换算出理想的 `samples_per_pixel`，在 `levels` 里
    选最接近的一级，再拿着该级的 `level` 序号去
    `GET /api/media/waveform/{project_id}/{kind}/{level}` 取那一级的二进制
    峰值（BBC waveform-data 二进制 v2 格式，见 `kvm.media.waveform` 模块文档；
    格式本身已经带 sample_rate/channels，这里额外给出是为了不逼前端先下载
    一份二进制才能知道有哪些级别可选）。
    """

    project_id: str
    kind: str
    sample_rate_hz: int
    channels: int
    duration_ms: int
    levels: list[WaveformLevelInfo] = Field(default_factory=list)

    cached: bool = False
    elapsed_s: float = 0.0
    """本次请求实际耗时（秒）。缓存命中时只是文件读取 + 哈希校验的时间。"""
