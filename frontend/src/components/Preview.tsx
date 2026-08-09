/**
 * 预览播放器：视频 + libass 字幕叠加 + 原声/伴奏切换。
 *
 * 这是「一站式」的技术前提 —— 所见即所得的实时预览。三条硬约束：
 *
 * 1. 字幕由 JASSUB（libass 的 WASM 构建）叠在 <video> 上，ASS 文本一律取自后端
 *    /api/render/ass。前端不拼 ASS，导出侧的 ffmpeg 用同一份 libass（CLAUDE.md §5.12）。
 * 2. <video> **永远静音**，声音统一走 Web Audio（CLAUDE.md D15）。W3C 明确说明
 *    多个 media element 之间无法保持同步，所以「原声/伴奏」不能用两个 <audio> 互相追时间。
 * 3. 播放头一律由 rVFC 的 mediaTime 驱动：timeupdate 每 250ms 才触发一次，
 *    精度不足以驱动逐字高亮；video.currentTime 在 Firefox 上被量化到 2ms，
 *    规范上也只是「近似值」。
 *
 * ## 本组件是全应用唯一的播放时钟
 *
 * 时间轴、波形、注音编辑器都**没有**自己的播放器：它们写 store 的
 * `playheadMs` / `playing` / `playbackRate` 只表示「请跳到这里 / 请播 / 请变速」，
 * 由这里执行，执行完再把真实位置写回 `playheadMs`。回环靠 `lastEmittedRef`
 * 精确相等切断（见其注释）。
 *
 * 曾经波形层自带一份 wavesurfer 时钟并把 `timeupdate` 写回 store，
 * 于是两个时钟互相追时间 —— 表现为播放头抖动和大量多余 seek。**不要再开第二个时钟。**
 *
 * ## 视频轨是可选的从动方，不是播放的前提
 *
 * 声音、播放头、字幕时间全部来自 AudioContext 主时钟，`<video>` 只贡献画面。
 * 因此**没有视频、或视频这个浏览器解不了，都不该让播放失败**：
 *
 * - 工程只导入了音轨（"先只有音轨、边听边打轴"是本工具最常见的起点，§2.5）时，
 *   根本不渲染 `<video>`，播放头改由 rAF 直读音频引擎推进；
 * - 视频存在但浏览器放不了时同样降级为纯音频。实测：yt-dlp 下下来的 `.mkv`
 *   在 WebKit 里没有解复用器，`<video>` 报 `MEDIA_ERR_SRC_NOT_SUPPORTED`、
 *   `play()` 抛 `NotSupportedError: The operation is not supported.`
 *   （Chromium 能放，所以这条路径只有 Safari 会走到）。
 *
 * 这条降级的实现要点是**先起音频、再起视频，且视频单独 try/catch**：
 * 早先两者写在同一个 try 里，视频一抛异常就把整段 catch 走掉、顺手
 * `setPlaying(false)`，结果声音刚起来又被立刻掐掉，用户看到的就是"完全不能播"。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import * as api from '../api/client'
import type { JobStatus } from '../api/types'
import { t } from '../i18n'
import {
  checkPreviewEnvironment,
  describeError,
  hasFrameCallback,
  requestFrameLoop,
  SubtitleOverlay,
  type FrameMeta,
  type PreviewIssue,
} from '../lib/jassub'
import { useProject } from '../state/projectStore'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 工程变动后重新拉取 ASS 的防抖窗口。
 *
 * 重建 ASS 要走一次后端往返（POST /api/render/ass），远超一帧的 16ms，
 * 所以拖拽过程中不能每次变更都拉。这个窗口天然实现了「拖动时不更新、停手才更新」：
 * 连续拖拽期间不会发起请求，手一停（或松开）就刷新。
 */
const ASS_REFRESH_DEBOUNCE_MS = 120

/** 视频相对音频时钟的软纠偏阈值（秒）。CLAUDE.md D15 给的是 40~50ms */
const SOFT_SYNC_S = 0.045
/** 超过这个偏差就直接 seek —— 用变速已经追不回来了 */
const HARD_SYNC_S = 0.25
/** 软纠偏时的播放速率偏移。静音视频调速没有音高副作用，比频繁 seek 平滑得多 */
const SYNC_RATE_DELTA = 0.02
/** 原声/伴奏交叉淡入时长（秒），避免切换时爆音 */
const CROSSFADE_S = 0.06

type AudioMode = 'original' | 'instrumental'

const AUDIO_LABEL: Record<AudioMode, string> = { original: '原声', instrumental: '伴奏' }

/**
 * loading：音轨还在解码；webaudio：走 Web Audio；fallback：Web Audio 没拿到音轨。
 *
 * **`fallback` 只说明 Web Audio 空了，不等于"已经退回视频自带音轨"。** 真正退得回去
 * 还要求画面这条路本身是通的（`videoActive`），而工程刚建、视频正在下载、
 * 或者这个浏览器压根放不了这个视频时都不通 —— 那些情况下声音无处可退。
 * 二者曾被当成一回事，于是没有视频时也会弹出「已改用视频自身的声音」。
 */
type AudioState = 'loading' | 'webaudio' | 'fallback'

/** 素材准备任务的 kind → 画面区文案键。未知 kind 落到通用的"正在准备素材" */
const BUSY_LABEL: Record<string, string> = {
  'media.download': 'media.player.downloading',
  'media.separate': 'media.player.separating',
  'media.proxy': 'media.player.buildingProxy',
}

/** 有任务在跑时的轮询间隔（毫秒）。只为换一行文案，不必追进度条那种精度 */
const ACTIVITY_POLL_BUSY_MS = 1200
/** 没有任务在跑时的轮询间隔。素材齐了会整个停掉，见轮询 effect 的说明 */
const ACTIVITY_POLL_IDLE_MS = 4000

// ---------------------------------------------------------------------------
// 音频引擎
// ---------------------------------------------------------------------------

/**
 * 两条音轨（原声 / 伴奏）作为两个 AudioBufferSourceNode 同时 start，
 * 用 GainNode 交叉淡入切换。它们共用同一个 AudioContext 时钟，天然采样级对齐，
 * 切换时不需要 seek，也就不会「切一下跳一下」。
 *
 * AudioContext 是主时钟，<video> 是从动方。
 */
class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly buffers = new Map<AudioMode, AudioBuffer>()
  private readonly gains = new Map<AudioMode, GainNode>()
  private readonly sources = new Map<AudioMode, AudioBufferSourceNode>()

  /** 播放锚点：ctx 时间轴上的一个时刻，以及它对应的媒体位置 */
  private anchorCtxTime = 0
  private anchorMediaSec = 0
  private running = false
  private mode: AudioMode = 'original'
  private rate = 1
  private disposed = false

  get available(): boolean {
    return this.buffers.size > 0
  }

  get playing(): boolean {
    return this.running
  }

  /** 已载入音轨里最长的那条的时长（秒）。没有音轨时为 0 */
  get durationSec(): number {
    let max = 0
    for (const buffer of this.buffers.values()) max = Math.max(max, buffer.duration)
    return max
  }

  has(mode: AudioMode): boolean {
    return this.buffers.has(mode)
  }

  /** 主时钟：当前媒体位置（秒）。变速时 ctx 时间要按速率折算成媒体时间 */
  get positionSec(): number {
    if (!this.ctx || !this.running) return this.anchorMediaSec
    return Math.max(
      this.anchorMediaSec,
      this.anchorMediaSec + (this.ctx.currentTime - this.anchorCtxTime) * this.rate,
    )
  }

  /**
   * 载入音轨，返回中文警告列表。
   * 某条轨缺失不影响另一条，也不能因此终止 —— 一站式定位下「失败要降级」（CLAUDE.md §2.5）。
   */
  async load(projectId: string, kinds: Record<AudioMode, boolean>): Promise<PreviewIssue[]> {
    const warnings: PreviewIssue[] = []
    let ctx: AudioContext
    try {
      ctx = new AudioContext()
    } catch (e) {
      return [
        {
          level: 'warn',
          title: '无法创建 Web Audio 上下文',
          detail: `${describeError(e)}。预览将回退到视频自带音轨，伴奏切换不可用。`,
        },
      ]
    }
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)

    const targets: Array<[AudioMode, 'audio' | 'instrumental']> = [
      ['original', 'audio'],
      ['instrumental', 'instrumental'],
    ]

    for (const [mode, kind] of targets) {
      if (!kinds[mode]) continue
      try {
        const resp = await fetch(api.mediaUrl(projectId, kind))
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
        const decoded = await ctx.decodeAudioData(await resp.arrayBuffer())
        if (this.disposed) return warnings
        const gain = ctx.createGain()
        gain.gain.value = mode === this.mode ? 1 : 0
        gain.connect(this.master)
        this.buffers.set(mode, decoded)
        this.gains.set(mode, gain)
      } catch (e) {
        warnings.push({
          level: 'warn',
          title: `${AUDIO_LABEL[mode]}音轨加载失败`,
          detail: `${describeError(e)}。${
            mode === 'instrumental'
              ? '伴奏需要先跑一次人声分离，完成后会自动可用。'
              : '请确认视频已下载并抽出了音频。'
          }`,
        })
      }
    }
    return warnings
  }

  async play(offsetSec: number): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.available || this.disposed) return
    if (ctx.state === 'suspended') await ctx.resume()
    this.stopSources()

    const when = ctx.currentTime
    for (const [mode, buffer] of this.buffers) {
      const gain = this.gains.get(mode)
      if (!gain) continue
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.playbackRate.value = this.rate
      src.connect(gain)
      src.start(when, Math.max(0, Math.min(offsetSec, buffer.duration)))
      this.sources.set(mode, src)
    }
    this.anchorCtxTime = when
    this.anchorMediaSec = offsetSec
    this.running = true
  }

  pause(): void {
    if (!this.running) return
    this.anchorMediaSec = this.positionSec
    this.running = false
    this.stopSources()
  }

  seek(offsetSec: number): void {
    if (this.running) {
      void this.play(offsetSec)
    } else {
      this.anchorMediaSec = offsetSec
    }
  }

  /**
   * 变速（打轴时用 0.5~0.75x 试听，CLAUDE.md §5.10）。
   *
   * 先把锚点结算到当前位置再改速率，否则**已经播过的那段**会被按新速率重新折算，
   * 播放头会瞬间跳一大截。`AudioBufferSourceNode.playbackRate` 可以在播放中直接改，
   * 不必重起 source，也就没有换挡时的断音。
   *
   * 代价：Web Audio 的 buffer source 变速会同步改变音高（没有 preservesPitch），
   * 0.75x 试听会降调约 5 个半音。保音高需要相位声码器，属于后续课题。
   */
  setRate(rate: number): void {
    const ctx = this.ctx
    if (rate <= 0 || rate === this.rate) return
    this.anchorMediaSec = this.positionSec
    this.anchorCtxTime = ctx?.currentTime ?? 0
    this.rate = rate
    for (const src of this.sources.values()) src.playbackRate.value = rate
  }

  setMode(mode: AudioMode): void {
    const ctx = this.ctx
    // 目标轨还不存在时（例如尚未分离出伴奏）保持现状，由 UI 禁用对应按钮
    if (!ctx || !this.buffers.has(mode)) return
    this.mode = mode
    const now = ctx.currentTime
    for (const [m, gain] of this.gains) {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(m === mode ? 1 : 0, now + CROSSFADE_S)
    }
  }

  setVolume(value: number): void {
    if (this.master) this.master.gain.value = value
  }

  dispose(): void {
    this.disposed = true
    this.stopSources()
    this.buffers.clear()
    this.gains.clear()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }

  private stopSources(): void {
    for (const src of this.sources.values()) {
      try {
        src.stop()
      } catch {
        /* 尚未 start 或已自然结束 */
      }
      src.disconnect()
    }
    this.sources.clear()
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
  const clamped = Math.max(0, ms)
  const m = Math.floor(clamped / 60000)
  const s = Math.floor((clamped % 60000) / 1000)
  const cs = Math.floor((clamped % 1000) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export interface PreviewProps {
  className?: string
}

export function Preview({ className }: PreviewProps) {
  const project = useProject((s) => s.project)
  const playing = useProject((s) => s.playing)
  const playbackRate = useProject((s) => s.playbackRate)
  const audioMode = useProject((s) => s.audioMode)
  const setPlayhead = useProject((s) => s.setPlayhead)
  const setPlaying = useProject((s) => s.setPlaying)
  const setAudioMode = useProject((s) => s.setAudioMode)
  const refreshProject = useProject((s) => s.refresh)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<SubtitleOverlay | null>(null)
  const audioRef = useRef<AudioEngine | null>(null)
  const seekBarRef = useRef<HTMLInputElement | null>(null)
  const clockRef = useRef<HTMLSpanElement | null>(null)
  /** 音量用 ref 传给异步回调，免得把它塞进「重建音频引擎」的依赖数组 */
  const volumeRef = useRef(1)
  /** 播放速率同理：逐帧的纠偏回调要读它，但不该因它变化而重挂 */
  const rateRef = useRef(playbackRate)

  /**
   * 最近一次由播放器写进 store 的播放头。
   *
   * 双向绑定的回环就靠它切断：store 里的值与它**完全相等**说明这次变化是播放器
   * 自己发出的，忽略；不相等就是时间轴（或别的组件）改的，需要 seek。
   * 用精确相等而不是阈值 —— setPlayhead 写进去的就是这个数，不会有误差，
   * 也就不必猜一个「多小算是同一个位置」的经验值。
   */
  const lastEmittedRef = useRef<number>(useProject.getState().playheadMs)
  const assTimerRef = useRef<number>(0)
  const assInFlightRef = useRef(false)
  const assDirtyRef = useRef(false)

  const [overlayError, setOverlayError] = useState<string | null>(null)
  const [overlayLoading, setOverlayLoading] = useState(false)
  const [overlayWarnings, setOverlayWarnings] = useState<PreviewIssue[]>([])
  const [audioWarnings, setAudioWarnings] = useState<PreviewIssue[]>([])
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [volume, setVolume] = useState(1)
  const [audioState, setAudioState] = useState<AudioState>('loading')
  const [instrumentalReady, setInstrumentalReady] = useState(false)
  const [rvfcMissing, setRvfcMissing] = useState(false)
  /** 当前正在跑的素材准备任务（下载 / 分离 / 代理）。见下方轮询 effect */
  const [activity, setActivity] = useState<JobStatus[]>([])
  /**
   * 工程里有视频，但这个浏览器放不了它（容器/编码不支持）。
   * 置位后一切与 `<video>` 相关的路径都停掉，只留音频，画面位置改显提示。
   */
  const [videoUnplayable, setVideoUnplayable] = useState(false)

  const envIssues = useMemo(() => checkPreviewEnvironment(), [])
  const fatal = envIssues.filter((i) => i.level === 'fatal')
  const blocked = fatal.length > 0

  const projectId = project?.id ?? null
  const durationMs = project?.duration_ms ?? 0
  const hasVideo = !!project?.video_path
  const videoPath = project?.video_path ?? null
  const proxyPath = project?.proxy_video_path ?? null

  /**
   * 画面取哪一份素材：**有代理就用代理**（H.264 / MP4 / 无音轨 / 约 1 秒 GOP），
   * 没有才回退原视频。
   *
   * 原视频常是 AV1 + Matroska + Opus——Safari 三重放不了（没有 Matroska 解复用器、
   * 不认 MKV 里的 Opus、M1/M2 也没有 AV1 硬解），所以在 WebKit 上"有没有代理"
   * 直接决定看不看得见画面；4K 长 GOP 还会让逐帧核对音节边界卡住。
   *
   * **这只影响预览。** 导出成片始终烧在原始素材上（后端 render 路由读的是
   * `video_path`），代理是 540p 无音轨的编辑器专用产物，绝不能拿来出片。
   */
  const videoSrcKind: 'proxy' | 'video' = proxyPath ? 'proxy' : 'video'
  const fontName = project?.style.font_name ?? ''
  const audioPath = project?.audio_path ?? null
  const instrumentalPath = project?.instrumental_path ?? null

  /**
   * 视频画面这条路是否还走得通。**播放的前提只有音频**，这个值只决定
   * 「要不要驱动 `<video>`、要不要挂字幕层」，不参与播放能否开始的判断。
   */
  const videoActive = hasVideo && !videoUnplayable

  /**
   * 素材已经齐到不会再影响预览：画面有、且放得出来、音轨也有。
   * 齐了就不必再问后端"有没有任务在跑"（见下方轮询 effect）。
   */
  const mediaSettled = videoActive && !!audioPath

  /**
   * `videoUnplayable` 的 ref 镜像。命令式路径（seek / play）要读它，
   * 但它们不该因为这个值变化而重挂 —— 播放中途才发现视频放不了时，
   * 重挂播放 effect 会让音频从头 `start()` 一次，听感上就是"咔"一下。
   */
  const videoUnplayableRef = useRef(false)

  const markVideoUnplayable = useCallback(() => {
    videoUnplayableRef.current = true
    setVideoUnplayable(true)
  }, [])

  /**
   * 换了工程或换了视频文件，之前那次「放不了」的结论就作废，重新给它一次机会。
   * 代理路径也算：后台把代理跑出来之后 src 会从原视频切到代理，
   * 那正是「刚才放不了的东西现在放得了」的典型时刻，不复位就白跑一场。
   */
  useEffect(() => {
    videoUnplayableRef.current = false
    setVideoUnplayable(false)
  }, [projectId, videoPath, proxyPath])

  /**
   * 素材准备任务轮询。
   *
   * 存在的理由：**「素材还没准备好」与「真的降级了」在工程 JSON 上长得一模一样**
   * —— 正在下载和从没下载过，`video_path` 都是空的。把前者当成后者报出来，用户会
   * 以为出了故障，而他其实什么都不用做，等着就行。这个区分只有后端答得了
   * （`GET /api/media/activity/{id}`）。
   *
   * 顺带兑现"完成后自动恢复"：任务从有到无时刷新一次工程。App 里那份 JobProgress
   * 只认它**自己发起**的任务 —— 页面刷新过、或者代理是后端在下载完成后自动发起的，
   * 它都不认识，那时没有别人来刷新，画面就一直不出现。
   *
   * **素材齐了就整个停掉**：编辑一首歌要几十分钟，没有任何东西会变的时候
   * 不该一直问后端。
   */
  useEffect(() => {
    if (!projectId || mediaSettled) {
      setActivity([])
      return
    }
    let alive = true
    let timer = 0
    let running = new Set<string>()

    const poll = async (): Promise<void> => {
      let jobs: JobStatus[]
      try {
        jobs = await api.mediaActivity(projectId)
      } catch {
        // 后端暂时联系不上就退避重试，不放弃：任务多半还在跑
        if (alive) timer = window.setTimeout(() => void poll(), ACTIVITY_POLL_IDLE_MS * 2)
        return
      }
      if (!alive) return
      setActivity(jobs)
      // 判据是"**有任务从在跑里消失了**"，不是"队列空了"：下载一完成后端会立刻
      // 接着排代理任务，等队列空掉才刷新，画面会白白晚出现一个代理生成的时长
      const ids = new Set(jobs.map((j) => j.job_id))
      if ([...running].some((id) => !ids.has(id))) void refreshProject()
      running = ids
      timer = window.setTimeout(
        () => void poll(),
        jobs.length > 0 ? ACTIVITY_POLL_BUSY_MS : ACTIVITY_POLL_IDLE_MS,
      )
    }

    void poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [projectId, mediaSettled, refreshProject])

  /**
   * 取当前真正能用的 `<video>`。没有视频的工程根本不渲染这个元素，所以 ref 为空
   * 就已经代表"纯音频工程"。除此之外还要现场看一眼 `video.error`：媒体元素报错是
   * 异步事件，可能比某次命令式调用晚一步到，只靠 state 会有一帧的空窗。
   */
  const usableVideo = useCallback((): HTMLVideoElement | null => {
    const video = videoRef.current
    if (!video || videoUnplayableRef.current || video.error) return null
    return video
  }, [])

  // --- 音频：工程或音轨可用性变化时重建 ------------------------------------

  useEffect(() => {
    if (!projectId) return
    const engine = new AudioEngine()
    audioRef.current = engine
    setAudioState('loading')
    setInstrumentalReady(false)
    let cancelled = false

    void engine
      .load(projectId, { original: !!audioPath, instrumental: !!instrumentalPath })
      .then((warnings) => {
        if (cancelled) return
        setAudioWarnings(warnings)
        setInstrumentalReady(engine.has('instrumental'))
        setAudioState(engine.available ? 'webaudio' : 'fallback')
        engine.setMode(useProject.getState().audioMode)
        engine.setRate(rateRef.current)
        engine.setVolume(volumeRef.current)
        // 音轨可能是分离作业跑完后才出现的，此刻若正在播放就续上当前位置
        if (useProject.getState().playing) {
          void engine.play(useProject.getState().playheadMs / 1000)
        }
      })

    return () => {
      cancelled = true
      audioRef.current = null
      engine.dispose()
    }
  }, [projectId, audioPath, instrumentalPath])

  useEffect(() => {
    volumeRef.current = volume
    audioRef.current?.setVolume(volume)
    const video = videoRef.current
    if (video && audioState === 'fallback') video.volume = volume
  }, [volume, audioState])

  useEffect(() => {
    audioRef.current?.setMode(audioMode)
  }, [audioMode])

  /**
   * 变速由这里统一执行：音频引擎与 <video> 必须同时改，否则视频会被纠偏逻辑
   * 一路当成「漂了」而不停 seek。时间轴上那个速率下拉框只是把值写进 store。
   */
  useEffect(() => {
    rateRef.current = playbackRate
    audioRef.current?.setRate(playbackRate)
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [playbackRate])

  /**
   * <video> 永远静音，除非 Web Audio 完全不可用。
   * 后者是降级路径：此时只有一个媒体元素在出声，不违反「不能让两个元素互相追」。
   */
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !(videoActive && audioState === 'fallback')
  }, [audioState, videoActive])

  // --- 字幕层：工程 / 视频 / 字体变化时重建 ---------------------------------

  useEffect(() => {
    const video = videoRef.current
    if (!video || !projectId || !videoActive || blocked) return

    let disposed = false
    let created: SubtitleOverlay | null = null
    setOverlayError(null)
    setOverlayLoading(true)

    void (async () => {
      try {
        const { ass } = await api.buildAss(projectId)
        if (disposed) return
        created = await SubtitleOverlay.create({ video, ass, fontFamily: fontName })
        if (disposed) {
          void created.destroy()
          created = null
          return
        }
        overlayRef.current = created
        setOverlayWarnings(created.warnings)
      } catch (e) {
        if (!disposed) setOverlayError(describeError(e))
      } finally {
        if (!disposed) setOverlayLoading(false)
      }
    })()

    return () => {
      disposed = true
      overlayRef.current = null
      // 视频中途被判定为放不了时这个 effect 会被拆掉，而上面的 finally 因为
      // disposed 不再复位 loading —— 不在这里清掉，「字幕渲染器加载中…」会一直挂着
      setOverlayLoading(false)
      void created?.destroy()
    }
  }, [projectId, videoActive, fontName, blocked])

  // --- ASS 刷新：工程一变就重新拉 -------------------------------------------

  const refreshAss = useCallback(async (id: string): Promise<void> => {
    if (assInFlightRef.current) {
      assDirtyRef.current = true
      return
    }
    assInFlightRef.current = true
    try {
      do {
        assDirtyRef.current = false
        const { ass } = await api.buildAss(id)
        overlayRef.current?.update(ass)
        setOverlayError(null)
      } while (assDirtyRef.current)
    } catch (e) {
      setOverlayError(`重新生成字幕失败：${describeError(e)}`)
    } finally {
      assInFlightRef.current = false
      assDirtyRef.current = false
    }
  }, [])

  useEffect(() => {
    return useProject.subscribe((state, prev) => {
      // 每次编辑后端都返回一个全新的工程对象，引用不等即视为有改动
      if (state.project === prev.project) return
      const id = state.project?.id
      if (!id || id !== prev.project?.id) return
      window.clearTimeout(assTimerRef.current)
      assTimerRef.current = window.setTimeout(() => void refreshAss(id), ASS_REFRESH_DEBOUNCE_MS)
    })
  }, [refreshAss])

  useEffect(() => () => window.clearTimeout(assTimerRef.current), [])

  // --- 播放位置：播放器 → store ----------------------------------------------

  /** 把真实播放位置写进 store，并同步进度条与时钟文字。回环切断也在这里 */
  const emitPlayhead = useCallback(
    (ms: number) => {
      if (ms === lastEmittedRef.current) return
      lastEmittedRef.current = ms
      setPlayhead(ms)
      if (seekBarRef.current) seekBarRef.current.value = String(ms)
      if (clockRef.current) clockRef.current.textContent = formatTime(ms)
    },
    [setPlayhead],
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoActive) return
    setRvfcMissing(!hasFrameCallback(video))

    return requestFrameLoop(video, (meta: FrameMeta) => {
      overlayRef.current?.noteFrame(meta)

      emitPlayhead(Math.round(meta.mediaTime * 1000))

      // 音频是主时钟，视频跟着它走。偏差小时微调播放速率（静音视频调速无副作用），
      // 大到追不回来才硬 seek —— 每次超阈值就 seek 会让画面一直抖。
      // 基准速率是用户选的试听速率，纠偏只在它上下浮动 ±2%。
      const base = rateRef.current
      const engine = audioRef.current
      if (!engine?.available || !engine.playing) {
        if (video.playbackRate !== base) video.playbackRate = base
        return
      }
      // 纠偏比的是「播放时钟」，所以这里用 currentTime 而不是 mediaTime：
      // mediaTime 是已呈现帧的时间，天然落后于播放位置一帧左右。
      const drift = video.currentTime - engine.positionSec
      if (Math.abs(drift) > HARD_SYNC_S) {
        video.currentTime = engine.positionSec
        video.playbackRate = base
      } else if (Math.abs(drift) > SOFT_SYNC_S) {
        video.playbackRate = base * (drift > 0 ? 1 - SYNC_RATE_DELTA : 1 + SYNC_RATE_DELTA)
      } else if (video.playbackRate !== base) {
        video.playbackRate = base
      }
    })
  }, [emitPlayhead, videoActive])

  /**
   * 没有可用视频时的时钟：rVFC 依附于 <video>，纯音频工程（以及视频放不了、
   * 已降级为纯音频的工程）里它一帧都不会触发。此时直接读音频引擎
   * （主时钟本来就是它），否则播放头会一动不动 ——
   * 「先只有音轨、边听边打轴」正是本工具最常见的起点（CLAUDE.md §2.5）。
   */
  useEffect(() => {
    if (videoActive || !playing) return
    let raf = 0
    const tick = (): void => {
      const engine = audioRef.current
      if (engine?.available) {
        const pos = engine.positionSec
        // 音频放完了要自己停：没有 <video> 就没有 onEnded 兜底
        if (engine.durationSec > 0 && pos >= engine.durationSec) {
          emitPlayhead(Math.round(engine.durationSec * 1000))
          setPlaying(false)
          return
        }
        emitPlayhead(Math.round(pos * 1000))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emitPlayhead, videoActive, playing, setPlaying])

  // --- 播放位置：store → 播放器（时间轴 / 注音编辑器发来的跳转意图） ----------

  const seekTo = useCallback(
    (ms: number) => {
      const sec = Math.max(0, ms / 1000)
      const video = usableVideo()
      if (video) video.currentTime = sec
      audioRef.current?.seek(sec)
      if (seekBarRef.current) seekBarRef.current.value = String(ms)
      if (clockRef.current) clockRef.current.textContent = formatTime(ms)
      // 暂停时 seek，浏览器仍会呈现新帧并触发 rVFC，JASSUB 自会重绘；
      // 没有视频画面时补一次，避免字幕停在旧位置
      if (!video || !video.videoWidth) void overlayRef.current?.repaint()
    },
    [usableVideo],
  )

  /**
   * store 里的播放头只要不是本组件刚写进去的，就一律当成「别人请求跳到这里」。
   * 时间轴点波形、概览条、注音编辑器跳到某个字，走的都是这一条路 ——
   * 它们不碰任何播放器，真正的 seek 只在这里发生一次。
   */
  useEffect(() => {
    return useProject.subscribe((state) => {
      if (state.playheadMs === lastEmittedRef.current) return
      lastEmittedRef.current = state.playheadMs
      seekTo(state.playheadMs)
    })
  }, [seekTo])

  // --- 播放 / 暂停 -----------------------------------------------------------

  useEffect(() => {
    const engine = audioRef.current
    if (!playing) {
      videoRef.current?.pause()
      engine?.pause()
      return
    }
    void (async () => {
      const at = useProject.getState().playheadMs / 1000

      // 第一步：起音频。它是主时钟也是唯一声源，只有它失败才算「播不了」。
      try {
        await engine?.play(at)
        setPlaybackError(null)
      } catch (e) {
        setPlaying(false)
        setPlaybackError(`无法开始播放：${describeError(e)}`)
        return
      }

      // 第二步：起画面。视频只是从动方，起不来就地降级为纯音频预览，
      // **不许回头去动播放状态** —— 否则 WebKit 放不了 mkv 会把整段播放掐掉。
      const video = usableVideo()
      if (!video) return
      try {
        video.currentTime = at
        video.playbackRate = rateRef.current
        await video.play()
      } catch {
        markVideoUnplayable()
      }
    })()
  }, [playing, setPlaying, audioState, usableVideo, markVideoUnplayable])

  const onEnded = useCallback(() => setPlaying(false), [setPlaying])

  const onSeekBar = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const ms = Number(e.target.value)
      lastEmittedRef.current = ms
      setPlayhead(ms)
      seekTo(ms)
    },
    [seekTo, setPlayhead],
  )

  // --- 渲染 ------------------------------------------------------------------

  if (!project) {
    return (
      <div className={className} style={styles.placeholder}>
        还没有打开工程。
      </div>
    )
  }

  if (blocked) {
    return (
      <div className={className} style={styles.placeholder}>
        <IssueList issues={fatal} />
      </div>
    )
  }

  /*
   * 素材状态与降级状态必须分开算，这是本组件最容易搞错的一处。
   *
   * - **素材没准备好**（工程刚建 / 视频正在下载）是正常的中间状态，用户什么都
   *   不用做。它的归宿是画面区那行中性说明，**不进警告列表**。
   * - **降级**是"本该做到的事没做到，已经用次优方案顶着"，前提是**真的有东西可退**。
   *   没有视频时说"已改用视频自身的声音"就是无中生有 —— 那正是这次要修的 bug。
   */
  const busyJob = activity[0] ?? null
  const downloading = activity.some((j) => j.kind === 'media.download')
  const proxyBuilding = activity.some((j) => j.kind === 'media.proxy')
  /** 声音真的退回了 `<video>` 自带音轨。画面这条路不通时退无可退，不算降级 */
  const usingVideoAudio = videoActive && audioState === 'fallback'
  /** 画面放不了、又没有独立音轨：此刻预览既没画面也没声音，必须说出来 */
  const silent = videoUnplayable && !audioPath && audioState === 'fallback'

  const issues: PreviewIssue[] = [
    // 跨源隔离那条只关系到 libass 的渲染线程数，字幕层还没挂起来时提它没有意义，
    // 只会让"素材还没到"的空预览凭空多一条黄字
    ...(videoActive ? envIssues : envIssues.filter((i) => i.level === 'fatal')),
    ...overlayWarnings,
    ...audioWarnings,
    ...(rvfcMissing
      ? [
          {
            level: 'warn' as const,
            title: '浏览器不支持 requestVideoFrameCallback',
            detail: '已退回逐动画帧采样，逐字高亮可能与画面差半帧到一帧。',
          },
        ]
      : []),
    ...(usingVideoAudio
      ? [
          {
            level: 'warn' as const,
            title: t('media.player.warn.fallbackTitle'),
            detail: t('media.player.warn.fallbackDetail'),
          },
        ]
      : []),
    ...(silent
      ? [
          {
            level: 'warn' as const,
            title: t('media.player.audioMissing'),
            detail: t('media.player.audioMissingHint'),
          },
        ]
      : []),
    ...(videoUnplayable
      ? [
          {
            level: 'warn' as const,
            title: t('media.player.warn.unplayableTitle'),
            detail:
              t('media.player.warn.unplayableDetail') +
              // 代理正在生成时不该催用户去生成代理——他已经在等了
              (proxyBuilding
                ? t('media.player.warn.unplayableBuilding')
                : proxyPath
                  ? t('media.player.warn.unplayableRetry')
                  : t('media.player.warn.unplayableNeedProxy')),
          },
        ]
      : []),
  ]

  /**
   * 画面区当前该说什么：主行说"是什么状态"，副行说"接下来会怎样 / 该做什么"。
   * 没有副行就不显示，不硬凑。
   */
  const stageNote = ((): { title: string; hint?: string } | null => {
    if (videoActive) return null
    if (videoUnplayable) {
      return {
        title: t('media.player.unplayable'),
        hint: proxyBuilding
          ? t('media.player.busyHint')
          : proxyPath
            ? undefined
            : t('media.player.unplayableProxyHint'),
      }
    }
    // 下载优先于"只有音轨"：下载中的工程随时会长出画面，说"只有音轨"是错的
    if (downloading) {
      return { title: t('media.player.downloading'), hint: t('media.player.busyHint') }
    }
    if (audioPath) return { title: t('media.player.audioOnly') }
    if (busyJob) {
      return {
        title: t(BUSY_LABEL[busyJob.kind] ?? 'media.player.preparing'),
        hint: t('media.player.busyHint'),
      }
    }
    return { title: t('media.player.noAssets'), hint: t('media.player.noAssetsHint') }
  })()

  return (
    <div className={className} style={styles.root}>
      {/* JASSUB 会把它的 canvas 绝对定位插在 <video> 之后，所以这里必须 relative */}
      <div style={styles.stage}>
        {hasVideo && (
          <video
            ref={videoRef}
            // 跨源隔离页面里不加 crossOrigin，带 CORP 头的媒体会加载失败；
            // JASSUB 还要靠未被污染的画面读色彩空间来对齐字幕颜色矩阵
            crossOrigin="anonymous"
            playsInline
            muted
            preload="auto"
            src={api.mediaUrl(project.id, videoSrcKind)}
            onEnded={onEnded}
            // 元素报错就地降级为纯音频，**不当致命错误**：声音、播放头、打轴、
            // 导出全都不依赖这条视频轨（WebKit 放不了 .mkv 时走的正是这里）
            onError={markVideoUnplayable}
            style={styles.video}
          />
        )}
        {stageNote && (
          <div style={styles.noVideo}>
            <span style={styles.noVideoTitle}>{stageNote.title}</span>
            {stageNote.hint && <span style={styles.noVideoHint}>{stageNote.hint}</span>}
          </div>
        )}
        {overlayLoading && videoActive && <div style={styles.badge}>字幕渲染器加载中…</div>}
      </div>

      <div style={styles.controls}>
        <button type="button" onClick={() => setPlaying(!playing)} style={styles.button}>
          {playing ? '暂停' : '播放'}
        </button>

        <span ref={clockRef} style={styles.clock}>
          {formatTime(useProject.getState().playheadMs)}
        </span>
        <span style={styles.duration}>/ {formatTime(durationMs)}</span>

        <input
          ref={seekBarRef}
          type="range"
          min={0}
          max={Math.max(1, durationMs)}
          defaultValue={useProject.getState().playheadMs}
          onChange={onSeekBar}
          style={styles.seek}
        />

        <div style={styles.group}>
          {(['original', 'instrumental'] as AudioMode[]).map((mode) => {
            const disabled =
              audioState !== 'webaudio' || (mode === 'instrumental' && !instrumentalReady)
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                title={disabled ? '伴奏需要先完成人声分离' : undefined}
                onClick={() => setAudioMode(mode)}
                style={{
                  ...styles.toggle,
                  ...(audioMode === mode ? styles.toggleActive : null),
                  ...(disabled ? styles.toggleDisabled : null),
                }}
              >
                {AUDIO_LABEL[mode]}
              </button>
            )
          })}
        </div>

        <label style={styles.volume}>
          音量
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>
      </div>

      {(overlayError ?? playbackError) && (
        <IssueList
          issues={[
            ...(overlayError
              ? [{ level: 'fatal' as const, title: '字幕预览不可用', detail: overlayError }]
              : []),
            ...(playbackError
              ? [{ level: 'fatal' as const, title: '播放出错', detail: playbackError }]
              : []),
          ]}
        />
      )}
      {issues.length > 0 && <IssueList issues={issues} />}
    </div>
  )
}

function IssueList({ issues }: { issues: PreviewIssue[] }) {
  return (
    <ul style={styles.issues}>
      {issues.map((issue, i) => (
        <li
          key={`${issue.title}-${i}`}
          style={{
            ...styles.issue,
            ...(issue.level === 'fatal' ? styles.issueFatal : styles.issueWarn),
          }}
        >
          <strong>{issue.title}</strong>
          <div style={styles.issueDetail}>{issue.detail}</div>
        </li>
      ))}
    </ul>
  )
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 8 },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: 16,
    color: '#888',
    fontSize: 13,
  },
  stage: { position: 'relative', background: '#000', aspectRatio: '16 / 9', overflow: 'hidden' },
  video: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  noVideo: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '0 16px',
    textAlign: 'center',
  },
  // 主行比副行亮：一眼先读到"现在是什么状态"，再读"接下来会怎样"。
  // 两行同色会糊成一段说明文字，正是要避免的观感
  noVideoTitle: { color: '#aab', fontSize: 14 },
  noVideoHint: { color: '#777', fontSize: 12 },
  badge: {
    position: 'absolute',
    left: 8,
    top: 8,
    padding: '2px 8px',
    borderRadius: 4,
    background: 'rgba(0,0,0,.6)',
    color: '#ddd',
    fontSize: 12,
  },
  controls: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  button: { padding: '4px 14px', cursor: 'pointer' },
  clock: { fontVariantNumeric: 'tabular-nums', fontSize: 13, minWidth: 64 },
  duration: { fontVariantNumeric: 'tabular-nums', fontSize: 13, color: '#888' },
  seek: { flex: 1, minWidth: 120 },
  group: { display: 'flex' },
  toggle: { padding: '4px 12px', cursor: 'pointer' },
  toggleActive: { fontWeight: 700 },
  toggleDisabled: { cursor: 'not-allowed', opacity: 0.5 },
  volume: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 },
  issues: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  issue: { padding: '6px 10px', borderRadius: 4, fontSize: 12, lineHeight: 1.6 },
  issueFatal: { background: '#3a1414', color: '#ffb4b4' },
  issueWarn: { background: '#3a3214', color: '#ffe2a8' },
  issueDetail: { opacity: 0.85 },
} satisfies Record<string, CSSProperties>

export default Preview
