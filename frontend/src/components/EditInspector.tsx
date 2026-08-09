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

import { LockOutlined, UnlockOutlined } from '@ant-design/icons'
import { useCallback, useRef } from 'react'

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
