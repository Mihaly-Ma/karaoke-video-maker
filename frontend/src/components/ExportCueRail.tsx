/**
 * 导出前抽查用的「关键位置」跳转条。
 *
 * ## 为什么需要它
 *
 * 烧一条 4K 全片要几分钟，用户在导出前想看的从来不是"从头放一遍"，而是
 * **抽查几个最容易出问题的位置**：第一句的引导点在不在、间奏之后有没有从上行
 * 重新开始、制作名单那一屏会不会和歌词叠上、最长的那行有没有被拆坏。
 * 只给一条进度条等于让用户自己去找这些位置。
 *
 * ## 位置从哪来
 *
 * 全部由工程数据现算，**复用后端 ass_builder 的同一套判据**，这样跳过去看到的
 * 才是成片里真实发生的事：
 *
 * - 段落切分用 `_assign_slots` 的规则：与前一行的间隔 ≥ `paragraph_gap_ms` 即新段落。
 *   这同时是引导点出现的条件与槽位归零的条件，所以"间奏后"是必查点。
 * - 制作名单窗口用 `_find_credit_window` 的规则：优先片头空档，放不下就找行间
 *   第一个够长的间隙；边界按**字幕实际出现/消失**算而不是开唱时间。
 * - 最长行 / 注音最密行是版面风险点（拆行、注音溢出重排）。
 *
 * 有一处刻意的近似：后端会先 `_split_wide_lines` 再找名单窗口，而拆行依赖
 * libass 实测字宽，前端拿不到。拆行只在原行内部引入新边界，不会改变行与行之间
 * 的间隙，所以段落与名单窗口的判定不受影响。
 *
 * ## 时间基准
 *
 * 输出的 `atMs` 是**音频时间**（`playheadMs` 的基准），已经加过
 * `global_offset_ms`（见 lib/timeScale 的两套基准说明）。
 */

import { AimOutlined } from '@ant-design/icons'

import type { Line, Project } from '../api/types'
import { t } from '../i18n'
import { formatMs, toAudioMs } from '../lib/timeScale'

/** 与 ass_builder `_find_credit_window` 的默认参数一致，改动要两边一起改 */
const CREDIT_MIN_DUR_MS = 4500
const CREDIT_PAD_MS = 600

/** 两个位置挨得太近就没有分别跳的意义，保留优先级高的那个 */
const CUE_MERGE_MS = 1500

export type CueKind = 'credits' | 'first' | 'paragraph' | 'widest' | 'ruby' | 'end'

export interface Cue {
  id: string
  kind: CueKind
  /** 音频时间（毫秒），可直接写进 `playheadMs` */
  atMs: number
  /** 该位置的歌词片段，用来认出"这是不是副歌" */
  snippet: string
}

const CUE_LABEL: Record<CueKind, string> = {
  credits: 'export.cueCredits',
  first: 'export.cueFirst',
  paragraph: 'export.cueParagraph',
  widest: 'export.cueWidest',
  ruby: 'export.cueRuby',
  end: 'export.cueEnd',
}

const lineText = (ln: Line): string => ln.tokens.map((tk) => tk.text).join('')
const lineStart = (ln: Line): number => ln.tokens[0].start_ms
const lineEnd = (ln: Line): number => {
  const last = ln.tokens[ln.tokens.length - 1]
  return last.start_ms + last.dur_ms
}

/**
 * 行宽的粗略当量：全角算 2、半角算 1。
 *
 * 真实字宽只有 libass 量得准（CLAUDE.md §9 P0-2），但这里只是**排序**用来挑出
 * 最长的一行，不参与任何排版决策，量纲一致就够了。
 */
function lineWeight(ln: Line): number {
  let w = 0
  for (const ch of lineText(ln)) w += ch.codePointAt(0)! > 0x2e80 ? 2 : 1
  return w
}

/**
 * 名单窗口：片头空档放得下就放片头，否则找行间第一个够长的间隙。
 * 返回窗口起点的音频时间；找不到返回 null（该曲不显示制作名单）。
 */
function creditAt(singable: Line[], project: Project): number | null {
  const st = project.style
  const off = project.global_offset_ms
  const headEnd = lineStart(singable[0]) + off - st.lead_in_ms
  if (headEnd >= CREDIT_MIN_DUR_MS + CREDIT_PAD_MS) return 0

  for (let i = 0; i + 1 < singable.length; i++) {
    const g0 = lineEnd(singable[i]) + off + st.lead_out_ms
    const g1 = lineStart(singable[i + 1]) + off - st.max_lead_ms
    if (g1 - g0 >= CREDIT_MIN_DUR_MS + CREDIT_PAD_MS * 2) return g0 + CREDIT_PAD_MS
  }
  return null
}

/**
 * 跳到某一句时要往前留一点：引导点在开唱前 `countdown_dots × countdown_beat_ms`
 * 就亮起，正踩在开唱那一刻跳过去只会看到点已经灭完。
 */
function prerollMs(project: Project): number {
  const st = project.style
  const want = st.lead_in_ms + st.countdown_dots * st.countdown_beat_ms
  return Math.min(Math.max(want, 800), Math.max(800, st.max_lead_ms))
}

export function buildCues(project: Project | null): Cue[] {
  if (!project) return []
  const singable = project.lines.filter((ln) => !ln.is_metadata && ln.tokens.length > 0)
  if (singable.length === 0) return []

  const off = project.global_offset_ms
  const pre = prerollMs(project)
  const maxMs = Math.max(0, project.duration_ms)
  const clamp = (ms: number): number => Math.min(Math.max(0, Math.round(ms)), maxMs)

  // 段落切分：与前一行的间隔 ≥ paragraph_gap_ms 即新段落（= 槽位归零 = 引导点重现）
  const paragraphHeads: Line[] = []
  let prevEnd: number | null = null
  for (const ln of singable) {
    if (prevEnd === null || lineStart(ln) - prevEnd >= project.style.paragraph_gap_ms) {
      paragraphHeads.push(ln)
    }
    prevEnd = lineEnd(ln)
  }

  // 并列时取先出现的那条：跳转条按时间排序，靠前的更接近用户"先看哪里"的直觉
  let widest = singable[0]
  let widestWeight = lineWeight(widest)
  let densest = singable[0]
  for (const ln of singable) {
    const w = lineWeight(ln)
    if (w > widestWeight) {
      widest = ln
      widestWeight = w
    }
    if (ln.ruby.length > densest.ruby.length) densest = ln
  }

  // 按优先级生成，靠得太近的低优先级项直接丢掉——同一个位置摆两个按钮没有意义
  const out: Cue[] = []
  const push = (kind: CueKind, atMs: number, snippet: string): void => {
    const at = clamp(atMs)
    if (out.some((c) => Math.abs(c.atMs - at) < CUE_MERGE_MS)) return
    out.push({ id: `${kind}-${at}`, kind, atMs: at, snippet })
  }

  // 结构位（第一句 / 间奏后）优先级最高：它们是"抽查一首歌"最先要看的地方，
  // 与别的位置撞车时留下的必须是它们。
  push('first', toAudioMs(lineStart(paragraphHeads[0]), off) - pre, lineText(paragraphHeads[0]))
  for (const head of paragraphHeads.slice(1)) {
    push('paragraph', toAudioMs(lineStart(head), off) - pre, lineText(head))
  }

  const credit = creditAt(singable, project)
  if (credit !== null) push('credits', credit, `${project.title} / ${project.artist}`.trim())

  const last = singable[singable.length - 1]
  push('end', toAudioMs(lineStart(last), off) - project.style.lead_in_ms, lineText(last))
  push('widest', toAudioMs(lineStart(widest), off) - project.style.lead_in_ms, lineText(widest))
  if (densest.ruby.length > 0) {
    push('ruby', toAudioMs(lineStart(densest), off) - project.style.lead_in_ms, lineText(densest))
  }

  return out.sort((a, b) => a.atMs - b.atMs)
}

export interface ExportCueRailProps {
  cues: Cue[]
  onJump: (ms: number) => void
}

export default function ExportCueRail({ cues, onJump }: ExportCueRailProps) {
  return (
    <div className="exp-cues">
      <span className="exp-cues__label">
        <AimOutlined /> {t('export.cues')}
      </span>
      {cues.length === 0 ? (
        <span className="muted">{t('export.cuesEmpty')}</span>
      ) : (
        <div className="exp-cues__list">
          {cues.map((cue) => (
            <button
              key={cue.id}
              type="button"
              className="exp-cue"
              title={cue.snippet}
              onClick={() => onJump(cue.atMs)}
            >
              <span className="exp-cue__top">
                <span className="exp-cue__kind">{t(CUE_LABEL[cue.kind])}</span>
                <span className="exp-cue__time">{formatMs(cue.atMs)}</span>
              </span>
              <span className="exp-cue__snippet">{cue.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
