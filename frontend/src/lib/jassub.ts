/**
 * JASSUB（libass 的 WebAssembly 构建）封装：实例生命周期、字体注入、增量字幕更新、错误处理。
 *
 * 为什么预览必须用 libass、而不是 DOM 或 Canvas 自绘：导出侧的 ffmpeg 也用 libass，
 * 两端同源才谈得上「预览对了导出也对」（CLAUDE.md §5.12 D3/D4）。
 *
 * 本模块只负责「把后端给的 ASS 文本喂给 libass 并画出来」。
 * **前端不生成、也不修改 ASS** —— ASS 的唯一来源是后端 /api/render/ass，
 * 工程文件才是唯一真源（CLAUDE.md §4.1）。
 *
 * 字幕层有两种挂法：叠在 `<video>` 上（对轴舞台的预览），或挂在一块自备的
 * 画布上、由调用方给时钟（样式舞台的成片预览——那一步只确认观感，工程甚至
 * 可能还没有视频）。两者共用同一份 libass 实例封装与增量更新逻辑，
 * 只有「帧从哪来」不同，见 `Mount`。
 *
 * 版本要求：jassub@2.5.14（CLAUDE.md §5.9 锁死）。v2 砍掉了 v1.x 的
 * dropAllAnimations / targetFps / onDemandRender / blendMode / useLocalFonts 等选项，
 * 传进去只会被静默忽略，本文件一律不传。
 */

import JASSUB from 'jassub'
import { fontSubsetUrl } from '../api/client'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** wasm + worker 起不来时的等待上限。超时比无限转圈更容易排查。 */
const READY_TIMEOUT_MS = 20_000

/**
 * worker 与 wasm 一律从 public/jassub/ 下的静态副本加载，而不是包自带的默认路径。
 * 副本由 scripts/sync-jassub-assets.mjs 在 predev / prebuild 时从 node_modules 复制。
 *
 * 理由是**两端一致**：Vite 对 public/ 下的文件原样下发、不做任何转换，于是 dev 与
 * 构建产物加载的是同一份字节、同一组 URL，不留「只在一端验证过」的分叉；
 * jassub 的 worker 图（worker.js + 三个渲染器 + emscripten 胶水 + 嵌套 pthread worker）
 * 也就不会被打包器改写。
 *
 * **这里曾经写着另一套因果**：说 Vite 会往被它转换过的 worker 文件顶部注入
 * `import '/node_modules/vite/dist/client/env.mjs'`，WebKit 在嵌套 worker 里拒绝加载
 * 它，所以字幕不出现。按 jassub 2.5.14 + vite 6 复核，dev server 下发的
 * `/node_modules/jassub/dist/worker/worker.js` 里**没有这行注入**，该说法至少已不成立。
 * Safari 上字幕消失的真因是另一件事：**WebKit 在 304 响应上丢掉 COEP**，
 * 导致页面里第二个 JASSUB 实例的 worker 被 COEP 拒绝加载 ——
 * 详见 vite.config.ts 的 `crossOriginIsolationPlugin`，那里有单变量对照实验。
 * 静态副本这套安排与那个 bug 无关，留着是因为上面那条"两端一致"的理由本身成立。
 *
 * 两份 wasm 必须都传：JASSUB 按运行时 SIMD 探测在 modern / legacy 之间二选一
 * （实测 Chromium 选 modern、WebKit 选 legacy），只传一个会让另一条路径悄悄退回包内
 * 默认 URL，变成「有的机器走静态副本、有的机器走打包产物」。
 *
 * 路径写成绝对形式，前提是应用挂在站点根下 —— dev、vite preview、Tauri 壳都如此。
 */
const JASSUB_ASSETS = {
  workerUrl: '/jassub/worker/worker.js',
  wasmUrl: '/jassub/wasm/jassub-worker.wasm',
  modernWasmUrl: '/jassub/wasm/jassub-worker-modern.wasm',
} as const

/**
 * 增量更新退化为整轨重建的阈值。
 *
 * `renderer.*` 的每次调用都是跨 worker 的 IPC，而且**不 await 等于没执行**
 * （CLAUDE.md §5.9）。逐条 setEvent 在「改了少数几行」时远快于整轨重建，
 * 但在「全局 offset 平移」这种所有事件都变的场景下，N 次串行 IPC 反而更慢，
 * 此时一次 setTrack 更划算。
 */
const FULL_RELOAD_RATIO = 0.25
const FULL_RELOAD_MIN_EVENTS = 32

// ---------------------------------------------------------------------------
// 运行环境自检
// ---------------------------------------------------------------------------

export interface PreviewIssue {
  /** fatal 表示预览完全起不来；warn 表示能跑但有降级或缺陷 */
  level: 'fatal' | 'warn'
  title: string
  /** 面向用户的可能原因说明，不要只报错误码 */
  detail: string
}

/**
 * 在创建实例之前先把环境问题查清楚。
 *
 * 注意 SharedArrayBuffer 缺失**不是致命错误**：JASSUB 会自动退回单线程渲染。
 * 把它报成致命会让 Firefox（本身不支持 worker 多线程）永远看不到预览。
 */
export function checkPreviewEnvironment(): PreviewIssue[] {
  const issues: PreviewIssue[] = []

  if (typeof Worker === 'undefined') {
    issues.push({
      level: 'fatal',
      title: '浏览器不支持 Web Worker',
      detail: 'JASSUB 在独立 Worker 里运行 libass。请改用较新版本的 Chrome / Edge / Firefox / Safari。',
    })
  }

  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    issues.push({
      level: 'fatal',
      title: '浏览器不支持 WebAssembly',
      detail: 'libass 以 WebAssembly 形式运行，没有它无法渲染字幕。',
    })
  }

  if (
    typeof HTMLCanvasElement === 'undefined' ||
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function'
  ) {
    issues.push({
      level: 'fatal',
      title: '浏览器不支持 OffscreenCanvas',
      detail:
        'JASSUB 把画布控制权转移给 Worker 后再绘制。Safari 16.4 以下、以及部分嵌入式 WebView 不支持。',
    })
  }

  if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
    issues.push({
      level: 'warn',
      title: '跨源隔离未生效，libass 退回单线程渲染',
      detail:
        '字幕仍能显示，但复杂特效帧率会下降。常见原因：一、没有经 Vite dev server 访问' +
        '（COOP/COEP 两个响应头由 vite.config.ts 下发）；二、用 http:// 加局域网 IP 访问，' +
        '浏览器判定为非安全上下文，SharedArrayBuffer 被禁用；三、套 Tauri 壳后没配' +
        ' app.security.headers（需要 Tauri ≥ 2.1.0）。Firefox 不支持 Worker 多线程，' +
        '在 Firefox 上此项必然出现，可忽略。',
    })
  }

  return issues
}

// ---------------------------------------------------------------------------
// rVFC：驱动播放头与字幕重绘的唯一时钟
// ---------------------------------------------------------------------------

/**
 * 帧元数据。lib.dom 对 requestVideoFrameCallback 的收录还不稳定，
 * 这里按 W3C 规范只声明本项目用得到的字段，避免依赖环境自带的全局类型。
 */
export interface FrameMeta {
  /** 当前呈现帧对应的媒体时间（秒）。逐字高亮必须用它，不能用 video.currentTime */
  mediaTime: number
  expectedDisplayTime: number
  width: number
  height: number
}

interface FrameCallbackHost {
  requestVideoFrameCallback?(callback: (now: number, meta: FrameMeta) => void): number
  cancelVideoFrameCallback?(handle: number): void
}

/** 环境是否提供 rVFC。没有时只能退回 rAF + currentTime，精度不足以驱动逐字高亮。 */
export function hasFrameCallback(video: HTMLVideoElement): boolean {
  return typeof (video as HTMLVideoElement & FrameCallbackHost).requestVideoFrameCallback === 'function'
}

/**
 * 逐帧回调循环，返回取消函数。
 *
 * 优先 requestVideoFrameCallback：它给出的 mediaTime 是**这一帧真正对应的媒体时间**。
 * timeupdate 事件每 250ms 才触发一次，精度差两个数量级，不能用来驱动逐字高亮。
 * rAF 兜底路径只在浏览器没有 rVFC 时启用（旧版 Firefox）。
 */
export function requestFrameLoop(
  video: HTMLVideoElement,
  callback: (meta: FrameMeta) => void,
): () => void {
  const host = video as HTMLVideoElement & FrameCallbackHost
  let cancelled = false

  if (typeof host.requestVideoFrameCallback === 'function') {
    let handle = 0
    const step = (_now: number, meta: FrameMeta): void => {
      if (cancelled) return
      callback(meta)
      handle = host.requestVideoFrameCallback!(step)
    }
    handle = host.requestVideoFrameCallback(step)
    return () => {
      cancelled = true
      host.cancelVideoFrameCallback?.(handle)
    }
  }

  let raf = 0
  const tick = (): void => {
    if (cancelled) return
    callback({
      mediaTime: video.currentTime,
      expectedDisplayTime: performance.now(),
      width: video.videoWidth,
      height: video.videoHeight,
    })
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => {
    cancelled = true
    cancelAnimationFrame(raf)
  }
}

// ---------------------------------------------------------------------------
// ASS 解析（只为增量更新服务，不做序列化）
// ---------------------------------------------------------------------------

/**
 * 与 libass 的 ASS_Event 一一对应，字段名必须与 jassub 的 ASSEvent 完全一致。
 * Start / Duration 的单位是**毫秒**（libass 内部就是毫秒），Style 是样式表下标。
 */
export interface AssEvent {
  Start: number
  Duration: number
  Name: string
  Effect: string
  Text: string
  ReadOrder: number
  Layer: number
  Style: number
  MarginL: number
  MarginR: number
  MarginV: number
}

export interface ParsedAss {
  /** 除 Dialogue 外的全部原文。它一变就说明样式/头部变了，只能整轨重建 */
  headerSignature: string
  /** 样式名，顺序即 libass 里的下标 */
  styleNames: string[]
  events: AssEvent[]
}

const DEFAULT_EVENT_FORMAT = [
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
]

/** `H:MM:SS.cc` → 毫秒。小数位按实际位数解释，不假设一定是两位。 */
function parseTimestamp(value: string): number {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(value)
  if (!m) return 0
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = Number(m[3])
  const frac = m[4] ? Number(`0.${m[4]}`) : 0
  return Math.round(((h * 60 + min) * 60 + sec + frac) * 1000)
}

function toInt(value: string): number {
  const n = Number.parseInt(value.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/** 前 count-1 个字段按逗号切，最后一个字段（Text）原样保留 —— Text 里必然含逗号 */
function splitFields(body: string, count: number): string[] {
  const out: string[] = []
  let rest = body
  for (let i = 0; i < count - 1; i++) {
    const idx = rest.indexOf(',')
    if (idx < 0) {
      out.push(rest)
      rest = ''
      continue
    }
    out.push(rest.slice(0, idx))
    rest = rest.slice(idx + 1)
  }
  out.push(rest)
  return out
}

export function parseAss(text: string): ParsedAss {
  const headerLines: string[] = []
  const styleNames: string[] = []
  const events: AssEvent[] = []

  let section = ''
  let eventFormat = DEFAULT_EVENT_FORMAT
  let styleNameIndex = 0

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const trimmed = line.trim()

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).toLowerCase()
      headerLines.push(line)
      continue
    }

    const colon = line.indexOf(':')
    const key = colon >= 0 ? line.slice(0, colon).trim().toLowerCase() : ''
    const body = colon >= 0 ? line.slice(colon + 1) : ''

    if (section === 'events') {
      if (key === 'format') {
        eventFormat = body.split(',').map((s) => s.trim())
        headerLines.push(line)
        continue
      }
      if (key === 'dialogue') {
        const parts = splitFields(body, eventFormat.length)
        const field = (name: string): string => {
          const i = eventFormat.indexOf(name)
          return i >= 0 ? (parts[i] ?? '') : ''
        }
        const start = parseTimestamp(field('Start'))
        const end = parseTimestamp(field('End'))
        const styleIndex = styleNames.indexOf(field('Style').trim())
        events.push({
          Start: start,
          Duration: Math.max(0, end - start),
          Name: field('Name').trim(),
          Effect: field('Effect').trim(),
          Text: field('Text'),
          ReadOrder: events.length,
          Layer: toInt(field('Layer')),
          Style: styleIndex >= 0 ? styleIndex : 0,
          MarginL: toInt(field('MarginL')),
          MarginR: toInt(field('MarginR')),
          MarginV: toInt(field('MarginV')),
        })
        continue
      }
      headerLines.push(line)
      continue
    }

    if (section.endsWith('styles') || section.endsWith('styles+')) {
      if (key === 'format') {
        const idx = body.split(',').map((s) => s.trim()).indexOf('Name')
        styleNameIndex = idx >= 0 ? idx : 0
      } else if (key === 'style') {
        const parts = body.split(',')
        styleNames.push((parts[styleNameIndex] ?? '').trim())
      }
    }

    headerLines.push(line)
  }

  return { headerSignature: headerLines.join('\n'), styleNames, events }
}

function sameEvent(a: AssEvent, b: AssEvent): boolean {
  return (
    a.Start === b.Start &&
    a.Duration === b.Duration &&
    a.Layer === b.Layer &&
    a.Style === b.Style &&
    a.MarginL === b.MarginL &&
    a.MarginR === b.MarginR &&
    a.MarginV === b.MarginV &&
    a.Name === b.Name &&
    a.Effect === b.Effect &&
    a.Text === b.Text
  )
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

export interface PreviewFontSource {
  /** ASS 里引用的字体族名，必须与后端 style.font_name 对得上 */
  family: string
  /** 字体文件 URL */
  url: string
}

/**
 * JASSUB 用的是 ASS_FONTPROVIDER_NONE —— **浏览器里根本拿不到系统字体**
 * （CLAUDE.md §5.12）。它自带的 default.woff2 只有 145KB，不含任何 CJK 字形，
 * 所以不显式喂字体文件，日文歌词会整片渲染成豆腐块。
 *
 * 字体不预打包（CLAUDE.md §2.6：一律经后端从本机系统按需提取），默认字体来源
 * 就是当前工程的 `style.font_name`，经 `GET /api/fonts/subset?family=` 子集化，
 * 与导出侧 ffmpeg 用的是同一份字节，WYSIWYG 才成立。传入空 family（工程还没
 * 设置字体）时返回空数组，交由 `loadFonts` 走"没有字体可用"的降级路径。
 */
export function defaultFontSources(fontFamily: string): PreviewFontSource[] {
  const family = fontFamily.trim()
  return family ? [{ family, url: fontSubsetUrl(family) }] : []
}

interface LoadedFont {
  family: string
  data: Uint8Array
}

/** 503（后端字体扫描/子集化尚未就绪）时按 `Retry-After` 兜底的重试间隔 */
const FONT_FETCH_RETRY_FALLBACK_MS = 2_000
/**
 * 503 重试的总等待上限。系统字体冷扫描本机实测 40.9 秒
 * （backend/kvm/api/routes/fonts.py 模块文档），留出余量避免刚好卡在边界。
 */
const FONT_FETCH_MAX_WAIT_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 响应体是 JSON 且带 `detail` 字段时取出来；不是 JSON（比如静态文件的 404）时返回 null */
async function readErrorDetail(resp: Response): Promise<string | null> {
  try {
    const body = (await resp.json()) as { detail?: unknown }
    if (body?.detail) return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  } catch {
    /* 响应体不是 JSON，保留状态行 */
  }
  return null
}

type FontFetchResult =
  | { kind: 'ok'; data: Uint8Array }
  | { kind: 'pending'; detail: string }
  | { kind: 'error'; detail: string }

/**
 * 取一个字体文件的字节。后端字体扫描/子集化未完成时返回 503 + `Retry-After`
 * （见 `backend/kvm/api/routes/fonts.py` 的 `_require_font`），这里按该间隔重试，
 * **不当作错误**——这是"自动环节失败要降级、不能终止"在字体加载上的体现
 * （CLAUDE.md §2.5）。超过 `FONT_FETCH_MAX_WAIT_MS` 仍是 503 才作为 `pending`
 * 上报给调用方，由它决定怎么提示用户，而不是直接抛错炸掉整个预览。
 */
async function fetchFontData(url: string): Promise<FontFetchResult> {
  const deadline = Date.now() + FONT_FETCH_MAX_WAIT_MS
  for (;;) {
    let resp: Response
    try {
      resp = await fetch(url)
    } catch (e) {
      return { kind: 'error', detail: describeError(e) }
    }
    if (resp.ok) return { kind: 'ok', data: new Uint8Array(await resp.arrayBuffer()) }

    if (resp.status === 503) {
      const detail = (await readErrorDetail(resp)) ?? '字体准备中，请稍候。'
      if (Date.now() >= deadline) return { kind: 'pending', detail }
      const retryAfter = Number(resp.headers.get('Retry-After'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : FONT_FETCH_RETRY_FALLBACK_MS
      await sleep(Math.max(0, Math.min(waitMs, deadline - Date.now())))
      continue
    }

    return { kind: 'error', detail: (await readErrorDetail(resp)) ?? `${resp.status} ${resp.statusText}` }
  }
}

async function loadFonts(
  sources: PreviewFontSource[],
): Promise<{ fonts: LoadedFont[]; warnings: PreviewIssue[] }> {
  if (!sources.length) {
    return {
      fonts: [],
      warnings: [
        {
          level: 'warn',
          title: '工程未设置字体',
          detail: '工程的 style.font_name 为空，无法确定该加载哪个字体；请在样式面板里选择字体。',
        },
      ],
    }
  }

  const fonts: LoadedFont[] = []
  const missing: string[] = []
  const pending: string[] = []

  await Promise.all(
    sources.map(async (source) => {
      const result = await fetchFontData(source.url)
      if (result.kind === 'ok') {
        fonts.push({ family: source.family, data: result.data })
      } else if (result.kind === 'pending') {
        pending.push(`${source.family}：${result.detail}`)
      } else {
        missing.push(`${source.family}（${result.detail}）`)
      }
    }),
  )

  const warnings: PreviewIssue[] = []
  if (pending.length) {
    warnings.push({
      level: 'warn',
      title: '字体准备中',
      detail:
        `${pending.join('；')}。预览暂时用不到该字体，画面可能出现豆腐块或临时使用其它已加载字体代替，` +
        '字体准备完成后重新打开工程或切换一次字体即可恢复正常。',
    })
  }
  if (!fonts.length && !pending.length) {
    warnings.push({
      level: 'warn',
      title: '预览缺少字体文件，日文字形会渲染成豆腐块',
      detail:
        `以下字体都没取到：${missing.join('、')}。JASSUB 在 WebAssembly 里拿不到系统字体，` +
        '必须显式提供字体文件；字体一律经后端从本机系统按需提取（GET /api/fonts/subset），' +
        '请确认后端服务正常运行。注意导出侧的 ffmpeg 会回退到系统字体，两端字体不一致会直接摧毁「所见即所得」。',
    })
  } else if (missing.length) {
    warnings.push({
      level: 'warn',
      title: '部分字体缺失，可能与导出结果不一致',
      detail: `没取到：${missing.join('、')}。缺字时 libass 会回退到已加载的其它字体。`,
    })
  }

  return { fonts, warnings }
}

// ---------------------------------------------------------------------------
// 实例封装
// ---------------------------------------------------------------------------

interface OverlayCommonOptions {
  /** 初始 ASS 文本，来自后端 /api/render/ass */
  ass: string
  /** 工程使用的字体族名（project.style.font_name），用于挑选默认字体 */
  fontFamily: string
  /**
   * 覆盖默认字体来源；不传时按 `fontFamily` 经 `GET /api/fonts/subset` 动态取字体
   * （见 `defaultFontSources`），仅用于测试或需要额外候选字体的场景。
   */
  fontSources?: PreviewFontSource[]
}

/**
 * 叠在真实视频画面上：JASSUB 自己建一块 canvas 插在 `<video>` 之后，用
 * ResizeObserver 跟随视频尺寸，并挂 rVFC 逐帧重绘。父容器必须 position: relative。
 */
export interface VideoOverlayOptions extends OverlayCommonOptions {
  video: HTMLVideoElement
  canvas?: undefined
}

/**
 * 挂在一块自备画布上，**完全不需要视频元素**。
 *
 * 样式舞台要的正是这个：那一步只确认成片观感，而工程可能根本还没有视频
 * （"先只有音轨、边听边打轴"是本工具最常见的起点，CLAUDE.md §2.5）。
 * jassub@2.5.14 的构造协议本来就接受 `canvas` 代替 `video`（见 dist/jassub.d.ts
 * 的 `JASSUBOptions`）；此时它不挂 rVFC 也不改画布的 CSS 尺寸，
 * **时钟与重绘全部由调用方经 `renderAt` 驱动**。
 *
 * `width` / `height` 是画面基准分辨率（工程的 video_width / video_height）：
 * libass 用它当 storage size，画布的 CSS 宽高比必须与之一致，否则 JASSUB 会
 * 按这个比例做信箱式内缩、画出来的字幕会被拉伸。
 */
export interface CanvasOverlayOptions extends OverlayCommonOptions {
  canvas: HTMLCanvasElement
  width: number
  height: number
  video?: undefined
}

export type OverlayOptions = VideoOverlayOptions | CanvasOverlayOptions

/** 实例挂在哪里。画布模式没有视频元素，帧元数据只能由调用方给的时钟合成。 */
type Mount =
  | { kind: 'video'; video: HTMLVideoElement }
  | { kind: 'canvas'; width: number; height: number }

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer = 0
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * 一层 libass 字幕。两种挂法见 `VideoOverlayOptions` / `CanvasOverlayOptions`。
 */
export class SubtitleOverlay {
  private destroyed = false
  /** 待应用的 ASS。中间态会被后来的覆盖 —— 拖拽时丢弃中间帧，只跟最后一次 */
  private pending: string | null = null
  private flushing = false
  private scheduled = 0
  private lastFrame: FrameMeta | null = null
  /** 画布模式的播放位置（秒）。视频模式下不用它，那边的时钟是 rVFC 的 mediaTime */
  private clockSec = 0
  /** 正在绘制中；并发进来的请求只登记意图，见 `paint` */
  private painting = false
  /** 绘制期间又来了一次强制重绘，空闲后必须补上 */
  private pendingForce = false

  /** 最近一次字幕更新的耗时（毫秒），用于判断增量接口够不够快 */
  lastUpdateMs = 0
  /** 最近一次更新是否退化成了整轨重建 */
  lastUpdateWasFullReload = false

  private constructor(
    private readonly instance: JASSUB,
    private readonly mount: Mount,
    private parsed: ParsedAss,
    readonly warnings: PreviewIssue[],
  ) {}

  static async create(opts: OverlayOptions): Promise<SubtitleOverlay> {
    const { fonts, warnings } = await loadFonts(opts.fontSources ?? defaultFontSources(opts.fontFamily))

    // 工程指定的字体优先；它没加载上就退到任意一个已加载字体，
    // 一个都没有时干脆不设 defaultFont，让 JASSUB 用自带的 Liberation Sans
    // 至少把拉丁字符画出来，而不是整块空白。
    const wanted = fonts.find(
      (f) => f.family.toLowerCase() === opts.fontFamily.trim().toLowerCase(),
    )
    const fallback = wanted ?? fonts[0]
    if (fonts.length && !wanted) {
      warnings.push({
        level: 'warn',
        title: `工程指定的字体「${opts.fontFamily}」未加载`,
        detail: `预览改用「${fallback!.family}」。字体不同会让字宽、换行位置与导出结果对不上。`,
      })
    }

    const common = {
      ...JASSUB_ASSETS,
      subContent: opts.ass,
      // 预加载：worker 在建轨之前就把字体灌进 libass，避免首帧无字形
      fonts: fonts.map((f) => f.data),
      ...(fallback ? { defaultFont: fallback.family } : {}),
      // 不查系统字体（Chromium 独有、需用户授权、破坏渲染确定性），
      // 也不联网拉 Google Fonts（会让预览与导出各用各的字体）
      queryFonts: false as const,
    }

    let instance: JASSUB
    try {
      instance = opts.video
        ? new JASSUB({ ...common, video: opts.video })
        : new JASSUB({ ...common, canvas: opts.canvas })
    } catch (e) {
      throw new Error(`JASSUB 初始化失败：${describeError(e)}`)
    }

    if (!opts.video) {
      /*
       * 画布模式必须先把画面基准尺寸告诉实例，**否则第一次 ResizeObserver 回调会算出 NaN**：
       * JASSUB 的 `resize()` 用 `_videoWidth / _videoHeight` 当宽高比，而它们初值是 0，
       * 0/0 = NaN 一路传染到 `_resizeCanvas(NaN, NaN, …)`。构造函数里 RO 回调 `await this.ready`
       * 之后才跑，所以这里同步赋值必定先于它。
       *
       * 这两个字段在 jassub 的 .d.ts 里是公开成员（`_videoWidth: number`），
       * 上游哪天改掉会在 tsc 阶段直接报错，不会静默失效。
       */
      instance._videoWidth = opts.width
      instance._videoHeight = opts.height
    }

    try {
      await withTimeout(
        instance.ready,
        READY_TIMEOUT_MS,
        `字幕渲染器在 ${READY_TIMEOUT_MS / 1000} 秒内没有就绪。` +
          '最常见的原因是 public/jassub/ 下的 worker / wasm 静态副本不在位 —— ' +
          '跑一次 `npm run sync:jassub` 重建（正常情况下 predev / prebuild 会自动跑）。' +
          '其次才是被浏览器扩展拦截。',
      )
    } catch (e) {
      void instance.destroy()
      throw e instanceof Error ? e : new Error(describeError(e))
    }

    const mount: Mount = opts.video
      ? { kind: 'video', video: opts.video }
      : { kind: 'canvas', width: opts.width, height: opts.height }
    return new SubtitleOverlay(instance, mount, parseAss(opts.ass), warnings)
  }

  /** 播放循环每帧回调进来，供暂停时重绘复用最后一帧的元数据 */
  noteFrame(meta: FrameMeta): void {
    this.lastFrame = meta
  }

  /**
   * 用新的 ASS 文本刷新字幕。
   *
   * 调用可以任意密集：内部按 rAF 节流、且只保留最后一次，
   * 不会让 IPC 排成长队把拖拽卡住。
   */
  update(ass: string): void {
    if (this.destroyed) return
    this.pending = ass
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled || this.flushing || this.destroyed) return
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0
      void this.flush()
    })
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.destroyed) return
    const ass = this.pending
    if (ass === null) return
    this.pending = null
    this.flushing = true

    const started = performance.now()
    try {
      await this.apply(ass)
    } catch {
      // 增量路径出任何差错都退回整轨重建：宁可慢一帧，不能显示错的字幕
      try {
        await this.instance.renderer.setTrack(ass)
        this.parsed = parseAss(ass)
        this.lastUpdateWasFullReload = true
        await this.repaint()
      } catch {
        /* 实例已销毁或 worker 已终止，忽略 */
      }
    } finally {
      this.lastUpdateMs = performance.now() - started
      this.flushing = false
      if (this.pending !== null) this.schedule()
    }
  }

  private async apply(ass: string): Promise<void> {
    const next = parseAss(ass)
    const prev = this.parsed
    const renderer = this.instance.renderer

    const headerChanged =
      prev.headerSignature !== next.headerSignature ||
      prev.styleNames.length !== next.styleNames.length ||
      prev.styleNames.some((name, i) => name !== next.styleNames[i])

    const changed: number[] = []
    if (!headerChanged) {
      const common = Math.min(prev.events.length, next.events.length)
      for (let i = 0; i < common; i++) {
        if (!sameEvent(prev.events[i]!, next.events[i]!)) changed.push(i)
      }
    }

    const churn = changed.length + Math.abs(prev.events.length - next.events.length)
    const tooMany = churn > Math.max(FULL_RELOAD_MIN_EVENTS, next.events.length * FULL_RELOAD_RATIO)

    if (headerChanged || tooMany) {
      await renderer.setTrack(ass)
      this.lastUpdateWasFullReload = true
    } else {
      // 每个 renderer.* 调用都是跨 worker 的 IPC 代理，不 await 等于没执行
      for (const i of changed) await renderer.setEvent(next.events[i]!, i)
      for (let i = prev.events.length; i < next.events.length; i++) {
        await renderer.createEvent(next.events[i]!)
      }
      // 倒着删，否则下标会随删除左移
      for (let i = prev.events.length - 1; i >= next.events.length; i--) {
        await renderer.removeEvent(i)
      }
      this.lastUpdateWasFullReload = false
    }

    this.parsed = next
    await this.repaint()
  }

  /**
   * 强制重绘一帧。
   *
   * JASSUB 只在 rVFC 回调里重绘，而编辑器 90% 的时间视频是暂停的 ——
   * 暂停时改了字幕不显式重绘，画面就一直是旧的（CLAUDE.md §5.9）。
   */
  async repaint(): Promise<void> {
    await this.paint(true)
  }

  /**
   * 画布模式：把字幕画到指定时刻。
   *
   * 这是画布模式**唯一的时钟入口** —— 没有 `<video>` 就没有 rVFC，libass 不会
   * 自己动。播放一句时逐帧调它（`force = false`，时间变了 libass 自然重排）；
   * 改了样式、换了句子、拖了进度条则要 `force = true` 强制重绘，
   * 否则时间没变、画面就一直是旧的（CLAUDE.md §5.9）。
   *
   * 视频模式下调用无效果：那边的时间由播放器决定，凭空改时钟只会和 rVFC 打架。
   */
  async renderAt(ms: number, force = false): Promise<void> {
    if (this.mount.kind !== 'canvas') return
    this.clockSec = Math.max(0, ms / 1000)
    await this.paint(force)
  }

  /**
   * 真正下笔的地方，**自己排队，绝不并发调用 `manualRender`**。
   *
   * JASSUB 对并发绘制的处理是"忙就丢，闲下来补一帧"，而补的那一帧
   * `repaint` 恒为 false（jassub.js 的 `_demandRender`：busy → `_skipped = true`，
   * 之后 `await this._demandRender()` 不带参数）。于是**强制重绘会被静默降级**：
   * 改完样式那次 `repaint()` 撞上正在进行的绘制，画面就停在旧的一帧上，
   * 表现为"改了看不见"，而且时序相关、时好时坏。
   *
   * 这里只保留最后一次请求，并把"欠一次强制重绘"记下来在空闲时补上：
   * 播放时丢中间帧是对的（下一帧马上就来），但强制重绘一次都不能丢。
   */
  private async paint(force: boolean): Promise<void> {
    if (this.destroyed) return
    if (this.painting) {
      this.pendingForce ||= force
      return
    }
    this.painting = true
    try {
      let wanted = force
      do {
        wanted = wanted || this.pendingForce
        this.pendingForce = false
        const meta = this.frameMeta()
        if (!meta) return
        await this.instance.manualRender(meta, wanted)
        wanted = false
      } while (this.pendingForce && !this.destroyed)
    } catch {
      /* 销毁竞态，忽略 */
    } finally {
      this.painting = false
    }
  }

  private frameMeta(): FrameMeta | null {
    if (this.mount.kind === 'canvas') {
      return {
        mediaTime: this.clockSec,
        expectedDisplayTime: performance.now(),
        width: this.mount.width,
        height: this.mount.height,
      }
    }
    const v = this.mount.video
    if (!v.videoWidth || !v.videoHeight) return null
    // 优先复用真实帧的元数据；还没有帧时按当前播放位置合成一个
    if (this.lastFrame && this.lastFrame.width === v.videoWidth) return { ...this.lastFrame }
    return {
      mediaTime: v.currentTime,
      expectedDisplayTime: performance.now(),
      width: v.videoWidth,
      height: v.videoHeight,
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    if (this.scheduled) cancelAnimationFrame(this.scheduled)
    this.pending = null
    try {
      await this.instance.destroy()
    } catch {
      /* 已经拆掉了 */
    }
  }
}
