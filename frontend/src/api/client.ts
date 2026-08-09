/**
 * 后端 API 客户端。
 *
 * 所有编辑操作都返回**完整的新工程**而不是补丁：工程 JSON 只有几十 KB，
 * 省下的带宽远不值得为增量同步引入一致性问题。
 */

import type {
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
  TimingEdit,
} from './types'

const BASE = '/api'

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
    throw new Error(detail)
  }
  if (resp.status === 204) return undefined as T
  return (await resp.json()) as T
}

const post = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', body: JSON.stringify(body) })

// ---- 工程 ----

export const listProjects = () => req<ProjectSummary[]>('/projects')
export const getProject = (id: string) => req<Project>(`/projects/${id}`)
export const createProject = (title = '', artist = '') =>
  post<Project>('/projects', { title, artist })
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

export const separate = (projectId: string, model = 'htdemucs') =>
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

export const jobStatus = (jobId: string) => req<JobStatus>(`/media/jobs/${jobId}`)
export const cancelJob = (jobId: string) => post<JobStatus>(`/media/jobs/${jobId}/cancel`, {})

/** 导入本地视频/音频文件——下载失败时的手工旁路（CLAUDE.md §2.5：视频获取的手工旁路是"选本地文件"） */
export const importMedia = (projectId: string, kind: 'video' | 'audio', path: string) =>
  post<Project>('/media/import', { project_id: projectId, kind, path })

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
 */
export const setTimings = (projectId: string, edits: TimingEdit[]) =>
  post<Project>('/editor/timings', { project_id: projectId, edits })

/** 设置/清除 locked_timing 或 ruby 的 locked */
export const setLock = (projectId: string, target: LockTarget) =>
  post<Project>('/editor/lock', { project_id: projectId, ...target })

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

export const updatePalettes = (projectId: string, patch: Record<string, Palette>) =>
  post<Project>(`/projects/${projectId}/palettes`, patch)

/** 配色模板：内置 + 用户保存的，二者混在同一个列表里，用 PaletteTemplate.builtin 区分 */
export const listPaletteTemplates = () => req<PaletteTemplate[]>('/palettes/templates')

export const savePaletteTemplate = (name: string, palette: Palette) =>
  post<PaletteTemplate>('/palettes/templates', { name, palette })

export const deletePaletteTemplate = (id: string) =>
  req<void>(`/palettes/templates/${id}`, { method: 'DELETE' })

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

export const checkFontCoverage = (family: string, text: string) =>
  post<FontCoverageResult>('/fonts/coverage', { family, text })

// ---- 渲染 ----

export const buildAss = (projectId: string) =>
  post<{ ass: string; event_count: number }>('/render/ass', { project_id: projectId })

export const exportVideo = (body: {
  project_id: string
  with_guide: boolean
  use_instrumental: boolean
}) => post<JobStatus>('/render/export', body)

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
