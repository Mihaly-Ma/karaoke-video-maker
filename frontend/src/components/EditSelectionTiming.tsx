import { useEffect, useState } from 'react'

import { t } from '../i18n'
import { useProject } from '../state/projectStore'
import { CLEAR_PICKED_WORDS_EVENT, PICKED_WORDS_EVENT } from './RubyEditor'

type Range = { line_id: string; start: number; end: number }

export default function EditSelectionTiming() {
  const project = useProject((s) => s.project)
  const shiftSelection = useProject((s) => s.shiftSelection)
  const [ranges, setRanges] = useState<Range[]>([])
  const [delta, setDelta] = useState('100')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const read = () => {
      const hit = new Map<string, Range>()
      for (const el of document.querySelectorAll<HTMLElement>('.kvm-ruby__ch[data-picked]')) {
        const id = el.closest<HTMLElement>('[data-line]')?.dataset.line
        const index = Number(el.dataset.tk)
        if (!id || !Number.isInteger(index)) continue
        const range = hit.get(id)
        if (range) {
          range.start = Math.min(range.start, index)
          range.end = Math.max(range.end, index + 1)
        } else hit.set(id, { line_id: id, start: index, end: index + 1 })
      }
      setRanges([...hit.values()])
    }
    read()
    document.addEventListener(PICKED_WORDS_EVENT, read)
    return () => document.removeEventListener(PICKED_WORDS_EVENT, read)
  }, [project?.id])

  const valid = ranges.filter((r) => {
    const line = project?.lines.find((l) => l.id === r.line_id)
    return line && r.end <= line.tokens.length
  })
  const count = valid.reduce((n, r) => n + r.end - r.start, 0)
  const send = async (ms: number) => {
    if (busy || !count || !Number.isFinite(ms) || !ms) return
    setBusy(true)
    try {
      await shiftSelection(valid, Math.round(ms))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="edit-inspect__timing" data-role="selection-timing">
      <span className="kvm-ruby__label">{t('align.selectionShift')}</span>
      {count ? (
        <>
          <span>{t('align.selectionCount', { n: count })}</span>
          {[-100, -10, 10, 100].map((ms) => (
            <button type="button" className="small num" key={ms} disabled={busy} onClick={() => void send(ms)}>
              {ms > 0 ? `+${ms}` : ms}
            </button>
          ))}
          <input
            type="number"
            className="num edit-offset__value"
            aria-label={t('align.selectionDelta')}
            value={delta}
            disabled={busy}
            onChange={(e) => setDelta(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send(Number(delta))
            }}
          />
          <span>ms</span>
          <button type="button" className="small" disabled={busy || !Number(delta)} onClick={() => void send(Number(delta))}>
            {t('align.selectionApply')}
          </button>
        </>
      ) : <span className="kvm-ruby__muted">{t('align.selectionHint')}</span>}
    </div>
  )
}


export function EditUnitActions() {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const select = useProject((s) => s.select)
  const mergeTokens = useProject((s) => s.mergeTokens)
  const splitTokens = useProject((s) => s.splitTokens)
  const [ranges, setRanges] = useState<Range[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const read = () => {
      const hit = new Map<string, Range>()
      for (const el of document.querySelectorAll<HTMLElement>('.kvm-ruby__ch[data-picked]')) {
        const line_id = el.closest<HTMLElement>('[data-line]')?.dataset.line
        const index = Number(el.dataset.tk)
        if (!line_id || !Number.isInteger(index)) continue
        const r = hit.get(line_id)
        if (r) { r.start = Math.min(r.start, index); r.end = Math.max(r.end, index + 1) }
        else hit.set(line_id, { line_id, start: index, end: index + 1 })
      }
      setRanges([...hit.values()])
    }
    read()
    document.addEventListener(PICKED_WORDS_EVENT, read)
    return () => document.removeEventListener(PICKED_WORDS_EVENT, read)
  }, [project])
  const range = ranges.length === 1 ? ranges[0] : ranges.length === 0 && selection.kind === 'token'
    ? { line_id: selection.lineId, start: selection.tokenIndex, end: selection.tokenIndex + 1 } : null
  const line = project?.lines.find((l) => l.id === range?.line_id)
  const valid = range && line && !line.is_metadata && range.end <= line.tokens.length
  const canMerge = valid && range.end - range.start > 1
  const canSplit = valid && line.tokens.slice(range.start, range.end).some((tk) => Array.from(tk.text).length > 1)
  const run = async (split: boolean) => {
    if (busy || !range || !(split ? canSplit : canMerge)) return
    setBusy(true)
    try {
      await (split ? splitTokens : mergeTokens)(range.line_id, range.start, range.end)
      if (!useProject.getState().error) {
        document.dispatchEvent(new Event(CLEAR_PICKED_WORDS_EVENT))
        select({ kind: 'token', lineId: range.line_id, tokenIndex: range.start })
      }
    } finally { setBusy(false) }
  }
  return <div className="edit-tool-group" role="group" aria-label={t('align.units')}>
    <button type="button" className="small" disabled={busy || !canMerge} title={t('align.mergeUnitsHint')} onClick={() => void run(false)}>{t('align.mergeUnits')}</button>
    <button type="button" className="small" disabled={busy || !canSplit} title={t('align.splitUnitsHint')} onClick={() => void run(true)}>{t('align.splitUnits')}</button>
  </div>
}
