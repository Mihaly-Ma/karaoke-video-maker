/**
 * 舞台底栏的检查器：**同一个选中项的时间与读音并排**。
 *
 * 这是"对轴与注音合并成一步"在界面上的落点（docs/ui-redesign.md §四）。
 * 对轴管「这个词什么时候唱」，注音管「这个词怎么读」，两者修正的是同一个词；
 * 分成两个舞台时，同一个词要在两处各选一次，而且注音那边连播放都没有——
 * 可读音偏偏只能靠耳朵验证（「運命」在本曲唱 さだめ 还是 うんめい）。
 *
 * 两半的粒度不同，界面上必须说清楚，不能混成一个数：
 *
 * | 半边 | 对象 | 来源 |
 * |---|---|---|
 * | 时间 | 选中的**字**（token） | store 里的 `selection`，逐字轴上高亮的就是它 |
 * | 读音 | 覆盖那个字的**词**（ruby 区间） | `RubyModel.unitOfToken` 换算 |
 *
 * 「明日」两个字共用「あした」时是一个词、两个 token——时间只能逐字给，
 * 读音只能整词给，硬凑成一个粒度必然要在某一边说谎。
 *
 * 读音那一半整块复用 `RubyInspector`（校验、拍数、候选、拆分判断都在它那儿），
 * 本组件只补上时间那一半，并通过它的 `leading` 插槽塞进去。
 */

import { EditOutlined, LockOutlined, PlusOutlined, UnlockOutlined } from '@ant-design/icons'
import { useCallback, useMemo, useRef, useState } from 'react'

import type { Project } from '../api/types'
import { t } from '../i18n'
import { formatMs } from '../lib/timeScale'
import { useProject } from '../state/projectStore'
import type { RubyEditing } from './RubyEditor'
import { RubyInspector } from './RubyInspector'
import type { RubyUnit } from './RubyModel'
import { SOURCE_META } from './Timeline'

/** 与时间轴方向键一致的两档：10ms 是听得出的下限，100ms 用来对付整体偏一截 */
const NUDGES = [-100, -10, 10, 100]

export interface EditInspectorProps {
  editing: RubyEditing
}

export default function EditInspector({ editing }: EditInspectorProps) {
  const { selectedUnit, lineUnits, busy, phoneticOf, applyReading, split, remove, toggleLock, setPhonetic } =
    editing

  return (
    <div className="edit-inspect" data-role="inspector">
      <RubyInspector
        unit={selectedUnit}
        units={lineUnits}
        busy={busy}
        layout="bar"
        leading={<TimingBlock unit={selectedUnit} />}
        phoneticOverride={selectedUnit ? phoneticOf(selectedUnit) : ''}
        onApplyReading={applyReading}
        onSplit={split}
        onDelete={remove}
        onToggleLock={toggleLock}
        onPhonetic={setPhonetic}
      />
      <VoiceBlock />
    </div>
  )
}

// ---------------------------------------------------------------- 声部

/**
 * 声部名从**歌词数据**汇总，不允许凭空新建一个没有任何行引用的声部。
 *
 * 这份逻辑与 `StylePanel.collectParts` 必须一致 —— 样式舞台的配色列表就是按它列的，
 * 这里指派出一个新声部，那边才会冒出对应的一格。两处**故意各写一份**而不是共用：
 * 样式舞台归别人所有，为了共用一个十行的纯函数去改它不划算；代价是改一处要改两处，
 * 所以两边都留了这条注释。
 */
function collectParts(project: Project | null): string[] {
  const set = new Set<string>(['main'])
  for (const line of project?.lines ?? []) {
    if (line.voice_part) set.add(line.voice_part)
    for (const tk of line.tokens) if (tk.voice_part) set.add(tk.voice_part)
  }
  for (const name of Object.keys(project?.palettes ?? {})) set.add(name)
  return [...set].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
}

/** 作用域。三档覆盖用户点名的「当前句 / 此句之后 / 选中多句」 */
type VoiceScope = 'line' | 'after' | 'tokens'

export function VoiceBlock() {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const setVoicePart = useProject((s) => s.setVoicePart)

  const updatePalettes = useProject((s) => s.updatePalettes)
  const [scope, setScope] = useState<VoiceScope>('line')
  /** 改名草稿。`null` = 没在改名（当前声部显示成一个可点的小标签） */
  const [rename, setRename] = useState<string | null>(null)
  /** 「本句起 N 句」的 N。默认 4：对唱多是几句一换，一句一句点才是要消灭的那件事 */
  const [span, setSpan] = useState(4)
  /**
   * 「本字起 N 字」的 N。默认 1 —— 字级覆盖的典型用法是**精确点掉几个字**
   * （一行内男女交替），默认吃到句末会让人一不小心把整个后半句改掉。
   */
  const [tokenSpan, setTokenSpan] = useState(1)
  /** 新声部草稿。`null` = 收起成一个 ＋，低频操作不常驻空输入框 */
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ n: number; part: string } | null>(null)

  const parts = useMemo(() => collectParts(project), [project])

  const lineId = selection.kind === 'none' ? null : selection.lineId
  const line = lineId ? (project?.lines.find((l) => l.id === lineId) ?? null) : null
  const tokenIndex = selection.kind === 'token' ? selection.tokenIndex : -1

  /**
   * 这一下会改到哪些行。**先算出来摆在按钮旁边**，不是点完才知道 ——
   * 声部改错会连带改掉一片颜色，视觉上很显眼，退回去却要一行行来。
   *
   * 制作名单行跳过：它们不唱，指派声部没有意义。
   */
  const targets = useMemo(() => {
    if (!project || !line) return []
    if (scope === 'tokens') return [line]
    const singable = project.lines.filter((l) => !l.is_metadata && l.tokens.length)
    const at = singable.findIndex((l) => l.id === line.id)
    if (at < 0) return []
    if (scope === 'line') return [singable[at]]
    return singable.slice(at, at + Math.max(1, span))
  }, [project, line, scope, span])

  /** 「到曲末」= 把 N 一次拉满，用户仍能看到具体是多少行再决定 */
  const restCount = useMemo(() => {
    if (!project || !line) return 0
    const singable = project.lines.filter((l) => !l.is_metadata && l.tokens.length)
    const at = singable.findIndex((l) => l.id === line.id)
    return at < 0 ? 0 : singable.length - at
  }, [project, line])

  const apply = useCallback(
    async (part: string) => {
      if (!line || busy) return
      setBusy(true)
      setDone(null)
      try {
        if (scope === 'tokens') {
          if (tokenIndex < 0) return
          // 「本字起至句末」：对唱最常见的形态就是一句从某个字开始换人，
          // 逐字点等于把 §8.5「Token 级可覆盖」做成了没人愿意用的功能
          const end = Math.min(line.tokens.length, tokenIndex + Math.max(1, tokenSpan))
          await setVoicePart(line.id, part, [tokenIndex, end])
          setDone({ n: end - tokenIndex, part })
          return
        }
        // 后端一次只收一行（POST /api/editor/voice-part），所以批量只能逐行发。
        // 串行而不是并发：每个编辑接口都返回整份工程，并发的话后到的旧响应
        // 会把先到的新改动覆盖掉。
        for (const l of targets) await setVoicePart(l.id, part, undefined)
        setDone({ n: targets.length, part })
      } finally {
        setBusy(false)
      }
    },
    [line, busy, scope, tokenIndex, tokenSpan, targets, setVoicePart],
  )

  /**
   * 改名：把全曲所有引用这个名字的地方一起换掉，**包括默认的 `main`**。
   *
   * 声部名是用户自己起的标签（「男」「女」「合」比 `duet_a` 好读得多），
   * 而它同时是配色的键，所以改名必须三处一起动：行级、token 级覆盖、配色键。
   * 漏掉配色那一处的话，改完名字颜色会当场退回 main 的回退色。
   *
   * 配色用 `replace=true` 整体写回：合并式更新删不掉旧键，留下来的旧名会被
   * `collectParts` 当成一个还存在的声部继续列出来，界面上多一个点不出东西的幽灵。
   */
  const doRename = async (to: string) => {
    // 本函数定义在 `if (!project || !line) return null` 之前（它要用到下面才算出来的
    // 状态），所以这里自己收窄一次，而不是依赖外层的守卫
    const ln = line
    const proj = project
    if (!ln || !proj) return
    const from = ln.voice_part || 'main'
    if (!to || to === from || busy) return
    setBusy(true)
    setDone(null)
    try {
      let n = 0
      for (const l of proj.lines) {
        if (l.voice_part === from) {
          await setVoicePart(l.id, to, undefined)
          n += 1
        }
        // token 级覆盖按**连续段**提交：后端收的是区间，逐个 token 发会白白
        // 多占同样多格撤销
        let s = -1
        for (let i = 0; i <= l.tokens.length; i++) {
          const hit = i < l.tokens.length && l.tokens[i].voice_part === from
          if (hit && s < 0) s = i
          if (!hit && s >= 0) {
            await setVoicePart(l.id, to, [s, i])
            n += 1
            s = -1
          }
        }
      }
      const pal = useProject.getState().project?.palettes ?? {}
      if (pal[from]) {
        const next = Object.fromEntries(
          Object.entries(pal).map(([k, v]) => [k === from ? to : k, v]),
        )
        await updatePalettes(next, true)
      }
      setDone({ n, part: to })
    } finally {
      setBusy(false)
    }
  }

  if (!project || !line) return null

  const restTokens = tokenIndex >= 0 ? line.tokens.length - tokenIndex : 0
  const count =
    scope === 'tokens' ? Math.min(restTokens, Math.max(1, tokenSpan)) : targets.length
  const disabled = busy || (scope === 'tokens' && tokenIndex < 0)

  const curPart = line.voice_part || 'main'

  return (
    <div className="edit-voice" data-role="voice-part">
      <span className="kvm-ruby__label">{t('align.voice')}</span>

      {/*
        当前声部。**点它就地改名**，而不是常驻一个改名输入框 ——
        改名是低频操作，为它长期占一条 148px 的空输入框既挤又难看。
        默认声部 main 一样能改：声部名是给人看的标签（「男」「女」「合」
        比 duet_a 好读得多），没有理由把默认那一个钉死。
      */}
      {rename === null ? (
        <button
          type="button"
          className="edit-voice__cur"
          data-role="voice-current"
          title={t('align.voiceRenameHint', { part: curPart })}
          disabled={busy}
          onClick={() => setRename(curPart)}
        >
          {curPart}
          <EditOutlined />
        </button>
      ) : (
        <input
          type="text"
          className="edit-voice__renaming"
          data-role="voice-rename"
          aria-label={t('align.voiceRename')}
          autoFocus
          value={rename}
          disabled={busy}
          onChange={(e) => setRename(e.target.value)}
          onBlur={() => setRename(null)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setRename(null)
            if (e.key !== 'Enter') return
            const name = rename.trim()
            setRename(null)
            if (name) void doRename(name)
          }}
        />
      )}

      {/* 作用域先选、再点声部：作用域是黏的，连着改几段时每段只要一次点击 */}
      <span className="edit-voice__seg" role="radiogroup" aria-label={t('align.voiceScope')}>
        {(['line', 'after', 'tokens'] as const).map((k) => (
          <label key={k} data-on={scope === k || undefined} data-scope={k}>
            <input
              type="radio"
              name="kvm-voice-scope"
              checked={scope === k}
              disabled={k === 'tokens' && tokenIndex < 0}
              onChange={() => setScope(k)}
            />
            {t(`align.voiceScope.${k}`)}
          </label>
        ))}
      </span>

      {/*
        数量输入。两档作用域**共用同一种形态**（数字框 + 一键拉满），
        差别只在单位是"句"还是"字" —— 一行内男女交替要精确到第几个字，
        所以字级也必须能给出任意区间，而不只是"到句末"。
      */}
      {scope !== 'line' && (
        <>
          <input
            type="number"
            min={1}
            max={scope === 'after' ? Math.max(1, restCount) : Math.max(1, restTokens)}
            className="num edit-voice__span"
            data-role="voice-span"
            aria-label={t(scope === 'after' ? 'align.voiceSpan' : 'align.voiceSpanTokens')}
            value={scope === 'after' ? span : tokenSpan}
            onChange={(e) => {
              const v = Math.max(1, Math.round(Number(e.target.value) || 1))
              if (scope === 'after') setSpan(v)
              else setTokenSpan(v)
            }}
          />
          <span className="edit-voice__unit">
            {t(scope === 'after' ? 'align.voiceUnitLines' : 'align.voiceUnitTokens')}
          </span>
          <button
            type="button"
            className="small"
            data-role="voice-fill"
            onClick={() => (scope === 'after' ? setSpan(restCount) : setTokenSpan(restTokens))}
          >
            {t(scope === 'after' ? 'align.voiceToEnd' : 'align.voiceToLineEnd')}
          </button>
        </>
      )}

      {/* 动手前就说清这一下改多少：改错声部很显眼，退回去却要一行行来 */}
      <span className="edit-voice__count num" data-role="voice-count">
        {t(scope === 'tokens' ? 'align.voiceAffectTokens' : 'align.voiceAffectLines', { n: count })}
      </span>

      {parts.map((p) => (
        <button
          key={p}
          type="button"
          className="small"
          data-role="voice-assign"
          data-part={p}
          disabled={disabled}
          onClick={() => void apply(p)}
        >
          {p}
        </button>
      ))}

      {/*
        新声部只能从这里产生（样式舞台按歌词数据汇总声部名，见 collectParts）。
        指派完它就会出现在样式舞台的配色列表里，可以去那儿给它配四个颜色。
        同样收成一个 ＋：新建也是低频操作，不值得常驻一条空输入框。
      */}
      {draft === null ? (
        <button
          type="button"
          className="iconbtn"
          data-role="voice-new"
          title={t('align.voiceNew')}
          aria-label={t('align.voiceNew')}
          disabled={disabled}
          onClick={() => setDraft('')}
        >
          <PlusOutlined />
        </button>
      ) : (
        <input
          type="text"
          className="edit-voice__new"
          data-role="voice-new-input"
          placeholder={t('align.voiceNewPlaceholder')}
          aria-label={t('align.voiceNew')}
          autoFocus
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setDraft(null)
            if (e.key !== 'Enter') return
            const name = draft.trim()
            setDraft(null)
            if (name) void apply(name)
          }}
        />
      )}

      {/* 清除字级覆盖：传空串让这些音节回到继承行声部（后端 SetVoicePartRequest 的语义） */}
      {scope === 'tokens' && (
        <button
          type="button"
          className="small"
          data-role="voice-clear"
          disabled={disabled}
          onClick={() => void apply('')}
        >
          {t('align.voiceClear')}
        </button>
      )}

      {done && (
        <span className="edit-voice__done" data-role="voice-done">
          {t('align.voiceDone', { n: done.n, part: done.part || 'main' })}
        </span>
      )}
    </div>
  )
}

/**
 * 时间那一半。读的是 store 里的 `selection`——逐字轴上高亮的、歌词正文里点中的，
 * 都是这同一个值，所以三处永远说的是同一个字。
 *
 * 选中的若是整行（进入舞台时的初始状态，或从行轨上选的），就落到**这个词的首字**：
 * 检查器右半边已经在显示这个词的读音了，左半边空着一句"点个字吧"只是自相矛盾。
 */
function TimingBlock({ unit }: { unit: RubyUnit | null }) {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const select = useProject((s) => s.select)
  const shift = useProject((s) => s.shift)
  const setLock = useProject((s) => s.setLock)

  /** 与时间轴同样的理由：每个编辑接口都返回整份工程，并发发出去会互相覆盖 */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = useCallback((fn: () => Promise<unknown>) => {
    const run = queueRef.current.then(fn)
    queueRef.current = run.catch(() => undefined)
  }, [])

  const lineId = selection.kind !== 'none' ? selection.lineId : (unit?.lineId ?? null)
  const line = lineId ? (project?.lines.find((l) => l.id === lineId) ?? null) : null
  const tokenIndex =
    selection.kind === 'token'
      ? selection.tokenIndex
      : unit && unit.lineId === lineId
        ? unit.tokenIndex
        : -1
  const token = tokenIndex >= 0 ? (line?.tokens[tokenIndex] ?? null) : null

  if (!token || !line) {
    return (
      <div className="edit-inspect__timing">
        <span className="kvm-ruby__label">{t('align.time')}</span>
        <span className="kvm-ruby__muted">{t('align.selectHint')}</span>
      </div>
    )
  }

  const meta = SOURCE_META[token.timing_source]
  /**
   * 平移与锁定都要求全局选中确实指向这个字：`shift('token')` 读的是 store 里的
   * selection，选中的若还是整行，它会拿不到 token_index。先补一次选中，
   * 顺带把逐字轴上的高亮也对齐过来。
   */
  const ensureSelected = () => {
    if (selection.kind !== 'token' || selection.tokenIndex !== tokenIndex) {
      select({ kind: 'token', lineId: line.id, tokenIndex })
    }
  }

  return (
    <div className="edit-inspect__timing">
      <span className="kvm-ruby__label">{t('align.time')}</span>
      <span className="edit-inspect__tok">{token.text}</span>
      <span className="num edit-inspect__num" data-role="token-start" title={t('align.start')}>
        {formatMs(token.start_ms, true)}
      </span>
      <span className="num edit-inspect__num" data-role="token-dur" title={t('align.dur')}>
        +{Math.round(token.dur_ms)}ms
      </span>
      <span
        className="kvm-ruby__chip"
        data-timing-source={token.timing_source}
        title={t(meta.hintKey)}
        style={{ color: meta.color, borderColor: meta.color }}
      >
        {t(meta.labelKey)}
      </span>

      {/*
        标签必须露出来。舞台左栏的「整体偏移」也是一模一样的四个 ±ms 按钮，
        两组挨在同一屏上、长得完全一样却一个动全曲一个动一个字 ——
        只把「平移」写进 aria-label 等于只对读屏软件说了，用眼睛的人看不到。
      */}
      <span className="kvm-ruby__label">{t('align.shift')}</span>
      <span className="edit-inspect__nudges" aria-label={t('align.shift')}>
        {NUDGES.map((ms) => (
          <button
            key={ms}
            type="button"
            className="small num"
            // 平移的是**选中的那个字**，与时间轴上按方向键完全同义；
            // 整词平移没有专门的接口，多 token 的词请在逐字轴上逐个拖
            onClick={() => {
              ensureSelected()
              enqueue(() => shift('token', ms))
            }}
          >
            {ms > 0 ? `+${ms}` : ms}
          </button>
        ))}
      </span>

      <button
        type="button"
        className="small"
        aria-pressed={token.locked_timing}
        data-on={token.locked_timing || undefined}
        onClick={() => {
          ensureSelected()
          enqueue(() =>
            setLock({
              target: 'timing',
              line_id: line.id,
              token_index: tokenIndex,
              locked: !token.locked_timing,
            }),
          )
        }}
      >
        {token.locked_timing ? <LockOutlined /> : <UnlockOutlined />} {t('align.lockTiming')}
      </button>
    </div>
  )
}
