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

import type { Line, Palette, Project } from '../api/types'
import { t } from '../i18n'
import { assToCssHex } from '../lib/assColor'
import { alignReading, normalizeKana, toHiragana, validateKana } from '../lib/kana'
import { locateLineId, useProject } from '../state/projectStore'
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

  /**
   * 待检查清单。**制作名单行永远不进来**，即使此刻正显示着它们。
   *
   * `lineUnits` 是按"正文里显示哪些行"建的，而制作名单行有一个开关能把它们显示
   * 出来（时间轴上选中一条名单行时还会自动打开）。开关一开，「词：片岡健太」
   * 「编曲：sumika」这些根本不唱的行就会挤进清单，把真正要复核的当て字淹掉 ——
   * 而清单的数字正是"这一步还剩多少活"的硬指标，掺了假就没法用。
   */
  const metaIds = useMemo(
    () => new Set((project?.lines ?? []).filter((l) => l.is_metadata).map((l) => l.id)),
    [project],
  )
  const review = useMemo(() => {
    const out: RubyUnit[] = []
    for (const [lineId, list] of lineUnits) {
      if (metaIds.has(lineId)) continue
      for (const u of list) if (u.guess || u.missing) out.push(u)
    }
    return out
  }, [lineUnits, metaIds])

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
      /*
       * 点词 = 把播放位置也挪过来。「选中」与「正在唱」已经合成一件事，
       * 而验证读音本来就只能靠耳朵（「運命」在本曲唱 さだめ 还是 うんめい），
       * 点完还要自己去拖进度条找这句，等于把最常做的一步留给用户手动完成。
       *
       * 只写 store 的播放头，真正的 seek 由 Preview 执行（D15：唯一时钟）。
       * 加上整曲偏移换算成音频时间——工程时间与音频时间差的就是这个数。
       */
      const st = useProject.getState()
      const tk = st.project?.lines.find((l) => l.id === u.lineId)?.tokens[u.tokenIndex]
      if (tk) st.setPlayhead(Math.max(0, Math.round(tk.start_ms + (st.project?.global_offset_ms ?? 0))))
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

// ---------------------------------------------------------------- 跟随播放

/**
 * 用户手动滚过歌词之后，暂停自动滚动多久。
 *
 * 有这个缓冲是因为**被界面拽着走比不滚更烦人**：用户往上翻两行去核对前一句时，
 * 自动滚动会立刻把视口抢回去，那两行永远看不成。到点自愈而不是永久关闭，
 * 是为了不让"跟随"悄无声息地失效——真要长期关掉，工具条上的「跟随」才是那个开关。
 */
const FOLLOW_RESUME_MS = 4000

/**
 * 自己滚完之后这么久内的 `scroll` 事件不算用户操作。
 *
 * `scrollTop = x` 触发的 scroll 事件是异步派发的（浏览器在 rAF 时机发），
 * 不加这道闸门，每一次自动滚动都会把自己当成"用户在滚"，跟随就此停摆。
 */
const SELF_SCROLL_GRACE_MS = 150

/**
 * 跟着播放头高亮当前行，并在必要时把它滚进视口。
 *
 * ## 为什么整块都是命令式的
 *
 * `playheadMs` 是 60fps 级别的更新，而歌词正文有近百行、每行十几个 `<span>`。
 * 把它订阅成 React state（`useProject((s) => s.playheadMs)`）会让整屏歌词
 * **每帧重建一次虚拟 DOM 并做一次协调**——这不是"可能有点卡"，是必然的掉帧。
 *
 * 所以这里只做两件事：算出"当前是哪一行"（只在跨行时才变），
 * 然后直接给那个 DOM 节点挂 `data-playing`。React 全程不参与，
 * 一次跨行只产生 2 次属性变更（摘掉旧的、挂上新的）。
 *
 * ## 为什么每次渲染后还要重贴一次
 *
 * `data-playing` 不在 JSX 里，React 不认识它：正文因别的原因重渲时
 * （改写行文本、拆行、展开制作名单）新建出来的行节点身上没有这个属性，
 * 高亮就会凭空消失，而播放头并没有变、订阅回调也不会再触发。
 * 兜底是渲染后无条件重贴一次，代价是两次 querySelector。
 *
 * ## 播放高亮 ≠ 选中
 *
 * 两者是不同的东西，视觉必须分开：选中是**编辑焦点**（底栏检查器在编谁），
 * 播放高亮是**现在唱到这里**，它们经常落在不同的行上（一边听一边改前一句时
 * 总是如此）。所以这里只写 `data-playing`，绝不去碰 `selection`。
 */
function usePlayheadLine(
  paperRef: RefObject<HTMLDivElement>,
  suspended: boolean,
  /**
   * 歌词纸这一刻是否已经渲染出来。**必须显式传进来当依赖**：
   * 工程还在加载时正文整块不渲染，`paperRef.current` 是 null，
   * 只挂一次的 effect 会当场返回、而且再也不会重跑 —— 监听器就此永远没挂上。
   * 实测代价：用户滚动歌词后自动滚动照抢不误（抑制完全失效），
   * 而高亮本身照常工作，所以肉眼很难发现是"监听没挂"。
   */
  ready: boolean,
): void {
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended

  /** 当前高亮的行 id。刻意用 ref：它每帧都要被重新求值，进 state 就前功尽弃 */
  const lineIdRef = useRef<string | null>(null)
  /** 最近一次用户手动滚动的时刻 */
  const userScrollAtRef = useRef(0)
  /** 最近一次自己滚动的时刻，用来把自己触发的 scroll 事件排除掉 */
  const selfScrollAtRef = useRef(0)

  const applyRef = useRef<(force: boolean) => void>(() => undefined)
  applyRef.current = (force: boolean) => {
    const paper = paperRef.current
    if (!paper) return
    const { project, playheadMs, followPlayhead } = useProject.getState()
    const id = locateLineId(project, playheadMs)
    const changed = id !== lineIdRef.current
    if (!changed && !force) return
    lineIdRef.current = id

    const prev = paper.querySelector('[data-playing]')
    if (prev instanceof HTMLElement && prev.dataset.line !== id) prev.removeAttribute('data-playing')
    if (!id) return
    const el = paper.querySelector(`[data-line="${id}"]`)
    if (!(el instanceof HTMLElement)) return
    el.setAttribute('data-playing', '')

    // 只在**跨行**时才考虑滚动。重贴（force）不滚：那是渲染后的补写，
    // 视口本来就没有理由动
    if (!changed || !followPlayhead || suspendedRef.current) return
    if (Date.now() - userScrollAtRef.current < FOLLOW_RESUME_MS) return
    scrollLineIntoView(paper, el, selfScrollAtRef)
  }

  // 渲染后重贴。无依赖数组 = 每次渲染都跑，这正是本 effect 的用途（见上）
  useEffect(() => {
    applyRef.current(true)
  })

  useEffect(() => {
    const paper = paperRef.current
    if (!paper) return
    /*
     * 用户在滚 vs 自己在滚。两条证据并用：
     * - wheel / touchmove 是**确凿的**用户手势，不受时间窗竞争影响；
     * - scroll 事件覆盖拖滚动条与键盘翻页，但自己滚也会触发，
     *   靠 SELF_SCROLL_GRACE_MS 排除。
     * 只用其中一条都会漏：只听 wheel 漏掉拖滚动条，只听 scroll 会有竞态。
     */
    const noteUser = () => {
      userScrollAtRef.current = Date.now()
    }
    const onScroll = () => {
      if (Date.now() - selfScrollAtRef.current < SELF_SCROLL_GRACE_MS) return
      noteUser()
    }
    paper.addEventListener('wheel', noteUser, { passive: true })
    paper.addEventListener('touchmove', noteUser, { passive: true })
    paper.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      paper.removeEventListener('wheel', noteUser)
      paper.removeEventListener('touchmove', noteUser)
      paper.removeEventListener('scroll', onScroll)
    }
  }, [paperRef, ready])

  useEffect(() => {
    // 只挑出播放头真的变了的那些通知：store 里任何字段的写入都会进这个回调
    return useProject.subscribe((state, prev) => {
      if (state.playheadMs !== prev.playheadMs) applyRef.current(false)
    })
  }, [])
}

/**
 * 把当前行滚进视口——**只在它确实不在视口里时**。
 *
 * 用 `scrollTop` 而不是 `el.scrollIntoView()`：后者会连带滚动所有可滚祖先，
 * 在这个"外层不滚、内部分区各自滚"的舞台里可能把整块面板顶掉。
 *
 * 上下各留一行余量再判断：正好卡在边缘的行虽然"可见"，但读起来仍要低头找，
 * 而它下一秒就会滚出去。
 */
function scrollLineIntoView(
  paper: HTMLElement,
  el: HTMLElement,
  selfScrollAtRef: { current: number },
): void {
  const pr = paper.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  const pad = Math.min(er.height, pr.height / 4)
  if (er.top >= pr.top + pad && er.bottom <= pr.bottom - pad) return
  const next = paper.scrollTop + (er.top - pr.top) - (pr.height - er.height) / 2
  selfScrollAtRef.current = Date.now()
  paper.scrollTop = Math.max(0, next)
}

/**
 * 这个词自己的声部覆盖（与所在行不同才算）。
 * 一个 ruby 单元可能横跨多个 token（「明日」两个字一个词），取首字的覆盖即可 ——
 * 一个词内部再分声部在演唱上没有意义。
 */
function tokenVoiceOf(line: Line, tokenIndex: number): string {
  return line.tokens[tokenIndex]?.voice_part || line.voice_part || 'main'
}

/**
 * 划词时被划到的那些词，事件名。
 *
 * 标记由本模块做（它拥有正文的 DOM），范围由 `EditVoice` 读 `[data-picked]` 得出。
 * 两边各监听一次 `selectionchange` 的话，谁先跑取决于 effect 的注册顺序——
 * 那种依赖在插入一个组件时就会悄悄反过来。改成"标记完再广播"，顺序就定死了。
 */
export const PICKED_WORDS_EVENT = 'kvm:picked-words'

/**
 * 划词：按住拖过几个词，把它们标进 DOM（`data-picked`），供 `EditVoice` 指派声部。
 *
 * **不用浏览器的文本选区**，两条独立的理由：
 *
 * 一、它在这里根本不成立。每个词是 `display: inline-block`（要挂注音、要定位
 * 划线），而 Chromium 跨 inline-block 拖拽时选区落不出来——实测拖过五个词，
 * `getSelection().toString()` 是空串、只框住一个元素。
 *
 * 二、就算能用也不该用。这里选的是"哪几个词"，不是一段文本；系统那条蓝底会
 * 一路糊过注音、标点与词间空隙，读起来像在复制文字，而划完要做的事是
 * "把这一段指派给某个声部"。
 *
 * 所以自己按指针位置算：从按下的那个词到当前指针下的那个词，中间按 DOM 顺序
 * 全部标上——跨行也就自然支持了。单击（没有拖动）只清标记，把选中那件事
 * 让给 `pick`。
 */
/** 一块高亮矩形，坐标相对正文的**内容**（含滚动量），所以滚动时不用重算 */
interface PickBox {
  x: number
  y: number
  w: number
  h: number
}

function usePickedWords(paperRef: RefObject<HTMLDivElement>): PickBox[] {
  const [boxes, setBoxes] = useState<PickBox[]>([])

  useEffect(() => {
    /*
     * 监听挂在 document 上，**不挂在正文容器上**。
     *
     * 挂容器要在 effect 跑的那一刻就拿得到 `paperRef.current`，而正文在工程还没
     * 加载完时会提前 return（那时根本没渲染出容器）——ref 对象本身不变，effect
     * 也就不会重跑，于是监听永远没注册上，进编辑页后划词整个是死的。
     * 挂 document 则与挂载时机无关，每次事件再去问一次当前的容器。
     */
    let anchor: HTMLElement | null = null

    const root = (): HTMLElement | null => paperRef.current
    /**
     * 指针位置对应哪个字。
     *
     * **不要求指针正好压在字身上**：一行里除了字还有注音上方的空档、字下方的
     * 留白、行尾的空白，划到那些地方要是就断了，拖动必须贴着一条几十像素高的
     * 带子走——而用户的意思很明确，就是"从这个字划到那个字"。
     * 所以先按点命中，命中不到就在**这一行**里取横向最近的那个字。
     */
    const unitAt = (x: number, y: number): HTMLElement | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      const paper = root()
      if (!el || !paper?.contains(el)) return null
      const direct = el.closest<HTMLElement>('.kvm-ruby__ch')
      if (direct) return direct
      const lineEl = el.closest<HTMLElement>('.kvm-ruby__line')
      if (!lineEl) return null
      let best: HTMLElement | null = null
      let bestDist = Infinity
      for (const ch of lineEl.querySelectorAll<HTMLElement>('.kvm-ruby__ch')) {
        const r = ch.getBoundingClientRect()
        const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
        if (d < bestDist) {
          bestDist = d
          best = ch
        }
      }
      return best
    }
    const units = (): HTMLElement[] => [
      ...(root()?.querySelectorAll<HTMLElement>('.kvm-ruby__ch') ?? []),
    ]
    const clear = (notify: boolean) => {
      let had = false
      for (const el of units()) {
        if (el.hasAttribute('data-picked')) {
          el.removeAttribute('data-picked')
          had = true
        }
      }
      if (had) setBoxes([])
      if (had && notify) document.dispatchEvent(new CustomEvent(PICKED_WORDS_EVENT))
    }

    /**
     * 划到的字合成**整块**高亮，一个视觉行一块。
     *
     * 逐字各画一块是走不通的：那些块半透明，紧挨着就会在接缝处叠出深色竖条，
     * 看着正好像一道道分隔线；而留空隙又变成一串小方块。合成整块之后，
     * 一行划过去就是一条连续的高亮带——本来要表达的也正是"这一段"。
     *
     * 高度取这一带里所有字的联合上下沿（含注音），所以同一带里高低不齐的字
     * 也共用一个框顶与框底。
     */
    const measure = (picked: HTMLElement[]) => {
      const paper = root()
      if (!paper || !picked.length) {
        setBoxes([])
        return
      }
      const base = paper.getBoundingClientRect()
      /*
       * 按**基线**聚类，不按顶边。
       *
       * 带注音的字比不带的高，顶边差着一截——拿顶边当分组键，同一行会被拆成
       * 好几块，相邻块的竖边挨在一起就成了一道道竖线（正是要消掉的东西）。
       * 而同一视觉行的字底边永远齐平，差得远的那才是真的换了行。
       */
      /*
       * 先按**行**分组，再在行内按基线聚类。
       *
       * 只按基线聚类是不够的：同一行里带注音的字与不带的、以及词间那些几像素
       * 宽的空格，基线能差出十几个像素（实测 17px）。差得超过容差就裂成两块，
       * 于是「ゆらゆら｜ゆらゆら」中间冒出一道竖线，有时还是一小块 6px 宽的
       * 独立方框。容差因此跟着字高走（0.6 倍），行内怎么抖都并得回来，
       * 而真正的换行差着一整个行高，并不进来。
       */
      const byLine = new Map<Element, HTMLElement[]>()
      for (const ch of picked) {
        const lineEl = ch.closest('.kvm-ruby__line')
        if (!lineEl) continue
        const cur = byLine.get(lineEl)
        if (cur) cur.push(ch)
        else byLine.set(lineEl, [ch])
      }
      const rows: { l: number; r: number; t: number; b: number }[] = []
      for (const chs of byLine.values()) {
        const items = chs
          .map((ch) => ({
            r: ch.getBoundingClientRect(),
            // 注音挂在词上，框要连注音一起罩住，所以纵向取所属词的范围
            own: ch.closest<HTMLElement>('.kvm-ruby__unit')?.getBoundingClientRect() ?? null,
          }))
          .sort((a, b) => a.r.bottom - b.r.bottom || a.r.left - b.r.left)
        /*
         * 容差按**行内最高的那个字**算，不按第一个——第一个可能是词间那种
         * 几像素高的空格，拿它当尺子会算出一个比真实抖动还小的容差，
         * 于是同一行照样裂成两块（实测差 17px，而按空格算出来只有 12px）。
         * 一行内的抖动来自"有没有注音"，最多就是一个字高的量级；
         * 真正的换行差着一整个行高（约 1.9 倍字高），半个字高卡在两者中间。
         */
        const maxH = items.reduce((m, it) => Math.max(m, it.r.height), 0)
        const eps = Math.max(24, maxH * 0.5)
        let last: { l: number; r: number; t: number; b: number } | null = null
        for (const it of items) {
          const top = Math.min(it.own?.top ?? it.r.top, it.r.top)
          if (last && Math.abs(it.r.bottom - last.b) <= eps) {
            last.l = Math.min(last.l, it.r.left)
            last.r = Math.max(last.r, it.r.right)
            last.t = Math.min(last.t, top)
            last.b = Math.max(last.b, it.r.bottom)
          } else {
            last = { l: it.r.left, r: it.r.right, t: top, b: it.r.bottom }
            rows.push(last)
          }
        }
      }
      /*
       * 左右各外扩一点，别让框贴着字的墨迹收边——贴着看像把字裁掉了。
       * 现在框是整块画的，外扩不会再像逐字那样在接缝处叠出竖线。
       */
      const PAD_X = 3
      /*
       * 上下留白不对称：上边挨着的是注音那行小字，贴太近会读成"把假名圈了一半"；
       * 下边只是字的底，给一点就够。两边都按 7px 给的话，跨行划选时上下两块
       * 会碰在一起（行距本来就不宽）。
       */
      const PAD_TOP = 6
      const PAD_BOTTOM = 2
      setBoxes(
        rows.map((v) => ({
          x: v.l - base.left + paper.scrollLeft - PAD_X,
          y: v.t - base.top + paper.scrollTop - PAD_TOP,
          w: v.r - v.l + PAD_X * 2,
          h: v.b - v.t + PAD_TOP + PAD_BOTTOM,
        })),
      )
    }

    const mark = (from: HTMLElement, to: HTMLElement) => {
      const list = units()
      const i = list.indexOf(from)
      const j = list.indexOf(to)
      if (i < 0 || j < 0) return
      const [s, e] = i <= j ? [i, j] : [j, i]
      // 只划到一个字不算划选——那是单击的地盘（选中 + 定位播放头）
      const on = e > s
      const picked: HTMLElement[] = []
      list.forEach((el, k) => {
        if (!on || k < s || k > e) {
          el.removeAttribute('data-picked')
          return
        }
        el.setAttribute('data-picked', '')
        picked.push(el)
      })
      measure(picked)
      document.dispatchEvent(new CustomEvent(PICKED_WORDS_EVENT))
    }

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const paper = root()
      if (!paper) return
      const u = unitAt(e.clientX, e.clientY)
      // 按在正文之外（走带、时间轴、别的面板）与划词无关，别去动已有的划选
      if (!u && !paper.contains(e.target as Node)) return
      // 按在正文里的非词处（行号、空白、按钮）则把上一次的划选收掉
      if (!u) {
        clear(true)
        return
      }
      anchor = u
      clear(true)
    }
    const onMove = (e: PointerEvent) => {
      if (!anchor || !(e.buttons & 1)) return
      const u = unitAt(e.clientX, e.clientY)
      if (!u) return
      mark(anchor, u)
    }
    const onUp = () => {
      anchor = null
    }

    document.addEventListener('pointerdown', onDown)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [paperRef])

  return boxes
}

/** 一段连续的、同一个声部的词 */
interface VoiceSeg {
  part: string
  units: RubyUnit[]
}

/**
 * 把一行按**有效声部**切成连续段。
 *
 * 这是"一句里男女交替"在界面上能被看见的前提。此前字级覆盖是逐词渲染的：
 * 每个词自己一条 2px 短线、自己一个声部名，于是「君の/声が/聞こえる」三个词
 * 会得到三条断开的线和三个重复的名字——而它们其实是同一个人连着唱的一段。
 * 切成段之后，一段只画一条线、只标一次名。
 */
function segmentByVoice(line: Line, units: RubyUnit[]): VoiceSeg[] {
  const out: VoiceSeg[] = []
  for (const u of units) {
    const part = tokenVoiceOf(line, u.tokenIndex)
    const last = out[out.length - 1]
    if (last && last.part === part) last.units.push(u)
    else out.push({ part, units: [u] })
  }
  return out
}

/**
 * 这一行实际用到的全部声部（行级 + 字级覆盖），按出现顺序去重。
 * 只有一个且是 main 时返回空 —— main 是默认值，每行挂一个「main」只是噪音。
 */
function linePartsOf(line: Line): string[] {
  const out: string[] = []
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v)
  }
  push(line.voice_part)
  for (const tk of line.tokens) if (tk.voice_part) push(tk.voice_part)
  if (out.length === 1 && out[0] === 'main') return []
  return out
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

  /** 点整行 = 选中它的首字 + 播放头跳过去，与点字（`pick`）是同一套语义 */
  const pickLine = (lineId: string) => {
    const st = useProject.getState()
    st.select({ kind: 'token', lineId, tokenIndex: 0 })
    const tk = st.project?.lines.find((l) => l.id === lineId)?.tokens[0]
    if (tk) st.setPlayhead(Math.max(0, Math.round(tk.start_ms + (st.project?.global_offset_ms ?? 0))))
  }

  /*
   * 正在打字时不许抢视口：就地改写行文本、或者在某个词头上开着注音输入框时，
   * 视口一动光标就跑了（注音输入框是绝对定位在词上方的，跟着行一起滚）。
   * 高亮本身照常跟着走，被暂停的只有滚动。
   */
  usePlayheadLine(paperRef, editingLineId !== null || editingKey !== null, !!project)
  const pickBoxes = usePickedWords(paperRef)

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
        {/* 划词高亮：一块一块画在文字底下，坐标由 usePickedWords 量出来 */}
        {pickBoxes.map((b, i) => (
          <div
            key={i}
            className="kvm-ruby__pickbox"
            style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
          />
        ))}
        {project.lines.length === 0 && <p className="kvm-ruby__muted">{t('ruby.empty.lines')}</p>}
        {project.lines.length > 0 && lines.length === 0 && (
          <p className="kvm-ruby__muted">{t('ruby.empty.allMetadata')}</p>
        )}

        {lines.map((line) => {
          const units = lineUnits.get(line.id) ?? []
          const segs = segmentByVoice(line, units)
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
              data-voice={line.voice_part || undefined}
              /* 这一行里不止一个声部：段线与段首的声部名只在这种行上画 */
              data-multi={segs.length > 1 || undefined}
              style={paletteVars(project.palettes[line.voice_part] ?? project.palettes['main'])}
              /*
                **整行都可点**，不只是字。行里除了字还有行号、右侧留白、声部标签，
                点在那些地方本来什么也不会发生 —— 而用户想做的事很明确：选中这一句。
                一句几十个字里只有字身上有热区，等于逼人去瞄准。

                落到**首字**而不是整行：选中项是 token 级的，落到行上会让底栏检查器
                半空着。点具体某个字时由 `pick` 接手（它更精确），所以这里要把
                来自字、按钮、输入框的点击让出去，否则会把刚选好的字又拽回首字。
              */
              onClick={(e) => {
                const el = e.target as HTMLElement
                if (el.closest('.kvm-ruby__unit, button, input')) return
                if (!line.tokens.length) return
                pickLine(line.id)
              }}
            >
              <span className="kvm-ruby__no num">{lineNo.get(line.id)}</span>
              <span className="kvm-ruby__text">
                {units.length === 0 && <span className="kvm-ruby__muted">{t('ruby.empty.line')}</span>}
                {segs.map((seg, si) => (
                  /*
                    一段 = 连着的、同一个声部的那些词。段是这里的渲染单位而不是词，
                    于是「谁唱的」这件事在一句里是**连续**的：一条线、一个名字，
                    而不是每个词各画一遍。

                    段上覆盖这个声部自己的配色变量（`--ruby-fill` / `--ruby-outline`），
                    所以一句里两个声部**颜色就是分开的**——此前整行只取行级配色，
                    字级覆盖的那几个词跟旁边一模一样，只能靠那条短线认。
                  */
                  <span
                    key={`${seg.part}-${si}`}
                    className="kvm-ruby__seg"
                    data-part={seg.part}
                    style={paletteVars(project.palettes[seg.part] ?? project.palettes['main'])}
                  >
                    {seg.units.map((u) => {
                  const k = unitKey(u)
                  const rt = u.span?.text ?? ''
                  return (
                    <span
                      key={k}
                      className="kvm-ruby__unit"
                      data-unit={k}
                      data-src={u.missing ? 'missing' : u.src}
                      data-selected={k === selectedKey || undefined}
                      /*
                        本词覆盖的 token 区间，左闭右开。摆在 DOM 上是为了让
                        **划词指派声部**（`EditVoice`）能只靠选区把范围算出来——
                        否则它得自己再复刻一遍 unit → token 的换算，
                        而那份换算是 `RubyModel` 的职责，不该有第二份。
                      */
                      data-tk={u.tokenIndex}
                      data-tke={u.tokenEnd}
                      tabIndex={0}
                      /*
                        **单击只选中，双击才改注音。**
                        单击是这一屏最高频的动作（选中 = 同时定位逐字轴、播放头、
                        检查器），而它此前顺带弹出一个覆盖在字上的输入框：想听一下
                        这个词唱的是什么，得先把输入框关掉。改注音是低频动作，
                        让它多一次点击换来单击不再有副作用。
                        键盘上的 Enter 仍直接进编辑——那一步本来就要按键才发生。
                      */
                      onClick={() => pick(u, false)}
                      onDoubleClick={() => pick(u, true)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') pick(u, true)
                      }}
                    >
                      <ruby>
                        {/*
                          词的文本按 **token** 拆成一个个可命中的小块。
                          注音仍挂在整个词上（`rt` 对应整段 ruby 内容），但划词
                          要精确到字：声部本来就是 token 级的属性（§8.5「Token 级
                          可覆盖」），而「ゆらゆらゆらゆら」这种纯假名串整段是一个
                          注音单位——卡在词上就意味着这八个字只能一起指派。
                        */}
                        {line.tokens.slice(u.tokenIndex, u.tokenEnd).map((tk, i) => (
                          <span
                            key={u.tokenIndex + i}
                            className="kvm-ruby__ch"
                            data-tk={u.tokenIndex + i}
                          >
                            {tk.text}
                          </span>
                        ))}
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
                ))}
              </span>
              {line.is_metadata && <span className="kvm-ruby__tag">{t('ruby.metadata')}</span>}
              {/*
                声部标签。**不能只靠颜色说这件事**：新指派的声部还没有自己的配色时，
                后端与前端都按 main 回退（`effectivePalette` 的 explicit=false），
                于是"改了声部却看起来毫无变化"，用户会以为指派没生效。
                标签是那一刻唯一的证据；等去样式舞台配好四个颜色，颜色才接手。
                main 不标 —— 它是默认值，每行挂一个「main」只是噪音。

                **一句多声部时段首也各标一个**（见 `kvm-ruby__seg`），两处并不重复：
                段首那个说的是"这几个字是谁唱"，跟着字走、字一多就要横向找；
                行尾这排说的是"这一句用到了哪些人"，位置固定，扫一列就能看出
                整段歌是怎么分的。
              */}
              {linePartsOf(line).map((vp) => (
                <span key={vp} className="kvm-ruby__voice" data-role="voice-tag" data-part={vp}>
                  {vp}
                </span>
              ))}
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
 *
 * **本块是模板字符串，注释里不能出现反引号**（按习惯给 `data-xxx` 加一对反引号
 * 就会把字符串在那里截断，报出来的却是几十行之外莫名其妙的语法错误）。
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
  /* 划词高亮块按内容坐标绝对定位在这里面（见 .kvm-ruby__pickbox） */
  position: relative;
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
  /* 整行可点（见 JSX 里的 onClick），光标要跟上，否则没人知道行首行尾也能点 */
  cursor: pointer;
  display: flex;
  align-items: flex-end;
  gap: var(--sp-3);
  padding: var(--sp-1) var(--sp-2);
  /*
   * 行间留一道缝：划词高亮要连注音一起罩住，框比字高出一截，
   * 行距不够时跨行划选的上下两块会贴在一起，读不出是两行。
   */
  margin-bottom: var(--sp-1);
  border-radius: var(--r-md);
}
.kvm-ruby__line[data-active] { background: var(--accent-weak); }
.kvm-ruby__line[data-editing] { background: var(--bg-surface); align-items: center; }

/*
 * 播放高亮。
 *
 * 曾经这里是**两种**视觉：data-active（选中，强调色底）与 data-playing
 * （正在唱，左侧红竖条 + 行号变红）。现在合成一种 —— 点哪一句播放头就跳到哪一句、
 * 播放推进时选中也跟着走（见 Timeline 的播放头订阅），二者永远指同一行，
 * 再画两种颜色只会让人以为它们可能不一样。
 *
 * data-playing 保留**属性**：它是命令式更新的落点（见上方 usePlayheadLine），
 * 也是验收脚本判断"时间轴与正文说的是不是同一行"的抓手。左侧那条竖条也留着，
 * 因为它和波形上那条播放头是同一个 --danger —— 同一个"此刻"在三处用同一个颜色说，
 * 而它与强调色底不冲突：一个是底、一个是边。
 */
.kvm-ruby__line[data-playing] {
  box-shadow: inset 3px 0 0 var(--danger);
  background: var(--accent-weak);
}

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
 * 声部标签。比制作名单标签醒目一档（描边 + 手工语义色）：它标的是**用户刚做的决定**，
 * 而不是一条系统判定；新声部还没配色时，它是"指派确实生效了"的唯一可见证据。
 */
.kvm-ruby__voice {
  flex: 0 0 auto;
  align-self: center;
  font-size: var(--fs-xs);
  padding: 0 var(--sp-2);
  border-radius: var(--r-pill);
  border: 1px solid var(--src-manual);
  color: var(--src-manual);
}
/*
 * 被单独指派了声部的词：**上方**压一条短线 + 一个小标签。
 *
 * 走上边而不是下边：下划线已经被"读音来源"占了（§7.4 要求来源可见），
 * 两条线叠在同一侧谁也读不出来。标签用 data-part 直接吐出声部名 ——
 * 一句里两个声部时，用户要知道的是"这几个字是谁唱"，不是"这里有点不一样"。
 */
/*
 * 一句里的一段（连着的、同一个声部的那些词）。
 *
 * 段而不是词，是因为"谁唱的"在一句里本来就是连续的：三个词连着由同一个人唱，
 * 就该是一条线、一个名字。逐词画的话，「君の/声が/聞こえる」会得到三条断线
 * 和三个重复的名字，读起来像三次换人。
 *
 * 线走上边而不是下边：下划线已经被"读音来源"占了（§7.4 要求来源可见），
 * 两条线叠在同一侧谁也读不出来。
 *
 * 颜色取这一段自己的声部色（--ruby-fill 由段上的内联变量给），
 * 于是同一句里的两个声部**本身就是两个颜色**，不必靠线去分辨。
 */
.kvm-ruby__seg {
  position: relative;
  color: var(--ruby-fill);
}
/*
 * 段线与段名画在**注音上方一段距离处**，中间空出 0.42em。
 *
 * 贴着画会和注音糊成一片：注音本来就在字的正上方，声部线再压在它头上，
 * 两行小字挤在一起，谁也读不出是什么。这条线说的是"这几个字归谁"，
 * 与"这个字怎么读"是两件事，视觉上就该分开。
 */
.kvm-ruby__line[data-multi] .kvm-ruby__seg {
  box-shadow: inset 0 2px 0 var(--ruby-fill);
  /* 换行时每一截都要有线与圆角，否则一段跨两行就只有上面那截画得出来 */
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  padding-top: 0.42em;
}
.kvm-ruby__line[data-multi] .kvm-ruby__seg::before {
  content: attr(data-part);
  position: absolute;
  top: -1.05em;
  left: 0;
  font-size: var(--fs-xs);
  line-height: 1;
  color: var(--ruby-fill);
  pointer-events: none;
  white-space: nowrap;
}
/* 段名浮在行的上沿之外，给它留出落脚的地方，别压到上一行的字 */
.kvm-ruby__line[data-multi] {
  margin-top: 0.7em;
}

/*
 * 划词指派声部时的选中态。
 *
 * 词上关掉原生选区：拖动完全由 usePickedWords 自己算（那里有为什么不用文本选区
 * 的完整理由），留着它只会在自绘高亮之下再糊一层系统蓝。
 */
.kvm-ruby__unit {
  user-select: none;
  -webkit-user-select: none;
}
/*
 * 划词高亮：**一个视觉行一块**，由 JS 量出联合矩形后绝对定位在文字底下。
 *
 * 逐字各画一块走不通：块是半透明的，紧挨着会在接缝处叠出深色竖条，看着正好
 * 像一道道分隔线；留空隙又变成一串小方块。而这里要表达的是"这一段"，
 * 本来就该是一条连续的带子——高度也因此由整块统一，不随某个字有没有注音而起伏。
 */
.kvm-ruby__pickbox {
  position: absolute;
  z-index: 0;
  background: var(--accent-weak);
  border: 1px solid var(--accent);
  border-radius: var(--r-sm);
  pointer-events: none;
}
/* 文字压在高亮之上，别被那层底色糊住 */
.kvm-ruby__line {
  position: relative;
  z-index: 1;
}

/*
 * 来源标记：先做下划线（docs/ui-redesign.md §八未决项的处置）。
 * 粗细用 em，跟着成片字号缩放，换字号不用回来改这里。
 */
.kvm-ruby__ch {
  position: relative;
  display: inline-block;
}
/*
 * 注音比基字宽时，ruby 默认把基字往右挪、让注音居中——于是每行的第一个字
 * 各自缩进不同的量（实测 0 / 5.1 / 11.3px），整屏歌词的左边缘是毛的。
 * 靠左对齐后所有行的首字落在同一竖线上；宽注音改为向右伸，
 * 而右边本来就还有字，不空。
 */
.kvm-ruby__unit ruby {
  ruby-align: start;
}
.kvm-ruby__unit {
  position: relative;
  display: inline-block;
  cursor: pointer;
}
/*
 * 来源那条线画在伪元素上、抬到**字底附近**。
 *
 * 用 border-bottom 时它落在 inline-block 的盒底，而盒底比字底低着大半个行距，
 * 于是线离字远得像是画给下一行的。抬起来之后一眼就能对上是哪个字的来源。
 */
.kvm-ruby__unit::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0.28em;
  height: 0.09em;
  background: transparent;
  pointer-events: none;
}
.kvm-ruby__unit[data-src=provider]::after { background: var(--src-provider); }
.kvm-ruby__unit[data-src=dict]::after { background: var(--src-aligned); }
.kvm-ruby__unit[data-src=guess]::after { background: var(--src-interp); }
.kvm-ruby__unit[data-src=manual]::after { background: var(--src-manual); }
/* 有汉字却没读音：虚线 + 危险色，它比"猜错了"更需要先被看到 */
.kvm-ruby__unit[data-src=missing]::after {
  background: none;
  border-bottom: 0.09em dotted var(--danger);
}
.kvm-ruby__unit:hover { background: var(--accent-weak); }
.kvm-ruby__unit[data-selected] {
  background: var(--accent-weak);
  outline: var(--hairline-strong);
}
/*
 * 正在划词时，**选中词与 hover 的装饰全部让位**。
 *
 * 三样东西画在同一块地方：划选底、选中词的底色 + 灰色外框、鼠标底下的 hover 底。
 * 叠起来的结果是划选带里凭空出现一道竖线（选中词外框的边）和一段更深的色块
 * （hover），看着像划选被切成了几块。此刻用户关心的只有"划到哪儿"，
 * 不是上一次点中过谁、鼠标正压着谁。
 */
.kvm-ruby__paper:has(.kvm-ruby__pickbox) .kvm-ruby__unit[data-selected] {
  background: transparent;
  outline: none;
}
.kvm-ruby__paper:has(.kvm-ruby__pickbox) .kvm-ruby__unit:hover {
  background: transparent;
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
