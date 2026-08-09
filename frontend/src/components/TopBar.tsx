import {
  AppstoreOutlined,
  BgColorsOutlined,
  CheckOutlined,
  ExportOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  RollbackOutlined,
  TranslationOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import type { ComponentType } from 'react'

import { t } from '../i18n'
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

        {/*
         * 撤销/重做为什么不是 antd 的 UndoOutlined / RedoOutlined：那两个图标的
         * 路径是一段约 330° 的圆弧加一个箭头，也就是**一个几乎闭合的圆圈**，
         * 与 ReloadOutlined / SyncOutlined 的轮廓几乎无法区分——用户实际读成了
         * "旋转/刷新"。RollbackOutlined 是"箭头退回上一格"的方框造型，完全没有
         * 圆弧，跟刷新类图标不存在混淆空间；重做用它的水平镜像，方向对称，
         * 两个按钮并排时"往回 / 往前"一眼可读。
         * 镜像仍然是 Ant Design 的图标资产，没有自绘 SVG（docs/ui-redesign.md §六）。
         *
         * 另外配上文字：15px 下 RollbackOutlined 的方框比里面的箭头抢眼，光看图标
         * 仍要犹豫一下。docs/ui-redesign.md §六 允许"工具条这类空间紧张且动作高频
         * 的地方"用图标加文字——撤销/重做正是编辑器里最高频的两个动作，值得花这点
         * 横向空间换取零歧义。步骤条在 `1fr auto 1fr` 的中列，不受左侧变宽影响。
         */}
        <button
          type="button"
          className="ghost small"
          disabled={!canUndo}
          onClick={() => void undo()}
          title="撤销 (Ctrl/Cmd+Z)"
          aria-label={t('common.undo')}
        >
          <RollbackOutlined /> {t('common.undo')}
        </button>
        <button
          type="button"
          className="ghost small"
          disabled={!canRedo}
          onClick={() => void redo()}
          title="重做 (Shift+Ctrl/Cmd+Z)"
          aria-label={t('common.redo')}
        >
          <RollbackOutlined style={{ transform: 'scaleX(-1)' }} /> {t('common.redo')}
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

      {/*
        这里**不放"导出"按钮**。它曾经存在，onClick 就是 onStep('export')，
        与步骤条里的「导出」是同一个目的地——纯重复，且步骤条那个还多带完成状态。
        与"两个播放按钮"是同一类问题：同一个动作只应在一处出现（docs/ui-redesign.md §五）。

        若将来要在顶栏放一个终极动作，它必须是**真的开始导出**（带当前设置直接起任务），
        而不是又一个跳转入口；否则不要加。
      */}
      <div className="topbar__side topbar__side--end">
        {project && (
          <span className="topbar__meta num">
            {t('topbar.lineCount', { n: project.lines.length })} · {formatDuration(project.duration_ms)}
          </span>
        )}
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
