import { InboxOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'

import * as api from '../api/client'
import { t } from '../i18n'
import { useProject } from '../state/projectStore'
import type { Project } from '../api/types'
import MediaGuideCard from './MediaGuideCard'
import MediaProxyCard from './MediaProxyCard'
import MediaTrackCard, { trackPath, type TrackKind } from './MediaTrackCard'
import MediaVideoPreview from './MediaVideoPreview'

/**
 * 「素材」舞台：判断的是**素材质量是否合格**（docs/ui-redesign.md §四"素材"）。
 *
 * 布局：左侧是获取入口（下载链接 / 拖放本地文件 / 分离档位），右侧上方是画面
 * 预览、下方是各条音轨卡片。这不是随意的两栏——判断"下载有没有坏、分离好不好"
 * 分别要靠**眼睛**（画面）和**耳朵**（逐条试听），两者都必须在这一步的主区域
 * 里，不能藏进次级 tab。
 *
 * CLAUDE.md §2.5：自动环节必须有等价的手工旁路，且旁路不能藏起来——因此下载
 * 与拖放导入并列展示，分离与"导入已分离音轨"并列展示，代理生成失败时预览
 * 自动回退用原始视频，不阻断这一步。
 */

/** 一个人声分离档位，对应后端 `SeparateModelTier`（`GET /api/media/separate/models`）。 */
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
 * audio-separator 的命名空间，前端硬编码它是历史上"标准"/"最佳"两档一点就报
 * `Model file ... not found` 的根因：换模型/调档位现在只改后端一处。
 */
const FALLBACK_TIERS: SeparateTier[] = [
  { id: 'fast', label: t('media.tierName.fast'), model_filename: '', hint: '', recommended: true, warning: '' },
  { id: 'standard', label: t('media.tierName.standard'), model_filename: '', hint: '', recommended: false, warning: '' },
  { id: 'best', label: t('media.tierName.best'), model_filename: '', hint: '', recommended: false, warning: '' },
]

/**
 * 已知档位 id → 短选型依据（速度/质量取舍，用户真正要的决策依据）。
 *
 * 后端 `hint` 字段是完整说明，适合当 `title` 悬浮详情，但界面主文案要短
 * （docs/ui-redesign.md §六"文案：短，且准确"），所以可见文字用这张短表，
 * 完整说明仍通过 title 属性保留，不丢信息。
 *
 * **这张表与档位名并排显示，所以绝不能是档位名的同义词。** 它写的是体积与
 * 速度倍率这类可比的数字；曾经写成"最快/均衡/最高质量"，于是界面上出现
 * 「快速 最快」「标准 均衡」，占了两个词却没给出任何新信息。
 */
const TIER_SHORT_HINT: Record<string, string> = {
  fast: 'media.tier.fast',
  standard: 'media.tier.standard',
  best: 'media.tier.best',
}

// 引导声排在最后：它是人声轨的派生物，先有人声才谈得上它。
const TRACK_ORDER: TrackKind[] = ['audio', 'vocals', 'instrumental', 'drums', 'guide']

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
  /** 由工作流导航指定，仅做视觉引导，不影响功能。 */
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
  const urlInputRef = useRef<HTMLInputElement>(null)

  const [tiers, setTiers] = useState<SeparateTier[]>(FALLBACK_TIERS)
  const [tiersFallback, setTiersFallback] = useState(false)
  /** null 表示"用户还没选"，此时跟随后端标记的推荐档，避免异步拿到档位表时把用户的选择顶掉。 */
  const [model, setModel] = useState<string | null>(null)
  const [separateError, setSeparateError] = useState<string | null>(null)

  const [importError, setImportError] = useState<string | null>(null)
  const [importingKind, setImportingKind] = useState<
    null | 'video' | 'audio' | 'vocals' | 'instrumental' | 'drums'
  >(null)
  const [dragOverKind, setDragOverKind] = useState<'video' | 'audio' | null>(null)

  const videoFileRef = useRef<HTMLInputElement>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)
  const vocalsFileRef = useRef<HTMLInputElement>(null)
  const instrumentalFileRef = useRef<HTMLInputElement>(null)
  const drumsFileRef = useRef<HTMLInputElement>(null)
  // `useRef(...).current` 而不是普通对象字面量：包一层 ref 让这个查找表的
  // 引用在渲染间保持恒定，handleImport 的 useCallback 才能放心把它当稳定依赖
  // （不放心就得整个禁用 exhaustive-deps，这里没必要）。
  const fileInputRefs = useRef({
    video: videoFileRef,
    audio: audioFileRef,
    vocals: vocalsFileRef,
    instrumental: instrumentalFileRef,
    drums: drumsFileRef,
  }).current

  /** 独占播放：同一时刻只有一路声音在响（画面预览的 <video> 或某一条 stem）。 */
  const activeMediaRef = useRef<HTMLMediaElement | null>(null)
  const claimPlayback = useCallback((el: HTMLMediaElement) => {
    const prev = activeMediaRef.current
    if (prev && prev !== el) prev.pause()
    activeMediaRef.current = el
  }, [])

  /**
   * 波形解码排队：同一时刻只让一张卡片的 wavesurfer 工作。
   *
   * 本工程的音频一律是未压缩 PCM WAV（见 backend/kvm/media/download.py、
   * separate.py），一首 4-5 分钟的曲子就有几十 MB，四条 stem 同时起
   * wavesurfer（各自完整 fetch + decode）在解码这端会有明显的主线程/内存尖峰。
   * 用一个"已完成数"做门槛，按固定顺序（原始音频→人声→伴奏→鼓声）逐条放行，
   * 波形是全自动出现的，用户不需要点什么，只是不会四条同时开始。
   */
  const [waveSettledCount, setWaveSettledCount] = useState(0)
  const handleWaveSettled = useCallback(() => setWaveSettledCount((n) => n + 1), [])

  const projectId = project?.id

  useEffect(() => {
    setWaveSettledCount(0)
  }, [projectId])

  useEffect(() => {
    if (focusSection === 'download') urlInputRef.current?.focus()
  }, [focusSection])

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

  const selectedModel = model ?? tiers.find((tr) => tr.recommended)?.id ?? tiers[0]?.id ?? 'fast'

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

  const handleImport = useCallback(
    async (kind: 'video' | 'audio' | 'vocals' | 'instrumental' | 'drums', file: File | undefined) => {
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
        // 清空对应的 <input type=file>，否则再次选中同一个文件时 onChange 不会
        // 触发（浏览器只在 value 变化时才触发该事件）。
        const ref = fileInputRefs[kind].current
        if (ref) ref.value = ''
      }
    },
    [projectId, refresh, fileInputRefs],
  )

  const onDropFile = useCallback(
    (kind: 'video' | 'audio') => (e: DragEvent<HTMLLabelElement>) => {
      e.preventDefault()
      setDragOverKind(null)
      const file = e.dataTransfer.files?.[0]
      if (file) void handleImport(kind, file)
    },
    [handleImport],
  )

  if (!project) {
    return (
      <div className="panel kvm-media">
        <p className="hint">{t('common.selectProjectFirst')}</p>
      </div>
    )
  }

  return (
    <div className="panel kvm-media">
      <style>{CSS}</style>

      <div className="kvm-media__grid">
        {/* ---- 左：获取入口 ---- */}
        <div className="kvm-media__col">
          <section
            className={`kvm-media-acq${focusSection === 'download' ? ' kvm-media-acq--focus' : ''}`}
          >
            <h3>{t('media.acquire.title')}</h3>

            <div className="kvm-media-status">
              <span className={`badge${project.video_path ? ' badge--ok' : ''}`}>
                {t('media.track.video')} {project.video_path ? t('common.ready') : t('media.status.missing')}
              </span>
              <span className={`badge${project.audio_path ? ' badge--ok' : ''}`}>
                {t('media.track.audio')} {project.audio_path ? t('common.ready') : t('media.status.missing')}
              </span>
            </div>

            <div className="kvm-media-row">
              <input
                ref={urlInputRef}
                type="text"
                placeholder={t('media.download.placeholder')}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void startDownload()
                }}
              />
              <button
                type="button"
                className="primary"
                onClick={() => void startDownload()}
                disabled={!url.trim() || !!downloadJobId}
              >
                {downloadJobId ? t('media.download.downloading') : t('media.download.button')}
              </button>
            </div>
            {downloadError && <p className="error">{downloadError}</p>}

            <label
              className={`kvm-media-dropzone${dragOverKind === 'video' ? ' kvm-media-dropzone--over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverKind('video')
              }}
              onDragLeave={() => setDragOverKind((k) => (k === 'video' ? null : k))}
              onDrop={onDropFile('video')}
            >
              <InboxOutlined className="kvm-media-dropzone__icon" />
              <span>{importingKind === 'video' ? t('media.local.importing') : t('media.local.dropVideo')}</span>
              <input
                ref={videoFileRef}
                type="file"
                accept="video/*"
                onChange={(e) => void handleImport('video', e.target.files?.[0])}
              />
            </label>
            <label
              className={`kvm-media-dropzone${dragOverKind === 'audio' ? ' kvm-media-dropzone--over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverKind('audio')
              }}
              onDragLeave={() => setDragOverKind((k) => (k === 'audio' ? null : k))}
              onDrop={onDropFile('audio')}
            >
              <InboxOutlined className="kvm-media-dropzone__icon" />
              <span>{importingKind === 'audio' ? t('media.local.importing') : t('media.local.dropAudio')}</span>
              <input
                ref={audioFileRef}
                type="file"
                accept="audio/*"
                onChange={(e) => void handleImport('audio', e.target.files?.[0])}
              />
            </label>
            {importError && <p className="error">{importError}</p>}
          </section>

          <section
            className={`kvm-media-acq${focusSection === 'separate' ? ' kvm-media-acq--focus' : ''}`}
          >
            <h3>{t('media.separate.title')}</h3>
            <p className="hint">{t('media.separate.optional')}</p>

            <div className="kvm-media-status">
              <span className={`badge${project.vocals_path ? ' badge--ok' : ''}`}>
                {t('media.track.vocals')} {project.vocals_path ? t('common.ready') : t('media.status.missing')}
              </span>
              <span className={`badge${project.instrumental_path ? ' badge--ok' : ''}`}>
                {t('media.track.instrumental')}{' '}
                {project.instrumental_path ? t('common.ready') : t('media.status.missing')}
              </span>
            </div>

            <div className="kvm-media-tiers">
              {tiers.map((tr) => (
                <div key={tr.id}>
                  <label className="kvm-media-tier">
                    <input
                      type="radio"
                      name="separate-model"
                      value={tr.id}
                      checked={selectedModel === tr.id}
                      onChange={() => setModel(tr.id)}
                    />
                    <span className="kvm-media-tier__label">{tr.label}</span>
                    {tr.recommended && (
                      <span className="kvm-media-tier__badge">{t('media.separate.recommended')}</span>
                    )}
                    <span className="kvm-media-tier__hint" title={tr.hint || undefined}>
                      {t(TIER_SHORT_HINT[tr.id] ?? 'media.tier.generic')}
                    </span>
                  </label>
                  {tr.warning && <p className="error">{tr.warning}</p>}
                </div>
              ))}
            </div>
            {tiersFallback && <p className="hint">{t('media.separate.fallbackNote')}</p>}

            <button
              type="button"
              className="primary"
              onClick={() => void startSeparate()}
              disabled={(!project.audio_path && !project.video_path) || !!separateJobId}
            >
              {separateJobId ? t('media.separate.running') : t('media.separate.start')}
            </button>
            {separateError && <p className="error">{separateError}</p>}

            <div className="kvm-media-manual">
              <span>{t('media.separate.manualTitle')}</span>
              <label>
                {t('media.track.vocals')}
                <input
                  ref={vocalsFileRef}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => void handleImport('vocals', e.target.files?.[0])}
                />
              </label>
              <label>
                {t('media.track.instrumental')}
                <input
                  ref={instrumentalFileRef}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => void handleImport('instrumental', e.target.files?.[0])}
                />
              </label>
              <label title={t('media.separate.drumsHint')}>
                {t('media.track.drums')}
                <input
                  ref={drumsFileRef}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => void handleImport('drums', e.target.files?.[0])}
                />
              </label>
              {(importingKind === 'vocals' || importingKind === 'instrumental' || importingKind === 'drums') && (
                <span className="muted">{t('media.local.importing')}</span>
              )}
            </div>
          </section>
        </div>

        {/* ---- 右：编辑代理 + 画面预览 + 音轨卡片 ---- */}
        <div className="kvm-media__col">
          {/* 代理排在最上：没有它 Safari 直接没画面，是本步骤的关键产物而不是
              可选加速项，理由见 MediaProxyCard 头部注释 */}
          <MediaProxyCard project={project} />
          {/* 引导声：与代理并列的一件派生素材。生成入口在这里，试听走下面那张
              「引导声」音轨卡片——判断它好不好用只能靠耳朵 */}
          <MediaGuideCard project={project} />
          <MediaVideoPreview project={project} onPlayback={claimPlayback} />

          <div className="kvm-media-tracks">
            {(() => {
              // 只在真实存在的 stem 之间排队（空位不占用队号，见组件头部注释），
              // 顺序固定为原始音频→人声→伴奏→鼓声。
              const existing = TRACK_ORDER.filter((k) => trackPath(project, k))
              return TRACK_ORDER.map((kind) => {
                const existingIndex = existing.indexOf(kind)
                return (
                  <MediaTrackCard
                    key={kind}
                    projectId={project.id}
                    kind={kind}
                    label={t(`media.track.${kind}`)}
                    path={trackPath(project, kind)}
                    waveTurn={existingIndex >= 0 && existingIndex <= waveSettledCount}
                    onWaveSettled={handleWaveSettled}
                    onPlayback={claimPlayback}
                  />
                )
              })
            })()}
          </div>
        </div>
      </div>
    </div>
  )
}

const CSS = `
.kvm-media {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
.kvm-media__grid {
  display: grid;
  grid-template-columns: minmax(260px, 320px) 1fr;
  gap: var(--sp-5);
  align-items: start;
}
@media (max-width: 720px) {
  .kvm-media__grid { grid-template-columns: 1fr; }
}
.kvm-media__col {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  min-width: 0;
}

.kvm-media-acq {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.kvm-media-acq--focus {
  outline: 1px solid var(--accent);
  outline-offset: var(--sp-2);
  border-radius: var(--r-md);
}

.kvm-media-row {
  display: flex;
  gap: var(--sp-1);
}
.kvm-media-row input[type='text'] {
  flex: 1 1 auto;
}

.kvm-media-dropzone {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px dashed var(--stroke-strong);
  border-radius: var(--r-md);
  color: var(--fg-2);
  cursor: pointer;
  font-size: var(--fs-sm);
}
.kvm-media-dropzone:hover,
.kvm-media-dropzone--over {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--fg);
}
.kvm-media-dropzone input[type='file'] {
  display: none;
}
.kvm-media-dropzone__icon {
  font-size: var(--fs-xl);
  color: var(--fg-3);
  flex: 0 0 auto;
}

.kvm-media-status {
  display: flex;
  gap: var(--sp-1);
  flex-wrap: wrap;
}

.kvm-media-tiers {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.kvm-media-tier {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: var(--hairline);
  border-radius: var(--r-md);
  cursor: pointer;
  font-size: var(--fs-sm);
}
.kvm-media-tier:has(input:checked) {
  border-color: var(--accent);
  background: var(--bg-surface);
}
.kvm-media-tier__label {
  font-weight: 600;
  color: var(--fg);
}
.kvm-media-tier__badge {
  font-size: var(--fs-xs);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: var(--r-pill);
  padding: 0 var(--sp-1);
}
.kvm-media-tier__hint {
  margin-left: auto;
  color: var(--fg-2);
}

.kvm-media-manual {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  font-size: var(--fs-sm);
  color: var(--fg-2);
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--stroke);
}
.kvm-media-manual label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

/* ---- 编辑代理（右栏首块，最先进入视线） ---- */

.kvm-media-proxy {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  background: var(--bg-surface);
  border: var(--hairline);
  border-radius: var(--r-lg);
}
/* 需要用户动手时才染强调色；就绪后退回中性，避免一张永远高亮的卡片变成噪音 */
.kvm-media-proxy--action {
  background: var(--accent-weak);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--stroke));
}
.kvm-media-proxy--ready {
  border-color: color-mix(in srgb, var(--ok) 30%, var(--stroke));
}
.kvm-media-proxy__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.kvm-media-proxy__icon {
  font-size: var(--fs-lg);
  color: var(--accent);
  flex: 0 0 auto;
}
.kvm-media-proxy__title {
  font-weight: 600;
  color: var(--fg);
}
.kvm-media-proxy__state {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
  color: var(--fg-2);
  font-size: var(--fs-sm);
}
.kvm-media-proxy__dot--ok {
  color: var(--ok);
}
.kvm-media-proxy__dot--warn {
  color: var(--warn);
}

/* ---- 引导声：与代理同一张卡片的骨架（kvm-media-proxy），额外多一组参数 ---- */

.kvm-guide-params {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--stroke);
}
/* 每行：名称 / 控件 / 数值 / 说明。说明另起一行占满，短句不会被挤成省略号 */
.kvm-guide-param {
  display: grid;
  grid-template-columns: 4.5em minmax(80px, 1fr) 3.5em;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
}
.kvm-guide-param__name {
  color: var(--fg);
}
.kvm-guide-param__value {
  color: var(--fg-2);
  text-align: right;
}
.kvm-guide-param__hint {
  grid-column: 1 / -1;
  color: var(--fg-3);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
.kvm-guide-param input[type='range'] {
  width: 100%;
  min-width: 0;
}

/* ---- 画面预览 ---- */

.kvm-media-preview {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.kvm-media-preview__frame {
  position: relative;
  /* 预览呈现的是素材本身，不是界面外壳——这里刻意用真黑而不是 --bg-canvas，
     与对轴舞台 Preview.tsx 的画面区保持同一观感
     （docs/ui-redesign.md §六："预览区域不套用界面配色"）。 */
  background: #000;
  aspect-ratio: 16 / 9;
  border-radius: var(--r-lg);
  overflow: hidden;
}
.kvm-media-preview__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  background: #000;
}
.kvm-media-preview__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-3);
  font-size: var(--fs-sm);
  text-align: center;
  padding: var(--sp-4);
}
.kvm-media-preview__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-wrap: wrap;
}
.kvm-media-preview__companion {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
  color: var(--fg-2);
  font-size: var(--fs-sm);
}
.kvm-media-preview__companion select {
  font-size: var(--fs-sm);
}

/* ---- 音轨卡片 ---- */

.kvm-media-tracks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.kvm-media-track {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--bg-surface);
  border: var(--hairline);
  border-radius: var(--r-lg);
}
.kvm-media-track--empty {
  opacity: 0.55;
}
.kvm-media-track__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.kvm-media-track__play {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-pill);
  border: none;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: var(--fs-lg);
  padding: 0;
}
.kvm-media-track__play:hover:not(:disabled) {
  filter: brightness(1.08);
}
.kvm-media-track__play:disabled {
  background: var(--bg-raise);
  color: var(--fg-3);
}
.kvm-media-track__label {
  font-weight: 600;
  color: var(--fg);
  flex: 0 0 auto;
}
.kvm-media-track__stats {
  display: flex;
  gap: var(--sp-3);
  margin-left: auto;
  color: var(--fg-2);
  font-size: var(--fs-sm);
}
.kvm-media-track__time {
  color: var(--fg);
}
.kvm-media-track__wave {
  position: relative;
  height: 44px;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-raise);
  touch-action: none; /* 指针拖动定位时不要被浏览器当成滚动手势吃掉 */
}
.kvm-media-track__wave--seekable {
  cursor: pointer;
}
/* 已播区域与播放头都覆盖在波形之上：Waveform 是纯渲染封装，不改它。
   z-index 必须显式给：wavesurfer 内部给自己的 canvas 层写了 z-index:2/5，
   不压过它，播放头会被波形本体盖掉、只在波峰之间的空隙里露一点点。 */
.kvm-media-track__played {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 6;
  background: var(--accent-weak);
  pointer-events: none;
}
.kvm-media-track__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 7;
  width: 2px;
  margin-left: -1px;
  background: var(--accent);
  pointer-events: none;
}
.kvm-media-track__wave-status {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-3);
  font-size: var(--fs-xs);
}
`
