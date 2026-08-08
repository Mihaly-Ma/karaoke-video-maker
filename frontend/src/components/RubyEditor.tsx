/**
 * 注音（振り仮名）编辑器。
 *
 * ## 为什么这个界面是核心功能而不是配套功能
 *
 * 日语歌词大量使用当て字：作词者指定的读音与词典读音不同（「運命」唱作 さだめ、
 * 「時間」唱作 とき、「本気」唱作 マジ）。形态素分析器对这类**一定给错，而且给得很自信**。
 * 而读音在本项目里是**上游**：读音 → mora 序列 → 时间轴单位 → 注音显示
 * （CLAUDE.md §4.2「时间轴单位永远是 mora」）。读音错了是双重打击——注音显示错，
 * 同时拍数错导致逐字扫色的切分也错。所以手工修正注音是必需能力（§2.5）。
 *
 * ## 三条设计约束落在界面上的样子
 *
 * 1. **注音挂在行内字符区间上**：`RubySpan.start/end` 是行内字符下标（左闭右开），
 *    不是 token 下标。所以这里做的是「在一行文本上拉选若干字符 → 给这段指定读音」，
 *    「明日」两个字共用「あした」这种熟字訓才表达得出来。
 * 2. **只给汉字注音**：纯假名区间不进 `ruby[]`，否则渲染出「あ|あ」这种冗余标注
 *    （§4.2）。「食べる」应当只给「食」注「た」——「自动切分」按钮做的就是这件事。
 * 3. **来源必须一眼可见**（§4.4 / §7.4）：`provider_kana` 是该曲实际演唱读音最可信，
 *    `morph` 是分析器猜的必须逐条核对。用户要的是「哪几条需要检查」，
 *    而不是面对一堆看起来同样自信的结果逐个核对。
 *
 * ## 两个与后端的口径约定
 *
 * - **下标以 Unicode 码点为单位**，与后端 Python 的字符串下标一致。行文本由
 *   `line.tokens[].text` 拼接得到（后端 `Line.text` 就是这么定义的）。
 * - **`RubySpan.text` 存的是要渲染的形态**：`render/ass_builder.py` 把它逐字写进 ASS，
 *   QRC 的 `[kana:]` 轨给的也是平假名。所以这里**不做平/片假名的强制归一**，
 *   用户输入什么就存什么（「本気 → マジ」的片假名注音是原文意图，归一化会毁掉它），
 *   只提供互转按钮让用户自己决定。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Line, RubySpan } from '../api/types'
import { useProject } from '../state/projectStore'
import {
  alignReading,
  buildRenderGroups,
  containsKanji,
  isAllKana,
  kanjiBlocks,
  normalizeKana,
  segmentSurface,
  splitMora,
  toCodePoints,
  toHiragana,
  toKatakana,
  validateKana,
} from '../lib/kana'

// ---- 来源徽章 ----

type SourceTone = 'trusted' | 'ok' | 'guess' | 'manual'

interface SourceMeta {
  label: string
  hint: string
  tone: SourceTone
}

/** 与后端 `models/karaoke.py` 的 `ReadingSource` 一一对应（CLAUDE.md §4.5）。 */
const SOURCE_META: Record<string, SourceMeta> = {
  provider_kana: {
    label: '歌词源',
    hint: '歌词源自带的假名轨，是该曲的实际演唱读音，优先于通用词典',
    tone: 'trusted',
  },
  dict: { label: '词典', hint: '通用词典读音。当て字处可能与实际演唱不符', tone: 'ok' },
  dict_user: { label: '用户词典', hint: '你的跨歌曲词典条目', tone: 'ok' },
  morph: {
    label: '形态素推断',
    hint: '形态素分析器自动推断。对当て字必错，请逐条核对',
    tone: 'guess',
  },
  acoustic: {
    label: '声学消歧',
    hint: '多候选读音经强制对齐挑出，置信度不高，建议抽查',
    tone: 'guess',
  },
  manual: { label: '手工', hint: '你手工改过的读音', tone: 'manual' },
}

const UNKNOWN_SOURCE: SourceMeta = {
  label: '未知来源',
  hint: '后端返回了本界面不认识的 source 值，按需检查处理',
  tone: 'guess',
}

const sourceMeta = (source: string): SourceMeta => SOURCE_META[source] ?? UNKNOWN_SOURCE

/** 需要人工复核：机器猜的且用户还没锁定。 */
const needsReview = (span: RubySpan): boolean =>
  !span.locked && sourceMeta(span.source).tone === 'guess'

// ---- 组件 ----

export interface RubyEditorProps {
  /** 指定要编辑的行。不传时跟随全局选中行。 */
  lineId?: string
  className?: string
}

interface CharRange {
  anchor: number
  focus: number
}

export function RubyEditor({ lineId, className }: RubyEditorProps) {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const select = useProject((s) => s.select)
  const setPlayhead = useProject((s) => s.setPlayhead)
  const setRubyRemote = useProject((s) => s.setRuby)
  const storeError = useProject((s) => s.error)

  const activeLineId = lineId ?? (selection.kind === 'none' ? undefined : selection.lineId)
  const line: Line | undefined = useMemo(
    () => project?.lines.find((l) => l.id === activeLineId),
    [project, activeLineId],
  )

  const chars = useMemo(
    () => toCodePoints((line?.tokens ?? []).map((t) => t.text).join('')),
    [line],
  )

  /** 每个字符属于第几个 token。点字符要能选中对应 token，时间轴才跟得上。 */
  const tokenOfChar = useMemo(() => {
    const map: number[] = []
    ;(line?.tokens ?? []).forEach((t, i) => {
      toCodePoints(t.text).forEach(() => map.push(i))
    })
    return map
  }, [line])

  const segments = useMemo(() => segmentSurface(chars.join('')), [chars])

  const [range, setRange] = useState<CharRange | null>(null)
  const [dragging, setDragging] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [onlyReview, setOnlyReview] = useState(false)

  const sel = useMemo(() => {
    if (!range) return null
    const start = Math.min(range.anchor, range.focus)
    const end = Math.max(range.anchor, range.focus) + 1
    return { start, end }
  }, [range])

  const selKey = sel ? `${sel.start}:${sel.end}` : ''

  // 换行时清空一切，避免把上一行的选区/输入带过来误写
  useEffect(() => {
    setRange(null)
    setInput('')
    setNotice('')
  }, [activeLineId])

  // 选区变化时，若正好落在已有注音上就回填它的读音，方便微调
  // （用 ref 读 line，避免每次工程刷新都重置用户正在输入的内容）
  const lineRef = useRef<Line | undefined>(undefined)
  lineRef.current = line
  const selRef = useRef<{ start: number; end: number } | null>(null)
  selRef.current = sel
  useEffect(() => {
    const l = lineRef.current
    const s = selRef.current
    setNotice('')
    if (!l || !s) {
      setInput('')
      return
    }
    const exact = l.ruby.find((r) => r.start === s.start && r.end === s.end)
    setInput(exact ? exact.text : '')
  }, [selKey])

  // 拖拽选区：鼠标可能在组件外松开，监听必须挂 window
  useEffect(() => {
    if (!dragging) return
    const up = () => setDragging(false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [dragging])

  // 用 useMemo 稳定引用：`line?.ruby ?? []` 在 line 为空时每次渲染都会
  // 生成新数组，会让下面依赖 spans 的 useMemo 白白重算
  const spans = useMemo(() => line?.ruby ?? [], [line])
  const reviewCount = spans.filter(needsReview).length
  const lockedCount = spans.filter((s) => s.locked).length

  const groups = useMemo(() => buildRenderGroups(chars, spans), [chars, spans])

  /** 已被注音覆盖的汉字块之外，还剩哪些汉字没注音——直接告诉用户还差什么。 */
  const uncovered = useMemo(() => {
    const covered = new Set<number>()
    for (const s of spans) for (let i = s.start; i < s.end; i++) covered.add(i)
    return kanjiBlocks(chars.join('')).filter((b) => {
      for (let i = b.start; i < b.end; i++) if (!covered.has(i)) return true
      return false
    })
  }, [chars, spans])

  const selText = sel ? chars.slice(sel.start, sel.end).join('') : ''
  const validation = useMemo(() => validateKana(input), [input])
  const moras = useMemo(
    () => (validation.ok ? splitMora(input) : []),
    [input, validation.ok],
  )

  /** 自动切分预览。按钮不该是盲操作，先把结果摆出来。 */
  const autoPieces = useMemo(() => {
    if (!sel || !validation.ok || !selText) return null
    return alignReading(selText, input)
  }, [sel, selText, input, validation.ok])

  /** 输入里出现片假名就按片假名落库，否则转平假名——不夺走「マジ」这类原文意图。 */
  const wantsKatakana = /[ァ-ヺ]/.test(normalizeKana(input))

  const overlapping = sel
    ? spans.filter((r) => r.start < sel.end && r.end > sel.start)
    : []
  const replaced = sel
    ? overlapping.filter((r) => !(r.start === sel.start && r.end === sel.end))
    : []
  const lockedHit = overlapping.filter((r) => r.locked)

  // ---- 选区操作 ----

  const pickChar = (i: number, extend: boolean) => {
    setRange((prev) => (extend && prev ? { ...prev, focus: i } : { anchor: i, focus: i }))
    const ti = tokenOfChar[i]
    if (line && ti !== undefined) select({ kind: 'token', lineId: line.id, tokenIndex: ti })
  }

  /** 双击展开到整个汉字块 / 假名串——「食べる」一下就选中「食」，不用拖。 */
  const expandSegment = (i: number) => {
    const seg = segments.find((s) => i >= s.start && i < s.end)
    if (seg) setRange({ anchor: seg.start, focus: seg.end - 1 })
  }

  const selectSpan = (span: RubySpan) => {
    setRange({ anchor: span.start, focus: Math.max(span.start, span.end - 1) })
    const ti = tokenOfChar[span.start]
    if (line && ti !== undefined) select({ kind: 'token', lineId: line.id, tokenIndex: ti })
  }

  /** 把播放头挪到该注音对应的字符处，供试听核对。 */
  const seekToSpan = (span: RubySpan) => {
    if (!line || !project) return
    const ti = tokenOfChar[span.start]
    const token = ti === undefined ? undefined : line.tokens[ti]
    if (token) setPlayhead(token.start_ms + project.global_offset_ms)
  }

  const onStripKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!range) return
    if (e.key === 'Escape') {
      setRange(null)
      return
    }
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (step === 0) return
    e.preventDefault()
    const next = Math.min(chars.length - 1, Math.max(0, range.focus + step))
    setRange(e.shiftKey ? { ...range, focus: next } : { anchor: next, focus: next })
  }

  // ---- 写入 ----

  const runEdits = async (
    edits: ReadonlyArray<{ start: number; end: number; text: string }>,
    okMessage: string,
  ) => {
    if (!line) return
    setBusy(true)
    try {
      // 每次调用返回的是完整新工程（见 api/client.ts 的说明），必须串行
      for (const e of edits) await setRubyRemote(line.id, e.start, e.end, e.text)
      setNotice(okMessage)
    } finally {
      setBusy(false)
    }
  }

  const handleApply = () => {
    if (!sel) return
    if (!validation.ok) {
      setNotice(validation.message)
      return
    }
    void runEdits(
      [{ start: sel.start, end: sel.end, text: normalizeKana(input) }],
      `已把「${selText}」的读音设为「${normalizeKana(input)}」`,
    )
  }

  const handleAutoSplit = () => {
    if (!sel) return
    if (!validation.ok) {
      setNotice(validation.message)
      return
    }
    if (autoPieces === null) {
      setNotice('切不出送り仮名：读音与选中文字对不上。可以改小选区，或直接整段注音')
      return
    }
    if (autoPieces.length === 0) {
      setNotice('选中的是纯假名，不需要注音')
      return
    }
    void runEdits(
      autoPieces.map((p) => ({
        start: sel.start + p.start,
        end: sel.start + p.end,
        text: wantsKatakana ? p.text : toHiragana(p.text),
      })),
      `已按送り仮名切成 ${autoPieces.length} 段`,
    )
  }

  /** 删除约定：空 `text` 表示清除该区间的注音（后端 `/editor/ruby` 的行为）。 */
  const handleDelete = () => {
    if (!sel) return
    void runEdits([{ start: sel.start, end: sel.end, text: '' }], '已删除该区间的注音')
  }

  // ---- 渲染 ----

  if (!project) return <div className={panelClass(className)}><Styles />
    <p className="kvm-ruby-empty">还没有打开工程。</p>
  </div>

  if (!line) return <div className={panelClass(className)}><Styles />
    <p className="kvm-ruby-empty">在歌词列表里选中一行，这里会显示该行的全部注音。</p>
  </div>

  const listed = onlyReview ? spans.filter(needsReview) : spans
  const canWrite = !busy && sel !== null

  return (
    <div className={panelClass(className)}>
      <Styles />

      <header className="kvm-ruby-head">
        <div className="kvm-ruby-title">
          注音编辑
          {line.is_metadata && <span className="kvm-ruby-tag">制作名单行</span>}
        </div>
        <div className="kvm-ruby-stat">
          <span>{spans.length} 处注音</span>
          {reviewCount > 0 && (
            <span className="kvm-ruby-warn">{reviewCount} 处待核对</span>
          )}
          {lockedCount > 0 && <span>{lockedCount} 处已锁定</span>}
        </div>
      </header>

      <div className="kvm-ruby-legend">
        {(['trusted', 'ok', 'guess', 'manual'] as const).map((tone) => (
          <span key={tone} className="kvm-ruby-legend-item">
            <i className="kvm-ruby-dot" data-tone={tone} />
            {LEGEND_TEXT[tone]}
          </span>
        ))}
        <span className="kvm-ruby-legend-item">🔒 已锁定，自动重算不会覆盖</span>
      </div>

      {/* 字符条：拖拽选字符，双击选中整个汉字块 */}
      <div
        className="kvm-ruby-strip"
        tabIndex={0}
        role="listbox"
        aria-label="行内字符，拖拽可选择注音区间"
        onKeyDown={onStripKeyDown}
        onMouseDown={() => setDragging(true)}
      >
        {chars.length === 0 && <span className="kvm-ruby-empty">这一行没有文字。</span>}
        {groups.map((g) => {
          const span = g.spanIndex >= 0 ? spans[g.spanIndex] : undefined
          const meta = span ? sourceMeta(span.source) : undefined
          return (
            <div
              key={`${g.start}-${g.end}`}
              className="kvm-ruby-group"
              data-tone={meta?.tone ?? 'none'}
              title={span ? `${meta?.label}：${meta?.hint}` : undefined}
            >
              <div className="kvm-ruby-rt">
                {span ? span.text : ' '}
                {span?.locked && <span className="kvm-ruby-lock">🔒</span>}
              </div>
              <div className="kvm-ruby-base">
                {Array.from({ length: g.end - g.start }, (_, k) => {
                  const i = g.start + k
                  const inSel = sel !== null && i >= sel.start && i < sel.end
                  const inToken =
                    selection.kind === 'token' &&
                    selection.lineId === line.id &&
                    tokenOfChar[i] === selection.tokenIndex
                  return (
                    <span
                      key={i}
                      className="kvm-ruby-ch"
                      data-selected={inSel || undefined}
                      data-token={inToken || undefined}
                      data-kanji={containsKanji(chars[i] ?? '') || undefined}
                      onMouseDown={(e) => pickChar(i, e.shiftKey)}
                      onMouseEnter={() => {
                        if (dragging) setRange((p) => (p ? { ...p, focus: i } : p))
                      }}
                      onDoubleClick={() => expandSegment(i)}
                    >
                      {chars[i]}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {uncovered.length > 0 && (
        <div className="kvm-ruby-todo">
          还没注音的汉字块：
          {uncovered.map((b) => (
            <button
              key={b.start}
              type="button"
              className="kvm-ruby-chip"
              onClick={() => setRange({ anchor: b.start, focus: b.end - 1 })}
            >
              {b.text}
            </button>
          ))}
        </div>
      )}

      {/* 选区 → 读音 */}
      <div className="kvm-ruby-form">
        <div className="kvm-ruby-selinfo">
          {sel ? (
            <>
              选中 <b>「{selText}」</b>
              <span className="kvm-ruby-muted">
                （字符 {sel.start}–{sel.end}）
              </span>
              {isAllKana(selText) && (
                <span className="kvm-ruby-warn">纯假名，通常不需要注音</span>
              )}
            </>
          ) : (
            <span className="kvm-ruby-muted">在上面拖选要注音的字符（双击可选中整个汉字块）</span>
          )}
        </div>

        <div className="kvm-ruby-row">
          <input
            className="kvm-ruby-input"
            value={input}
            placeholder="输入假名读音"
            disabled={!sel || busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleApply()
              if (e.key === 'Escape') setRange(null)
            }}
          />
          <button
            type="button"
            className="kvm-ruby-btn"
            disabled={!input}
            title="转成平假名"
            onClick={() => setInput(toHiragana(input))}
          >
            → あ
          </button>
          <button
            type="button"
            className="kvm-ruby-btn"
            disabled={!input}
            title="转成片假名"
            onClick={() => setInput(toKatakana(input))}
          >
            → ア
          </button>
        </div>

        {input && !validation.ok && <p className="kvm-ruby-error">{validation.message}</p>}

        {input && validation.ok && (
          <p className="kvm-ruby-mora">
            {moras.length} 拍：
            <span className="kvm-ruby-moralist">{moras.join(' | ')}</span>
            <span className="kvm-ruby-muted">拍数决定逐字扫色的切分，改读音会改时间轴单位</span>
          </p>
        )}

        {autoPieces !== null && autoPieces.length > 0 && sel && (
          <p className="kvm-ruby-preview">
            自动切分：
            {autoPieces.map((p) => (
              <span key={p.start} className="kvm-ruby-piece">
                {chars.slice(sel.start + p.start, sel.start + p.end).join('')}
                <i>{wantsKatakana ? p.text : toHiragana(p.text)}</i>
              </span>
            ))}
          </p>
        )}

        {replaced.length > 0 && (
          <p className="kvm-ruby-warn">
            选区与 {replaced.length} 处已有注音重叠
            {lockedHit.length > 0 && `，其中 ${lockedHit.length} 处已锁定`}
          </p>
        )}

        <div className="kvm-ruby-row">
          <button
            type="button"
            className="kvm-ruby-btn kvm-ruby-primary"
            disabled={!canWrite || !validation.ok}
            onClick={handleApply}
          >
            应用到整段
          </button>
          <button
            type="button"
            className="kvm-ruby-btn"
            disabled={!canWrite || !validation.ok || !autoPieces || autoPieces.length === 0}
            title="把送り仮名摘掉，只给汉字块注音"
            onClick={handleAutoSplit}
          >
            自动切分
          </button>
          <button
            type="button"
            className="kvm-ruby-btn kvm-ruby-danger"
            disabled={!canWrite || overlapping.length === 0}
            onClick={handleDelete}
          >
            删除注音
          </button>
        </div>

        {notice && <p className="kvm-ruby-notice">{notice}</p>}
        {storeError && <p className="kvm-ruby-error">{storeError}</p>}
      </div>

      {/* 本行全部注音 */}
      <div className="kvm-ruby-listhead">
        <span>本行注音</span>
        <label className="kvm-ruby-check">
          <input
            type="checkbox"
            checked={onlyReview}
            onChange={(e) => setOnlyReview(e.target.checked)}
          />
          只看待核对
        </label>
      </div>

      <ul className="kvm-ruby-list">
        {listed.length === 0 && (
          <li className="kvm-ruby-empty">
            {onlyReview ? '没有待核对的注音。' : '这一行还没有注音。'}
          </li>
        )}
        {listed.map((span) => {
          const meta = sourceMeta(span.source)
          const active = sel !== null && sel.start === span.start && sel.end === span.end
          return (
            <li key={`${span.start}-${span.end}-${span.text}`}>
              <button
                type="button"
                className="kvm-ruby-item"
                data-active={active || undefined}
                onClick={() => selectSpan(span)}
              >
                <span className="kvm-ruby-item-base">
                  {chars.slice(span.start, span.end).join('')}
                </span>
                <span className="kvm-ruby-item-rt">{span.text}</span>
                <span className="kvm-ruby-badge" data-tone={meta.tone} title={meta.hint}>
                  {meta.label}
                </span>
                {span.locked && <span className="kvm-ruby-lock" title="已锁定，自动重算不会覆盖">🔒</span>}
                {needsReview(span) && <span className="kvm-ruby-warn">待核对</span>}
              </button>
              <button
                type="button"
                className="kvm-ruby-seek"
                title="把播放头挪到这里试听"
                onClick={() => seekToSpan(span)}
              >
                ⏱
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default RubyEditor

// ---- 样式 ----

const LEGEND_TEXT: Record<SourceTone, string> = {
  trusted: '歌词源（最可信）',
  ok: '词典',
  guess: '机器推断（需核对）',
  manual: '手工',
}

const panelClass = (extra?: string) => ['kvm-ruby', extra].filter(Boolean).join(' ')

/**
 * 样式内联在组件里：本项目还没有全局样式方案，另起一个 css 文件会和别的界面
 * 抢命名。全部类名以 `kvm-ruby-` 开头，不会外泄。
 */
function Styles() {
  return <style>{CSS}</style>
}

const CSS = `
.kvm-ruby {
  --tone-trusted: #3fa96a;
  --tone-ok: #4a8fd0;
  --tone-guess: #d4901f;
  --tone-manual: #a06fd6;
  --tone-none: transparent;
  background: var(--kvm-panel-bg, #1b1d22);
  color: var(--kvm-fg, #e6e6e6);
  border: 1px solid var(--kvm-border, #33363d);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kvm-ruby button { font: inherit; color: inherit; }
.kvm-ruby-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.kvm-ruby-title { font-weight: 600; }
.kvm-ruby-tag {
  margin-left: 6px; padding: 0 6px; border-radius: 3px; font-size: 11px; font-weight: 400;
  background: #3a3d45;
}
.kvm-ruby-stat { display: flex; gap: 10px; font-size: 12px; color: #9aa0aa; }
.kvm-ruby-warn { color: var(--tone-guess); }
.kvm-ruby-muted { color: #8b909a; font-size: 12px; margin-left: 6px; }
.kvm-ruby-empty { color: #8b909a; margin: 4px 0; }

.kvm-ruby-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: #9aa0aa; }
.kvm-ruby-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.kvm-ruby-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.kvm-ruby-dot[data-tone=trusted] { background: var(--tone-trusted); }
.kvm-ruby-dot[data-tone=ok] { background: var(--tone-ok); }
.kvm-ruby-dot[data-tone=guess] { background: var(--tone-guess); }
.kvm-ruby-dot[data-tone=manual] { background: var(--tone-manual); }

.kvm-ruby-strip {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0 2px;
  padding: 10px 8px 6px; border-radius: 4px;
  background: var(--kvm-canvas, #24272e);
  user-select: none; cursor: text; outline: none;
}
.kvm-ruby-strip:focus-visible { box-shadow: 0 0 0 2px #4a8fd0 inset; }
.kvm-ruby-group { display: flex; flex-direction: column; align-items: center; }
.kvm-ruby-group[data-tone=trusted] { border-bottom: 2px solid var(--tone-trusted); }
.kvm-ruby-group[data-tone=ok] { border-bottom: 2px solid var(--tone-ok); }
.kvm-ruby-group[data-tone=guess] { border-bottom: 2px solid var(--tone-guess); }
.kvm-ruby-group[data-tone=manual] { border-bottom: 2px solid var(--tone-manual); }
.kvm-ruby-group[data-tone=none] { border-bottom: 2px solid transparent; }
.kvm-ruby-rt {
  font-size: 11px; line-height: 1.2; white-space: nowrap; color: #cfd3da;
  min-height: 14px;
}
.kvm-ruby-lock { margin-left: 2px; font-size: 10px; }
.kvm-ruby-base { display: flex; }
.kvm-ruby-ch {
  font-size: 22px; line-height: 1.3; padding: 0 1px; border-radius: 2px;
  cursor: pointer;
}
.kvm-ruby-ch[data-kanji] { color: #ffffff; }
.kvm-ruby-ch:not([data-kanji]) { color: #aeb4bf; }
.kvm-ruby-ch[data-token] { background: #33404f; }
.kvm-ruby-ch[data-selected] { background: #2f6fb5; color: #ffffff; }

.kvm-ruby-todo { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: #9aa0aa; }
.kvm-ruby-chip {
  border: 1px solid #444852; border-radius: 3px;
  padding: 1px 7px; cursor: pointer; background: #2e323a;
}
.kvm-ruby-chip:hover { border-color: var(--tone-guess); }

.kvm-ruby-form { display: flex; flex-direction: column; gap: 6px; }
.kvm-ruby-row { display: flex; gap: 6px; align-items: center; }
.kvm-ruby-input {
  flex: 1; min-width: 0; padding: 5px 8px; font-size: 15px;
  background: #14161a; color: inherit;
  border: 1px solid #444852; border-radius: 3px;
}
.kvm-ruby-input:focus { outline: none; border-color: #4a8fd0; }
.kvm-ruby-btn {
  padding: 5px 10px; border: 1px solid #444852; border-radius: 3px;
  background: #2e323a; cursor: pointer; white-space: nowrap;
}
.kvm-ruby-btn:hover:not(:disabled) { border-color: #6b7280; }
.kvm-ruby-btn:disabled { opacity: 0.45; cursor: default; }
.kvm-ruby-primary { background: #2f6fb5; border-color: #2f6fb5; }
.kvm-ruby-danger:hover:not(:disabled) { border-color: #c05252; color: #e08a8a; }
.kvm-ruby-error { color: #e08a8a; margin: 0; }
.kvm-ruby-notice { color: var(--tone-trusted); margin: 0; }
.kvm-ruby-mora, .kvm-ruby-preview { margin: 0; font-size: 12px; color: #9aa0aa; }
.kvm-ruby-moralist { color: #cfd3da; margin: 0 6px; letter-spacing: 1px; }
.kvm-ruby-piece {
  display: inline-flex; flex-direction: column; align-items: center;
  margin-left: 8px; color: #e6e6e6;
}
.kvm-ruby-piece i { font-style: normal; font-size: 11px; color: var(--tone-manual); }

.kvm-ruby-listhead { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #9aa0aa; }
.kvm-ruby-check { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.kvm-ruby-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto; }
.kvm-ruby-list li { display: flex; align-items: stretch; gap: 2px; }
.kvm-ruby-item {
  flex: 1; display: flex; align-items: center; gap: 8px; text-align: left;
  padding: 4px 8px; border: 1px solid transparent; border-radius: 3px;
  background: #22252b; cursor: pointer;
}
.kvm-ruby-item:hover { border-color: #444852; }
.kvm-ruby-item[data-active] { border-color: #2f6fb5; background: #24303d; }
.kvm-ruby-item-base { font-size: 16px; min-width: 3em; }
.kvm-ruby-item-rt { color: #cfd3da; min-width: 5em; }
.kvm-ruby-badge { font-size: 11px; padding: 0 6px; border-radius: 9px; border: 1px solid currentColor; }
.kvm-ruby-badge[data-tone=trusted] { color: var(--tone-trusted); }
.kvm-ruby-badge[data-tone=ok] { color: var(--tone-ok); }
.kvm-ruby-badge[data-tone=guess] { color: var(--tone-guess); }
.kvm-ruby-badge[data-tone=manual] { color: var(--tone-manual); }
.kvm-ruby-seek {
  padding: 0 8px; border: 1px solid #444852; border-radius: 3px;
  background: #22252b; cursor: pointer;
}
.kvm-ruby-seek:hover { border-color: #6b7280; }
`
