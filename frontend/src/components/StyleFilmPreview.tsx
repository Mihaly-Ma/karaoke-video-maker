/**
 * 样式舞台的成片预览：**真实 JASSUB（libass）渲染的一句歌词**。
 *
 * 为什么不能用 CSS 近似（docs/ui-redesign.md §六点五已裁决）：这一步存在的全部
 * 意义就是确认成片观感，用近似等于没确认。描边跟着填充一起翻色是 nicokara 的
 * 招牌观感，而它靠的是"双层 + 渐进 clip"（CLAUDE.md §8.5），CSS 里没有对应物。
 *
 * 三个实现要点：
 *
 * 1. **字幕层挂在自备画布上，不挂视频**。样式这一步不需要画面，而工程可能压根
 *    还没有视频（只导入音轨是最常见的起点，CLAUDE.md §2.5）。挂法见
 *    `lib/jassub.ts` 的 `CanvasOverlayOptions`。
 * 2. **ASS 一律取自后端 /api/render/ass，整首拿、只把时钟停在这一句上**。
 *    前端不生成也不裁剪 ASS（CLAUDE.md §4.1）；"看某一句"就是把 libass 的时间
 *    拨到那一句的区间——这样连上下行错开、提前入场、引导点都是真的。
 * 3. **画布模式没有 rVFC，libass 不会自己动**。播放靠本组件的 rAF 循环逐帧调
 *    `renderAt`；暂停时改了样式必须显式重绘一帧，否则画面一直是旧的（§5.9）。
 *
 * 声音不参与：本舞台的 transport 形态是"播放这一句看扫色"（docs/ui-redesign.md §五），
 * 全局唯一的音频引擎在 Preview 里，而 Preview 只挂在对轴舞台。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CaretRightOutlined, PauseOutlined, WarningOutlined } from '@ant-design/icons'

import * as api from '../api/client'
import type { Line, Project } from '../api/types'
import { t } from '../i18n'
import {
  checkPreviewEnvironment,
  describeError,
  SubtitleOverlay,
  type PreviewIssue,
} from '../lib/jassub'
import { useProject } from '../state/projectStore'

/** 工程一变就重新拉 ASS 的防抖窗口：重建要走一次后端往返，远超一帧 */
const ASS_REFRESH_DEBOUNCE_MS = 120

/** 预览窗口在开唱前后各留出的余量（毫秒）：前面看得到入场，后面看得到收尾 */
const PRE_ROLL_MS = 800
const POST_ROLL_MS = 600

/**
 * 预览底色。**这三个值属于"成片长什么样"那套坐标系，不是界面 token**
 * （docs/ui-redesign.md §六：预览区域不套用界面配色）。
 *
 * 黑＝多数 MV 画面的暗部；绿＝工程没有画面时的纯色兜底（CLAUDE.md §5.8）；
 * 白＝亮画面，专门用来看白字的描边够不够——描边太细只在亮底上才暴露。
 */
const BACKDROPS = [
  { key: 'black', css: '#000000' },
  { key: 'green', css: '#005500' },
  { key: 'white', css: '#ffffff' },
] as const

type BackdropKey = (typeof BACKDROPS)[number]['key']

const KANJI = /[㐀-䶿一-鿿]/

function lineText(line: Line): string {
  return line.tokens.map((tk) => tk.text).join('')
}

function lineSpan(line: Line): { start: number; end: number } {
  const first = line.tokens[0]
  const last = line.tokens[line.tokens.length - 1]
  return { start: first.start_ms, end: last.start_ms + last.dur_ms }
}

/**
 * 默认预览句：**既有汉字又有注音、长度中等**（docs/ui-redesign.md §四「样式」）。
 *
 * 三个条件各有理由：有注音才看得到注音行的字号与间距；有汉字才看得出主文与注音
 * 两行的对齐；长度中等才既能看清逐字扫色、又不至于触发拆行而看不到常规版面。
 * 唱得太短的句子扫色一闪而过，等于没看到，所以额外扣分。
 */
function pickPreviewLine(lines: Line[]): Line | null {
  let best: Line | null = null
  let bestScore = -Infinity
  for (const line of lines) {
    const text = lineText(line)
    const { start, end } = lineSpan(line)
    let score = 0
    if (line.ruby.length > 0) score += 100
    if (KANJI.test(text)) score += 60
    score -= Math.abs(text.length - 14) * 2
    if (end - start < 800) score -= 80
    if (score > bestScore) {
      bestScore = score
      best = line
    }
  }
  return best
}

function formatSec(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}

export interface StyleFilmPreviewProps {
  project: Project
}

export default function StyleFilmPreview({ project }: StyleFilmPreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<SubtitleOverlay | null>(null)
  const scrubRef = useRef<HTMLInputElement | null>(null)
  const clockRef = useRef<HTMLSpanElement | null>(null)
  const activeChipRef = useRef<HTMLButtonElement | null>(null)
  /** 当前预览时刻（毫秒，全曲时间轴）。逐帧变化，放 ref 避免每帧重渲 */
  const posRef = useRef(0)
  const assTimerRef = useRef(0)
  const assInFlightRef = useRef(false)
  const assDirtyRef = useRef(false)

  const [lineId, setLineId] = useState<string | null>(null)
  const [backdrop, setBackdrop] = useState<BackdropKey>('black')
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<PreviewIssue[]>([])

  const envIssues = useMemo(() => checkPreviewEnvironment(), [])
  const fatal = useMemo(() => envIssues.filter((i) => i.level === 'fatal'), [envIssues])

  // 制作名单行（「词：xxx」这类）不是歌词，拿它确认样式看不出注音与扫色
  const lines = useMemo(
    () => project.lines.filter((l) => !l.is_metadata && l.tokens.length > 0),
    [project.lines],
  )
  const line = lines.find((l) => l.id === lineId) ?? null

  // 换工程、或选中的句子被别处编辑掉了，就重新挑一句默认的
  useEffect(() => {
    if (line) return
    setLineId(pickPreviewLine(lines)?.id ?? null)
  }, [line, lines])

  /*
   * 预览窗口一律用**数字**而不是对象表达。
   *
   * 后端每次编辑都返回一个全新的工程对象，`project.lines` 因此每次都是新数组、
   * 每个 Line 也都是新对象——把区间包成 `{from,to}` 再进依赖数组，改一次字号就会
   * 让下面所有 effect 重跑，正在播的那一句会被打断。数字只在时间真的变了才变。
   */
  const span = line ? lineSpan(line) : null
  const fromMs = span ? Math.max(0, span.start + project.global_offset_ms - PRE_ROLL_MS) : 0
  const toMs = span ? span.end + project.global_offset_ms + POST_ROLL_MS : 0
  const spanMs = Math.max(1, toMs - fromMs)

  const videoW = project.video_width > 0 ? project.video_width : 1920
  const videoH = project.video_height > 0 ? project.video_height : 1080
  const fontName = project.style.font_name
  const projectId = project.id
  const blocked = fatal.length > 0 || lines.length === 0

  /** 把播放位置同步到进度条与时钟文字。逐帧调用，走 DOM 不走 state */
  const showPos = useCallback(
    (ms: number) => {
      posRef.current = ms
      if (scrubRef.current) scrubRef.current.value = String(Math.round(ms - fromMs))
      if (clockRef.current) {
        clockRef.current.textContent = `${formatSec(ms - fromMs)} / ${formatSec(spanMs)}`
      }
    },
    [fromMs, spanMs],
  )

  // --- 字幕层：工程 / 字体 / 画面尺寸变化时重建 -----------------------------

  useEffect(() => {
    const host = hostRef.current
    if (!host || blocked) return

    let disposed = false
    let created: SubtitleOverlay | null = null
    /*
     * 画布命令式创建、交给 JASSUB 托管：JASSUB 的 destroy() 会把它从 DOM 里摘掉，
     * 若这个节点由 React 渲染，卸载时 React 会去删一个已经不在的节点。
     * 宿主 div 里不放任何 React 子节点，两边的 DOM 归属因此互不重叠。
     */
    const canvas = document.createElement('canvas')
    canvas.className = 'sty-film__canvas'
    host.appendChild(canvas)

    setError(null)
    setLoading(true)

    void (async () => {
      try {
        const { ass } = await api.buildAss(projectId)
        if (disposed) return
        created = await SubtitleOverlay.create({
          canvas,
          width: videoW,
          height: videoH,
          ass,
          fontFamily: fontName,
        })
        if (disposed) {
          void created.destroy()
          created = null
          return
        }
        overlayRef.current = created
        setWarnings(created.warnings)
        await created.renderAt(posRef.current, true)
      } catch (e) {
        if (!disposed) setError(describeError(e))
      } finally {
        if (!disposed) setLoading(false)
      }
    })()

    return () => {
      disposed = true
      overlayRef.current = null
      setLoading(false)
      void created?.destroy()
      // 创建失败时 JASSUB 没接管这块画布，得自己收
      canvas.remove()
    }
  }, [projectId, fontName, videoW, videoH, blocked])

  // --- ASS 刷新：改了样式参数 → 后端重新排版 → 重新喂给 libass -------------

  const refreshAss = useCallback(async (id: string): Promise<void> => {
    if (assInFlightRef.current) {
      assDirtyRef.current = true
      return
    }
    assInFlightRef.current = true
    try {
      do {
        assDirtyRef.current = false
        const { ass } = await api.buildAss(id)
        // update() 内部在应用完新轨后会强制重绘一帧——暂停时 libass 不会自己动
        // （CLAUDE.md §5.9），而样式舞台九成时间是暂停的。这里**不要**再补一次
        // renderAt：两次绘制并发会让 JASSUB 把强制重绘降级成普通重绘，
        // 画面反而停在旧的一帧（见 lib/jassub.ts 的 `paint`）。
        overlayRef.current?.update(ass)
        setError(null)
      } while (assDirtyRef.current)
    } catch (e) {
      setError(describeError(e))
    } finally {
      assInFlightRef.current = false
      assDirtyRef.current = false
    }
  }, [])

  // 用 store.subscribe 而不是 useEffect(…, [project])：订阅只在工程**变化**时触发，
  // 挂载那一次不会重复拉一遍上面刚拉过的 ASS
  useEffect(() => {
    return useProject.subscribe((state, prev) => {
      if (state.project === prev.project) return
      const id = state.project?.id
      if (!id || id !== prev.project?.id) return
      window.clearTimeout(assTimerRef.current)
      assTimerRef.current = window.setTimeout(() => void refreshAss(id), ASS_REFRESH_DEBOUNCE_MS)
    })
  }, [refreshAss])

  useEffect(() => () => window.clearTimeout(assTimerRef.current), [])

  // --- 换句子：停播、把时钟拨到入场点、重绘一帧 ---------------------------

  useEffect(() => {
    setPlaying(false)
    showPos(fromMs)
    void overlayRef.current?.renderAt(fromMs, true)
  }, [lineId, fromMs, showPos])

  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [lineId])

  // --- 播放这一句：画布模式没有 rVFC，时钟只能由这里推 ---------------------

  // 卸载时播放循环随这个 effect 一起取消 —— 切换步骤即停止播放，
  // transport 属于舞台（docs/ui-redesign.md §五），不需要另设全局开关
  useEffect(() => {
    if (!playing || !lineId) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const next = posRef.current + (now - last)
      last = now
      // 循环播：调样式时要反复看同一句扫过去，播一遍就停反而要不停点按钮
      showPos(next >= toMs ? fromMs : next)
      void overlayRef.current?.renderAt(posRef.current)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, lineId, fromMs, toMs, showPos])

  const onScrub = (raw: string) => {
    setPlaying(false)
    const ms = fromMs + Number(raw)
    showPos(ms)
    void overlayRef.current?.renderAt(ms, true)
  }

  const backdropCss = BACKDROPS.find((b) => b.key === backdrop)?.css ?? BACKDROPS[0].css
  const filmStyle = {
    background: backdropCss,
    '--sty-aspect': `${videoW} / ${videoH}`,
  } as CSSProperties

  return (
    <div className="sty-film-col">
      <div className="sty-bar">
        <span className="sty-bar__label">{t('style.preview.title')}</span>
        <span className="num">
          {videoW}×{videoH}
        </span>
        <span className="sty-bar__spacer" />
        <span className="sty-bar__label">{t('style.preview.backdrop')}</span>
        <span className="sty-chips">
          {BACKDROPS.map((b) => (
            <button
              key={b.key}
              type="button"
              className={`sty-chip${b.key === backdrop ? ' sty-chip--on' : ''}`}
              style={{ background: b.css }}
              title={t(`style.backdrop.${b.key}`)}
              aria-label={t(`style.backdrop.${b.key}`)}
              onClick={() => setBackdrop(b.key)}
            />
          ))}
        </span>
      </div>

      <div className="sty-film-wrap">
        {blocked ? (
          <div className="sty-empty">
            {fatal.length > 0 ? fatal.map((i) => i.title).join('；') : t('style.preview.noLines')}
          </div>
        ) : (
          <div className="sty-film" data-testid="style-film" style={filmStyle}>
            <div ref={hostRef} className="sty-film__host" />
            {loading && <div className="sty-film__note">{t('style.preview.loading')}</div>}
            {!loading && error && (
              <div className="sty-film__note">{t('style.preview.failed', { detail: error })}</div>
            )}
            {!loading && !error && warnings.length > 0 && (
              <div className="sty-film__note" title={warnings.map((w) => w.detail).join('\n')}>
                <WarningOutlined /> {warnings[0].title}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sty-transport">
        <button
          type="button"
          className="iconbtn"
          disabled={!lineId}
          aria-label={playing ? t('common.pause') : t('common.play')}
          title={playing ? t('common.pause') : t('style.preview.playLine')}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? <PauseOutlined /> : <CaretRightOutlined />}
        </button>
        <input
          ref={scrubRef}
          type="range"
          className="sty-transport__scrub"
          min={0}
          max={spanMs}
          defaultValue={0}
          disabled={!lineId}
          aria-label={t('style.preview.scrub')}
          onChange={(e) => onScrub(e.target.value)}
        />
        <span ref={clockRef} className="sty-transport__clock">
          {formatSec(0)} / {formatSec(spanMs)}
        </span>
      </div>

      <div className="sty-lines" data-testid="style-lines">
        {lines.map((l, i) => (
          <button
            key={l.id}
            ref={l.id === lineId ? activeChipRef : undefined}
            type="button"
            className={`sty-line${l.id === lineId ? ' sty-line--on' : ''}`}
            onClick={() => setLineId(l.id)}
          >
            <span className="sty-line__no">{i + 1}</span>
            <span className="sty-line__text">{lineText(l)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
