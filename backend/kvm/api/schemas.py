"""HTTP API 的数据契约。

前端类型由 FastAPI 导出的 OpenAPI 自动生成（见 frontend/package.json 的 gen:api），
**不要手写两份类型**——手写必然漂移。

命名与 `models.karaoke` 保持一致：API 是工程模型的传输表示，不是另一套概念。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ---- 工程 ----


class RubySpanDTO(BaseModel):
    start: int
    end: int
    text: str
    source: str = "provider_kana"
    locked: bool = False


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
    """`ruby` / `timing` / `voice_part`。"""

    detail: str
    """人类可读的中文说明，例如"「明日」的注音 あした 在拆行后跨越了分界"。"""

    payload: dict = Field(default_factory=dict)
    """原始数据，供用户选择重新应用。"""


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
    """

    provider: str
    song_id: str
    title: str
    artist: str
    album: str = ""
    duration_ms: int = 0
    granularity: Literal["word", "line", "plain"] = "line"
    has_ruby: bool = False
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
    """一条锁定变更。`target` 决定改的是音节时间锁还是注音锁。"""

    line_id: str
    target: Literal["timing", "ruby"] = "timing"
    locked: bool = True
    """False 表示解锁，让自动重算重新接管这一项。"""

    token_index: int | None = None
    """`target=timing` 时必填。"""

    ruby_range: tuple[int, int] | None = None
    """`target=ruby` 时必填，须与已有注音的字符区间**完全一致**。"""


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


class SplitLineRequest(BaseModel):
    project_id: str
    line_id: str
    token_index: int


class MergeLineRequest(BaseModel):
    project_id: str
    line_id: str
    """与下一行合并。"""


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
