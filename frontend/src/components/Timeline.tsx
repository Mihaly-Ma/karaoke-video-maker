/**
 * 三级调轴时间轴 —— 本工具的核心界面。
 *
 * CLAUDE.md §2.5：**自动化可以打折，一站式不能**。所以这个组件的验收标准不是
 * 「自动对齐跑完之后能微调」，而是**哪怕自动对齐完全不可用，用户也能从零打完一首歌**。
 * 由此推出下面几条设计：
 *
 * ## 三级调轴（§1「三级调轴 UI 就是核心功能」）
 *
 * | 级别 | 交互 | 落到哪里 |
 * |---|---|---|
 * | 整体 | 工具条上的「整曲偏移」（`EditOffset`） | `project.global_offset_ms`，**不动任何 token** |
 * | 单句 | 拖逐字轴顶上的「句柄条」，或选中行后按方向键 | `shift(scope='line')` |
 * | 单词 | 拖「逐字轴」上的 token 本体或它的左右边界 | `shift(scope='token')` / `setTiming` |
 *
 * 整体偏移刻意不写进 token 时间：写进去就再也回不来了，而重锚定（§5.3）本身
 * 是个高不确定性的自动环节，用户必须能随时归零重来。它曾经是工具条下的一整条
 * 横带，挤掉的正是逐字轴；后来搬去舞台左栏，又和画面一起在那儿空占一大片。
 * 现在收进工具条右段，与缩放/整曲这些**同样作用于全曲**的控件放在一起，
 * 而按字平移留在底栏检查器——两级调轴按作用范围分处时间轴的一头一尾。
 *
 * ## 时间轴上不画句子文本
 *
 * 曾经有一条「行轨」压在波形顶部 45px，把每句歌词的**文本**画出来。同一句
 * 在右侧歌词正文里本来就整屏摆着，波形上再画一遍既是重复、又盖住了真正要对的
 * 能量曲线。现在句子层收敛成两处**不含文本**的标记：
 *
 * - **句柄条**：逐字轴顶上一条 22px 的窄带，只画当前行的跨度 + 行号（与正文左侧
 *   同一个数），拖它 = 整句平移
 * - **概览条**：全曲每句一个小块，当前行强调色、正在唱的那句带播放色描边，
 *   点它就切到那一句
 *
 * ## 逐字轴是主角，不是波形上的一条压边
 *
 * 它从波形覆盖层里挪了出来，独占波形下方一条 78px 的轨道：**块宽严格等于该字时长**，
 * 底色与底边取来源语义色，**字与字之间的空隙画成斜纹**——句内空隙是真实存在的
 * （唱完这个字到下个字之间的静默），把它画成"什么都没有"会让人误以为轴是连续的，
 * 一拖边界就把静默吃掉。
 *
 * ## tap-to-time 是一等公民，不是降级方案
 *
 * 摆在工具栏第一排，按 `T` 直接进入。空格/回车逐字打点、退格回退上一个点、
 * 点任意字即可从那里开始打。**打点面板按「字的顺序」排列而不是按时间位置排列**——
 * 纯文本歌词刚导入时所有 token 时间都是 0，按时间摆的话它们全叠在原点，
 * 那个界面根本没法用，而这恰恰是「从零打完一首歌」的起点。
 *
 * ## 来源可见（§4.4 / §7.4）
 *
 * 每个 token 按 `timing_source` 着色：`interpolated`（插值推算，最不可信）加斜纹，
 * `unset`（还没打过轴）用中性灰 + 虚线边框，另有一枚常驻的「尚未打轴 N/M 字」徽标。
 * 用户需要知道该复核哪几个字、还差多少字没打，而不是面对一堆看起来同样自信的数字
 * 逐个核对。
 *
 * ## 时间从哪来：没有自己的播放器
 *
 * 播放位置、播放状态、试听速率全部来自 store，唯一写入者是 `Preview.tsx`
 * （CLAUDE.md D15：Web Audio 主时钟 + `<video>` 从动）。本组件只做两件事：
 * 读播放头来画播放头标记、跟随滚动、取打点时间；把用户的播放/暂停/跳转/变速
 * **意图**写回 store。波形层曾经自带一份时钟并把结果写回 store，与预览层互相追时间，
 * 表现为播放头抖动 —— 不要恢复那条路。
 *
 * **走带控件（播放/暂停按钮、时钟、进度条）也不在这里**：docs/ui-redesign.md §五
 * 要求同一时刻界面上只存在一个 transport，而对轴舞台的那一个在 `Preview` 上 ——
 * 它是完整走带（播放 + 时钟 + 拖动进度 + 原声/伴奏 + 音量），也正是执行者本身。
 * 这里只保留预览层没有、但打轴离不开的**变速**（§5.10：0.5~0.75x 打点）。
 * 空格键仍然由本组件独占，见下方 `keyRef`。
 *
 * ## 跟手
 *
 * 编辑要往后端发请求，因此拖动全程只改本地预览状态，**松手才提交**；
 * 打轴的一串点也先攒在本地草稿里，暂停 / 退出 / 手动提交时才落库。
 * 所有请求排成一条串行队列 —— 每个编辑接口都返回整份工程，并发发出去的话
 * 后到的旧响应会把新改动覆盖掉。
 */

import {
  ColumnWidthOutlined,
  FieldTimeOutlined,
  LinkOutlined,
  LockOutlined,
  MergeCellsOutlined,
  ScissorOutlined,
  UndoOutlined,
  VerticalAlignMiddleOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

import * as api from '../api/client'
import type { Line, Token } from '../api/types'
import { t } from '../i18n'
import { locateLineId, useProject } from '../state/projectStore'
import {
  buildTicks,
  clamp,
  clampPxPerSec,
  clampScroll,
  contentWidthPx,
  createScale,
  fitPxPerSec,
  formatDeltaMs,
  formatMs,
  scrollToCenter,
  stepZoom,
  toAudioMs,
  toProjectMs,
  visibleRangeMs,
} from '../lib/timeScale'
import EditOffset from './EditOffset'
import { Waveform } from './Waveform'
import type { WaveformHandle, WaveformStatus } from './Waveform'

// ---------------------------------------------------------------- 常量

const RULER_H = 22
/**
 * 波形高度**不是常数**：刻度、逐字轴、概览、工具条、图例都是定高的，
 * 波形吃掉时间轴里剩下的全部空间。所以把上下分割条往上拖，波形就跟着长高，
 * 而不是在下面留一片没人用的空白。
 *
 * 只保留一个下限：低于这个数波形就只剩一条糊线，读不出能量突变，
 * 而"对着能量突变去拖边界"正是这一步的干活方式。首帧还没量到尺寸时用它兜底。
 */
const MIN_WAVE_H = 96
/**
 * 首次拿到真实时长后落在哪个缩放上：视口内摆得下这么多秒。
 *
 * 以前是缩到**整曲铺满**（"先看清全局再往下钻"）。整曲铺满意味着 0.006 px/ms，
 * 一个 300ms 的字只有 1.7px，被最小可点击宽度顶成一根 6px 的针 ——
 * 逐字轴一进来就是一排看不出长短的竖条，等于没有。全局导航有底下的概览条
 * 和「整曲」按钮，主轨的默认缩放应该服务于**这一步真正要干的事**。
 *
 * 10 秒约合一到两句歌词：1580px 视口下 158 px/s，300ms 的字有 47px 宽，
 * 字与起点时间都读得出来。
 */
const INITIAL_WINDOW_SEC = 10
/**
 * 句柄条：逐字轴顶上的一条窄带，只画**当前行**的时间跨度，内容只有行号。
 *
 * 它接手了原「行轨」的单句级调轴（拖它 = 整句平移）。原行轨把整句歌词文本
 * 画在波形上，而同一句在右侧歌词正文里本来就有——**同一份信息在两处各画一遍，
 * 且在波形上盖掉了真正要对的能量曲线**。行号是"这段属于哪句"所需的最小信息，
 * 与正文左侧的行号是同一个数，扫一眼就能对上，不必再把句子搬过来。
 */
const LINE_HANDLE_H = 22
/**
 * 逐字块的高度。它是这一步的主对象，给的高度要装得下**一个成人字号的字 + 起点时间**，
 * 而不是压成波形底下的一条边——78px 下字号可以给到 --fs-xl，扫一眼就读得出是哪个字。
 */
const TOKEN_BLOCK_H = 78
const TOKEN_RAIL_H = LINE_HANDLE_H + TOKEN_BLOCK_H
const OVERVIEW_H = 26

/** 任何编辑都不许把 token 拖成 0 时长：零时长音节会触发 libass #124（§5.7） */
const MIN_TOKEN_DUR_MS = 20
/** 打点时先给当前字一个临时时长，下一次打点会把它改写成真实值 */
const TAP_PROVISIONAL_DUR_MS = 300
/** 跨句打点时上一句末字的收尾上限 —— 否则它会一路拖过整段间奏 */
const TAP_MAX_TAIL_MS = 1500

const NUDGE_MS = 10
/** Shift+方向键 = 1 帧（按 30fps 估算） */
const NUDGE_FRAME_MS = 33
const NUDGE_FINE_MS = 1

/** 试听速率的档位。§5.10 建议 0.5~0.75x 打点，1.0x 用来核对整体观感 */
const RATE_OPTIONS = [0.5, 0.75, 1] as const

/** 波形可以画哪几条轨。顺序按"原曲 → 拆出来的两条"，与分离流程的先后一致 */
const WAVE_SOURCES = ['audio', 'instrumental', 'vocals'] as const

export interface SourceMeta {
  /** 文案键。存键而不是存句子：模块级常量在 import 时求值，存句子等于把语言钉死 */
  labelKey: string
  hintKey: string
  /** 全部取自 styles.css 的 `--src-*` 语义色，是界面上唯一允许的高饱和用法（§7.4） */
  color: string
  /** 斜纹填充，用来标「算出来的、不可信的」 */
  hatch: boolean
  /** 虚线边框，用来标「这里还是空的」 */
  dashed: boolean
}

/**
 * `unset` 排在最前面：它不是一种「时间来源」，而是**还没有时间**。
 * 纯文本导入后整首歌都是这个状态，正是 tap-to-time 的目标，
 * 所以给弱文字灰 + 虚线边框（看着就像个待填的空框），图例里还带未打轴字数。
 *
 * 另外四种**必须**分别用 `--src-provider` / `--src-aligned` / `--src-interp` /
 * `--src-manual`：这四个 token 是全应用共享的来源语义色，注音舞台、歌词舞台读的
 * 是同一份。这里另起一套色相，就等于同一个「插值」在两个界面上是两个颜色。
 * 也不要给 `unset` 复用 `manual` 的紫色 —— 那表示用户确实调过，
 * 混用会让人以为这个 0 是他认可的。
 */
export const SOURCE_META: Record<Token['timing_source'], SourceMeta> = {
  unset: {
    labelKey: 'align.sourceUnset',
    color: 'var(--fg-3)',
    hintKey: 'align.hintUnset',
    hatch: false,
    dashed: true,
  },
  provider: {
    labelKey: 'source.provider',
    color: 'var(--src-provider)',
    hintKey: 'align.hintProvider',
    hatch: false,
    dashed: false,
  },
  aligned: {
    labelKey: 'source.aligned',
    color: 'var(--src-aligned)',
    hintKey: 'align.hintAligned',
    hatch: false,
    dashed: false,
  },
  interpolated: {
    labelKey: 'source.interpolated',
    color: 'var(--src-interp)',
    hintKey: 'align.hintInterpolated',
    hatch: true,
    dashed: false,
  },
  manual: {
    labelKey: 'source.manual',
    color: 'var(--src-manual)',
    hintKey: 'align.hintManual',
    hatch: false,
    dashed: false,
  },
}

/**
 * 本组件的局部 CSS。
 *
 * **不再重复定义按钮/输入框的皮肤** —— `styles.css` 已经给 `button` / `select` /
 * `input` 定了一套，这里只留时间轴独有的东西（绝对定位的块、拖拽把手、脉冲动画）。
 * 原先那份 `.kvm-tl button { background:#243244 … }` 正是 docs/ui-redesign.md §六点五
 * 说的「六套并行样式系统」之一：它让工具条按钮和外壳按钮长得不一样，且各自维护。
 */
const CSS = `
.kvm-tl { color:var(--fg); font-size:var(--fs-sm); user-select:none; }
/* 只覆盖尺寸与图标对齐，配色一律继承 styles.css 的 button 规则 */
.kvm-tl button { display:inline-flex; align-items:center; justify-content:center; gap:var(--sp-1);
  padding:var(--sp-1) var(--sp-2); border-radius:var(--r-sm);
  /*
   * 触点下限。纯图标按钮没有文字撑高，早先实测只有 30×22 —— 图标化省下来的
   * 横向空间不该拿可点性去换，所以这里把两个方向都钉到 28px。
   */
  min-height:28px; min-width:28px; }
.kvm-tl button[data-on="1"] { background:var(--accent-weak); border-color:var(--accent); color:var(--fg); }
/*
 * 按钮式 radio（一组并排按钮，选中的那个高亮）。
 *
 * **本舞台不用下拉框。** 这里的选择项都是三五个的小集合，而下拉框要点开才知道
 * 有哪些选项、选完还得再点开一次才能确认当前值；摊开来是一眼可见 + 一次点击。
 *
 * 用真的 <input type=radio> 包在 <label> 里而不是拿 <button> 拼一组：单一 tab 停靠点、
 * 与读屏软件的 radio 语义是白送的。**但方向键切换不能指望浏览器** ——
 * Chromium 有、WebKit 实测没有，所以另外自己实现了一份（见 JSX 里的 onKeyDown）。
 */
.kvm-tl-seg { display:inline-flex; gap:2px; }
.kvm-tl-seg label { position:relative; display:inline-flex; align-items:center;
  padding:var(--sp-1) var(--sp-2); border:var(--hairline); border-radius:var(--r-sm);
  color:var(--fg-2); cursor:pointer; white-space:nowrap; font-variant-numeric:tabular-nums; }
.kvm-tl-seg label[data-on] { background:var(--accent-weak); border-color:var(--accent); color:var(--fg); }
/* 原生 radio 藏起来但**保留可聚焦**：opacity:0 而不是 display:none */
.kvm-tl-seg input { position:absolute; inset:0; width:100%; height:100%; opacity:0; margin:0; cursor:pointer; }
/* 焦点态必须看得见，否则键盘用户不知道方向键正在动谁 */
.kvm-tl-seg label:has(input:focus-visible) { outline:2px solid var(--accent); outline-offset:1px; }
.kvm-tl input[type=number] { width:74px; padding:2px var(--sp-2); border-radius:var(--r-sm);
  font-variant-numeric:tabular-nums; }
.kvm-tl-tok { position:absolute; box-sizing:border-box; border-radius:var(--r-sm) var(--r-sm) 0 0;
  overflow:hidden; cursor:grab; display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:2px; }
.kvm-tl-tok:hover { filter:brightness(1.3); }
.kvm-tl-tok:active { cursor:grabbing; }
/* 句内空隙：真实存在的静默，画成斜纹而不是留白，免得被当成"轴是连着的" */
.kvm-tl-gap { position:absolute; box-sizing:border-box; pointer-events:none;
  background:repeating-linear-gradient(45deg,
    color-mix(in srgb, var(--fg-3) 26%, transparent) 0 4px,
    transparent 4px 9px); }
.kvm-tl-hnd { position:absolute; top:0; bottom:0; width:9px; cursor:ew-resize; z-index:2; }
.kvm-tl-hnd:hover { background:color-mix(in srgb, var(--fg) 45%, transparent); }
/*
 * 句柄条（单句级调轴）。**不画句子文本，只画行号** —— 句子在右侧正文里，
 * 搬到波形上只会盖住能量曲线并且和正文说两遍同一件事。
 */
.kvm-tl-lh { position:absolute; box-sizing:border-box; display:flex; align-items:center;
  gap:var(--sp-1); padding:0 var(--sp-1); border-radius:var(--r-sm) var(--r-sm) 0 0;
  cursor:grab; white-space:nowrap; overflow:hidden;
  background:color-mix(in srgb, var(--accent) 26%, transparent);
  border:1px solid var(--accent); border-bottom:none;
  font-size:var(--fs-xs); color:var(--fg); }
.kvm-tl-lh:hover { filter:brightness(1.25); }
.kvm-tl-lh:active { cursor:grabbing; }
.kvm-tl-lh[data-playing] { box-shadow:inset 3px 0 0 var(--danger); }
/* 概览条上的每一句。点它 = 选中该行，于是逐字轴切过去 —— 行轨拆掉后，
   "在时间轴上换一句"的入口收在这里，且它是全曲尺度、比原先只能看到视口内几行更全 */
.kvm-tl-ov { position:absolute; box-sizing:border-box; border-radius:var(--r-sm); cursor:pointer; }
.kvm-tl-ov:hover { filter:brightness(1.4); }
.kvm-tl-next { animation:kvm-tl-pulse 1.1s ease-in-out infinite; }
@keyframes kvm-tl-pulse {
  0%,100% { box-shadow:0 0 0 0 color-mix(in srgb, var(--warn) 85%, transparent); }
  50%     { box-shadow:0 0 0 var(--sp-2) transparent; }
}
.kvm-tl-chip { border:var(--hairline-strong); background:var(--bg-surface); border-radius:var(--r-md);
  padding:var(--sp-1) var(--sp-2); min-width:32px; text-align:center; cursor:pointer; }
.kvm-tl-chip:hover { background:var(--bg-raise); }
`

// ---------------------------------------------------------------- 小工具

const tokenKey = (lineId: string, index: number): string => `${lineId}#${index}`

interface Timing {
  start: number
  dur: number
}

interface DragConfig {
  kind: 'line' | 'token-move' | 'token-start' | 'token-end'
  lineId: string
  index: number
  startClientX: number
  pxPerMs: number
  minDelta: number
  maxDelta: number
  /** 与相邻 token 严丝合缝：拖边界要连带改邻居，否则会拉出缝隙或造成重叠 */
  linked: boolean
}

interface FlatRef {
  lineIndex: number
  tokenIndex: number
  lineId: string
}

function lineBounds(line: Line): Timing {
  if (!line.tokens.length) return { start: 0, dur: 0 }
  const first = line.tokens[0]
  const last = line.tokens[line.tokens.length - 1]
  return { start: first.start_ms, dur: last.start_ms + last.dur_ms - first.start_ms }
}

function lineText(line: Line): string {
  return line.tokens.map((t) => t.text).join('')
}

/**
 * 半透明化。来源色现在是 `var(--src-*)`，拼 `#rrggbb` + alpha 后缀那一套失效了
 * （变量的值在 JS 侧不可见），改用 `color-mix` —— styles.css 本身也用它。
 */
const tint = (color: string, pct: number): string =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`

/**
 * token 底色。插值推算加斜纹：只靠色相区分，扫一眼很容易漏掉最不可信的那一类；
 * 未打轴的填色压到最淡，配上虚线边框读起来就是「一个还没填的空框」。
 * 斜纹的 5px/10px 是图案几何，不是间距，因此不走 `--sp-*`。
 */
function blockBg(meta: SourceMeta, drafted: boolean): string {
  const { color } = meta
  if (meta.hatch && !drafted) {
    return `repeating-linear-gradient(45deg, ${tint(color, 40)} 0 5px, ${tint(color, 12)} 5px 10px)`
  }
  if (meta.dashed && !drafted) return tint(color, 12)
  return tint(color, drafted ? 46 : 32)
}

// ---------------------------------------------------------------- 组件

export function Timeline() {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const storeError = useProject((s) => s.error)
  // 播放状态与速率都是 Preview 的（唯一时钟，见 projectStore 文件头）：
  // 这里只负责显示按钮状态、以及把用户的播放/变速意图写进去
  const playing = useProject((s) => s.playing)
  const rate = useProject((s) => s.playbackRate)
  /**
   * 「跟随」是全舞台一个开关（store），不是波形自己的本地状态：
   * 歌词正文也要跟着播放头滚，两处各存一份就会变成两个都叫「跟随」的按钮。
   */
  const follow = useProject((s) => s.followPlayhead)
  const setFollow = useProject((s) => s.setFollowPlayhead)
  const select = useProject((s) => s.select)
  const setPlayhead = useProject((s) => s.setPlayhead)
  const setPlaying = useProject((s) => s.setPlaying)
  const setRate = useProject((s) => s.setPlaybackRate)
  const setAudioMode = useProject((s) => s.setAudioMode)
  const shift = useProject((s) => s.shift)
  const setTiming = useProject((s) => s.setTiming)
  const splitLine = useProject((s) => s.splitLine)
  const mergeLine = useProject((s) => s.mergeLine)

  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 波形那一格。它的高度由 flex 分配，量到多少就转给 wavesurfer 多少 */
  const waveBoxRef = useRef<HTMLDivElement | null>(null)
  const rulerTrackRef = useRef<HTMLDivElement | null>(null)
  const overlayTrackRef = useRef<HTMLDivElement | null>(null)
  /** 逐字轴自己的轨道：它已经不在波形覆盖层里，但必须与波形同步平移 */
  const railTrackRef = useRef<HTMLDivElement | null>(null)
  const playheadRef = useRef<HTMLDivElement | null>(null)
  const railPlayheadRef = useRef<HTMLDivElement | null>(null)
  const overviewBoxRef = useRef<HTMLDivElement | null>(null)
  const waveRef = useRef<WaveformHandle | null>(null)
  const tapChipRef = useRef<HTMLDivElement | null>(null)

  /**
   * 波形当前实际有多高。由 CSS 的 flex 分配决定，这里只是把量到的结果转给
   * wavesurfer（它要的是像素数，没法写 `height: 100%`）。
   */
  const [waveH, setWaveH] = useState(MIN_WAVE_H)
  const [viewportPx, setViewportPx] = useState(900)
  const [pxPerSec, setPxPerSec] = useState(24)
  const [waveDurationMs, setWaveDurationMs] = useState(0)
  const [status, setStatus] = useState<WaveformStatus>({ kind: 'idle' })
  const [linkNeighbor, setLinkNeighbor] = useState(true)
  const [viewWindow, setViewWindow] = useState({ startMs: 0, endMs: 0 })
  const [playheadLineId, setPlayheadLineId] = useState<string | null>(null)

  const [dragging, setDragging] = useState(false)
  const [dragUI, setDragUI] = useState({ delta: 0, x: 0, y: 0 })
  const dragRef = useRef<DragConfig | null>(null)

  const [tapMode, setTapMode] = useState(false)
  const [tapPos, setTapPos] = useState(0)
  const [tapDraft, setTapDraft] = useState<Record<string, Timing>>({})
  const [tapStackLen, setTapStackLen] = useState(0)
  const [commit, setCommit] = useState({ done: 0, total: 0 })

  const scrollRef = useRef(0)
  const viewportRef = useRef(viewportPx)
  const contentPxRef = useRef(0)
  const windowRef = useRef(viewWindow)
  const projectRef = useRef(project)
  const tapDraftRef = useRef(tapDraft)
  const tapPosRef = useRef(tapPos)
  const tapStackRef = useRef<Array<{ pos: number; draft: Record<string, Timing> }>>([])
  const committingRef = useRef(false)
  const zoomInitedRef = useRef(false)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  /** 「跟随」开关给逐帧回调用的镜像，免得订阅因为它变化而重挂 */
  const followRef = useRef(follow)
  /** 同理：播放头订阅里要用 select，但不该因为它的引用变化而重挂订阅 */
  const selectRef = useRef(select)
  selectRef.current = select

  viewportRef.current = viewportPx
  followRef.current = follow
  projectRef.current = project
  tapDraftRef.current = tapDraft
  tapPosRef.current = tapPos

  const durationMs = Math.max(waveDurationMs, project?.duration_ms ?? 0) || 60_000
  const minPxPerSec = fitPxPerSec(durationMs, viewportPx)
  const scale = useMemo(() => createScale(pxPerSec), [pxPerSec])
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const contentPx = contentWidthPx(durationMs, scale, viewportPx)
  contentPxRef.current = contentPx

  /** 整体偏移只读：旋钮是工具条上的 `EditOffset`，这里只用它把工程时间换算成音频时间 */
  const globalOffset = project?.global_offset_ms ?? 0

  const enqueue = useCallback((fn: () => Promise<void>): Promise<void> => {
    const run = queueRef.current.then(fn)
    queueRef.current = run.catch(() => undefined)
    return run
  }, [])

  /** 移动打点光标（「下一个要打的字」）。state 与 ref 必须一起改 */
  const moveTapCursor = useCallback((pos: number) => {
    tapPosRef.current = pos
    setTapPos(pos)
  }, [])

  // ------------------------------------------------------------ 视口 / 滚动 / 缩放

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportPx(el.clientWidth))
    ro.observe(el)
    setViewportPx(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  /**
   * 波形高度跟着分割条走。
   *
   * 只观察、不计算：高度是 CSS 用 flex 分出来的，这里若自己去减一遍
   * "总高 − 刻度 − 逐字轴 − 概览 − 工具条 − 图例"，每加一条横带都要回来改这个减法，
   * 且和真实布局必然对不齐。整数取整是必须的——wavesurfer 拿到小数会逐帧重画。
   */
  useEffect(() => {
    const el = waveBoxRef.current
    if (!el) return
    const apply = () => setWaveH(Math.max(MIN_WAVE_H, Math.round(el.clientHeight)))
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    apply()
    return () => ro.disconnect()
  }, [])

  /** 覆盖层与刻度尺跟着波形滚动。命令式赋值，和 wavesurfer 的滚动事件同一帧生效 */
  const applyTranslate = useCallback((px: number) => {
    const t = `translate3d(${-px}px,0,0)`
    if (rulerTrackRef.current) rulerTrackRef.current.style.transform = t
    if (overlayTrackRef.current) overlayTrackRef.current.style.transform = t
    if (railTrackRef.current) railTrackRef.current.style.transform = t
    const box = overviewBoxRef.current
    if (box) {
      const c = Math.max(1, contentPxRef.current)
      box.style.left = `${(px / c) * 100}%`
      box.style.width = `${(viewportRef.current / c) * 100}%`
    }
  }, [])

  /** 只在滚出预渲染范围时才更新虚拟化窗口，否则每帧都要重渲整棵树 */
  const ensureWindow = useCallback((scrollPx: number) => {
    const s = scaleRef.current
    const vp = viewportRef.current
    const pad = Math.max(300, s.pxToMs(vp * 0.6))
    const vis = visibleRangeMs(scrollPx, vp, s)
    const w = windowRef.current
    if (vis.startMs >= w.startMs + pad * 0.25 && vis.endMs <= w.endMs - pad * 0.25) return
    const next = { startMs: vis.startMs - pad, endMs: vis.endMs + pad }
    windowRef.current = next
    setViewWindow(next)
  }, [])

  const handleScrollPx = useCallback(
    (px: number) => {
      scrollRef.current = px
      applyTranslate(px)
      ensureWindow(px)
    },
    [applyTranslate, ensureWindow],
  )

  // 缩放或视口变化后必须重算窗口，否则放大之后会有一大片方块不渲染
  useEffect(() => {
    windowRef.current = { startMs: 0, endMs: 0 }
    ensureWindow(scrollRef.current)
    applyTranslate(scrollRef.current)
  }, [pxPerSec, viewportPx, durationMs, ensureWindow, applyTranslate])

  // 缩放下限跟着视口走：整曲已经铺满之后再往外缩只会留白
  useEffect(() => {
    setPxPerSec((v) => clampPxPerSec(v, minPxPerSec))
  }, [minPxPerSec])

  const movePlayheadMarker = useCallback((audioMs: number) => {
    const x = `translate3d(${scaleRef.current.msToPx(audioMs)}px,0,0)`
    // 波形与逐字轴各有一条播放头：它们是两个独立的裁剪容器，一条线画不穿
    if (playheadRef.current) playheadRef.current.style.transform = x
    if (railPlayheadRef.current) railPlayheadRef.current.style.transform = x
  }, [])

  useEffect(() => {
    movePlayheadMarker(useProject.getState().playheadMs)
  }, [pxPerSec, movePlayheadMarker])

  /**
   * 播放跟随。以前是 wavesurfer 的 `autoScroll` 干的，但它只认自己的播放进度，
   * 而波形层已经不播了（唯一时钟在 Preview），所以这件事只能自己做。
   *
   * 只在播放头快要滑出视口时才把它重新居中：每帧都居中的话整条波形一直在漂，
   * 反而看不清自己正对着哪一段能量。
   */
  const followPlayhead = useCallback(
    (audioMs: number) => {
      if (!followRef.current || !useProject.getState().playing) return
      const vp = viewportRef.current
      const px = scaleRef.current.msToPx(audioMs)
      const left = scrollRef.current
      if (px >= left + vp * 0.15 && px <= left + vp * 0.85) return
      const target = clampScroll(
        scrollToCenter(audioMs, vp, scaleRef.current),
        vp,
        contentPxRef.current,
      )
      if (Math.abs(target - left) < 1) return
      waveRef.current?.setScrollPx(target)
      handleScrollPx(target)
    },
    [handleScrollPx],
  )

  /**
   * 播放头：**只读** store。写入者只有 Preview（CLAUDE.md D15 的唯一时钟）。
   *
   * 用命令式订阅而不是 `useProject((s) => s.playheadMs)`：后者会让整棵时间轴
   * 每帧重渲一次。只有「播放头进了另一行」这种低频事件才值得进 state。
   */
  useEffect(() => {
    const onPlayhead = (ms: number): void => {
      movePlayheadMarker(ms)
      followPlayhead(ms)
      // locateLineId 是 O(行数) 的线性扫描，逐帧跑也远不到一帧预算；
      // 且行号相同时 setState 会被 React 直接丢弃，不会引起重渲。
      // **与歌词正文调的是同一个函数**，两处不会各说各的（见其注释）
      const id = locateLineId(projectRef.current, ms)
      setPlayheadLineId((prev) => (prev === id ? prev : id))

      /*
       * 选中跟着播放走 —— 「选中的句」与「正在唱的句」是同一件事，不再分两套标记。
       *
       * 三条限制，缺一条就会变成骚扰：
       * - 只在**播放中**跟：暂停时用户正对着某个字调轴，选中被挪走等于活没法干
       * - 只在**跨行**时跟：逐字跟的话检查器每几百毫秒换一个字，读都读不清
       * - 落到该行**首字**：选中项是 token 级的，落到行上会让检查器退化成半空
       */
      if (!id || !useProject.getState().playing) return
      const cur = useProject.getState().selection
      if (cur.kind !== 'none' && cur.lineId === id) return
      selectRef.current({ kind: 'token', lineId: id, tokenIndex: 0 })
    }
    onPlayhead(useProject.getState().playheadMs)
    return useProject.subscribe((state, prev) => {
      if (state.playheadMs !== prev.playheadMs) onPlayhead(state.playheadMs)
    })
  }, [followPlayhead, movePlayheadMarker])

  /**
   * 选中的字滚进视口。
   *
   * 合并舞台之后选中项是双向的：在歌词正文里点一个词，逐字轴上同一个字要高亮。
   * 但两边的坐标系毫无关系——正文是文档流、时间轴是时间轴，选中的字很可能落在
   * 视口之外，此时"同步高亮"只是嘴上说说，用户根本看不见它亮在哪。
   *
   * 只在它确实不在视口里时才滚：从逐字轴上点字时它本来就在眼前，
   * 每点一次都重新居中会让整条波形无谓地平移一下。
   */
  useEffect(() => {
    if (selection.kind === 'none') return
    /*
     * 播放中不由选中来滚。选中现在跟着播放头走（见上方订阅），这条 effect 会
     * 在每次跨行时被唤醒，与 `followPlayhead` 抢同一个 scrollLeft ——
     * 一个要把选中的首字摆进视口、一个要把播放头居中，结果是每换一句抖一下。
     * 播放时滚动只认播放头这一个主人。
     */
    if (useProject.getState().playing) return
    const line = projectRef.current?.lines.find((l) => l.id === selection.lineId)
    // 选中整行时对齐到它的首字：行的起点就是首字的起点
    const tk = selection.kind === 'token' ? line?.tokens[selection.tokenIndex] : line?.tokens[0]
    if (!tk) return
    const audioMs = toAudioMs(tk.start_ms, globalOffset)
    const px = scaleRef.current.msToPx(audioMs)
    const vp = viewportRef.current
    const left = scrollRef.current
    if (px >= left + vp * 0.08 && px <= left + vp * 0.92) return
    const target = clampScroll(
      scrollToCenter(audioMs, vp, scaleRef.current),
      vp,
      contentPxRef.current,
    )
    waveRef.current?.setScrollPx(target)
    handleScrollPx(target)
  }, [selection, globalOffset, handleScrollPx])

  const zoomBy = useCallback(
    (dir: number, anchorPx?: number) => {
      const old = scaleRef.current
      const next = createScale(stepZoom(old.pxPerSec, dir, minPxPerSec))
      if (next.pxPerSec === old.pxPerSec) return
      const anchor = anchorPx ?? viewportRef.current / 2
      const anchorMs = old.pxToMs(scrollRef.current + anchor)
      setPxPerSec(next.pxPerSec)
      // 等 wavesurfer 自己重排完再定位，否则会被它的 reRender 覆盖掉
      requestAnimationFrame(() => {
        const target = clampScroll(
          next.msToPx(anchorMs) - anchor,
          viewportRef.current,
          contentWidthPx(durationMs, next, viewportRef.current),
        )
        waveRef.current?.setScrollPx(target)
        handleScrollPx(target)
      })
    },
    [durationMs, handleScrollPx, minPxPerSec],
  )

  // 滚轮：横向滚动 + Ctrl/Cmd 缩放。React 的 onWheel 是被动监听，preventDefault 无效
  // （会退化成浏览器整页缩放），必须自己挂一个非被动的原生监听
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - el.getBoundingClientRect().left)
        return
      }
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (!d) return
      e.preventDefault()
      const target = clampScroll(scrollRef.current + d, viewportRef.current, contentPxRef.current)
      waveRef.current?.setScrollPx(target)
      handleScrollPx(target)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomBy, handleScrollPx])

  // ------------------------------------------------------------ 音源

  /*
   * **波形看哪条轨，与耳朵听哪条轨是两件事。**
   *
   * 走带上的原声/伴奏切的是 store 的 `audioMode`（D15 的 Web Audio 混音），
   * 这里切的只是画在屏幕上的那条曲线。二者分开是有实际用处的：
   * 对着**人声**的波形能一眼看出每个字的起音在哪（这正是调轴要对的东西），
   * 而耳朵里放**伴奏**才听得清节拍、不被原唱带着走。绑在一起就只能二选一。
   */
  const waveSource = useProject((s) => s.waveSource)
  const setWaveSource = useProject((s) => s.setWaveSource)

  /** 这个工程有哪几条轨可看。缺的轨不能只是点不动——要让人知道是"还没分离" */
  const waveTracks = useMemo(
    () => ({
      audio: !!project?.audio_path,
      instrumental: !!project?.instrumental_path,
      vocals: !!project?.vocals_path,
    }),
    [project?.audio_path, project?.instrumental_path, project?.vocals_path],
  )

  // 调轴时看伴奏的波形更容易分辨节拍（§5.10），有伴奏就默认切过去
  useEffect(() => {
    if (project?.instrumental_path) setAudioMode('instrumental')
  }, [project?.instrumental_path, setAudioMode])

  // 选中的那条轨这个工程没有（换了工程、或还没分离）就退回原曲，
  // 否则波形会一直卡在"加载失败"上，而用户看不出是自己选了条不存在的轨
  useEffect(() => {
    if (waveSource !== 'audio' && !waveTracks[waveSource]) setWaveSource('audio')
  }, [waveSource, waveTracks, setWaveSource])

  const sources = useMemo(() => {
    if (!project) return []
    // 首选用户挑的那条，后面几条是兜底：缺轨时仍要有波形可看，而不是一片空白
    const order: Array<'vocals' | 'instrumental' | 'audio' | 'video'> = [
      waveSource,
      'instrumental',
      'audio',
      'video',
    ]
    const has: Record<'vocals' | 'instrumental' | 'audio' | 'video', boolean> = {
      vocals: waveTracks.vocals,
      instrumental: waveTracks.instrumental,
      audio: waveTracks.audio,
      video: !!project.video_path,
    }
    return [...new Set(order)].filter((k) => has[k]).map((k) => api.mediaUrl(project.id, k))
  }, [project, waveSource, waveTracks])

  // ------------------------------------------------------------ 生效时间（草稿 + 拖动预览）

  /** 只叠加打轴草稿，不含拖动预览。提交时要以它为基准 */
  const baseTiming = useCallback(
    (line: Line, index: number): Timing => {
      const d = tapDraft[tokenKey(line.id, index)]
      if (d) return d
      const tk = line.tokens[index]
      return { start: tk.start_ms, dur: tk.dur_ms }
    },
    [tapDraft],
  )

  const effTiming = useCallback(
    (line: Line, index: number): Timing => {
      const b = baseTiming(line, index)
      const cfg = dragRef.current
      if (!dragging || !cfg || cfg.lineId !== line.id) return b
      const d = dragUI.delta
      let { start, dur } = b
      if (cfg.kind === 'line') start += d
      else if (cfg.kind === 'token-move' && cfg.index === index) start += d
      else if (cfg.kind === 'token-start') {
        if (cfg.index === index) {
          start += d
          dur -= d
        } else if (cfg.linked && cfg.index - 1 === index) dur += d
      } else if (cfg.kind === 'token-end') {
        if (cfg.index === index) dur += d
        else if (cfg.linked && cfg.index + 1 === index) {
          start += d
          dur -= d
        }
      }
      return { start, dur }
    },
    [baseTiming, dragging, dragUI.delta],
  )

  const effLineBounds = useCallback(
    (line: Line): Timing => {
      if (!line.tokens.length) return { start: 0, dur: 0 }
      const a = effTiming(line, 0)
      const b = effTiming(line, line.tokens.length - 1)
      return { start: a.start, dur: b.start + b.dur - a.start }
    },
    [effTiming],
  )

  // ------------------------------------------------------------ 可见行 / 当前行

  const flat = useMemo(() => {
    const out: FlatRef[] = []
    project?.lines.forEach((ln, li) => {
      if (ln.is_metadata) return
      ln.tokens.forEach((_, ti) => out.push({ lineIndex: li, tokenIndex: ti, lineId: ln.id }))
    })
    return out
  }, [project])

  const activeLineId =
    selection.kind !== 'none'
      ? selection.lineId
      : tapMode && flat[tapPos]
        ? flat[tapPos].lineId
        : playheadLineId
  const activeLine = project?.lines.find((l) => l.id === activeLineId) ?? null

  /**
   * 行号。取的是**在 `project.lines` 里的序号**（含制作名单行），与歌词正文左侧
   * 那个数字算法完全一致——两处对不上的话，行号就没法当"这段属于哪句"的指针用。
   */
  const lineNo = useMemo(() => {
    const m = new Map<string, number>()
    project?.lines.forEach((l, i) => m.set(l.id, i + 1))
    return m
  }, [project])

  /**
   * 逐字轴画哪些行：**落在视口时间窗里的全部行**，不是只有选中的那一句。
   *
   * 虚拟化是硬要求而不是优化（§5.10）：一首 4-5 分钟的日语歌 600~900 个音节，
   * 全部实例化会卡死。`viewWindow` 自带预渲染余量，滚动时不会每帧重建。
   *
   * 不假设行之间时间互斥（§8.5 允许重叠）：这里只做筛选、不做排他，
   * 真出现重叠时两行的块会叠在同一排上——第一版编辑器本来就不支持编辑重叠行，
   * 但代码不该因此假设它不会发生。
   */
  const railLines = useMemo(() => {
    if (!project) return []
    return project.lines.filter((l) => {
      // 制作名单行（「词：xxx」「编曲：xxx」，§6.1）不进逐字轴：它们不唱、
      // 不需要调轴，而歌词源把它们塞在正文开头几十毫秒里，铺在轴上就是开头
      // 一坨挤成一团的方块，正好压在真正要调的第一句上
      if (l.is_metadata || !l.tokens.length) return false
      const b = lineBounds(l)
      const s = toAudioMs(b.start, globalOffset)
      return s + b.dur >= viewWindow.startMs && s <= viewWindow.endMs
    })
  }, [project, viewWindow, globalOffset])

  const ticks = useMemo(
    () => buildTicks(viewWindow.startMs, viewWindow.endMs, scale),
    [viewWindow, scale],
  )

  /**
   * 还有多少字没打轴。这是「这首歌还差多远能用」的唯一硬指标，必须常驻可见。
   * 已经打进草稿的字算作已完成 —— 打轴过程中这个数字要肉眼可见地往下掉，
   * 否则一整段打完了还显示原样，人会以为白干了。
   */
  const { unset: unsetCount, total: totalTokens } = useMemo(() => {
    let unset = 0
    let total = 0
    for (const line of project?.lines ?? []) {
      if (line.is_metadata) continue
      line.tokens.forEach((tk, i) => {
        total += 1
        if (tk.timing_source === 'unset' && !tapDraft[tokenKey(line.id, i)]) unset += 1
      })
    }
    return { unset, total }
  }, [project, tapDraft])

  // ------------------------------------------------------------ 拖动：本地预览 → 松手提交

  const beginDrag = useCallback(
    (e: ReactPointerEvent, cfg: Omit<DragConfig, 'startClientX' | 'pxPerMs'>) => {
      e.stopPropagation()
      e.preventDefault()
      dragRef.current = { ...cfg, startClientX: e.clientX, pxPerMs: scaleRef.current.pxPerMs }
      setDragUI({ delta: 0, x: e.clientX, y: e.clientY })
      setDragging(true)
    },
    [],
  )

  useEffect(() => {
    if (!dragging) return
    let raf = 0
    let pending: { x: number; y: number } | null = null
    const flush = () => {
      raf = 0
      const cfg = dragRef.current
      if (!cfg || !pending) return
      const raw = (pending.x - cfg.startClientX) / cfg.pxPerMs
      setDragUI({
        delta: Math.round(clamp(raw, cfg.minDelta, cfg.maxDelta)),
        x: pending.x,
        y: pending.y,
      })
    }
    const onMove = (e: PointerEvent) => {
      pending = { x: e.clientX, y: e.clientY }
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const onUp = () => {
      if (raf) {
        cancelAnimationFrame(raf)
        flush()
      }
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging])

  // 提交逻辑放进 ref：它要读最新的 project/选择，又不该让拖动 effect 反复重挂
  const commitDragRef = useRef<(delta: number) => void>(() => undefined)
  commitDragRef.current = (delta: number) => {
    const cfg = dragRef.current
    dragRef.current = null
    const p = projectRef.current
    if (!cfg || !p || Math.abs(delta) < 1) return
    const line = p.lines.find((l) => l.id === cfg.lineId)
    if (!line) return
    const i = cfg.index

    if (cfg.kind === 'line') {
      select({ kind: 'line', lineId: cfg.lineId })
      void enqueue(() => shift('line', delta))
      return
    }
    if (cfg.kind === 'token-move') {
      select({ kind: 'token', lineId: cfg.lineId, tokenIndex: i })
      void enqueue(() => shift('token', delta))
      return
    }
    if (!line.tokens[i]) return
    const cur = baseTiming(line, i)

    if (cfg.kind === 'token-start') {
      const prev = i > 0 ? baseTiming(line, i - 1) : null
      void enqueue(async () => {
        await setTiming(cfg.lineId, i, Math.round(cur.start + delta), Math.round(cur.dur - delta))
        // 联动改邻居只能再发一次请求（后端没有批量端点），因此会占两步撤销
        if (cfg.linked && prev) {
          await setTiming(cfg.lineId, i - 1, undefined, Math.round(prev.dur + delta))
        }
      })
    } else {
      const next = i + 1 < line.tokens.length ? baseTiming(line, i + 1) : null
      void enqueue(async () => {
        await setTiming(cfg.lineId, i, undefined, Math.round(cur.dur + delta))
        if (cfg.linked && next) {
          await setTiming(
            cfg.lineId,
            i + 1,
            Math.round(next.start + delta),
            Math.round(next.dur - delta),
          )
        }
      })
    }
  }

  const prevDraggingRef = useRef(false)
  useEffect(() => {
    if (prevDraggingRef.current && !dragging) commitDragRef.current(dragUI.delta)
    prevDraggingRef.current = dragging
  }, [dragging, dragUI.delta])

  /**
   * 选中即播放位置。
   *
   * 「选中的那一句」和「正在唱的那一句」以前是两个独立的标记，同屏两种高亮，
   * 用户得先记住哪个颜色是哪个意思。现在合成一件事：**点哪儿，播放头就跳到哪儿**，
   * 于是二者在点击那一刻必然重合；播放推进时选中也跟着走（见下方订阅）。
   *
   * 只写 store 的播放头，真正的 seek 由 Preview 执行（D15：唯一时钟）。
   */
  const selectAndSeek = useCallback(
    (sel: Parameters<typeof select>[0], projectMs: number) => {
      select(sel)
      setPlayhead(Math.round(clamp(toAudioMs(projectMs, globalOffset), 0, durationMs)))
    },
    [select, setPlayhead, globalOffset, durationMs],
  )

  const onTokenPointerDown = useCallback(
    (e: ReactPointerEvent, line: Line, i: number, kind: DragConfig['kind']) => {
      // 拖左右边界是"改这个字的边界"，不是"我要听这里"——那种手势不该顺带跳播放头
      if (kind === 'token-move') {
        selectAndSeek({ kind: 'token', lineId: line.id, tokenIndex: i }, baseTiming(line, i).start)
      } else {
        select({ kind: 'token', lineId: line.id, tokenIndex: i })
      }
      if (tapMode) {
        // 打轴模式下点字 =「从这里开始打」，不进入拖动
        const pos = flat.findIndex((f) => f.lineId === line.id && f.tokenIndex === i)
        if (pos >= 0) moveTapCursor(pos)
        e.stopPropagation()
        return
      }
      const t = baseTiming(line, i)
      const prev = i > 0 ? baseTiming(line, i - 1) : null
      const next = i + 1 < line.tokens.length ? baseTiming(line, i + 1) : null
      let minDelta = -t.start
      let maxDelta = 600_000
      let linked = false

      if (kind === 'token-start') {
        linked = linkNeighbor && !!prev && Math.abs(prev.start + prev.dur - t.start) <= 1
        if (linked && prev) minDelta = Math.max(minDelta, prev.start + MIN_TOKEN_DUR_MS - t.start)
        else if (prev) minDelta = Math.max(minDelta, prev.start + prev.dur - t.start)
        maxDelta = t.dur - MIN_TOKEN_DUR_MS
      } else if (kind === 'token-end') {
        linked = linkNeighbor && !!next && Math.abs(t.start + t.dur - next.start) <= 1
        minDelta = MIN_TOKEN_DUR_MS - t.dur
        if (linked && next) maxDelta = next.start + next.dur - MIN_TOKEN_DUR_MS - (t.start + t.dur)
        else if (next) maxDelta = next.start - (t.start + t.dur)
      }
      if (maxDelta < minDelta) maxDelta = minDelta
      beginDrag(e, { kind, lineId: line.id, index: i, minDelta, maxDelta, linked })
    },
    [baseTiming, beginDrag, flat, linkNeighbor, moveTapCursor, select, selectAndSeek, tapMode],
  )

  // ------------------------------------------------------------ tap-to-time

  const tapTimingOf = useCallback((ref: FlatRef): Timing => {
    const d = tapDraftRef.current[tokenKey(ref.lineId, ref.tokenIndex)]
    if (d) return d
    const tk = projectRef.current?.lines[ref.lineIndex]?.tokens[ref.tokenIndex]
    return { start: tk?.start_ms ?? 0, dur: tk?.dur_ms ?? 0 }
  }, [])

  const pushTapSnapshot = useCallback(() => {
    tapStackRef.current.push({ pos: tapPosRef.current, draft: { ...tapDraftRef.current } })
    setTapStackLen(tapStackRef.current.length)
  }, [])

  /**
   * 打点取的时间点：直接读唯一时钟（store 的 `playheadMs`，由 Preview 逐帧写入）。
   * 以前读的是波形层自己那份播放器时间，而用户听到的其实是 Preview 的声音 ——
   * 两份时钟一旦不同步，打出来的点就整体偏一截。
   */
  const nowProjectMs = useCallback(
    (): number => Math.round(toProjectMs(useProject.getState().playheadMs, globalOffset)),
    [globalOffset],
  )

  const doTap = useCallback(() => {
    // 读 ref 而不是 state：连续快打时两次按键可能落在同一次渲染之间
    const tapPos = tapPosRef.current
    if (tapPos < 0 || tapPos >= flat.length) return
    const p = nowProjectMs()
    const cur = flat[tapPos]

    pushTapSnapshot()
    const draft = { ...tapDraftRef.current }

    // 收尾上一个字 —— 只收尾**本次打过的**，否则从中间开始打会改到不该动的地方
    if (tapPos > 0) {
      const prev = flat[tapPos - 1]
      const key = tokenKey(prev.lineId, prev.tokenIndex)
      const prevDraft = draft[key]
      if (prevDraft) {
        const raw = p - prevDraft.start
        const capped = prev.lineIndex === cur.lineIndex ? raw : Math.min(raw, TAP_MAX_TAIL_MS)
        draft[key] = { start: prevDraft.start, dur: Math.max(MIN_TOKEN_DUR_MS, Math.round(capped)) }
      }
    }

    const curDur = tapTimingOf(cur).dur
    draft[tokenKey(cur.lineId, cur.tokenIndex)] = {
      start: p,
      dur: Math.max(MIN_TOKEN_DUR_MS, curDur || TAP_PROVISIONAL_DUR_MS),
    }
    tapDraftRef.current = draft
    setTapDraft(draft)
    moveTapCursor(tapPos + 1)
  }, [flat, moveTapCursor, nowProjectMs, pushTapSnapshot, tapTimingOf])

  /** 结束当前句：给刚打完的最后一个字收尾，光标跳到下一句首字 */
  const doEndPhrase = useCallback(() => {
    const tapPos = tapPosRef.current
    if (tapPos <= 0 || tapPos > flat.length) return
    const prev = flat[tapPos - 1]
    const key = tokenKey(prev.lineId, prev.tokenIndex)
    const p = nowProjectMs()
    pushTapSnapshot()
    const draft = { ...tapDraftRef.current }
    const prevDraft = draft[key]
    if (prevDraft) {
      draft[key] = { start: prevDraft.start, dur: Math.max(MIN_TOKEN_DUR_MS, p - prevDraft.start) }
    }
    tapDraftRef.current = draft
    setTapDraft(draft)
    let np = tapPos
    while (np < flat.length && flat[np].lineIndex === prev.lineIndex) np++
    moveTapCursor(np)
  }, [flat, moveTapCursor, nowProjectMs, pushTapSnapshot])

  const doTapUndo = useCallback(() => {
    const snap = tapStackRef.current.pop()
    setTapStackLen(tapStackRef.current.length)
    if (!snap) return
    tapDraftRef.current = snap.draft
    setTapDraft(snap.draft)
    moveTapCursor(snap.pos)
  }, [moveTapCursor])

  /**
   * 把打轴草稿落库。
   *
   * 后端只有逐个 token 的 `setTiming`，所以整首歌的打轴结果只能一条条发，
   * 也就会占掉同样多的撤销步数。**这是目前最该补的后端接口**（见文件末尾说明）。
   * 这里的补偿是：提交成功一个才从草稿里摘掉一个，屏幕上不会先整片弹回旧时间。
   */
  const commitTapDraft = useCallback(async () => {
    if (committingRef.current) return
    const entries = Object.entries(tapDraftRef.current)
    if (!entries.length) return
    committingRef.current = true
    tapStackRef.current = []
    setTapStackLen(0)
    setCommit({ done: 0, total: entries.length })
    try {
      let done = 0
      for (const [key, v] of entries) {
        const at = key.lastIndexOf('#')
        const lineId = key.slice(0, at)
        const index = Number(key.slice(at + 1))
        await enqueue(() => setTiming(lineId, index, Math.round(v.start), Math.round(v.dur)))
        done += 1
        setCommit({ done, total: entries.length })
        // 只摘掉这一个 key：提交期间用户新打的点必须原样留着
        const rest = { ...tapDraftRef.current }
        delete rest[key]
        tapDraftRef.current = rest
        setTapDraft(rest)
      }
    } finally {
      committingRef.current = false
      setCommit({ done: 0, total: 0 })
    }
  }, [enqueue, setTiming])

  const enterTapMode = useCallback(() => {
    // 从选中的字开始；没选中就从播放头所在的字开始；都没有就从头开始
    let pos = 0
    if (selection.kind === 'token') {
      const i = flat.findIndex(
        (f) => f.lineId === selection.lineId && f.tokenIndex === selection.tokenIndex,
      )
      if (i >= 0) pos = i
    } else {
      const p = nowProjectMs()
      const i = flat.findIndex((f) => tapTimingOf(f).start >= p)
      pos = i >= 0 ? i : 0
    }
    moveTapCursor(pos)
    setRate(0.75)
    setTapMode(true)
  }, [flat, moveTapCursor, nowProjectMs, selection, setRate, tapTimingOf])

  const exitTapMode = useCallback(() => {
    setTapMode(false)
    setRate(1)
    void commitTapDraft()
  }, [commitTapDraft, setRate])

  /**
   * 暂停是「这一段打完了」的天然节点，顺手落库，免得草稿越攒越大。
   * 播放状态来自 store（Preview 写的），所以这里盯的是它的下降沿。
   */
  const prevPlayingRef = useRef(playing)
  useEffect(() => {
    const wasPlaying = prevPlayingRef.current
    prevPlayingRef.current = playing
    if (wasPlaying && !playing && Object.keys(tapDraftRef.current).length) void commitTapDraft()
  }, [commitTapDraft, playing])

  useEffect(() => {
    if (tapMode) tapChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [tapMode, tapPos])

  // ------------------------------------------------------------ 其它编辑动作

  const nudgeSelection = useCallback(
    (delta: number) => {
      if (selection.kind === 'token') void enqueue(() => shift('token', delta))
      else if (selection.kind === 'line') void enqueue(() => shift('line', delta))
    },
    [enqueue, selection, shift],
  )

  const doSplit = useCallback(() => {
    if (selection.kind !== 'token' || selection.tokenIndex <= 0) return
    void enqueue(() => splitLine(selection.lineId, selection.tokenIndex))
  }, [enqueue, selection, splitLine])

  const doMerge = useCallback(() => {
    if (selection.kind === 'none') return
    void enqueue(() => mergeLine(selection.lineId))
  }, [enqueue, mergeLine, selection])

  /**
   * 点波形定位。这里**只发出跳转意图**（写 store 的播放头），真正的 seek 由
   * Preview 执行；播放头标记也由上面那个订阅统一移动，不在这里抢着画 ——
   * 早先是「波形自己 seek 完再把结果写回 store」，于是两个时钟互相追。
   */
  const seekAt = useCallback(
    (clientX: number) => {
      const el = hostRef.current
      if (!el) return
      const ms = scaleRef.current.pxToMs(
        scrollRef.current + (clientX - el.getBoundingClientRect().left),
      )
      setPlayhead(Math.round(clamp(ms, 0, durationMs)))
    },
    [durationMs, setPlayhead],
  )

  // ------------------------------------------------------------ 快捷键

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target
    if (
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable)
    ) {
      return
    }
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()

    // Cmd/Ctrl+Z（撤销）与 Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y（重做）统一交给
    // App.tsx 的全局监听器处理，这里不再重复注册：两处都监听同一个组合键的话，
    // 一次按键会触发两次 undo/redo 请求，表现为「按一次退两步」。
    // 工具栏的撤销/重做按钮（下方 JSX）仍然直接调用 enqueue(undo)/enqueue(redo)，
    // 那是点击触发，不受这条规则影响。
    if (mod) return

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      /*
       * 空格必须由这里独占。App.tsx 也在 window 上挂了「空格 = 播放/暂停」，
       * 而打轴模式下空格是「打一个点」—— 两个监听器都跑的话，每打一个点就会
       * 顺手把播放停掉，playheadMs 随之冻住，后面几个点会全落在同一个时刻。
       * 子组件的 effect 先于父组件执行，本监听器排在 App 之前，
       * 所以掐断同一事件上后续的 window 监听器是有效的（React 的合成事件挂在
       * 根容器上，冒泡时早已处理完，不受影响）。
       */
      e.stopImmediatePropagation()
      // 非打轴模式下空格 = 播放/暂停意图，交给 Preview 执行
      if (!tapMode) setPlaying(!useProject.getState().playing)
      else if (e.key === ' ' && e.shiftKey) doEndPhrase()
      else doTap()
      return
    }
    if (e.key === 'Backspace' && tapMode) {
      e.preventDefault()
      doTapUndo()
      return
    }
    if (e.key === 'Escape') {
      if (tapMode) exitTapMode()
      else select({ kind: 'none' })
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const step = e.shiftKey ? NUDGE_FRAME_MS : e.altKey ? NUDGE_FINE_MS : NUDGE_MS
      nudgeSelection((e.key === 'ArrowLeft' ? -1 : 1) * step)
      return
    }
    if (k === 't') {
      e.preventDefault()
      if (tapMode) exitTapMode()
      else enterTapMode()
      return
    }
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      zoomBy(1)
      return
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      zoomBy(-1)
    }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // ------------------------------------------------------------ 渲染

  if (!project) {
    return (
      <div className="kvm-tl" style={{ padding: 'var(--sp-4)', color: 'var(--fg-2)' }}>
        <style>{CSS}</style>
        {t('align.noProject')}
      </div>
    )
  }

  const tapCur = flat[tapPos] ?? null
  const tapLine = tapCur ? project.lines[tapCur.lineIndex] : null
  const tapNextLine = (() => {
    if (!tapCur) return null
    for (let i = tapCur.lineIndex + 1; i < project.lines.length; i++) {
      const l = project.lines[i]
      if (!l.is_metadata && l.tokens.length) return l
    }
    return null
  })()
  const tappedCount = Object.keys(tapDraft).length

  return (
    <div className="kvm-tl" style={S.root}>
      <style>{CSS}</style>

      {/* ------------------------------------------------ 工具栏 */}
      <div style={S.bar}>
        {/*
         * tap-to-time 排在工具条第一位（CLAUDE.md §2.5：它是一等公民，不是降级方案）。
         * 播放/暂停按钮此前也在这一排，已经去掉 —— 走带归 Preview，见文件头。
         */}
        <button
          data-role="tap"
          data-on={tapMode ? '1' : '0'}
          aria-pressed={tapMode}
          onClick={() => (tapMode ? exitTapMode() : enterTapMode())}
          title={tapMode ? t('align.tapExit') : t('align.tapEnter')}
        >
          <FieldTimeOutlined />
          {tapMode ? t('align.tapOn') : t('align.tap')}
        </button>
        {/* 还剩多少字没打轴要能一眼看到：它直接决定「这首歌还差多远能用」，
            所以贴着打轴按钮放，而不是塞进底部图例 */}
        {unsetCount > 0 && (
          <span style={S.todo} className="num">
            {t('align.untimed', { n: unsetCount, total: totalTokens })}
          </span>
        )}

        <span style={S.sep} />

        {/*
         * 变速是打点的必需品（§5.10 建议 0.5~0.75x），且预览层没有这个控件。
         * 三个档位摊开成按钮式 radio —— 见 CSS 里 `.kvm-tl-seg` 的说明。
         */}
        <span style={S.dim} title={t('align.rateHint')}>
          {t('align.rate')}
          <span
            className="kvm-tl-seg"
            role="radiogroup"
            aria-label={t('align.rate')}
            /*
             * 方向键切换**自己实现**，并 preventDefault 掉原生行为。
             *
             * 原生 radio 组在 Chromium 上方向键可用，**WebKit 上实测无效**
             * （焦点与 checked 都不动）——用户用的正是 Safari，只靠原生等于
             * 在那一端把键盘可达性丢了。两端都走自己这份实现才有一致行为，
             * 不 preventDefault 的话 Chromium 会原生 + 自己各切一次，跳两档。
             */
            onKeyDown={(e) => {
              const dir =
                e.key === 'ArrowRight' || e.key === 'ArrowDown'
                  ? 1
                  : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                    ? -1
                    : 0
              if (!dir) return
              e.preventDefault()
              const cur = RATE_OPTIONS.indexOf(rate as (typeof RATE_OPTIONS)[number])
              const n = RATE_OPTIONS.length
              const next = ((cur < 0 ? 0 : cur) + dir + n) % n
              setRate(RATE_OPTIONS[next])
              // 焦点跟着选中项走，这是原生 radio 组的行为，键盘用户靠它知道自己在哪
              e.currentTarget.querySelectorAll('input')[next]?.focus()
            }}
          >
            {RATE_OPTIONS.map((v) => (
              <label key={v} data-on={rate === v || undefined} data-rate={v}>
                <input
                  type="radio"
                  name="kvm-tl-rate"
                  checked={rate === v}
                  onChange={() => setRate(v)}
                />
                {v}x
              </label>
            ))}
          </span>
        </span>
        {/*
         * 以下一组都改成**纯图标**：语义单一、Ant Design 里有约定俗成的图标、
         * 且是高频操作（docs/ui-redesign.md §六「图标只在语义明确处使用」）。
         *
         * 刻意**没有**图标化的：
         * - 「手工打轴」：它是模式开关而非一次动作，§2.5 要求它是一等公民、
         *   不能藏起来；一个人第一次打开这一步必须一眼看见它
         * - 检查器里的「锁定时间」/「锁定读音」：同一把锁图标、锁的却是两回事，
         *   只留图标就分不出来了
         *
         * 纯图标一律**同时**给 title（鼠标）与 aria-label（读屏），少一个就等于
         * 对其中一类用户把这个按钮变成了哑谜。
         */}
        <button
          data-role="follow"
          data-on={follow ? '1' : '0'}
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
          title={`${t('align.follow')}｜${t('align.followHint')}`}
          aria-label={t('align.follow')}
        >
          <VerticalAlignMiddleOutlined />
        </button>

        <span style={S.sep} />

        {/*
         * 波形画哪条轨。**与走带上的原声/伴奏是两个独立的选择**（见 sources 的注释）：
         * 这里改的只是屏幕上那条曲线，耳朵听什么不受影响。
         * 缺的轨不隐藏而是禁用 —— 藏起来的话用户只会以为这个功能不存在，
         * 而真实原因是"还没分离出人声"，那是他自己能去解决的。
         */}
        <span style={S.dim} title={t('align.waveSrcHint')}>
          {t('align.waveSrc')}
          <span className="kvm-tl-seg" role="radiogroup" aria-label={t('align.waveSrc')}>
            {WAVE_SOURCES.map((k) => (
              <label
                key={k}
                data-on={waveSource === k || undefined}
                data-wave-src={k}
                data-missing={!waveTracks[k] || undefined}
                title={waveTracks[k] ? t(`align.waveSrc.${k}`) : t('align.waveSrcMissing')}
              >
                <input
                  type="radio"
                  name="kvm-tl-wavesrc"
                  checked={waveSource === k}
                  disabled={!waveTracks[k]}
                  onChange={() => setWaveSource(k)}
                />
                {t(`align.waveSrc.${k}`)}
              </label>
            ))}
          </span>
        </span>

        {/*
         * 这里**不放撤销/重做**。顶栏已经有一对，点下去调的是同一个后端历史 ——
         * 与曾经"顶栏导出按钮跳到导出步骤"、"同屏两个播放按钮"是同一类重复
         * （docs/ui-redesign.md §五：同一个动作只应在一处出现）。
         * 顺带解决一个真实的误读：打轴面板里的「回退」退的是本地打点草稿，
         * 与后端撤销不是一回事，两个"往回"的按钮同屏出现时没人分得清。
         */}

        <span style={S.sep} />

        <button
          data-role="split"
          onClick={doSplit}
          disabled={selection.kind !== 'token' || selection.tokenIndex <= 0}
          title={`${t('align.split')}｜${t('align.splitHint')}`}
          aria-label={t('align.split')}
        >
          <ScissorOutlined />
        </button>
        <button
          data-role="merge"
          onClick={doMerge}
          disabled={selection.kind === 'none'}
          title={`${t('align.merge')}｜${t('align.mergeHint')}`}
          aria-label={t('align.merge')}
        >
          <MergeCellsOutlined />
        </button>

        <span style={S.sep} />

        <button
          data-role="link"
          data-on={linkNeighbor ? '1' : '0'}
          aria-pressed={linkNeighbor}
          onClick={() => setLinkNeighbor((v) => !v)}
          title={`${t('align.link')}｜${t('align.linkHint')}`}
          aria-label={t('align.link')}
        >
          <LinkOutlined />
        </button>

        <span style={S.sep} />

        {/*
         * 整曲偏移（三级调轴的「整体」级）。放在这里而不是舞台左栏，有两条理由：
         *
         * 1. 它作用于**全曲的时间轴**，与同一排的缩放/整曲是同一类东西；
         *    改完之后波形上每一块都会动，控件和结果在同一屏里
         * 2. 与底栏检查器的「平移」（作用于**一个字**）拉开到时间轴的一头一尾。
         *    两者曾经都是四个 ±ms 按钮、长得一模一样，是真实发生过的误读来源；
         *    现在除了距离，形态也不同（对称摆在数值两侧 + 图标 + 「整曲」二字）
         */}
        <EditOffset />

        <span style={{ marginLeft: 'auto' }} />

        {/*
         * 这里**不放原声/伴奏切换**。走带归预览层所有（docs/ui-redesign.md §五），
         * 而"听哪条轨"正是走带的一部分，`Preview` 的控件条上已经有这一组按钮，
         * 与这里改的是 store 里同一个 `audioMode` —— 同屏两个入口改同一个值。
         * 波形显示哪条轨仍然跟着这个值走（见下方 `sources`），
         * 也就是说切换能力一点没少，只是入口收敛到了它该在的地方。
         */}
        <button onClick={() => zoomBy(-1)} title={t('align.zoomOut')} aria-label={t('align.zoomOut')}>
          <ZoomOutOutlined />
        </button>
        <button onClick={() => zoomBy(1)} title={t('align.zoomIn')} aria-label={t('align.zoomIn')}>
          <ZoomInOutlined />
        </button>
        <button
          data-role="fit"
          onClick={() => {
            setPxPerSec(minPxPerSec)
            waveRef.current?.setScrollPx(0)
            handleScrollPx(0)
          }}
          title={`${t('align.fit')}｜${t('align.fitHint')}`}
          aria-label={t('align.fit')}
        >
          <ColumnWidthOutlined />
        </button>
      </div>

      {/* ------------------------------------------------ 打轴面板 */}
      {tapMode && (
        <div style={S.tapPanel}>
          <div style={S.tapHeadRow}>
            <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{t('align.tapOn')}</span>
            <span style={S.dim}>{t('align.tapKeys')}</span>
            <span style={{ marginLeft: 'auto' }} />
            <span style={S.dim} className="num">
              {t('align.tapCount', { n: tappedCount })} ・{' '}
              {t('align.tapProgress', {
                pos: Math.min(tapPos, flat.length),
                total: flat.length,
              })}
            </span>
            <button onClick={doTapUndo} disabled={!tapStackLen}>
              <UndoOutlined />
              {t('align.tapBack')}
            </button>
            <button onClick={() => void commitTapDraft()} disabled={!tappedCount}>
              {t('align.tapCommit')}
            </button>
          </div>

          {tapLine ? (
            <>
              <div style={S.chipRow}>
                {tapLine.tokens.map((tk, i) => {
                  const isNext = tapCur !== null && tapCur.tokenIndex === i
                  const d = tapDraft[tokenKey(tapLine.id, i)]
                  const pos = flat.findIndex((f) => f.lineId === tapLine.id && f.tokenIndex === i)
                  return (
                    <div
                      key={i}
                      ref={isNext ? tapChipRef : undefined}
                      className={`kvm-tl-chip${isNext ? ' kvm-tl-next' : ''}`}
                      onClick={() => pos >= 0 && moveTapCursor(pos)}
                      style={{
                        // 「下一个要打的字」用 warn 提示色；已打进草稿的按 manual 语义色，
                        // 与词轨上同一个字的配色保持一致
                        borderColor: isNext
                          ? 'var(--warn)'
                          : d
                            ? SOURCE_META.manual.color
                            : 'var(--stroke-strong)',
                        background: isNext
                          ? `color-mix(in srgb, var(--warn) 18%, var(--bg-surface))`
                          : d
                            ? `color-mix(in srgb, ${SOURCE_META.manual.color} 18%, var(--bg-surface))`
                            : 'var(--bg-surface)',
                        opacity: d || isNext ? 1 : 0.72,
                      }}
                    >
                      <div
                        style={{
                          fontSize: isNext ? 'var(--fs-2xl)' : 'var(--fs-lg)',
                          lineHeight: 1.2,
                        }}
                      >
                        {tk.text}
                      </div>
                      <div className="num" style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-3)' }}>
                        {d ? formatMs(d.start, true) : '—'}
                      </div>
                    </div>
                  )
                })}
              </div>
              {tapNextLine && (
                <div style={{ ...S.dim, marginTop: 2 }}>
                  {t('align.tapNextLine', { text: lineText(tapNextLine) })}
                </div>
              )}
            </>
          ) : (
            <div style={S.dim}>{t('align.tapEnd')}</div>
          )}

          {status.kind !== 'ready' && (
            <div style={{ color: 'var(--warn)' }}>{t('align.tapNoAudio')}</div>
          )}
        </div>
      )}

      {commit.total > 0 && (
        <div className="num" style={{ ...S.bar, color: 'var(--warn)' }}>
          {t('align.committing', { done: commit.done, total: commit.total })}
        </div>
      )}

      {/* ------------------------------------------------ 刻度 + 波形 + 覆盖层 */}
      <div
        ref={hostRef}
        data-role="wave-host"
        style={S.host}
        onPointerDown={(e) => {
          if (e.button === 0) seekAt(e.clientX)
        }}
      >
        <div style={S.rulerClip}>
          <div ref={rulerTrackRef} style={S.track}>
            {ticks.map((tk) => (
              <div
                key={tk.ms}
                style={{
                  position: 'absolute',
                  left: tk.px,
                  bottom: 0,
                  height: tk.major ? 10 : 5,
                  borderLeft: `1px solid ${tk.major ? 'var(--stroke-strong)' : 'var(--stroke)'}`,
                }}
              >
                {tk.label && <span style={S.tickLabel}>{tk.label}</span>}
              </div>
            ))}
          </div>
        </div>

        {/* 波形吃掉时间轴里剩下的高度：分割条往上拖，这里就跟着长高 */}
        <div ref={waveBoxRef} data-role="wave-box" style={S.waveBox}>
          <Waveform
            ref={waveRef}
            sources={sources}
            height={waveH}
            pxPerSec={pxPerSec}
            onStatus={(s) => {
              setStatus(s)
              if (s.kind !== 'ready') return
              setWaveDurationMs(s.durationMs)
              // 第一次拿到真实时长时落到一个**能干活**的缩放上，见 INITIAL_WINDOW_SEC
              if (!zoomInitedRef.current) {
                zoomInitedRef.current = true
                setPxPerSec(
                  clampPxPerSec(
                    viewportRef.current / INITIAL_WINDOW_SEC,
                    fitPxPerSec(s.durationMs, viewportRef.current),
                  ),
                )
              }
            }}
            onScrollPx={handleScrollPx}
          />

          {status.kind !== 'ready' && (
            <div style={S.waveNotice}>
              {status.kind === 'loading'
                ? t('align.waveLoading', { percent: Math.round(status.percent) })
                : status.kind === 'error'
                  ? t('align.waveError', { message: status.message })
                  : t('align.waveNone')}
            </div>
          )}

          {/*
            覆盖层：边界参考线 + 播放头。
            **这里不再有行轨** —— 句子文本已经从时间轴上撤掉（见文件头），
            波形因此整块裸露，参考线也能从顶画到底。
          */}
          <div style={S.overlayClip}>
            <div ref={overlayTrackRef} style={S.track}>
              {/* 当前行的字界参考线：画到波形上，才能对着能量突变去看 */}
              {activeLine?.tokens.map((_, i) => (
                <div
                  key={`guide-${i}`}
                  style={{
                    position: 'absolute',
                    left: scale.msToPx(toAudioMs(effTiming(activeLine, i).start, globalOffset)),
                    top: 0,
                    height: waveH,
                    borderLeft: `1px dashed ${tint('var(--fg-2)', 55)}`,
                    pointerEvents: 'none',
                  }}
                />
              ))}

              {/* 播放头：位置走命令式更新，不进 state，避免每帧重渲 */}
              <div ref={playheadRef} data-role="playhead" style={S.playhead} />
            </div>
          </div>
        </div>

        {/*
          逐字轴。**整首歌的字都画**，不再只画选中的那一句 —— 只画一句时，
          时间轴上到处是空的，看不出前后句的字挨得多近、间奏有多长，
          调轴时也没法把一句的末字和下一句的首字放在一起比。

          唯一的收敛是**按视口时间窗虚拟化**：一首 4-5 分钟的日语歌有 600~900 个
          音节，全部实例化会卡死（§5.10）。`viewWindow` 已经带了预渲染余量，
          滚动时不必每帧重建。

          它与波形共用同一套坐标与同一个平移量，所以拖出来的边界与波形上看到的
          能量突变是严丝合缝的。
        */}
        <div
          style={S.railClip}
          data-role="token-rail"
          // 逐字轴当前落在哪一行。既是排查抓手，也让"正文高亮的行"与
          // "逐字轴在编的行"是否一致这件事可以被外部直接量出来
          data-line={activeLine?.id}
          aria-label={t('align.tokenRail')}
          title={t('align.tokenRailHint')}
        >
          <div ref={railTrackRef} style={S.track}>
            {railLines.map((line) => {
              const lb = effLineBounds(line)
              const isActiveLine = line.id === activeLineId
              return (
                <div key={line.id} style={S.contents}>
                  {/*
                    句柄条（单句级调轴）。只写行号，**不写句子文本**。
                    它接手了原行轨的拖动语义：拖 = 整句平移。
                  */}
                  <div
                    className="kvm-tl-lh"
                    data-role="line-handle"
                    data-line={line.id}
                    data-active={isActiveLine || undefined}
                    title={t('align.lineHandleHint', { no: lineNo.get(line.id) ?? 0 })}
                    onPointerDown={(e) => {
                      // 点句柄 = 选中这一句并把播放位置挪过来（见 selectAndSeek）
                      selectAndSeek({ kind: 'line', lineId: line.id }, lb.start)
                      if (tapMode) {
                        e.stopPropagation()
                        return
                      }
                      beginDrag(e, {
                        kind: 'line',
                        lineId: line.id,
                        index: -1,
                        minDelta: -lb.start,
                        maxDelta: 600_000,
                        linked: false,
                      })
                    }}
                    style={{
                      left: scale.msToPx(toAudioMs(lb.start, globalOffset)),
                      width: scale.durToPx(lb.dur, 6),
                      top: 0,
                      height: LINE_HANDLE_H,
                      color: line.locked ? 'var(--warn)' : 'var(--fg)',
                    }}
                  >
                    {line.locked && <LockOutlined style={S.lineLock} />}
                    {/* 与歌词正文左侧同一个行号 —— 这是"这段属于哪句"所需的最小信息 */}
                    <span className="num">#{lineNo.get(line.id)}</span>
                  </div>

                  {/* 空隙先画，让 token 盖在它上面：斜纹只出现在真正没有字的地方 */}
                  {line.tokens.slice(0, -1).map((_, i) => {
                    const a = effTiming(line, i)
                    const b = effTiming(line, i + 1)
                    const gap = b.start - (a.start + a.dur)
                    if (gap <= 1) return null
                    return (
                      <div
                        key={`gap-${i}`}
                        className="kvm-tl-gap"
                        data-gap={i}
                        title={t('align.gap', { ms: Math.round(gap) })}
                        style={{
                          left: scale.msToPx(toAudioMs(a.start + a.dur, globalOffset)),
                          width: scale.msToPx(gap),
                          top: LINE_HANDLE_H,
                          height: TOKEN_BLOCK_H,
                        }}
                      />
                    )
                  })}

                  {line.tokens.map((tk, i) => {
                    // 变量名不能再叫 t：那会遮住 i18n 的 t()，本行的 title 正要用它
                    const tm = effTiming(line, i)
                    const meta = SOURCE_META[tk.timing_source]
                    const drafted = !!tapDraft[tokenKey(line.id, i)]
                    const isSel =
                      selection.kind === 'token' &&
                      selection.lineId === line.id &&
                      selection.tokenIndex === i
                    const isNext = tapMode && tapCur?.lineId === line.id && tapCur.tokenIndex === i
                    // 打进草稿的字立刻按「手工」显示：它已经有用户给的真实时间了
                    const shown = drafted ? SOURCE_META.manual : meta
                    const widthPx = scale.durToPx(tm.dur, 6)
                    return (
                      <div
                        key={i}
                        className={`kvm-tl-tok${isNext ? ' kvm-tl-next' : ''}`}
                        data-source={drafted ? 'manual' : tk.timing_source}
                        data-line={line.id}
                        data-token-index={i}
                        data-selected={isSel || undefined}
                        /*
                         * 只用 hint，不再拼「label：hint」。两者说的是同一件事，
                         * 拼起来会读成「歌词源：歌词源自带」「手工：手工，重算不覆盖」——
                         * 同一个概念在一行里占两遍，却没多给任何信息。
                         * label 仍用在下方图例上，那里需要的是短名。
                         */
                        title={`${tk.text}｜${t(meta.hintKey)}\n${formatMs(tm.start, true)} + ${Math.round(tm.dur)}ms${
                          tk.locked_timing ? `\n${t('align.locked')}` : ''
                        }`}
                        onPointerDown={(e) => onTokenPointerDown(e, line, i, 'token-move')}
                        style={{
                          left: scale.msToPx(toAudioMs(tm.start, globalOffset)),
                          // 块宽 = 该字时长。minPx 只保底可点击宽度，不改时长本身
                          width: widthPx,
                          top: LINE_HANDLE_H,
                          height: TOKEN_BLOCK_H,
                          background: blockBg(shown, drafted),
                          // 底边是来源色的主载体：块顶到底一条粗边，扫一眼就能读出整行的来源分布
                          border: `1px ${shown.dashed ? 'dashed' : 'solid'} ${tint(shown.color, 70)}`,
                          borderBottom: `3px ${shown.dashed ? 'dashed' : 'solid'} ${shown.color}`,
                          outline: isSel ? '2px solid var(--fg)' : undefined,
                          outlineOffset: isSel ? '-2px' : undefined,
                          // 非当前句压暗一点：整曲铺开之后要一眼看出正在编的是哪一段，
                          // 但**不能藏起来**——看见前后句正是这次改成整曲的目的
                          opacity: isActiveLine ? 1 : 0.62,
                          zIndex: isSel ? 3 : isActiveLine ? 2 : 1,
                        }}
                      >
                        <span style={S.tokText}>{tk.text}</span>
                        {/* 窄块塞不下起点时间，硬塞只会得到一截被裁掉的数字 */}
                        {widthPx >= 56 && (
                          <span className="num" style={S.tokTime}>
                            {formatMs(tm.start, true)}
                          </span>
                        )}
                        {tk.locked_timing && <LockOutlined style={S.lock} />}
                        <div
                          className="kvm-tl-hnd"
                          style={{ left: 0 }}
                          onPointerDown={(e) => onTokenPointerDown(e, line, i, 'token-start')}
                        />
                        <div
                          className="kvm-tl-hnd"
                          style={{ right: 0 }}
                          onPointerDown={(e) => onTokenPointerDown(e, line, i, 'token-end')}
                        />
                      </div>
                    )
                  })}
                </div>
              )
            })}

            <div ref={railPlayheadRef} data-role="playhead" style={S.playhead} />
          </div>

          {railLines.length === 0 && <div style={S.waveNotice}>{t('align.railEmpty')}</div>}
        </div>

        {/*
          概览条：整曲导航 + **换句的入口**。
          行轨拆掉之后，"在时间轴上切到另一句"就落在这里：点某一块 = 选中那一行，
          逐字轴随之切过去（选中项会被既有的 effect 滚进视口）。点空白仍是纯导航。
        */}
        <div
          style={S.overview}
          data-role="overview"
          onPointerDown={(e) => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            const ms = ((e.clientX - rect.left) / rect.width) * durationMs
            const target = clampScroll(scrollToCenter(ms, viewportPx, scale), viewportPx, contentPx)
            waveRef.current?.setScrollPx(target)
            handleScrollPx(target)
          }}
        >
          {project.lines.map((l) => {
            // 制作名单行不上概览条，理由与逐字轴相同（都挤在开头几十毫秒里）
            if (l.is_metadata || !l.tokens.length) return null
            const b = lineBounds(l)
            const isActive = l.id === activeLineId
            /*
             * 「正在唱」不再单独画一种高亮。选中与播放位置已经是同一件事
             * （点哪儿播放头跳哪儿、播放推进时选中跟着走），再画两种颜色只会
             * 让人以为它们可能不一样。属性留着当排查与验收的抓手。
             */
            const isPlaying = l.id === playheadLineId
            return (
              <div
                key={l.id}
                className="kvm-tl-ov"
                data-line={l.id}
                data-active={isActive || undefined}
                data-playing={isPlaying || undefined}
                // title 里只有行号与时间，**不放句子文本** —— 句子是右侧正文的活
                title={t('align.overviewLine', {
                  no: lineNo.get(l.id) ?? 0,
                  start: formatMs(b.start, true),
                })}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  selectAndSeek({ kind: 'line', lineId: l.id }, b.start)
                }}
                style={{
                  left: `${(toAudioMs(b.start, globalOffset) / durationMs) * 100}%`,
                  width: `${Math.max(0.15, (b.dur / durationMs) * 100)}%`,
                  top: 6,
                  height: OVERVIEW_H - 12,
                  background: isActive ? 'var(--accent)' : tint('var(--fg-2)', 50),
                }}
              />
            )
          })}
          <div ref={overviewBoxRef} style={S.overviewBox} />
        </div>
      </div>

      {/* ------------------------------------------------ 图例 + 状态 */}
      <div style={S.bar}>
        <span style={S.dim}>{t('align.sources')}</span>
        {(Object.keys(SOURCE_META) as Array<Token['timing_source']>).map((k) => (
          <span key={k} title={t(SOURCE_META[k].hintKey)} style={S.legendItem}>
            {/* data-source 既是给自动化测试的抓手，也让「这一格用的是哪个 --src-* 」
                在 devtools 里一眼可查 */}
            <span
              data-source={k}
              style={{
                width: 14,
                height: 10,
                borderRadius: 'var(--r-sm)',
                border: `1px ${SOURCE_META[k].dashed ? 'dashed' : 'solid'} ${SOURCE_META[k].color}`,
                background: blockBg(SOURCE_META[k], false),
                display: 'inline-block',
              }}
            />
            {t(SOURCE_META[k].labelKey)}
          </span>
        ))}
        <span style={S.dim}>
          <LockOutlined />
          {t('align.locked')}
        </span>

        <span style={{ marginLeft: 'auto' }} />
        {/*
          这里**不再重复"选中了哪个字、起点多少"** —— 舞台底栏的检查器给的是同一个词
          的时间与读音，两处各说一遍就是这次重做要消灭的"同一信息多处出现"。
        */}
        <span style={S.dim}>{t('align.keys', { step: NUDGE_MS, fine: NUDGE_FINE_MS })}</span>
      </div>

      {storeError && (
        <div style={{ ...S.bar, color: 'var(--danger)' }}>
          {t('align.backendError', { message: storeError })}
        </div>
      )}

      {/* 拖动时的数值实时预览 */}
      {dragging && dragRef.current && (
        <div style={{ ...S.tip, left: dragUI.x + 14, top: dragUI.y + 16 }}>
          {dragPreviewText(dragRef.current, dragUI.delta, project.lines, effTiming)}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 渲染辅助

function dragPreviewText(
  cfg: DragConfig,
  delta: number,
  lines: Line[],
  eff: (line: Line, index: number) => Timing,
): string {
  const line = lines.find((l) => l.id === cfg.lineId)
  if (!line || !line.tokens.length) return formatDeltaMs(delta)
  if (cfg.kind === 'line') {
    const b = eff(line, 0)
    return t('align.dragLine', {
      delta: formatDeltaMs(delta),
      start: formatMs(b.start, true),
    })
  }
  const timing = eff(line, cfg.index)
  return t('align.dragToken', {
    text: line.tokens[cfg.index]?.text ?? '',
    delta: formatDeltaMs(delta),
    start: formatMs(timing.start, true),
    dur: Math.round(timing.dur),
  })
}

// ---------------------------------------------------------------- 样式

/**
 * 内联样式。**颜色 / 间距 / 圆角 / 字号 / 边框一律取 `styles.css` 的 token**，
 * 不再出现字面量（docs/ui-redesign.md §六点五）。
 *
 * 仍是数字的只有轨道几何：`RULER_H` / `WAVE_H` / `TOKEN_STRIP_*` / `OVERVIEW_H`
 * 以及把手宽度、播放头线宽。它们要和波形 canvas 的像素高度严丝合缝地对上，
 * 属于结构尺寸而不是间距刻度，套 `--sp-*` 只会让覆盖层和波形错位。
 */
const S: Record<string, CSSProperties> = {
  /*
   * 整条时间轴撑满分割条给的高度，波形那一格再吃掉其中的剩余空间。
   * `minHeight: 0` 是这条链的必要条件（docs/ui-redesign.md §七点五）——
   * 少写它的话 host 会被内容顶到自然高度，波形就永远只有 min 那么高。
   */
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--sp-2)',
    background: 'var(--bg-panel)',
    padding: 'var(--sp-2)',
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
  },
  bar: { display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' },
  sep: { width: 1, height: 18, background: 'var(--stroke)', margin: '0 var(--sp-1)' },
  dim: { color: 'var(--fg-2)', display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-1)' },
  host: {
    position: 'relative',
    overflow: 'hidden',
    border: 'var(--hairline)',
    borderRadius: 'var(--r-md)',
    background: 'var(--bg-canvas)',
    flex: '1 1 auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  /** 波形格：刻度/逐字轴/概览都是定高的，剩下的全归它 */
  waveBox: {
    position: 'relative',
    flex: '1 1 auto',
    minHeight: MIN_WAVE_H,
    background: 'var(--bg-canvas)',
  },
  rulerClip: {
    position: 'relative',
    flex: `0 0 ${RULER_H}px`,
    height: RULER_H,
    overflow: 'hidden',
    background: 'var(--bg-panel)',
  },
  overlayClip: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' },
  /**
   * 逐字轴的裁剪容器。它**不设 pointerEvents:none**（波形覆盖层要那样是因为
   * 点空白处得能落到波形上去 seek），这里的空白落到 host 上同样是 seek，
   * 而块本身要能拖，所以整块都收事件。
   */
  railClip: {
    position: 'relative',
    flex: `0 0 ${TOKEN_RAIL_H}px`,
    height: TOKEN_RAIL_H,
    overflow: 'hidden',
    borderTop: 'var(--hairline)',
    background: 'var(--bg-panel)',
  },
  track: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, willChange: 'transform' },
  /**
   * 逐字轴按行分组只是为了 React 的 key 稳定（行增删时不会整片重建），
   * 视觉上不该多出一层盒子——里面全是绝对定位的块，套一个 static 的 div
   * 会把它们的定位基准从轨道换成这层，整轨错位。`display: contents` 让这层
   * 只存在于 React 的树里、不进布局。
   */
  contents: { display: 'contents' },
  tickLabel: {
    position: 'absolute',
    left: 3,
    top: -13,
    color: 'var(--fg-3)',
    fontSize: 'var(--fs-xs)',
    fontVariantNumeric: 'tabular-nums',
  },
  playhead: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    background: 'var(--danger)',
    pointerEvents: 'none',
  },
  waveNotice: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--fg-2)',
    pointerEvents: 'none',
  },
  tokText: {
    fontSize: 'var(--fs-xl)',
    lineHeight: 1.1,
    pointerEvents: 'none',
    textShadow: '0 1px 2px rgb(0 0 0 / 0.9)',
    whiteSpace: 'nowrap',
  },
  /** 每个块自报起点：调轴时要对的就是这个数，读它比把鼠标悬上去看 title 快得多 */
  tokTime: {
    fontSize: 'var(--fs-xs)',
    color: 'var(--fg-2)',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
  lock: {
    position: 'absolute',
    top: 1,
    right: 2,
    fontSize: 'var(--fs-xs)',
    color: 'var(--fg)',
    pointerEvents: 'none',
  },
  lineLock: { marginRight: 2, fontSize: 'var(--fs-xs)' },
  overview: {
    position: 'relative',
    flex: `0 0 ${OVERVIEW_H}px`,
    height: OVERVIEW_H,
    overflow: 'hidden',
    background: 'var(--bg-canvas)',
    borderTop: 'var(--hairline)',
    cursor: 'pointer',
  },
  overviewBox: {
    position: 'absolute',
    left: 0,
    width: '100%',
    top: 0,
    bottom: 0,
    border: '1px solid var(--accent)',
    background: 'var(--accent-weak)',
    borderRadius: 'var(--r-sm)',
    pointerEvents: 'none',
  },
  tapPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--sp-1)',
    padding: 'var(--sp-2)',
    // 打轴是个模式，需要整块面板被认出来；用 warn 调和面板底色，
    // 而不是另配一组棕黄，饱和色预算只留给来源徽章（§六）
    border: '1px solid color-mix(in srgb, var(--warn) 45%, var(--stroke))',
    borderRadius: 'var(--r-md)',
    background: 'color-mix(in srgb, var(--warn) 8%, var(--bg-surface))',
  },
  tapHeadRow: { display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' },
  chipRow: { display: 'flex', gap: 'var(--sp-1)', overflowX: 'auto', padding: 'var(--sp-1) 0' },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
    color: 'var(--fg-2)',
  },
  todo: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px var(--sp-2)',
    borderRadius: 'var(--r-pill)',
    border: '1px dashed var(--fg-3)',
    background: 'color-mix(in srgb, var(--fg-3) 16%, transparent)',
    color: 'var(--fg-2)',
  },
  tip: {
    position: 'fixed',
    zIndex: 50,
    padding: 'var(--sp-1) var(--sp-2)',
    background: 'var(--bg-surface)',
    border: 'var(--hairline-strong)',
    borderRadius: 'var(--r-sm)',
    color: 'var(--fg)',
    boxShadow: 'var(--shadow-1)',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
}

export default Timeline
