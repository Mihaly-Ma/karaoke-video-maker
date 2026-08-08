/**
 * 手工导入歌词——不是"搜索失败后的惩罚性回退"，是与搜索并列的一等入口
 * （CLAUDE.md §2.5：每个自动环节都必须有等价的手工旁路，且随时可用）。
 *
 * 支持三种格式：
 * - 纯文本：一行一句，无时间轴，导入后靠 tap-to-time 手工打轴
 * - LRC：行级时间轴（`[mm:ss.xx]文本`）
 * - QRC：逐字轴 + 可选 `[kana:]` 假名注音轨（QQ音乐/酷狗风格）
 *
 * 支持粘贴、拖拽文件、文件选择器；导入前用一个**简化的前端启发式解析**
 * 给出行数与内容预览——真正的解析仍在后端完成，这里只是"心里有数"，
 * 不是权威结果，预览区已明确标注。
 */

import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { history as fetchProjectHistory, importLyrics } from '../api/client'
import { useProject } from '../state/projectStore'

type ImportKind = 'text' | 'lrc' | 'qrc'

const KIND_LABELS: Record<ImportKind, string> = {
  text: '纯文本',
  lrc: 'LRC（行级时间轴）',
  qrc: 'QRC（逐字轴 + 假名）',
}

const KIND_HINTS: Record<ImportKind, string> = {
  text: '一行一句，不含任何时间信息；导入后需要用 tap-to-time 从零手工打轴。',
  lrc: '形如 [00:12.34]歌词 的行级时间标签；导入后每行有整句时间，单词/音节仍需手工细化。',
  qrc: 'QQ音乐/酷狗风格逐字轴，形如 [起始,时长]字(起始,时长)…；若含 [kana:] 行还会带假名注音。',
}

interface PreviewEntry {
  time: string | null
  text: string
}

interface ImportPreviewResult {
  lineCount: number
  warningCount: number
  sample: PreviewEntry[]
  hasKanaTrack: boolean
}

const SAMPLE_LIMIT = 8

function parseTextPreview(content: string): ImportPreviewResult {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return {
    lineCount: lines.length,
    warningCount: 0,
    sample: lines.slice(0, SAMPLE_LIMIT).map((text) => ({ time: null, text })),
    hasKanaTrack: false,
  }
}

// LRC/QRC 共用的元数据标签行（曲名/歌手/专辑/上传者/整体偏移等），预览时忽略不计
const META_TAG_RE = /^\[(ti|ar|al|by|offset|length|re|ve):/i
const LRC_TIME_TAG_RE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/

function parseLrcPreview(content: string): ImportPreviewResult {
  const rawLines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const sample: PreviewEntry[] = []
  let lineCount = 0
  let warningCount = 0

  for (const raw of rawLines) {
    if (META_TAG_RE.test(raw)) continue
    let rest = raw
    const times: string[] = []
    let m = LRC_TIME_TAG_RE.exec(rest)
    while (m) {
      times.push(`${m[1]}:${m[2]}`)
      rest = rest.slice(m[0].length)
      m = LRC_TIME_TAG_RE.exec(rest)
    }
    if (times.length === 0) {
      warningCount += 1
      continue
    }
    lineCount += times.length
    if (sample.length < SAMPLE_LIMIT) sample.push({ time: times[0], text: rest.trim() || '（空行）' })
  }
  return { lineCount, warningCount, sample, hasKanaTrack: false }
}

// QRC 行形如 [起始ms,时长ms]字(起始ms,时长ms)字(起始ms,时长ms)…
const QRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/
const QRC_CHAR_TAG_RE = /\(\d+,\d+\)/g

function parseQrcPreview(content: string): ImportPreviewResult {
  const rawLines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const sample: PreviewEntry[] = []
  let lineCount = 0
  let warningCount = 0
  let hasKanaTrack = false

  for (const raw of rawLines) {
    if (META_TAG_RE.test(raw)) continue
    if (/^\[kana:/i.test(raw)) {
      hasKanaTrack = true
      continue
    }
    const m = QRC_LINE_RE.exec(raw)
    if (!m) {
      warningCount += 1
      continue
    }
    const [, startMs, , rest] = m
    const text = rest.replace(QRC_CHAR_TAG_RE, '').trim()
    lineCount += 1
    if (sample.length < SAMPLE_LIMIT) {
      sample.push({ time: formatMsAsMinSec(Number(startMs)), text: text || '（空行）' })
    }
  }
  return { lineCount, warningCount, sample, hasKanaTrack }
}

function formatMsAsMinSec(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`
}

function parsePreview(kind: ImportKind, content: string): ImportPreviewResult | null {
  if (!content.trim()) return null
  if (kind === 'text') return parseTextPreview(content)
  if (kind === 'lrc') return parseLrcPreview(content)
  return parseQrcPreview(content)
}

function detectKindFromFilename(name: string): ImportKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.lrc')) return 'lrc'
  if (lower.endsWith('.qrc') || lower.endsWith('.krc') || lower.endsWith('.xml')) return 'qrc'
  if (lower.endsWith('.txt')) return 'text'
  return null
}

export default function LyricImport() {
  const project = useProject((s) => s.project)

  const [kind, setKind] = useState<ImportKind>('text')
  const [content, setContent] = useState('')
  const [replace, setReplace] = useState(true)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importedSummary, setImportedSummary] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const preview = useMemo(() => parsePreview(kind, content), [kind, content])

  function loadFile(file: File) {
    setFileError(null)
    const detected = detectKindFromFilename(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      setContent(typeof reader.result === 'string' ? reader.result : '')
      setFileName(file.name)
      if (detected) setKind(detected)
    }
    reader.onerror = () => setFileError('文件读取失败，请重试，或直接把内容粘贴进文本框')
    reader.readAsText(file)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files?.[0]
    if (file) loadFile(file)
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) loadFile(file)
    e.target.value = ''
  }

  async function handlePasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setContent(text)
        setFileName(null)
      }
    } catch {
      setFileError('无法读取剪贴板（浏览器权限限制），请在文本框内直接 Ctrl+V 粘贴')
    }
  }

  async function handleImport() {
    if (!project) return
    if (!content.trim()) return
    setImporting(true)
    setImportError(null)
    setImportedSummary(null)
    try {
      const updated = await importLyrics(project.id, kind, content, replace)
      useProject.setState({ project: updated, error: null })
      try {
        const h = await fetchProjectHistory(updated.id)
        useProject.setState({ canUndo: h.undo > 0, canRedo: h.redo > 0 })
      } catch {
        /* 历史状态刷新失败不影响已完成的导入操作 */
      }
      setImportedSummary(`导入成功，工程当前共 ${updated.lines.length} 行歌词。`)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="kvm-lyric-import">
      {!project && (
        <div className="kvm-lyric-hint">尚未加载工程——可以先粘贴/拖入歌词试看解析预览，创建或打开工程后才能正式导入。</div>
      )}

      <div className="kvm-lyric-radio-group" role="radiogroup" aria-label="导入格式">
        {(Object.keys(KIND_LABELS) as ImportKind[]).map((k) => (
          <label key={k} className={`kvm-lyric-radio ${kind === k ? 'kvm-lyric-radio--active' : ''}`}>
            <input
              type="radio"
              name="kvm-lyric-import-kind"
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
            />
            {KIND_LABELS[k]}
          </label>
        ))}
      </div>
      <p className="kvm-lyric-hint">{KIND_HINTS[kind]}</p>

      <div
        className={`kvm-lyric-dropzone ${dragActive ? 'kvm-lyric-dropzone--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <textarea
          className="kvm-lyric-textarea"
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            setFileName(null)
          }}
          placeholder="把歌词文件拖拽到此处，或直接粘贴文本内容……"
          rows={10}
        />
        <div className="kvm-lyric-dropzone-actions">
          <button type="button" className="kvm-lyric-btn kvm-lyric-btn--ghost" onClick={() => fileInputRef.current?.click()}>
            选择文件…
          </button>
          <button type="button" className="kvm-lyric-btn kvm-lyric-btn--ghost" onClick={() => void handlePasteFromClipboard()}>
            从剪贴板粘贴
          </button>
          {content && (
            <button
              type="button"
              className="kvm-lyric-btn kvm-lyric-btn--ghost"
              onClick={() => {
                setContent('')
                setFileName(null)
              }}
            >
              清空
            </button>
          )}
          {fileName && <span className="kvm-lyric-filename">已加载：{fileName}</span>}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.lrc,.qrc,.krc,.xml"
          style={{ display: 'none' }}
          onChange={handleFileInputChange}
        />
      </div>
      {fileError && <div className="kvm-lyric-error">{fileError}</div>}

      {preview && (
        <div className="kvm-lyric-import-preview">
          <div className="kvm-lyric-meta-row">
            <strong>解析预览</strong>
            <span>识别到 {preview.lineCount} 行</span>
            {preview.warningCount > 0 && (
              <span className="kvm-lyric-badge kvm-lyric-badge--warn">{preview.warningCount} 行无法识别</span>
            )}
            {preview.hasKanaTrack && <span className="kvm-lyric-badge kvm-lyric-badge--info">检测到 [kana:] 注音轨</span>}
          </div>
          <ol className="kvm-lyric-preview-lines">
            {preview.sample.map((s, i) => (
              <li key={i} className="kvm-lyric-preview-line">
                {s.time && <span className="kvm-lyric-preview-time">{s.time}</span>}
                <span className="kvm-lyric-preview-text">{s.text}</span>
              </li>
            ))}
          </ol>
          {preview.lineCount > preview.sample.length && (
            <p className="kvm-lyric-hint">
              仅预览前 {preview.sample.length} 行。此预览为前端简化解析，仅供参考行数与大致内容，正式导入以后端解析结果为准。
            </p>
          )}
        </div>
      )}

      <div className="kvm-lyric-radio-group" role="radiogroup" aria-label="导入方式">
        <label className={`kvm-lyric-radio ${replace ? 'kvm-lyric-radio--active' : ''}`}>
          <input type="radio" name="kvm-lyric-import-mode" checked={replace} onChange={() => setReplace(true)} />
          替换现有歌词
        </label>
        <label className={`kvm-lyric-radio ${!replace ? 'kvm-lyric-radio--active' : ''}`}>
          <input type="radio" name="kvm-lyric-import-mode" checked={!replace} onChange={() => setReplace(false)} />
          追加到现有歌词
        </label>
      </div>

      <div className="kvm-lyric-actions">
        <button
          type="button"
          className="kvm-lyric-btn kvm-lyric-btn--primary"
          disabled={!project || !content.trim() || importing}
          title={!project ? '尚未加载工程' : undefined}
          onClick={() => void handleImport()}
        >
          {importing ? '导入中…' : '导入歌词'}
        </button>
      </div>

      {importError && <div className="kvm-lyric-error">导入失败：{importError}</div>}
      {importedSummary && <div className="kvm-lyric-success">{importedSummary}</div>}
    </div>
  )
}
