import { useState } from 'react'

import { t } from '../i18n'
import { useProject } from '../state/projectStore'

type Row = { key: string; line_id: string | null; text: string }
const emptyRow = (): Row => ({ key: crypto.randomUUID(), line_id: null, text: '' })

export default function LyricsEditor() {
  const project = useProject((s) => s.project)
  const editLyrics = useProject((s) => s.editLyrics)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!project) return null

  const insert = (index: number) =>
    setRows((current) => {
      if (!current) return current
      return [...current.slice(0, index), emptyRow(), ...current.slice(index)]
    })
  const save = async () => {
    if (!rows) return
    setBusy(true)
    setError(null)
    await editLyrics(
      rows.filter((row) => row.text.trim()).map(({ line_id, text }) => ({ line_id, text })),
    )
    const failure = useProject.getState().error
    setBusy(false)
    if (failure) setError(failure)
    else setRows(null)
  }

  return (
    <>
      <div style={{ padding: '4px 8px' }}>
        <button
          type="button"
          onClick={() => {
            setRows(
              project.lines.map((line) => ({
                key: line.id,
                line_id: line.id,
                text: line.tokens.map((token) => token.text).join(''),
              })),
            )
            setError(null)
          }}
        >
          {t('lyrics.editor.open')}
        </button>
      </div>
      {rows !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('lyrics.editor.open')}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: '#0009',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <section
            style={{
              width: 'min(900px, 95vw)',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-surface)',
              padding: 16,
              gap: 8,
              borderRadius: 8,
            }}
          >
            <strong>{t('lyrics.editor.open')}</strong>
            <span>{t('lyrics.editor.hint')}</span>
            <div style={{ overflowY: 'auto', minHeight: 0 }}>
              <button type="button" disabled={busy} onClick={() => insert(0)}>
                {t('lyrics.editor.addFirst')}
              </button>
              {rows.map((row, index) => (
                <div
                  key={row.key}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
                >
                  <span>{index + 1}</span>
                  <textarea
                    rows={1}
                    value={row.text}
                    disabled={busy}
                    style={{ flex: 1, minWidth: 0 }}
                    aria-label={t('lyrics.editor.row', { n: index + 1 })}
                    onChange={(e) => {
                      const parts = e.target.value.split(/\r?\n/)
                      setRows(
                        (current) =>
                          current?.flatMap((item) =>
                            item.key !== row.key
                              ? [item]
                              : parts.map((text, i) =>
                                  i === 0 ? { ...item, text } : { ...emptyRow(), text },
                                ),
                          ) ?? null,
                      )
                    }}
                  />
                  <button type="button" disabled={busy} onClick={() => insert(index + 1)}>
                    {t('lyrics.editor.insert')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setRows((current) => current?.filter((item) => item.key !== row.key) ?? null)
                    }
                  >
                    {t('lyrics.editor.delete')}
                  </button>
                </div>
              ))}
            </div>
            {error && <span role="alert">{error}</span>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" disabled={busy} onClick={() => setRows(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={busy} onClick={() => void save()}>
                {t('lyrics.editor.save')}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
