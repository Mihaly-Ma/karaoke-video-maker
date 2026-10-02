import { useEffect, useState } from 'react'

import { t } from '../i18n'
import { useProject } from '../state/projectStore'
import { PICKED_WORDS_EVENT } from './RubyEditor'

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
