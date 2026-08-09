/**
 * 大预览底部的一条元信息栏：这份歌词有没有逐字轴、有没有注音、时长差多少、多少行，
 * 以及确认动作。
 *
 * 摆在这里而不是每条候选上：这四项是**看完歌词之后**才需要的确认依据，
 * 而候选列表是用来扫视排除的。同一个动作只在一处出现，是这次重做要解决的
 * "同一操作在多处重复"（docs/ui-redesign.md §一）。
 *
 * 逐字轴与注音的徽章按来源语义色着色（CLAUDE.md §7.4）：有逐字轴 = 时间来自歌词源，
 * 只有句级 = 行内时间要靠插值，插值不是锚点。
 */

import type { ReactNode } from 'react'

import { t } from '../i18n'
import type { LyricCandidate } from '../api/types'
import { durationDiffMs, formatDuration, granularityTag, isDurationMismatch } from './LyricCandidateList'

export interface LyricMetaBarProps {
  lineCount: number
  /** null = 这份数据还说不出粒度（尚未取到内容） */
  granularity: LyricCandidate['granularity'] | null
  hasRuby: boolean | null
  /** 这份歌词自身的时长（毫秒）。null 表示未知，不与视频比对 */
  durationMs: number | null
  videoDurationMs: number
  /** 追加的提示，如"3 行无法识别" */
  extra?: ReactNode
  /** 动作区（使用 / 导入） */
  children?: ReactNode
}

export default function LyricMetaBar({
  lineCount,
  granularity,
  hasRuby,
  durationMs,
  videoDurationMs,
  extra,
  children,
}: LyricMetaBarProps) {
  const gran = granularity ? granularityTag(granularity) : null
  const diff = durationMs === null ? null : durationDiffMs(durationMs, videoDurationMs)
  const mismatch = isDurationMismatch(diff)

  return (
    <div className="lyr-meta">
      <span className="num">{t('lyrics.lineCount', { n: lineCount })}</span>
      {gran && <span className={`badge lyr-tag--${gran.tone}`}>{t(gran.key)}</span>}
      {hasRuby !== null && (
        <span className={`badge ${hasRuby ? 'lyr-tag--provider' : 'lyr-tag--none'}`}>
          {t(hasRuby ? 'lyrics.hasRuby' : 'lyrics.noRuby')}
        </span>
      )}
      {durationMs !== null && durationMs > 0 && <span className="num">{formatDuration(durationMs)}</span>}
      {mismatch && diff !== null && (
        <span className="badge lyr-tag--warn" title={t('lyrics.durationDiffTitle')}>
          {t('lyrics.durationDiff', { n: `${diff > 0 ? '+' : ''}${Math.round(diff / 1000)}` })}
        </span>
      )}
      {extra}
      <span className="lyr-meta__spacer" />
      {children}
    </div>
  )
}
