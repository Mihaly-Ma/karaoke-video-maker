/**
 * 「歌词」舞台。
 *
 * 形态是**候选列表（窄）+ 成片样式大预览（宽）+ 底部元信息栏**
 * （docs/ui-redesign.md §四）。这样排的理由只有一条：判断候选对不对，看的是
 * 歌词内容本身。同名不同版本的差异往往出现在中后段（CLAUDE.md §6.1
 * 「版本混淆是头号坑」：`赤春花` 的 2025 原版在 QQ 上署名的是企划名而不是 sumika），
 * 纯文本候选列表看不出来，按成片样式整首渲染才能一眼认出。
 *
 * 舞台有两个态：
 * - **选源态**：搜索或导入，选中即在中间大区域预览，确认后写入工程
 * - **全文编辑态**（工程已有歌词）：同一个渲染器，加上拆行/并行。
 *   分行是歌词步骤的正当归属，不该藏在别处——官方分行 ≠ 演唱断句，
 *   更 ≠ nicokara 一屏两行（CLAUDE.md §6.1）
 *
 * 搜索与导入是**并列的两个一等入口**（CLAUDE.md §2.5），不是"主路径 + 惩罚性回退"。
 *
 * 写工程一律走 store 的 action（`applyLyrics` / `importLyrics` / `splitLine` /
 * `mergeLine`）。旧实现绕过 store 直接 `useProject.setState({ project, error, canUndo… })`，
 * 等于在状态层之外开了第二条写入路径：撤销栈刷新、错误清理、并发中的旧响应覆盖新状态
 * 这些约束全得在调用点各写一遍，写漏一处就是难查的状态不一致。
 */

import {
  CheckOutlined,
  DownOutlined,
  ImportOutlined,
  RightOutlined,
  SearchOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { previewLyrics, searchLyrics } from '../api/client'
import type { LyricCandidate, LyricPreview } from '../api/types'
import { t } from '../i18n'
import { useProject } from '../state/projectStore'
import LyricCandidateList, { candidateKey, normalizeGranularity } from './LyricCandidateList'
import LyricImport, { parseImportDraft, type ImportKind } from './LyricImport'
import LyricMetaBar from './LyricMetaBar'
import LyricScript, { toScriptLines } from './LyricScript'
import { LYRIC_STAGE_CSS } from './LyricStageCss'

// 视频标题里常见的、与曲目本身无关的类型标签，整段剥离。
// `Video` 单独放在最后一个可选分支：正则按顺序匹配，遇到「Music Video」「Lyric Video」
// 时会先整体命中更具体的写法，落单的「(Official Video)」也不会漏网。
const NOISE_WORDS_RE =
  /\b(Official\s*)?(Music\s*Video|Lyric[s]?\s*Video|Video|MV|PV|Visualizer|Teaser|Trailer|Audio|Short\s*Ver\.?|Full\s*Ver\.?|Live|Remix|4K|HD|HQ)\b/gi

/**
 * 从视频标题（+已知歌手）清洗出适合去歌词源检索的初始搜索词。
 *
 * 只是**建议值**：视频标题常是 `sumika『赤春花 (feat. 幾田りら)』Music Video` 这种形式，
 * 直接拿去搜大概率零结果；但清洗结果必须保持完全可编辑——日语曲经常要换写法
 * （日文原名 / 罗马字 / 中文译名）重搜。
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

  s = s.replace(NOISE_WORDS_RE, '')
  // 日式书名号只是强调符号，曲名信息在里面：剥符号保留内容，换成空格而不是删掉，
  // 免得相邻的罗马字与假名挤成一个词
  s = s.replace(/[『』「」]/g, ' ')
  s = s.replace(/\(\s*\)|\[\s*\]|【\s*】/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[-|·,，、\s]+|[-|·,，、\s]+$/g, '')

  if (!s) s = title.trim()
  if (artist && !s.includes(artist)) s = `${artist} ${s}`.trim()
  return s
}

type SourceTab = 'search' | 'import'

export default function LyricPanel() {
  const project = useProject((s) => s.project)
  const applyLyricsAction = useProject((s) => s.applyLyrics)
  const importLyricsAction = useProject((s) => s.importLyrics)
  const splitLineAction = useProject((s) => s.splitLine)
  const mergeLineAction = useProject((s) => s.mergeLine)

  const [tab, setTab] = useState<SourceTab>('search')
  // null = 跟随工程有没有歌词；用户点了「换歌词」之后由它接管
  const [forcedView, setForcedView] = useState<'source' | 'script' | null>(null)

  // ---- 搜索 ----
  const [query, setQuery] = useState('')
  const autoFilledProjectId = useRef<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({})
  const [errorsOpen, setErrorsOpen] = useState(false)

  // ---- 预览 ----
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, LyricPreview>>({})
  const [previewLoadingKey, setPreviewLoadingKey] = useState<string | null>(null)
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({})

  // ---- 导入草稿 ----
  const [kind, setKind] = useState<ImportKind>('text')
  const [content, setContent] = useState('')
  const [replace, setReplace] = useState(true)

  // ---- 写工程 ----
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyLineId, setBusyLineId] = useState<string | null>(null)

  const hasLines = (project?.lines.length ?? 0) > 0
  const view = forcedView ?? (hasLines ? 'script' : 'source')

  // 搜索词只在"切到一个新工程"时自动填一次，之后用户怎么改都不会被覆盖
  useEffect(() => {
    if (!project) return
    if (autoFilledProjectId.current === project.id) return
    autoFilledProjectId.current = project.id
    setForcedView(null)
    setQuery((cur) => (cur ? cur : buildInitialQuery(project.title, project.artist)))
  }, [project])

  const loadPreview = useCallback(
    (candidate: LyricCandidate) => {
      const key = candidateKey(candidate)
      setSelectedKey(key)
      setActionError(null)
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
        .catch((e) => setPreviewErrors((m) => ({ ...m, [key]: e instanceof Error ? e.message : String(e) })))
        .finally(() => setPreviewLoadingKey((cur) => (cur === key ? null : cur)))
    },
    [previews, previewLoadingKey],
  )

  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setSearchError(t('lyrics.emptyQuery'))
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const resp = await searchLyrics(q, project && project.duration_ms > 0 ? project.duration_ms : undefined)
      setCandidates(resp.candidates)
      setProviderErrors(resp.errors)
      setHasSearched(true)
      // 预览缓存按 `provider::song_id` 存，换关键词重搜后仍然一一对应，留着可以省一次往返；
      // 真正必须清掉的是"当前选中的是哪条"。失败记录清掉，好让重搜后能再试一次。
      setPreviewErrors({})
      setSelectedKey(null)
      setActionError(null)
      // 自动预览打分最高的一条。这不是替用户裁决——写入工程仍要显式点「使用」，
      // 而让最大的一块屏幕一开始就摆着空白，恰恰是这次重做要消灭的东西。
      if (resp.candidates.length > 0) loadPreview(resp.candidates[0])
    } catch (e) {
      setSearchError(t('lyrics.searchFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSearching(false)
    }
  }, [query, project, loadPreview])

  /**
   * 跑一个会改工程的 store action，并判断它到底成没成功。
   *
   * store 的 action 把异常吞进 `error` 字段（由顶栏统一显示）且不 reject，
   * 所以这里用**工程对象是否被换掉**判断成败：成功时 store 会 set 一个新的
   * project 对象，失败时只写 error。比对字符串或时间戳都不如比对身份可靠。
   */
  const runMutation = useCallback(async (failKey: string, fn: () => Promise<void>): Promise<boolean> => {
    const before = useProject.getState().project
    await fn()
    const after = useProject.getState()
    if (after.project === before) {
      setActionError(t(failKey, { msg: after.error || t('common.failed') }))
      return false
    }
    setActionError(null)
    return true
  }, [])

  const selected = useMemo(
    () => candidates.find((c) => candidateKey(c) === selectedKey) ?? null,
    [candidates, selectedKey],
  )
  const preview = selectedKey ? previews[selectedKey] : undefined
  const previewError = selectedKey ? previewErrors[selectedKey] : undefined

  const handleApply = useCallback(async () => {
    if (!project || !selected) return
    setBusy(true)
    const ok = await runMutation('lyrics.applyFailed', () =>
      applyLyricsAction(selected.provider, selected.song_id),
    )
    setBusy(false)
    if (ok) setForcedView('script')
  }, [project, selected, applyLyricsAction, runMutation])

  const handleImport = useCallback(async () => {
    if (!project || !content.trim()) return
    setBusy(true)
    const ok = await runMutation('lyrics.importFailed', () => importLyricsAction(kind, content, replace))
    setBusy(false)
    if (ok) setForcedView('script')
  }, [project, content, kind, replace, importLyricsAction, runMutation])

  const handleSplit = useCallback(
    async (lineId: string, tokenIndex: number) => {
      setBusyLineId(lineId)
      await runMutation('lyrics.editFailed', () => splitLineAction(lineId, tokenIndex))
      setBusyLineId(null)
    },
    [splitLineAction, runMutation],
  )

  const handleMerge = useCallback(
    async (lineId: string) => {
      setBusyLineId(lineId)
      await runMutation('lyrics.editFailed', () => mergeLineAction(lineId))
      setBusyLineId(null)
    },
    [mergeLineAction, runMutation],
  )

  const draft = useMemo(() => parseImportDraft(kind, content), [kind, content])
  const draftGranularity = kind === 'qrc' ? 'word' : kind === 'lrc' ? 'line' : 'plain'
  const videoDurationMs = project?.duration_ms ?? 0
  const style = project?.style ?? null
  const palettes = project?.palettes ?? {}
  const providerErrorEntries = Object.entries(providerErrors)

  // ---- 全文编辑态：工程已有歌词 ----
  if (view === 'script' && project) {
    return (
      <div className="lyr-stage">
        <style>{LYRIC_STAGE_CSS}</style>
        <div className="lyr-main">
          <div className="lyr-bar">
            <span>{t('lyrics.script')}</span>
            <span className="num">{t('lyrics.lineCount', { n: project.lines.length })}</span>
            <span>·</span>
            <span>{t('lyrics.editHint')}</span>
            <span className="lyr-bar__spacer" />
            {actionError && <span className="error">{actionError}</span>}
            <button type="button" className="small ghost" onClick={() => setForcedView('source')}>
              <SwapOutlined /> {t('lyrics.changeSource')}
            </button>
          </div>
          {project.lines.length > 0 ? (
            <LyricScript
              lines={toScriptLines(project.lines)}
              style={style}
              palettes={palettes}
              editable
              busyLineId={busyLineId}
              onSplit={(id, idx) => void handleSplit(id, idx)}
              onMerge={(id) => void handleMerge(id)}
            />
          ) : (
            <div className="lyr-blank">{t('lyrics.noLines')}</div>
          )}
        </div>
      </div>
    )
  }

  // ---- 选源态 ----
  const searchDraftLines = preview ? toScriptLines(preview.lines) : []

  return (
    <div className="lyr-stage">
      <style>{LYRIC_STAGE_CSS}</style>
      <div className="lyr-body">
        <aside className="lyr-side">
          {/* 搜索与导入等宽并列：手工旁路随时可主动使用，不是失败后的降级（§2.5） */}
          <div className="lyr-tabs" role="tablist" aria-label={t('lyrics.script')}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'search'}
              className={`lyr-tab${tab === 'search' ? ' lyr-tab--active' : ''}`}
              onClick={() => setTab('search')}
            >
              <SearchOutlined /> {t('lyrics.tabSearch')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'import'}
              className={`lyr-tab${tab === 'import' ? ' lyr-tab--active' : ''}`}
              onClick={() => setTab('import')}
            >
              <ImportOutlined /> {t('lyrics.tabImport')}
            </button>
          </div>

          {tab === 'search' ? (
            <>
              <form
                className="lyr-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void runSearch()
                }}
              >
                <div className="lyr-row lyr-row--grow">
                  <input
                    type="search"
                    value={query}
                    placeholder={t('lyrics.queryPlaceholder')}
                    aria-label={t('lyrics.tabSearch')}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button type="submit" className="primary" disabled={searching}>
                    {searching ? t('lyrics.searching') : t('lyrics.search')}
                  </button>
                </div>
                {project && (
                  <div className="lyr-row">
                    <button
                      type="button"
                      className="small ghost"
                      title={t('lyrics.suggestQueryTitle')}
                      onClick={() => setQuery(buildInitialQuery(project.title, project.artist))}
                    >
                      {t('lyrics.suggestQuery')}
                    </button>
                  </div>
                )}
                {searchError && <div className="error">{searchError}</div>}
              </form>

              {providerErrorEntries.length > 0 && (
                <div className="lyr-fold">
                  <button type="button" className="lyr-fold__head" onClick={() => setErrorsOpen((v) => !v)}>
                    {errorsOpen ? <DownOutlined /> : <RightOutlined />}
                    <WarningOutlined />
                    {t('lyrics.providerErrors', { n: providerErrorEntries.length })}
                  </button>
                  {errorsOpen && (
                    <ul className="lyr-fold__body">
                      {providerErrorEntries.map(([name, msg]) => (
                        <li key={name}>
                          {name}：{msg}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {hasSearched ? (
                <LyricCandidateList
                  candidates={candidates}
                  videoDurationMs={videoDurationMs}
                  selectedKey={selectedKey}
                  onSelect={loadPreview}
                />
              ) : (
                <div className="lyr-note">{t('lyrics.beforeSearch')}</div>
              )}
            </>
          ) : (
            <div className="lyr-side__scroll">
              <LyricImport
                kind={kind}
                onKind={setKind}
                content={content}
                onContent={setContent}
                replace={replace}
                onReplace={setReplace}
                disabled={busy}
              />
            </div>
          )}
        </aside>

        <div className="lyr-main">
          {tab === 'search' ? (
            <>
              {previewError ? (
                <div className="lyr-blank error">{t('lyrics.previewFailed', { msg: previewError })}</div>
              ) : previewLoadingKey && previewLoadingKey === selectedKey ? (
                <div className="lyr-blank">{t('lyrics.loadingPreview')}</div>
              ) : preview ? (
                searchDraftLines.length > 0 ? (
                  <LyricScript lines={searchDraftLines} style={style} palettes={palettes} />
                ) : (
                  <div className="lyr-blank">{t('lyrics.emptyLyric')}</div>
                )
              ) : (
                <div className="lyr-blank">{t('lyrics.pickCandidate')}</div>
              )}

              <LyricMetaBar
                lineCount={preview?.lines.length ?? 0}
                granularity={preview ? normalizeGranularity(preview.granularity) : null}
                hasRuby={preview ? preview.has_ruby : null}
                durationMs={selected?.duration_ms ?? null}
                videoDurationMs={videoDurationMs}
                extra={actionError ? <span className="error">{actionError}</span> : undefined}
              >
                <button
                  type="button"
                  className="primary"
                  disabled={!project || !preview || busy}
                  title={!project ? t('common.selectProjectFirst') : undefined}
                  onClick={() => void handleApply()}
                >
                  <CheckOutlined /> {t('common.use')}
                </button>
              </LyricMetaBar>
            </>
          ) : (
            <>
              {draft.lines.length > 0 ? (
                <LyricScript lines={draft.lines} style={style} palettes={palettes} />
              ) : (
                <div className="lyr-blank">{t('lyrics.beforePaste')}</div>
              )}

              <LyricMetaBar
                lineCount={draft.lines.length}
                granularity={draftGranularity}
                hasRuby={draft.hasKanaTrack}
                durationMs={null}
                videoDurationMs={videoDurationMs}
                extra={
                  <>
                    {draft.unrecognized > 0 && (
                      <span className="badge lyr-tag--warn">
                        {t('lyrics.unrecognized', { n: draft.unrecognized })}
                      </span>
                    )}
                    {draft.hasKanaTrack && <span className="badge lyr-tag--provider">{t('lyrics.kanaTrack')}</span>}
                    {draft.lines.length > 0 && <span className="muted">{t('lyrics.parsePending')}</span>}
                    {actionError && <span className="error">{actionError}</span>}
                  </>
                }
              >
                <button
                  type="button"
                  className="primary"
                  disabled={!project || !content.trim() || busy}
                  title={!project ? t('common.selectProjectFirst') : undefined}
                  onClick={() => void handleImport()}
                >
                  <ImportOutlined /> {busy ? t('lyrics.importing') : t('lyrics.import')}
                </button>
              </LyricMetaBar>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
