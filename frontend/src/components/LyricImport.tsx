/**
 * 手工导入歌词（左侧窄列的另一个一等入口）。
 *
 * CLAUDE.md §2.5：手工旁路不是"搜索失败后的惩罚性回退"，要能随时主动使用——
 * 所以它与搜索是同一组切换里等宽的两个选项，而不是藏在角落的小链接。
 * 冷门曲、同人曲、翻唱在任何歌词库都可能查不到，这条路必须始终可用。
 *
 * 三种格式：
 * - text：一行一句，无时间轴，导入后靠 tap-to-time 打轴
 * - lrc：`[mm:ss.xx]` 行级时间轴
 * - qrc：逐字轴 + 可选 `[kana:]` 假名轨
 *
 * 本组件只管**采集内容**；粘贴进来的东西同样走中间那块成片样式的大预览，
 * 与搜索候选看到的是同一个渲染器。导入动作在底部元信息栏，与"使用候选"同一个位置。
 *
 * 草稿解析是**前端启发式**，只用来立刻看到行数与内容；`[kana:]` 的注音挂载
 * 有一串已知陷阱（CLAUDE.md §6.1：覆盖数按单个数字解析、credits 行也参与消费
 * kana 序列），错位的注音比没有注音更难发现，所以草稿一律不画注音，
 * 由后端解析后再显示。
 */

import { FileTextOutlined, FolderOpenOutlined, SnippetsOutlined } from '@ant-design/icons'
import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'

import { t } from '../i18n'
import type { ScriptLine } from './LyricScript'

export type ImportKind = 'text' | 'lrc' | 'qrc'

export const IMPORT_KINDS: { key: ImportKind; label: string; title: string }[] = [
  { key: 'text', label: 'lyrics.kindText', title: 'lyrics.kindTextTitle' },
  { key: 'lrc', label: 'lyrics.kindLrc', title: 'lyrics.kindLrcTitle' },
  { key: 'qrc', label: 'lyrics.kindQrc', title: 'lyrics.kindQrcTitle' },
]

export interface ImportDraft {
  lines: ScriptLine[]
  /** 有内容但对不上格式的行数——多半是选错了格式 */
  unrecognized: number
  hasKanaTrack: boolean
}

const EMPTY_DRAFT: ImportDraft = { lines: [], unrecognized: 0, hasKanaTrack: false }

// LRC/QRC 共用的元数据标签行（曲名/歌手/整体偏移等），不是歌词
const META_TAG_RE = /^\[(ti|ar|al|by|offset|length|re|ve):/i
const LRC_TIME_TAG_RE = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/
const QRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/
// QRC 的字块是「文本(起始,时长)」，文本在标记之前
const QRC_TOKEN_RE = /(.*?)\((\d+),(\d+)\)/g
// LyricContent 必须按原文取：XML 属性值规范化会把行分隔符 0x0A 换成空格
const QRC_CONTENT_RE = /LyricContent="([\s\S]*)"\s*\/>/

const draftLine = (id: string, tokens: string[], timingSource: string | null): ScriptLine => ({
  id,
  tokens,
  ruby: [],
  isMetadata: false,
  voicePart: 'main',
  timingSource,
})

function nonEmptyLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

function parseTextDraft(content: string): ImportDraft {
  return {
    lines: nonEmptyLines(content).map((text, i) => draftLine(`d${i}`, [text], null)),
    unrecognized: 0,
    hasKanaTrack: false,
  }
}

function parseLrcDraft(content: string): ImportDraft {
  const lines: ScriptLine[] = []
  let unrecognized = 0
  for (const raw of nonEmptyLines(content)) {
    if (META_TAG_RE.test(raw)) continue
    let rest = raw
    let stamps = 0
    let m = LRC_TIME_TAG_RE.exec(rest)
    while (m) {
      stamps += 1
      rest = rest.slice(m[0].length)
      m = LRC_TIME_TAG_RE.exec(rest)
    }
    if (stamps === 0) {
      unrecognized += 1
      continue
    }
    // 一行挂多个时间戳（重复副歌）时它会在成片里出现多次，草稿也照实展开
    for (let k = 0; k < stamps; k++) lines.push(draftLine(`d${lines.length}`, [rest.trim()], 'provider'))
  }
  return { lines, unrecognized, hasKanaTrack: false }
}

function parseQrcDraft(content: string): ImportDraft {
  const inner = QRC_CONTENT_RE.exec(content)
  const body = inner
    ? inner[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    : content

  const lines: ScriptLine[] = []
  let unrecognized = 0
  let hasKanaTrack = false

  for (const raw of nonEmptyLines(body)) {
    if (/^\[kana:/i.test(raw)) {
      hasKanaTrack = true
      continue
    }
    if (META_TAG_RE.test(raw)) continue
    const m = QRC_LINE_RE.exec(raw)
    if (!m) {
      unrecognized += 1
      continue
    }
    const tokens: string[] = []
    QRC_TOKEN_RE.lastIndex = 0
    let tk = QRC_TOKEN_RE.exec(m[3])
    while (tk) {
      if (tk[1]) tokens.push(tk[1])
      tk = QRC_TOKEN_RE.exec(m[3])
    }
    lines.push(draftLine(`d${lines.length}`, tokens.length ? tokens : [m[3]], 'provider'))
  }
  return { lines, unrecognized, hasKanaTrack }
}

export function parseImportDraft(kind: ImportKind, content: string): ImportDraft {
  if (!content.trim()) return EMPTY_DRAFT
  if (kind === 'text') return parseTextDraft(content)
  if (kind === 'lrc') return parseLrcDraft(content)
  return parseQrcDraft(content)
}

function detectKindFromFilename(name: string): ImportKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.lrc')) return 'lrc'
  if (lower.endsWith('.qrc') || lower.endsWith('.krc') || lower.endsWith('.xml')) return 'qrc'
  if (lower.endsWith('.txt')) return 'text'
  return null
}

export interface LyricImportProps {
  kind: ImportKind
  onKind: (kind: ImportKind) => void
  content: string
  onContent: (content: string) => void
  /** 替换现有歌词还是追加 */
  replace: boolean
  onReplace: (replace: boolean) => void
  disabled?: boolean
}

export default function LyricImport({
  kind,
  onKind,
  content,
  onContent,
  replace,
  onReplace,
  disabled = false,
}: LyricImportProps) {
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function loadFile(file: File) {
    setFileError(null)
    const detected = detectKindFromFilename(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      onContent(typeof reader.result === 'string' ? reader.result : '')
      setFileName(file.name)
      if (detected) onKind(detected)
    }
    reader.onerror = () => setFileError(t('lyrics.fileFailed'))
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

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        onContent(text)
        setFileName(null)
      }
    } catch {
      setFileError(t('lyrics.clipboardDenied'))
    }
  }

  return (
    <div className="lyr-form">
      <div className="lyr-seg" role="radiogroup" aria-label={t('lyrics.tabImport')}>
        {IMPORT_KINDS.map((k) => (
          <label
            key={k.key}
            className={`lyr-seg__item${kind === k.key ? ' lyr-seg__item--active' : ''}`}
            title={t(k.title)}
          >
            <input
              type="radio"
              name="lyr-import-kind"
              checked={kind === k.key}
              disabled={disabled}
              onChange={() => onKind(k.key)}
            />
            {t(k.label)}
          </label>
        ))}
      </div>

      <div
        className={`lyr-drop${dragActive ? ' lyr-drop--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <textarea
          value={content}
          disabled={disabled}
          placeholder={t('lyrics.contentPlaceholder')}
          onChange={(e) => {
            onContent(e.target.value)
            setFileName(null)
          }}
        />
        <div className="lyr-row">
          <button type="button" className="small ghost" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
            <FolderOpenOutlined /> {t('lyrics.chooseFile')}
          </button>
          <button type="button" className="small ghost" disabled={disabled} onClick={() => void handlePaste()}>
            <SnippetsOutlined /> {t('lyrics.pasteClipboard')}
          </button>
          {content && (
            <button
              type="button"
              className="small ghost"
              disabled={disabled}
              onClick={() => {
                onContent('')
                setFileName(null)
              }}
            >
              {t('lyrics.clear')}
            </button>
          )}
        </div>
        {fileName && (
          <span className="hint">
            <FileTextOutlined /> {t('lyrics.loadedFile', { name: fileName })}
          </span>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.lrc,.qrc,.krc,.xml"
          style={{ display: 'none' }}
          onChange={handleFileInputChange}
        />
      </div>

      {fileError && <div className="error">{fileError}</div>}

      <div className="lyr-seg" role="radiogroup" aria-label={t('lyrics.modeReplace')}>
        <label className={`lyr-seg__item${replace ? ' lyr-seg__item--active' : ''}`}>
          <input type="radio" name="lyr-import-mode" checked={replace} disabled={disabled} onChange={() => onReplace(true)} />
          {t('lyrics.modeReplace')}
        </label>
        <label className={`lyr-seg__item${!replace ? ' lyr-seg__item--active' : ''}`}>
          <input type="radio" name="lyr-import-mode" checked={!replace} disabled={disabled} onChange={() => onReplace(false)} />
          {t('lyrics.modeAppend')}
        </label>
      </div>
    </div>
  )
}
