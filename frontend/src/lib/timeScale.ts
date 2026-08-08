/**
 * 时间轴的「时间 ↔ 像素」换算、缩放与刻度生成。
 *
 * 这个模块**不认识工程数据**，只做纯几何换算 —— 这样波形层、覆盖层、
 * 概览条三处才可能用完全一致的坐标系，不会出现「波形和方块差半个字」这种
 * 只能靠肉眼发现的错位。
 *
 * ## 两套时间基准（全项目统一，不要混用）
 *
 * - **工程时间（project ms）**：`Token.start_ms` / `dur_ms` 所在的基准。
 * - **音频时间（audio ms）**：波形、播放头、`<video>.currentTime` 所在的基准。
 *
 * 两者相差 `Project.global_offset_ms`。整体调轴改的就是这个偏移量，
 * **不是逐个 token 的时间**，所以用户随时可以归零重来（CLAUDE.md §5.8「全局 offset 旋钮」）。
 * `projectStore.locate()` 用的也是同一约定（`t = playheadMs - global_offset_ms`）。
 */

/** 最小缩放：1 px/s 时 5 分钟的曲子只有 300px，够做整曲概览 */
export const MIN_PX_PER_SEC = 1
/** 最大缩放：1200 px/s ≈ 1.2 px/ms，一个 200ms 的音节有 240px 宽，足够单字级微调 */
export const MAX_PX_PER_SEC = 1200
/** 一次滚轮/按键缩放的倍率 */
export const ZOOM_FACTOR = 1.4

export interface TimeScale {
  /** 每秒对应多少像素，是缩放的唯一状态量 */
  readonly pxPerSec: number
  readonly pxPerMs: number
  msToPx(ms: number): number
  pxToMs(px: number): number
  /** 时长转宽度。极短 token 也要保证 minPx 的可点击宽度，否则用户根本抓不住它 */
  durToPx(durMs: number, minPx?: number): number
}

export function createScale(pxPerSec: number): TimeScale {
  const pxPerMs = pxPerSec / 1000
  return {
    pxPerSec,
    pxPerMs,
    msToPx: (ms) => ms * pxPerMs,
    pxToMs: (px) => px / pxPerMs,
    durToPx: (durMs, minPx = 3) => Math.max(minPx, durMs * pxPerMs),
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 工程时间 → 音频时间 */
export const toAudioMs = (projectMs: number, globalOffsetMs: number): number => projectMs + globalOffsetMs

/** 音频时间 → 工程时间 */
export const toProjectMs = (audioMs: number, globalOffsetMs: number): number => audioMs - globalOffsetMs

/** 整曲刚好铺满视口时的缩放。它同时是缩放下限——再往外缩只会留白 */
export function fitPxPerSec(durationMs: number, viewportPx: number): number {
  if (durationMs <= 0 || viewportPx <= 0) return 20
  return clamp((viewportPx / durationMs) * 1000, MIN_PX_PER_SEC, MAX_PX_PER_SEC)
}

export function clampPxPerSec(pxPerSec: number, minAllowed = MIN_PX_PER_SEC): number {
  return clamp(pxPerSec, Math.max(MIN_PX_PER_SEC, minAllowed), MAX_PX_PER_SEC)
}

/** dir > 0 放大，dir < 0 缩小 */
export function stepZoom(pxPerSec: number, dir: number, minAllowed = MIN_PX_PER_SEC): number {
  const next = dir > 0 ? pxPerSec * ZOOM_FACTOR : pxPerSec / ZOOM_FACTOR
  return clampPxPerSec(next, minAllowed)
}

/** 内容总宽度。fillParent 语义下不会窄于视口 */
export function contentWidthPx(durationMs: number, scale: TimeScale, viewportPx: number): number {
  return Math.max(viewportPx, scale.msToPx(durationMs))
}

export function clampScroll(scrollPx: number, viewportPx: number, contentPx: number): number {
  return clamp(scrollPx, 0, Math.max(0, contentPx - viewportPx))
}

/**
 * 缩放时保持视口内某个锚点不动。
 * `anchorPx` 是相对视口左沿的像素（鼠标位置或播放头位置）。
 * 不做这件事的话，用滚轮放大会让用户正在看的那一段跑出屏幕。
 */
export function zoomAroundAnchor(
  anchorPx: number,
  oldScrollPx: number,
  oldScale: TimeScale,
  newScale: TimeScale,
): number {
  const anchorMs = oldScale.pxToMs(oldScrollPx + anchorPx)
  return newScale.msToPx(anchorMs) - anchorPx
}

/** 把某个时刻滚到视口正中所需的 scrollLeft */
export function scrollToCenter(ms: number, viewportPx: number, scale: TimeScale): number {
  return scale.msToPx(ms) - viewportPx / 2
}

export interface VisibleRange {
  startMs: number
  endMs: number
}

/**
 * 当前可见的时间区间。`padMs` 用来预渲染视口外一小段，
 * 滚动时才不会出现方块「追不上」的空白（CLAUDE.md §5.10 要求 region 虚拟化：
 * 一首歌几百个音节，全部实例化会卡死）。
 */
export function visibleRangeMs(
  scrollPx: number,
  viewportPx: number,
  scale: TimeScale,
  padMs = 0,
): VisibleRange {
  return {
    startMs: scale.pxToMs(scrollPx) - padMs,
    endMs: scale.pxToMs(scrollPx + viewportPx) + padMs,
  }
}

/** 刻度阶梯：只用这些「整数感」的间隔，避免出现 137ms 这种读不出来的刻度 */
const TICK_LADDER_MS = [
  10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
]

export interface Tick {
  ms: number
  px: number
  major: boolean
  /** 只有主刻度带文字 */
  label: string | null
}

/**
 * 生成 [startMs, endMs] 区间内的刻度。
 * `minMajorPx` 是两个主刻度之间的最小像素距离，决定文字会不会挤在一起。
 */
export function buildTicks(
  startMs: number,
  endMs: number,
  scale: TimeScale,
  minMajorPx = 88,
): Tick[] {
  const major =
    TICK_LADDER_MS.find((s) => s * scale.pxPerMs >= minMajorPx) ??
    TICK_LADDER_MS[TICK_LADDER_MS.length - 1]
  const minorCandidate = major / 5
  // 次刻度密到画出来是一片灰就别画了
  const step = minorCandidate * scale.pxPerMs >= 7 ? minorCandidate : major

  const out: Tick[] = []
  const from = Math.floor(Math.max(0, startMs) / step) * step
  const withMillis = major < 1000
  for (let ms = from; ms <= endMs; ms += step) {
    const isMajor = ms % major === 0
    out.push({
      ms,
      px: scale.msToPx(ms),
      major: isMajor,
      label: isMajor ? formatMs(ms, withMillis) : null,
    })
    // 安全阀：任何参数组合下都不允许生成到卡死浏览器
    if (out.length > 3000) break
  }
  return out
}

/** `1:23` / `1:23.456` */
export function formatMs(ms: number, withMillis = false): string {
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(Math.round(ms))
  const m = Math.floor(abs / 60_000)
  const s = Math.floor((abs % 60_000) / 1000)
  const base = `${sign}${m}:${String(s).padStart(2, '0')}`
  return withMillis ? `${base}.${String(abs % 1000).padStart(3, '0')}` : base
}

/** `+120ms` / `-30ms`，用于偏移量与拖动增量 */
export function formatDeltaMs(ms: number): string {
  const v = Math.round(ms)
  return `${v >= 0 ? '+' : ''}${v}ms`
}

/** 磁吸到固定步长（方向键微调、按帧对齐都用它） */
export function snapMs(ms: number, stepMs: number): number {
  if (stepMs <= 0) return Math.round(ms)
  return Math.round(ms / stepMs) * stepMs
}
