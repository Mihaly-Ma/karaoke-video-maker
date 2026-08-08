/**
 * 歌词面板：搜索 + 手工导入两个标签页。
 *
 * 产品定位（CLAUDE.md §2.5 / §5.2）：搜索是日常主路径，手工导入是保证
 * 通用性的兜底——冷门曲、同人曲任何歌词库都可能查不到，所以导入不是
 * "搜索失败后的惩罚性回退"，是并列的一等入口，随时可用（两个标签页同时
 * 挂载，只用 CSS 切换显隐，切标签不会丢失另一边正在编辑的内容）。
 *
 * "系统只排序、不替用户裁决"：候选列表按后端 Resolver 打分顺序展示，
 * 前端不做二次排序/自动选中，应用前必须先预览。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { applyLyrics, history as fetchProjectHistory, previewLyrics, searchLyrics } from '../api/client'
import type { LyricCandidate, LyricPreview } from '../api/types'
import { useProject } from '../state/projectStore'
import LyricCandidateList, { candidateKey, formatDuration, providerLabel } from './LyricCandidateList'
import LyricImport from './LyricImport'

// 视频标题里常见的、与曲目本身无关的类型标签，整段剥离
// 注意 `Video` 单独放在最后一个可选分支：正则按顺序匹配，
// 遇到「Music Video」「Lyric Video」时会先整体命中更具体的写法，
// 落单的「(Official Video)」这类最常见写法也不会漏网
const NOISE_WORDS_RE =
  /\b(Official\s*)?(Music\s*Video|Lyric[s]?\s*Video|Video|MV|PV|Visualizer|Teaser|Trailer|Audio|Short\s*Ver\.?|Full\s*Ver\.?|Live|Remix|4K|HD|HQ)\b/gi

/**
 * 从视频标题（+已知歌手）清洗出适合去歌词源检索的初始搜索词。
 *
 * 只是**建议值**：视频标题常是 `sumika『赤春花 (feat. 幾田りら)』Music Video`
 * 这种形式，直接拿去搜大概率零结果；但清洗结果必须保持完全可编辑——
 * 日语曲经常需要换写法（日文原名 / 罗马字 / 中文译名）重搜。
 */
export function buildInitialQuery(title: string, artist: string): string {
  let s = title.trim()

  // 先剥掉「只包含噪声词」的整个括号，如「(Official Music Video)」「【MV】」，
  // 避免连同括号里可能有意义的内容（如 feat.）一并误删
  const bracketPairs: [RegExp, RegExp][] = [
    [/\(([^()]*)\)/g, NOISE_WORDS_RE],
    [/\[([^[\]]*)\]/g, NOISE_WORDS_RE],
    [/【([^【】]*)】/g, NOISE_WORDS_RE],
  ]
  for (const [bracketRe, wordRe] of bracketPairs) {
    s = s.replace(bracketRe, (whole, inner: string) => {
      wordRe.lastIndex = 0
      return wordRe.test(inner) ? '' : whole
    })
  }

  // 再去掉裸露（未加括号）的噪声词
  s = s.replace(NOISE_WORDS_RE, '')

  // 日式书名号只是强调符号，曲名信息在里面，剥符号保留内容；
  // 换成空格而不是直接删掉，避免相邻的罗马字与假名/汉字挤在一起变成一个词
  s = s.replace(/[『』「」]/g, ' ')

  // 清掉噪声词删除后残留的空括号
  s = s.replace(/\(\s*\)|\[\s*\]|【\s*】/g, '')

  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[-|·,，、\s]+|[-|·,，、\s]+$/g, '')

  if (!s) s = title.trim()
  if (artist && !s.includes(artist)) s = `${artist} ${s}`.trim()
  return s
}

type TabKey = 'search' | 'import'

export default function LyricPanel() {
  const project = useProject((s) => s.project)

  const [activeTab, setActiveTab] = useState<TabKey>('search')

  // ---- 搜索 ----
  const [query, setQuery] = useState('')
  const autoFilledProjectId = useRef<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({})
  const [warningsOpen, setWarningsOpen] = useState(false)

  // ---- 预览 ----
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [previewLoadingKey, setPreviewLoadingKey] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, LyricPreview>>({})
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({})

  // ---- 应用 ----
  const [applyingKey, setApplyingKey] = useState<string | null>(null)
  const [appliedKey, setAppliedKey] = useState<string | null>(null)
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({})

  // 搜索词初始值只在"切换到一个新工程"时自动填一次，之后用户怎么改都不会被覆盖
  useEffect(() => {
    if (!project) return
    if (autoFilledProjectId.current === project.id) return
    autoFilledProjectId.current = project.id
    setQuery((cur) => (cur ? cur : buildInitialQuery(project.title, project.artist)))
  }, [project])

  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setSearchError('请输入搜索词')
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const resp = await searchLyrics(q, project && project.duration_ms > 0 ? project.duration_ms : undefined)
      setCandidates(resp.candidates)
      setProviderErrors(resp.errors)
      setHasSearched(true)
      // 换关键词重搜后，旧结果的预览/应用状态不再对应当前候选，清空避免误导
      setExpandedKey(null)
      setPreviews({})
      setPreviewErrors({})
      setAppliedKey(null)
      setApplyErrors({})
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }, [query, project])

  const handleTogglePreview = useCallback(
    (candidate: LyricCandidate) => {
      const key = candidateKey(candidate)
      setExpandedKey((cur) => (cur === key ? null : key))
      if (previews[key] || previewLoadingKey === key) return
      setPreviewLoadingKey(key)
      previewLyrics(candidate.provider, candidate.song_id)
        .then((data) => {
          setPreviews((m) => ({ ...m, [key]: data }))
          setPreviewErrors((m) => {
            if (!(key in m)) return m
            const next = { ...m }
            delete next[key]
            return next
          })
        })
        .catch((e) => {
          setPreviewErrors((m) => ({ ...m, [key]: e instanceof Error ? e.message : String(e) }))
        })
        .finally(() => setPreviewLoadingKey((cur) => (cur === key ? null : cur)))
    },
    [previews, previewLoadingKey],
  )

  const handleApply = useCallback(
    async (candidate: LyricCandidate) => {
      if (!project) return
      const key = candidateKey(candidate)
      setApplyingKey(key)
      setApplyErrors((m) => {
        if (!(key in m)) return m
        const next = { ...m }
        delete next[key]
        return next
      })
      try {
        const updated = await applyLyrics(project.id, candidate.provider, candidate.song_id)
        useProject.setState({ project: updated, error: null })
        try {
          const h = await fetchProjectHistory(updated.id)
          useProject.setState({ canUndo: h.undo > 0, canRedo: h.redo > 0 })
        } catch {
          /* 历史状态刷新失败不影响已完成的应用操作 */
        }
        setAppliedKey(key)
      } catch (e) {
        setApplyErrors((m) => ({ ...m, [key]: e instanceof Error ? e.message : String(e) }))
      } finally {
        setApplyingKey((cur) => (cur === key ? null : cur))
      }
    },
    [project],
  )

  const providerErrorEntries = Object.entries(providerErrors)

  return (
    <div className="kvm-lyric-panel">
      <style>{PANEL_CSS}</style>

      <div className="kvm-lyric-tabs" role="tablist" aria-label="歌词获取方式">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'search'}
          className={`kvm-lyric-tab ${activeTab === 'search' ? 'kvm-lyric-tab--active' : ''}`}
          onClick={() => setActiveTab('search')}
        >
          搜索歌词
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'import'}
          className={`kvm-lyric-tab ${activeTab === 'import' ? 'kvm-lyric-tab--active' : ''}`}
          onClick={() => setActiveTab('import')}
        >
          手工导入
        </button>
      </div>

      {/* 两个标签页始终挂载，只切显隐——切换标签不会丢内容，也呼应"两者都是核心入口"的定位 */}
      <section className="kvm-lyric-search" style={{ display: activeTab === 'search' ? undefined : 'none' }}>
        <form
          className="kvm-lyric-search-bar"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch()
          }}
        >
          <input
            type="text"
            className="kvm-lyric-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入曲名 / 歌手，日语曲可换日文原名、罗马字或中文译名再搜"
          />
          <button type="submit" className="kvm-lyric-btn kvm-lyric-btn--primary" disabled={searching}>
            {searching ? '搜索中…' : '搜索'}
          </button>
          {project && (
            <button
              type="button"
              className="kvm-lyric-btn kvm-lyric-btn--ghost"
              title="用当前工程标题重新生成清洗后的建议搜索词"
              onClick={() => setQuery(buildInitialQuery(project.title, project.artist))}
            >
              使用建议词
            </button>
          )}
        </form>

        <p className="kvm-lyric-hint">
          {project
            ? `视频时长 ${project.duration_ms > 0 ? formatDuration(project.duration_ms) : '未知'}，候选列表会据此提示时长明显不符（可能是 live / remix 版本）的结果。`
            : '尚未加载工程，搜索结果可以预览，但暂时无法应用。'}
        </p>

        {searchError && <div className="kvm-lyric-error">{searchError}</div>}

        {providerErrorEntries.length > 0 && (
          <div className="kvm-lyric-provider-warnings">
            <button
              type="button"
              className="kvm-lyric-provider-warnings-toggle"
              onClick={() => setWarningsOpen((v) => !v)}
            >
              {warningsOpen ? '▾' : '▸'} {providerErrorEntries.length} 个歌词源未返回结果（不影响其余结果）
            </button>
            {warningsOpen && (
              <ul className="kvm-lyric-provider-warnings-list">
                {providerErrorEntries.map(([provider, msg]) => (
                  <li key={provider}>
                    <strong>{providerLabel(provider)}</strong>：{msg}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {searching && <div className="kvm-lyric-loading">搜索中…</div>}

        {!searching && hasSearched && (
          <LyricCandidateList
            candidates={candidates}
            videoDurationMs={project?.duration_ms ?? 0}
            canApply={Boolean(project)}
            expandedKey={expandedKey}
            previewLoadingKey={previewLoadingKey}
            previewErrors={previewErrors}
            previews={previews}
            applyingKey={applyingKey}
            appliedKey={appliedKey}
            applyErrors={applyErrors}
            onTogglePreview={handleTogglePreview}
            onApply={handleApply}
          />
        )}

        {!hasSearched && !searching && (
          <div className="kvm-lyric-empty">
            还没有搜索。日语冷门曲、同人曲经常在任何歌词库都查不到——如果搜索一无所获，
            切到“手工导入”标签直接粘贴或拖入歌词文件，同样能继续后面的流程。
          </div>
        )}
      </section>

      <section style={{ display: activeTab === 'import' ? undefined : 'none' }}>
        <LyricImport />
      </section>
    </div>
  )
}

const PANEL_CSS = `
.kvm-lyric-panel {
  --kvm-lp-bg: #ffffff;
  --kvm-lp-bg-subtle: #f6f7f9;
  --kvm-lp-border: #e2e4e9;
  --kvm-lp-text: #1a1c20;
  --kvm-lp-text-muted: #6b7280;
  --kvm-lp-accent: #2f6fed;
  --kvm-lp-accent-contrast: #ffffff;
  --kvm-lp-good: #1a7f4b;
  --kvm-lp-good-bg: #e6f6ec;
  --kvm-lp-mid: #9a6b00;
  --kvm-lp-mid-bg: #fbf0d9;
  --kvm-lp-bad: #b23b3b;
  --kvm-lp-bad-bg: #fbe8e8;
  --kvm-lp-info: #5b3fb8;
  --kvm-lp-info-bg: #efe9fb;
  --kvm-lp-warn-bg: #fff1e0;
  --kvm-lp-warn: #a35a00;
  color: var(--kvm-lp-text);
  background: var(--kvm-lp-bg);
  border: 1px solid var(--kvm-lp-border);
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  max-width: 100%;
  box-sizing: border-box;
}
@media (prefers-color-scheme: dark) {
  .kvm-lyric-panel {
    --kvm-lp-bg: #17181c;
    --kvm-lp-bg-subtle: #1f2126;
    --kvm-lp-border: #2c2f36;
    --kvm-lp-text: #e7e8ea;
    --kvm-lp-text-muted: #9aa0aa;
    --kvm-lp-accent: #5b8cff;
    --kvm-lp-accent-contrast: #0b1020;
    --kvm-lp-good: #63d391;
    --kvm-lp-good-bg: #16301f;
    --kvm-lp-mid: #e5b849;
    --kvm-lp-mid-bg: #362b0c;
    --kvm-lp-bad: #ef8080;
    --kvm-lp-bad-bg: #3a1c1c;
    --kvm-lp-info: #b6a4f2;
    --kvm-lp-info-bg: #2a2140;
    --kvm-lp-warn-bg: #3a2a0f;
    --kvm-lp-warn: #f0b15e;
  }
}
.kvm-lyric-panel * { box-sizing: border-box; }

.kvm-lyric-tabs { display: flex; gap: 4px; padding: 8px 8px 0; border-bottom: 1px solid var(--kvm-lp-border); }
.kvm-lyric-tab {
  appearance: none; border: none; background: transparent; cursor: pointer;
  padding: 8px 14px; font-size: 13px; font-weight: 600; color: var(--kvm-lp-text-muted);
  border-radius: 8px 8px 0 0;
}
.kvm-lyric-tab:hover { color: var(--kvm-lp-text); background: var(--kvm-lp-bg-subtle); }
.kvm-lyric-tab--active { color: var(--kvm-lp-accent); box-shadow: inset 0 -2px 0 var(--kvm-lp-accent); }

.kvm-lyric-search, .kvm-lyric-import { padding: 14px; display: flex; flex-direction: column; gap: 10px; }

.kvm-lyric-search-bar { display: flex; gap: 8px; flex-wrap: wrap; }
.kvm-lyric-search-input {
  flex: 1 1 220px; min-width: 0; padding: 8px 10px; border: 1px solid var(--kvm-lp-border);
  border-radius: 8px; background: var(--kvm-lp-bg); color: var(--kvm-lp-text); font-size: 13px;
}
.kvm-lyric-search-input:focus { outline: 2px solid var(--kvm-lp-accent); outline-offset: -1px; }

.kvm-lyric-btn {
  appearance: none; border: 1px solid var(--kvm-lp-border); border-radius: 8px; cursor: pointer;
  padding: 8px 14px; font-size: 13px; font-weight: 600; background: var(--kvm-lp-bg-subtle); color: var(--kvm-lp-text);
  white-space: nowrap;
}
.kvm-lyric-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.kvm-lyric-btn--primary { background: var(--kvm-lp-accent); border-color: var(--kvm-lp-accent); color: var(--kvm-lp-accent-contrast); }
.kvm-lyric-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
.kvm-lyric-btn--ghost { background: transparent; }
.kvm-lyric-btn--ghost:hover:not(:disabled) { background: var(--kvm-lp-bg-subtle); }

.kvm-lyric-hint { margin: 0; color: var(--kvm-lp-text-muted); font-size: 12px; }
.kvm-lyric-error { color: var(--kvm-lp-bad); background: var(--kvm-lp-bad-bg); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; }
.kvm-lyric-success { color: var(--kvm-lp-good); background: var(--kvm-lp-good-bg); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; }
.kvm-lyric-loading { color: var(--kvm-lp-text-muted); font-size: 12.5px; padding: 4px 0; }
.kvm-lyric-empty { color: var(--kvm-lp-text-muted); font-size: 12.5px; padding: 14px; text-align: center; background: var(--kvm-lp-bg-subtle); border-radius: 8px; }

.kvm-lyric-provider-warnings { border: 1px solid var(--kvm-lp-warn-bg); background: var(--kvm-lp-warn-bg); border-radius: 8px; padding: 2px 4px; }
.kvm-lyric-provider-warnings-toggle {
  appearance: none; border: none; background: transparent; cursor: pointer; width: 100%; text-align: left;
  padding: 6px 8px; font-size: 12.5px; color: var(--kvm-lp-warn); font-weight: 600;
}
.kvm-lyric-provider-warnings-list { margin: 0; padding: 4px 12px 8px 22px; font-size: 12px; color: var(--kvm-lp-text); }
.kvm-lyric-provider-warnings-list li { margin: 2px 0; }

.kvm-lyric-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.kvm-lyric-candidate { border: 1px solid var(--kvm-lp-border); border-radius: 10px; padding: 10px 12px; background: var(--kvm-lp-bg); display: flex; flex-direction: column; gap: 6px; }

.kvm-lyric-candidate-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kvm-lyric-rank-pill { background: var(--kvm-lp-accent); color: var(--kvm-lp-accent-contrast); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
.kvm-lyric-duration { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--kvm-lp-text-muted); font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; }

.kvm-lyric-badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; line-height: 1.6; }
.kvm-lyric-badge--good { background: var(--kvm-lp-good-bg); color: var(--kvm-lp-good); }
.kvm-lyric-badge--mid { background: var(--kvm-lp-mid-bg); color: var(--kvm-lp-mid); }
.kvm-lyric-badge--bad { background: var(--kvm-lp-bad-bg); color: var(--kvm-lp-bad); }
.kvm-lyric-badge--info { background: var(--kvm-lp-info-bg); color: var(--kvm-lp-info); }
.kvm-lyric-badge--warn { background: var(--kvm-lp-warn-bg); color: var(--kvm-lp-warn); }
.kvm-lyric-badge--muted { background: var(--kvm-lp-bg-subtle); color: var(--kvm-lp-text-muted); }

.kvm-lyric-title-line { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.kvm-lyric-title-line strong { font-size: 14px; }
.kvm-lyric-provider { font-size: 11.5px; color: var(--kvm-lp-text-muted); background: var(--kvm-lp-bg-subtle); padding: 1px 6px; border-radius: 6px; }
.kvm-lyric-meta-row { display: flex; gap: 14px; flex-wrap: wrap; color: var(--kvm-lp-text-muted); font-size: 12px; }
.kvm-lyric-note { font-size: 12px; color: var(--kvm-lp-warn); }

.kvm-lyric-actions { display: flex; gap: 8px; }

.kvm-lyric-preview-panel { margin-top: 4px; padding: 10px; border-radius: 8px; background: var(--kvm-lp-bg-subtle); display: flex; flex-direction: column; gap: 8px; }
.kvm-lyric-preview-lines { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.kvm-lyric-preview-line { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; padding: 2px 0; border-bottom: 1px dashed var(--kvm-lp-border); }
.kvm-lyric-preview-time { font-variant-numeric: tabular-nums; color: var(--kvm-lp-text-muted); flex: 0 0 auto; }
.kvm-lyric-preview-text { flex: 1 1 auto; word-break: break-word; }
.kvm-lyric-preview-more { color: var(--kvm-lp-text-muted); font-style: italic; }
.kvm-lyric-raw summary { cursor: pointer; font-size: 12px; color: var(--kvm-lp-text-muted); }
.kvm-lyric-raw pre { white-space: pre-wrap; word-break: break-word; font-size: 11.5px; background: var(--kvm-lp-bg); border: 1px solid var(--kvm-lp-border); border-radius: 6px; padding: 8px; max-height: 200px; overflow: auto; }

.kvm-lyric-radio-group { display: flex; gap: 8px; flex-wrap: wrap; }
.kvm-lyric-radio {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--kvm-lp-border);
  border-radius: 999px; font-size: 12.5px; cursor: pointer; color: var(--kvm-lp-text-muted);
}
.kvm-lyric-radio--active { color: var(--kvm-lp-accent); border-color: var(--kvm-lp-accent); background: var(--kvm-lp-info-bg); }
.kvm-lyric-radio input { accent-color: var(--kvm-lp-accent); }

.kvm-lyric-dropzone { border: 1.5px dashed var(--kvm-lp-border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.15s, background 0.15s; }
.kvm-lyric-dropzone--active { border-color: var(--kvm-lp-accent); background: var(--kvm-lp-info-bg); }
.kvm-lyric-textarea {
  width: 100%; resize: vertical; min-height: 160px; padding: 10px; border: 1px solid var(--kvm-lp-border);
  border-radius: 8px; background: var(--kvm-lp-bg); color: var(--kvm-lp-text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px;
}
.kvm-lyric-textarea:focus { outline: 2px solid var(--kvm-lp-accent); outline-offset: -1px; }
.kvm-lyric-dropzone-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kvm-lyric-filename { font-size: 12px; color: var(--kvm-lp-text-muted); }

.kvm-lyric-import-preview { border: 1px solid var(--kvm-lp-border); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; background: var(--kvm-lp-bg-subtle); }
`
