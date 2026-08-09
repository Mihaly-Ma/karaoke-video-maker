import { useCallback, useEffect, useMemo, useState } from 'react'

import type { JobStatus } from './api/types'
import { useProject } from './state/projectStore'
import { STEP_ORDER, stepStatus, type StepKey } from './workflow'

import ExportPanel from './components/ExportPanel'
import HomeView from './components/HomeView'
import JobProgress from './components/JobProgress'
import LineList from './components/LineList'
import LyricPanel from './components/LyricPanel'
import MediaPanel from './components/MediaPanel'
import Preview from './components/Preview'
import RubyEditor from './components/RubyEditor'
import StylePanel from './components/StylePanel'
import Timeline from './components/Timeline'
import TopBar from './components/TopBar'

/**
 * 应用外壳。
 *
 * 结构（docs/ui-redesign.md §三）：
 *   首页    → 选工程 / 新建工程，应用启动落在这里
 *   顶栏    → 工程名（回首页）/ 撤销重做 / 步骤条 / 导出
 *   舞台    → 唯一的主区域，**内容完全由当前步骤决定**
 *   任务栏  → 跨步骤常驻，有长任务才出现
 *
 * 核心原则是"中间舞台属于当前步骤的主对象"。此前中间区域被写死成"预览 + 时间轴"，
 * 与在第几步无关，于是搜歌词时最大的一块屏幕摆着一个此刻毫无用处的播放器。
 * 现在预览+时间轴只是**对轴**这一步的舞台形态。
 *
 * 播放 transport 归舞台所有，全局不设播放器：只有对轴舞台挂了 Preview，
 * 切换步骤即停止播放，"同屏两个播放按钮"结构上不可能出现（§五）。
 */

/** 每个工程各记各的步骤：点卡片进去应该回到它上次所在的那一步（§三点五） */
const stepKey = (projectId: string) => `kvm.step.${projectId}`

export default function App() {
  const [view, setView] = useState<'home' | 'editor'>('home')
  const [step, setStep] = useState<StepKey>('media')

  // 长任务 job id 提升到 App 级别持有：切换步骤时舞台会整个换掉，
  // 但任务栏始终挂载，进度条不会跟着消失。
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

  const status = useMemo(() => stepStatus(project, !!exportResult), [project, exportResult])

  const openProject = useCallback(
    (id: string) => {
      void load(id)
      const saved = localStorage.getItem(stepKey(id))
      setStep(STEP_ORDER.includes(saved as StepKey) ? (saved as StepKey) : 'media')
      setView('editor')
    },
    [load],
  )

  const goStep = useCallback(
    (next: StepKey) => {
      setStep(next)
      if (project) localStorage.setItem(stepKey(project.id), next)
    },
    [project],
  )

  // 切换步骤时停止播放：上一个舞台的 transport 已经卸载，让它继续"在播"
  // 只会留下一个没人执行、也没人能停的播放意图（§五）。
  useEffect(() => {
    setPlaying(false)
  }, [step, view, setPlaying])

  // 键盘快捷键：Cmd/Ctrl+Z 撤销、Shift+Cmd/Ctrl+Z 或 Cmd/Ctrl+Y 重做、空格播放/暂停。
  // 输入框/下拉框/可编辑区域聚焦时不拦截，否则用户没法正常打字或用浏览器自带撤销。
  //
  // 这是全应用唯一注册这组组合键的地方——Timeline.tsx 曾经在 window 上重复监听
  // 同一组合键，导致按一次 Cmd/Ctrl+Z 发出两次 undo 请求（用户按一次退两步）。
  //
  // 空格只在**拥有 transport 的舞台**上生效：别处按空格会把 playing 置真却没有
  // 任何执行者，表现为"按了没反应，再按也停不下来"。
  const hasTransport = view === 'editor' && step === 'align'
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
      if (e.code === 'Space' && hasTransport) {
        e.preventDefault()
        setPlaying(!playing)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, playing, setPlaying, hasTransport])

  const handleDownloadSettled = async (s: JobStatus) => {
    await refresh()
    if (s.state === 'done') setDownloadJobId(null)
  }
  const handleSeparateSettled = async (s: JobStatus) => {
    await refresh()
    if (s.state === 'done') setSeparateJobId(null)
  }
  const handleExportSettled = (s: JobStatus) => {
    if (s.state === 'done') {
      setExportJobId(null)
      const out = s.result['output_path'] ?? s.result['path']
      if (typeof out === 'string') setExportResult(out)
    }
  }

  /** 舞台形态由步骤全权决定：分几栏、要不要播放器、要不要波形，都在这里分派 */
  const renderStage = () => {
    switch (step) {
      case 'media':
        return (
          <main className="stage stage--scroll">
            <div className="stage__center">
              {/* 下载与分离合并为"素材"一步：二者都是把素材准备好，且分离依赖已有音频 */}
              <MediaPanel
                downloadJobId={downloadJobId}
                onDownloadStart={setDownloadJobId}
                separateJobId={separateJobId}
                onSeparateStart={setSeparateJobId}
              />
            </div>
          </main>
        )
      case 'lyrics':
        return (
          <main className="stage stage--scroll">
            <div className="stage__center">
              <LyricPanel />
            </div>
          </main>
        )
      // 只有这一步挂 Preview——"预览 + 时间轴"是对轴的舞台形态，不是全局外壳
      case 'align':
        return (
          <main className="stage">
            <AlignToolbar />
            <div className="stage__viewport">
              <Preview />
            </div>
            <div className="stage__rail">
              <Timeline />
            </div>
          </main>
        )
      case 'ruby':
        return <RubyStage />
      case 'style':
        return (
          <main className="stage stage--scroll">
            <div className="stage__center">
              <StylePanel />
            </div>
          </main>
        )
      case 'export':
        return (
          <main className="stage stage--scroll">
            <div className="stage__center">
              <ExportPanel exportJobId={exportJobId} onExportStart={setExportJobId} exportResult={exportResult} />
            </div>
          </main>
        )
    }
  }

  return (
    <div className="app-shell">
      {view === 'home' ? (
        <HomeView onOpen={openProject} />
      ) : (
        <>
          <TopBar step={step} status={status} onStep={goStep} onHome={() => setView('home')} />
          {renderStage()}
        </>
      )}

      {/* 任务栏：与步骤切换解耦，只要有任务在跑就一直可见 */}
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
 * 对轴舞台的工具条：把选中的行/词整段平移。
 *
 * 只在选中了行或词时出现——全曲平移时间轴自己已经有一条"整体偏移"，
 * 再摆一份就是这次重做要消灭的"同一操作在多处重复出现"。
 */
function AlignToolbar() {
  const selection = useProject((s) => s.selection)
  const shift = useProject((s) => s.shift)

  if (selection.kind === 'none') return null
  const scope = selection.kind

  return (
    <div className="stage-toolbar">
      <span>平移{scope === 'line' ? '选中行' : '选中词'}</span>
      <div className="nudges">
        {[-1000, -100, -10, 10, 100, 1000].map((ms) => (
          <button key={ms} type="button" className="small" onClick={() => void shift(scope, ms)}>
            {ms > 0 ? `+${ms}` : ms}
          </button>
        ))}
      </div>
      <span className="stage-toolbar__spacer" />
    </div>
  )
}

/**
 * 注音舞台：左边选行，右边逐词改读音。
 *
 * 进来时自动选中第一条正文行——RubyEditor 只编辑"当前选中行"，而选中行此前
 * 唯一的来源是时间轴。不自动选，这一步打开就是一句"请先选中一行"的死胡同。
 * 跳过制作名单行（「词：xxx」这类），它们不需要注音。
 */
function RubyStage() {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const select = useProject((s) => s.select)

  useEffect(() => {
    if (selection.kind !== 'none' || !project) return
    const first = project.lines.find((l) => !l.is_metadata && l.tokens.length > 0)
    if (first) select({ kind: 'line', lineId: first.id })
  }, [project, selection.kind, select])

  return (
    <main className="stage stage--cols">
      <aside className="stage__aside">
        <LineList />
      </aside>
      <div className="stage__main">
        <RubyEditor />
      </div>
    </main>
  )
}
