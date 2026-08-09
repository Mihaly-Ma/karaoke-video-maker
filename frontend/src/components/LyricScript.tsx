/**
 * 整首歌词按**成片样式**渲染：真实字体、卡拉OK 配色（白字黑边）、带注音。
 *
 * 为什么是它而不是一个文本列表：判断歌词候选对不对，看的是歌词内容本身。
 * 同名不同版本的差异往往出现在中后段（CLAUDE.md §6.1「版本混淆是头号坑」），
 * 纯文本列表看不出来，按成片样式渲染才能一眼认出。
 *
 * 渲染方式已裁决为 **CSS 近似**（docs/ui-redesign.md §六点五）：原生 `<ruby>` 标注 +
 * 文字描边，不用 JASSUB。这一步要判断的是文本内容与版本，不是像素级观感；
 * JASSUB 必须挂在真实视频元素上，切换候选还要重建字幕轨，代价与收益不成比例。
 *
 * 近似到什么程度、差在哪里：
 * - 字体、字号比例、注音比例、描边比例都取自工程样式，所以字面观感接近成片
 * - 注音的水平位置交给浏览器的 ruby 布局，不走 libass 的 advance 实测 + 组间避让
 *   （karaskel 那套算法在后端 `render/ass_builder.py`）。相邻注音的挤压方式会不同
 * - 不画已唱色与扫色：静态视图里没有播放头，伪造一个"已唱到这里"只会误导
 *
 * 同一个渲染器同时服务"候选预览"与"确认后的全文编辑态"——两者本来就该长得一样，
 * 用户确认前看到的就是确认后得到的。
 */

import { MergeCellsOutlined, ScissorOutlined } from '@ant-design/icons'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { t } from '../i18n'
import type { Line, Palette, RubySpan, Style } from '../api/types'
import { assToCssHex } from '../lib/assColor'

/** 渲染器只认这个形状：候选预览、导入草稿、工程正文三种数据都先归一到它。 */
export interface ScriptLine {
  id: string
  /** 逐个计时单元的文本。拼起来就是整行，拆行点只能落在它们之间 */
  tokens: string[]
  /** 字符区间 [start, end) → 注音文本，索引指向整行拼接后的字符串 */
  ruby: RubySpan[]
  /** 歌词源塞进正文的「词：xxx」「曲：xxx」，渲染时单独成屏 */
  isMetadata: boolean
  voicePart: string
  /** 该行时间的来源。null = 这份数据根本没有时间（纯文本导入草稿） */
  timingSource: string | null
}

/**
 * 有语义色的四种时间来源（CLAUDE.md §7.4）。
 * `unset` 不在其中——它是"从未定过时"，不是一种来源，画一条色杠反而像已经有轴了。
 */
const TIMING_SOURCES = new Set(['provider', 'aligned', 'interpolated', 'manual'])

/** 成片默认色（CLAUDE.md §8.5）：工程还没配色时用它，不是界面 token。 */
const FILM_FILL = '#ffffff'
const FILM_OUTLINE = '#000000'

/** 屏幕上的主文字号上限。工程样式里的 font_size 是相对视频高度的，不能直接当 px 用。 */
const SCREEN_FONT_PX = 28

/**
 * 自动缩小的下限。
 *
 * 这个视图要回答的是"歌词内容与版本对不对、读音对不对"，字号的绝对值不重要——
 * 注音的**排版**本来就不能在这里判断（这里走浏览器原生 ruby，成片走 karaskel 的
 * advance 实测 + 组间避让）。但注音的**内容**要读得出来：16px 主文对应 7px 出头的
 * 注音，已经是能认出假名的下沿，再小就只剩一团墨。到底之后不再缩，改走本行横向滚动。
 */
const MIN_FONT_PX = 16

export function toScriptLines(lines: Line[]): ScriptLine[] {
  return lines.map((ln) => ({
    id: ln.id,
    tokens: ln.tokens.map((tk) => tk.text),
    ruby: ln.ruby,
    isMetadata: ln.is_metadata,
    voicePart: ln.voice_part,
    // 取首个音节的来源代表整行：混合来源的行极少，而这里只是给一条提示色，
    // 逐音节的来源在对轴舞台上看
    timingSource: ln.tokens[0]?.timing_source ?? null,
  }))
}

export const lineText = (line: ScriptLine): string => line.tokens.join('')

function paletteColors(palettes: Record<string, Palette>, voicePart: string): { fill: string; outline: string } {
  const p = palettes[voicePart] ?? palettes['main'] ?? Object.values(palettes)[0]
  if (!p) return { fill: FILM_FILL, outline: FILM_OUTLINE }
  try {
    return { fill: assToCssHex(p.unsung_fill), outline: assToCssHex(p.unsung_outline) }
  } catch {
    // 配色字段理论上恒合法；真坏了也不该让整屏歌词渲染不出来
    return { fill: FILM_FILL, outline: FILM_OUTLINE }
  }
}

/**
 * 把工程样式换算成本视图的 CSS 变量。
 *
 * 换算的是**比例**而不是绝对值：`font_size` / `outline` 都以视频高度为基准
 * （4K 下字号 162px），照搬到网页上会撑满屏幕。比例照抄，绝对值按屏幕重定。
 */
function filmVars(style: Style | null): CSSProperties {
  const outlineRatio = style && style.font_size > 0 ? style.outline / style.font_size : 3 / 64
  const rubyScale = style?.ruby_scale ?? 0.45
  return {
    '--lyr-font': style?.font_name ? `"${style.font_name}", var(--font-ui)` : 'var(--font-ui)',
    '--lyr-fs': `${SCREEN_FONT_PX}px`,
    // 只交出**比例**，描边与注音字号由 CSS 从 --lyr-fs 派生（见 LyricStageCss）。
    // 自动缩放只改 --lyr-fs 一个变量，派生量自动跟上，不会缩了字漏了边。
    // 注音描边比主文细：后端取主描边的 0.55 倍，那个系数也写在 CSS 里
    '--lyr-stroke-ratio': String(outlineRatio),
    '--lyr-ruby-scale': String(rubyScale),
  } as CSSProperties
}

/**
 * 把一行拆成「纯文本片段」与「带注音的片段」。
 *
 * 越界或互相重叠的注音区间**整条丢掉**而不是硬塞：错位的注音比没有注音更难发现，
 * 用户会以为那就是歌词源给的读音。
 */
function renderRuby(text: string, ruby: RubySpan[]): ReactNode[] {
  const spans = ruby
    .filter((r) => r.start >= 0 && r.end <= text.length && r.end > r.start)
    .sort((a, b) => a.start - b.start)

  const out: ReactNode[] = []
  let cursor = 0
  spans.forEach((r, i) => {
    if (r.start < cursor) return
    if (r.start > cursor) out.push(<span key={`p${cursor}`}>{text.slice(cursor, r.start)}</span>)
    out.push(
      <ruby key={`r${i}-${r.start}`}>
        {text.slice(r.start, r.end)}
        <rt>{r.text}</rt>
      </ruby>,
    )
    cursor = r.end
  })
  if (cursor < text.length) out.push(<span key={`p${cursor}`}>{text.slice(cursor)}</span>)
  return out
}

export interface LyricScriptProps {
  lines: ScriptLine[]
  /** 工程样式。为 null（尚未加载工程）时用默认比例 */
  style: Style | null
  palettes: Record<string, Palette>
  /** 开启拆行/并行。候选预览态不给，避免用户以为改的是自己的工程 */
  editable?: boolean
  onSplit?: (lineId: string, tokenIndex: number) => void
  onMerge?: (lineId: string) => void
  /** 正在提交的行：期间禁掉它的操作，避免连点发出两次拆行 */
  busyLineId?: string | null
}

export default function LyricScript({
  lines,
  style,
  palettes,
  editable = false,
  onSplit,
  onMerge,
  busyLineId = null,
}: LyricScriptProps) {
  // 拆行是两步操作：先选行、再选位置。位置只能是 token 边界，而注音区间可以
  // 横跨边界，所以拆分态要换一种排版（见下），不能在注音结构里插分隔符。
  const [splittingId, setSplittingId] = useState<string | null>(null)
  const filmRef = useRef<HTMLDivElement>(null)

  // 行的身份 + 文本决定测量结果。直接依赖 lines 数组会因为父组件每次渲染都新建数组
  // 而让下面的 effect 空转（连带反复重建 ResizeObserver）
  const contentKey = useMemo(() => lines.map((l) => `${l.id}:${lineText(l)}`).join('\n'), [lines])

  /**
   * 把正文整体缩到「最长的一行也放得下」。
   *
   * 为什么必须缩而不是折：见 LyricStageCss 里 `.lyr-text` 的说明——软换行会发明
   * 成片里不存在的断点。这里的取舍是"字号绝对值不重要，断点位置很重要"。
   *
   * 为什么直接写 DOM 而不是 setState：字号会改变测量结果，走 state 就成了
   * 测量→渲染→再测量的回环。做法是**先把字号复位到基准**量出与缩放无关的自然宽度，
   * 一次算出终值再写回，不迭代、不振荡。
   */
  useLayoutEffect(() => {
    const film = filmRef.current
    if (!film) return

    const fit = () => {
      // ---- 写：复位到基准字号 ----
      film.style.setProperty('--lyr-fs', `${SCREEN_FONT_PX}px`)

      // ---- 读：这一段里不能再写样式，否则每读一次就强制一次重排 ----
      const cs = getComputedStyle(film)
      const avail = film.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      let scale = 1
      for (const row of film.querySelectorAll<HTMLElement>('.lyr-line')) {
        const body = row.querySelector<HTMLElement>('.lyr-line__body')
        const text = body?.querySelector<HTMLElement>('.lyr-text')
        if (!body || !text) continue
        // scrollWidth 取整会少算不到 1px，宁可多留一点，免得刚好差半像素长出滚动条
        const natural = text.scrollWidth + 1
        // 行号、来源杠、徽章、操作按钮都不随字号缩放，先从可用宽度里扣掉
        const room = avail - (row.getBoundingClientRect().width - body.getBoundingClientRect().width)
        if (room > 0) scale = Math.min(scale, room / natural)
      }

      // ---- 写：终值 ----
      film.style.setProperty(
        '--lyr-fs',
        `${Math.min(SCREEN_FONT_PX, Math.max(MIN_FONT_PX, SCREEN_FONT_PX * scale)).toFixed(2)}px`,
      )
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(film)
    return () => ro.disconnect()
  }, [contentKey, style, splittingId])

  return (
    <div className="lyr-film" style={filmVars(style)} ref={filmRef}>
      <div className="lyr-script">
        {lines.map((line, i) => {
          const text = lineText(line)
          const colors = paletteColors(palettes, line.voicePart)
          const splitting = editable && splittingId === line.id
          const src = line.timingSource && TIMING_SOURCES.has(line.timingSource) ? line.timingSource : null
          const busy = busyLineId === line.id
          const cls = [
            'lyr-line',
            editable ? 'lyr-line--edit' : '',
            line.isMetadata ? 'lyr-line--meta' : '',
            splitting ? 'lyr-line--splitting' : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <div
              key={line.id}
              className={cls}
              style={{ '--lyr-fill': colors.fill, '--lyr-outline': colors.outline } as CSSProperties}
            >
              <span className="lyr-line__no num">{i + 1}</span>
              <span
                className={`lyr-line__src${src ? ` lyr-line__src--${src}` : ''}`}
                title={src ? t(`source.${src}`) : undefined}
              />
              <div className="lyr-line__body">
                {splitting ? (
                  <SplitRow line={line} disabled={busy} onPick={(idx) => {
                    setSplittingId(null)
                    onSplit?.(line.id, idx)
                  }} />
                ) : (
                  <div className="lyr-text">{text ? renderRuby(text, line.ruby) : ' '}</div>
                )}
              </div>

              {line.isMetadata && (
                <span className="badge lyr-line__badge" title={t('lyrics.metadataTitle')}>
                  {t('lyrics.metadata')}
                </span>
              )}

              {editable && (
                <div className="lyr-line__ops">
                  <button
                    type="button"
                    disabled={busy || line.tokens.length < 2}
                    title={splitting ? t('lyrics.splitPick') : t('lyrics.splitStart')}
                    aria-label={t('lyrics.splitStart')}
                    onClick={() => setSplittingId(splitting ? null : line.id)}
                  >
                    <ScissorOutlined />
                  </button>
                  <button
                    type="button"
                    disabled={busy || i === lines.length - 1}
                    title={t('lyrics.merge')}
                    aria-label={t('lyrics.merge')}
                    onClick={() => onMerge?.(line.id)}
                  >
                    <MergeCellsOutlined />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 拆分态的一行：逐 token 平铺，token 之间是可点的拆分位置。
 *
 * 落在注音区间内部的位置标成警示色——后端在这种拆法下会把跨界的注音丢进
 * `orphans` 等用户确认（CLAUDE.md §4.4），拆之前就该看见，而不是拆完才发现注音没了。
 */
function SplitRow({
  line,
  disabled,
  onPick,
}: {
  line: ScriptLine
  disabled: boolean
  onPick: (tokenIndex: number) => void
}) {
  // 每个 token 起点在整行里的字符偏移，用来判断拆分位置有没有切开某条注音
  const offsets: number[] = []
  let acc = 0
  for (const tk of line.tokens) {
    offsets.push(acc)
    acc += tk.length
  }

  return (
    <div className="lyr-split">
      {line.tokens.map((tk, i) => {
        const at = offsets[i]
        const risky = i > 0 && line.ruby.some((r) => r.start < at && r.end > at)
        return (
          <span key={i}>
            {i > 0 && (
              <button
                type="button"
                className={`lyr-split__pt${risky ? ' lyr-split__pt--risky' : ''}`}
                disabled={disabled}
                title={risky ? t('lyrics.splitRisky') : t('lyrics.splitHere')}
                aria-label={t('lyrics.splitHere')}
                onClick={() => onPick(i)}
              />
            )}
            <span className="lyr-split__tok">{tk}</span>
          </span>
        )
      })}
    </div>
  )
}
