/**
 * 整曲偏移 —— 三级调轴的「整体」级（CLAUDE.md §5.8「全局 offset 旋钮」）。
 *
 * ## 为什么在时间轴工具条上
 *
 * 它搬过两次家，两次都是因为放错了地方：
 *
 * 1. 最早是工具条**下方一整条横带**（滑块 + 四个按钮 + 数字框 + 归零）。
 *    一个全曲改一次的旋钮，占掉的正是**逐字轴**——每个字都要动的那条轨道。
 * 2. 于是搬去舞台左栏、贴着画面。结果左栏本来就只有一个 191px 高的画面 +
 *    一条走带，塞进这张 112px 的小卡片之后仍有 272px 空着——**它没有省下空间，
 *    只是把浪费换了个位置**，还顺手把歌词正文挤窄了 220px。
 *
 * 现在它是工具条右段的一个**行内控件**：与同排的缩放 / 整曲同属"作用于全曲"的
 * 一类，改完之后波形上每一块都会动，控件和结果在同一屏里。
 *
 * ## 与检查器的「平移」必须一眼分得开
 *
 * 底栏检查器上有一组**作用于单个字**的 ±ms 按钮。两组曾经长得一模一样
 * （同样四个 -100/-10/+10/+100 并排），是真实发生过的误读来源。现在三处不同：
 *
 * | | 整曲偏移 | 检查器的平移 |
 * |---|---|---|
 * | 位置 | 时间轴**顶部**工具条 | 舞台**底栏** |
 * | 形态 | 对称摆在数值两侧，带图标与「整曲」二字 | 四个按钮并排在标签之后 |
 * | 范围 | 全曲，不动任何 token | 选中的那一个字 |
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

import { ClockCircleOutlined, UndoOutlined } from '@ant-design/icons'
import { useCallback, useRef, useState } from 'react'

import { t } from '../i18n'
import { useProject } from '../state/projectStore'

/**
 * 一次点击调多少。10ms 是听得出差别的下限，100ms 用来对付整段偏移。
 * 拆成左右两半**对称摆在数值两侧**——这既是"往左挪 / 往右挪"的直接映射，
 * 也让它和检查器那组"标签 + 四连按钮"在形状上就区分得开。
 */
const NUDGES_DOWN = [-100, -10]
const NUDGES_UP = [10, 100]

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

  const nudge = (ms: number) => (
    <button
      key={ms}
      type="button"
      className="small num"
      data-role="global-nudge"
      onClick={() => send(ms)}
    >
      {ms > 0 ? `+${ms}` : ms}
    </button>
  )

  return (
    <span className="edit-offset" data-role="global-offset">
      {/* 「整曲」两个字不能省：它是这一组按钮与检查器那一组唯一的语义差别 */}
      <span className="edit-offset__title" title={t('align.offsetHint')}>
        <ClockCircleOutlined />
        {t('align.offset')}
      </span>

      {NUDGES_DOWN.map(nudge)}

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

      {NUDGES_UP.map(nudge)}

      {/* 归零是"随时能回来"的出口（见文件头），语义单一，纯图标即可 */}
      <button
        type="button"
        className="small"
        data-role="offset-reset"
        disabled={!offset}
        title={t('align.reset')}
        aria-label={t('align.reset')}
        onClick={() => send(-offset)}
      >
        <UndoOutlined />
      </button>
    </span>
  )
}
