import { useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import { useProject } from '../state/projectStore'
import type { Project } from '../api/types'

/**
 * 视频下载与人声分离面板。
 *
 * CLAUDE.md §2.5：自动环节必须有等价的手工旁路，且旁路不能藏起来。
 * 因此每个小节都是"自动入口 + 手工入口"并列展示，而不是自动失败后才露出。
 *
 * 长任务（下载/分离）的 job id 由父组件（App.tsx）持有而不是本组件内部
 * state——这样切换到其它工作流步骤时，任务栏里的进度条不会跟着卸载消失。
 */

/**
 * 一个人声分离档位，对应后端 `SeparateModelTier`
 * （`GET /api/media/separate/models`）。
 */
interface SeparateTier {
  id: string
  label: string
  model_filename: string
  hint: string
  recommended: boolean
  warning: string
}

/**
 * 后端不可达时的兜底档位。**只写档位 id，不写模型文件名**——模型文件名属于
 * audio-separator 的命名空间，前端硬编码它正是此前"标准"和"最佳"两档一点就报
 * `Model file ... not found in supported model files` 的根因：前端传去掉扩展名的
 * 文件名，后端按档位名建别名表，两边压根对不上。现在传输值统一为档位 id。
 */
const FALLBACK_TIERS: SeparateTier[] = [
  { id: 'fast', label: '快速', model_filename: '', hint: '先出个能听的伴奏，立刻开始调轴', recommended: true, warning: '' },
  { id: 'standard', label: '标准', model_filename: '', hint: '质量与速度平衡', recommended: false, warning: '' },
  { id: 'best', label: '最佳', model_filename: '', hint: '质量最高，最慢', recommended: false, warning: '' },
]

/**
 * 手工旁路：直接导入本地文件，绕开下载/分离。
 *
 * 后端 `POST /api/media/import`（`backend/kvm/api/routes/media.py`）已实现，
 * 支持 kind ∈ video/audio/instrumental/vocals/drums 全部五种，multipart 字段
 * project_id / kind / file，返回完整 Project JSON。
 */
async function importLocalFile(
  projectId: string,
  kind: 'video' | 'audio' | 'vocals' | 'instrumental' | 'drums',
  file: File,
): Promise<Project> {
  const form = new FormData()
  form.append('project_id', projectId)
  form.append('kind', kind)
  form.append('file', file)
  const resp = await fetch('/api/media/import', { method: 'POST', body: form })
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`
    try {
      const body: unknown = await resp.json()
      if (body && typeof body === 'object' && 'detail' in body) {
        const d = (body as { detail: unknown }).detail
        detail = typeof d === 'string' ? d : JSON.stringify(d)
      }
    } catch {
      /* 响应体不是 JSON 时保留状态行 */
    }
    throw new Error(detail)
  }
  return (await resp.json()) as Project
}

interface MediaPanelProps {
  /** 由工作流导航指定，仅做视觉高亮引导，不影响功能。 */
  focusSection?: 'download' | 'separate'
  downloadJobId: string | null
  onDownloadStart: (jobId: string) => void
  separateJobId: string | null
  onSeparateStart: (jobId: string) => void
}

export default function MediaPanel({
  focusSection,
  downloadJobId,
  onDownloadStart,
  separateJobId,
  onSeparateStart,
}: MediaPanelProps) {
  const project = useProject((s) => s.project)
  const refresh = useProject((s) => s.refresh)

  const [url, setUrl] = useState('')
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const [tiers, setTiers] = useState<SeparateTier[]>(FALLBACK_TIERS)
  const [tiersFallback, setTiersFallback] = useState(false)
  /** null 表示"用户还没选"，此时跟随后端标记的推荐档，避免异步拿到档位表时把用户的选择顶掉。 */
  const [model, setModel] = useState<string | null>(null)
  const [separateError, setSeparateError] = useState<string | null>(null)

  const [importError, setImportError] = useState<string | null>(null)
  const [importingKind, setImportingKind] = useState<
    null | 'video' | 'audio' | 'vocals' | 'instrumental' | 'drums'
  >(null)

  const videoFileRef = useRef<HTMLInputElement>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)
  const vocalsFileRef = useRef<HTMLInputElement>(null)
  const instrumentalFileRef = useRef<HTMLInputElement>(null)
  const drumsFileRef = useRef<HTMLInputElement>(null)
  const fileRefs = {
    video: videoFileRef,
    audio: audioFileRef,
    vocals: vocalsFileRef,
    instrumental: instrumentalFileRef,
    drums: drumsFileRef,
  }

  const projectId = project?.id

  // 档位表由后端给（唯一真相来源），前端只认 id。取不到就退回内置 id 列表——
  // 那些 id 后端一样认，分离仍然可用，只是提示文案没那么准。
  useEffect(() => {
    let alive = true
    fetch('/api/media/separate/models')
      .then((resp) => (resp.ok ? (resp.json() as Promise<SeparateTier[]>) : Promise.reject()))
      .then((list) => {
        if (alive && list.length > 0) setTiers(list)
      })
      .catch(() => {
        if (alive) setTiersFallback(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const selectedModel = model ?? tiers.find((t) => t.recommended)?.id ?? tiers[0]?.id ?? 'fast'

  const startDownload = async () => {
    if (!projectId || !url.trim()) return
    setDownloadError(null)
    try {
      const job = await api.download(projectId, url.trim())
      onDownloadStart(job.job_id)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : String(e))
    }
  }

  const startSeparate = async () => {
    if (!projectId) return
    setSeparateError(null)
    try {
      const job = await api.separate(projectId, selectedModel)
      onSeparateStart(job.job_id)
    } catch (e) {
      setSeparateError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleImport = async (
    kind: 'video' | 'audio' | 'vocals' | 'instrumental' | 'drums',
    file: File | undefined,
  ) => {
    if (!projectId || !file) return
    setImportError(null)
    setImportingKind(kind)
    try {
      await importLocalFile(projectId, kind, file)
      await refresh()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e))
    } finally {
      setImportingKind(null)
      const ref = fileRefs[kind]
      if (ref.current) ref.current.value = ''
    }
  }

  if (!project) {
    return (
      <div className="panel media-panel">
        <p className="muted">请先在顶栏创建或选择一个工程。</p>
      </div>
    )
  }

  return (
    <div className="panel media-panel">
      <section className={`media-panel__section${focusSection === 'download' ? ' media-panel__section--focus' : ''}`}>
        <h3>视频获取</h3>
        <div className="media-panel__status">
          <span className={`badge${project.video_path ? ' badge--ok' : ''}`}>
            视频 {project.video_path ? '已就绪' : '未获取'}
          </span>
          <span className={`badge${project.audio_path ? ' badge--ok' : ''}`}>
            音频 {project.audio_path ? '已就绪' : '未获取'}
          </span>
        </div>
        {project.video_path && <code className="path">{project.video_path}</code>}
        {project.audio_path && <code className="path">{project.audio_path}</code>}

        <div className="media-panel__row">
          <input
            type="text"
            placeholder="YouTube 链接"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void startDownload()
            }}
          />
          <button type="button" onClick={() => void startDownload()} disabled={!url.trim() || !!downloadJobId}>
            下载
          </button>
        </div>

        <div className="media-panel__manual">
          {/* 视频与音频分成两个明确入口，而不是共用一个 accept="video/*,audio/*"
              的输入框固定传 kind='video'——那样选了纯音频文件会让 video_path
              指向一个没有视频流的文件，下游渲染/预览会出问题 */}
          <span className="muted">或直接选择本地文件：</span>
          <label className="media-panel__file-label">
            视频
            <input
              ref={videoFileRef}
              type="file"
              accept="video/*"
              onChange={(e) => void handleImport('video', e.target.files?.[0])}
            />
          </label>
          <label className="media-panel__file-label">
            音频
            <input
              ref={audioFileRef}
              type="file"
              accept="audio/*"
              onChange={(e) => void handleImport('audio', e.target.files?.[0])}
            />
          </label>
          {(importingKind === 'video' || importingKind === 'audio') && (
            <span className="muted">导入中…</span>
          )}
        </div>

        {downloadError && <p className="error">{downloadError}</p>}
      </section>

      <section className={`media-panel__section${focusSection === 'separate' ? ' media-panel__section--focus' : ''}`}>
        <h3>人声分离</h3>
        <p className="hint">可选步骤——跳过也能导出，只是没有 ON/OFF VOCAL 双音轨。</p>
        <div className="media-panel__status">
          <span className={`badge${project.vocals_path ? ' badge--ok' : ''}`}>
            人声 {project.vocals_path ? '已就绪' : '未分离'}
          </span>
          <span className={`badge${project.instrumental_path ? ' badge--ok' : ''}`}>
            伴奏 {project.instrumental_path ? '已就绪' : '未分离'}
          </span>
        </div>

        <div className="media-panel__models">
          {tiers.map((t) => (
            <label key={t.id} className="media-panel__model">
              <input
                type="radio"
                name="separate-model"
                value={t.id}
                checked={selectedModel === t.id}
                onChange={() => setModel(t.id)}
              />
              <span className="media-panel__model-label">
                {t.label}
                {t.recommended ? '（推荐）' : ''}
              </span>
              <span className="muted">{t.hint}</span>
              {t.warning && <span className="error">{t.warning}</span>}
            </label>
          ))}
        </div>
        {tiersFallback && (
          <p className="hint">读取不到后端的档位列表，正在用内置档位，提示文案可能不准。</p>
        )}

        <button
          type="button"
          onClick={() => void startSeparate()}
          disabled={(!project.audio_path && !project.video_path) || !!separateJobId}
        >
          开始分离
        </button>

        <div className="media-panel__manual">
          <span className="muted">或导入已分离好的音轨：</span>
          <label className="media-panel__file-label">
            人声
            <input
              ref={vocalsFileRef}
              type="file"
              accept="audio/*"
              onChange={(e) => void handleImport('vocals', e.target.files?.[0])}
            />
          </label>
          <label className="media-panel__file-label">
            伴奏
            <input
              ref={instrumentalFileRef}
              type="file"
              accept="audio/*"
              onChange={(e) => void handleImport('instrumental', e.target.files?.[0])}
            />
          </label>
          <label className="media-panel__file-label" title="用于节拍检测（引导旋律），跳过完整分离时可以只导入这一轨">
            鼓声
            <input
              ref={drumsFileRef}
              type="file"
              accept="audio/*"
              onChange={(e) => void handleImport('drums', e.target.files?.[0])}
            />
          </label>
          {(importingKind === 'vocals' ||
            importingKind === 'instrumental' ||
            importingKind === 'drums') && <span className="muted">导入中…</span>}
        </div>

        {separateError && <p className="error">{separateError}</p>}
        {importError && <p className="error">{importError}</p>}
      </section>
    </div>
  )
}
