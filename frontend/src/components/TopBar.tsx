import {
  AppstoreOutlined,
  BgColorsOutlined,
  CheckOutlined,
  ExportOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  RedoOutlined,
  TranslationOutlined,
  UndoOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import type { ComponentType } from 'react'

import { useProject } from '../state/projectStore'
import { STEP_LABEL, STEP_ORDER, type StepKey, type StepStatus } from '../workflow'

/**
 * 顶栏：工程名（回首页）、撤销/重做、步骤条、导出。
 *
 * 左侧那条窄导航整个取消后，步骤条是用户判断"我在哪一步"的唯一锚点
 * （docs/ui-redesign.md §三），所以它居中、占据视线中心，两侧只放低频操作。
 */

const STEP_ICON: Record<StepKey, ComponentType> = {
  media: VideoCameraOutlined,
  lyrics: FileTextOutlined,
  align: FieldTimeOutlined,
  ruby: TranslationOutlined,
  style: BgColorsOutlined,
  export: ExportOutlined,
}

interface TopBarProps {
  step: StepKey
  status: Record<StepKey, StepStatus>
  onStep: (step: StepKey) => void
  /** 回首页。工程名可点是"同时做几首歌"的正常入口，不是隐藏功能 */
  onHome: () => void
}

export default function TopBar({ step, status, onStep, onHome }: TopBarProps) {
  const project = useProject((s) => s.project)
  const error = useProject((s) => s.error)
  const canUndo = useProject((s) => s.canUndo)
  const canRedo = useProject((s) => s.canRedo)
  const undo = useProject((s) => s.undo)
  const redo = useProject((s) => s.redo)

  return (
    <header className="topbar">
      <div className="topbar__side">
        <button type="button" className="topbar__project" onClick={onHome} title="返回工程列表">
          <AppstoreOutlined />
          <span className="topbar__project-name">{project?.title || '未命名'}</span>
        </button>

        <button
          type="button"
          className="iconbtn"
          disabled={!canUndo}
          onClick={() => void undo()}
          title="撤销 (Ctrl/Cmd+Z)"
          aria-label="撤销"
        >
          <UndoOutlined />
        </button>
        <button
          type="button"
          className="iconbtn"
          disabled={!canRedo}
          onClick={() => void redo()}
          title="重做 (Shift+Ctrl/Cmd+Z)"
          aria-label="重做"
        >
          <RedoOutlined />
        </button>
      </div>

      <nav className="stepbar" aria-label="工作流步骤">
        {STEP_ORDER.map((key) => {
          const Icon = STEP_ICON[key]
          const st = status[key]
          const cls = [
            'step',
            step === key ? 'step--current' : '',
            !st.ready && step !== key ? 'step--blocked' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <button
              key={key}
              type="button"
              className={cls}
              // 前置条件不满足也照样能点：契约 §2.5 明确允许任意跳步，
              // 用户可能带着现成素材直接从中间某一步开始。
              onClick={() => onStep(key)}
              title={st.blockedBy || undefined}
              aria-current={step === key ? 'step' : undefined}
            >
              <span className="step__icon">
                <Icon />
              </span>
              {STEP_LABEL[key]}
              {st.done && (
                <span className="step__check" aria-label="已完成">
                  <CheckOutlined />
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="topbar__side topbar__side--end">
        {project && (
          <span className="topbar__meta num">
            {project.lines.length} 行 · {formatDuration(project.duration_ms)}
          </span>
        )}
        <button type="button" className="primary" disabled={!project} onClick={() => onStep('export')}>
          <ExportOutlined /> 导出
        </button>
      </div>

      {error && (
        <div className="topbar__error" role="alert">
          {error}
        </div>
      )}
    </header>
  )
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}
