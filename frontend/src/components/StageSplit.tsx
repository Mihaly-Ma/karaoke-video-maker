import { useCallback, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'

import { t } from '../i18n'

/**
 * 两栏 + 可拖分割条的舞台容器。**上下、左右两种方向共用同一份实现**。
 *
 * 编辑舞台同时用到两个方向：外层上下分「工作区 / 时间轴」，内层左右分
 * 「画面 / 歌词正文」。写成两个组件的话，localStorage 读写、夹取下限、
 * 键盘通路、拖动中禁选中这四件事要各维护一遍——它们和方向没有关系。
 *
 * 方向只影响三处：量的是 `clientHeight` 还是 `clientWidth`、跟的是 `clientY`
 * 还是 `clientX`、`flex-direction` 是 column 还是 row。
 *
 * ## 比例为什么落在 localStorage 而不是工程文件
 *
 * 分割位置是**视图偏好**，不是工程数据：同一个工程换台机器、换个屏幕尺寸，
 * 合适的分割位置本就不同，把它写进 `project.json` 只会让工程文件在没有任何
 * 实质修改时变脏，还要占一格撤销历史。
 *
 * ## 为什么用 flex-grow 分配而不是给两栏各写百分比
 *
 * 分割条自己也占尺寸，写百分比就得在 calc 里把它减掉，比例一改要同步改两处。
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

export type SplitDirection = 'vertical' | 'horizontal'

export interface StageSplitProps {
  /** localStorage 键。不同舞台、不同方向各记各的 */
  storageKey: string
  /**
   * 分割方向。`vertical`（默认）= 上下分，`horizontal` = 左右分。
   * 说的是**两栏怎么排**，不是分割条自己的朝向——后者恰好相反，见下面的 aria。
   */
  direction?: SplitDirection
  /** 第一栏（上 / 左）的默认占比（0–1） */
  defaultTop: number
  /** 第一栏（上 / 左）、第二栏（下 / 右）的内容 */
  top: ReactNode
  bottom: ReactNode
  /** 附加在两栏上的类名，用于让各舞台自己决定内边距、背景、滚动 */
  topClassName?: string
  bottomClassName?: string
  /**
   * 两栏各自的最小像素尺寸。拖到底也要给两栏各留一点，否则会出现
   * "拖没了就再也抓不回来"的死角。
   *
   * 左右分割时这个值是硬需求而不是保险：画面那一栏装着走带控件条，
   * 实测第一排（播放 + 时钟 + 总时长 + 进度条）要 312px 才不折行，
   * 再窄下去省的是宽度、赔的是高度。
   */
  minTopPx?: number
  minBottomPx?: number
}

/** 键盘每次调整的幅度。方向键要能微调，2% 在 850px 的舞台上约合 17px */
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
  direction = 'vertical',
  defaultTop,
  top,
  bottom,
  topClassName,
  bottomClassName,
  minTopPx = 120,
  minBottomPx = 160,
}: StageSplitProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => readRatio(storageKey, defaultTop))
  const [dragging, setDragging] = useState(false)
  const horizontal = direction === 'horizontal'

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
   * 把比例夹进"两栏都还剩得下最小尺寸"的区间。
   * 舞台太小以致两个下限同时满足不了时退回一半——此时 CSS 的 min-* 会接手，
   * 再纠结精确比例没有意义。
   */
  const clamp = useCallback(
    (v: number) => {
      const el = rootRef.current
      const total = (horizontal ? el?.clientWidth : el?.clientHeight) ?? 0
      if (total <= 0) return v
      const lo = minTopPx / total
      const hi = 1 - minBottomPx / total
      if (lo > hi) return 0.5
      return Math.min(hi, Math.max(lo, v))
    },
    [horizontal, minTopPx, minBottomPx],
  )

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
      if (!r) return
      const total = horizontal ? r.width : r.height
      if (total <= 0) return
      const pos = horizontal ? e.clientX - r.left : e.clientY - r.top
      setRatio(clamp(pos / total))
    },
    [dragging, clamp, horizontal],
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
      data-dir={direction}
      style={vars}
    >
      <div className={`stage-split__pane stage-split__pane--top${topClassName ? ` ${topClassName}` : ''}`}>
        {top}
      </div>

      {/*
        role=separator + aria-valuenow 是 WAI-ARIA 给窗格分割条定的角色，
        让读屏软件报得出"现在分到几成"；tabIndex 让它能用方向键调，
        拖动之外必须留一条键盘通路。

        `aria-orientation` 说的是**分割条自己的朝向**，与两栏的排布方向相反：
        上下分栏用的是一条横着的分割条。
      */}
      <div
        className="stage-split__bar"
        data-role="split-bar"
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={t(horizontal ? 'align.sideDivider' : 'align.paneDivider')}
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
          const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
          const fwd = horizontal ? 'ArrowRight' : 'ArrowDown'
          if (e.key === back) {
            e.preventDefault()
            nudge(-KEY_STEP)
          } else if (e.key === fwd) {
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
