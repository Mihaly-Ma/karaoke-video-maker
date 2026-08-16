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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'

import { t } from '../i18n'

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
  /** 组件已卸载：wavesurfer 的异步回调必须靠它自我了断 */
  const deadRef = useRef(false)
  /**
   * 加载世代号，每发起一次 `load()` 就 +1。
   *
   * 它解决的是一类**会被误读成"音源坏了"的假失败**：`WaveSurfer.load()` 一进来就
   * `abortController.abort()` 掉上一次还在下载的 fetch，被中断的那次于是抛
   * AbortError（Chromium 报 "signal is aborted without reason"，WebKit 报
   * "Fetch is aborted"）。这条中断是**我们自己换音源造成的**，不代表那个 URL 有问题。
   *
   * 而换音源恰恰发生在每次进入编辑步骤的头几十毫秒：时间轴挂载后会把音源默认切到
   * 伴奏（`Timeline.tsx` 的"有伴奏就默认切过去"），此时第一条候选还在下载。
   * 早先把这次中断当成真失败，就会一路退候选、把整条候选链走穿，最后弹出
   * 「音频加载失败：signal is aborted without reason」—— 而用户随手换一次音源
   * 又"好了"（重新 load 一次，这回没有东西可中断），于是看起来像玄学。
   *
   * 用世代号而不是去认错误消息：中断的原因与措辞都属于实现细节，
   * "有没有更新的一次加载"才是判据。
   */
  const loadGenRef = useRef(0)

  // 回调每次渲染都可能是新函数。存进 ref，避免为了拿到最新回调而反复重建 wavesurfer
  const cbRef = useRef(props)
  cbRef.current = props

  const srcKey = props.sources.join('|')

  /**
   * 加载第 `index` 条候选，失败则顺延到下一条，全部失败才报错。
   *
   * 走 `load()` 返回的 promise 而不是 wavesurfer 的 `error` 事件：只有 promise
   * 能和"是哪一次加载"对上号（事件不带任何身份），而这个对应关系正是区分
   * "真失败"与"被自己中断"的唯一依据。`load()` 内部会先 emit `error` 再原样
   * 抛出，所以这条路径不会漏掉任何真实错误。
   */
  // 显式标注类型：函数体里递归引用了自己，不标注会让 TS 陷入循环推断
  const startLoad: (index: number) => void = useCallback((index: number): void => {
    const ws = wsRef.current
    const list = cbRef.current.sources
    const url = list[index]
    if (!ws || url === undefined) return
    const gen = ++loadGenRef.current
    cbRef.current.onStatus({ kind: 'loading', percent: 0 })
    void ws.load(url).catch((err: unknown) => {
      // 组件没了，或者这次加载已经被更新的一次取代——后者的"失败"就是新的 load()
      // 中断出来的，丢掉（见 loadGenRef 的说明）
      if (deadRef.current || gen !== loadGenRef.current) return
      readyRef.current = false
      if (index + 1 < list.length) {
        // 伴奏还没分离出来是常态，静默退到下一个候选，不打扰用户
        startLoad(index + 1)
        return
      }
      const message = err instanceof Error && err.message ? err.message : ''
      cbRef.current.onStatus({
        kind: 'error',
        message: message
          ? t('align.waveLoadFailedDetail', { detail: message })
          : t('align.waveLoadFailed'),
      })
    })
  }, [])

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
        /*
         * 就绪后把高度再喂一次。
         *
         * 实例是在容器刚挂上、还没分到最终高度时建的（那时 props.height 还是
         * 那个 96px 的下限），随后布局算完、ResizeObserver 把新高度传下来——
         * 但解码完成会重建波形画布，两件事谁先谁后不定，输给它的那一次
         * 就会留下一块只有下限高的波形。所以在这里按当前值再设一遍，
         * **偶发的"波形没占满"就是这个竞态**。
         */
        ws.setOptions({ height: cbRef.current.height })
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

    // 不订阅 timeupdate / play / pause / finish：那是"第二个时钟"的来源。
    //
    // **也不订阅 error**：那个事件不带"属于哪一次加载"的身份，无法区分真失败与
    // 换音源造成的中断（见 loadGenRef）。加载失败一律由 `startLoad` 里 `load()`
    // 的 promise 处理——`load()` 是先 emit error 再原样抛出，两者信息量相同。

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
    if (!props.sources.length) {
      // 空列表也要推进世代号：上一次加载若还在跑，它的失败已经与界面无关了
      loadGenRef.current++
      ws.empty()
      cbRef.current.onStatus({ kind: 'idle' })
      return
    }
    startLoad(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, startLoad])

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
