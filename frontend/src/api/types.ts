/**
 * 与 backend/kvm/api/schemas.py 一一对应。
 *
 * 运行 `npm run gen:api` 可从后端 OpenAPI 生成 schema.d.ts 用于校验；
 * 这里保留手写版本是为了让编辑器在后端未启动时也有类型提示。
 * **两边字段必须同名同义**——发现不一致时以 schemas.py 为准。
 */

export interface RubySpan {
  start: number
  end: number
  text: string
  source: string
  locked: boolean
}

export interface Token {
  text: string
  start_ms: number
  dur_ms: number
  /**
   * `unset` = 从未定过时（纯文本导入后等待打轴），与 `manual`（用户确实调过）语义不同，
   * UI 上要能区分——混用会让人误以为这个时间是用户认可的。
   */
  timing_source: 'provider' | 'aligned' | 'interpolated' | 'manual' | 'unset'
  locked_timing: boolean
  /**
   * 该 token 时间的权威粒度：低于权威粒度的时间由插值产生，
   * 禁止标成 provider/aligned（CLAUDE.md §4.2）。
   */
  timing_granularity: 'provider_char' | 'mora' | 'line'
  /** 声部覆盖，为 null 时继承所在行的 voice_part（对唱歌曲一行内男女交替是常态） */
  voice_part: string | null
  locked_voice: boolean
  /** 内容寻址身份键，用于在重新分行后重新绑定手工修改（CLAUDE.md §4.4） */
  tid: string
}

export interface Line {
  id: string
  tokens: Token[]
  ruby: RubySpan[]
  voice_part: string
  slot: number
  is_metadata: boolean
  locked: boolean
}

export interface Palette {
  name: string
  unsung_fill: string
  unsung_outline: string
  sung_fill: string
  sung_outline: string
}

export interface Style {
  /**
   * 有序字体候选链：链首缺哪个字形，就落到后面那个。
   *
   * 没有一个日文字体覆盖得全，而缺字的后果两端不同——预览（JASSUB）手里只有
   * 我们喂进去的字体，缺了就是空白；导出（ffmpeg）的系统回退**无法禁用**，
   * 它会自己找个字体顶上。链把"缺字时用谁"变成工程里显式记着的一份数据，
   * 两端照同一份走才谈得上所见即所得。
   */
  font_names: string[]
  /**
   * 主字体族名 = `font_names[0]`。**后端派生，不要往回写**（写了也会被忽略）。
   *
   * 改字体请发 `font_names`；只想换主字体、保留兜底链时可以发 `font_name`，
   * 后端会把它提到链首（见 `routes/projects.py` 的 `update_style`）。
   */
  font_name: string
  font_size: number
  bold: boolean
  outline: number
  shadow: number
  ruby_scale: number
  ruby_gap: number
  margin_v: number
  margin_h: number
  line_gap: number
  stagger: boolean
  lead_in_ms: number
  max_lead_ms: number
  lead_out_ms: number
  paragraph_gap_ms: number
  slot_gap_ms: number
  countdown_dots: number
  countdown_beat_ms: number
  countdown_min_gap_ms: number
}

/**
 * 一条已导出的成片记录（后端 `ExportArtifactDTO`）。
 *
 * 由 `GET /api/render/exports/{project_id}` 返回，该接口只列**文件仍在磁盘上**的
 * 产物。工程 JSON 里那份 `exports` 是持久化存储，用户随时会把成片挪走或删掉，
 * 拿它判断"现在能不能用"会给出一个点开必然报错的入口。
 */
export interface ExportArtifact {
  /** 取自生成它的那次导出任务的 job_id，便于把记录与任务日志对上 */
  id: string
  path: string
  /** Unix 时间戳（**秒**，不是毫秒）——直接喂 `new Date()` 会得到 1970 年 */
  created_at: number
  size_bytes: number
  /** 成片实际时长（后端 ffprobe 实测） */
  duration_ms: number
  with_guide: boolean
  /** true = OFF VOCAL（伴奏轨），false = ON VOCAL */
  use_instrumental: boolean
  /** 片段试渲染，不是整首成片。两者在文件上无从分辨，必须标出来 */
  is_excerpt: boolean
  /** 后端由上面三个布尔位派生的中文变体名，如「OFF VOCAL + 引导声」，可直接显示 */
  variant_label: string
}

/**
 * 引导声（ガイドメロディ）暴露给用户的参数（后端 `GuideParamsDTO`）。
 *
 * 后端 `GuideConfig` 有十几个字段，这里只有五个——其余是 f0 管线的标准步骤或按
 * 实测间隙分布定死的阈值，用户没有判据去调。改这五个都能立刻听出差别。
 */
export interface GuideParams {
  /** 音量（RMS 口径），0.02~0.40 */
  gain: number
  /** 音色。方波穿透力最好，正弦最干净但容易被编曲埋掉 */
  timbre: 'sine' | 'triangle' | 'square' | 'saw'
  /** 谐波数上限 = 明亮度，1~32。**`sine` 音色下无效**（它只有基波） */
  max_harmonics: number
  /** 发声判定门限（dB），−40~−12。越负越灵敏，弱唱也有引导声 */
  voicing_drop_db: number
  /** 短于此的间隙桥接成 legato（毫秒），0~500。越大越连贯 */
  legato_gap_ms: number
}

/**
 * 工程的引导声状态（`GET /api/media/guide/{project_id}`）。
 *
 * 比 `ProxyStatus` 多一个 `stale`：合成一次要十几到几十秒，不能每拖一下滑块就重跑，
 * 所以"参数改了、产物还是旧的"是一个必然存在的中间态，必须报出来——
 * 否则用户会以为参数根本没生效。
 */
export interface GuideStatus {
  project_id: string
  ready: boolean
  /** 产物是旧参数（或旧人声轨）产出的，要重新生成才能听到当前设置 */
  stale: boolean
  path: string | null
  job: JobStatus | null
  /** 已是中文，可直接显示 */
  note: string
}

/**
 * 一条无法重新绑定的手工修改（CLAUDE.md §4.4：重绑失败的锁定项不得静默丢弃，
 * 要浮到界面上让用户确认）。
 */
export interface OrphanedEdit {
  /** `ruby` / `timing` / `voice_part` */
  kind: string
  /** 人类可读的中文说明 */
  detail: string
  /** 原始数据，供用户选择重新应用 */
  payload: Record<string, unknown>
}

export interface Project {
  id: string
  title: string
  artist: string
  lines: Line[]
  style: Style
  palettes: Record<string, Palette>
  video_width: number
  video_height: number
  global_offset_ms: number
  /** **原始**视频文件。导出成片一律用它，绝不用 proxy_video_path */
  video_path: string | null
  /**
   * 编辑用代理视频（H.264 / MP4 / 短 GOP / 无音轨），**只服务于编辑器预览**。
   *
   * 原始视频常是 AV1 + Matroska + Opus，Safari 三重放不了（没有 Matroska 解复用器、
   * 不认 MKV 里的 Opus、M1/M2 也没有 AV1 硬解），4K 长 GOP 还会让逐帧核对音节边界卡住。
   * 为 null 表示还没生成，预览回退用原视频，**不因此阻断播放**。
   */
  proxy_video_path: string | null
  audio_path: string | null
  instrumental_path: string | null
  vocals_path: string | null
  drums_path: string | null
  /**
   * 合成好的引导声轨。由人声轨派生，与 stem 同属**后台产物，不进撤销栈**。
   * 为 null 表示还没生成——此时预览听不到引导声，导出勾了会现场合成，不阻断。
   */
  guide_audio_path: string | null
  /** 产出上面那份文件时的 `(人声轨, 参数, 版本)` 指纹，用于判断产物是不是旧的 */
  guide_signature: string
  /** 引导声参数。**这是用户意图，改它占一格撤销**——与上面两个派生字段相反 */
  guide: GuideParams
  duration_ms: number
  /**
   * 实际使用的音频流标识。同一 YouTube 视频不同音频流原点可能相差数十毫秒，
   * 下载、分离、重锚定、烧录必须锁同一条流；换流必须重跑重锚定。
   */
  audio_format_id: string
  /** 重绑失败的手工修改，等待用户确认 */
  orphans: OrphanedEdit[]
  /**
   * 已导出的成片。
   *
   * **前端这份的含义与后端字段不同**：后端 `ProjectDTO.exports` 是持久化存储
   * （可能含文件已被删掉的记录），而这里只放 `GET /api/render/exports/{id}`
   * 核对过、文件确实还在的那批（见 `projectStore` 的 `loadExports`）。
   * 编辑响应里带回来的原值一律被丢弃，不让未核对的记录混进来。
   */
  exports: ExportArtifact[]
}

export interface ProjectSummary {
  id: string
  title: string
  artist: string
  updated_at: number
  duration_ms: number
  line_count: number
}

export interface LyricCandidate {
  provider: string
  song_id: string
  title: string
  artist: string
  album: string
  duration_ms: number
  /** 决定用户还要不要手工打轴，必须在候选列表里显眼展示 */
  granularity: 'word' | 'line' | 'plain'
  /** 是否自带假名读音轨——日语曲的关键指标 */
  has_ruby: boolean
  has_translation: boolean
  score: number
  note: string
}

export interface LyricSearchResponse {
  candidates: LyricCandidate[]
  /** 按 provider 记录失败原因；部分源失败不影响其余结果 */
  errors: Record<string, string>
}

export interface LyricPreview {
  lines: Line[]
  granularity: string
  has_ruby: boolean
  raw_excerpt: string
}

export interface JobStatus {
  job_id: string
  kind: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  progress: number
  message: string
  error: string
  result: Record<string, unknown>
}

/**
 * 编辑用代理视频的状态（`GET /api/media/proxy/{project_id}`）。
 *
 * 一次回答两个问题：代理现在能不能用（决定 `<video>` 的 src），以及有没有任务
 * 正在跑——下载/导入之后的代理任务由**后端自动发起**，前端没有别的途径拿到那个
 * job_id，只能从这里取。
 */
export interface ProxyStatus {
  project_id: string
  ready: boolean
  path: string | null
  job: JobStatus | null
  /** 已是中文，可直接显示 */
  note: string
}

// ---- 编辑：批量改时间 / 锁定 ----
//
// 两个端点都收 `items` 数组，整批算**一个**撤销单元（CLAUDE.md §8）。
// 名字与 schemas.py 的 TimingItem / LockItem 对齐，别再另起一套。

/** 批量调轴里的一项（后端 `TimingItem`）。`start_ms` 与 `dur_ms` 至少要给一个。 */
export interface TimingItem {
  line_id: string
  token_index: number
  start_ms: number | null
  dur_ms: number | null
}

/**
 * 一条锁定变更（后端 `LockItem`），`project_id` 由 client 补上。
 *
 * 注音锁给的是 `ruby_range: [start, end]` **一个二元组**，不是拆开的两个字段——
 * 后端按元组校验，且必须与已有注音的字符区间完全一致。
 */
export type LockTarget =
  | { target: 'timing'; line_id: string; token_index: number; locked: boolean }
  | { target: 'ruby'; line_id: string; ruby_range: [number, number]; locked: boolean }

// ---- 配色 ----

/**
 * 一套可跨工程复用的配色方案（后端 `PaletteScheme`）= **一组四色**。
 *
 * **没有 `id` 字段，主键就是 `name`**（删除走 `DELETE /api/palettes/schemes/{name}`）。
 *
 * **方案不带声部。** 它此前是 `dict[声部名 → Palette]`，而声部名是用户自定义的
 * （编辑舞台可新建、可就地改名，连 `main` 都能改）——真实工程里声部叫「男」「女」「合」，
 * 按名字取色必然落空、全部退到 `main`，每个声部拿到同一组颜色且毫无提示。
 * 现在写给哪个声部由界面决定（`applyPaletteScheme` 的 `applyTo`），
 * 色板上看到什么，点下去就是什么。
 */
export interface PaletteScheme {
  name: string
  description: string
  /** 内置方案不可删除、不可改名、不可被同名覆盖 */
  builtin: boolean
  colors: Palette
}

// ---- 字体服务 ----
//
// 与 backend/kvm/api/routes/fonts.py 的 FontInfo / FontScanStatus / PresetInfo /
// FontCoverage 一一对应——字体扫描后台化后端已落地，前端以它为准。

export interface FontInfo {
  family: string
  path: string
  /** TTC 字体集合内的族下标；非集合为 0 */
  index: number
  /** 是否覆盖日文字形。不覆盖的字体拿来排日语歌词只会渲染成豆腐块 */
  is_cjk: boolean
  /** 该 family 下观测到的全部字重（子族名，如 W3/W6/W8/Regular/Bold），已排序去重 */
  weights: string[]
  /**
   * 同一个字体在 name 表里的其它语言写法（`Hiragino Sans` ← `ヒラギノ角ゴシック`）。
   *
   * **搜索必须认这些名字**：日文字体普遍中英双名，`family` 是英文，
   * 用户却多半会打「ヒラギノ」。只按 `family` 搜的话，界面上看得见的名字反而搜不到。
   */
  alt_names: string[]
}

/**
 * 系统字体后台扫描状态。冷启动扫描约需 30~40 秒，期间前端应轮询
 * `GET /api/fonts/status` 并显示 `message`（已是中文），而不是让用户
 * 面对一个逐渐变长又不知道何时完整的字体列表。
 */
export interface FontScanStatus {
  state: 'idle' | 'scanning' | 'ready' | 'failed'
  /** 给用户看的中文状态说明，可直接显示 */
  message: string
  family_count: number
  scanned_files: number
  total_files: number
  elapsed_s: number
  /** 本次结果是否直接来自磁盘缓存（是则说明没有真的重扫，耗时可忽略） */
  from_cache: boolean
  error: string | null
}

/** 卡拉OK 常用字体档位（粗ゴシック/ゴシック/丸ゴシック/明朝体），见 GET /api/fonts/presets */
export interface FontPreset {
  key: string
  label: string
  note: string
  /** 本机实际选中的字体族。为 null 表示该档在本机不可用（除非 pending=true） */
  resolved: string | null
  candidates: string[]
  /**
   * 该档尚未命中候选，但系统字体还在后台扫描中，结果可能变化。
   * 界面此时应显示"正在扫描系统字体…"，**不能显示"该档不可用"**。
   */
  pending: boolean
}

/** 链上一个字体实际承担了哪些字形（后端 `FontShare`） */
export interface FontShare {
  family: string
  count: number
  /** 该字体**第一个**能提供的那些字形。各条互不重叠，加起来就是"有着落的字" */
  chars: string
}

export interface FontCoverageResult {
  /** 链首族名。老调用方只认这一个 */
  family: string
  /** 本次检查的整条链 */
  families: string[]
  /**
   * **整条链都没有**的字形：预览与成片都会缺。为空即这条链完全覆盖。
   *
   * 链尾补上的字不算缺字——那正是配置链尾的目的。
   */
  missing: string[]
  /**
   * 链里有、但预览无论如何都拿不到的字形。
   *
   * **现在恒为空**：子集会按本曲字符集加裁（`/subset` 的 `extra`），
   * 凡是链里有的字预览就有。字段保留是因为它曾经非空，症状是
   * "预览空白、成片正常"——与缺字相反的分叉，看成片根本发现不了。
   */
  preview_missing: string[]
  /**
   * 本曲用到、但落在默认子集之外的字（「鷗」「𠮷」「①」这类）。
   * **不是问题清单**，只说明这首歌用到了生僻字，预览靠加裁把它们补上了。
   */
  extra_chars: string
  /** 逐字体的承担情况，链序排列。回答"每个字实际由哪个字体画" */
  shares: FontShare[]
  total_checked: number
}
