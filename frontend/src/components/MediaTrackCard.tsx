import { CaretRightOutlined, PauseOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useRef, useState } from 'react'

import * as api from '../api/client'
import { t } from '../i18n'
import Waveform, { type WaveformStatus } from './Waveform'

/**
 * 「素材」舞台右下的单条音轨卡片：原始音频 / 人声 / 伴奏 / 鼓声通用同一个组件。
 *
 * 分离质量只能靠耳朵判断（CLAUDE.md §5.4），所以试听按钮是本卡片的一等操作，
 * 波形只是辅助——先给出播放能力，波形晚一点点出现不影响可用性。
 */

export type TrackKind = 'audio' | 'vocals' | 'instrumental' | 'drums'

interface MediaTrackCardProps {
  projectId: string
  kind: TrackKind
  label: string
  path: string | null
  /** 轮到本卡片解码波形（见 MediaPanel 的排队说明：同一时刻只解码一条，避免 N 个 wavesurfer 同时跑）。 */
  waveTurn: boolean
  /** 波形加载结束（无论成功失败）时回调，交出排队权给下一张卡片。 */
  onWaveSettled: () => void
  /** 独占播放：开始播放前调用，父组件借此暂停其它正在响的音轨/视频。 */
  onPlayback: (el: HTMLMediaElement) => void
}

const EMPTY_HINT_KEY: Record<TrackKind, string> = {
  audio: 'media.track.empty.audio',
  vocals: 'media.track.empty.vocals',
  instrumental: 'media.track.empty.instrumental',
  drums: 'media.track.empty.drums',
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * 从 WAV 头解出采样率，并用 data 子块的声明长度除以字节率反推时长。
 *
 * 本工程的音频与分离产物一律经 ffmpeg `-acodec pcm_s16le` 规范化（见
 * backend/kvm/media/download.py、separate.py），命中率很高——但**不是**教科书式的
 * RIFF/fmt/data 三段紧挨布局：ffmpeg 会在 fmt 和 data 之间插一个 `LIST/INFO`
 * 编码器标签块（实测 `Lavf62.1...` 版本串），且该块长度随 ffmpeg 版本字符串长度
 * 变化。真正做法是按标准 RIFF 子块结构逐块走：读 4 字节 ID + 4 字节长度（小端），
 * 不认识的块直接跳过（长度为奇数要向上补 1 字节对齐，RIFF 规范如此），一路找到
 * `data` 块为止。找不到就把时长留空，交给 `<audio>` 元素的 loadedmetadata 兜底。
 */
function parseWavHeader(
  bytes: Uint8Array,
): { sampleRate: number; durationSec: number | null } | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic4 = (o: number) =>
    String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
  if (magic4(0) !== 'RIFF' || magic4(8) !== 'WAVE') return null

  let sampleRate: number | null = null
  let byteRate: number | null = null
  let durationSec: number | null = null

  let pos = 12
  // 子块数量有限（fmt/LIST/data 等寥寥几个），加个上限只是防御性地避免死循环。
  for (let guard = 0; guard < 32 && pos + 8 <= bytes.length; guard++) {
    const id = magic4(pos)
    const size = view.getUint32(pos + 4, true)
    const payloadStart = pos + 8
    if (id === 'fmt ' && payloadStart + 16 <= bytes.length) {
      sampleRate = view.getUint32(payloadStart + 4, true)
      byteRate = view.getUint32(payloadStart + 8, true)
    } else if (id === 'data') {
      if (byteRate && byteRate > 0) durationSec = size / byteRate
      break
    }
    pos = payloadStart + size + (size % 2) // RIFF 子块按偶数字节对齐
  }

  return sampleRate !== null ? { sampleRate, durationSec } : null
}

/**
 * 只读文件开头一小段字节就够解析 WAV 头（fmt + 编码器标签块 + data 头，实测几十到
 * 几百字节），顺带从响应头拿文件总大小——一次 Range 请求换三个数据点
 * （采样率/时长/体积），不必再为大小单开一次 HEAD。
 *
 * 哪怕服务端没理会 Range、直接回了完整文件（200），也用流式读取 + 提前
 * `cancel()` 掐断连接：本工程的音频都是未压缩 PCM WAV，一条 4-5 分钟的曲子
 * 能有几十 MB，绝不能为了读个文件头就把整份下载下来。
 */
const WAV_HEAD_PROBE_BYTES = 4096

async function probeAudioFile(
  url: string,
): Promise<{ sampleRate: number | null; sizeBytes: number | null; durationSec: number | null }> {
  let resp: Response
  try {
    resp = await fetch(url, { headers: { Range: `bytes=0-${WAV_HEAD_PROBE_BYTES - 1}` } })
  } catch {
    return { sampleRate: null, sizeBytes: null, durationSec: null }
  }

  let sizeBytes: number | null = null
  const contentRange = resp.headers.get('content-range') // "bytes 0-4095/1234567"
  const total = contentRange?.split('/')[1]
  if (total && total !== '*') sizeBytes = Number(total)
  if (sizeBytes === null) {
    const len = resp.headers.get('content-length')
    if (len) sizeBytes = Number(len)
  }

  const reader = resp.body?.getReader()
  if (!reader) return { sampleRate: null, sizeBytes, durationSec: null }
  const bytes = new Uint8Array(WAV_HEAD_PROBE_BYTES)
  let filled = 0
  try {
    while (filled < WAV_HEAD_PROBE_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const take = Math.min(value.length, WAV_HEAD_PROBE_BYTES - filled)
      bytes.set(value.subarray(0, take), filled)
      filled += take
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }

  const parsed = parseWavHeader(bytes.subarray(0, filled))
  return {
    sampleRate: parsed?.sampleRate ?? null,
    sizeBytes,
    durationSec: parsed?.durationSec ?? null,
  }
}

export default function MediaTrackCard({
  projectId,
  kind,
  label,
  path,
  waveTurn,
  onWaveSettled,
  onPlayback,
}: MediaTrackCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const waveWrapRef = useRef<HTMLDivElement>(null)

  const [playing, setPlaying] = useState(false)
  const [playError, setPlayError] = useState(false)
  const [durationSec, setDurationSec] = useState<number | null>(null)
  const [sampleRate, setSampleRate] = useState<number | null>(null)
  const [sizeBytes, setSizeBytes] = useState<number | null>(null)
  const [waveStatus, setWaveStatus] = useState<WaveformStatus>({ kind: 'idle' })
  const [waveWidth, setWaveWidth] = useState(0)

  const src = path ? api.mediaUrl(projectId, kind) : null

  // 换轨（含"从没有到有"，例如分离刚跑完）都要重置派生状态，否则会闪一下
  // 上一条轨的数字。
  useEffect(() => {
    setPlaying(false)
    setPlayError(false)
    setDurationSec(null)
    setSampleRate(null)
    setSizeBytes(null)
    setWaveStatus({ kind: 'idle' })
  }, [src])

  useEffect(() => {
    if (!src) return
    let alive = true
    void probeAudioFile(src).then(({ sampleRate: sr, sizeBytes: sz, durationSec: dur }) => {
      if (!alive) return
      setSampleRate(sr)
      setSizeBytes(sz)
      if (dur !== null) setDurationSec(dur)
    })
    return () => {
      alive = false
    }
  }, [src])

  // 量出波形容器的实际像素宽度，据此反推 pxPerSec，让整段波形正好填满卡片——
  // 这是一张缩略图，不是 Timeline 那种要放大到可滚动的调轴视图。
  useEffect(() => {
    const el = waveWrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWaveWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleWaveStatus = useCallback(
    (s: WaveformStatus) => {
      setWaveStatus(s)
      if (s.kind === 'ready' || s.kind === 'error') onWaveSettled()
    },
    [onWaveSettled],
  )

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      onPlayback(el)
      void el.play().catch(() => setPlayError(true))
    } else {
      el.pause()
    }
  }, [onPlayback])

  const noop = useCallback(() => undefined, [])

  if (!path || !src) {
    return (
      <div className="kvm-media-track kvm-media-track--empty">
        <div className="kvm-media-track__head">
          <span className="kvm-media-track__label">{label}</span>
          <span className="kvm-media-track__stats muted">{t(EMPTY_HINT_KEY[kind])}</span>
        </div>
      </div>
    )
  }

  const pxPerSec = waveWidth > 0 && durationSec ? Math.max(4, waveWidth / durationSec) : 0
  const canShowWave = waveTurn && pxPerSec > 0

  return (
    <div className="kvm-media-track">
      <audio
        ref={audioRef}
        src={src}
        // 时长通常已经从上面的 WAV 头 probe 出来了，这里的 preload="metadata"
        // 只是兜底（万一遇到 probe 解不出 data 子块的非常规布局）。对本工程统一
        // 产出的 WAV 而言，"metadata" 走 Range 请求即可拿到时长，不会拉整份文件。
        preload="metadata"
        hidden
        onLoadedMetadata={(e) =>
          setDurationSec((prev) => prev ?? e.currentTarget.duration)
        }
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setPlayError(true)}
      />
      <div className="kvm-media-track__head">
        <button
          type="button"
          className="kvm-media-track__play"
          onClick={togglePlay}
          disabled={playError}
          aria-label={playing ? t('common.pause') : t('common.play')}
          title={playError ? t('media.track.playError') : undefined}
        >
          {playing ? <PauseOutlined /> : <CaretRightOutlined />}
        </button>
        <span className="kvm-media-track__label">{label}</span>
        <span className="kvm-media-track__stats num">
          <span>{durationSec !== null ? formatDuration(durationSec) : '--:--'}</span>
          <span>{sampleRate ? `${sampleRate} Hz` : '—'}</span>
          <span>{sizeBytes !== null ? formatBytes(sizeBytes) : '—'}</span>
        </span>
      </div>
      <div className="kvm-media-track__wave" ref={waveWrapRef}>
        {canShowWave ? (
          <Waveform
            sources={[src]}
            height={44}
            pxPerSec={pxPerSec}
            onStatus={handleWaveStatus}
            onScrollPx={noop}
          />
        ) : (
          <div className="kvm-media-track__wave-status">
            {waveTurn ? t('media.track.waveLoading') : t('media.track.waveQueued')}
          </div>
        )}
      </div>
      {waveStatus.kind === 'error' && (
        <div className="kvm-media-track__wave-status">{t('media.track.waveError')}</div>
      )}
      {playError && <p className="error">{t('media.track.playError')}</p>}
    </div>
  )
}
