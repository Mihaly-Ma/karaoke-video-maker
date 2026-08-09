import { useCallback, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'

import { t } from '../i18n'

/**
 * 上下两栏 + 可拖分割条的舞台容器。
 *
 * 对轴舞台用它分「画面 / 波形」（docs/ui-redesign.md §四 对轴）。规格要求默认
 * **波形占更大比例**——实际工作发生在波形上，画面只用于随时确认观感，
 * 所以 `defaultTop` 给的是画面那一侧，默认小于一半。
 *
 * ## 比例为什么落在 localStorage 而不是工程文件
 *
 * 分割位置是**视图偏好**，不是工程数据：同一个工程换台机器、换个屏幕尺寸，
 * 合适的分割位置本就不同，把它写进 `project.json` 只会让工程文件在没有任何
 * 实质修改时变脏，还要占一格撤销历史。
 *
 * ## 为什么用 flex-grow 分配而不是给两栏各写百分比高度
 *
 * 分割条自己也占高度，写百分比就得在 calc 里把它减掉，比例一改要同步改两处。
 * `flex-basis: 0` 让分割条先取走自己那几像素，剩余空间再严格按 grow 比例分。
 *
 * 注意 grow 因子传的是 **0–100 的数**而不是 0–1 的小数：CSS 规定 grow 因子之和
 * 小于 1 时剩余空间只按该比例分掉一部分，写 0.42 / 0.58 会留下一条分不掉的空隙。
 */

/** 两栏的 grow 因子经由自定义属性下发，声明成 CSSProperties 的扩展以免用 any 断言 */
interface SplitVars extends CSSProperties {
  '--split-top': number
  '--split-bottom': number
}

export interface StageSplitProps {
  /** localStorage 键。不同舞台各记各的 */
  storageKey: string
  /** 上栏默认占比（0–1）。对轴舞台传 0.42，让波形拿到更大的一半 */
  defaultTop: number
  /** 上/下栏内容 */
  top: ReactNode
  bottom: ReactNode
  /** 附加在两栏上的类名，用于让各舞台自己决定内边距、背景、滚动 */
  topClassName?: string
  bottomClassName?: string
}

/** 拖到底也要给两栏各留一点，否则会出现"拖没了就再也抓不回来"的死角 */
const MIN_TOP_PX = 120
const MIN_BOTTOM_PX = 160
/** 键盘每次调整的幅度。方向键要能微调，2% 在 850px 高的舞台上约合 17px */
const KEY_STEP = 0.02

function readRatio(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const v = Number(raw)
    return Number.isFinite(v) && v > 0 && v < 1 ? v : fallback
  } catch {
    // 隐私模式下读不到 localStorage。取不到偏好不该让舞台起不来
    return fallback
  }
}

export default function StageSplit({
  storageKey,
  defaultTop,
  top,
  bottom,
  topClassName,
  bottomClassName,
}: StageSplitProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => readRatio(storageKey, defaultTop))
  const [dragging, setDragging] = useState(false)

  const persist = useCallback(
    (v: number) => {
      try {
        localStorage.setItem(storageKey, v.toFixed(4))
      } catch {
        // 写不进去就只在本次会话里生效，不值得为此打断拖动
      }
    },
    [storageKey],
  )

  /**
   * 把比例夹进"两栏都还剩得下最小高度"的区间。
   * 舞台太矮以致两个下限同时满足不了时退回一半——此时 CSS 的 min-height 会接手，
   * 再纠结精确比例没有意义。
   */
  const clamp = useCallback((v: number) => {
    const h = rootRef.current?.clientHeight ?? 0
    if (h <= 0) return v
    const lo = MIN_TOP_PX / h
    const hi = 1 - MIN_BOTTOM_PX / h
    if (lo > hi) return 0.5
    return Math.min(hi, Math.max(lo, v))
  }, [])

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    // 阻止默认行为，否则拖过文字会顺带选中一片
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }, [])

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      const r = rootRef.current?.getBoundingClientRect()
      if (!r || r.height <= 0) return
      setRatio(clamp((e.clientY - r.top) / r.height))
    },
    [dragging, clamp],
  )

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      e.currentTarget.releasePointerCapture(e.pointerId)
      setDragging(false)
      // 只在松手时落盘：拖动过程中每帧写一次 localStorage 是同步 IO，会把拖动拖卡
      persist(ratio)
    },
    [dragging, persist, ratio],
  )

  const nudge = useCallback(
    (delta: number) => {
      const next = clamp(ratio + delta)
      setRatio(next)
      persist(next)
    },
    [clamp, ratio, persist],
  )

  const reset = useCallback(() => {
    const next = clamp(defaultTop)
    setRatio(next)
    persist(next)
  }, [clamp, defaultTop, persist])

  const vars: SplitVars = { '--split-top': ratio * 100, '--split-bottom': (1 - ratio) * 100 }

  return (
    <div
      ref={rootRef}
      className={`stage-split${dragging ? ' stage-split--dragging' : ''}`}
      style={vars}
    >
      <div className={`stage-split__pane stage-split__pane--top${topClassName ? ` ${topClassName}` : ''}`}>
        {top}
      </div>

      {/*
        role=separator + aria-valuenow 是 WAI-ARIA 给窗格分割条定的角色，
        让读屏软件报得出"现在分到几成"；tabIndex 让它能用方向键调，
        拖动之外必须留一条键盘通路。
      */}
      <div
        className="stage-split__bar"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('align.paneDivider')}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        title={t('align.paneDividerHint')}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            nudge(-KEY_STEP)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(KEY_STEP)
          }
        }}
      />

      <div className={`stage-split__pane stage-split__pane--bottom${bottomClassName ? ` ${bottomClassName}` : ''}`}>
        {bottom}
      </div>
    </div>
  )
}
