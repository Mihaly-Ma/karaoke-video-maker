import { useEffect, useMemo, useRef, useState } from 'react'

import type { MoraTime, MoraTimingItem } from '../api/types'
import { t } from '../i18n'
import { isKana, splitMora, toCodePoints, toHiragana } from '../lib/kana'
import { formatMs } from '../lib/timeScale'
import { useProject } from '../state/projectStore'
import { buildUnits } from './RubyModel'

export default function MoraTap({ onExit }: { onExit: () => void }) {
  const project = useProject((s) => s.project)
  const setMoraTimings = useProject((s) => s.setMoraTimings)
  const groups = useMemo(() => (project?.lines ?? []).filter((l) => !l.is_metadata).flatMap((line) =>
    buildUnits(line).filter((u) => u.kind !== 'other').map((u) => {
      const reading = toHiragana(u.span?.text ?? u.text)
      const moras = toCodePoints(reading).every(isKana) ? splitMora(reading) : []
      const record = line.mora_timings?.find((r) => r.start === u.start && r.end === u.end && r.surface === u.text && toHiragana(r.reading) === reading)
      const tokens = line.tokens.slice(u.tokenIndex, u.tokenEnd)
      const shifts = record && tokens.length === record.token_ids.length && tokens.every((tk, i) => tk.tid === record.token_ids[i] && tk.dur_ms === record.token_durations[i])
        ? tokens.map((tk, i) => tk.start_ms - record.token_starts[i]) : []
      const offset = shifts.length && shifts.every((v) => v === shifts[0]) ? shifts[0] : null
      return { ...u, reading, moras, key: `${line.id}:${u.start}:${u.end}:${reading}`, saved: record && offset !== null ? record.times.map((b) => ({ ...b, start_ms: b.start_ms + offset })) : [] }
    })), [project])
  const beats = useMemo(() => groups.flatMap((g) => g.moras.map((text, index) => ({ group: g, index, text, key: `${g.key}#${index}` }))), [groups])
  const [pos, setPos] = useState(() => {
    const selection = useProject.getState().selection
    if (selection.kind === 'none') return 0
    const found = beats.findIndex((b) => b.group.lineId === selection.lineId && b.group.tokenIndex <= (selection.kind === 'token' ? selection.tokenIndex : 0) && b.group.tokenEnd > (selection.kind === 'token' ? selection.tokenIndex : 0))
    return Math.max(0, found)
  })
  const [draft, setDraft] = useState<Record<string, MoraTime>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = useRef({ pos, draft, busy })
  live.current = { pos, draft, busy }
  const stack = useRef<Array<{ pos: number; draft: Record<string, MoraTime> }>>([])
  const handlers = useRef<(e: KeyboardEvent) => void>(() => undefined)
  const current = beats[pos]
  const missing = groups.filter((g) => !g.moras.length)

  const update = (nextPos: number, nextDraft: Record<string, MoraTime>) => {
    live.current = { ...live.current, pos: nextPos, draft: nextDraft }
    setPos(nextPos); setDraft(nextDraft)
  }
  const tap = (endLine = false) => {
    const state = live.current
    if (state.busy || (!endLine && !beats[state.pos])) return
    const now = Math.max(0, Math.round(useProject.getState().playheadMs - (project?.global_offset_ms ?? 0)))
    const next = { ...state.draft }
    const prev = beats[state.pos - 1]
    if (prev && next[prev.key] && now < next[prev.key].start_ms + 10) {
      setError(t('align.mora.order')); return
    }
    stack.current.push({ pos: state.pos, draft: { ...state.draft } })
    if (prev && next[prev.key]) {
      const length = now - next[prev.key].start_ms
      next[prev.key] = { ...next[prev.key], dur_ms: endLine || prev.group.lineId === beats[state.pos]?.group.lineId ? length : Math.min(800, length) }
    }
    if (endLine) {
      let target = state.pos
      while (beats[target] && beats[target].group.lineId === prev?.group.lineId) target++
      update(target, next)
    } else {
      const beat = beats[state.pos]
      next[beat.key] = { text: beat.text, start_ms: now, dur_ms: beat.group.saved[beat.index]?.dur_ms ?? 200 }
      update(state.pos + 1, next)
    }
    setError(null)
  }
  const save = async (exit = false) => {
    if (live.current.busy) return
    const snapshot = { ...live.current.draft }
    const touched = groups.filter((g) => g.moras.some((_, i) => snapshot[`${g.key}#${i}`]))
    if (!touched.length) { if (exit) onExit(); return }
    const items: MoraTimingItem[] = []
    for (const group of touched) {
      const times = group.moras.map((_, i) => snapshot[`${group.key}#${i}`] ?? group.saved[i])
      if (times.some((b) => !b)) { setError(t('align.mora.incomplete', { text: group.text })); return }
      items.push({ line_id: group.lineId, start: group.start, end: group.end, surface: group.text, reading: group.reading, times })
    }
    live.current.busy = true; setBusy(true)
    try {
      await setMoraTimings(items)
      const failure = useProject.getState().error
      if (failure) { setError(failure); return }
      stack.current = []
      update(live.current.pos, {})
      if (exit) onExit()
    } finally { live.current.busy = false; setBusy(false) }
  }
  handlers.current = (e) => {
    const el = e.target
    if (e.ctrlKey || e.metaKey || e.repeat || (el instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(el.tagName) || el.isContentEditable))) return
    if (![' ', 'Enter', 'Backspace', 'Escape'].includes(e.key)) return
    e.preventDefault(); e.stopImmediatePropagation()
    if (e.key === 'Escape') void save(true)
    else if (e.key === 'Backspace') {
      const prev = stack.current.pop()
      if (prev && !live.current.busy) { update(prev.pos, prev.draft); setError(null) }
    } else tap(e.shiftKey)
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => handlers.current(e)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [])

  return <section className="mora-tap" data-role="mora-tap">
    <div className="mora-tap__head">
      <strong>{t('align.mora.title')}</strong><span>{t('align.mora.keys')}</span>
      <button type="button" className="small" disabled={busy || !stack.current.length} onClick={() => { const prev = stack.current.pop(); if (prev) update(prev.pos, prev.draft) }}>{t('align.tapBack')}</button>
      <button type="button" className="small" disabled={busy || !Object.keys(draft).length} onClick={() => void save()}>{t('align.tapCommit')}</button>
      <button type="button" className="small" disabled={busy} onClick={() => void save(true)}>{t('align.mora.exit')}</button>
    </div>
    {missing.length > 0 && <span className="error">{t('align.mora.missing', { text: missing.map((g) => g.text).join('、') })}</span>}
    <div className="mora-tap__beats">
      {beats.filter((b) => b.group.lineId === (current?.group.lineId ?? beats[beats.length - 1]?.group.lineId)).map((beat) => {
        const value = draft[beat.key] ?? beat.group.saved[beat.index]
        return <button key={beat.key} type="button" aria-pressed={beat.key === current?.key} data-next={beat.key === current?.key || undefined} disabled={busy} onClick={(e) => { e.currentTarget.blur(); update(beats.indexOf(beat), live.current.draft) }}>
          <small>{beat.index === 0 ? beat.group.text : '・'}</small><b>{beat.text}</b><small>{value ? formatMs(value.start_ms, true) : '—'}</small>
        </button>
      })}
    </div>
    {error && <span role="alert" className="error">{error}</span>}
  </section>
}
