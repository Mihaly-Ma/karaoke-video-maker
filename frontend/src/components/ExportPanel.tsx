import { ExportOutlined } from '@ant-design/icons'
import { useState } from 'react'

import * as api from '../api/client'
import { useProject } from '../state/projectStore'

/**
 * 导出舞台：左侧设置、右侧产物。
 *
 * 产物列表目前只有本次会话导出的那一条——后端没有"已导出成片"的查询接口，
 * 刷新页面这条就没了。补上接口后这块直接换成真正的列表。
 */

interface ExportPanelProps {
  exportJobId: string | null
  onExportStart: (jobId: string) => void
  exportResult: string | null
}

export default function ExportPanel({ exportJobId, onExportStart, exportResult }: ExportPanelProps) {
  const project = useProject((s) => s.project)
  const [withGuide, setWithGuide] = useState(false)
  const [useInstrumental, setUseInstrumental] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!project) return <p className="stage__empty">还没有打开工程。</p>

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
        <h3>设置</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={useInstrumental}
            disabled={!project.instrumental_path}
            onChange={(e) => setUseInstrumental(e.target.checked)}
          />
          伴奏音轨（OFF VOCAL）
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={withGuide} onChange={(e) => setWithGuide(e.target.checked)} />
          混入引导声
        </label>
        <button type="button" className="primary" onClick={() => void start()} disabled={!!exportJobId}>
          <ExportOutlined /> 导出
        </button>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <h3>产物</h3>
        {exportResult ? (
          <p className="success">
            已导出 <code className="path">{exportResult}</code>
          </p>
        ) : (
          <p className="muted">还没有导出过。</p>
        )}
      </section>
    </div>
  )
}
