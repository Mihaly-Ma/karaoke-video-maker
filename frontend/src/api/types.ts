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
  video_path: string | null
  audio_path: string | null
  instrumental_path: string | null
  vocals_path: string | null
  drums_path: string | null
  duration_ms: number
  /**
   * 实际使用的音频流标识。同一 YouTube 视频不同音频流原点可能相差数十毫秒，
   * 下载、分离、重锚定、烧录必须锁同一条流；换流必须重跑重锚定。
   */
  audio_format_id: string
  /** 重绑失败的手工修改，等待用户确认 */
  orphans: OrphanedEdit[]
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

// ---- 编辑：批量改时间 / 锁定 ----
//
// 对应新端点 POST /api/editor/timings、POST /api/editor/lock（后端由另一 agent
// 并行实现中，schemas.py 落地前暂缺权威定义）。字段命名沿用 schemas.py 里
// SetTimingRequest / RubySpanDTO 已有的风格；后端落地后如有出入以 schemas.py 为准。

/** 批量时间编辑里的单条改动，整批只作为一次 POST /api/editor/timings 请求 */
export interface TimingEdit {
  line_id: string
  token_index: number
  start_ms: number | null
  dur_ms: number | null
}

/** POST /api/editor/lock 的请求体（不含 project_id，由 client 补上） */
export type LockTarget =
  | { target: 'timing'; line_id: string; token_index: number; locked: boolean }
  | { target: 'ruby'; line_id: string; ruby_start: number; ruby_end: number; locked: boolean }

// ---- 配色 ----

/** 配色模板：内置预设或用户保存的，POST /api/projects/{id}/palettes 用同一套 Palette 形状 */
export interface PaletteTemplate {
  id: string
  name: string
  /** 内置模板不可删除 */
  builtin: boolean
  palette: Palette
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

export interface FontCoverageResult {
  family: string
  /** 未覆盖到的字符列表，为空即完全覆盖 */
  missing: string[]
  total_checked: number
}
