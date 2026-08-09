/**
 * 注音（振り仮名）舞台。
 *
 * ## 主对象是「逐词的读音」，所以中间整屏就是歌词本身
 *
 * 上一版是为竖直窄侧栏设计的：把一行拆成字符条，靠拖选字符区间来指定注音范围。
 * 那套交互在窄栏里成立，在整屏下毫无收益——字符条横向拉长只是变成一条更长的条，
 * 而用户真正要做的事是**在整首歌里找出机器猜错的读音**，那需要同时看到很多行。
 *
 * 现在中间按成片样式渲染整首歌词（真实字体、真实配色、注音排在字上方），
 * 每个词的读音来源用下划线颜色标出（CLAUDE.md §7.4：provider / dict / 推断 / 手工
 * 必须在界面上可见地区分），点词就地改读音，右侧辅助栏放两份读音、候选与锁定。
 *
 * ## 为什么"点一下"选中的是词而不是字
 *
 * 注音挂在**行内字符区间**上（`RubySpan.start/end`），而不是 token 上——
 * 「明日」两个字共用「あした」这种熟字訓只有区间才表达得出来。但让用户自己拖出
 * 区间是把数据结构的负担转嫁给他。所以切分交给 `RubyModel.buildUnits`：
 * 已有注音的区间原样成词，其余按汉字块 / 假名串分词，点哪个就是哪个。
 * 需要更细的切分时用「拆送り仮名」，它走 `lib/kana.ts` 的 `alignReading`。
 *
 * ## 不放波形
 *
 * 改读音不需要看波形（docs/ui-redesign.md §四）。读音改了会改拍数、进而改时间轴
 * 切分单位，但那是对轴那一步的事，在这里摆一条波形只会抢走屏幕。
 */

import { LockOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type { Palette } from '../api/types'
import { t } from '../i18n'
import { assToCssHex } from '../lib/assColor'
import { alignReading, normalizeKana, toHiragana, validateKana } from '../lib/kana'
import { useProject } from '../state/projectStore'
import { RubyInspector, RubyReviewList } from './RubyInspector'
import {
  buildProjectUnits,
  canAnnotate,
  derivePhonetic,
  lineIdOfKey,
  loadPhonetics,
  persistPhonetics,
  phoneticKey,
  setRubyLock,
  SOURCE_LABEL_KEY,
  SOURCE_ORDER,
  unitKey,
  type RubyUnit,
} from './RubyModel'

export interface RubyEditorProps {
  className?: string
}

export function RubyEditor({ className }: RubyEditorProps) {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const select = useProject((s) => s.select)
  const setRubyRemote = useProject((s) => s.setRuby)
  const refresh = useProject((s) => s.refresh)
  const storeError = useProject((s) => s.error)

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [phonetics, setPhonetics] = useState<Record<string, string>>({})

  const paperRef = useRef<HTMLDivElement | null>(null)
  /** Esc 取消时不要让紧随其后的 blur 把草稿写进去 */
  const cancelRef = useRef(false)

  const projectId = project?.id ?? ''
  const lineUnits = useMemo(() => buildProjectUnits(project), [project])

  // 发音形的本地覆盖层。换工程要整批换掉，否则会把上一首歌的读音带过来
  useEffect(() => {
    setPhonetics(projectId ? loadPhonetics(projectId) : {})
  }, [projectId])

  const selectedUnit = useMemo(() => {
    if (!selectedKey) return null
    const list = lineUnits.get(lineIdOfKey(selectedKey)) ?? []
    return list.find((u) => unitKey(u) === selectedKey) ?? null
  }, [selectedKey, lineUnits])

  // 外面（左侧行列表、外壳的自动选行）换了行时，把选中词落到这一行上最该看的那个词
  useEffect(() => {
    if (selection.kind === 'none') return
    if (selectedKey && lineIdOfKey(selectedKey) === selection.lineId) return
    const list = lineUnits.get(selection.lineId) ?? []
    const first = list.find((u) => u.missing || u.guess) ?? list.find(canAnnotate) ?? list[0]
    setSelectedKey(first ? unitKey(first) : null)
    setEditingKey(null)
  }, [selection, selectedKey, lineUnits])

  const selLineId = selection.kind === 'none' ? null : selection.lineId
  useEffect(() => {
    if (!selLineId) return
    const el = paperRef.current?.querySelector(`[data-line="${selLineId}"]`)
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [selLineId])

  const review = useMemo(() => {
    const out: RubyUnit[] = []
    for (const list of lineUnits.values()) {
      for (const u of list) if (u.guess || u.missing) out.push(u)
    }
    return out
  }, [lineUnits])

  const stats = useMemo(() => {
    let spans = 0
    let locked = 0
    for (const list of lineUnits.values()) {
      for (const u of list) {
        if (!u.span) continue
        spans++
        if (u.span.locked) locked++
      }
    }
    return { spans, locked }
  }, [lineUnits])

  const write = useCallback(
    async (u: RubyUnit, text: string) => {
      setBusy(true)
      try {
        await setRubyRemote(u.lineId, u.start, u.end, text)
      } finally {
        setBusy(false)
      }
    },
    [setRubyRemote],
  )

  const pick = useCallback(
    (u: RubyUnit, openEditor: boolean) => {
      setNotice('')
      setSelectedKey(unitKey(u))
      select({ kind: 'token', lineId: u.lineId, tokenIndex: u.tokenIndex })
      if (openEditor && canAnnotate(u)) {
        setEditDraft(u.span?.text ?? '')
        setEditingKey(unitKey(u))
      } else {
        setEditingKey(null)
      }
    },
    [select],
  )

  /** 就地编辑提交。空串 = 清除该区间的注音（后端 `/editor/ruby` 的约定）。 */
  const commitInline = useCallback(
    (u: RubyUnit) => {
      setEditingKey(null)
      const text = normalizeKana(editDraft)
      if (text === (u.span?.text ?? '')) return
      if (text) {
        const v = validateKana(text)
        if (!v.ok) {
          setNotice(v.message)
          return
        }
      }
      void write(u, text)
    },
    [editDraft, write],
  )

  const handleApply = useCallback(
    (u: RubyUnit, text: string) => {
      if (text) {
        const v = validateKana(text)
        if (!v.ok) {
          setNotice(v.message)
          return
        }
      }
      setNotice('')
      void write(u, text)
    },
    [write],
  )

  const handleSplit = useCallback(
    async (u: RubyUnit, reading: string) => {
      const kana = normalizeKana(reading)
      const pieces = alignReading(u.text, kana)
      if (pieces === null) {
        setNotice(t('ruby.msg.splitFailed'))
        return
      }
      if (pieces.length === 0) {
        setNotice(t('ruby.msg.noKanji'))
        return
      }
      // 输入里出现片假名就按片假名落库：「本気 → マジ」是原文意图，归一化会毁掉它
      const wantsKatakana = /[ァ-ヺ]/.test(kana)
      setBusy(true)
      try {
        // 每次调用都返回完整新工程，必须串行；字符下标不受注音改动影响，可以沿用
        for (const p of pieces) {
          await setRubyRemote(
            u.lineId,
            u.start + p.start,
            u.start + p.end,
            wantsKatakana ? p.text : toHiragana(p.text),
          )
        }
        setNotice(t('ruby.msg.splitDone', { n: pieces.length }))
      } finally {
        setBusy(false)
      }
    },
    [setRubyRemote],
  )

  const handleDelete = useCallback(
    (u: RubyUnit) => {
      setNotice('')
      void write(u, '')
    },
    [write],
  )

  const handleLock = useCallback(
    async (u: RubyUnit) => {
      if (!projectId || !u.span) return
      setBusy(true)
      try {
        await setRubyLock(projectId, u.lineId, [u.start, u.end], !u.span.locked)
        await refresh()
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [projectId, refresh],
  )

  const handlePhonetic = useCallback(
    (u: RubyUnit, value: string) => {
      if (!projectId) return
      const next = { ...phonetics }
      const k = phoneticKey(u)
      const v = normalizeKana(value)
      const derived = derivePhonetic(u.span?.text ?? (u.kind === 'kana' ? u.text : ''))
      // 与推导值一致就不必留一条覆盖：覆盖层越薄，将来搬到后端时要迁移的东西越少
      if (!v || v === derived) delete next[k]
      else next[k] = v
      setPhonetics(next)
      persistPhonetics(projectId, next)
    },
    [projectId, phonetics],
  )

  if (!project) {
    return (
      <div className={cls(className)}>
        <RubyStyles />
        <p className="kvm-ruby__muted">{t('ruby.empty.project')}</p>
      </div>
    )
  }

  return (
    <div className={cls(className)}>
      <RubyStyles />

      <div className="kvm-ruby__canvas">
        <div className="kvm-ruby__bar">
          <span className="num">{t('ruby.stat.spans', { n: stats.spans })}</span>
          {review.length > 0 && (
            <span className="num kvm-ruby__warn">{t('ruby.stat.review', { n: review.length })}</span>
          )}
          {stats.locked > 0 && <span className="num">{t('ruby.stat.locked', { n: stats.locked })}</span>}

          <span className="kvm-ruby__legend">
            <span className="kvm-ruby__label">{t('ruby.legend')}</span>
            {SOURCE_ORDER.map((s) => (
              <span key={s} className="kvm-ruby__swatch" data-src={s}>
                <i />
                {t(SOURCE_LABEL_KEY[s])}
              </span>
            ))}
          </span>

          <span className="kvm-ruby__spacer" />
          {notice && <span className="kvm-ruby__notice">{notice}</span>}
          {storeError && <span className="error">{storeError}</span>}
        </div>

        <div className="kvm-ruby__paper" ref={paperRef} style={paperFont(project.style.font_name)}>
          {project.lines.length === 0 && <p className="kvm-ruby__muted">{t('ruby.empty.lines')}</p>}

          {project.lines.map((line, i) => {
            const units = lineUnits.get(line.id) ?? []
            return (
              <div
                key={line.id}
                className="kvm-ruby__line"
                data-line={line.id}
                data-active={selLineId === line.id || undefined}
                style={paletteVars(project.palettes[line.voice_part] ?? project.palettes['main'])}
              >
                <span className="kvm-ruby__no num">{i + 1}</span>
                <span className="kvm-ruby__text">
                  {units.length === 0 && <span className="kvm-ruby__muted">{t('ruby.empty.line')}</span>}
                  {units.map((u) => {
                    const k = unitKey(u)
                    const rt = u.span?.text ?? ''
                    return (
                      <span
                        key={k}
                        className="kvm-ruby__unit"
                        data-src={u.missing ? 'missing' : u.src}
                        data-selected={k === selectedKey || undefined}
                        tabIndex={0}
                        onClick={() => pick(u, true)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') pick(u, true)
                        }}
                      >
                        <ruby>
                          {u.text}
                          {rt && <rt className="kvm-ruby__rt">{rt}</rt>}
                        </ruby>
                        {u.span?.locked && <LockOutlined className="kvm-ruby__lockmark" />}
                        {editingKey === k && (
                          <input
                            className="kvm-ruby__inline"
                            type="text"
                            value={editDraft}
                            autoFocus
                            disabled={busy}
                            placeholder={t('ruby.field.displayPlaceholder')}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              e.stopPropagation()
                              if (e.key === 'Enter') commitInline(u)
                              if (e.key === 'Escape') {
                                cancelRef.current = true
                                setEditingKey(null)
                              }
                            }}
                            onBlur={() => {
                              if (cancelRef.current) {
                                cancelRef.current = false
                                return
                              }
                              commitInline(u)
                            }}
                          />
                        )}
                      </span>
                    )
                  })}
                </span>
                {line.is_metadata && <span className="kvm-ruby__tag">{t('ruby.metadata')}</span>}
              </div>
            )
          })}
        </div>
      </div>

      <aside className="kvm-ruby__rail">
        <RubyInspector
          unit={selectedUnit}
          units={lineUnits}
          busy={busy}
          phoneticOverride={selectedUnit ? (phonetics[phoneticKey(selectedUnit)] ?? '') : ''}
          onApplyReading={handleApply}
          onSplit={(u, r) => void handleSplit(u, r)}
          onDelete={handleDelete}
          onToggleLock={(u) => void handleLock(u)}
          onPhonetic={handlePhonetic}
        />
        <RubyReviewList items={review} activeKey={selectedKey} onPick={(u) => pick(u, false)} />
      </aside>
    </div>
  )
}

export default RubyEditor

// ---- 样式 ----

const cls = (extra?: string) => ['kvm-ruby', extra].filter(Boolean).join(' ')

/** 预览用工程自己的字体，这一步的判断（注音挤不挤、字够不够宽）依赖真实字形 */
const paperFont = (family: string): CSSProperties =>
  ({ '--ruby-font': `"${family}", var(--font-ui)` }) as CSSProperties

/**
 * 每行按自己的声部配色渲染。
 *
 * 取的是**未唱**的一组颜色：这一步看的是静态的字，不是扫色过程；
 * 配色缺失或格式非法时退回界面前景/画布色，绝不因为一个颜色字符串把整屏渲染掉。
 */
function paletteVars(p: Palette | undefined): CSSProperties {
  const safe = (v: string | undefined, fallback: string) => {
    if (!v) return fallback
    try {
      return assToCssHex(v)
    } catch {
      return fallback
    }
  }
  return {
    '--ruby-fill': safe(p?.unsung_fill, 'var(--fg)'),
    '--ruby-outline': safe(p?.unsung_outline, 'var(--bg-canvas)'),
  } as CSSProperties
}

function RubyStyles() {
  return <style>{CSS}</style>
}

/*
 * 取值一律来自 styles.css 的设计 token（docs/ui-redesign.md §六点五）。
 * 唯一的例外是歌词纸的字号与描边比例：那是**成片排版**而不是界面排版，
 * 与界面字号刻度无关，所以按倍率从 --fs-2xl 推出来并集中在本块顶部。
 */
const CSS = `
.kvm-ruby {
  --paper-fs: calc(var(--fs-2xl) * 1.5);
  --paper-stroke: 0.055em;
  --rail-w: 300px;
  display: flex;
  gap: var(--sp-4);
  height: 100%;
  min-height: 0;
}

.kvm-ruby__canvas {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.kvm-ruby__bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding-bottom: var(--sp-3);
  border-bottom: var(--hairline);
  font-size: var(--fs-sm);
  color: var(--fg-2);
}
.kvm-ruby__spacer { flex: 1 1 auto; }
.kvm-ruby__warn { color: var(--warn); }
.kvm-ruby__notice { color: var(--ok); }
.kvm-ruby__muted { color: var(--fg-3); margin: 0; }

.kvm-ruby__legend { display: inline-flex; align-items: center; gap: var(--sp-2); }
.kvm-ruby__swatch {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--fg-2);
}
.kvm-ruby__swatch i {
  display: inline-block;
  width: var(--sp-3);
  height: var(--sp-1);
  border-radius: var(--r-pill);
  background: var(--fg-3);
}
.kvm-ruby__swatch[data-src=provider] i { background: var(--src-provider); }
.kvm-ruby__swatch[data-src=dict] i { background: var(--src-aligned); }
.kvm-ruby__swatch[data-src=guess] i { background: var(--src-interp); }
.kvm-ruby__swatch[data-src=manual] i { background: var(--src-manual); }

/* 歌词纸：按成片样式渲染，不套用界面配色（docs/ui-redesign.md §六） */
.kvm-ruby__paper {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  margin-top: var(--sp-3);
  padding: var(--sp-4) var(--sp-3);
  background: var(--bg-canvas);
  border: var(--hairline);
  border-radius: var(--r-lg);
  font-family: var(--ruby-font, var(--font-ui));
}

.kvm-ruby__line {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-md);
}
.kvm-ruby__line[data-active] { background: var(--accent-weak); }
.kvm-ruby__no {
  flex: 0 0 auto;
  width: var(--sp-6);
  text-align: right;
  font-size: var(--fs-sm);
  color: var(--fg-3);
  padding-bottom: var(--sp-1);
}
.kvm-ruby__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--paper-fs);
  font-weight: 700;
  line-height: 1.9;
  color: var(--ruby-fill, var(--fg));
  -webkit-text-stroke: var(--paper-stroke) var(--ruby-outline, var(--bg-canvas));
  paint-order: stroke fill;
}
.kvm-ruby__tag {
  flex: 0 0 auto;
  align-self: center;
  font-size: var(--fs-xs);
  padding: 0 var(--sp-2);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  color: var(--fg-3);
}

/*
 * 来源标记：先做下划线（docs/ui-redesign.md §八未决项的处置）。
 * 粗细用 em，跟着成片字号缩放，换字号不用回来改这里。
 */
.kvm-ruby__unit {
  position: relative;
  display: inline-block;
  cursor: pointer;
  border-bottom: 0.09em solid transparent;
}
.kvm-ruby__unit[data-src=provider] { border-bottom-color: var(--src-provider); }
.kvm-ruby__unit[data-src=dict] { border-bottom-color: var(--src-aligned); }
.kvm-ruby__unit[data-src=guess] { border-bottom-color: var(--src-interp); }
.kvm-ruby__unit[data-src=manual] { border-bottom-color: var(--src-manual); }
/* 有汉字却没读音：虚线 + 危险色，它比"猜错了"更需要先被看到 */
.kvm-ruby__unit[data-src=missing] {
  border-bottom-style: dotted;
  border-bottom-color: var(--danger);
}
.kvm-ruby__unit:hover { background: var(--accent-weak); }
.kvm-ruby__unit[data-selected] {
  background: var(--accent-weak);
  outline: var(--hairline-strong);
}
.kvm-ruby__unit:focus-visible { outline: 2px solid var(--accent); }
.kvm-ruby__rt {
  font-size: 0.45em;
  font-weight: 600;
  ruby-align: center;
}
/* 锁标浮在注音带的角上，不占排版位置也不吃点击——点它应该等于点这个词 */
.kvm-ruby__lockmark {
  position: absolute;
  right: 0;
  top: 0;
  pointer-events: none;
  font-size: var(--fs-xs);
  color: var(--src-manual);
  -webkit-text-stroke-width: 0;
}

/* 就地编辑框浮在注音位置上，不参与 ruby 排版，改字时整行不会跳 */
.kvm-ruby__inline {
  position: absolute;
  left: 50%;
  bottom: 100%;
  transform: translateX(-50%);
  z-index: 5;
  min-width: 6em;
  max-width: 12em;
  padding: 0 var(--sp-1);
  text-align: center;
  font-size: var(--fs-md);
  font-weight: 400;
  color: var(--fg);
  background: var(--bg-surface);
  border: var(--hairline);
  border-color: var(--accent);
  border-radius: var(--r-sm);
  -webkit-text-stroke-width: 0;
}

/* ---- 右侧辅助栏 ---- */

.kvm-ruby__rail {
  flex: 0 0 var(--rail-w);
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.kvm-ruby__box {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--bg-panel);
  border: var(--hairline);
  border-radius: var(--r-lg);
}
.kvm-ruby__box--grow { flex: 1 1 auto; min-height: 0; }
.kvm-ruby__boxtitle {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--fg-2);
}
.kvm-ruby__count { margin-left: auto; color: var(--fg-3); font-size: var(--fs-xs); }

.kvm-ruby__word { display: flex; align-items: center; gap: var(--sp-2); }
.kvm-ruby__wordtext { font-size: var(--fs-xl); font-weight: 600; }

.kvm-ruby__field { display: flex; flex-direction: column; gap: var(--sp-1); }
.kvm-ruby__field input { width: 100%; font-size: var(--fs-lg); }
.kvm-ruby__label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--fg-2);
}
.kvm-ruby__badge {
  font-size: var(--fs-xs);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: var(--bg-raise);
  color: var(--fg-3);
}
.kvm-ruby__meta {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--fg-2);
}
.kvm-ruby__moras { color: var(--fg); letter-spacing: 0.08em; }
.kvm-ruby__error { margin: 0; font-size: var(--fs-sm); color: var(--danger); }
.kvm-ruby__row { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.kvm-ruby__row button[data-on] { color: var(--src-manual); border-color: var(--src-manual); }

.kvm-ruby__cands { display: flex; flex-direction: column; gap: var(--sp-1); }
.kvm-ruby__chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.kvm-ruby__cand {
  padding: 0 var(--sp-2);
  font-size: var(--fs-sm);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
}

.kvm-ruby__chip {
  font-size: var(--fs-xs);
  padding: 0 var(--sp-2);
  border-radius: var(--r-pill);
  border: var(--hairline);
  color: var(--fg-2);
}
.kvm-ruby__chip[data-src=provider] { color: var(--src-provider); border-color: var(--src-provider); }
.kvm-ruby__chip[data-src=dict] { color: var(--src-aligned); border-color: var(--src-aligned); }
.kvm-ruby__chip[data-src=guess] { color: var(--src-interp); border-color: var(--src-interp); }
.kvm-ruby__chip[data-src=manual] { color: var(--src-manual); border-color: var(--src-manual); }
.kvm-ruby__chip[data-src=none] { color: var(--danger); border-color: var(--danger); }

.kvm-ruby__list {
  list-style: none;
  margin: 0;
  padding: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.kvm-ruby__listitem {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  text-align: left;
  padding: var(--sp-1) var(--sp-2);
  background: transparent;
  border-color: transparent;
}
.kvm-ruby__listitem[data-active] { background: var(--accent-weak); border-color: var(--accent); }
.kvm-ruby__listbase { flex: 0 0 auto; font-size: var(--fs-lg); }
.kvm-ruby__listrt {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  color: var(--fg-2);
}
`
