/**
 * 歌词候选列表（左侧窄列）。
 *
 * 只负责"快速扫视 + 选中"：每条给出来源、粒度、注音、时长、歌手，够用来排除
 * 明显不对的版本；真正判断内容对不对靠中间那块成片样式的大预览。
 * 因此这里**不再有逐条的预览/应用按钮**——选中即预览，使用在底部元信息栏，
 * 同一个动作只在一处出现。
 *
 * CLAUDE.md §5.2：Resolver 只排序、不裁决。列表严格按后端给的顺序展示，
 * 前端不做二次排序，也不标"推荐"——排序本身已经表达了打分结果，再加一个
 * 徽章就变成系统替用户下结论。
 */

import type { LyricCandidate } from '../api/types'
import { t } from '../i18n'

/** 候选项的稳定 key：不同 provider 的 song_id 可能重复，必须带 provider 前缀。 */
export function candidateKey(candidate: LyricCandidate): string {
  return `${candidate.provider}::${candidate.song_id}`
}

const PROVIDER_LABELS: Record<string, string> = {
  qq: 'QQ音乐',
  qqmusic: 'QQ音乐',
  kugou: '酷狗',
  krc: '酷狗',
  netease: '网易云',
  ncm: '网易云',
  youtube: 'YouTube 字幕',
  yt: 'YouTube 字幕',
  lrclib: 'LRCLIB',
  utaten: 'UtaTen',
  manual: '手工',
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider
}

/**
 * 粒度徽章。颜色沿用来源语义色（CLAUDE.md §7.4）：逐字轴是歌词源实测的时间，
 * 句级轴导入后行内只能靠插值，纯文本干脆没有时间。
 */
export const GRANULARITY_TAG: Record<string, { key: string; tone: string }> = {
  word: { key: 'lyrics.granWord', tone: 'provider' },
  line: { key: 'lyrics.granLine', tone: 'interp' },
  plain: { key: 'lyrics.granPlain', tone: 'none' },
  // 搜索阶段拿不到歌词正文，粒度只有 fetch 之后才确定。后端为此保留了 `unknown`
  // （§5.2「粒度可以被提升，不能被伪造」）——它不是"没有"，是"还不知道"，
  // 所以给中性色而不是 plain 的样式。
  unknown: { key: 'lyrics.granUnknown', tone: 'none' },
}

/**
 * 取粒度徽章。**必须容忍未知值**：这张表的键来自后端枚举，后端加一个取值就会让
 * 这里查空——直接 `TAG[g].tone` 会在渲染中抛异常、整棵 React 树卸载、界面变全白。
 * 这个 bug 真实发生过（后端加 `unknown` 三态时）。查不到就返回 null，让调用方不画徽章。
 */
export function granularityTag(g: string): { key: string; tone: string } | null {
  return GRANULARITY_TAG[g] ?? null
}

/**
 * 预览接口的 `granularity` 是自由字符串（后端枚举的值），来源不受前端类型约束。
 * 认不出来时返回 null 而不是硬转类型——错的徽章比没有徽章更容易误导。
 */
export function normalizeGranularity(g: string): LyricCandidate['granularity'] | null {
  return g === 'word' || g === 'line' || g === 'plain' ? g : null
}

/** 与视频时长差超过这个值就提示可能是错配版本，与后端 Resolver 的阈值一致（CLAUDE.md §5.2）。 */
const DURATION_MISMATCH_THRESHOLD_MS = 3000

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '--:--'
  const totalSec = Math.round(ms / 1000)
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`
}

/** 候选时长与视频时长之差（毫秒）。任一方未知时返回 null，而不是误报不符。 */
export function durationDiffMs(candidateMs: number, videoMs: number): number | null {
  if (videoMs <= 0 || candidateMs <= 0) return null
  return candidateMs - videoMs
}

export const isDurationMismatch = (diffMs: number | null): boolean =>
  diffMs !== null && Math.abs(diffMs) > DURATION_MISMATCH_THRESHOLD_MS

export interface LyricCandidateListProps {
  candidates: LyricCandidate[]
  /** 视频时长（毫秒）。0 表示未知，跳过时长比对 */
  videoDurationMs: number
  selectedKey: string | null
  onSelect: (candidate: LyricCandidate) => void
}

export default function LyricCandidateList({
  candidates,
  videoDurationMs,
  selectedKey,
  onSelect,
}: LyricCandidateListProps) {
  if (candidates.length === 0) {
    return <div className="lyr-note">{t('lyrics.noCandidates')}</div>
  }

  return (
    <div className="lyr-cands">
      {candidates.map((c) => {
        const key = candidateKey(c)
        const gran = granularityTag(c.granularity)
        const diff = durationDiffMs(c.duration_ms, videoDurationMs)
        const mismatch = isDurationMismatch(diff)
        return (
          <button
            key={key}
            type="button"
            className={`lyr-cand${selectedKey === key ? ' lyr-cand--active' : ''}`}
            aria-pressed={selectedKey === key}
            onClick={() => onSelect(c)}
          >
            <span className="lyr-cand__top">
              <span className="lyr-cand__title">{c.title || providerLabel(c.provider)}</span>
              <span className="lyr-cand__dur num">{formatDuration(c.duration_ms)}</span>
            </span>
            <span className="lyr-cand__sub">
              {[providerLabel(c.provider), c.artist, c.album].filter(Boolean).join(' · ')}
            </span>
            <span className="lyr-cand__tags">
              {gran && <span className={`badge lyr-tag--${gran.tone}`}>{t(gran.key)}</span>}
              {/*
                三态：true 有、false 没有、null「搜索阶段还不知道」。
                后两者必须区分——把"不知道"画成"没有"，用户会据此排除掉其实有注音的候选。
              */}
              {c.has_ruby === true && (
                <span className="badge lyr-tag--provider">{t('lyrics.hasRuby')}</span>
              )}
              {c.has_ruby === null && <span className="badge">{t('lyrics.rubyUnknown')}</span>}
              {c.has_translation && <span className="badge">{t('lyrics.hasTranslation')}</span>}
              {mismatch && diff !== null && (
                <span className="badge lyr-tag--warn" title={t('lyrics.durationDiffTitle')}>
                  {t('lyrics.durationDiff', { n: `${diff > 0 ? '+' : ''}${Math.round(diff / 1000)}` })}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
