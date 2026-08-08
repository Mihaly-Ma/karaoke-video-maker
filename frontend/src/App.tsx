import { useEffect, useState } from 'react'
import * as api from './api/client'
import type { JobStatus } from './api/types'
import { useProject } from './state/projectStore'

import ProjectBar from './components/ProjectBar'
import MediaPanel from './components/MediaPanel'
import JobProgress from './components/JobProgress'

// 以下三个组件由其他 agent 并行编写，此刻可能尚不存在——本文件只 import、
// 不实现它们。类型检查在它们落地前会报"找不到模块"，这是预期状态。
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import LyricPanel from './components/LyricPanel'
import RubyEditor from './components/RubyEditor'
import StylePanel from './components/StylePanel'

/**
 * 应用外壳与主布局。
 *
 * 工作流顺序（CLAUDE.md §4.1）：下载 → 歌词 → 分离 → 对轴 → 注音 → 样式 → 导出。
 * 左侧导航按此顺序排列引导用户，但每一步都可独立点开，允许任意跳步——
 * 用户可能直接导入已有素材，不能强制走完整条流水线（§2.5）。
 *
 * 区域划分：
 *   顶栏：工程 / 撤销重做 / 导出（ProjectBar）
 *   左侧：工作流步骤 + 该步骤的操作面板（下载/分离/歌词/对轴/导出）
 *   中间：预览（Preview）+ 时间轴（Timeline）——主区域，占最大空间
 *   右侧：属性面板，注音（RubyEditor）/ 样式（StylePanel）两个 tab
 *   全局悬浮：长任务进度条（任务栏），跨步骤切换也不会消失
 */

const LAST_PROJECT_KEY = 'kvm.lastProjectId'

type LeftStep = 'download' | 'lyrics' | 'separate' | 'align'
type RightTab = 'ruby' | 'style'

const LEFT_STEPS: { key: LeftStep; label: string }[] = [
  { key: 'download', label: '① 下载' },
  { key: 'lyrics', label: '② 歌词' },
  { key: 'separate', label: '③ 分离' },
  { key: 'align', label: '④ 对轴' },
]

const RIGHT_STEPS: { key: RightTab; label: string }[] = [
  { key: 'ruby', label: '⑤ 注音' },
  { key: 'style', label: '⑥ 样式' },
]

export default function App() {
  const [leftStep, setLeftStep] = useState<LeftStep>('download')
  const [rightTab, setRightTab] = useState<RightTab>('ruby')
  const [showExport, setShowExport] = useState(false)

  // 长任务 job id 提升到 App 级别持有：切换工作流步骤时子面板会卸载，
  // 但任务栏（下方）始终挂载，进度条不会跟着消失，用户随时能看到还在
  // 跑什么、跑到哪、要不要取消。
  const [downloadJobId, setDownloadJobId] = useState<string | null>(null)
  const [separateJobId, setSeparateJobId] = useState<string | null>(null)
  const [exportJobId, setExportJobId] = useState<string | null>(null)
  const [exportResult, setExportResult] = useState<string | null>(null)

  const project = useProject((s) => s.project)
  const load = useProject((s) => s.load)
  const refresh = useProject((s) => s.refresh)
  const undo = useProject((s) => s.undo)
  const redo = useProject((s) => s.redo)
  const playing = useProject((s) => s.playing)
  const setPlaying = useProject((s) => s.setPlaying)

  // 崩溃恢复：工程由后端每次编辑即落盘，刷新页面时靠 localStorage 记住的
  // 最后打开工程 id 直接回到上次状态。记录的工程已不存在（比如被删除）或
  // 首次启动没有记录时，退化为打开列表里第一个工程；仍然没有则保持空白，
  // 由顶栏引导用户新建。
  useEffect(() => {
    const savedId = localStorage.getItem(LAST_PROJECT_KEY)
    void (async () => {
      if (savedId) {
        await load(savedId)
        if (useProject.getState().project) return
      }
      const list = await api.listProjects().catch(() => [])
      if (list.length > 0) await load(list[0].id)
    })()
  }, [load])

  useEffect(() => {
    if (project?.id) localStorage.setItem(LAST_PROJECT_KEY, project.id)
  }, [project?.id])

  // 键盘快捷键：Cmd/Ctrl+Z 撤销、Shift+Cmd/Ctrl+Z 或 Cmd/Ctrl+Y 重做、空格播放/暂停。
  // 输入框/下拉框/可编辑区域聚焦时不拦截，否则用户没法正常打字或用浏览器自带撤销。
  //
  // 这是全应用唯一注册这组组合键的地方——Timeline.tsx 曾经在 window 上重复监听
  // 同一组合键，导致按一次 Cmd/Ctrl+Z 发出两次 undo 请求（用户按一次退两步），
  // Redo 同理。现在撤销/重做的键盘快捷键统一收在这里；Timeline 只保留它自己
  // 工具栏按钮的点击调用，以及打轴模式下需要独占的空格键处理（见 Timeline.tsx
  // 的 stopImmediatePropagation 注释）。
  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) void redo()
        else void undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        void redo()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        setPlaying(!playing)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, playing, setPlaying])

  const handleDownloadSettled = async (status: JobStatus) => {
    await refresh()
    if (status.state === 'done') setDownloadJobId(null)
  }
  const handleSeparateSettled = async (status: JobStatus) => {
    await refresh()
    if (status.state === 'done') setSeparateJobId(null)
  }
  const handleExportSettled = (status: JobStatus) => {
    if (status.state === 'done') {
      setExportJobId(null)
      const out = status.result['output_path'] ?? status.result['path']
      if (typeof out === 'string') setExportResult(out)
    }
  }

  const openLeftStep = (key: LeftStep) => {
    setShowExport(false)
    setLeftStep(key)
  }
  const openRightTab = (key: RightTab) => {
    setShowExport(false)
    setRightTab(key)
  }

  return (
    <div className="app-shell">
      <ProjectBar onExport={() => setShowExport(true)} />

      <div className="app-body">
        <nav className="workflow-nav">
          <div className="workflow-nav__group">
            {LEFT_STEPS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`workflow-nav__item${!showExport && leftStep === s.key ? ' active' : ''}`}
                onClick={() => openLeftStep(s.key)}
              >
                {s.label}
              </button>
            ))}
            {RIGHT_STEPS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`workflow-nav__item${!showExport && rightTab === s.key ? ' active' : ''}`}
                onClick={() => openRightTab(s.key)}
              >
                {s.label}
              </button>
            ))}
            <button
              type="button"
              className={`workflow-nav__item${showExport ? ' active' : ''}`}
              onClick={() => setShowExport(true)}
            >
              ⑦ 导出
            </button>
          </div>

          <div className="workflow-nav__content">
            {showExport ? (
              <ExportPanel exportJobId={exportJobId} onExportStart={setExportJobId} exportResult={exportResult} />
            ) : leftStep === 'download' ? (
              <MediaPanel
                focusSection="download"
                downloadJobId={downloadJobId}
                onDownloadStart={setDownloadJobId}
                separateJobId={separateJobId}
                onSeparateStart={setSeparateJobId}
              />
            ) : leftStep === 'lyrics' ? (
              <LyricPanel />
            ) : leftStep === 'separate' ? (
              <MediaPanel
                focusSection="separate"
                downloadJobId={downloadJobId}
                onDownloadStart={setDownloadJobId}
                separateJobId={separateJobId}
                onSeparateStart={setSeparateJobId}
              />
            ) : (
              <AlignPanel />
            )}
          </div>
        </nav>

        <main className="main-stage">
          <div className="preview-area">
            <Preview />
          </div>
          <div className="timeline-area">
            <Timeline />
          </div>
        </main>

        <aside className="side-panel">
          <div className="side-panel__tabs">
            <button type="button" className={rightTab === 'ruby' ? 'active' : ''} onClick={() => setRightTab('ruby')}>
              注音
            </button>
            <button type="button" className={rightTab === 'style' ? 'active' : ''} onClick={() => setRightTab('style')}>
              样式
            </button>
          </div>
          <div className="side-panel__content">{rightTab === 'ruby' ? <RubyEditor /> : <StylePanel />}</div>
        </aside>
      </div>

      {/* 任务栏：与工作流步骤切换解耦，只要有任务在跑就一直可见 */}
      <div className="job-tray">
        {downloadJobId && (
          <JobProgress
            jobId={downloadJobId}
            label="下载视频"
            onSettled={handleDownloadSettled}
            onDismiss={() => setDownloadJobId(null)}
          />
        )}
        {separateJobId && (
          <JobProgress
            jobId={separateJobId}
            label="人声分离"
            onSettled={handleSeparateSettled}
            onDismiss={() => setSeparateJobId(null)}
          />
        )}
        {exportJobId && (
          <JobProgress
            jobId={exportJobId}
            label="导出视频"
            onSettled={handleExportSettled}
            onDismiss={() => setExportJobId(null)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * 对轴步骤没有独立组件（三级调轴的精细交互——tap-to-time、波形拖拽——
 * 由 Timeline 组件负责，见下方主区域）。这里只提供粗调整体平移的入口，
 * 满足"每个自动环节都要有手工旁路"（§2.5）：哪怕自动对齐完全不可用，
 * 用户也能在这里和下方时间轴上从零手动打完一首歌。
 */
function AlignPanel() {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const shift = useProject((s) => s.shift)

  if (!project) {
    return (
      <div className="panel">
        <p className="muted">请先选择工程。</p>
      </div>
    )
  }

  const scope: 'global' | 'line' | 'token' = selection.kind === 'none' ? 'global' : selection.kind
  const scopeLabel = scope === 'global' ? '全曲' : scope === 'line' ? '当前选中行' : '当前选中词'
  const nudges = [-1000, -100, -10, 10, 100, 1000]

  return (
    <div className="panel align-panel">
      <h3>对轴</h3>
      <p className="hint">
        自动轴来自 QRC 逐字轴 / 强制对齐，精度约 50–150ms，够“整行同时亮起”但不够“逐字擦除严丝合缝”。
        精调请直接在下方时间轴上 tap-to-time 打轴或拖拽波形边界；这里的按钮用于快速整体/局部平移。
      </p>
      <p className="align-panel__scope">
        当前作用范围：<strong>{scopeLabel}</strong>
      </p>
      <div className="align-panel__nudges">
        {nudges.map((ms) => (
          <button key={ms} type="button" onClick={() => void shift(scope, ms)}>
            {ms > 0 ? `+${ms}` : ms} ms
          </button>
        ))}
      </div>
      <p className="hint">在下方时间轴选中一行或一词后，这里的按钮会只作用于该范围。</p>
    </div>
  )
}

interface ExportPanelProps {
  exportJobId: string | null
  onExportStart: (jobId: string) => void
  exportResult: string | null
}

function ExportPanel({ exportJobId, onExportStart, exportResult }: ExportPanelProps) {
  const project = useProject((s) => s.project)
  const [withGuide, setWithGuide] = useState(false)
  const [useInstrumental, setUseInstrumental] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!project) {
    return (
      <div className="panel">
        <p className="muted">请先选择工程。</p>
      </div>
    )
  }

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
    <div className="panel export-panel">
      <h3>导出成片</h3>
      <label className="checkbox-row">
        <input type="checkbox" checked={useInstrumental} onChange={(e) => setUseInstrumental(e.target.checked)} />
        使用伴奏音轨（OFF VOCAL，需已完成人声分离）
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={withGuide} onChange={(e) => setWithGuide(e.target.checked)} />
        混入引导旋律（帮助跟唱音高）
      </label>
      <p className="hint">
        ON VOCAL 与 OFF VOCAL 各需单独导出一次；字幕烧录本身会被缓存，两次导出不必重复烧录。
      </p>
      <button type="button" className="primary" onClick={() => void start()} disabled={!!exportJobId}>
        开始导出
      </button>
      {error && <p className="error">{error}</p>}
      {exportResult && (
        <p className="success">
          已导出：<code className="path">{exportResult}</code>
        </p>
      )}
    </div>
  )
}
