/**
 * 声部指派条 —— 贴在歌词正文下方。
 *
 * ## 为什么在这儿，而不是底栏检查器
 *
 * 声部是**行 / token 的属性**，而"选中哪一行、哪个字"这个动作发生在歌词正文里。
 * 控件跟选择动作待在一起，眼睛不用在屏幕上下两端来回跑 —— 尤其「本句起 N 句」
 * 这种要一边看歌词一边确认范围的操作，隔着大半个屏幕根本没法确认改对了没有。
 *
 * 底栏检查器是"当前选中项的属性面板"，放那儿不算错，但它离选择动作太远。
 * 搬过来之后**底栏不再留任何声部入口**：同一个属性两处都能改，正是这轮重做
 * 要消灭的那类问题。
 *
 * ## 为什么它是一条而不是一块
 *
 * 上一轮刚把歌词正文从 1004px 拓到 1232px（1024 窗口下 428 → 672px），
 * 这里再摆一块面板等于把腾出来的地方又吃回去。所以是**单行、横向、会换行**的
 * 一条：宽度一点不占（它在正文下方，不与正文抢横向空间），高度只吃一行。
 *
 * ## §2.5：这是声部唯一的入口
 *
 * CLAUDE.md §2.5 的表格里，声部那一行自动栏写的是"（暂无可靠自动方案）"，
 * 手工旁路写的是"选中词句指派声部"。也就是说自动识别可以没有，
 * **手工指派不能没有** —— 在这条控件出现之前，前端对 `setVoicePart` 的调用是零。
 */

import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { useCallback, useMemo, useState } from 'react'

import type { Project } from '../api/types'
import { t } from '../i18n'
import { useProject } from '../state/projectStore'

/**
 * 声部名从**歌词数据**汇总，不允许凭空新建一个没有任何行引用的声部。
 *
 * 这份逻辑与 `StylePanel.collectParts` 必须一致 —— 样式舞台的配色列表就是按它列的，
 * 这里指派出一个新声部，那边才会冒出对应的一格。两处**故意各写一份**而不是共用：
 * 样式舞台归别人所有，为了共用一个十行的纯函数去改它不划算；代价是改一处要改两处，
 * 所以两边都留了这条注释。
 */
function collectParts(project: Project | null): string[] {
  const set = new Set<string>()
  for (const line of project?.lines ?? []) {
    if (line.voice_part) set.add(line.voice_part)
    for (const tk of line.tokens) if (tk.voice_part) set.add(tk.voice_part)
  }
  for (const name of Object.keys(project?.palettes ?? {})) set.add(name)
  /*
   * **`main` 不是无条件塞进来的。**
   *
   * 早先这里写的是 `new Set(['main'])`，于是把 main 改名成「男」之后，列表里
   * 仍然常驻一个没有任何行引用的 `main` —— 删也删不掉（删除作用于"当前行的声部"，
   * 而没有任何一行挂着它），用户看到的就是"main 怎么删不掉"。
   *
   * 现在只在**一个声部都收不到**时才兜底给 main：那种情况下总得有个默认值，
   * 而它一旦被用起来就会自己出现在上面的收集里。
   */
  if (set.size === 0) set.add('main')
  return [...set].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
}

/** 作用域。三档覆盖用户点名的「当前句 / 此句之后 / 选中多句」 */
type VoiceScope = 'line' | 'after' | 'tokens'

export default function EditVoice() {
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

  /**
   * 删掉当前声部之后，它那些行改挂到谁身上。取"除它之外用得最多的那个"；
   * 全曲只有这一个声部在用时返回 null —— 那种情况不许删。
   */
  const deleteTarget = useMemo(() => {
    const cur = (project?.lines ?? []).find((l) => l.id === (selection.kind === 'none' ? '' : selection.lineId))
    const from = cur?.voice_part || 'main'
    const used = new Map<string, number>()
    for (const l of project?.lines ?? []) {
      const p = l.voice_part || 'main'
      if (p !== from) used.set(p, (used.get(p) ?? 0) + 1)
    }
    if (used.size === 0) {
      const other = parts.find((p) => p !== from)
      return other ?? null
    }
    return [...used.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }, [project, selection, parts])

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

  /**
   * 删除声部：把全曲引用它的地方并到另一个声部，并摘掉它的配色键。
   *
   * "删除"在这里**不可能是"清空"** —— 一行总得有个声部（后端 `SetVoicePartRequest`
   * 只在给了 `token_range` 时才允许传空串）。所以删除 = 归并：行级改挂到 `fallback`，
   * 字级覆盖传空串清掉、回到继承行声部。
   *
   * 兜底目标取"除它之外用得最多的那个"，而不是写死 main —— main 本身可以被改名
   * （用户把它叫成「男」是常态），写死就会在改过名的工程里凭空造出一个 main。
   *
   * 只剩一个声部时不许删：删完没有任何声部可挂，配色也就无从取色。
   */
  const doDelete = async () => {
    const ln = line
    const proj = project
    if (!ln || !proj || busy) return
    const from = ln.voice_part || 'main'
    if (!deleteTarget) return
    setBusy(true)
    setDone(null)
    try {
      let n = 0
      for (const l of proj.lines) {
        if (l.voice_part === from) {
          await setVoicePart(l.id, deleteTarget, undefined)
          n += 1
        }
        // 字级覆盖按连续段清空（传空串 = 回到继承行声部）
        let s = -1
        for (let i = 0; i <= l.tokens.length; i++) {
          const hit = i < l.tokens.length && l.tokens[i].voice_part === from
          if (hit && s < 0) s = i
          if (!hit && s >= 0) {
            await setVoicePart(l.id, '', [s, i])
            n += 1
            s = -1
          }
        }
      }
      const pal = useProject.getState().project?.palettes ?? {}
      if (from in pal) {
        const next = Object.fromEntries(Object.entries(pal).filter(([k]) => k !== from))
        await updatePalettes(next, true)
      }
      setDone({ n, part: deleteTarget })
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

      {/*
        删除当前声部。删 = **归并**，不是清空（一行总得有个声部），
        所以按钮上把归并目标写进 title —— 点下去改多少、改成什么，动手前就说清。
      */}
      <button
        type="button"
        className="iconbtn"
        data-role="voice-delete"
        data-target={deleteTarget ?? undefined}
        title={
          deleteTarget
            ? t('align.voiceDeleteHint', { part: curPart, to: deleteTarget })
            : t('align.voiceDeleteLast')
        }
        aria-label={t('align.voiceDeleteHint', { part: curPart, to: deleteTarget ?? '' })}
        disabled={busy || !deleteTarget}
        onClick={() => void doDelete()}
      >
        <DeleteOutlined />
      </button>

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
