import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useState } from 'react'

import * as api from '../api/client'
import type { Project, ProxyStatus } from '../api/types'
import { t } from '../i18n'
import { useProject } from '../state/projectStore'
import JobProgress from './JobProgress'

/**
 * 「素材」舞台的**编辑代理**入口。
 *
 * 为什么把它单独提成一张卡、并排在右栏最上方（右栏是本舞台最宽的一栏，卡片
 * 因此落在首屏视口顶部、紧贴它所影响的画面预览）：代理视频是这一步真正的关键
 * 产物，不是一个可选的加速开关。yt-dlp 下载回来的常是 AV1 + Matroska + Opus
 * 组合，Safari / WKWebView 对这三样都不支持——**没有代理，画面根本出不来**；
 * 4K 长 GOP 的 seek 也慢到没法逐帧核对音节边界（CLAUDE.md §9 第 18 项）。
 * 它此前是预览卡底部的一行小字加一个 ghost 按钮，埋得太深，等于把"画面为什么
 * 是黑的"变成一个用户自己解不开的死结。
 *
 * 本卡片的全部职责就是让状态一眼可读：未生成 / 生成中（带进度）/ 已就绪。
 * 导出成片与代理无关，那条路始终用原始素材（见 api/client.ts 的 buildProxy）。
 */

interface MediaProxyCardProps {
  project: Project
}

export default function MediaProxyCard({ project }: MediaProxyCardProps) {
  const refresh = useProject((s) => s.refresh)

  const [proxy, setProxy] = useState<ProxyStatus | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const projectId = project.id
  const videoPath = project.video_path
  const proxyPath = project.proxy_video_path
  const hasVideo = !!videoPath

  // 视频或代理换了就重新问一次后端。注意**不能只看 proxy_video_path 有没有值**：
  // 工程记着路径但文件被清掉时后端会报 ready=false，那才是可信的判据。
  useEffect(() => {
    let alive = true
    void api
      .proxyStatus(projectId)
      .then((st) => {
        if (!alive) return
        setProxy(st)
        // 下载/导入之后后端会自动发起一次代理生成，接管它的进度而不是再起一个。
        if (st.job && (st.job.state === 'pending' || st.job.state === 'running')) {
          setJobId(st.job.job_id)
        }
      })
      .catch(() => {
        if (alive) setProxy(null)
      })
    return () => {
      alive = false
    }
  }, [projectId, videoPath, proxyPath])

  const start = useCallback(async () => {
    setError(null)
    try {
      const job = await api.buildProxy(projectId, undefined, !!proxyPath)
      setJobId(job.job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId, proxyPath])

  const onSettled = useCallback(async () => {
    await refresh()
    setProxy(await api.proxyStatus(projectId).catch(() => null))
    setJobId(null)
  }, [projectId, refresh])

  const ready = proxy?.ready ?? !!proxyPath
  const running = !!jobId
  // 三态直接决定这张卡的观感：需要用户动手时整卡染上强调色，就绪后退回中性，
  // 免得一张永远高亮的卡片变成背景噪音。
  const tone = running ? 'busy' : ready ? 'ready' : hasVideo ? 'action' : 'idle'

  const stateText = running
    ? t('media.proxy.buildingState')
    : ready
      ? t('common.ready')
      : hasVideo
        ? t('media.proxy.missing')
        : t('media.proxy.needVideo')

  return (
    <section className={`kvm-media-proxy kvm-media-proxy--${tone}`}>
      <div className="kvm-media-proxy__head">
        <ThunderboltOutlined className="kvm-media-proxy__icon" />
        <span className="kvm-media-proxy__title">{t('media.proxy.title')}</span>
        {/* 后端 note 是完整说明句，界面主文案要短（docs/ui-redesign.md §六），
            所以它只作为悬浮详情保留，不占版面 */}
        <span className="kvm-media-proxy__state" title={proxy?.note || undefined}>
          {ready && !running ? (
            <CheckCircleOutlined className="kvm-media-proxy__dot kvm-media-proxy__dot--ok" />
          ) : (
            !running && (
              <ExclamationCircleOutlined className="kvm-media-proxy__dot kvm-media-proxy__dot--warn" />
            )
          )}
          {stateText}
        </span>
        <button
          type="button"
          className={ready ? 'ghost' : 'primary'}
          onClick={() => void start()}
          disabled={!hasVideo || running}
        >
          {ready ? t('media.proxy.rebuild') : t('media.proxy.build')}
        </button>
      </div>

      {jobId && (
        <JobProgress
          jobId={jobId}
          label={t('media.proxy.building')}
          onSettled={() => void onSettled()}
          onDismiss={() => setJobId(null)}
        />
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
