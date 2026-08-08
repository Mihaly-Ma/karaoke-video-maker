/**
 * 假名工具：字符分类、平/片假名互转、归一化、mora 切分、读音校验、
 * 以及「整词读音 → 逐汉字块注音」的送り仮名切分。
 *
 * 全部是本地规则实现的纯函数。CLAUDE.md §2.1 禁止云端推理，注音链路不得联网；
 * 这里也刻意不引入任何第三方依赖（jaconv 是 Python 侧的，前端要自己有一份）。
 *
 * **索引口径（重要）**：本模块所有下标都以 **Unicode 码点** 为单位，
 * 与后端 Python 的字符串下标一致。JS 原生的 `str[i]` / `slice` 是 UTF-16 码元，
 * 遇到 CJK 扩展 B 区汉字（歌手名、人名用字里真会出现）就会与后端错位，
 * 而 `RubySpan.start/end` 是要发给后端的字符区间——错一个位就注错字。
 * 所以凡是要算下标的地方，一律先 `toCodePoints()` 拆成码点数组再算。
 */

// ---- 码点区间常量 ----

const HIRAGANA_MIN = 0x3041
const HIRAGANA_MAX = 0x3096
const KATAKANA_MIN = 0x30a1
const KATAKANA_MAX = 0x30f6
/** 平假名与片假名在 Unicode 上的固定间距 */
const KANA_GAP = 0x60

/** ゝゞ（平假名叠字）与 ヽヾ（片假名叠字），同样相隔 0x60 */
const HIRA_ITERATION = [0x309d, 0x309e]
const KATA_ITERATION = [0x30fd, 0x30fe]

/** 长音符号「ー」与其半角形 */
const PROLONGED_MARKS = new Set(['ー', 'ｰ'])

// ---- 字符分类 ----

export type CharClass =
  | 'hiragana'
  | 'katakana'
  /** 长音符号「ー」。书写上归假名，但拍数上自成一拍 */
  | 'prolonged'
  | 'kanji'
  | 'latin'
  | 'digit'
  | 'space'
  | 'punct'
  | 'other'

/** 把字符串拆成码点数组。所有下标运算的入口。 */
export function toCodePoints(text: string): string[] {
  return Array.from(text)
}

function codePoint(ch: string): number {
  return ch.codePointAt(0) ?? 0
}

export function charClass(ch: string): CharClass {
  if (!ch) return 'other'
  const c = codePoint(ch)

  if (PROLONGED_MARKS.has(ch)) return 'prolonged'
  if (c >= HIRAGANA_MIN && c <= HIRAGANA_MAX) return 'hiragana'
  if (HIRA_ITERATION.includes(c)) return 'hiragana'
  // 30A1–30FA 含 ヷヸヹヺ；31F0–31FF 是小写片假名扩展（ㇰㇱ 等，アイヌ語用）
  if (c >= KATAKANA_MIN && c <= 0x30fa) return 'katakana'
  if (KATA_ITERATION.includes(c)) return 'katakana'
  if (c >= 0x31f0 && c <= 0x31ff) return 'katakana'
  // 半角片假名 ｦ–ﾝ（浊点 ﾞﾟ 归 punct，归一化后会被合成掉）
  if (c >= 0xff66 && c <= 0xff9d) return 'katakana'

  // 汉字：々〆〇 + 扩展A + 基本区 + 兼容区 + 扩展B 以上（需按码点判断，不能按 UTF-16）
  if (c === 0x3005 || c === 0x3006 || c === 0x3007) return 'kanji'
  if (c >= 0x3400 && c <= 0x4dbf) return 'kanji'
  if (c >= 0x4e00 && c <= 0x9fff) return 'kanji'
  if (c >= 0xf900 && c <= 0xfaff) return 'kanji'
  if (c >= 0x20000 && c <= 0x3ffff) return 'kanji'

  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return 'latin'
  // 全角拉丁字母
  if ((c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a)) return 'latin'
  if (c >= 0x30 && c <= 0x39) return 'digit'
  if (c >= 0xff10 && c <= 0xff19) return 'digit'

  if (ch === ' ' || ch === '　' || ch === '\t' || ch === '\n' || ch === '\r') return 'space'
  if (c < 0x80) return 'punct'
  // 日文标点、全角符号、中文标点
  if (c >= 0x3000 && c <= 0x303f) return 'punct'
  if (c >= 0xff01 && c <= 0xff65) return 'punct'
  if (c >= 0x2000 && c <= 0x206f) return 'punct'

  return 'other'
}

export function isKanji(ch: string): boolean {
  return charClass(ch) === 'kanji'
}

/** 假名（含长音符号与叠字符）。注音文本必须整串通过这一判定。 */
export function isKana(ch: string): boolean {
  const k = charClass(ch)
  return k === 'hiragana' || k === 'katakana' || k === 'prolonged'
}

export function containsKanji(text: string): boolean {
  return toCodePoints(text).some(isKanji)
}

export function isAllKana(text: string): boolean {
  const cps = toCodePoints(text)
  return cps.length > 0 && cps.every(isKana)
}

// ---- 归一化与平/片互转 ----

/**
 * 读音输入的归一化：NFKC（半角片假名 → 全角、浊点合成、全角字母 → 半角）+ 去空白。
 *
 * 只用于**读音输入框**，不要拿去处理 surface：NFKC 对书写文本是破坏性的
 * （① → 1、㍿ → 株式会社），而 surface 必须原样保留用于渲染（CLAUDE.md §4.2）。
 */
export function normalizeKana(text: string): string {
  return text.normalize('NFKC').replace(/[\s　]+/g, '')
}

/** 片假名 → 平假名。无对应平假名的字符（ヷヸヹヺ・ー）原样保留。 */
export function toHiragana(text: string): string {
  return toCodePoints(normalizeKana(text))
    .map((ch) => {
      const c = codePoint(ch)
      if (c >= KATAKANA_MIN && c <= KATAKANA_MAX) return String.fromCodePoint(c - KANA_GAP)
      if (KATA_ITERATION.includes(c)) return String.fromCodePoint(c - KANA_GAP)
      return ch
    })
    .join('')
}

/** 平假名 → 片假名。工程内部读音按片假名规范存储（CLAUDE.md §4.2）。 */
export function toKatakana(text: string): string {
  return toCodePoints(normalizeKana(text))
    .map((ch) => {
      const c = codePoint(ch)
      if (c >= HIRAGANA_MIN && c <= HIRAGANA_MAX) return String.fromCodePoint(c + KANA_GAP)
      if (HIRA_ITERATION.includes(c)) return String.fromCodePoint(c + KANA_GAP)
      return ch
    })
    .join('')
}

// ---- 读音校验 ----

export interface KanaValidation {
  ok: boolean
  /** 面向用户的中文提示；ok 时为空串 */
  message: string
  /** 非法字符，按出现顺序去重 */
  offenders: string[]
}

const OK_VALIDATION: KanaValidation = { ok: true, message: '', offenders: [] }

/**
 * 校验一段文本是否是合法的注音（纯假名）。
 *
 * 混进汉字是最常见的误操作（直接把 surface 粘进读音框），
 * 混进拉丁字母则说明该用 kanalizer 之类先转片假名——两种都要单独报错，
 * 笼统一句「格式不对」用户不知道该改什么。
 */
export function validateKana(text: string): KanaValidation {
  const normalized = normalizeKana(text)
  if (!normalized) return { ok: false, message: '读音不能为空', offenders: [] }

  const cps = toCodePoints(normalized)
  const bad = (pred: (ch: string) => boolean): string[] => [
    ...new Set(cps.filter(pred)),
  ]

  const kanji = bad(isKanji)
  if (kanji.length) {
    return {
      ok: false,
      message: `读音里不能出现汉字：${kanji.join('')}——注音必须写成假名`,
      offenders: kanji,
    }
  }

  const latin = bad((ch) => {
    const k = charClass(ch)
    return k === 'latin' || k === 'digit'
  })
  if (latin.length) {
    return {
      ok: false,
      message: `读音里不能出现字母或数字：${latin.join('')}——请先写成片假名读法`,
      offenders: latin,
    }
  }

  const others = bad((ch) => !isKana(ch))
  if (others.length) {
    return {
      ok: false,
      message: `含有非假名字符：${others.join('')}`,
      offenders: others,
    }
  }

  return OK_VALIDATION
}

// ---- mora 切分 ----

/** 拗音的小假名：ゃゅょ ＋ ゎ（くゎ 这类） */
const SMALL_YOUON = new Set(['ゃ', 'ゅ', 'ょ', 'ゎ', 'ャ', 'ュ', 'ョ', 'ヮ'])
/** 小写元音：外来语音节 ファ/ティ/チェ/ヴォ 的构成要素 */
const SMALL_VOWEL = new Set(['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ'])
/** 单纯元音字。「あぁ」是两拍的感叹，不能并成一拍 */
const PLAIN_VOWEL = new Set(['あ', 'い', 'う', 'え', 'お', 'ア', 'イ', 'ウ', 'エ', 'オ'])
/** ウ/ヴ 虽是元音行，却确实拼出 ウィ/ヴァ，作为例外放行 */
const FOREIGN_BASE = new Set(['う', 'ゔ', 'ウ', 'ヴ'])
const SOKUON = new Set(['っ', 'ッ'])
const HATSUON = new Set(['ん', 'ン'])

export interface MoraOptions {
  /**
   * 促音「っ」并入前一拍。
   * 标准拍数统计不要开——「がっこう」是 4 拍，注音行与主行的同步就靠这个数
   * （CLAUDE.md §4.2「时间轴单位永远是 mora」）。
   * 只有在生成 ASS `\k` 分块时才开：促音声学上是静音，CTC 发射极不稳定
   * （CLAUDE.md §5.5 后处理）。
   */
  mergeSokuon?: boolean
  /**
   * 长音「ー」并入前一拍。默认关：长音在日语里独占一拍，
   * 扫色也应当给它单独的时长，否则拖腔处会提前扫完。
   */
  mergeProlonged?: boolean
}

/** 判断小假名 `ch` 能否挂到前一拍 `prev` 上。 */
function attachesToPrev(prev: string, ch: string): boolean {
  if (!prev) return false
  // 前一拍本身是促音/拨音/长音/小假名时，不再接小假名
  if (SOKUON.has(prev) || HATSUON.has(prev)) return false
  if (PROLONGED_MARKS.has(prev)) return false
  if (SMALL_YOUON.has(prev) || SMALL_VOWEL.has(prev)) return false
  if (!isKana(prev)) return false

  if (SMALL_YOUON.has(ch)) return true
  if (SMALL_VOWEL.has(ch)) return !PLAIN_VOWEL.has(prev) || FOREIGN_BASE.has(prev)
  return false
}

/**
 * 把假名串切成 mora（拍）。拗音「きゃ」合并为一拍，促音「っ」、拨音「ん」、
 * 长音「ー」各自独占一拍（可用 options 改写促音/长音的行为）。
 *
 * 非假名字符不会被丢弃，各自单独成一项——这样这个函数是全函数，
 * 调用方拿到的拍序列长度永远可与输入对得上，便于定位问题字符。
 */
export function splitMora(kana: string, options: MoraOptions = {}): string[] {
  const cps = toCodePoints(normalizeKana(kana))
  const out: string[] = []

  for (const ch of cps) {
    const prevMora = out[out.length - 1] ?? ''
    const prevCh = toCodePoints(prevMora).pop() ?? ''

    if (out.length > 0 && attachesToPrev(prevCh, ch)) {
      out[out.length - 1] = prevMora + ch
      continue
    }
    if (out.length > 0 && options.mergeSokuon === true && SOKUON.has(ch)) {
      out[out.length - 1] = prevMora + ch
      continue
    }
    if (out.length > 0 && options.mergeProlonged === true && PROLONGED_MARKS.has(ch)) {
      out[out.length - 1] = prevMora + ch
      continue
    }
    out.push(ch)
  }

  return out
}

/** 拍数。读音一改，时间轴切分单位就跟着变，UI 上必须让用户看见这个数。 */
export function moraCount(kana: string, options: MoraOptions = {}): number {
  return splitMora(kana, options).length
}

// ---- surface 分段（汉字块 / 假名串 交替） ----

export type SegmentKind = 'kanji' | 'kana' | 'other'

export interface SurfaceSegment {
  /** 码点下标，左闭右开 */
  start: number
  end: number
  text: string
  kind: SegmentKind
}

function segmentKind(ch: string): SegmentKind {
  const k = charClass(ch)
  if (k === 'kanji') return 'kanji'
  if (k === 'hiragana' || k === 'katakana' || k === 'prolonged') return 'kana'
  return 'other'
}

/**
 * 把 surface 切成交替的「汉字块 / 假名串 / 其他」。
 * 送り仮名切分与「只给汉字注音」都建立在这一步上。
 */
export function segmentSurface(text: string): SurfaceSegment[] {
  const cps = toCodePoints(text)
  const out: SurfaceSegment[] = []

  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i] ?? ''
    const kind = segmentKind(ch)
    const last = out[out.length - 1]
    if (last && last.kind === kind) {
      last.end = i + 1
      last.text += ch
    } else {
      out.push({ start: i, end: i + 1, text: ch, kind })
    }
  }

  return out
}

/**
 * 该分段是否需要注音。
 *
 * 汉字必须注；纯假名不注（否则会渲染出「あ|あ」这种冗余标注，CLAUDE.md §4.2）；
 * 拉丁字母/数字算「需要读音」——歌词里 `sumika`、`3` 这类是要给片假名读法的，
 * 但它们不在自动注音的推荐范围里，只在整词读音切分时用来占位。
 */
export function needsReading(seg: SurfaceSegment): boolean {
  if (seg.kind === 'kanji') return true
  if (seg.kind !== 'other') return false
  return toCodePoints(seg.text).some((ch) => {
    const k = charClass(ch)
    return k === 'latin' || k === 'digit'
  })
}

/** 该区间里可以注音的汉字块（供 UI 推荐选区用）。 */
export function kanjiBlocks(text: string): SurfaceSegment[] {
  return segmentSurface(text).filter((s) => s.kind === 'kanji')
}

// ---- 整词读音 → 逐块注音 ----

export interface RubyPiece {
  /** 相对于传入 surface 的码点下标，左闭右开 */
  start: number
  end: number
  text: string
}

/** 严格匹配失败后启用的等价类：书写差异，不是读音差异。 */
const FUZZY_EQUIV: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['ヂ', 'ジ']),
  new Set(['ヅ', 'ズ']),
  new Set(['ヲ', 'オ']),
  // 助词写法差异。reading_display 本应保留「は」，但歌词源的 kana 轨不保证
  new Set(['ハ', 'ワ']),
  new Set(['ヘ', 'エ']),
]

function kanaEq(a: string, b: string, fuzzy: boolean): boolean {
  if (a === b) return true
  if (!fuzzy) return false
  return FUZZY_EQUIV.some((set) => set.has(a) && set.has(b))
}

function matchAt(reading: string[], pattern: string[], at: number, fuzzy: boolean): boolean {
  if (at + pattern.length > reading.length) return false
  for (let i = 0; i < pattern.length; i++) {
    if (!kanaEq(reading[at + i] ?? '', pattern[i] ?? '', fuzzy)) return false
  }
  return true
}

/**
 * 把整词读音按「汉字块 / 送り仮名」切开，只给需要读音的块留注音。
 *
 * 例：`alignReading('食べる', 'たべる')` → `[{start:0, end:1, text:'タ'}]`
 * ——「べる」是送り仮名，不注；直接整词注音会渲染出「たべる|食べる」这种冗余。
 *
 * 做法：把假名串当锚点在读音里定位（带回溯，不是一次贪心），
 * 锚点之间剩下的读音归给夹在中间的汉字块。
 * 切不出来时返回 `null`，调用方应降级为「整段一个注音」——
 * nicokara 风格里整词注音很常见，是可接受的降级（CLAUDE.md §5.6）。
 *
 * 返回的 `text` 一律是片假名（工程内部的规范存储形式），
 * 要给用户看时再 `toHiragana()`。
 *
 * **已知边界**：连浊/促音便发生在汉字块内部（手+紙 → てがみ、一+本 → いっぽん），
 * 由于汉字块整体拿走锚点之间的读音，这类变化天然被吸收，不需要额外规则；
 * 但块内**多个汉字之间**怎么分，没有词典就无从判断，一律整块一个注音。
 */
export function alignReading(surface: string, reading: string): RubyPiece[] | null {
  const segments = segmentSurface(surface)
  const R = toCodePoints(toKatakana(reading))
  if (R.length === 0) return null

  const attempt = (fuzzy: boolean): RubyPiece[] | null => {
    /**
     * @param segIdx  当前处理到第几个分段
     * @param pos     读音里已消耗到的位置
     * @param pending 等着分配读音的块（汉字/拉丁），null 表示当前没有
     */
    const solve = (
      segIdx: number,
      pos: number,
      pending: SurfaceSegment | null,
    ): RubyPiece[] | null => {
      if (segIdx >= segments.length) {
        if (!pending) return pos === R.length ? [] : null
        // 末尾的块吃掉剩余读音，必须非空
        if (pos >= R.length) return null
        return [{ start: pending.start, end: pending.end, text: R.slice(pos).join('') }]
      }

      const seg = segments[segIdx]
      if (!seg) return null

      if (needsReading(seg)) {
        // 分段本身是交替的，不会连续出现两个待分配块；真出现说明分段有 bug
        if (pending) return null
        return solve(segIdx + 1, pos, seg)
      }

      if (seg.kind === 'other') {
        // 标点/空格不消耗读音
        return solve(segIdx + 1, pos, pending)
      }

      // 假名串：在读音里找锚点
      const pattern = toCodePoints(toKatakana(seg.text))
      const from = pending ? pos + 1 : pos
      const to = pending ? R.length - pattern.length : pos
      for (let j = from; j <= to; j++) {
        if (!matchAt(R, pattern, j, fuzzy)) continue
        const rest = solve(segIdx + 1, j + pattern.length, null)
        if (rest === null) continue
        if (!pending) return rest
        return [
          { start: pending.start, end: pending.end, text: R.slice(pos, j).join('') },
          ...rest,
        ]
      }
      return null
    }

    return solve(0, 0, null)
  }

  return attempt(false) ?? attempt(true)
}

/**
 * 注音的显示式切分：把一整行的注音区间与未被覆盖的字符排成一串渲染组。
 * 「明日」共用一个「あした」时，两个字必须归到同一组才能把注音居中排在上方。
 */
export interface RubyRenderGroup {
  start: number
  end: number
  text: string
  /** 该组对应的注音下标（指向传入的 spans 数组）；未注音时为 -1 */
  spanIndex: number
}

export function buildRenderGroups(
  chars: readonly string[],
  spans: ReadonlyArray<{ start: number; end: number }>,
): RubyRenderGroup[] {
  // 越界与重叠的区间在这里就被挡掉，渲染层不必再防御一遍
  const sorted = spans
    .map((s, i) => ({ ...s, i }))
    .filter((s) => s.start >= 0 && s.end > s.start && s.end <= chars.length)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const groups: RubyRenderGroup[] = []
  let cursor = 0
  for (const s of sorted) {
    if (s.start < cursor) continue // 与前一个区间重叠，跳过后者
    for (let i = cursor; i < s.start; i++) {
      groups.push({ start: i, end: i + 1, text: chars[i] ?? '', spanIndex: -1 })
    }
    groups.push({
      start: s.start,
      end: s.end,
      text: chars.slice(s.start, s.end).join(''),
      spanIndex: s.i,
    })
    cursor = s.end
  }
  for (let i = cursor; i < chars.length; i++) {
    groups.push({ start: i, end: i + 1, text: chars[i] ?? '', spanIndex: -1 })
  }
  return groups
}
