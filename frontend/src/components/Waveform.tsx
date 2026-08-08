/**
 * 波形显示（wavesurfer.js@7）。
 *
 * ## 职责边界
 *
 * 本组件只负责「画波形 + 滚动/缩放」，**不认识 token、不认识工程数据，也不播放**。
 * 三级调轴的全部交互都在 `Timeline.tsx` 的覆盖层里做。这样波形层可以被独立替换
 * （例如将来改成吃后端预算好的 peaks，CLAUDE.md §5.10），而不用动调轴交互代码。
 *
 * ## 为什么滚动交给 wavesurfer 而不是自己实现
 *
 * wavesurfer 内部的滚动容器同时承载了 canvas 分块懒渲染。自己再套一层滚动只会得到
 * 两个互相追赶的 scrollLeft。所以这里的分工是：
 * **wavesurfer 是滚动与缩放的唯一真源**，它每次滚动都通过 `onScrollPx` 同步出去，
 * 覆盖层照着这个值平移即可，两边天然对齐。
 * （"播放时跟随播放头"不在此列：那要读播放位置，由 `Timeline.tsx` 主动调 `setScrollPx`。）
 *
 * ## 降级（CLAUDE.md §2.5：失败要降级，不能终止）
 *
 * `sources` 是一串候选音频 URL。伴奏还没分离出来时自动退到原始音轨、再退到视频轨，
 * 全部失败也只是没有波形——Timeline 仍然可以打轴，不会把用户卡死在这一步。
 *
 * ## 不播放、不计时（CLAUDE.md D15）
 *
 * `Preview.tsx` 的 Web Audio（原声/伴奏双 stem 交叉淡入）是全应用**唯一**的音源，
 * 同时也是**唯一的播放时钟**。本组件里的 wavesurfer 只用来解码出峰值并画波形，
 * **从不 play()**：
 *
 * - 两个媒体元素同时出声会得到双份声音，而且 W3C 明确说明多个 media element 之间
 *   无法互相保持同步，所以不存在"也放但静音一个"这种折中；
 * - 就算静音，它自己跑起来的时钟也会和 Preview 的时钟互相追时间 —— 早先正是这样：
 *   波形把 `timeupdate` 写进 store，Preview 一见播放头变化就 seek，两边抖成一团。
 *
 * 因此播放位置一律**从 store 的 `playheadMs` 读**（由 `Timeline.tsx` 负责画播放头
 * 与跟随滚动），本组件既不产生时间也不消费时间。wavesurfer 自带的光标与进度着色
 * 一并关掉：它们只会停在 0 秒处误导人。
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'

export type WaveformStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; percent: number }
  | { kind: 'ready'; durationMs: number }
  | { kind: 'error'; message: string }

/**
 * 只剩「滚动」这一类命令。播放、暂停、seek、读时间全部不在这里 ——
 * 那些属于 Preview 的时钟（见文件头）。
 */
export interface WaveformHandle {
  getScrollPx(): number
  setScrollPx(px: number): void
  /** 把某个时刻滚到视口中央 */
  centerMs(ms: number): void
  isReady(): boolean
}

export interface WaveformProps {
  /** 候选音频，按优先级排列，前一个失败自动退到下一个 */
  sources: string[]
  height: number
  pxPerSec: number
  onStatus(status: WaveformStatus): void
  /** 滚动同步。**必须同步执行**，覆盖层靠它在同一帧内平移 */
  onScrollPx(px: number): void
}

export const Waveform = forwardRef<WaveformHandle, WaveformProps>(function Waveform(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const readyRef = useRef(false)
  /** 当前用的是 sources 里的第几个 */
  const srcIndexRef = useRef(0)
  /** 组件已卸载：wavesurfer 的异步回调必须靠它自我了断 */
  const deadRef = useRef(false)

  // 回调每次渲染都可能是新函数。存进 ref，避免为了拿到最新回调而反复重建 wavesurfer
  const cbRef = useRef(props)
  cbRef.current = props

  const srcKey = props.sources.join('|')

  useImperativeHandle(
    ref,
    (): WaveformHandle => ({
      getScrollPx: () => wsRef.current?.getScroll() ?? 0,
      setScrollPx: (px) => wsRef.current?.setScroll(px),
      centerMs: (ms) => wsRef.current?.setScrollTime(Math.max(0, ms / 1000)),
      isReady: () => readyRef.current,
    }),
    [],
  )

  // 只在挂载时建一次实例；后续所有参数变化都走 setOptions / load
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    deadRef.current = false

    const ws = WaveSurfer.create({
      container: el,
      height: cbRef.current.height,
      waveColor: '#46617f',
      // 进度色与波形同色、光标宽度为 0：本组件不跑时钟，它俩只会永远停在 0 秒处。
      // 真正的播放头由 Timeline 的覆盖层按 store 的 playheadMs 画
      progressColor: '#46617f',
      cursorWidth: 0,
      minPxPerSec: cbRef.current.pxPerSec,
      fillParent: true,
      // 跟随滚动由 Timeline 按 playheadMs 自己做：wavesurfer 的 autoScroll 只认它
      // 自己的播放进度，而它永远不播
      autoScroll: false,
      autoCenter: false,
      hideScrollbar: true,
      // 点击 seek 由覆盖层统一处理：两套 seek 语义并存必然在拖拽时打架
      interact: false,
      normalize: true,
      // 只用于画峰值，降采样能显著缩短长曲子的解码时间与内存占用
      sampleRate: 8000,
    })
    wsRef.current = ws
    // 本组件永远不调用 play()，这行只是兜底：万一将来谁误加了播放调用，
    // 也不会立刻变成"双份声音"这种最难查的现象（CLAUDE.md D15）
    ws.setMuted(true)

    const offs: Array<() => void> = []

    offs.push(
      ws.on('loading', (percent: number) => {
        if (!deadRef.current) cbRef.current.onStatus({ kind: 'loading', percent })
      }),
    )

    offs.push(
      ws.on('ready', () => {
        if (deadRef.current) return
        readyRef.current = true
        applyZoom(ws, cbRef.current.pxPerSec)
        ws.setMuted(true) // 换源重载后再兜底一次，理由同上
        cbRef.current.onStatus({ kind: 'ready', durationMs: ws.getDuration() * 1000 })
        // 首次就绪时把滚动位置同步出去，覆盖层才知道自己该画哪一段
        cbRef.current.onScrollPx(ws.getScroll())
      }),
    )

    offs.push(
      ws.on('scroll', () => {
        if (!deadRef.current) cbRef.current.onScrollPx(ws.getScroll())
      }),
    )

    // 不订阅 timeupdate / play / pause / finish：那是"第二个时钟"的来源

    offs.push(
      ws.on('error', (err: Error) => {
        if (deadRef.current) return
        readyRef.current = false
        const list = cbRef.current.sources
        const next = srcIndexRef.current + 1
        if (next < list.length) {
          // 伴奏还没分离出来是常态，静默退到下一个候选，不打扰用户
          srcIndexRef.current = next
          void ws.load(list[next]).catch(() => undefined)
          return
        }
        cbRef.current.onStatus({
          kind: 'error',
          message: err?.message ? `音频加载失败：${err.message}` : '音频加载失败',
        })
      }),
    )

    return () => {
      deadRef.current = true
      readyRef.current = false
      for (const off of offs) off()
      // 卸载时若仍在解码，destroy 会抛 AbortError，属正常路径
      try {
        ws.destroy()
      } catch {
        /* 忽略卸载竞态 */
      }
      wsRef.current = null
    }
  }, [])

  // 音源变化（伴奏/原声切换、分离完成）
  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    readyRef.current = false
    srcIndexRef.current = 0
    const list = props.sources
    if (!list.length) {
      ws.empty()
      cbRef.current.onStatus({ kind: 'idle' })
      return
    }
    cbRef.current.onStatus({ kind: 'loading', percent: 0 })
    void ws.load(list[0]).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey])

  useEffect(() => {
    const ws = wsRef.current
    if (ws && readyRef.current) applyZoom(ws, props.pxPerSec)
  }, [props.pxPerSec])

  useEffect(() => {
    wsRef.current?.setOptions({ height: props.height })
  }, [props.height])

  return <div ref={containerRef} style={{ width: '100%', height: props.height }} />
})

/** zoom() 在音频未解码时会抛异常，统一在这里兜住 */
function applyZoom(ws: WaveSurfer, pxPerSec: number): void {
  try {
    ws.zoom(pxPerSec)
  } catch {
    /* 尚未解码完成，等 ready 回调里再来一次 */
  }
}

export default Waveform
