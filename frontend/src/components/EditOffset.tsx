/**
 * 整体偏移 —— 三级调轴的「整体」级（CLAUDE.md §5.8「全局 offset 旋钮」）。
 *
 * ## 为什么从时间轴里搬出来
 *
 * 它原先是时间轴工具条下的一整条横带（滑块 + 四个按钮 + 数字框 + 归零），
 * 占掉的正是**逐字轴**的高度——一个全曲改一次的旋钮压着一个每个字都要动的轨道。
 * 现在它贴着画面放在舞台左栏，宽度与画面对齐，只有两行。
 *
 * ## 为什么没有滑块
 *
 * 滑块要跟手就必须有本地草稿（拖动中先改本地、松手才发请求），而草稿一旦离开
 * 时间轴组件，时间轴就看不到拖动过程中的偏移——波形上的方块会在松手那一刻
 * 整片跳一下。±10 / ±100 的按钮直接落库，改一次就是一次真实的重排，
 * 反而看得清；要跳到某个具体值就直接敲进数字框。
 *
 * 偏移**不写进任何 token 的时间**：写进去就再也回不来了，而重锚定（§5.3）本身
 * 是个高不确定性的自动环节，用户必须能随时归零重来。
 */

import { useCallback, useRef, useState } from 'react'

import { t } from '../i18n'
import { useProject } from '../state/projectStore'

/** 一次点击调多少。10ms 是听得出差别的下限，100ms 用来对付整段偏移 */
const NUDGES = [-100, -10, 10, 100]

export default function EditOffset() {
  const project = useProject((s) => s.project)
  const shift = useProject((s) => s.shift)

  const offset = project?.global_offset_ms ?? 0
  /** 数字框的本地草稿：敲字过程中不能每按一键就发一次请求 */
  const [draft, setDraft] = useState<string | null>(null)

  /**
   * 串行队列。每个编辑接口都返回整份工程，并发发出去的话后到的旧响应会把新改动
   * 覆盖掉——连点两下 +100ms 就会只生效一次。
   */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const send = useCallback(
    (delta: number) => {
      if (!delta) return
      const run = queueRef.current.then(() => shift('global', delta))
      queueRef.current = run.catch(() => undefined)
    },
    [shift],
  )

  const commitDraft = useCallback(() => {
    if (draft === null) return
    const target = Number(draft)
    setDraft(null)
    if (!Number.isFinite(target)) return
    send(Math.round(target) - offset)
  }, [draft, offset, send])

  if (!project) return null

  return (
    <section className="edit-offset">
      <div className="edit-offset__head">
        <span className="edit-offset__title" title={t('align.offsetHint')}>
          {t('align.offset')}
        </span>
        <button
          type="button"
          className="small ghost"
          disabled={!offset}
          onClick={() => send(-offset)}
        >
          {t('align.reset')}
        </button>
      </div>

      <div className="edit-offset__row">
        <input
          type="number"
          step={10}
          className="num edit-offset__value"
          aria-label={t('align.offset')}
          value={draft ?? String(offset)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitDraft()
          }}
        />
        <span className="edit-offset__unit">ms</span>
      </div>

      <div className="edit-offset__row">
        {NUDGES.map((ms) => (
          <button key={ms} type="button" className="small num edit-offset__nudge" onClick={() => send(ms)}>
            {ms > 0 ? `+${ms}` : ms}
          </button>
        ))}
      </div>
    </section>
  )
}
