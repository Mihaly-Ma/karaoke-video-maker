/**
 * 改写一行的歌词文本 —— §2.5「每个自动环节都必须有等价的手工旁路」里此前空着的一档。
 *
 * 歌词源认错版本、送假名写法不同、当て字被写成别的字都是常态（CLAUDE.md §6.1），
 * 而在此之前唯一的改法是把整首歌重新粘贴一遍——连带丢掉全部手工成果。
 * 改一个错字的正确粒度显然是一行，不是一首。
 *
 * ## 为什么不是边打字边提交
 *
 * 后端每次收到都要重算 token 切分、重绑时间与注音，并压一格撤销栈。
 * 按一次 Cmd+Z 应该退回到**改这一行之前**，而不是退掉一个字符，
 * 所以只有回车/失焦才提交，Esc 原样丢弃。
 *
 * ## 改完要能立刻看到后果
 *
 * 提交后回报"多少字保住了原时间、多少字的时间是推算的"——推算出来的字在逐字轴上
 * 是插值色（§7.4 要求四种来源在界面上可见地区分），用户一眼就能看出该复核哪几个字；
 * 绑不上的注音进「失效修正」清单，不静默丢弃（§4.4）。
 */

import { CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'

import { t } from '../i18n'
import { useProject } from '../state/projectStore'

/**
 * 改写行文本的结果，用于给用户一句话回执。
 *
 * 这些数字是**从新工程里数出来的**，不是后端回报的：后端的 warnings 只进日志与
 * 响应头，而"这一行现在有几个字的时间是推算的"恰恰能从工程数据本身读出来，
 * 数据自己说的比转述更可靠。
 */
export interface LineTextResult {
  /** 时间原样保住的字数（来源仍是歌词源/对齐/手工） */
  kept: number
  /** 时间靠插值推算、需要复核的字数 */
  guessed: number
  /** 新进「失效修正」清单的条数 */
  orphaned: number
}

/**
 * 提交改写。
 *
 * **这个 fetch 本该住在 `api/client.ts`，刷新则该走 `projectStore` 的一个 action。**
 * 本轮那两个文件由别的改动持有，为免冲突暂时落在这里；搬过去时把下面这段换成
 * `api.setLineText()` + store action 即可，组件不用改。
 *
 * 刷新用 `load()` 而不是 `refresh()`：`refresh()` 只换工程数据，不重新拉撤销深度，
 * 于是改完一行之后"撤销"按钮要滞后一拍才亮——而这一步正是用户最可能想撤销的操作。
 */
export async function submitLineText(
  projectId: string,
  lineId: string,
  text: string,
): Promise<LineTextResult> {
  const before = useProject.getState().project?.orphans.length ?? 0

  const resp = await fetch('/api/editor/line-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, line_id: lineId, text }),
  })
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`
    try {
      const body: unknown = await resp.json()
      const d = (body as { detail?: unknown }).detail
      if (typeof d === 'string') detail = d
    } catch {
      /* 响应体不是 JSON 时保留状态行 */
    }
    throw new Error(detail)
  }

  await useProject.getState().load(projectId)

  const line = useProject.getState().project?.lines.find((l) => l.id === lineId)
  const after = useProject.getState().project?.orphans.length ?? 0
  const guessed = (line?.tokens ?? []).filter(
    (tk) => tk.timing_source === 'interpolated' || tk.timing_source === 'unset',
  ).length
  return {
    kept: (line?.tokens.length ?? 0) - guessed,
    guessed,
    orphaned: Math.max(0, after - before),
  }
}

export interface EditLineTextProps {
  value: string
  busy: boolean
  onCommit: (text: string) => void
  onCancel: () => void
}

/** 就地改写一行文本的输入框。宽度吃满整行，改长句时不必在一个小框里横向翻。 */
export function EditLineText({ value, busy, onCommit, onCancel }: EditLineTextProps) {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** Esc 取消时不要让紧随其后的 blur 把草稿又提交一次 */
  const cancelRef = useRef(false)

  useEffect(() => {
    setDraft(value)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [value])

  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false
      return
    }
    onCommit(draft)
  }

  return (
    <span className="edit-linetext">
      <input
        ref={inputRef}
        type="text"
        className="edit-linetext__input"
        value={draft}
        disabled={busy}
        aria-label={t('ruby.lineText.label')}
        placeholder={t('ruby.lineText.placeholder')}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            cancelRef.current = true
            onCancel()
          }
        }}
        onBlur={commit}
      />
      <button
        type="button"
        className="iconbtn"
        disabled={busy}
        title={t('ruby.lineText.save')}
        aria-label={t('ruby.lineText.save')}
        // 用 mouseDown：输入框的 blur 会先于 click 触发并已经提交过一次，
        // 到 click 时这个按钮往往已经被卸载了
        onMouseDown={(e) => {
          e.preventDefault()
          onCommit(draft)
        }}
      >
        <CheckOutlined />
      </button>
      <button
        type="button"
        className="iconbtn"
        title={t('common.cancel')}
        aria-label={t('common.cancel')}
        onMouseDown={(e) => {
          e.preventDefault()
          cancelRef.current = true
          onCancel()
        }}
      >
        <CloseOutlined />
      </button>
    </span>
  )
}

export default EditLineText
