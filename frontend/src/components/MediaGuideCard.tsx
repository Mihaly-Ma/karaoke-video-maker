import { SoundOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useRef, useState } from 'react'

import * as api from '../api/client'
import type { GuideParams, GuideStatus, Project } from '../api/types'
import { t } from '../i18n'
import { useProject } from '../state/projectStore'
import JobProgress from './JobProgress'

/**
 * 「素材」舞台的**引导声**（ガイドメロディ）入口：生成 + 调参。
 *
 * ## 为什么它属于素材页
 *
 * 引导声是人声轨的派生物，和分离出的 stem、编辑代理是同一类东西——先做好、
 * 后面反复用。更实际的理由是**它好不好用只能靠耳朵判断**：参数改完必须马上听得到，
 * 等到导出才发现跑调，一次几分钟的烧录就白费了。所以生成放在这里，试听走下面
 * 那张引导声音轨卡片（与人声/伴奏同一个组件）。
 *
 * ## 为什么参数只有五个
 *
 * 后端 `GuideConfig` 有十几个字段，其中绝大多数是 f0 管线的标准步骤或按实测间隙
 * 分布定死的阈值（CLAUDE.md §8.9），用户既没有判据去调，调了也只会把那套结论推翻。
 * 这里留下的五个各自对应一句真实的抱怨：太响/太轻、太尖或被埋掉、太亮或太闷、
 * 弱唱处没声音、一顿一顿。
 *
 * ## 为什么改参数不自动重新生成
 *
 * 整曲跑一次 CREPE 要十几到几十秒（本机 4:43 实测 16s）。每拖一下滑块就重算不可
 * 接受，debounce 也只是把这件事推迟——用户连着调三个参数就会排三次队。所以改参数
 * 只保存（占一格撤销，参数是用户意图），重新生成由用户显式按按钮。
 * 中间那段"参数改了、产物还是旧的"由后端的 `stale` 如实报出来，不假装已生效。
 */

interface MediaGuideCardProps {
  project: Project
}

/** 一个滑块参数的定义。`step` 与范围直接对着后端 `GuideParamsDTO` 的取值域。 */
interface SliderSpec {
  key: 'gain' | 'max_harmonics' | 'voicing_drop_db' | 'legato_gap_ms'
  min: number
  max: number
  step: number
  /** 值的显示形式（带单位）。数值一律等宽对齐（docs/ui-redesign.md §六） */
  format: (v: number) => string
}

const SLIDERS: SliderSpec[] = [
  { key: 'gain', min: 0.02, max: 0.4, step: 0.01, format: (v) => v.toFixed(2) },
  { key: 'max_harmonics', min: 1, max: 32, step: 1, format: (v) => String(v) },
  { key: 'voicing_drop_db', min: -40, max: -12, step: 1, format: (v) => `${v} dB` },
  { key: 'legato_gap_ms', min: 0, max: 500, step: 10, format: (v) => `${v} ms` },
]

const TIMBRES: GuideParams['timbre'][] = ['sine', 'triangle', 'square', 'saw']

export default function MediaGuideCard({ project }: MediaGuideCardProps) {
  const refresh = useProject((s) => s.refresh)

  const [status, setStatus] = useState<GuideStatus | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  /**
   * 本地草稿。滑块拖动期间只改它，松手（`onChange` 之后的显式保存）才写后端——
   * 拖一次滑块是几十次 change 事件，每次都写工程等于几十格撤销。
   */
  const [draft, setDraft] = useState<GuideParams>(project.guide)

  const projectId = project.id
  const hasVocals = !!project.vocals_path
  const guidePath = project.guide_audio_path
  const saved = project.guide

  // 工程换了、或人声/引导声轨变了，重新问一次后端。**不能只看 guide_audio_path
  // 有没有值**：文件可能已被清掉，或产物是旧参数生成的——那两件事只有后端答得了。
  useEffect(() => {
    let alive = true
    void api
      .guideStatus(projectId)
      .then((st) => {
        if (!alive) return
        setStatus(st)
        if (st.job && (st.job.state === 'pending' || st.job.state === 'running')) {
          setJobId(st.job.job_id)
        }
      })
      .catch(() => {
        if (alive) setStatus(null)
      })
    return () => {
      alive = false
    }
  }, [projectId, project.vocals_path, guidePath, project.guide_signature])

  /**
   * 工程侧的参数**取值**变了（换工程、撤销/重做）才把草稿对齐回去。
   *
   * 依赖只能是取值本身，不能是 `saved` 这个对象：每次 `refresh()` 都会造一个新对象
   * （素材页有好几个卡片在轮询任务），直接依赖它就会在用户拖滑块的中途把滑块按回去。
   * 值经 ref 读取，effect 的依赖里因此只剩一个由取值拼出来的字符串。
   */
  const savedRef = useRef(saved)
  savedRef.current = saved
  const savedKey = `${saved.gain}|${saved.timbre}|${saved.max_harmonics}|${saved.voicing_drop_db}|${saved.legato_gap_ms}`
  useEffect(() => {
    setDraft(savedRef.current)
  }, [projectId, savedKey])

  /** 草稿与工程里存着的那组是否已经不同（决定要不要提示"改了还没保存/生成"）。 */
  const dirty = SLIDERS.some((s) => draft[s.key] !== saved[s.key]) || draft.timbre !== saved.timbre

  const start = useCallback(async () => {
    setError(null)
    try {
      // 参数与生成一起提交：后端会先存参数（一格撤销）再合成，
      // 中间不会出现"参数存了、产物还没跟上"以外的第三种状态。
      //
      // **不传 force**：缓存键是 `(人声轨哈希, 参数, 版本)`，命中就意味着磁盘上
      // 那份本来就是这组参数的产物，重算一遍只会白等几十秒——而且 CREPE 推理
      // 不是逐比特可复现的（§8.9），重算反而可能给出一条略有差别的轨。
      const job = await api.buildGuide(projectId, draft)
      setJobId(job.job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [projectId, draft])

  const saveOnly = useCallback(
    async (next: GuideParams) => {
      setError(null)
      try {
        await api.setGuideParams(projectId, next)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [projectId, refresh],
  )

  const onSettled = useCallback(async () => {
    await refresh()
    setStatus(await api.guideStatus(projectId).catch(() => null))
    setJobId(null)
  }, [projectId, refresh])

  const ready = status?.ready ?? !!guidePath
  const stale = status?.stale ?? false
  const running = !!jobId
  const tone = running ? 'busy' : !hasVocals ? 'idle' : stale || dirty ? 'action' : ready ? 'ready' : 'action'

  const stateText = running
    ? t('media.guide.buildingState')
    : !hasVocals
      ? t('media.guide.needVocals')
      : dirty
        ? t('media.guide.unsaved')
        : stale
          ? t('media.guide.stale')
          : ready
            ? t('common.ready')
            : t('media.guide.missing')

  return (
    <section className={`kvm-media-guide kvm-media-proxy kvm-media-proxy--${tone}`}>
      <div className="kvm-media-proxy__head">
        <SoundOutlined className="kvm-media-proxy__icon" />
        <span className="kvm-media-proxy__title">{t('media.guide.title')}</span>
        <span className="kvm-media-proxy__state" title={status?.note || undefined}>
          {stateText}
        </span>
        <button
          type="button"
          className="ghost"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          disabled={!hasVocals}
        >
          {t('media.guide.tune')}
        </button>
        <button
          type="button"
          className={ready && !stale && !dirty ? 'ghost' : 'primary'}
          onClick={() => void start()}
          // 缺前提时**禁用而不隐藏**，原因写在 title 里（CLAUDE.md §2.5）
          disabled={!hasVocals || running}
          title={hasVocals ? undefined : t('media.guide.needVocalsHint')}
        >
          {ready ? t('media.guide.rebuild') : t('media.guide.build')}
        </button>
      </div>

      {open && (
        <div className="kvm-guide-params">
          <label className="kvm-guide-param">
            <span className="kvm-guide-param__name">{t('media.guide.timbre')}</span>
            <select
              value={draft.timbre}
              data-testid="guide-timbre"
              onChange={(e) => {
                const next = { ...draft, timbre: e.target.value as GuideParams['timbre'] }
                setDraft(next)
                void saveOnly(next)
              }}
            >
              {TIMBRES.map((tb) => (
                <option key={tb} value={tb}>
                  {t(`media.guide.timbre.${tb}`)}
                </option>
              ))}
            </select>
            <span className="kvm-guide-param__hint">{t('media.guide.timbre.hint')}</span>
          </label>

          {SLIDERS.map((spec) => {
            // 谐波数对正弦无效（它只有基波）——**禁用并说明**，
            // 而不是让用户拖一个不起作用的滑块
            const inert = spec.key === 'max_harmonics' && draft.timbre === 'sine'
            return (
              <label key={spec.key} className="kvm-guide-param">
                <span className="kvm-guide-param__name">{t(`media.guide.${spec.key}`)}</span>
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={draft[spec.key]}
                  disabled={inert}
                  data-testid={`guide-${spec.key}`}
                  title={inert ? t('media.guide.max_harmonics.inert') : undefined}
                  onChange={(e) => setDraft({ ...draft, [spec.key]: Number(e.target.value) })}
                  // 拖动期间只动草稿，松手才写工程：一次拖拽有几十个 change 事件，
                  // 每个都写等于几十格撤销
                  onPointerUp={() => void saveOnly(draft)}
                  onKeyUp={() => void saveOnly(draft)}
                />
                <span className="kvm-guide-param__value num">{spec.format(draft[spec.key])}</span>
                <span className="kvm-guide-param__hint">
                  {inert
                    ? t('media.guide.max_harmonics.inert')
                    : t(`media.guide.${spec.key}.hint`)}
                </span>
              </label>
            )
          })}
        </div>
      )}

      {jobId && (
        <JobProgress
          jobId={jobId}
          label={t('media.guide.building')}
          onSettled={() => void onSettled()}
          onDismiss={() => setJobId(null)}
        />
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
