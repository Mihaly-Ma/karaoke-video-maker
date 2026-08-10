import {
  DownloadOutlined,
  ExportOutlined,
  LoadingOutlined,
  PlaySquareOutlined,
  SettingOutlined,
  VideoCameraOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'

import * as api from '../api/client'
import type { ExportArtifact } from '../api/types'
import { t } from '../i18n'
import { formatMissing, renderedCharset, useFontCoverage } from '../lib/fontCoverage'
import { formatMs } from '../lib/timeScale'
import { useProject } from '../state/projectStore'
import ExportCueRail, { buildCues } from './ExportCueRail'
import { EXPORT_STAGE_CSS } from './ExportStageCss'
import Preview from './Preview'

/**
 * 导出舞台：左栏设置 + 产物，右侧一块大的最终预览。
 *
 * ## 为什么这一步要有预览
 *
 * 烧一条 4K 全片要几分钟，发现问题再回头代价极大。这块预览是**长任务前的最后
 * 一道检查点**：字幕位置对不对、配色对不对、音轨选对没有，都要在这里确认，
 * 而不是等成片出来才发现。
 *
 * 因此版面与 docs/ui-redesign.md §四「左设置 / 右产物」有一处刻意的偏离：
 * 产物列表挪进左栏与设置同列，把大区域让给预览。依据是同一份文档的核心原则
 * ——"中间舞台属于当前步骤的主对象"，而在导出前，主对象是**成片本身**；
 * 窄栏里的小画面确认不了字幕位置，等于没确认。
 *
 * ## 预览怎么反映导出设置
 *
 * 预览整个复用 `Preview`（全应用唯一的播放时钟，代理画面 + JASSUB 字幕 +
 * Web Audio 双 stem），本舞台不新建任何播放器——同一时刻只应存在一个 transport。
 *
 * - **音轨**：ON/OFF VOCAL 这个设置**就是** store 的 `audioMode`，不另存一份。
 *   两者共用一个状态，结构上不可能出现"设置选了伴奏、预览还在放原声"。
 *
 *   但共用是**单向**的：`Preview` 的试听混音台除了「原声 / 伴奏」两个与本设置
 *   一一对应的档，还有「仅人声」和分轨音量滑块，那些**纯属试听、绝不写回
 *   `audioMode`**。理由是 `audioMode` 只有两个取值、直接决定导出请求的
 *   `use_instrumental`——为核对咬字而 solo 一下人声，绝不能变成"导出一条只有
 *   人声的成片"。反过来在这里切 ON/OFF VOCAL 时预览会跟着切，那条同步保留。
 * - **字幕**：`Preview` 拉的 `/api/render/ass` 与导出走的是后端同一个
 *   `_build_ass_text`，样式、配色、注音、引导点完全一致。
 * - **引导声**：与 ON/OFF VOCAL 同一条纪律——这个勾选框**就是** store 的
 *   `guideEnabled`，预览的音频引擎按它决定引导声那一层出不出声，不另存一份。
 *   前提是素材页已经生成过引导声（`guide_audio_path`）；没有的话预览确实放不出来，
 *   界面上如实标注一条提示，并指出去哪里生成——**而不是笼统地说"预览不含引导声"**，
 *   那句话在能放出来之后就是错的。
 *
 * 预览画面用的是编辑用代理（540p H.264），导出一律烧在原始素材上
 * （CLAUDE.md §5.11.5），所以两者是**感知等价**而非像素一致（§5.12）——
 * 画面清晰度不同属预期，字幕的位置与配色才是这里要确认的东西。
 *
 * ## 字形预检为什么也放在这一步
 *
 * 缺字必须在渲染前拦截（CLAUDE.md §2.6 / §6.3），而"渲染"发生在两处：
 * 选字体时（样式舞台已有一道）与**这里**。这一道拦的是另一件事——
 * 用户在样式舞台之后又改了歌词、或换了工程，字体没动而字符集变了。
 * 长任务前的最后一道检查点本来就是这块面板存在的理由，字形属于同一类问题。
 *
 * **拦而不断**：缺字只是警告，导出按钮照常可用（§2.5 失败要降级、不能终止）。
 * 缺的可能只是一个用户根本不在乎的符号，为它锁死整条导出路径就是本末倒置。
 * 走的是与样式舞台同一个缓存，字体与歌词都没变时不会再发一次请求。
 */

interface ExportPanelProps {
  exportJobId: string | null
  onExportStart: (jobId: string) => void
  exportResult: string | null
}

/** 体积按量级取单位：3.2 MB 比 3202380 B 更容易判断"这条是不是整片"。 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * 后端给的是 Unix **秒**，乘 1000 才是 JS 的毫秒时间戳。
 *
 * 不显示秒：这个时间是用来分辨"同一变体导过的哪一次"的，精确到分钟绰绰有余，
 * 而完整的 `toLocaleString()` 在 360px 的窄栏里会把这一行挤到省略号。
 */
function formatTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

/**
 * 一条产物。
 *
 * **不显示绝对路径**：磁盘名是 `{工程id}_{任务id}.mp4`，一长串路径既占满整个
 * 窄栏，用户拿它也做不了任何事。真正用来分辨"哪一份是哪一份"的是**变体名 +
 * 导出时间**（同一变体可能导过好几次），体积与时长则用来判断这条是不是整片。
 * 路径排查问题时仍有用，收进整行的 title 悬停提示里，正常浏览时不占版面。
 */
function ArtifactRow({ item, projectId }: { item: ExportArtifact; projectId: string }) {
  return (
    <li className="exp-art" title={item.path}>
      <div className="exp-art__head">
        <span className="badge badge--ok">{item.variant_label}</span>
        <span className="exp-art__spacer" />
        {/*
          用 <a download> 而不是 fetch 成 Blob：成片实测 527 MB，Blob 会把整片
          读进内存；直链交给浏览器流式落盘，后端也支持 Range。
        */}
        <a
          className="exp-art__dl"
          href={api.exportDownloadUrl(projectId, item.id)}
          download
          aria-label={t('export.download')}
        >
          <DownloadOutlined /> {t('export.download')}
        </a>
      </div>
      {/* 细节独占一行：挤在变体名与下载按钮中间的话，最长的那一项必被省略号吃掉 */}
      <span className="exp-art__meta">
        {t('export.meta', {
          size: formatSize(item.size_bytes),
          duration: formatMs(item.duration_ms),
          time: formatTime(item.created_at),
        })}
      </span>
    </li>
  )
}

export default function ExportPanel({ exportJobId, onExportStart, exportResult }: ExportPanelProps) {
  const project = useProject((s) => s.project)
  const loadExports = useProject((s) => s.loadExports)
  // 音轨设置直接读写播放状态：设置与预览是同一个状态，不是两份互相同步的副本
  const audioMode = useProject((s) => s.audioMode)
  const setAudioMode = useProject((s) => s.setAudioMode)
  const setPlayhead = useProject((s) => s.setPlayhead)
  // 引导声开关与 ON/OFF VOCAL 一样存在 store 里：设置与预览是同一个状态，
  // 不是两份互相同步的副本，所以"勾了却听不到"在结构上不可能发生
  const withGuide = useProject((s) => s.guideEnabled)
  const setWithGuide = useProject((s) => s.setGuideEnabled)
  const [error, setError] = useState<string | null>(null)

  const projectId = project?.id ?? null
  const artifacts = project?.exports ?? []
  const hasInstrumental = !!project?.instrumental_path
  const hasVocals = !!project?.vocals_path
  /** 素材页已经生成过引导声——决定预览听不听得到（导出没有它也能现场合成） */
  const guideReady = !!project?.guide_audio_path
  const useInstrumental = audioMode === 'instrumental' && hasInstrumental

  const cues = useMemo(() => buildCues(project), [project])

  // 字形预检：查的是成片上会出现的全部字符（含制作名单），只查当前字体
  const charset = useMemo(() => renderedCharset(project), [project])
  const coverage = useFontCoverage(project?.style.font_name ?? '', charset)
  const missing = coverage.kind === 'done' ? coverage.result.missing : []
  const previewMissing = coverage.kind === 'done' ? coverage.result.preview_missing : []

  // 导出跑完（App 轮询到 done 后才会写 exportResult）重新拉一次清单。
  // 后端在把任务标 done **之前**就登记好了产物，所以这一拉必定拿得到。
  // 挂载时也拉一次：用户可能在别的窗口导出过。
  useEffect(() => {
    if (projectId) void loadExports()
  }, [projectId, exportResult, loadExports])

  /**
   * 上一个工程留下的 `audioMode` 可能指向一条本工程还没有的伴奏轨。
   * 不复位的话设置会显示 OFF VOCAL 而导出请求必被后端拒（400），
   * 用户看到的是一个"选了却用不了"的选项。
   */
  useEffect(() => {
    if (audioMode === 'instrumental' && !hasInstrumental) setAudioMode('original')
  }, [audioMode, hasInstrumental, setAudioMode])

  /** 人声轨没了就把引导声一起关掉，理由同上：后端会直接 400 */
  useEffect(() => {
    if (!hasVocals) setWithGuide(false)
  }, [hasVocals, setWithGuide])

  /**
   * 离开本舞台时停播（docs/ui-redesign.md §五：切换步骤时上一个舞台的播放
   * 自动停止）。不停的话 `playing` 还留在 store 里，下一个挂 Preview 的舞台
   * 一进去就自己响起来。
   */
  useEffect(() => () => useProject.getState().setPlaying(false), [])

  if (!project) return <p className="stage__empty">{t('common.selectProjectFirst')}</p>

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
    <div className="exp-stage">
      <style>{EXPORT_STAGE_CSS}</style>

      <aside className="exp-side">
        <section className="exp-card">
          <h3 className="exp-card__title">
            <SettingOutlined /> {t('export.settings')}
          </h3>

          <div className="exp-field">
            <span className="exp-field__label">{t('export.track')}</span>
            <div className="exp-seg" role="group" aria-label={t('export.track')}>
              <button
                type="button"
                className={`exp-seg__item${useInstrumental ? '' : ' exp-seg__item--active'}`}
                aria-pressed={!useInstrumental}
                onClick={() => setAudioMode('original')}
              >
                {t('export.trackOn')}
              </button>
              <button
                type="button"
                className={`exp-seg__item${useInstrumental ? ' exp-seg__item--active' : ''}`}
                aria-pressed={useInstrumental}
                disabled={!hasInstrumental}
                title={hasInstrumental ? undefined : t('export.instrumentalMissing')}
                onClick={() => setAudioMode('instrumental')}
              >
                {t('export.trackOff')}
              </button>
            </div>
          </div>

          <label className="checkbox-row" title={hasVocals ? '' : t('export.withGuideMissing')}>
            <input
              type="checkbox"
              checked={withGuide}
              disabled={!hasVocals}
              onChange={(e) => setWithGuide(e.target.checked)}
            />
            {t('export.withGuide')}
          </label>

          {/*
            缺字警告紧贴导出按钮：一次烧录几分钟，这条必须在按下之前被看到。
            **不禁用按钮**——缺的可能只是一个用户不在乎的符号（§2.5 降级不终止）。
          */}
          {missing.length > 0 && (
            <p className="exp-warn" data-testid="export-glyph-warn">
              <WarningOutlined />
              <span>
                {t('export.glyphMissing', {
                  n: missing.length,
                  chars: formatMissing(missing, 12),
                })}
                <br />
                {t('export.glyphHint')}
              </span>
            </p>
          )}

          <button type="button" className="primary" onClick={() => void start()} disabled={!!exportJobId}>
            {exportJobId ? <LoadingOutlined /> : <ExportOutlined />}{' '}
            {exportJobId ? t('export.running') : t('export.start')}
          </button>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="exp-card">
          <h3 className="exp-card__title">
            <VideoCameraOutlined /> {t('export.artifacts')}
          </h3>
          {artifacts.length === 0 ? (
            <p className="muted">{t('export.empty')}</p>
          ) : (
            <ul className="exp-arts">
              {artifacts.map((item) => (
                <ArtifactRow key={item.id} item={item} projectId={project.id} />
              ))}
            </ul>
          )}
        </section>
      </aside>

      <div className="exp-main">
        <div className="exp-head">
          <PlaySquareOutlined />
          <span className="exp-head__title">{t('export.preview')}</span>
          <span className="exp-head__spacer" />
          {/* 预览与成片的差异如实标出，不让用户以为看到的就是最终画面 */}
          {project.proxy_video_path && <span className="badge">{t('export.previewProxy')}</span>}
          {/*
            引导声：**生成过就真能听到**，此时不该再挂一条"预览不含引导声"的警告
            ——那句话在有产物之后就是错的。只有勾了却还没生成时才提示，
            并说明去哪里生成（§2.5：报错要说清出了什么事和怎么办）。
          */}
          {withGuide && !guideReady && (
            <span
              className="badge exp-tag--warn"
              data-testid="export-guide-missing"
              title={t('export.previewGuideMissingHint')}
            >
              {t('export.previewGuideMissing')}
            </span>
          )}
          {withGuide && guideReady && (
            <span className="badge" data-testid="export-guide-on">
              {t('export.previewGuideOn')}
            </span>
          )}
          {/*
            第三处差异：预览字体是子集化产物，字符集比系统原字体小得多，
            这些字**只有预览缺、成片是好的**。不标出来的话用户会以为成片也坏了，
            回头去换字体——而换字体解决不了这个方向的分叉。
          */}
          {previewMissing.length > 0 && (
            <span className="badge exp-tag--warn" title={previewMissing.join(' ')} data-testid="export-preview-gap">
              {t('export.previewGlyphGap', { n: previewMissing.length })}
            </span>
          )}
        </div>

        <div className="exp-viewport">
          {/*
            复用全应用唯一的播放时钟：它自己会挑代理画面、拉后端 ASS 挂 JASSUB、
            并按 store 的 audioMode 在原声/伴奏之间交叉淡入。本舞台一行播放逻辑都不写。
          */}
          <Preview className="exp-preview" />
        </div>

        {/* 跳转只写"意图"（playheadMs），真正的 seek 由 Preview 执行 */}
        <ExportCueRail cues={cues} onJump={setPlayhead} />
      </div>
    </div>
  )
}
