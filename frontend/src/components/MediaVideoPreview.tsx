import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import * as api from '../api/client'
import type { Project } from '../api/types'
import { t } from '../i18n'
import { useReleaseMediaOnUnmount } from '../lib/releaseMedia'
import { trackPath, type TrackKind } from './MediaTrackCard'

/**
 * 「素材」舞台右上的画面预览。
 *
 * 这一步存在的唯一理由是**看画面**（docs/ui-redesign.md §四"素材"）：下载可能
 * 拿到坏流、可能悄悄降级到 720p、可能音画不同步，这些问题不看画面根本发现不了。
 * 只需要能播、能拖，不挂字幕层——真正的所见即所得渲染是「对轴」舞台的 Preview
 * 组件的事。因此这里刻意用原生 `<video controls>`：拖动进度条、音量都是浏览器
 * 免费给的，不需要在这个纯粹的"看素材"场景里重新发明一套走带控件。
 *
 * ## 伴随音轨：为什么需要，以及为什么可以放宽同步
 *
 * 编辑用代理视频**没有音轨**（契约 D15：编辑器的 `<video>` 恒静音、音频全部走
 * Web Audio，给代理带音轨纯属浪费），所以这里直接播代理是**无声的**。要确认
 * "下载对不对、分离干不干净、音画同不同步"，必须能挑一条音轨伴着画面一起放。
 *
 * 同步用的是最朴素的做法：一个独立的 `<audio>` 跟着 `<video>` 起停、seek、变速，
 * 并在 rAF 里比对两者的 currentTime，漂移超过 `DRIFT_TOLERANCE_SEC` 才纠一次。
 * W3C 明确指出音频一旦经 `MediaElementAudioSourceNode` 离开 media element 就无法
 * 再与其他流保持同步，契约 §5.10 因此规定**对轴**那一步必须用 rVFC + Web Audio
 * 严格同步——但**这一步不是对轴**：它要回答的是"素材质量合不合格"，几十毫秒的
 * 漂移对这个判断毫无影响，而 Preview.tsx 那套严格时钟是全应用唯一的播放时钟、
 * 很脆弱，不该为了看一眼素材就复制一份出来。
 *
 * 放宽到什么程度：容差 120ms。选这个数是因为它明显小于人对音画不同步的察觉阈
 * （视频落后音频约 125ms / 视频超前约 45ms 起才普遍可察，ITU-R BT.1359），
 * 又足够大到不会因为两个媒体元素的正常抖动而反复 seek（每次 seek 都会带来一次
 * 可听的断音）。真要"严丝合缝"，那是对轴舞台的事。
 *
 * ## 播放归属
 *
 * 本组件不接入全局 store 的 playheadMs/playing——那一套是"对轴"舞台唯一时钟的
 * 专属机制。它只通过 onPlayback 参与"同一时刻只有一路声音"的独占协调：
 * **伴随音轨与画面是一体的、算一个 transport**，因此伴随音轨自己不去 claim，
 * 否则它会把刚刚开始播的画面顶掉。
 */

interface MediaVideoPreviewProps {
  project: Project
  /** 独占播放：开始播放前调用，父组件借此暂停其它正在响的音轨。 */
  onPlayback: (el: HTMLMediaElement) => void
}

/** 伴随音轨的候选顺序，与音轨卡片一致。 */
const COMPANION_ORDER: TrackKind[] = ['audio', 'vocals', 'instrumental', 'drums']

/** 音画允许的最大漂移（秒），超过才纠正。取值理由见文件头。 */
const DRIFT_TOLERANCE_SEC = 0.12

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function MediaVideoPreview({ project, onPlayback }: MediaVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useReleaseMediaOnUnmount(videoRef)
  const companionRef = useRef<HTMLAudioElement>(null)
  useReleaseMediaOnUnmount(companionRef)

  const [unplayable, setUnplayable] = useState(false)
  const [videoPlaying, setVideoPlaying] = useState(false)
  /** null = 用户还没选过，跟随默认；选过之后一律听用户的（包括显式选"静音"）。 */
  const [pick, setPick] = useState<TrackKind | 'none' | null>(null)

  const videoPath = project.video_path
  const proxyPath = project.proxy_video_path
  const videoKind: 'proxy' | 'video' = proxyPath ? 'proxy' : 'video'
  const hasVideo = !!videoPath

  const audioPath = project.audio_path
  const vocalsPath = project.vocals_path
  const instrumentalPath = project.instrumental_path
  const drumsPath = project.drums_path
  // 依赖具体路径而不是 project 对象：工程每次刷新都是新对象，挂在它上面会让
  // 下面那些以 available 为依赖的 memo/effect 无谓地重跑。
  const available = useMemo(
    () => COMPANION_ORDER.filter((k) => trackPath(project, k)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audioPath, vocalsPath, instrumentalPath, drumsPath],
  )

  // 默认挑原始音频——它是"下载对不对"的直接证据；没有就退到第一条存在的轨。
  const fallback: TrackKind | 'none' = available.includes('audio')
    ? 'audio'
    : (available[0] ?? 'none')
  const companion: TrackKind | 'none' =
    pick === 'none' || (pick !== null && available.includes(pick)) ? pick : fallback
  const companionSrc = companion === 'none' ? null : api.mediaUrl(project.id, companion)

  // 换了工程/换了视频文件，之前"放不了"的结论作废，重新给一次机会——代理刚
  // 生成出来时 proxyPath 会从 null 变成有值，那正是"刚才放不了、现在放得了"
  // 的典型时刻。
  useEffect(() => setUnplayable(false), [project.id, videoPath, proxyPath])

  /**
   * 把伴随音轨对到画面的时间上。
   * force=true 用于起播/seek/变速这类"位置已经确定跳变"的时刻，无条件对齐；
   * force=false 是播放中的常规巡检，只有漂移超过容差才动，避免频繁 seek 断音。
   */
  const alignCompanion = useCallback((force: boolean) => {
    const v = videoRef.current
    const a = companionRef.current
    if (!v || !a || !a.src) return
    if (a.playbackRate !== v.playbackRate) a.playbackRate = v.playbackRate
    if (force || Math.abs(a.currentTime - v.currentTime) > DRIFT_TOLERANCE_SEC) {
      // 元数据还没就绪时赋值会被忽略，由 onLoadedMetadata 再补一次
      a.currentTime = v.currentTime
    }
  }, [])

  // 画面静音由伴随音轨接管：原始视频自己带音轨时，不静音就会和伴随音轨同时出声。
  // 用 effect 而不是只写 JSX 上的 muted 属性——React 对 muted 的属性同步有历史
  // 坑，直接写 DOM property 是唯一可靠的写法。
  useEffect(() => {
    const v = videoRef.current
    if (v) v.muted = !!companionSrc
  }, [companionSrc, unplayable, videoKind])

  // 播放中巡检漂移。用 rAF 而不是定时器：它天然跟着渲染节奏，页面不可见时自动
  // 停下，不会在后台空转。
  useEffect(() => {
    if (!videoPlaying || !companionSrc) return
    let raf = 0
    const tick = () => {
      alignCompanion(false)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoPlaying, companionSrc, alignCompanion])

  // 播放中换轨：新轨要接着当前画面位置继续放，而不是从头开始。
  useEffect(() => {
    const a = companionRef.current
    if (!a) return
    if (!companionSrc) {
      a.pause()
      return
    }
    if (videoPlaying) {
      alignCompanion(true)
      void a.play().catch(() => undefined)
    }
  }, [companionSrc, videoPlaying, alignCompanion])

  return (
    <section className="kvm-media-preview card">
      <div className="kvm-media-preview__frame">
        {hasVideo && !unplayable ? (
          <video
            ref={videoRef}
            key={videoKind}
            className="kvm-media-preview__video"
            controls
            // 跨源隔离页面里不加 crossOrigin，带 CORP 头的媒体会加载失败（见
            // Preview.tsx 同一处注释，这里复用同样已验证过的写法）。
            crossOrigin="anonymous"
            playsInline
            preload="metadata"
            src={api.mediaUrl(project.id, videoKind)}
            onPlay={(e) => {
              // 独占只认画面这一个 transport：伴随音轨是它的一部分，不单独 claim
              onPlayback(e.currentTarget)
              setVideoPlaying(true)
              alignCompanion(true)
              void companionRef.current?.play().catch(() => undefined)
            }}
            onPause={() => {
              setVideoPlaying(false)
              companionRef.current?.pause()
            }}
            onEnded={() => {
              setVideoPlaying(false)
              companionRef.current?.pause()
            }}
            onSeeked={() => alignCompanion(true)}
            onRateChange={() => alignCompanion(true)}
            onError={() => setUnplayable(true)}
          />
        ) : (
          <div className="kvm-media-preview__empty">
            {hasVideo ? t('media.preview.unplayable') : t('media.preview.empty')}
          </div>
        )}
      </div>

      {companionSrc && (
        <audio
          ref={companionRef}
          data-kvm-companion={companion}
          src={companionSrc}
          crossOrigin="anonymous"
          preload="metadata"
          hidden
          onLoadedMetadata={() => alignCompanion(true)}
        />
      )}

      <div className="kvm-media-preview__meta">
        <span className="badge num">
          {project.video_width > 0
            ? `${project.video_width}×${project.video_height}`
            : t('media.preview.noResolution')}
        </span>
        <span className="badge num">{formatDuration(project.duration_ms)}</span>
        {hasVideo && (
          <span className="badge">
            {proxyPath ? t('media.preview.usingProxy') : t('media.preview.usingOriginal')}
          </span>
        )}

        <label className="kvm-media-preview__companion">
          {t('media.preview.companion')}
          <select
            value={companion}
            onChange={(e) => setPick(e.target.value as TrackKind | 'none')}
            disabled={!hasVideo || available.length === 0}
          >
            {available.map((k) => (
              <option key={k} value={k}>
                {t(`media.track.${k}`)}
              </option>
            ))}
            <option value="none">{t('media.preview.companionNone')}</option>
          </select>
        </label>
      </div>
    </section>
  )
}
