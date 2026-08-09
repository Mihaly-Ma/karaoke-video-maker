import { useCallback, useEffect, useState } from 'react'

import * as api from '../api/client'
import type { Project, ProxyStatus } from '../api/types'
import { t } from '../i18n'
import { useProject } from '../state/projectStore'
import JobProgress from './JobProgress'

/**
 * 「素材」舞台右上的画面预览。
 *
 * 这一步存在的唯一理由是**看画面**（CLAUDE.md §5.11.5 附近的讨论、
 * docs/ui-redesign.md §四"素材"）：下载可能拿到坏流、可能悄悄降级到 720p、
 * 可能音画不同步，这些问题不看画面根本发现不了。只需要能播、能拖，
 * 不挂字幕层——真正的所见即所得渲染是「对轴」舞台的 Preview 组件的事。
 *
 * 因此这里刻意用原生 `<video controls>`：拖动进度条、音量都是浏览器免费给的，
 * 不需要也不该在这个纯粹的"看素材"场景里重新发明一套走带控件。
 *
 * 播放不接入全局 store 的 playheadMs/playing——那一套是"对轴"舞台唯一时钟的
 * 专属机制（见 state/projectStore.ts 顶部注释），本组件是完全独立、自己管自己
 * 的一次性预览，只通过 onPlayback 参与"同一时刻只有一路声音"的独占协调。
 */

interface MediaVideoPreviewProps {
  project: Project
  /** 独占播放：开始播放前调用，父组件借此暂停其它正在响的音轨。 */
  onPlayback: (el: HTMLMediaElement) => void
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function MediaVideoPreview({ project, onPlayback }: MediaVideoPreviewProps) {
  const refresh = useProject((s) => s.refresh)

  const [unplayable, setUnplayable] = useState(false)
  const [proxy, setProxy] = useState<ProxyStatus | null>(null)
  const [proxyJobId, setProxyJobId] = useState<string | null>(null)
  const [proxyError, setProxyError] = useState<string | null>(null)

  const videoPath = project.video_path
  const proxyPath = project.proxy_video_path
  const videoKind: 'proxy' | 'video' = proxyPath ? 'proxy' : 'video'
  const hasVideo = !!videoPath

  // 换了工程/换了视频文件，之前"放不了"的结论作废，重新给一次机会——代理刚
  // 生成出来时 proxyPath 会从 null 变成有值，那正是"刚才放不了、现在放得了"
  // 的典型时刻。
  useEffect(() => setUnplayable(false), [project.id, videoPath, proxyPath])

  useEffect(() => {
    let alive = true
    void api
      .proxyStatus(project.id)
      .then((st) => {
        if (!alive) return
        setProxy(st)
        if (st.job && (st.job.state === 'pending' || st.job.state === 'running')) {
          setProxyJobId(st.job.job_id)
        }
      })
      .catch(() => {
        if (alive) setProxy(null)
      })
    return () => {
      alive = false
    }
  }, [project.id, videoPath, proxyPath])

  const startProxy = useCallback(async () => {
    setProxyError(null)
    try {
      const job = await api.buildProxy(project.id, undefined, !!proxyPath)
      setProxyJobId(job.job_id)
    } catch (e) {
      setProxyError(e instanceof Error ? e.message : String(e))
    }
  }, [project.id, proxyPath])

  const onProxySettled = useCallback(async () => {
    await refresh()
    setProxy(await api.proxyStatus(project.id).catch(() => null))
    setProxyJobId(null)
  }, [project.id, refresh])

  return (
    <section className="kvm-media-preview card">
      <div className="kvm-media-preview__frame">
        {hasVideo && !unplayable ? (
          <video
            key={videoKind}
            className="kvm-media-preview__video"
            controls
            // 跨源隔离页面里不加 crossOrigin，带 CORP 头的媒体会加载失败（见
            // Preview.tsx 同一处注释，这里复用同样已验证过的写法）。
            crossOrigin="anonymous"
            playsInline
            preload="metadata"
            src={api.mediaUrl(project.id, videoKind)}
            onPlay={(e) => onPlayback(e.currentTarget)}
            onError={() => setUnplayable(true)}
          />
        ) : (
          <div className="kvm-media-preview__empty">
            {hasVideo ? t('media.preview.unplayable') : t('media.preview.empty')}
          </div>
        )}
      </div>

      <div className="kvm-media-preview__meta">
        <span className="badge">
          {project.video_width > 0
            ? `${project.video_width}×${project.video_height}`
            : t('media.preview.noResolution')}
        </span>
        <span className="badge">{formatDuration(project.duration_ms)}</span>
        {hasVideo && (
          <span className="badge">
            {proxyPath ? t('media.preview.usingProxy') : t('media.preview.usingOriginal')}
          </span>
        )}
      </div>

      <div className="kvm-media-preview__proxybar">
        <span className={proxy?.ready ? 'success' : 'hint'}>
          {proxy?.note ?? (hasVideo ? t('media.proxy.missing') : t('media.proxy.needVideo'))}
        </span>
        <button
          type="button"
          className="ghost small"
          onClick={() => void startProxy()}
          disabled={!videoPath || !!proxyJobId}
        >
          {proxy?.ready ? t('media.proxy.rebuild') : t('media.proxy.build')}
        </button>
      </div>
      {proxyJobId && (
        <JobProgress
          jobId={proxyJobId}
          label={t('media.proxy.building')}
          onSettled={() => void onProxySettled()}
          onDismiss={() => setProxyJobId(null)}
        />
      )}
      {proxyError && <p className="error">{proxyError}</p>}
    </section>
  )
}
