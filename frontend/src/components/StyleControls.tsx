/**
 * 右栏的排版 / 时间 / 引导点三组参数。
 *
 * 每格是"标签 + 数字同行、滑块独占一行"：360px 的控件栏放不下旧版那种
 * "148px 标签列 + 滑块 + 数字"的一行式排布，硬塞的结果是滑块只剩几十像素。
 *
 * 两处偏离推荐值会出警告，因为它们的后果只在成片里才暴露（CLAUDE.md §8.5）：
 * 字号低于画面高度 6% 在实际观看距离下看不清；描边低于字号 3% 在 4K 下细到看不见。
 * 警告只说"偏离了多少"，不讲原理——原理属于文档（docs/ui-redesign.md 文案规则）。
 */

import { WarningOutlined } from '@ant-design/icons'

import type { Style } from '../api/types'
import { t } from '../i18n'

export interface FieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  warning?: string | null
  onChange: (v: number) => void
  onCommit: () => void
}

export function Field({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  warning,
  onChange,
  onCommit,
}: FieldProps) {
  const handle = (raw: string) => {
    const v = Number(raw)
    if (!Number.isNaN(v)) onChange(v)
  }
  return (
    <div className="sty-f">
      <div className="sty-f__head">
        <span className="sty-f__label">{label}</span>
        <input
          type="number"
          className="sty-f__num"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => handle(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="sty-f__unit">{unit}</span>
      </div>
      <input
        type="range"
        className="sty-f__range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => handle(e.target.value)}
        onMouseUp={onCommit}
        onTouchEnd={onCommit}
        onKeyUp={onCommit}
      />
      {warning && (
        <div className="sty-f__warn">
          <WarningOutlined /> <span>{warning}</span>
        </div>
      )}
    </div>
  )
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="sty-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export interface StyleControlsProps {
  draft: Style
  videoHeight: number
  set: <K extends keyof Style>(key: K, value: Style[K]) => void
  setNow: <K extends keyof Style>(key: K, value: Style[K]) => void
  commit: () => void
}

/** 排版：字号 / 描边 / 注音 / 边距 / 上下行错开 */
export function LayoutControls({ draft, videoHeight, set, setNow, commit }: StyleControlsProps) {
  const fontRatio = videoHeight > 0 ? draft.font_size / videoHeight : null
  const fontWarn =
    fontRatio !== null && fontRatio < 0.06
      ? t('style.warn.fontSize', { pct: (fontRatio * 100).toFixed(1) })
      : null
  const outlineRatio = draft.font_size > 0 ? draft.outline / draft.font_size : null
  const outlineWarn =
    outlineRatio !== null && outlineRatio < 0.03
      ? t('style.warn.outline', { pct: (outlineRatio * 100).toFixed(1) })
      : null
  const fontMax = videoHeight > 0 ? Math.max(200, Math.round(videoHeight * 0.25)) : 300

  return (
    <>
      <Field
        label={t('style.field.fontSize')}
        value={draft.font_size}
        min={24}
        max={fontMax}
        unit="px"
        warning={fontWarn}
        onChange={(v) => set('font_size', v)}
        onCommit={commit}
      />
      <Check
        label={t('style.field.bold')}
        checked={draft.bold}
        onChange={(v) => setNow('bold', v)}
      />
      <Field
        label={t('style.field.outline')}
        value={draft.outline}
        min={0}
        max={20}
        step={0.1}
        unit="px"
        warning={outlineWarn}
        onChange={(v) => set('outline', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.shadow')}
        value={draft.shadow}
        min={0}
        max={10}
        step={0.1}
        unit="px"
        onChange={(v) => set('shadow', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.rubyScale')}
        value={draft.ruby_scale}
        min={0.1}
        max={1}
        step={0.01}
        unit="×"
        onChange={(v) => set('ruby_scale', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.rubyGap')}
        value={draft.ruby_gap}
        min={0}
        max={40}
        unit="px"
        onChange={(v) => set('ruby_gap', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.marginV')}
        value={draft.margin_v}
        min={0}
        max={400}
        unit="px"
        onChange={(v) => set('margin_v', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.marginH')}
        value={draft.margin_h}
        min={0}
        max={400}
        unit="px"
        onChange={(v) => set('margin_h', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.lineGap')}
        value={draft.line_gap}
        min={0}
        max={100}
        unit="px"
        onChange={(v) => set('line_gap', v)}
        onCommit={commit}
      />
      <Check
        label={t('style.field.stagger')}
        checked={draft.stagger}
        onChange={(v) => setNow('stagger', v)}
      />
      <div className="sty-note">{t('style.field.staggerHint')}</div>
    </>
  )
}

/** 时间：提前入场 / 停留 / 间奏与槽位阈值 */
export function TimingControls({ draft, set, commit }: StyleControlsProps) {
  const leadWarn = draft.max_lead_ms > 8000 ? t('style.warn.maxLead') : null
  return (
    <>
      <Field
        label={t('style.field.leadIn')}
        value={draft.lead_in_ms}
        min={0}
        max={3000}
        step={50}
        unit="ms"
        onChange={(v) => set('lead_in_ms', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.maxLead')}
        value={draft.max_lead_ms}
        min={0}
        max={12000}
        step={100}
        unit="ms"
        warning={leadWarn}
        onChange={(v) => set('max_lead_ms', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.leadOut')}
        value={draft.lead_out_ms}
        min={0}
        max={3000}
        step={50}
        unit="ms"
        onChange={(v) => set('lead_out_ms', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.paragraphGap')}
        value={draft.paragraph_gap_ms}
        min={500}
        max={10000}
        step={100}
        unit="ms"
        onChange={(v) => set('paragraph_gap_ms', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.slotGap')}
        value={draft.slot_gap_ms}
        min={0}
        max={2000}
        step={50}
        unit="ms"
        onChange={(v) => set('slot_gap_ms', v)}
        onCommit={commit}
      />
    </>
  )
}

/** 开唱引导点：点从右往左依次熄灭，只在首句与间奏后出现 */
export function CountdownControls({ draft, set, commit }: StyleControlsProps) {
  return (
    <>
      <Field
        label={t('style.field.dots')}
        value={draft.countdown_dots}
        min={0}
        max={8}
        unit={t('style.unit.dots')}
        onChange={(v) => set('countdown_dots', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.beat')}
        value={draft.countdown_beat_ms}
        min={100}
        max={2000}
        step={10}
        unit="ms"
        onChange={(v) => set('countdown_beat_ms', v)}
        onCommit={commit}
      />
      <Field
        label={t('style.field.minGap')}
        value={draft.countdown_min_gap_ms}
        min={500}
        max={10000}
        step={100}
        unit="ms"
        onChange={(v) => set('countdown_min_gap_ms', v)}
        onCommit={commit}
      />
      <div className="sty-note">{t('style.field.dotsHint')}</div>
    </>
  )
}
