/**
 * JASSUB（libass 的 WebAssembly 构建）封装：实例生命周期、字体注入、增量字幕更新、错误处理。
 *
 * 为什么预览必须用 libass、而不是 DOM 或 Canvas 自绘：导出侧的 ffmpeg 也用 libass，
 * 两端同源才谈得上「预览对了导出也对」（CLAUDE.md §5.12 D3/D4）。
 *
 * 本模块只负责「把后端给的 ASS 文本喂给 libass 并画在 <video> 上」。
 * **前端不生成、也不修改 ASS** —— ASS 的唯一来源是后端 /api/render/ass，
 * 工程文件才是唯一真源（CLAUDE.md §4.1）。
 *
 * 版本要求：jassub@2.5.14（CLAUDE.md §5.9 锁死）。v2 砍掉了 v1.x 的
 * dropAllAnimations / targetFps / onDemandRender / blendMode / useLocalFonts 等选项，
 * 传进去只会被静默忽略，本文件一律不传。
 */

import JASSUB from 'jassub'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** wasm + worker 起不来时的等待上限。超时比无限转圈更容易排查。 */
const READY_TIMEOUT_MS = 20_000

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
  /** 字体文件 URL。放在 frontend/public/fonts/ 下即可用 /fonts/xxx 访问 */
  url: string
}

/**
 * JASSUB 用的是 ASS_FONTPROVIDER_NONE —— **浏览器里根本拿不到系统字体**
 * （CLAUDE.md §5.12）。它自带的 default.woff2 只有 145KB，不含任何 CJK 字形，
 * 所以不显式喂字体文件，日文歌词会整片渲染成豆腐块。
 *
 * 这里给出约定路径；文件不存在时会降级并给出中文警告，而不是白屏。
 * 后端默认 style.font_name 是 `Noto Sans CJK JP`（backend/kvm/models/karaoke.py），
 * 想换成 CLAUDE.md §5.8 推荐的「源真ゴシック Heavy」时，同步改这里与后端默认值。
 */
export const DEFAULT_FONT_SOURCES: PreviewFontSource[] = [
  { family: 'Noto Sans CJK JP', url: '/fonts/NotoSansCJKjp-Regular.otf' },
  { family: 'Noto Sans JP', url: '/fonts/NotoSansJP-Regular.otf' },
]

interface LoadedFont {
  family: string
  data: Uint8Array
}

async function loadFonts(
  sources: PreviewFontSource[],
): Promise<{ fonts: LoadedFont[]; warnings: PreviewIssue[] }> {
  const fonts: LoadedFont[] = []
  const missing: string[] = []

  await Promise.all(
    sources.map(async (source) => {
      try {
        const resp = await fetch(source.url)
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
        fonts.push({ family: source.family, data: new Uint8Array(await resp.arrayBuffer()) })
      } catch {
        missing.push(`${source.family}（${source.url}）`)
      }
    }),
  )

  const warnings: PreviewIssue[] = []
  if (!fonts.length) {
    warnings.push({
      level: 'warn',
      title: '预览缺少字体文件，日文字形会渲染成豆腐块',
      detail:
        `以下字体都没取到：${missing.join('、')}。JASSUB 在 WebAssembly 里拿不到系统字体，` +
        '必须显式提供字体文件。把字体放进 frontend/public/fonts/ 后刷新即可；' +
        '注意导出侧的 ffmpeg 会回退到系统字体，两端字体不一致会直接摧毁「所见即所得」。',
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

export interface OverlayOptions {
  video: HTMLVideoElement
  /** 初始 ASS 文本，来自后端 /api/render/ass */
  ass: string
  /** 工程使用的字体族名（project.style.font_name），用于挑选默认字体 */
  fontFamily: string
  fontSources?: PreviewFontSource[]
}

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
 * 挂在 <video> 上的字幕层。
 *
 * JASSUB 会自己建一个绝对定位的 canvas 插在 <video> 之后，并用 ResizeObserver
 * 跟随视频尺寸，所以父容器必须是 position: relative。
 */
export class SubtitleOverlay {
  private destroyed = false
  /** 待应用的 ASS。中间态会被后来的覆盖 —— 拖拽时丢弃中间帧，只跟最后一次 */
  private pending: string | null = null
  private flushing = false
  private scheduled = 0
  private lastFrame: FrameMeta | null = null

  /** 最近一次字幕更新的耗时（毫秒），用于判断增量接口够不够快 */
  lastUpdateMs = 0
  /** 最近一次更新是否退化成了整轨重建 */
  lastUpdateWasFullReload = false

  private constructor(
    private readonly instance: JASSUB,
    private readonly video: HTMLVideoElement,
    private parsed: ParsedAss,
    readonly warnings: PreviewIssue[],
  ) {}

  static async create(opts: OverlayOptions): Promise<SubtitleOverlay> {
    const { fonts, warnings } = await loadFonts(opts.fontSources ?? DEFAULT_FONT_SOURCES)

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

    let instance: JASSUB
    try {
      instance = new JASSUB({
        video: opts.video,
        subContent: opts.ass,
        // 预加载：worker 在建轨之前就把字体灌进 libass，避免首帧无字形
        fonts: fonts.map((f) => f.data),
        ...(fallback ? { defaultFont: fallback.family } : {}),
        // 不查系统字体（Chromium 独有、需用户授权、破坏渲染确定性），
        // 也不联网拉 Google Fonts（会让预览与导出各用各的字体）
        queryFonts: false,
      })
    } catch (e) {
      throw new Error(`JASSUB 初始化失败：${describeError(e)}`)
    }

    try {
      await withTimeout(
        instance.ready,
        READY_TIMEOUT_MS,
        `字幕渲染器在 ${READY_TIMEOUT_MS / 1000} 秒内没有就绪。` +
          '可能是 jassub 的 wasm / worker 资源没被打包出来（检查 vite.config.ts 的 ' +
          'optimizeDeps.exclude 与 worker.format 配置），或被浏览器扩展拦截。',
      )
    } catch (e) {
      void instance.destroy()
      throw e instanceof Error ? e : new Error(describeError(e))
    }

    return new SubtitleOverlay(instance, opts.video, parseAss(opts.ass), warnings)
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
    if (this.destroyed) return
    const meta = this.frameMeta()
    if (!meta) return
    try {
      await this.instance.manualRender(meta, true)
    } catch {
      /* 销毁竞态，忽略 */
    }
  }

  private frameMeta(): FrameMeta | null {
    const v = this.video
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
