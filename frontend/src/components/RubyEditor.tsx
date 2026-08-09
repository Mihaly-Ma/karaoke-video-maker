/**
 * 歌词正文（注音编辑）—— 合并后的「编辑」舞台的上半区。
 *
 * ## 从独立舞台变成半个舞台
 *
 * 注音原本是独立一步，现在与对轴合并（docs/ui-redesign.md §四）：二者修正的是
 * **同一个选中词**，一个管何时唱、一个管怎么读；而且读音只能靠耳朵验证
 * （「運命」在本曲唱 さだめ 还是 うんめい），独立的注音步骤连播放都没有。
 *
 * 所以本文件不再自己当一个舞台，而是拆成三块可组合的东西：
 *
 * | 导出 | 作用 | 落在合并舞台的哪 |
 * |---|---|---|
 * | `useRubyEditing()` | 全部编辑状态与动作 | 由 `EditStage` 持有，正文与检查器共用同一份 |
 * | `RubyPaper` | 整屏歌词正文 | 上半区右侧 |
 * | `RubyStyles` | 本模块的局部 CSS | 由 `EditStage` 挂一次 |
 *
 * 检查器（两份读音、候选、锁定）在 `RubyInspector`，现在渲染在舞台底栏里，
 * 与时间信息并排——「选中词」这一个概念只在界面上出现一次。
 *
 * ## 为什么"点一下"选中的是词而不是字
 *
 * 注音挂在**行内字符区间**上（`RubySpan.start/end`），而不是 token 上——
 * 「明日」两个字共用「あした」这种熟字訓只有区间才表达得出来。但让用户自己拖出
 * 区间是把数据结构的负担转嫁给他。所以切分交给 `RubyModel.buildUnits`：
 * 已有注音的区间原样成词，其余按汉字块 / 假名串分词，点哪个就是哪个。
 * 需要更细的切分时用「拆送り仮名」，它走 `lib/kana.ts` 的 `alignReading`。
 *
 * ## 选中项是双向的
 *
 * 点正文里的词 → 写全局 `selection`（token 级）→ 时间轴上同一个字高亮；
 * 反过来在逐字轴上点一个字 → `selection` 变化 → 这里落到**覆盖那个 token 的词**上
 * （`unitOfToken`，粒度换算在那儿）。两边共用 store 里的同一个 `selection`，
 * 不再各存一份"当前选中"。
 */

import {
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  LockOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

import type { Palette, Project } from '../api/types'
import { t } from '../i18n'
import { assToCssHex } from '../lib/assColor'
import { alignReading, normalizeKana, toHiragana, validateKana } from '../lib/kana'
import { useProject } from '../state/projectStore'
import { EditLineText, submitLineText } from './EditLineText'
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
  unitOfToken,
  type RubyUnit,
} from './RubyModel'

// ---------------------------------------------------------------- 状态

export interface RubyEditing {
  project: Project | null
  /** 正文里显示的行（默认不含制作名单行） */
  lines: Project['lines']
  lineUnits: Map<string, RubyUnit[]>
  /** 行 id → 工程原序行号。筛选不重排编号，跳号本身就是"这里还有东西"的提示 */
  lineNo: Map<string, number>
  selectedKey: string | null
  selectedUnit: RubyUnit | null
  editingKey: string | null
  editDraft: string
  busy: boolean
  notice: string
  storeError: string | null
  /** 机器猜的 + 缺注音的，聚合成一份待检查清单 */
  review: RubyUnit[]
  stats: { spans: number; locked: number }
  metadataCount: number
  showMetadata: boolean
  paperRef: RefObject<HTMLDivElement>
  phoneticOf: (unit: RubyUnit) => string
  /** 正在改写文本的行；null 表示没有行处于改写态 */
  editingLineId: string | null
  beginLineEdit: (lineId: string) => void
  cancelLineEdit: () => void
  commitLineEdit: (lineId: string, text: string) => void
  setShowMetadata: (v: boolean) => void
  setEditDraft: (v: string) => void
  cancelEdit: () => void
  pick: (unit: RubyUnit, openEditor: boolean) => void
  commitInline: (unit: RubyUnit) => void
  applyReading: (unit: RubyUnit, text: string) => void
  split: (unit: RubyUnit, reading: string) => void
  remove: (unit: RubyUnit) => void
  toggleLock: (unit: RubyUnit) => void
  setPhonetic: (unit: RubyUnit, value: string) => void
}

export function useRubyEditing(): RubyEditing {
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
  const [showMetadata, setShowMetadata] = useState(false)
  const [editingLineId, setEditingLineId] = useState<string | null>(null)

  const paperRef = useRef<HTMLDivElement | null>(null)
  /** Esc 取消时不要让紧随其后的 blur 把草稿写进去 */
  const cancelRef = useRef(false)

  const projectId = project?.id ?? ''

  const metadataCount = useMemo(
    () => (project?.lines ?? []).filter((l) => l.is_metadata).length,
    [project],
  )

  /**
   * 正文里显示哪些行。
   *
   * 制作名单行（歌词源塞进正文的「词：xxx」「编曲：xxx」，CLAUDE.md §6.1）默认不显示：
   * 它们不需要注音，混在歌词里只是噪音，还会把「待检查」清单塞满「编曲」「制作人」
   * 这类根本不是歌词的条目，把真正要复核的当て字淹掉。
   *
   * 但**不能让它们彻底消失**：`is_metadata` 是自动判定，必然有误判，而被误判的那一行
   * 如果在这一步完全看不见，用户就无从发现（CLAUDE.md §2.5：每个自动环节都要有手工旁路）。
   * 出口是正文顶栏那个带数量的开关。
   */
  const lines = useMemo(
    () => (project?.lines ?? []).filter((l) => showMetadata || !l.is_metadata),
    [project, showMetadata],
  )

  const lineNo = useMemo(() => {
    const m = new Map<string, number>()
    ;(project?.lines ?? []).forEach((l, i) => m.set(l.id, i + 1))
    return m
  }, [project])

  // 统计、待检查、候选读音全部只看可见行，三处与正文永远说同一件事
  const lineUnits = useMemo(() => buildProjectUnits(lines), [lines])

  // 时间轴上选中了制作名单行时自动把它们显示出来：从别处选中一行、正文里却找不到它，
  // 比多看几行噪音更让人困惑。
  useEffect(() => {
    if (showMetadata || selection.kind === 'none') return
    if (project?.lines.find((l) => l.id === selection.lineId)?.is_metadata) setShowMetadata(true)
  }, [selection, project, showMetadata])

  // 发音形的本地覆盖层。换工程要整批换掉，否则会把上一首歌的读音带过来
  useEffect(() => {
    setPhonetics(projectId ? loadPhonetics(projectId) : {})
  }, [projectId])

  const selectedUnit = useMemo(() => {
    if (!selectedKey) return null
    const list = lineUnits.get(lineIdOfKey(selectedKey)) ?? []
    return list.find((u) => unitKey(u) === selectedKey) ?? null
  }, [selectedKey, lineUnits])

  /**
   * 全局选中 → 选中词。
   *
   * 时间轴（逐字轴 / 行轨）与正文共用 store 里的同一个 `selection`，所以这里只负责
   * **粒度换算**：selection 是 token 级，注音挂在词上。
   *
   * "当前这个词已经覆盖了选中的 token 就别动"这条判断是必须的：正文里点词时
   * `pick()` 已经把 selectedKey 设好了，若这里再按 token 反查一次，同一个 token 里
   * 并排的两个词（「明日／は」在一个 token 里）会被拉回前一个，用户点 B 选中 A。
   */
  useEffect(() => {
    if (selection.kind === 'none') return
    const list = lineUnits.get(selection.lineId) ?? []
    if (!list.length) return

    if (selection.kind === 'token') {
      const cur = selectedKey ? list.find((u) => unitKey(u) === selectedKey) : null
      if (cur && cur.tokenIndex === selection.tokenIndex) return
      const hit = unitOfToken(list, selection.tokenIndex) ?? list[0]
      setSelectedKey(unitKey(hit))
      setEditingKey(null)
      return
    }

    // 选中的是整行：落到这一行上最该看的那个词
    if (selectedKey && lineIdOfKey(selectedKey) === selection.lineId) return
    const first = list.find((u) => u.missing || u.guess) ?? list.find(canAnnotate) ?? list[0]
    setSelectedKey(first ? unitKey(first) : null)
    setEditingKey(null)
  }, [selection, selectedKey, lineUnits])

  const selLineId = selection.kind === 'none' ? null : selection.lineId
  // 依赖里带上 showMetadata：选中的若是制作名单行，它是上面那个 effect 展开之后
  // 才出现在 DOM 里的，只依赖 selLineId 会在它还不存在时查一次然后再不重试
  useEffect(() => {
    if (!selLineId) return
    const el = paperRef.current?.querySelector(`[data-line="${selLineId}"]`)
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [selLineId, showMetadata])

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
      // 写的是 token 级选中：时间轴、逐字轴、检查器的时间栏都靠它对齐到同一个字
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

  const cancelEdit = useCallback(() => {
    cancelRef.current = true
    setEditingKey(null)
  }, [])

  /** 就地编辑提交。空串 = 清除该区间的注音（后端 `/editor/ruby` 的约定）。 */
  const commitInline = useCallback(
    (u: RubyUnit) => {
      if (cancelRef.current) {
        cancelRef.current = false
        return
      }
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

  const applyReading = useCallback(
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

  const split = useCallback(
    (u: RubyUnit, reading: string) => {
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
      void (async () => {
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
      })()
    },
    [setRubyRemote],
  )

  const remove = useCallback(
    (u: RubyUnit) => {
      setNotice('')
      void write(u, '')
    },
    [write],
  )

  const toggleLock = useCallback(
    (u: RubyUnit) => {
      if (!projectId || !u.span) return
      setBusy(true)
      void (async () => {
        try {
          await setRubyLock(projectId, u.lineId, [u.start, u.end], !u.span?.locked)
          await refresh()
        } catch (e) {
          setNotice(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      })()
    },
    [projectId, refresh],
  )

  const setPhonetic = useCallback(
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

  const phoneticOf = useCallback((u: RubyUnit) => phonetics[phoneticKey(u)] ?? '', [phonetics])

  // ---- 改写行文本（§2.5 的手工旁路：歌词本身也得能改）----

  const beginLineEdit = useCallback((lineId: string) => {
    setNotice('')
    setEditingLineId(lineId)
  }, [])

  const cancelLineEdit = useCallback(() => setEditingLineId(null), [])

  /**
   * 提交改写。**改完立刻回报后果**：保住了几个字的时间、几个字的时间是推算的
   * （逐字轴上是插值色，§7.4）、有没有东西进了「失效修正」清单。
   * 用户改完一个错字最该知道的就是这个，而不是一句"已保存"。
   */
  const commitLineEdit = useCallback(
    (lineId: string, text: string) => {
      setEditingLineId(null)
      const line = project?.lines.find((l) => l.id === lineId)
      const before = line ? line.tokens.map((tk) => tk.text).join('') : ''
      if (!projectId || !line || text.trim() === before) return
      setBusy(true)
      void (async () => {
        try {
          const r = await submitLineText(projectId, lineId, text)
          setNotice(
            t('ruby.lineText.done', { kept: r.kept, guessed: r.guessed }) +
              (r.orphaned > 0 ? t('ruby.lineText.orphaned', { n: r.orphaned }) : ''),
          )
        } catch (e) {
          setNotice(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      })()
    },
    [project, projectId],
  )

  return {
    project,
    lines,
    lineUnits,
    lineNo,
    selectedKey,
    selectedUnit,
    editingKey,
    editDraft,
    busy,
    notice,
    storeError,
    review,
    stats,
    metadataCount,
    showMetadata,
    paperRef,
    phoneticOf,
    editingLineId,
    beginLineEdit,
    cancelLineEdit,
    commitLineEdit,
    setShowMetadata,
    setEditDraft,
    cancelEdit,
    pick,
    commitInline,
    applyReading,
    split,
    remove,
    toggleLock,
    setPhonetic,
  }
}

// ---------------------------------------------------------------- 正文

export interface RubyPaperProps {
  editing: RubyEditing
  /** 待检查清单是否展开。清单占横向空间，默认收着，靠这个按钮找回来 */
  reviewOpen: boolean
  onToggleReview: () => void
}

/**
 * 整屏歌词正文：按成片样式渲染（真实字体、真实配色、注音排在字上方），
 * 每个词用下划线颜色标出读音来源（CLAUDE.md §7.4），点词就地改读音。
 */
export function RubyPaper({ editing, reviewOpen, onToggleReview }: RubyPaperProps) {
  const {
    project,
    lines,
    lineUnits,
    lineNo,
    selectedKey,
    editingKey,
    editDraft,
    busy,
    notice,
    storeError,
    review,
    stats,
    metadataCount,
    showMetadata,
    paperRef,
    editingLineId,
    beginLineEdit,
    cancelLineEdit,
    commitLineEdit,
    setShowMetadata,
    setEditDraft,
    cancelEdit,
    pick,
    commitInline,
  } = editing

  const selection = useProject((s) => s.selection)
  const selLineId = selection.kind === 'none' ? null : selection.lineId

  if (!project) {
    return <p className="kvm-ruby__muted">{t('ruby.empty.project')}</p>
  }

  return (
    <div className="kvm-ruby__canvas">
      <div className="kvm-ruby__bar">
        <span className="num">{t('ruby.stat.spans', { n: stats.spans })}</span>
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

        {/* 制作名单行的出口。没有这种行时连按钮都不出现，免得多一个永远点不出东西的开关 */}
        {metadataCount > 0 && (
          <button
            type="button"
            className="small kvm-ruby__metatoggle"
            aria-pressed={showMetadata}
            data-on={showMetadata || undefined}
            onClick={() => setShowMetadata(!showMetadata)}
          >
            {showMetadata ? <EyeOutlined /> : <EyeInvisibleOutlined />}
            {t('ruby.metadata.toggle', { n: metadataCount })}
          </button>
        )}

        {/* 待检查清单的开关：数量本身就是这一步还剩多少活的硬指标，所以常驻 */}
        <button
          type="button"
          className="small kvm-ruby__reviewtoggle"
          aria-pressed={reviewOpen}
          data-on={reviewOpen || undefined}
          data-warn={review.length > 0 || undefined}
          onClick={onToggleReview}
        >
          <WarningOutlined />
          {t('ruby.review.title')} <span className="num">{review.length}</span>
        </button>

        {notice && <span className="kvm-ruby__notice">{notice}</span>}
        {storeError && <span className="error">{storeError}</span>}
      </div>

      <div className="kvm-ruby__paper" ref={paperRef} style={paperFont(project.style.font_name)}>
        {project.lines.length === 0 && <p className="kvm-ruby__muted">{t('ruby.empty.lines')}</p>}
        {project.lines.length > 0 && lines.length === 0 && (
          <p className="kvm-ruby__muted">{t('ruby.empty.allMetadata')}</p>
        )}

        {lines.map((line) => {
          const units = lineUnits.get(line.id) ?? []
          const lineTextValue = line.tokens.map((tk) => tk.text).join('')
          if (editingLineId === line.id) {
            return (
              <div key={line.id} className="kvm-ruby__line" data-line={line.id} data-editing>
                <span className="kvm-ruby__no num">{lineNo.get(line.id)}</span>
                <EditLineText
                  value={lineTextValue}
                  busy={busy}
                  onCommit={(text) => commitLineEdit(line.id, text)}
                  onCancel={cancelLineEdit}
                />
              </div>
            )
          }
          return (
            <div
              key={line.id}
              className="kvm-ruby__line"
              data-line={line.id}
              data-meta={line.is_metadata || undefined}
              data-active={selLineId === line.id || undefined}
              style={paletteVars(project.palettes[line.voice_part] ?? project.palettes['main'])}
            >
              <span className="kvm-ruby__no num">{lineNo.get(line.id)}</span>
              <span className="kvm-ruby__text">
                {units.length === 0 && <span className="kvm-ruby__muted">{t('ruby.empty.line')}</span>}
                {units.map((u) => {
                  const k = unitKey(u)
                  const rt = u.span?.text ?? ''
                  return (
                    <span
                      key={k}
                      className="kvm-ruby__unit"
                      data-unit={k}
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
                            if (e.key === 'Escape') cancelEdit()
                          }}
                          onBlur={() => commitInline(u)}
                        />
                      )}
                    </span>
                  )
                })}
              </span>
              {line.is_metadata && <span className="kvm-ruby__tag">{t('ruby.metadata')}</span>}
              {/*
                改写这一行的文字。§2.5 要求每个自动环节都有等价的手工旁路，
                而歌词文本此前是唯一空着的一档——改一个错字得把整首歌重贴一遍。
              */}
              <button
                type="button"
                className="iconbtn kvm-ruby__linebtn"
                data-role="edit-line-text"
                title={t('ruby.lineText.edit')}
                aria-label={t('ruby.lineText.edit')}
                onClick={() => beginLineEdit(line.id)}
              >
                <EditOutlined />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- 样式 ----

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

/** 本模块的局部 CSS。由舞台挂一次，正文与检查器共用。 */
export function RubyStyles() {
  return <style>{CSS}</style>
}

/*
 * 取值一律来自 styles.css 的设计 token（docs/ui-redesign.md §六点五）。
 * 唯一的例外是歌词纸的字号与描边比例：那是**成片排版**而不是界面排版，
 * 与界面字号刻度无关，所以按倍率从 --fs-2xl 推出来并集中在本块顶部。
 *
 * 倍率从 1.5 降到 1.2：合并之后正文只占舞台上半区的一部分，1.5 倍下一屏只剩
 * 四五行，"整首歌里找出机器猜错的读音"这件事就退化成逐行翻页。
 */
const CSS = `
.kvm-ruby__canvas {
  --paper-fs: calc(var(--fs-2xl) * 1.2);
  --paper-stroke: 0.05em;
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
  padding-bottom: var(--sp-2);
  border-bottom: var(--hairline);
  font-size: var(--fs-sm);
  color: var(--fg-2);
}
.kvm-ruby__spacer { flex: 1 1 auto; }
.kvm-ruby__metatoggle, .kvm-ruby__reviewtoggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: var(--sp-1); }
/* 打开时按"手工干预"着色：这是一次显式的额外显示，不是默认状态 */
.kvm-ruby__metatoggle[data-on] { color: var(--src-manual); border-color: var(--src-manual); }
.kvm-ruby__reviewtoggle[data-warn] { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--stroke)); }
.kvm-ruby__reviewtoggle[data-on] { background: var(--accent-weak); border-color: var(--accent); }
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
  margin-top: var(--sp-2);
  padding: var(--sp-3);
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
.kvm-ruby__line[data-editing] { background: var(--bg-surface); align-items: center; }

/* 改文字的入口：常驻会在每一行右边挂一排图标，喧宾夺主；只在这一行上时露出来 */
.kvm-ruby__linebtn { flex: 0 0 auto; align-self: center; opacity: 0; }
.kvm-ruby__line:hover .kvm-ruby__linebtn,
.kvm-ruby__line[data-active] .kvm-ruby__linebtn,
.kvm-ruby__linebtn:focus-visible { opacity: 1; }

.edit-linetext { flex: 1 1 auto; display: flex; align-items: center; gap: var(--sp-1); min-width: 0; }
.edit-linetext__input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-xl);
  -webkit-text-stroke-width: 0;
}
/* 展开出来的制作名单行压暗：它们在这一步不是工作对象，只是拿来核对判定对不对 */
.kvm-ruby__line[data-meta] { opacity: 0.6; }
.kvm-ruby__no {
  flex: 0 0 auto;
  width: var(--sp-5);
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

/* ---- 检查器与待检查清单共用的盒子 ---- */

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
/*
 * 底栏形态：检查器与走带、时间栏同处一条横带，所以字段横排。
 * 盒子本身不再画边框——它已经坐在底栏那条分隔线上，再套一层框只是噪音。
 */
.kvm-ruby__box--bar {
  flex: 1 1 auto;
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
  padding: 0;
  min-width: 0;
  background: transparent;
  border: none;
}
.kvm-ruby__box--bar .kvm-ruby__field { flex: 0 1 168px; }
.kvm-ruby__box--bar .kvm-ruby__field input { font-size: var(--fs-md); }
.kvm-ruby__box--bar .kvm-ruby__cands { flex: 0 1 auto; min-width: 0; }
.kvm-ruby__box--bar .kvm-ruby__chips { flex-wrap: nowrap; overflow-x: auto; max-width: 220px; }

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
  white-space: nowrap;
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
