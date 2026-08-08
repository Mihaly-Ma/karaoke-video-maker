/**
 * 歌词搜索候选列表。
 *
 * 只负责展示与交互回调，不直接调用 API——预览/应用的网络请求与状态
 * 都由 LyricPanel 统一持有，方便切换搜索关键词时整体清空过期状态。
 *
 * 展示重点见 CLAUDE.md §5.2 / §2.5：granularity（决定还要不要手工打轴）、
 * has_ruby（日语曲的关键指标）、duration_ms（识别错配版本）、
 * provider / 歌手 / 专辑（区分原唱与翻唱）都必须显眼可见，
 * 且"系统只排序、不替用户裁决"——始终把候选摆出来，不自动选中。
 */

import type { LyricCandidate, LyricPreview } from '../api/types'

/** 候选项的稳定 key：不同 provider 的 song_id 可能重复，必须带 provider 前缀。 */
export function candidateKey(candidate: LyricCandidate): string {
  return `${candidate.provider}::${candidate.song_id}`
}

const PROVIDER_LABELS: Record<string, string> = {
  qq: 'QQ音乐',
  qqmusic: 'QQ音乐',
  kugou: '酷狗音乐',
  krc: '酷狗音乐',
  netease: '网易云音乐',
  ncm: '网易云音乐',
  youtube: 'YouTube官方字幕',
  yt: 'YouTube官方字幕',
  lrclib: 'LRCLIB',
  utaten: 'UtaTen',
  manual: '手工粘贴',
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider
}

const GRANULARITY_META: Record<LyricCandidate['granularity'], { label: string; tone: string; hint: string }> = {
  word: { label: '逐字', tone: 'good', hint: '已有逐字时间轴，套用后基本不用再手工打轴' },
  line: { label: '句级', tone: 'mid', hint: '只有整句时间，单词/音节仍需手工细化' },
  plain: { label: '纯文本', tone: 'bad', hint: '完全没有时间轴，需要从零 tap-to-time 打轴' },
}

/** 与视频时长比对超过这个阈值就提示"可能是错配版本"，与后端 Resolver 打分阈值保持一致（CLAUDE.md §5.2）。 */
const DURATION_MISMATCH_THRESHOLD_MS = 3000

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '--:--'
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function lineTimeRange(line: LyricPreview['lines'][number]): string {
  if (!line.tokens.length) return ''
  const first = line.tokens[0]
  const last = line.tokens[line.tokens.length - 1]
  return `${formatDuration(first.start_ms)}–${formatDuration(last.start_ms + last.dur_ms)}`
}

export interface LyricCandidateListProps {
  candidates: LyricCandidate[]
  /** 视频时长（毫秒）。0 或缺失表示未知，跳过时长比对而不是误报不符。 */
  videoDurationMs: number
  /** 是否已加载工程——没有工程时只能预览，不能应用。 */
  canApply: boolean
  expandedKey: string | null
  previewLoadingKey: string | null
  previewErrors: Record<string, string>
  previews: Record<string, LyricPreview>
  applyingKey: string | null
  appliedKey: string | null
  applyErrors: Record<string, string>
  onTogglePreview: (candidate: LyricCandidate) => void
  onApply: (candidate: LyricCandidate) => void
}

const PREVIEW_LINE_LIMIT = 30

export default function LyricCandidateList(props: LyricCandidateListProps) {
  const {
    candidates,
    videoDurationMs,
    canApply,
    expandedKey,
    previewLoadingKey,
    previewErrors,
    previews,
    applyingKey,
    appliedKey,
    applyErrors,
    onTogglePreview,
    onApply,
  } = props

  if (candidates.length === 0) {
    return (
      <div className="kvm-lyric-empty">
        没有找到候选结果。冷门曲、同人曲在任何歌词库都可能查不到——
        换个写法（日文原名 / 罗马字 / 中文译名）再搜，或切到“手工导入”标签直接粘贴歌词继续下一步。
      </div>
    )
  }

  return (
    <ul className="kvm-lyric-list">
      {candidates.map((candidate, index) => {
        const key = candidateKey(candidate)
        const gran = GRANULARITY_META[candidate.granularity]
        const expanded = expandedKey === key
        const previewLoading = previewLoadingKey === key
        const previewErr = previewErrors[key]
        const preview = previews[key]
        const applying = applyingKey === key
        const applied = appliedKey === key
        const applyErr = applyErrors[key]
        const hasPreviewed = Boolean(preview)

        const durDiffMs =
          videoDurationMs > 0 && candidate.duration_ms > 0 ? candidate.duration_ms - videoDurationMs : null
        const durMismatch = durDiffMs !== null && Math.abs(durDiffMs) > DURATION_MISMATCH_THRESHOLD_MS

        let applyTitle: string | undefined
        if (!canApply) applyTitle = '尚未加载工程，无法应用'
        else if (!hasPreviewed) applyTitle = '请先预览确认内容再应用'

        return (
          <li key={key} className="kvm-lyric-candidate">
            <div className="kvm-lyric-candidate-header">
              {index === 0 && <span className="kvm-lyric-rank-pill">推荐</span>}
              <span className={`kvm-lyric-badge kvm-lyric-badge--${gran.tone}`} title={gran.hint}>
                {gran.label}
              </span>
              {candidate.has_ruby && (
                <span
                  className="kvm-lyric-badge kvm-lyric-badge--info"
                  title="自带假名读音轨（[kana:] 等），注音编辑能省不少事"
                >
                  含假名注音
                </span>
              )}
              {candidate.has_translation && <span className="kvm-lyric-badge kvm-lyric-badge--muted">含译文</span>}
              <span className="kvm-lyric-duration">
                {formatDuration(candidate.duration_ms)}
                {durMismatch && durDiffMs !== null && (
                  <span
                    className="kvm-lyric-badge kvm-lyric-badge--warn"
                    title="与视频时长差异较大，可能是 live / remix 等错配版本"
                  >
                    {durDiffMs > 0 ? '+' : ''}
                    {Math.round(durDiffMs / 1000)}s 与视频不符
                  </span>
                )}
              </span>
            </div>

            <div className="kvm-lyric-candidate-main">
              <div className="kvm-lyric-title-line">
                <strong>{candidate.title || '（无标题）'}</strong>
                <span className="kvm-lyric-provider">{providerLabel(candidate.provider)}</span>
              </div>
              <div className="kvm-lyric-meta-row">
                {candidate.artist && <span>歌手：{candidate.artist}</span>}
                {candidate.album && <span>专辑：{candidate.album}</span>}
              </div>
              {candidate.note && <div className="kvm-lyric-note">{candidate.note}</div>}
            </div>

            <div className="kvm-lyric-actions">
              <button type="button" className="kvm-lyric-btn kvm-lyric-btn--ghost" onClick={() => onTogglePreview(candidate)}>
                {expanded ? '收起预览' : '预览内容'}
              </button>
              <button
                type="button"
                className="kvm-lyric-btn kvm-lyric-btn--primary"
                disabled={!hasPreviewed || applying || !canApply}
                title={applyTitle}
                onClick={() => onApply(candidate)}
              >
                {applying ? '应用中…' : applied ? '已应用 ✓' : '应用到工程'}
              </button>
            </div>
            {applyErr && <div className="kvm-lyric-error">应用失败：{applyErr}</div>}

            {expanded && (
              <div className="kvm-lyric-preview-panel">
                {previewLoading && <div className="kvm-lyric-loading">加载预览中…</div>}
                {previewErr && <div className="kvm-lyric-error">预览失败：{previewErr}</div>}
                {preview && (
                  <>
                    <div className="kvm-lyric-meta-row">
                      <span>粒度：{preview.granularity}</span>
                      <span>{preview.has_ruby ? '含假名注音轨' : '无假名注音轨'}</span>
                      <span>共 {preview.lines.length} 行</span>
                    </div>
                    <ol className="kvm-lyric-preview-lines">
                      {preview.lines.slice(0, PREVIEW_LINE_LIMIT).map((line) => (
                        <li key={line.id} className="kvm-lyric-preview-line">
                          <span className="kvm-lyric-preview-time">{lineTimeRange(line) || '--:--'}</span>
                          {line.is_metadata && (
                            <span
                              className="kvm-lyric-badge kvm-lyric-badge--muted"
                              title="疑似制作名单（词/曲/编曲等），源站常把这几行塞进正文"
                            >
                              名单?
                            </span>
                          )}
                          <span className="kvm-lyric-preview-text">
                            {line.tokens.map((t) => t.text).join('') || '（空行）'}
                          </span>
                        </li>
                      ))}
                      {preview.lines.length > PREVIEW_LINE_LIMIT && (
                        <li className="kvm-lyric-preview-line kvm-lyric-preview-more">
                          ……共 {preview.lines.length} 行，仅预览前 {PREVIEW_LINE_LIMIT} 行
                        </li>
                      )}
                    </ol>
                    {preview.raw_excerpt && (
                      <details className="kvm-lyric-raw">
                        <summary>查看源站原始文本片段</summary>
                        <pre>{preview.raw_excerpt}</pre>
                      </details>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
