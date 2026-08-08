import { useEffect, useState } from 'react'
import * as api from '../api/client'
import { useProject } from '../state/projectStore'
import type { ProjectSummary } from '../api/types'

/**
 * 顶栏：工程选择 / 新建、撤销重做、导出入口。
 *
 * 崩溃恢复所需的"记住最后打开的工程"逻辑放在 App.tsx（启动引导 + 写
 * localStorage），本组件只负责当前工程的展示与切换。
 */

interface ProjectBarProps {
  /** 点击"导出"时触发，由 App 决定如何展示导出面板。 */
  onExport: () => void
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function ProjectBar({ onExport }: ProjectBarProps) {
  const project = useProject((s) => s.project)
  const loading = useProject((s) => s.loading)
  const error = useProject((s) => s.error)
  const canUndo = useProject((s) => s.canUndo)
  const canRedo = useProject((s) => s.canRedo)
  const load = useProject((s) => s.load)
  const create = useProject((s) => s.create)
  const undo = useProject((s) => s.undo)
  const redo = useProject((s) => s.redo)

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newArtist, setNewArtist] = useState('')

  const refreshList = async () => {
    try {
      setProjects(await api.listProjects())
      setListError(null)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refreshList()
  }, [])

  // 当前工程加载/改名后，下拉列表里的标题、时长可能过期——保持新鲜。
  useEffect(() => {
    void refreshList()
  }, [project?.id, project?.title, project?.artist, project?.duration_ms])

  const handleSelect = (id: string) => {
    if (!id || id === project?.id) return
    void load(id)
  }

  const handleCreate = async () => {
    await create(newTitle.trim(), newArtist.trim())
    setCreating(false)
    setNewTitle('')
    setNewArtist('')
    await refreshList()
  }

  return (
    <header className="project-bar">
      <div className="project-bar__brand">卡拉OK视频制作工具</div>

      <div className="project-bar__project">
        <select
          className="project-bar__select"
          value={project?.id ?? ''}
          onChange={(e) => handleSelect(e.target.value)}
          aria-label="选择工程"
        >
          <option value="" disabled>
            {projects.length ? '选择工程…' : '暂无工程'}
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || '(未命名)'}
              {p.artist ? ` - ${p.artist}` : ''}
            </option>
          ))}
        </select>

        {creating ? (
          <form
            className="project-bar__new-form"
            onSubmit={(e) => {
              e.preventDefault()
              void handleCreate()
            }}
          >
            <input autoFocus placeholder="曲名" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            <input placeholder="歌手" value={newArtist} onChange={(e) => setNewArtist(e.target.value)} />
            <button type="submit">创建</button>
            <button type="button" className="ghost" onClick={() => setCreating(false)}>
              取消
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setCreating(true)}>
            新建工程
          </button>
        )}
      </div>

      <div className="project-bar__history">
        <button type="button" disabled={!canUndo} onClick={() => void undo()} title="撤销 (Ctrl/Cmd+Z)">
          ↶ 撤销
        </button>
        <button type="button" disabled={!canRedo} onClick={() => void redo()} title="重做 (Shift+Ctrl/Cmd+Z)">
          ↷ 重做
        </button>
      </div>

      <div className="project-bar__meta">
        {project ? (
          <span>
            {project.title || '(未命名)'} · {project.lines.length} 行 · {formatDuration(project.duration_ms)}
          </span>
        ) : loading ? (
          <span className="muted">加载中…</span>
        ) : (
          <span className="muted">未加载工程</span>
        )}
      </div>

      <div className="project-bar__actions">
        <button type="button" className="primary" disabled={!project} onClick={onExport}>
          导出
        </button>
      </div>

      {(error || listError) && (
        <div className="project-bar__error" role="alert">
          {error ?? listError}
        </div>
      )}
    </header>
  )
}
