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

/** loading：音轨还在解码；webaudio：走 Web Audio；fallback：退回视频自带音轨 */
type AudioState = 'loading' | 'webaudio' | 'fallback'

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

  const envIssues = useMemo(() => checkPreviewEnvironment(), [])
  const fatal = envIssues.filter((i) => i.level === 'fatal')
  const blocked = fatal.length > 0

  const projectId = project?.id ?? null
  const durationMs = project?.duration_ms ?? 0
  const hasVideo = !!project?.video_path
  const fontName = project?.style.font_name ?? ''
  const audioPath = project?.audio_path ?? null
  const instrumentalPath = project?.instrumental_path ?? null

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
    video.muted = audioState !== 'fallback'
  }, [audioState, hasVideo])

  // --- 字幕层：工程 / 视频 / 字体变化时重建 ---------------------------------

  useEffect(() => {
    const video = videoRef.current
    if (!video || !projectId || !hasVideo || blocked) return

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
      void created?.destroy()
    }
  }, [projectId, hasVideo, fontName, blocked])

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
    if (!video || !hasVideo) return
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
  }, [emitPlayhead, hasVideo])

  /**
   * 没有视频时的时钟：rVFC 依附于 <video>，纯音频工程里它一帧都不会触发。
   * 此时直接读音频引擎（主时钟本来就是它），否则播放头会一动不动 ——
   * 「先只有音轨、边听边打轴」正是本工具最常见的起点（CLAUDE.md §2.5）。
   */
  useEffect(() => {
    if (hasVideo || !playing) return
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
  }, [emitPlayhead, hasVideo, playing, setPlaying])

  // --- 播放位置：store → 播放器（时间轴 / 注音编辑器发来的跳转意图） ----------

  const seekTo = useCallback((ms: number) => {
    const sec = Math.max(0, ms / 1000)
    const video = videoRef.current
    if (video) video.currentTime = sec
    audioRef.current?.seek(sec)
    if (seekBarRef.current) seekBarRef.current.value = String(ms)
    if (clockRef.current) clockRef.current.textContent = formatTime(ms)
    // 暂停时 seek，浏览器仍会呈现新帧并触发 rVFC，JASSUB 自会重绘；
    // 没有视频画面时补一次，避免字幕停在旧位置
    if (!video || !video.videoWidth) void overlayRef.current?.repaint()
  }, [])

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
    const video = videoRef.current
    const engine = audioRef.current
    if (!playing) {
      video?.pause()
      engine?.pause()
      return
    }
    void (async () => {
      const at = useProject.getState().playheadMs / 1000
      try {
        await engine?.play(at)
        if (video) {
          video.currentTime = at
          video.playbackRate = rateRef.current
          await video.play()
        }
        setPlaybackError(null)
      } catch (e) {
        setPlaying(false)
        setPlaybackError(`无法开始播放：${describeError(e)}`)
      }
    })()
  }, [playing, setPlaying, audioState])

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

  const issues: PreviewIssue[] = [
    ...envIssues,
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
    ...(audioState === 'fallback'
      ? [
          {
            level: 'warn' as const,
            title: '正在使用视频自带音轨',
            detail:
              'Web Audio 没拿到可用音轨，已临时改用视频自身的声音，此时无法切换伴奏。' +
              '音频抽取或人声分离完成后会自动切回 Web Audio。',
          },
        ]
      : []),
  ]

  return (
    <div className={className} style={styles.root}>
      {/* JASSUB 会把它的 canvas 绝对定位插在 <video> 之后，所以这里必须 relative */}
      <div style={styles.stage}>
        {hasVideo ? (
          <video
            ref={videoRef}
            // 跨源隔离页面里不加 crossOrigin，带 CORP 头的媒体会加载失败；
            // JASSUB 还要靠未被污染的画面读色彩空间来对齐字幕颜色矩阵
            crossOrigin="anonymous"
            playsInline
            muted
            preload="auto"
            src={api.mediaUrl(project.id, 'video')}
            onEnded={onEnded}
            onError={() =>
              setPlaybackError(
                '视频加载失败。请确认媒体文件仍在，且后端为 /media 响应带上了 Cross-Origin-Resource-Policy 头。',
              )
            }
            style={styles.video}
          />
        ) : (
          <div style={styles.noVideo}>还没有视频。下载或选择本地文件后即可预览。</div>
        )}
        {overlayLoading && <div style={styles.badge}>字幕渲染器加载中…</div>}
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
    alignItems: 'center',
    justifyContent: 'center',
    color: '#777',
    fontSize: 13,
  },
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
