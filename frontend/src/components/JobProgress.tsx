import { useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import type { JobStatus } from '../api/types'

/**
 * 长任务进度条：下载 / 分离 / 导出都可能跑几十秒到几分钟。
 *
 * 组件只负责"轮询 + 展示 + 取消"，任务的发起（拿到 job_id）与任务结束后的
 * 收尾（刷新工程、清理状态）都交给调用方，通过 onSettled 回调完成——这样
 * 多个任务可以共用同一个组件，且父组件可以把 jobId 提升到不随面板切换而
 * 卸载的位置（见 App.tsx 的"任务栏"），避免用户切换工作流步骤时进度条消失。
 */

interface JobProgressProps {
  jobId: string
  /** 展示给用户的任务名称，例如"下载视频""人声分离""导出成片"。 */
  label: string
  /** 轮询间隔（毫秒），默认 800ms。 */
  intervalMs?: number
  /** 任务进入终态（done/failed/cancelled）时回调一次。 */
  onSettled?: (status: JobStatus) => void | Promise<void>
  /** 用户主动关闭这条进度条（不影响后端任务本身）。不传则不显示关闭按钮。 */
  onDismiss?: () => void
}

const STATE_LABEL: Record<JobStatus['state'], string> = {
  pending: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function toPercent(progress: number): number {
  // 约定 progress 是 0~1 的比例；防御性地兼容后端直接给 0~100 的写法，
  // 避免因为个位数百分比就把进度条渲染成"几乎不动"。
  const ratio = progress > 1 ? progress / 100 : progress
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

export default function JobProgress({ jobId, label, intervalMs = 800, onSettled, onDismiss }: JobProgressProps) {
  const [status, setStatus] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  // onSettled 在父组件里往往是每次渲染都新建的内联函数，不能把它放进
  // effect 依赖数组（会导致每次父组件重渲染都重启轮询）。用 ref 存住最新引用。
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const poll = async () => {
      try {
        const s = await api.jobStatus(jobId)
        if (cancelled) return
        setStatus(s)
        setError(null)
        const terminal = s.state === 'done' || s.state === 'failed' || s.state === 'cancelled'
        if (terminal) {
          if (!settled) {
            settled = true
            await onSettledRef.current?.(s)
          }
          return
        }
        timer = setTimeout(() => void poll(), intervalMs)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        // 轮询本身失败（例如后端重启中）时退避重试而不是放弃——长任务
        // 大概率还在跑，前端只是暂时联系不上。
        timer = setTimeout(() => void poll(), intervalMs * 2)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId, intervalMs])

  const handleCancel = async () => {
    setCancelling(true)
    try {
      const s = await api.cancelJob(jobId)
      setStatus(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCancelling(false)
    }
  }

  const state = status?.state ?? 'pending'
  const canCancel = state === 'pending' || state === 'running'
  const pct = toPercent(status?.progress ?? 0)

  return (
    <div className={`job-progress job-progress--${state}`}>
      <div className="job-progress__head">
        <span className="job-progress__label">{label}</span>
        <span className="job-progress__state">{STATE_LABEL[state]}</span>
        {onDismiss && (
          <button type="button" className="job-progress__dismiss" title="关闭（不影响后台任务）" onClick={onDismiss}>
            ×
          </button>
        )}
      </div>
      <div className="job-progress__bar">
        <div className="job-progress__bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="job-progress__foot">
        <span className="job-progress__message">{status?.message || `${pct}%`}</span>
        {canCancel && (
          <button type="button" className="ghost small" onClick={() => void handleCancel()} disabled={cancelling}>
            取消
          </button>
        )}
      </div>
      {state === 'failed' && status?.error && <p className="error">{status.error}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
