/**
 * 后端 API 客户端。
 *
 * 所有编辑操作都返回**完整的新工程**而不是补丁：工程 JSON 只有几十 KB，
 * 省下的带宽远不值得为增量同步引入一致性问题。
 */

import type {
  ExportArtifact,
  FontCoverageResult,
  FontInfo,
  FontPreset,
  FontScanStatus,
  JobStatus,
  LockTarget,
  LyricPreview,
  LyricSearchResponse,
  Palette,
  PaletteTemplate,
  Project,
  ProjectSummary,
  ProxyStatus,
  Style,
  TimingItem,
} from './types'

const BASE = '/api'

/**
 * 带 HTTP 状态码的请求失败。
 *
 * 光有 message 不够：`jobStatus` 要靠 404 判断"这个 id 不在这个任务表里，
 * 该去另一张表找"，而中文错误文案不是可以拿来分支的依据。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`
    try {
      const body = await resp.json()
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* 响应体不是 JSON 时保留状态行 */
    }
    throw new ApiError(resp.status, detail)
  }
  if (resp.status === 204) return undefined as T
  return (await resp.json()) as T
}

const post = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', body: JSON.stringify(body) })

// ---- 工程 ----

// 列表/新建的后端路由带尾斜杠（`APIRouter(prefix="/api/projects")` + `@get("/")`）。
// 不写这个斜杠仍然能通，但每次都要多吃一次 307 重定向。
export const listProjects = () => req<ProjectSummary[]>('/projects/')
/**
 * 取完整工程。
 *
 * **抹掉响应里的 `exports`**：后端那个字段是持久化存储，可能留着用户早已删掉的
 * 成片，拿它判断"现在还有没有可用产物"会给出一个点开必然报错的入口。前端的
 * `Project.exports` 只由 `listExports()`（会核对文件是否还在）填充——在这里就地
 * 清空，任何直接调 `getProject` 的地方（首页卡片的分段进度就是一个）都不会误用。
 */
export const getProject = async (id: string): Promise<Project> => {
  const p = await req<Project>(`/projects/${id}`)
  return { ...p, exports: [] }
}
export const createProject = (title = '', artist = '') =>
  post<Project>('/projects/', { title, artist })
export const deleteProject = (id: string) => req<void>(`/projects/${id}`, { method: 'DELETE' })

export const history = (id: string) => req<{ undo: number; redo: number }>(`/projects/${id}/history`)
export const undo = (id: string) => post<Project>(`/projects/${id}/undo`, {})
export const redo = (id: string) => post<Project>(`/projects/${id}/redo`, {})

// ---- 歌词 ----

export const searchLyrics = (query: string, durationHintMs?: number) =>
  post<LyricSearchResponse>('/lyrics/search', {
    query,
    duration_hint_ms: durationHintMs ?? null,
  })

export const previewLyrics = (provider: string, songId: string) =>
  post<LyricPreview>('/lyrics/preview', { provider, song_id: songId })

export const applyLyrics = (projectId: string, provider: string, songId: string) =>
  post<Project>('/lyrics/apply', { project_id: projectId, provider, song_id: songId })

export const importLyrics = (
  projectId: string,
  kind: 'text' | 'lrc' | 'qrc',
  content: string,
  replace = true,
) => post<Project>('/lyrics/import', { project_id: projectId, kind, content, replace })

// ---- 媒体 ----

export const download = (projectId: string, url: string) =>
  post<JobStatus>('/media/download', { project_id: projectId, url })

/**
 * 启动人声分离。
 *
 * `model` 传的是**档位 id**（`fast` / `standard` / `best`，见
 * `GET /api/media/separate/models`），不是模型文件名——文件名属于 audio-separator
 * 的命名空间，换模型不该逼前端跟着改。默认值必须与后端标 `recommended` 的那档一致。
 */
export const separate = (projectId: string, model = 'standard') =>
  post<JobStatus>('/media/separate', { project_id: projectId, model })

/**
 * 生成编辑用代理视频（H.264 / MP4 / 短 GOP / 无音轨，只服务于编辑器预览）。
 *
 * 下载完成、导入本地视频之后后端会自动跑一次，这个入口是等价的手工旁路
 * （CLAUDE.md §2.5），也用于给"已有原视频但还没有代理"的老工程补一份。
 * **导出成片与它无关**，那条路始终用原始素材。
 */
export const buildProxy = (projectId: string, maxHeight?: number, force = false) =>
  post<JobStatus>('/media/proxy', {
    project_id: projectId,
    ...(maxHeight === undefined ? {} : { max_height: maxHeight }),
    force,
  })

/** 代理是否就绪 + 最近一次代理任务（含后端自动发起的那次）的状态 */
export const proxyStatus = (projectId: string) => req<ProxyStatus>(`/media/proxy/${projectId}`)

/**
 * 查询长任务状态。
 *
 * **后端有两张互不相通的任务表**：下载/分离/代理走 `kvm.jobs.job_manager`
 * （`/media/jobs/{id}`），而导出烧录在 `routes/render.py` 里另存了一份
 * （`/render/export/{id}`）。id 空间不重叠，所以这里先问前者、404 再问后者，
 * 调用方（JobProgress）不必知道手上这个 id 是哪一类任务。
 *
 * 后端把导出并进 `kvm.jobs` 之后，这里的兜底分支即可删掉。
 */
export const jobStatus = async (jobId: string): Promise<JobStatus> => {
  try {
    return await req<JobStatus>(`/media/jobs/${jobId}`)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e
    return req<JobStatus>(`/render/export/${jobId}`)
  }
}

export const cancelJob = (jobId: string) => post<JobStatus>(`/media/jobs/${jobId}/cancel`, {})

/**
 * 导入本地视频/音频文件——下载失败时的手工旁路（CLAUDE.md §2.5：视频获取的
 * 手工旁路是"选本地文件"）。
 *
 * 走 **multipart 上传**而不是传一个路径字符串：后端收的是 `UploadFile`，
 * 而且浏览器里本来也拿不到用户选中文件的真实路径。
 * `FormData` 会自带 boundary，**不能手工设 Content-Type**，故绕开 `req()`。
 */
export const importMedia = (projectId: string, kind: 'video' | 'audio', file: File) => {
  const form = new FormData()
  form.append('project_id', projectId)
  form.append('kind', kind)
  form.append('file', file)
  return req<Project>('/media/import', { method: 'POST', body: form, headers: {} })
}

// ---- 编辑 ----

export const shift = (body: {
  project_id: string
  scope: 'global' | 'line' | 'token'
  delta_ms: number
  line_id: string | null
  token_index: number | null
}) => post<Project>('/editor/shift', body)

export const setTiming = (body: {
  project_id: string
  line_id: string
  token_index: number
  start_ms: number | null
  dur_ms: number | null
}) => post<Project>('/editor/timing', body)

/**
 * 批量改时间，整批作为一个 undo 单元。
 *
 * 打轴 agent 实测：逐个提交 `setTiming` 会让打完一首歌占 N 步撤销——这是
 * `POST /api/editor/timings` 存在的理由，调轴收口（tap-to-time / 拖拽批量提交）
 * 应优先走这个而不是循环调用 `setTiming`。
 *
 * `items` 按给出的顺序**依次**应用（越界夹紧参照应用到该项时的状态），
 * 重写整行时请按 token 顺序给出。
 */
export const setTimings = (projectId: string, items: TimingItem[]) =>
  post<Project>('/editor/timings', { project_id: projectId, items })

/**
 * 批量设置/清除锁定（音节时间锁 / 注音锁），整批同样是一个 undo 单元。
 *
 * 后端收的是 `items` 数组。曾经这里把单条目标**平铺**进请求体，后端于是收到一个
 * 空 items，返回 400「批量锁定的 items 为空」——用户点了锁，界面上什么都没发生。
 * 这类错误 tsc / lint 全都发现不了，只能靠比对 schemas.py。
 */
export const setLock = (projectId: string, items: LockTarget[]) =>
  post<Project>('/editor/lock', { project_id: projectId, items })

export const setRuby = (body: {
  project_id: string
  line_id: string
  start: number
  end: number
  text: string
}) => post<Project>('/editor/ruby', body)

export const splitLine = (body: { project_id: string; line_id: string; token_index: number }) =>
  post<Project>('/editor/split', body)

export const mergeLine = (body: { project_id: string; line_id: string }) =>
  post<Project>('/editor/merge', body)

export const setVoicePart = (body: {
  project_id: string
  line_id: string
  voice_part: string
  token_range: [number, number] | null
}) => post<Project>('/editor/voice-part', body)

export const updateStyle = (projectId: string, patch: Partial<Style>) =>
  post<Project>(`/projects/${projectId}/style`, patch)

// ---- 配色 ----

/**
 * 更新工程配色。
 *
 * 配色要包在 `palettes` 键里（后端 `PaletteUpdateRequest`），直接把
 * `{main: {...}}` 当请求体发过去，后端会认为"既没给 palettes 也没给 template"
 * 而返回 400。`replace=true` 表示整体替换（未出现的声部被删掉）。
 */
export const updatePalettes = (
  projectId: string,
  palettes: Record<string, Palette>,
  replace = false,
) => post<Project>(`/projects/${projectId}/palettes`, { palettes, replace })

/** 套用一套配色模板。与 `updatePalettes` 同一端点，仍是一步操作、一格撤销。 */
export const applyPaletteTemplate = (projectId: string, template: string) =>
  post<Project>(`/projects/${projectId}/palettes`, { template })

/** 配色模板：内置 + 用户保存的，二者混在同一个列表里，用 PaletteTemplate.builtin 区分 */
export const listPaletteTemplates = () => req<PaletteTemplate[]>('/palettes/templates')

/**
 * 把一套配色存成模板。给 `projectId` 就直接取该工程当前的配色（主路径：用户刚调好
 * 颜色，不该为了存个模板再把四组色号抄一遍）；否则用显式给出的 `palettes`。
 *
 * 注意是**按声部索引的一整套** `palettes`，不是单个 `palette`。
 */
export const savePaletteTemplate = (
  name: string,
  palettes: Record<string, Palette>,
  options: { description?: string; projectId?: string } = {},
) =>
  post<PaletteTemplate>('/palettes/templates', {
    name,
    description: options.description ?? '',
    project_id: options.projectId ?? null,
    palettes,
  })

/** 模板的主键是 `name`，后端没有 id 字段——传 `tpl.id` 只会删到一个叫 undefined 的模板。 */
export const deletePaletteTemplate = (name: string) =>
  req<void>(`/palettes/templates/${encodeURIComponent(name)}`, { method: 'DELETE' })

// ---- 字体服务 ----

/** `cjkOnly=true` 时只返回覆盖日文的字体（后端 `GET /api/fonts/?cjk_only=`） */
export const listFonts = (cjkOnly = false) => req<FontInfo[]>(`/fonts/?cjk_only=${cjkOnly}`)

export const listFontPresets = () => req<FontPreset[]>('/fonts/presets')

/**
 * 系统字体后台扫描状态，供前端轮询显示"正在扫描系统字体…"。
 * 调用它本身也会触发扫描（幂等），组件可以直接拿它当轮询入口。
 */
export const getFontStatus = () => req<FontScanStatus>('/fonts/status')

/**
 * 字体子集资源的直链，用法与 mediaUrl 相同——具体是二进制字体文件还是别的表示形式
 * 由后端决定，前端只负责拼 URL，不在这里假设响应体形状。
 */
export const fontSubsetUrl = (family: string) => `${BASE}/fonts/subset?family=${encodeURIComponent(family)}`

/**
 * 检查字体能否覆盖给定文本的全部字形（缺字必须在渲染前拦截，见 CLAUDE.md §2.6）。
 *
 * 后端把 `family` / `text` 声明成了 **query 参数**而不是请求体，发 JSON body
 * 只会拿到 422（`loc: ["query", "family"]`）。歌词整首扔进 `text` 时 URL 会很长，
 * 但 POST 的 query 串不受 GET 那套长度惯例约束。
 */
export const checkFontCoverage = (family: string, text: string) => {
  const qs = new URLSearchParams({ family, text })
  return req<FontCoverageResult>(`/fonts/coverage?${qs.toString()}`, { method: 'POST' })
}

// ---- 渲染 ----

export const buildAss = (projectId: string) =>
  post<{ ass: string; event_count: number }>('/render/ass', { project_id: projectId })

/** 启动烧录。`start_s` / `duration_s` 给了就是片段试渲染，产物会被标成 `is_excerpt`。 */
export const exportVideo = (body: {
  project_id: string
  with_guide: boolean
  use_instrumental: boolean
  start_s?: number
  duration_s?: number
}) => post<JobStatus>('/render/export', body)

/**
 * 该工程**文件仍在磁盘上**的导出产物，最新的在前。
 *
 * 判断"现在能不能用"必须走这个接口，不能读 `Project.exports` 的持久化原值：
 * 用户随时会把成片挪走或删掉，照单渲染就会给出一个点开必然报错的入口。
 * 接口顺带会把已消失的记录从工程里剔掉（后端 `list_exports`）。
 */
export const listExports = (projectId: string) =>
  req<ExportArtifact[]>(`/render/exports/${projectId}`)

/**
 * 媒体文件的可直接播放 URL。走后端是为了带上 CORP 头
 * （跨源隔离页面加载不了没有 CORP 的资源）。
 *
 * **必须带 `/api` 前缀**——后端路由是 `/api/media/file/...`。
 * 曾经漏掉它，表现为音频一律 404、波形永远画不出来、预览退化成
 * "Web Audio 没拿到可用音轨"的降级提示，看起来像是降级逻辑在正常工作，
 * 实际是请求压根没到后端。这类错误 tsc / lint / build 全都发现不了。
 */
export const mediaUrl = (
  projectId: string,
  kind: 'video' | 'proxy' | 'audio' | 'instrumental' | 'vocals' | 'drums',
) => `${BASE}/media/file/${projectId}/${kind}`

/**
 * 成片下载直链（后端带 `Content-Disposition: attachment`）。
 *
 * 只认 `artifactId`，不接受路径：真实路径由后端从该工程自己的 `exports` 里查，
 * 收路径参数等于把"读服务器上任意文件"开成公开接口。
 *
 * 用 `<a href download>` 消费它，不要 `fetch` 成 Blob——成片实测 527 MB，
 * 走 Blob 等于把整片读进内存，而直链让浏览器自己流式落盘（后端支持 Range）。
 */
export const exportDownloadUrl = (projectId: string, artifactId: string) =>
  `${BASE}/render/exports/${projectId}/${artifactId}/download`
