import { ExportOutlined, LoadingOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'

import * as api from '../api/client'
import type { ExportArtifact } from '../api/types'
import { t } from '../i18n'
import { useProject } from '../state/projectStore'

/**
 * 导出舞台：左侧设置、右侧产物。
 *
 * 产物列表来自 `GET /api/render/exports/{id}`（store 的 `loadExports`），
 * 只列文件仍在磁盘上的那批——刷新页面不会丢，用户把成片删了也不会留下一个
 * 点开必然报错的入口。工程 JSON 里的 `exports` 是持久化存储，不作可用性判据。
 */

interface ExportPanelProps {
  exportJobId: string | null
  onExportStart: (jobId: string) => void
  exportResult: string | null
}

/** 体积按量级取单位：3.2 MB 比 3202380 B 更容易判断"这条是不是整片"。 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 时长按 m:ss 显示；成片动辄几分钟，秒数反而读不出长短。 */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 后端给的是 Unix **秒**，乘 1000 才是 JS 的毫秒时间戳。 */
function formatTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString()
}

function ArtifactRow({ item }: { item: ExportArtifact }) {
  return (
    <li className="linelist__item">
      <span className="badge badge--ok">{item.variant_label}</span>
      <span className="linelist__text path" title={item.path}>
        {item.path}
      </span>
      <span className="muted">
        {t('export.meta', {
          size: formatSize(item.size_bytes),
          duration: formatDuration(item.duration_ms),
          time: formatTime(item.created_at),
        })}
      </span>
    </li>
  )
}

export default function ExportPanel({ exportJobId, onExportStart, exportResult }: ExportPanelProps) {
  const project = useProject((s) => s.project)
  const loadExports = useProject((s) => s.loadExports)
  const [withGuide, setWithGuide] = useState(false)
  const [useInstrumental, setUseInstrumental] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectId = project?.id ?? null
  const artifacts = project?.exports ?? []

  // 导出跑完（App 轮询到 done 后才会写 exportResult）重新拉一次清单。
  // 后端在把任务标 done **之前**就登记好了产物，所以这一拉必定拿得到。
  // 挂载时也拉一次：用户可能在别的窗口导出过。
  useEffect(() => {
    if (projectId) void loadExports()
  }, [projectId, exportResult, loadExports])

  if (!project) return <p className="stage__empty">{t('common.selectProjectFirst')}</p>

  const start = async () => {
    setError(null)
    try {
      const job = await api.exportVideo({
        project_id: project.id,
        with_guide: withGuide,
        use_instrumental: useInstrumental,
      })
      onExportStart(job.job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="export-grid">
      <section className="card">
        <h3>{t('export.settings')}</h3>
        <label className="checkbox-row" title={project.instrumental_path ? '' : t('export.instrumentalMissing')}>
          <input
            type="checkbox"
            checked={useInstrumental}
            disabled={!project.instrumental_path}
            onChange={(e) => setUseInstrumental(e.target.checked)}
          />
          {t('export.instrumental')}
        </label>
        <label className="checkbox-row" title={project.vocals_path ? '' : t('export.withGuideMissing')}>
          <input
            type="checkbox"
            checked={withGuide}
            disabled={!project.vocals_path}
            onChange={(e) => setWithGuide(e.target.checked)}
          />
          {t('export.withGuide')}
        </label>
        <button type="button" className="primary" onClick={() => void start()} disabled={!!exportJobId}>
          {exportJobId ? <LoadingOutlined /> : <ExportOutlined />}{' '}
          {exportJobId ? t('export.running') : t('export.start')}
        </button>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <h3>{t('export.artifacts')}</h3>
        {artifacts.length === 0 ? (
          <p className="muted">{t('export.empty')}</p>
        ) : (
          <ul className="linelist">
            {artifacts.map((item) => (
              <ArtifactRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
