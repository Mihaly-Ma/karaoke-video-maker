import { useCallback, useEffect, useMemo, useState } from 'react'

import type { JobStatus } from './api/types'
import { useProject } from './state/projectStore'
import { normalizeStep, stepStatus, type StepKey } from './workflow'

import EditStage from './components/EditStage'
import ExportPanel from './components/ExportPanel'
import HomeView from './components/HomeView'
import JobProgress from './components/JobProgress'
import LyricPanel from './components/LyricPanel'
import MediaPanel from './components/MediaPanel'
import StylePanel from './components/StylePanel'
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
 * 现在预览+时间轴只是**编辑**这一步的舞台形态。
 *
 * 播放 transport 归舞台所有，全局不设播放器：只有编辑舞台挂了 Preview，
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
      /*
       * 老工程记下的可能是已经合并掉的 `align` / `ruby`，归一化到 `edit`
       * （见 workflow.ts 的 normalizeStep）。**顺手把归一化结果写回去**：
       * 不写回的话每次打开这个工程都要再翻译一次，而下次改步骤集合时
       * 又得多认一层历史。
       */
      const next = normalizeStep(localStorage.getItem(stepKey(id)))
      localStorage.setItem(stepKey(id), next)
      setStep(next)
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
  const hasTransport = view === 'editor' && step === 'edit'
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

  /**
   * 舞台形态由步骤全权决定：分几栏、要不要播放器、要不要波形，都在这里分派。
   *
   * **舞台一律铺满宽度，不要再套 `stage__center` 那类限宽容器。**
   * 这次重排的核心原则就是"中间舞台拿到全部横向空间"，而每个舞台内部都是
   * 左操作 + 右大预览/列表的两栏结构——限宽 960px 会直接压死右侧那块大预览，
   * 逼得各舞台自己在组件 CSS 里用 `:has()` 把限宽解除，等于绕开外壳打补丁。
   * 需要限宽的是**单栏长文**，本应用没有这样的舞台。
   */
  const renderStage = () => {
    switch (step) {
      case 'media':
        return (
          <main className="stage stage--scroll">
            {/* 下载与分离合并为"素材"一步：二者都是把素材准备好，且分离依赖已有音频 */}
            <MediaPanel
              downloadJobId={downloadJobId}
              onDownloadStart={setDownloadJobId}
              separateJobId={separateJobId}
              onSeparateStart={setSeparateJobId}
            />
          </main>
        )
      case 'lyrics':
        return (
          <main className="stage stage--scroll">
            <LyricPanel />
          </main>
        )
      // 只有这一步挂 Preview——"预览 + 时间轴"是编辑的舞台形态，不是全局外壳。
      // 对轴与注音合并在这一个舞台里，版面见 EditStage。
      case 'edit':
        return <EditStage />
      case 'style':
        return (
          <main className="stage stage--scroll">
            <StylePanel />
          </main>
        )
      case 'export':
        return (
          <main className="stage stage--scroll">
            <ExportPanel exportJobId={exportJobId} onExportStart={setExportJobId} exportResult={exportResult} />
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

/*
 * 这里曾有两个只服务于旧划分的组件：
 *
 * - `AlignToolbar`（平移选中行/词的一条横带）—— 现在是底栏检查器里贴着时间的那组
 *   ±10/±100 按钮。平移的对象就是检查器正在显示的那个字，摆在一起才对得上。
 * - `RubyStage`（左选行 + 右改读音）—— 整个并进 `EditStage`：选行不再需要一个
 *   专用列表，时间轴与歌词正文本身就是选行的入口。
 */
