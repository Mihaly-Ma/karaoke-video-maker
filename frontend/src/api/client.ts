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
  GuideParams,
  GuideStatus,
  JobStatus,
  LockTarget,
  LyricPreview,
  LyricSearchResponse,
  Palette,
  PaletteScheme,
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
 * 只保存引导声参数，**不触发合成**。占一格撤销（参数是用户意图，见 CLAUDE.md §8）。
 *
 * 与 `buildGuide` 分成两个动作，是因为合成一次要跑十几到几十秒的 CREPE——
 * 每拖一下滑块就重算不可接受。
 */
export const setGuideParams = (projectId: string, params: GuideParams) =>
  post<Project>('/media/guide/params', { project_id: projectId, params })

/**
 * 合成引导声（ガイドメロディ）。
 *
 * 带 `params` 时后端会**先存参数再合成**——界面上"改完参数点重新生成"是一个动作，
 * 拆成两次请求会在中间留下一个两者不一致的窗口。
 */
export const buildGuide = (projectId: string, params?: GuideParams, force = false) =>
  post<JobStatus>('/media/guide', {
    project_id: projectId,
    ...(params ? { params } : {}),
    force,
  })

/** 引导声是否就绪、是不是旧参数产出的，以及最近一次合成任务的状态 */
export const guideStatus = (projectId: string) => req<GuideStatus>(`/media/guide/${projectId}`)

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
 * 该工程此刻正在跑的素材准备任务（下载 / 分离 / 代理），没有就是空数组。
 *
 * 用来区分「素材还没准备好」与「真的降级了」——这两种情况下工程 JSON 长得一样
 * （`video_path` 都是空），只有后端答得了。**按工程反查**是关键：`jobStatus`
 * 要求调用方手里已经有 id，而页面刷新后那个 id 就没了，后端自动发起的代理任务
 * 更是从头到尾都没给过前端。
 */
export const mediaActivity = (projectId: string) =>
  req<JobStatus[]>(`/media/activity/${projectId}`)

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

/**
 * 把一套配色方案施加到**一个声部**。与 `updatePalettes` 同一端点，仍是一步操作、一格撤销。
 *
 * `applyTo` 是必需的：方案就是一组四色、不带声部（见 `types.PaletteScheme`），
 * 不说写给谁没有意义。**任意用户自定义的声部名都合法**——声部由用户在编辑舞台
 * 自由新建与改名，前端后端都不该有声部名白名单。
 */
export const applyPaletteScheme = (projectId: string, scheme: string, applyTo: string) =>
  post<Project>(`/projects/${projectId}/palettes`, { scheme, apply_to: applyTo })

/** 配色方案：内置 + 用户保存的，混在同一个列表里，用 `PaletteScheme.builtin` 区分 */
export const listPaletteSchemes = () => req<PaletteScheme[]>('/palettes/schemes')

/**
 * 把一组四色存成方案。给 `projectId` + `part` 就直接取该声部当前生效的四色
 * （主路径：用户刚调好颜色，不该为了存个方案再把色号抄一遍）；否则用显式给出的 `colors`。
 *
 * 同名直接覆盖——界面的自动保存正是靠这个语义：从某套方案改出来的第一笔修改
 * 新建一条，之后的每次微调都更新同一条，列表不会被"自定义 1/2/3…"淹没。
 */
export const savePaletteScheme = (
  name: string,
  colors: Palette,
  options: { description?: string } = {},
) =>
  post<PaletteScheme>('/palettes/schemes', {
    name,
    description: options.description ?? '',
    colors,
  })

/**
 * 给用户方案改名。
 *
 * **不要用 delete + save 拼**：那是两次写盘，中间断掉就停在"删了还没存上"，
 * 用户攒的配色直接消失。后端的 PATCH 落到一次原子写。
 */
export const renamePaletteScheme = (name: string, newName: string) =>
  req<PaletteScheme>(`/palettes/schemes/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ new_name: newName }),
  })

/** 方案的主键是 `name`，后端没有 id 字段 */
export const deletePaletteScheme = (name: string) =>
  req<void>(`/palettes/schemes/${encodeURIComponent(name)}`, { method: 'DELETE' })

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
 *
 * 两个可选参数都与**字体链**有关，缺一条链就断一处：
 *
 * - `as`：产物对外自称的族名。整条链必须统一成**链首**的族名，libass 才会
 *   在它们之间做字形回退——族名各不相同时它压根不看内嵌字体
 *   （`experiments/ass_embedded_fonts.py` 实测）。
 * - `extra`：本曲用到、但默认子集裁不到的字（「鷗」「𠮷」「①」）。不传的话
 *   这些字**预览空白、成片正常**，只看成片发现不了。
 *
 * 两者都进后端的磁盘缓存键，所以同一个字体在不同链首/不同歌下是不同产物。
 */
export const fontSubsetUrl = (
  family: string,
  opts: { as?: string; extra?: string; weight?: number } = {},
) => {
  const params = new URLSearchParams({ family })
  if (opts.as && opts.as !== family) params.set('as', opts.as)
  if (opts.extra) params.set('extra', opts.extra)
  // 字重要跟着 ASS 声明走：勾了粗体时后端会挑本机的真粗字面（Yu Gothic 的
  // YuGothB.ttc）或把可变字体切到 700，而不是让 libass 合成粗体。不传的话
  // 预览拿到的是 Regular 子集，成片却是粗的——两端分叉。
  if (opts.weight && opts.weight !== 400) params.set('weight', String(opts.weight))
  return `${BASE}/fonts/subset?${params.toString()}`
}

/**
 * 检查**整条字体链**能否覆盖给定文本的全部字形，以及每个字由谁承担
 * （缺字必须在渲染前拦截，见 CLAUDE.md §2.6）。
 *
 * 传单个族名仍然可用（导出面板走的就是这条），后端会把它当成单元素链。
 *
 * **参数走请求体，不要改回 query**：`text` 装的是整首歌的字符集，
 * percent-encode 后每个汉字占 9 字节，几百个不重复字符就逼近 uvicorn 对
 * 请求行 + 头部的 16 KB 上限，超限时连接被直接掐断、连可读的 4xx 都没有。
 *
 * 调用方应先送**去重后的字符集**而不是原文（见 `lib/fontCoverage.ts`），
 * 两层保险各自独立：去重是为了缓存命中率，请求体是为了没有长度天花板。
 *
 * 副作用（刻意的）：后端借这次调用**预热整条链的子集产物**。这一刻用户还在
 * 字体列表里挑，离切到预览还有几秒到几十秒，正是把十秒级的裁剪塞进去的地方。
 */
export const checkFontCoverage = (
  families: string | string[],
  text: string,
  bold = false,
) =>
  post<FontCoverageResult>('/fonts/coverage', {
    families: typeof families === 'string' ? [families] : families,
    text,
    // 预热要按将来真正会取的那一档字重来裁，否则勾了粗体的工程等于没预热：
    // 切到预览时要的是 Bold 产物，而预热裁的是 Regular
    bold,
  })

// ---- 渲染 ----

export const buildAss = (projectId: string) =>
  post<{ ass: string; event_count: number }>('/render/ass', { project_id: projectId })

/** 启动烧录。`start_s` / `duration_s` 给了就是片段试渲染，产物会被标成 `is_excerpt`。 */
export const exportVideo = (body: {
  project_id: string
  with_guide: boolean
  use_instrumental: boolean
  /** 把非 16:9 的画面补黑边到 16:9 再烧字幕；已经是 16:9 的源上是空操作。 */
  pad_to_16_9?: boolean
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
  kind: 'video' | 'proxy' | 'audio' | 'instrumental' | 'vocals' | 'drums' | 'guide',
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
