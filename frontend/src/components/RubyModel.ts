/**
 * 注音舞台的纯逻辑层：把工程数据整理成「可点的词」，并处理读音的两种形态。
 *
 * 拆出来是因为舞台本身（RubyEditor）与辅助栏（RubyInspector）要看同一份切分结果，
 * 而这份切分有真正的规则在里面——它决定了用户点一下选中的是「食べる」还是「食」。
 * 规则全部建立在 lib/kana.ts 上，这里不重复实现任何假名知识。
 */

import type { Line, RubySpan } from '../api/types'
import { useProject } from '../state/projectStore'
import {
  buildRenderGroups,
  charClass,
  containsKanji,
  segmentSurface,
  toCodePoints,
  toHiragana,
  toKatakana,
} from '../lib/kana'

// ---- 来源 ----

/**
 * 界面上区分的四档来源。
 *
 * 后端 `ReadingSource` 有六个值，但用户要回答的问题只有一个：**这条要不要我复核**。
 * 所以 `dict`/`dict_user` 合成「词典」，`morph`/`acoustic` 合成「推断」——
 * 前者查得到条目、后者是猜的，这条界线才是决定要不要逐条核对的那一条。
 */
export type SourceKey = 'provider' | 'dict' | 'guess' | 'manual' | 'none'

export function sourceKey(source: string): SourceKey {
  switch (source) {
    case 'provider_kana':
      return 'provider'
    case 'dict':
    case 'dict_user':
      return 'dict'
    case 'manual':
      return 'manual'
    case 'morph':
    case 'acoustic':
      return 'guess'
    default:
      // 后端加了新来源而界面还不认识时按「需复核」处理：
      // 当作可信的一档会让用户漏掉真正该看的东西
      return 'guess'
  }
}

/** 四档来源在界面上的出现顺序（图例、统计都按这个顺序） */
export const SOURCE_ORDER: readonly SourceKey[] = ['provider', 'dict', 'guess', 'manual']

/** 图例、徽章、清单共用同一批文案键，免得同一个来源在三处叫三个名字 */
export const SOURCE_LABEL_KEY: Record<SourceKey, string> = {
  provider: 'source.provider',
  dict: 'ruby.src.dict',
  guess: 'ruby.src.guess',
  manual: 'source.manual',
  none: 'ruby.src.missing',
}

// ---- 词单元 ----

export type UnitKind = 'kanji' | 'kana' | 'other'

/**
 * 一个可点击的「词」。
 *
 * 边界由两件事共同决定：已有的注音区间（`RubySpan`，可能横跨汉字与送り仮名，
 * 例如整词注音的「食べる」），以及 surface 的汉字/假名分段。二者的并集就是
 * 用户心里的「一个词」——点「食」应该连「べる」一起选中（如果它们共用一条注音），
 * 而没有注音的地方按汉字块 / 假名串各自成词。
 */
export interface RubyUnit {
  lineId: string
  /** 行内码点下标，左闭右开。与后端 `RubySpan.start/end` 同一口径 */
  start: number
  end: number
  /** 书写形式 */
  text: string
  /** 指向 `line.ruby` 的下标；-1 表示这一段没有注音 */
  spanIndex: number
  span: RubySpan | null
  /** 首字符所属 token 下标，用于把全局选中同步过去 */
  tokenIndex: number
  /**
   * 末字符所属 token 下标 + 1（左闭右开）。
   *
   * 有了它，「选中词」才能同时给出**时间**（跨这些 token 的起止）与**读音**——
   * 合并后的编辑舞台正是靠这一条把两半接在同一个选中项上。只有起点下标的话，
   * 整词注音的「食べる」在时间栏里只能显示「食」那一拍。
   */
  tokenEnd: number
  kind: UnitKind
  /** 该注音的来源档位；没有注音时为 `none` */
  src: SourceKey
  /** 有汉字却没有注音——渲染出来会是一片没有读音的汉字，必须让用户看见 */
  missing: boolean
  /** 机器推断且用户没锁过，需要逐条核对 */
  guess: boolean
}

/** 单元的稳定标识。行 id 是 UUID，不含冒号，可以直接拼。 */
export const unitKey = (u: Pick<RubyUnit, 'lineId' | 'start' | 'end'>): string =>
  `${u.lineId}:${u.start}:${u.end}`

export const lineIdOfKey = (key: string): string => key.slice(0, key.indexOf(':'))

/** 行的完整书写文本，按码点拆开。后端 `Line.text` 也是这么拼的。 */
export const lineChars = (line: Line): string[] =>
  toCodePoints(line.tokens.map((t) => t.text).join(''))

function unitKindOf(text: string): UnitKind {
  const first = toCodePoints(text)[0] ?? ''
  const k = charClass(first)
  if (k === 'kanji') return 'kanji'
  if (k === 'hiragana' || k === 'katakana' || k === 'prolonged') return 'kana'
  return 'other'
}

export function buildUnits(line: Line): RubyUnit[] {
  const chars = lineChars(line)
  if (chars.length === 0) return []

  // 字符 → token 下标：点一个字要能把全局选中挪到对应的词上
  const tokenOfChar: number[] = []
  line.tokens.forEach((t, i) => toCodePoints(t.text).forEach(() => tokenOfChar.push(i)))

  // 字符 → 分段下标：用来判断两个相邻的未注音字符要不要并成一个词
  const segOfChar: number[] = []
  segmentSurface(chars.join('')).forEach((s, i) => {
    for (let k = s.start; k < s.end; k++) segOfChar[k] = i
  })

  const units: RubyUnit[] = []
  for (const g of buildRenderGroups(chars, line.ruby)) {
    const span = g.spanIndex >= 0 ? (line.ruby[g.spanIndex] ?? null) : null
    if (!span) {
      // buildRenderGroups 对未注音区间是逐字符输出的，这里按分段并回词
      const last = units[units.length - 1]
      if (last && last.spanIndex < 0 && last.end === g.start && segOfChar[last.end - 1] === segOfChar[g.start]) {
        last.end = g.end
        last.text += g.text
        last.tokenEnd = (tokenOfChar[g.end - 1] ?? last.tokenIndex) + 1
        continue
      }
    }
    const kind = unitKindOf(g.text)
    units.push({
      lineId: line.id,
      start: g.start,
      end: g.end,
      text: g.text,
      spanIndex: g.spanIndex,
      span,
      tokenIndex: tokenOfChar[g.start] ?? 0,
      tokenEnd: (tokenOfChar[g.end - 1] ?? tokenOfChar[g.start] ?? 0) + 1,
      kind,
      src: span ? sourceKey(span.source) : 'none',
      missing: !span && containsKanji(g.text),
      guess: !!span && !span.locked && sourceKey(span.source) === 'guess',
    })
  }
  return units
}

/**
 * 给定这些行的切分结果，按行 id 索引。Map 保持行序，待检查清单直接按它遍历。
 *
 * 收的是**行数组而不是整个工程**：注音舞台默认把制作名单行排除在正文之外，
 * 而统计、待检查清单、候选读音必须跟着同一份可见集合走。若这里仍按整个工程算，
 * 就会出现「待检查 8 处」而正文里一处也找不到——用户没有任何办法把它清空。
 */
export function buildProjectUnits(lines: readonly Line[]): Map<string, RubyUnit[]> {
  const m = new Map<string, RubyUnit[]>()
  for (const line of lines) m.set(line.id, buildUnits(line))
  return m
}

/** 这个单元能不能挂注音：纯假名挂了会渲染出「あ|あ」这种冗余标注（CLAUDE.md §4.2）。 */
export const canAnnotate = (u: RubyUnit): boolean => containsKanji(u.text) || u.kind === 'other'

/**
 * 找出覆盖某个 token 的词。
 *
 * 时间轴上选中的是 **token**，而注音挂在**词**（行内字符区间）上，两者粒度不同：
 * 「明日」两个字共用「あした」时是一个词、两个 token。合并后的编辑舞台要让
 * "在逐字轴上点一个字，歌词正文与检查器跟着落到同一处"，这一步换算就发生在这里。
 */
export function unitOfToken(units: readonly RubyUnit[], tokenIndex: number): RubyUnit | null {
  return units.find((u) => u.tokenIndex <= tokenIndex && tokenIndex < u.tokenEnd) ?? null
}

// ---- 表记读法 与 发音形 ----

/**
 * 助词的书写形与发音形不一致的三个字。这是 CLAUDE.md §4.2 要求两份读音同时存在的
 * 直接理由：注音行要显示「は」，喂给对齐器的必须是 /wa/。
 */
const PARTICLE_PHONETIC: Record<string, string> = { ハ: 'ワ', ヘ: 'エ', ヲ: 'オ' }

/**
 * 由表记读法推出发音形。
 *
 * 只做两件确定的事：规范成片假名、把整词就是助词的三个字换成实际发音。
 * **不猜长音**——「おう」在「王」是长音、在「問う」是两拍，纯假名串无法确定性还原
 * （CLAUDE.md §9 第 7 项，这条要靠 pyopenjtalk 才有定论）。猜错比不猜更糟：
 * 发音形是喂强制对齐的，错了会把整句轴带偏。
 */
export function derivePhonetic(reading: string): string {
  const k = toKatakana(reading)
  return PARTICLE_PHONETIC[k] ?? k
}

/**
 * 发音形的本地存储。
 *
 * **后端的 `RubySpan` 目前只有 `text` 一个读音字段**，没有 CLAUDE.md §4.2 要求的
 * `reading_display` / `reading_phonetic` 两份。发音形因此暂存在浏览器里，
 * 键是「工程 + 行 + 字符区间 + 书写形」——带上书写形是为了在行文本变了之后
 * 认出这条已经对不上，直接忽略而不是错配到别的词上。
 *
 * 这是过渡措施，后端补上字段后本模块整体替换成 API 调用，界面不用改。
 */
const phoneticStoreKey = (projectId: string) => `kvm.phonetic.${projectId}`

export const phoneticKey = (u: RubyUnit): string => `${unitKey(u)}:${u.text}`

export function loadPhonetics(projectId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(phoneticStoreKey(projectId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    // 存储被禁用或内容损坏时按「没有覆盖」处理，不要让整个舞台打不开
    return {}
  }
}

export function persistPhonetics(projectId: string, map: Record<string, string>): void {
  try {
    localStorage.setItem(phoneticStoreKey(projectId), JSON.stringify(map))
  } catch {
    /* 存储不可用时静默降级：发音形本轮仍然可编辑，只是不跨会话保留 */
  }
}

// ---- 候选读音 ----

/**
 * 给选中词凑一批候选读音。
 *
 * 最有用的一类是**同一首歌里同一个词的其它读法**：日语当て字往往整首统一
 * （「運命」通篇唱 さだめ），一处改对了，其余同形词直接一键跟上。
 * 其次才是平/片假名互转——「本気 → マジ」这种片假名注音是原文意图，
 * 不能自动归一，但要让用户一键切过去。
 */
export function readingCandidates(
  units: Map<string, RubyUnit[]>,
  target: RubyUnit,
  current: string,
): string[] {
  const seen = new Set<string>([current])
  const out: string[] = []
  const push = (s: string) => {
    if (!s || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }

  for (const list of units.values()) {
    for (const u of list) {
      if (u.text !== target.text || !u.span) continue
      if (u.lineId === target.lineId && u.start === target.start) continue
      push(u.span.text)
    }
  }
  if (current) {
    push(toHiragana(current))
    push(toKatakana(current))
  }
  return out.slice(0, 8)
}

// ---- 锁定 ----

/**
 * 切换某段注音的锁定标记（CLAUDE.md §4.4：自动重算只覆盖 `locked=false` 的项）。
 *
 * **走 store 而不是直接打后端。** 曾经这里自己 fetch，是为了绕开 `client.ts` 里
 * 形状写错的 `setLock`；那个 bug 修掉之后绕行就只剩坏处——store 每次写入后会
 * 重新拉一次历史深度，绕过去撤销/重做按钮就不会刷新，锁一次注音后撤销按钮的
 * 可用状态要滞后一拍才对得上。
 */
export async function setRubyLock(
  projectId: string,
  lineId: string,
  range: [number, number],
  locked: boolean,
): Promise<void> {
  // store 只认它当前打开的那个工程。对不上说明调用方拿的是过期的 projectId，
  // 继续写下去会把锁打到别的工程上
  if (useProject.getState().project?.id !== projectId) return
  await useProject.getState().setLock({ target: 'ruby', line_id: lineId, ruby_range: range, locked })
  // store 把失败收进自己的 error 字段（其余动作都靠它显示错误），这里再抛一次，
  // 让调用方原有的"就地提示"路径继续成立
  const err = useProject.getState().error
  if (err) throw new Error(err)
}
