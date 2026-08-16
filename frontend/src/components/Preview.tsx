/**
 * 预览播放器：视频 + libass 字幕叠加 + 试听混音台。
 *
 * 这是「一站式」的技术前提 —— 所见即所得的实时预览。三条硬约束：
 *
 * 1. 字幕由 JASSUB（libass 的 WASM 构建）叠在 <video> 上，ASS 文本一律取自后端
 *    /api/render/ass。前端不拼 ASS，导出侧的 ffmpeg 用同一份 libass（CLAUDE.md §5.12）。
 * 2. <video> **永远静音**，声音统一走 Web Audio（CLAUDE.md D15）。W3C 明确说明
 *    多个 media element 之间无法保持同步，所以「原声/伴奏」不能用两个 <audio> 互相追时间。
 * 3. 播放头一律由 rVFC 的 mediaTime 驱动：timeupdate 每 250ms 才触发一次，
 *    精度不足以驱动逐字高亮；video.currentTime 在 Firefox 上被量化到 2ms，
 *    规范上也只是「近似值」。
 *
 * ## 声音是「层 × 增益」，不是几个写死的档位
 *
 * 按 D15，分离过的工程装的是 **vocals 与 instrumental 两条 stem**，
 * **「原声」= 两者相加**，而不是另装一份原始混音。两条 stem 来自同一次分离，
 * 天然采样级对齐，所以切换只是改增益、不需要 seek，也就不会「切一下跳一下」。
 *
 * 由此「仅人声」是白拿的：把伴奏那层拉到 0 即可。预设（原声 / 伴奏 / 仅人声）
 * 只是把各层增益整组写成某个组合的**快捷方式，不是可选项的全集**（§8.7 的
 * 导出混音台是同一个心智模型）；分轨滑块直接就是各层增益，
 * 「原声 + 人声压低」就是日本卡拉OK 那种ガイドボーカル入り的试听方式。
 *
 * 没分离过的工程退化成单层 `mix`（原始混音），此时只有「原声」可用 ——
 * 缺的档**禁用而不隐藏**，并说明为什么（§2.5：失败要降级，且要让用户知道原因）。
 *
 * ## 试听混音与导出音轨是两件事
 *
 * store 的 `audioMode` 只有 `original` / `instrumental` 两个值，它是**导出**的
 * ON/OFF VOCAL 设置（ExportPanel 直接读它）。这里的「原声 / 伴奏」两档与它一一对应、
 * 会写回去；而「仅人声」和分轨滑块**纯属试听，绝不写 audioMode** ——
 * 结构上就不可能出现「编辑期为了核对咬字而 solo 了人声，结果导出一条只有人声的成片」。
 * 反向同步仍然保留：导出舞台切 ON/OFF VOCAL 时，这里的预设跟着变，
 * 「设置选了伴奏、预览还在放原声」不会发生。
 *
 * ## 慢速试听保音高
 *
 * 打轴主力是 tap-to-time，工作流要求 0.5~0.75x 慢速（§5.10），而
 * `AudioBufferSourceNode.playbackRate` 是重采样、0.75x 会降调约 5 个半音。
 * 所以采样源改用 `lib/timestretch` 的 WSOLA 拉伸器。**全引擎只建一个拉伸器**，
 * 所有层共用它的帧偏移决策——每条 stem 各起一个的话相加即相位抵消，
 * 而且只在「原声」档听得出来（见 lib/timestretch.ts 文件头）。
 * 建不起来（浏览器没有 AudioWorklet 等）就退回 BufferSource，只是慢速会降调，
 * **不让播放整个不可用**。
 *
 * ## 本组件是全应用唯一的播放时钟
 *
 * 时间轴、波形、注音编辑器都**没有**自己的播放器：它们写 store 的
 * `playheadMs` / `playing` / `playbackRate` 只表示「请跳到这里 / 请播 / 请变速」，
 * 由这里执行，执行完再把真实位置写回 `playheadMs`。回环靠 `lastEmittedRef`
 * 精确相等切断（见其注释）。
 *
 * 曾经波形层自带一份 wavesurfer 时钟并把 `timeupdate` 写回 store，
 * 于是两个时钟互相追时间 —— 表现为播放头抖动和大量多余 seek。**不要再开第二个时钟。**
 *
 * ## 视频轨是可选的从动方，不是播放的前提
 *
 * 声音、播放头、字幕时间全部来自 AudioContext 主时钟，`<video>` 只贡献画面。
 * 因此**没有视频、或视频这个浏览器解不了，都不该让播放失败**：
 *
 * - 工程只导入了音轨（"先只有音轨、边听边打轴"是本工具最常见的起点，§2.5）时，
 *   根本不渲染 `<video>`，播放头改由 rAF 直读音频引擎推进；
 * - 视频存在但浏览器放不了时同样降级为纯音频。实测：yt-dlp 下下来的 `.mkv`
 *   在 WebKit 里没有解复用器，`<video>` 报 `MEDIA_ERR_SRC_NOT_SUPPORTED`、
 *   `play()` 抛 `NotSupportedError: The operation is not supported.`
 *   （Chromium 能放，所以这条路径只有 Safari 会走到）。
 *
 * 这条降级的实现要点是**先起音频、再起视频，且视频单独 try/catch**：
 * 早先两者写在同一个 try 里，视频一抛异常就把整段 catch 走掉、顺手
 * `setPlaying(false)`，结果声音刚起来又被立刻掐掉，用户看到的就是"完全不能播"。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import * as api from '../api/client'
import type { JobStatus } from '../api/types'
import { t } from '../i18n'
import {
  checkPreviewEnvironment,
  describeError,
  hasFrameCallback,
  parsePlayRes,
  requestFrameLoop,
  SubtitleOverlay,
  type FrameMeta,
  type PreviewIssue,
} from '../lib/jassub'
import { TimeStretchPlayer } from '../lib/timestretch'
import { useProject } from '../state/projectStore'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 工程变动后重新拉取 ASS 的防抖窗口。
 *
 * 重建 ASS 要走一次后端往返（POST /api/render/ass），远超一帧的 16ms，
 * 所以拖拽过程中不能每次变更都拉。这个窗口天然实现了「拖动时不更新、停手才更新」：
 * 连续拖拽期间不会发起请求，手一停（或松开）就刷新。
 */
const ASS_REFRESH_DEBOUNCE_MS = 120

/** 视频相对音频时钟的软纠偏阈值（秒）。CLAUDE.md D15 给的是 40~50ms */
const SOFT_SYNC_S = 0.045
/** 超过这个偏差就直接 seek —— 用变速已经追不回来了 */
const HARD_SYNC_S = 0.25
/** 软纠偏时的播放速率偏移。静音视频调速没有音高副作用，比频繁 seek 平滑得多 */
const SYNC_RATE_DELTA = 0.02
/** 各层增益变化的交叉淡入时长（秒），避免切换时爆音 */
const CROSSFADE_S = 0.06

/**
 * 一条音频层。
 *
 * `vocals` / `instrumental` 是分离产出的两条 stem，**「原声」= 两者相加**（D15）。
 * `mix` 是没分离过时的兜底单层（原始混音），与两条 stem **互斥地装载**：
 * 有 stem 时再装一份混音等于同一段音乐白占第三份内存（整曲立体声约 100MB），
 * 而且"原声"该长什么样已经由 D15 定死了。
 */
type LayerId = 'mix' | 'vocals' | 'instrumental' | 'guide'

/** 层 → 后端媒体 kind */
const LAYER_KIND: Record<LayerId, 'audio' | 'vocals' | 'instrumental' | 'guide'> = {
  mix: 'audio',
  vocals: 'vocals',
  instrumental: 'instrumental',
  guide: 'guide',
}

/**
 * 引导声是**叠加层**，不参与「原声 / 伴奏 / 仅人声」那组预设的互斥。
 *
 * 它能配原声也能配伴奏（日本卡拉OK 里两种都有），所以它不是第四个档，而是一个
 * 独立开关——开关状态就是 store 的 `guideEnabled`，也就是导出设置里的「混入引导声」，
 * 两者共用一份状态（与 ON/OFF VOCAL 同一条纪律）。
 *
 * 它的音量**不进分轨滑块**：文件里已经把生成时那个 `gain` 烧进去了，
 * 预览按 1.0 播放才等于成片里的响度。在这里再给一个滑块，用户会以为拉低它
 * 导出也会变轻——那是素材页的「音量」参数才管的事。
 */
const GUIDE_LAYER: LayerId = 'guide'

/**
 * 预览里引导声那一层的增益。**不是 1，这是实测校准过的。**
 *
 * 引导声文件是**单声道**，而导出时 ffmpeg 的 `amix` 会先把它上混成立体声，
 * 上混矩阵为保持功率给每个声道乘 1/√2 —— 于是同一份文件在成片里比它自己的
 * 文件电平低 3 dB。实测（赤春花，34s+8s 窗口）：引导声本身 −19.45 dBFS，
 * 而"成片混音 − 伴奏"的残差是 −22.46 dBFS，两者相关系数 1.0000，差值恰好 3.01 dB。
 *
 * 预览若按 1.0 播放，用户就会照着一个比成片响 3 dB 的声音去调「音量」参数，
 * 导出后又觉得轻——正是这块面板要消灭的那类"导完才发现"。
 *
 * **反过来不去改导出侧的上混**：§8.9 记的默认 `gain=0.11`（"约低于伴奏 5dB"）
 * 就是在这条链路的末端量出来的，动它等于把那次校准作废。
 */
const GUIDE_EXPORT_GAIN = Math.SQRT1_2

/**
 * 试听预设。**只是把各层增益整组写成某个组合的快捷方式**，不是可选项的全集
 * ——真正的模型是「层 × 增益」（分轨滑块），与 §8.7 的导出混音台一致。
 */
type MonitorPreset = 'original' | 'instrumental' | 'vocals'

const MONITOR_PRESETS: readonly MonitorPreset[] = ['original', 'instrumental', 'vocals']

/**
 * 某个预设要让哪些层出声。
 *
 * 「原声」在有 stem 时是**两条 stem 相加**、没 stem 时是那条混音——所以它依赖
 * 当前工程实际装了哪些层，不能写成常量表。
 */
function presetLayers(preset: MonitorPreset, layers: readonly LayerId[]): LayerId[] {
  const stems = layers.filter((l) => l !== GUIDE_LAYER)
  if (preset === 'original') {
    return stems.includes('mix') ? ['mix'] : stems.filter((l) => l !== 'mix')
  }
  return stems.filter((l) => l === preset)
}

/**
 * 按预设算出各层增益。已有的分轨音量（`trims`）要保住，切一圈档回来不该被复位成 100%。
 *
 * 引导声由 `guideOn` 单独决定，**不受预设摆布**：它是叠加层（见 `GUIDE_LAYER`），
 * 切换 ON/OFF VOCAL 不该顺手把它关掉。
 */
function presetLevels(
  preset: MonitorPreset,
  layers: readonly LayerId[],
  trims: Partial<Record<LayerId, number>>,
  guideOn: boolean,
): Partial<Record<LayerId, number>> {
  const on = new Set(presetLayers(preset, layers))
  const out: Partial<Record<LayerId, number>> = {}
  for (const id of layers) {
    out[id] =
      id === GUIDE_LAYER
        ? guideOn
          ? GUIDE_EXPORT_GAIN
          : 0
        : on.has(id)
          ? (trims[id] ?? 1)
          : 0
  }
  return out
}

/** 增益低于它就当作"听不见"，用于反推当前落在哪个预设上 */
const AUDIBLE_EPS = 5e-4

/**
 * loading：音轨还在解码；webaudio：走 Web Audio；fallback：Web Audio 没拿到音轨。
 *
 * **`fallback` 只说明 Web Audio 空了，不等于"已经退回视频自带音轨"。** 真正退得回去
 * 还要求画面这条路本身是通的（`videoActive`），而工程刚建、视频正在下载、
 * 或者这个浏览器压根放不了这个视频时都不通 —— 那些情况下声音无处可退。
 * 二者曾被当成一回事，于是没有视频时也会弹出「已改用视频自身的声音」。
 */
type AudioState = 'loading' | 'webaudio' | 'fallback'

/** 素材准备任务的 kind → 画面区文案键。未知 kind 落到通用的"正在准备素材" */
const BUSY_LABEL: Record<string, string> = {
  'media.download': 'media.player.downloading',
  'media.separate': 'media.player.separating',
  'media.proxy': 'media.player.buildingProxy',
}

/** 有任务在跑时的轮询间隔（毫秒）。只为换一行文案，不必追进度条那种精度 */
const ACTIVITY_POLL_BUSY_MS = 1200
/** 没有任务在跑时的轮询间隔。素材齐了会整个停掉，见轮询 effect 的说明 */
const ACTIVITY_POLL_IDLE_MS = 4000

// ---------------------------------------------------------------------------
// 音频引擎
// ---------------------------------------------------------------------------

/**
 * 一台小混音台：若干条层各接一个 GainNode 汇进 master。
 *
 * 各层共用同一个 AudioContext 时钟、由**同一个采样源**推进，天然采样级对齐，
 * 所以切换只是改增益、不需要 seek，也就不会「切一下跳一下」。
 *
 * 采样源优先用 `TimeStretchPlayer`（保音高变速）；它建不起来时退回
 * `AudioBufferSourceNode`（变速会降调）。两条路的对外行为完全一致，
 * 差别只有"慢速试不试得出音高"这一条，由调用方报给用户。
 *
 * AudioContext 是主时钟，<video> 是从动方。
 */
class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** 保音高采样源。null = 已降级到 BufferSource 路径 */
  private stretch: TimeStretchPlayer | null = null
  /** **仅降级路径持有**：走拉伸器时样本已转移给 worklet，主线程再留一份纯属白占内存 */
  private readonly buffers = new Map<LayerId, AudioBuffer>()
  private readonly gains = new Map<LayerId, GainNode>()
  private readonly sources = new Map<LayerId, AudioBufferSourceNode>()
  /** 真正解码成功、已经能出声的层 */
  private readonly present = new Set<LayerId>()
  private levels: Partial<Record<LayerId, number>> = {}
  private maxDurationSec = 0

  /** 播放锚点：ctx 时间轴上的一个时刻，以及它对应的媒体位置（仅降级路径用） */
  private anchorCtxTime = 0
  private anchorMediaSec = 0
  private running = false
  private rate = 1
  private disposed = false

  get available(): boolean {
    return this.present.size > 0
  }

  /** 是否真的用上了保音高变速。false = 慢速试听会降调，界面上要说明 */
  get pitchPreserved(): boolean {
    return this.stretch !== null
  }

  get playing(): boolean {
    return this.stretch ? this.stretch.playing : this.running
  }

  /** 已载入音轨里最长的那条的时长（秒）。没有音轨时为 0 */
  get durationSec(): number {
    return this.maxDurationSec
  }

  has(layer: LayerId): boolean {
    return this.present.has(layer)
  }

  /** 主时钟：当前媒体位置（秒）。变速时 ctx 时间要按速率折算成媒体时间 */
  get positionSec(): number {
    if (this.stretch) return this.stretch.positionSec
    if (!this.ctx || !this.running) return this.anchorMediaSec
    return Math.max(
      this.anchorMediaSec,
      this.anchorMediaSec + (this.ctx.currentTime - this.anchorCtxTime) * this.rate,
    )
  }

  /**
   * 载入各层，返回中文警告列表。
   * 某条轨缺失不影响另一条，也不能因此终止 —— 一站式定位下「失败要降级」（CLAUDE.md §2.5）。
   */
  async load(
    projectId: string,
    layers: readonly LayerId[],
    levels: Partial<Record<LayerId, number>>,
  ): Promise<PreviewIssue[]> {
    const warnings: PreviewIssue[] = []
    this.levels = { ...levels }
    let ctx: AudioContext
    try {
      ctx = new AudioContext()
    } catch (e) {
      return [
        {
          level: 'warn',
          title: t('media.player.warn.noContextTitle'),
          detail: `${describeError(e)}。${t('media.player.warn.noContextDetail')}`,
        },
      ]
    }
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)

    for (const id of layers) {
      const gain = ctx.createGain()
      gain.gain.value = this.levels[id] ?? 0
      gain.connect(this.master)
      this.gains.set(id, gain)
    }

    /*
     * 保音高变速。**整个引擎只建一个拉伸器**，各层占它的一个输出序号：
     * 帧偏移决策在节点内部只做一次、所有层共用，这是"两条 stem 相加不梳状滤波"
     * 的唯一依据（证明见 lib/timestretch.ts 文件头）。给每条 stem 各建一个是错的，
     * 而且只在「原声」档（两层同时出声）才听得出来，单听任何一层都好——极易漏测。
     *
     * `referenceLayerIds` 刻意不传：相似度搜索的参考信号就该是**所有层的等增益和**，
     * 那正好等于原曲混音。绝不能按当前增益加权——切档时增益在变，参考跟着变，
     * 两条 stem 的对齐会在切换瞬间一起跳。
     */
    // 一条轨都没有时不建拉伸器，也**不报"慢速会降调"**：那条警告说的是
    // 浏览器能力不足，而此刻真实情况只是工程还没有素材。原先无条件走这里，
    // TimeStretchPlayer 以"至少要有一条音轨"抛错，于是空工程上会弹出一条
    // 黄色警告，正文还拼着那句内部异常——用户看到的是一个不存在的浏览器问题。
    if (layers.length > 0) {
      try {
        const stretch = await TimeStretchPlayer.create(ctx, { layerIds: layers })
        if (this.disposed) {
          stretch.dispose()
          return warnings
        }
        this.stretch = stretch
        for (const id of layers) {
          const gain = this.gains.get(id)
          if (gain) stretch.connectLayer(id, gain)
        }
      } catch {
        // 内部异常文本不进界面：用户既读不懂也处理不了，诊断留给控制台
        warnings.push({
          level: 'warn',
          title: t('media.player.warn.pitchFallbackTitle'),
          detail: t('media.player.warn.pitchFallbackDetail'),
        })
      }
    }

    for (const id of layers) {
      try {
        const resp = await fetch(api.mediaUrl(projectId, LAYER_KIND[id]))
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
        const decoded = await ctx.decodeAudioData(await resp.arrayBuffer())
        if (this.disposed) return warnings
        this.present.add(id)
        this.maxDurationSec = Math.max(this.maxDurationSec, decoded.duration)
        if (this.stretch) {
          // 样本转移给 worklet 之后就地丢掉 AudioBuffer：留着等于同一段音乐占两份内存
          this.stretch.setLayer(id, decoded)
        } else {
          this.buffers.set(id, decoded)
        }
      } catch (e) {
        warnings.push({
          level: 'warn',
          title: t('media.player.warn.trackFailed', { track: t(`media.player.track.${id}`) }),
          detail: `${describeError(e)}。${t(
            id === 'mix'
              ? 'media.player.warn.trackFailedMix'
              : id === GUIDE_LAYER
                ? // 引导声不是分离产物，让用户去"跑一次分离"是把人指向错的地方
                  'media.player.warn.trackFailedGuide'
                : 'media.player.warn.trackFailedStem',
          )}`,
        })
      }
    }
    return warnings
  }

  async play(offsetSec: number): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.available || this.disposed) return
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.stretch) {
      this.stretch.play(offsetSec)
      return
    }
    this.stopSources()

    const when = ctx.currentTime
    for (const [id, buffer] of this.buffers) {
      const gain = this.gains.get(id)
      if (!gain) continue
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.playbackRate.value = this.rate
      src.connect(gain)
      src.start(when, Math.max(0, Math.min(offsetSec, buffer.duration)))
      this.sources.set(id, src)
    }
    this.anchorCtxTime = when
    this.anchorMediaSec = offsetSec
    this.running = true
  }

  pause(): void {
    if (this.stretch) {
      this.stretch.pause()
      return
    }
    if (!this.running) return
    this.anchorMediaSec = this.positionSec
    this.running = false
    this.stopSources()
  }

  seek(offsetSec: number): void {
    if (this.stretch) {
      this.stretch.seek(offsetSec)
      return
    }
    if (this.running) {
      void this.play(offsetSec)
    } else {
      this.anchorMediaSec = offsetSec
    }
  }

  /**
   * 变速（打轴时用 0.5~0.75x 试听，CLAUDE.md §5.10）。
   *
   * 拉伸器路径上是保音高的；降级路径先把锚点结算到当前位置再改速率，
   * 否则**已经播过的那段**会被按新速率重新折算，播放头会瞬间跳一大截。
   * `AudioBufferSourceNode.playbackRate` 可以在播放中直接改，不必重起 source，
   * 也就没有换挡时的断音——代价是它是重采样，0.75x 会降调约 5 个半音。
   */
  setRate(rate: number): void {
    if (rate <= 0) return
    if (this.stretch) {
      this.stretch.setRate(rate)
      return
    }
    const ctx = this.ctx
    if (rate === this.rate) return
    this.anchorMediaSec = this.positionSec
    this.anchorCtxTime = ctx?.currentTime ?? 0
    this.rate = rate
    for (const src of this.sources.values()) src.playbackRate.value = rate
  }

  /**
   * 设置各层增益（缺省的层视为 0）。切换一律走斜坡，**不要直接赋 `.value`**：
   * 增益跳变就是一声爆音。
   */
  setLevels(levels: Partial<Record<LayerId, number>>): void {
    this.levels = { ...this.levels, ...levels }
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    for (const [id, gain] of this.gains) {
      const target = this.levels[id] ?? 0
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(target, now + CROSSFADE_S)
    }
  }

  setVolume(value: number): void {
    if (this.master) this.master.gain.value = value
  }

  dispose(): void {
    this.disposed = true
    this.stopSources()
    this.stretch?.dispose()
    this.stretch = null
    this.buffers.clear()
    this.gains.clear()
    this.present.clear()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }

  private stopSources(): void {
    for (const src of this.sources.values()) {
      try {
        src.stop()
      } catch {
        /* 尚未 start 或已自然结束 */
      }
      src.disconnect()
    }
    this.sources.clear()
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
  const clamped = Math.max(0, ms)
  const m = Math.floor(clamped / 60000)
  const s = Math.floor((clamped % 60000) / 1000)
  const cs = Math.floor((clamped % 1000) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export interface PreviewProps {
  className?: string
}

export function Preview({ className }: PreviewProps) {
  const project = useProject((s) => s.project)
  const playing = useProject((s) => s.playing)
  const playbackRate = useProject((s) => s.playbackRate)
  const audioMode = useProject((s) => s.audioMode)
  const guideEnabled = useProject((s) => s.guideEnabled)
  const setPlayhead = useProject((s) => s.setPlayhead)
  const setPlaying = useProject((s) => s.setPlaying)
  const setAudioMode = useProject((s) => s.setAudioMode)
  const setGuideEnabled = useProject((s) => s.setGuideEnabled)
  const refreshProject = useProject((s) => s.refresh)
  const padTo169 = useProject((s) => s.padTo169)
  /** 画面区的实际画布尺寸，取自 ASS 的 PlayRes（补边后与工程记的尺寸不同） */
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null)
  /** 补边开关的 ref 镜像：`refreshAss` 是空依赖的 useCallback，只能这样读到当前值 */
  const padTo169Ref = useRef(padTo169)
  padTo169Ref.current = padTo169

  const videoRef = useRef<HTMLVideoElement | null>(null)
  /**
   * 字幕画布的宿主。React 不往里放任何子节点，画布由字幕层独占——与
   * `StyleFilmPreview` 同一形态。
   *
   * **为什么不再用 JASSUB 的视频模式**：视频模式下它按 `<video>` 的**内容矩形**
   * 定位自己的画布（`_getElementBoundingBox`），也就是说字幕永远画不进黑边。
   * 勾了「补黑边到 16:9」之后预览纹丝不动，根子就在这里。画布模式把画布铺满整个
   * 画面区，画布尺寸直接取 ASS 的 PlayRes，补边与不补边走同一条路。
   */
  const overlayHostRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<SubtitleOverlay | null>(null)
  const audioRef = useRef<AudioEngine | null>(null)
  const seekBarRef = useRef<HTMLInputElement | null>(null)
  const clockRef = useRef<HTMLSpanElement | null>(null)
  /** 音量用 ref 传给异步回调，免得把它塞进「重建音频引擎」的依赖数组 */
  const volumeRef = useRef(1)
  /** 播放速率同理：逐帧的纠偏回调要读它，但不该因它变化而重挂 */
  const rateRef = useRef(playbackRate)
  /** 各层增益的 ref 镜像，理由同 volumeRef：引擎重建时要读它，但不该因它变化而重挂 */
  const levelsRef = useRef<Partial<Record<LayerId, number>>>({})
  /**
   * 各层最近一次的**非零**增益。
   *
   * 预设切换要靠它把用户调过的分轨音量还回去：把人声压到 30% 当引导声、
   * 切去伴奏听一段再切回来，音量不该被复位成 100%。
   */
  const trimsRef = useRef<Partial<Record<LayerId, number>>>({})
  /**
   * 上一次看到的 `audioMode`。
   *
   * 导出舞台切 ON/OFF VOCAL 时预览要跟着走，但**只在它真的变化时**跟——
   * 每次渲染都同步的话，用户在这里选的「仅人声」会被立刻按回去。
   */
  const lastAudioModeRef = useRef(audioMode)

  /**
   * 最近一次由播放器写进 store 的播放头。
   *
   * 双向绑定的回环就靠它切断：store 里的值与它**完全相等**说明这次变化是播放器
   * 自己发出的，忽略；不相等就是时间轴（或别的组件）改的，需要 seek。
   * 用精确相等而不是阈值 —— setPlayhead 写进去的就是这个数，不会有误差，
   * 也就不必猜一个「多小算是同一个位置」的经验值。
   */
  const lastEmittedRef = useRef<number>(useProject.getState().playheadMs)
  const assTimerRef = useRef<number>(0)
  const assInFlightRef = useRef(false)
  const assDirtyRef = useRef(false)

  const [overlayError, setOverlayError] = useState<string | null>(null)
  const [overlayLoading, setOverlayLoading] = useState(false)
  const [overlayWarnings, setOverlayWarnings] = useState<PreviewIssue[]>([])
  const [audioWarnings, setAudioWarnings] = useState<PreviewIssue[]>([])
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [volume, setVolume] = useState(1)
  const [audioState, setAudioState] = useState<AudioState>('loading')
  /** 已经解码成功、能出声的层。缺的层要**禁用而不隐藏**对应的档 */
  const [readyLayers, setReadyLayers] = useState<readonly LayerId[]>([])
  /** 各层增益 = 混音台本身。预设只是把它整组写成某个组合 */
  const [levels, setLevels] = useState<Partial<Record<LayerId, number>>>({})
  /** 分轨音量那一排是否展开。默认收起：绝大多数时候三个预设就够了 */
  const [mixerOpen, setMixerOpen] = useState(false)
  const [rvfcMissing, setRvfcMissing] = useState(false)
  /** 当前正在跑的素材准备任务（下载 / 分离 / 代理）。见下方轮询 effect */
  const [activity, setActivity] = useState<JobStatus[]>([])
  /**
   * 工程里有视频，但这个浏览器放不了它（容器/编码不支持）。
   * 置位后一切与 `<video>` 相关的路径都停掉，只留音频，画面位置改显提示。
   */
  const [videoUnplayable, setVideoUnplayable] = useState(false)

  const envIssues = useMemo(() => checkPreviewEnvironment(), [])
  const fatal = envIssues.filter((i) => i.level === 'fatal')
  const blocked = fatal.length > 0

  const projectId = project?.id ?? null
  const durationMs = project?.duration_ms ?? 0
  const hasVideo = !!project?.video_path
  const videoPath = project?.video_path ?? null
  const proxyPath = project?.proxy_video_path ?? null

  /**
   * 画面取哪一份素材：**有代理就用代理**（H.264 / MP4 / 无音轨 / 约 1 秒 GOP），
   * 没有才回退原视频。
   *
   * 原视频常是 AV1 + Matroska + Opus——Safari 三重放不了（没有 Matroska 解复用器、
   * 不认 MKV 里的 Opus、M1/M2 也没有 AV1 硬解），所以在 WebKit 上"有没有代理"
   * 直接决定看不看得见画面；4K 长 GOP 还会让逐帧核对音节边界卡住。
   *
   * **这只影响预览。** 导出成片始终烧在原始素材上（后端 render 路由读的是
   * `video_path`），代理是 540p 无音轨的编辑器专用产物，绝不能拿来出片。
   */
  const videoSrcKind: 'proxy' | 'video' = proxyPath ? 'proxy' : 'video'
  const fontName = project?.style.font_name ?? ''
  const audioPath = project?.audio_path ?? null
  const vocalsPath = project?.vocals_path ?? null
  const instrumentalPath = project?.instrumental_path ?? null
  const guidePath = project?.guide_audio_path ?? null

  /** 层 → 工程里对应的文件路径。为空 = 这条轨还不存在（多半是没分离过） */
  const layerPath = useCallback(
    (id: LayerId): string | null => {
      if (id === 'mix') return audioPath
      if (id === 'vocals') return vocalsPath
      if (id === 'instrumental') return instrumentalPath
      return guidePath
    },
    [audioPath, vocalsPath, instrumentalPath, guidePath],
  )

  /**
   * 这个工程要装哪几层。
   *
   * 两条 stem 都在就**只装 stem**：按 D15「原声 = 人声 + 伴奏」，再装一份原始混音
   * 是同一段音乐的第三份内存（整曲立体声约 100MB），而且"原声"该长什么样已经定死。
   * 缺任何一条 stem 时才回退到装原始混音，否则「原声」就残了。
   */
  const layers = useMemo<LayerId[]>(() => {
    const out: LayerId[] = []
    if (audioPath && !(vocalsPath && instrumentalPath)) out.push('mix')
    if (vocalsPath) out.push('vocals')
    if (instrumentalPath) out.push('instrumental')
    // 引导声已经生成才装。它是单声道、比 stem 小得多，而它换来的是**导出前
    // 能真的听到成片里的引导声**——此前这块只能在界面上标注"预览不含引导声"。
    if (guidePath) out.push(GUIDE_LAYER)
    return out
  }, [audioPath, vocalsPath, instrumentalPath, guidePath])

  /**
   * 视频画面这条路是否还走得通。**播放的前提只有音频**，这个值只决定
   * 「要不要驱动 `<video>`、要不要挂字幕层」，不参与播放能否开始的判断。
   */
  const videoActive = hasVideo && !videoUnplayable

  /**
   * 素材已经齐到不会再影响预览：画面有、且放得出来、音轨也有。
   * 齐了就不必再问后端"有没有任务在跑"（见下方轮询 effect）。
   */
  const mediaSettled = videoActive && !!audioPath

  /**
   * `videoUnplayable` 的 ref 镜像。命令式路径（seek / play）要读它，
   * 但它们不该因为这个值变化而重挂 —— 播放中途才发现视频放不了时，
   * 重挂播放 effect 会让音频从头 `start()` 一次，听感上就是"咔"一下。
   */
  const videoUnplayableRef = useRef(false)

  const markVideoUnplayable = useCallback(() => {
    videoUnplayableRef.current = true
    setVideoUnplayable(true)
  }, [])

  /**
   * 换了工程或换了视频文件，之前那次「放不了」的结论就作废，重新给它一次机会。
   * 代理路径也算：后台把代理跑出来之后 src 会从原视频切到代理，
   * 那正是「刚才放不了的东西现在放得了」的典型时刻，不复位就白跑一场。
   */
  useEffect(() => {
    videoUnplayableRef.current = false
    setVideoUnplayable(false)
  }, [projectId, videoPath, proxyPath])

  /**
   * 素材准备任务轮询。
   *
   * 存在的理由：**「素材还没准备好」与「真的降级了」在工程 JSON 上长得一模一样**
   * —— 正在下载和从没下载过，`video_path` 都是空的。把前者当成后者报出来，用户会
   * 以为出了故障，而他其实什么都不用做，等着就行。这个区分只有后端答得了
   * （`GET /api/media/activity/{id}`）。
   *
   * 顺带兑现"完成后自动恢复"：任务从有到无时刷新一次工程。App 里那份 JobProgress
   * 只认它**自己发起**的任务 —— 页面刷新过、或者代理是后端在下载完成后自动发起的，
   * 它都不认识，那时没有别人来刷新，画面就一直不出现。
   *
   * **素材齐了就整个停掉**：编辑一首歌要几十分钟，没有任何东西会变的时候
   * 不该一直问后端。
   */
  useEffect(() => {
    if (!projectId || mediaSettled) {
      setActivity([])
      return
    }
    let alive = true
    let timer = 0
    let running = new Set<string>()

    const poll = async (): Promise<void> => {
      let jobs: JobStatus[]
      try {
        jobs = await api.mediaActivity(projectId)
      } catch {
        // 后端暂时联系不上就退避重试，不放弃：任务多半还在跑
        if (alive) timer = window.setTimeout(() => void poll(), ACTIVITY_POLL_IDLE_MS * 2)
        return
      }
      if (!alive) return
      setActivity(jobs)
      // 判据是"**有任务从在跑里消失了**"，不是"队列空了"：下载一完成后端会立刻
      // 接着排代理任务，等队列空掉才刷新，画面会白白晚出现一个代理生成的时长
      const ids = new Set(jobs.map((j) => j.job_id))
      if ([...running].some((id) => !ids.has(id))) void refreshProject()
      running = ids
      timer = window.setTimeout(
        () => void poll(),
        jobs.length > 0 ? ACTIVITY_POLL_BUSY_MS : ACTIVITY_POLL_IDLE_MS,
      )
    }

    void poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [projectId, mediaSettled, refreshProject])

  /**
   * 取当前真正能用的 `<video>`。没有视频的工程根本不渲染这个元素，所以 ref 为空
   * 就已经代表"纯音频工程"。除此之外还要现场看一眼 `video.error`：媒体元素报错是
   * 异步事件，可能比某次命令式调用晚一步到，只靠 state 会有一帧的空窗。
   */
  const usableVideo = useCallback((): HTMLVideoElement | null => {
    const video = videoRef.current
    if (!video || videoUnplayableRef.current || video.error) return null
    return video
  }, [])

  // --- 音频：工程或音轨可用性变化时重建 ------------------------------------

  /**
   * 层集合变了（换工程 / 分离刚跑完）就按当前导出音轨设置重建一次各层增益。
   *
   * **必须声明在重建引擎的 effect 之前**：那个 effect 直接读 `levelsRef.current`
   * 去初始化各层增益节点，顺序反了的话首次起播会从静音斜坡淡进来。
   */
  useEffect(() => {
    const s = useProject.getState()
    const next = presetLevels(s.audioMode, layers, trimsRef.current, s.guideEnabled)
    levelsRef.current = next
    setLevels(next)
  }, [layers])

  useEffect(() => {
    if (!projectId) return
    const engine = new AudioEngine()
    audioRef.current = engine
    setAudioState('loading')
    setReadyLayers([])
    let cancelled = false

    void engine.load(projectId, layers, levelsRef.current).then((warnings) => {
      if (cancelled) return
      setAudioWarnings(warnings)
      setReadyLayers(layers.filter((id) => engine.has(id)))
      setAudioState(engine.available ? 'webaudio' : 'fallback')
      // 解码期间用户可能已经动过混音台或音量，这里以最新值为准补一次
      engine.setLevels(levelsRef.current)
      engine.setRate(rateRef.current)
      engine.setVolume(volumeRef.current)
      // 音轨可能是分离作业跑完后才出现的，此刻若正在播放就续上当前位置
      if (useProject.getState().playing) {
        void engine.play(useProject.getState().playheadMs / 1000)
      }
    })

    return () => {
      cancelled = true
      audioRef.current = null
      engine.dispose()
    }
  }, [projectId, layers])

  useEffect(() => {
    volumeRef.current = volume
    audioRef.current?.setVolume(volume)
    const video = videoRef.current
    if (video && audioState === 'fallback') video.volume = volume
  }, [volume, audioState])

  useEffect(() => {
    levelsRef.current = levels
    audioRef.current?.setLevels(levels)
  }, [levels])

  /**
   * 导出舞台切 ON/OFF VOCAL 时预览跟着走。
   *
   * **只在 `audioMode` 真的变化时同步**（而不是每次渲染都对齐）：否则用户在这里
   * 选的「仅人声」或调过的分轨音量会被立刻按回预设值。反方向的写回在
   * `applyPreset` 里，且只有「原声 / 伴奏」两档写——「仅人声」没有对应的导出变体。
   */
  useEffect(() => {
    if (lastAudioModeRef.current === audioMode) return
    lastAudioModeRef.current = audioMode
    setLevels(
      presetLevels(audioMode, layers, trimsRef.current, useProject.getState().guideEnabled),
    )
  }, [audioMode, layers])

  /**
   * 引导声开关（导出设置里的「混入引导声」就是它）。
   *
   * **只动引导声那一层**，不重算整组预设：用户可能已经把人声压到两三成在试听，
   * 顺手开一下引导声不该把那个调整按回预设值。
   */
  useEffect(() => {
    setLevels((prev) => ({ ...prev, [GUIDE_LAYER]: guideEnabled ? GUIDE_EXPORT_GAIN : 0 }))
  }, [guideEnabled])

  /**
   * 变速由这里统一执行：音频引擎与 <video> 必须同时改，否则视频会被纠偏逻辑
   * 一路当成「漂了」而不停 seek。时间轴上那个速率下拉框只是把值写进 store。
   */
  useEffect(() => {
    rateRef.current = playbackRate
    audioRef.current?.setRate(playbackRate)
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [playbackRate])

  /**
   * <video> 永远静音，除非 Web Audio 完全不可用。
   * 后者是降级路径：此时只有一个媒体元素在出声，不违反「不能让两个元素互相追」。
   */
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !(videoActive && audioState === 'fallback')
  }, [audioState, videoActive])

  // --- 字幕层：工程 / 视频 / 字体变化时重建 ---------------------------------

  useEffect(() => {
    const host = overlayHostRef.current
    if (!host || !projectId || !videoActive || blocked) return

    let disposed = false
    let created: SubtitleOverlay | null = null
    const canvas = document.createElement('canvas')
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'block',
    })
    host.appendChild(canvas)

    setOverlayError(null)
    setOverlayLoading(true)

    void (async () => {
      try {
        const { ass } = await api.buildAss(projectId, padTo169)
        if (disposed) return
        // 画布尺寸取这份 ASS 自己声明的 PlayRes：补边与否的规则只在后端
        // `render.geometry.plan_canvas` 里有一份，前端再算一遍必然漂移。
        // 宽高比与 PlayRes 对不上时 JASSUB 会做信箱式内缩，字幕被拉伸（§5.12）。
        const res = parsePlayRes(ass)
        if (res) setCanvasSize(res)
        created = await SubtitleOverlay.create({
          canvas,
          // 兜底尺寸从 store 现取，不进依赖数组：它只在"ASS 里没有 PlayRes"
          // 这条降级路径上有用，为它重建整个字幕层不值得
          width: res?.width ?? (useProject.getState().project?.video_width || 1920),
          height: res?.height ?? (useProject.getState().project?.video_height || 1080),
          ass,
          fontFamily: fontName,
        })
        if (disposed) {
          void created.destroy()
          created = null
          return
        }
        overlayRef.current = created
        setOverlayWarnings(created.warnings)
      } catch (e) {
        if (!disposed) setOverlayError(describeError(e))
      } finally {
        if (!disposed) setOverlayLoading(false)
      }
    })()

    return () => {
      disposed = true
      overlayRef.current = null
      // 视频中途被判定为放不了时这个 effect 会被拆掉，而上面的 finally 因为
      // disposed 不再复位 loading —— 不在这里清掉，「字幕渲染器加载中…」会一直挂着
      setOverlayLoading(false)
      void created?.destroy()
      // 创建失败时 JASSUB 没接管这块画布，得自己收
      canvas.remove()
    }
  }, [projectId, videoActive, fontName, padTo169, blocked])

  // --- ASS 刷新：工程一变就重新拉 -------------------------------------------

  const refreshAss = useCallback(async (id: string): Promise<void> => {
    if (assInFlightRef.current) {
      assDirtyRef.current = true
      return
    }
    assInFlightRef.current = true
    try {
      do {
        assDirtyRef.current = false
        const { ass } = await api.buildAss(id, padTo169Ref.current)
        overlayRef.current?.update(ass)
        setOverlayError(null)
      } while (assDirtyRef.current)
    } catch (e) {
      setOverlayError(t('media.player.err.overlayRebuild', { detail: describeError(e) }))
    } finally {
      assInFlightRef.current = false
      assDirtyRef.current = false
    }
  }, [])

  useEffect(() => {
    return useProject.subscribe((state, prev) => {
      // 每次编辑后端都返回一个全新的工程对象，引用不等即视为有改动
      if (state.project === prev.project) return
      const id = state.project?.id
      if (!id || id !== prev.project?.id) return
      window.clearTimeout(assTimerRef.current)
      assTimerRef.current = window.setTimeout(() => void refreshAss(id), ASS_REFRESH_DEBOUNCE_MS)
    })
  }, [refreshAss])

  useEffect(() => () => window.clearTimeout(assTimerRef.current), [])

  // --- 播放位置：播放器 → store ----------------------------------------------

  /** 把真实播放位置写进 store，并同步进度条与时钟文字。回环切断也在这里 */
  const emitPlayhead = useCallback(
    (ms: number) => {
      if (ms === lastEmittedRef.current) return
      lastEmittedRef.current = ms
      setPlayhead(ms)
      if (seekBarRef.current) seekBarRef.current.value = String(ms)
      if (clockRef.current) clockRef.current.textContent = formatTime(ms)
    },
    [setPlayhead],
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoActive) return
    setRvfcMissing(!hasFrameCallback(video))

    return requestFrameLoop(video, (meta: FrameMeta) => {
      // 画布模式没有 rVFC 自动重绘，时钟只能由这里推——`renderAt` 是它唯一的入口。
      // 内部自己排队（只保留最后一次），逐帧调用不会把 IPC 排成长队。
      void overlayRef.current?.renderAt(meta.mediaTime * 1000)

      emitPlayhead(Math.round(meta.mediaTime * 1000))

      // 音频是主时钟，视频跟着它走。偏差小时微调播放速率（静音视频调速无副作用），
      // 大到追不回来才硬 seek —— 每次超阈值就 seek 会让画面一直抖。
      // 基准速率是用户选的试听速率，纠偏只在它上下浮动 ±2%。
      const base = rateRef.current
      const engine = audioRef.current
      if (!engine?.available || !engine.playing) {
        if (video.playbackRate !== base) video.playbackRate = base
        return
      }
      // 纠偏比的是「播放时钟」，所以这里用 currentTime 而不是 mediaTime：
      // mediaTime 是已呈现帧的时间，天然落后于播放位置一帧左右。
      const drift = video.currentTime - engine.positionSec
      if (Math.abs(drift) > HARD_SYNC_S) {
        video.currentTime = engine.positionSec
        video.playbackRate = base
      } else if (Math.abs(drift) > SOFT_SYNC_S) {
        video.playbackRate = base * (drift > 0 ? 1 - SYNC_RATE_DELTA : 1 + SYNC_RATE_DELTA)
      } else if (video.playbackRate !== base) {
        video.playbackRate = base
      }
    })
  }, [emitPlayhead, videoActive])

  /**
   * 没有可用视频时的时钟：rVFC 依附于 <video>，纯音频工程（以及视频放不了、
   * 已降级为纯音频的工程）里它一帧都不会触发。此时直接读音频引擎
   * （主时钟本来就是它），否则播放头会一动不动 ——
   * 「先只有音轨、边听边打轴」正是本工具最常见的起点（CLAUDE.md §2.5）。
   */
  useEffect(() => {
    if (videoActive || !playing) return
    let raf = 0
    const tick = (): void => {
      const engine = audioRef.current
      if (engine?.available) {
        const pos = engine.positionSec
        // 音频放完了要自己停：没有 <video> 就没有 onEnded 兜底
        if (engine.durationSec > 0 && pos >= engine.durationSec) {
          emitPlayhead(Math.round(engine.durationSec * 1000))
          setPlaying(false)
          return
        }
        emitPlayhead(Math.round(pos * 1000))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emitPlayhead, videoActive, playing, setPlaying])

  // --- 播放位置：store → 播放器（时间轴 / 注音编辑器发来的跳转意图） ----------

  const seekTo = useCallback(
    (ms: number) => {
      const sec = Math.max(0, ms / 1000)
      const video = usableVideo()
      if (video) video.currentTime = sec
      audioRef.current?.seek(sec)
      if (seekBarRef.current) seekBarRef.current.value = String(ms)
      if (clockRef.current) clockRef.current.textContent = formatTime(ms)
      // 暂停时 seek，浏览器仍会呈现新帧并触发 rVFC，JASSUB 自会重绘；
      // 没有视频画面时补一次，避免字幕停在旧位置
      if (!video || !video.videoWidth) void overlayRef.current?.repaint()
    },
    [usableVideo],
  )

  /**
   * store 里的播放头只要不是本组件刚写进去的，就一律当成「别人请求跳到这里」。
   * 时间轴点波形、概览条、注音编辑器跳到某个字，走的都是这一条路 ——
   * 它们不碰任何播放器，真正的 seek 只在这里发生一次。
   */
  useEffect(() => {
    return useProject.subscribe((state) => {
      if (state.playheadMs === lastEmittedRef.current) return
      lastEmittedRef.current = state.playheadMs
      seekTo(state.playheadMs)
    })
  }, [seekTo])

  // --- 播放 / 暂停 -----------------------------------------------------------

  useEffect(() => {
    const engine = audioRef.current
    if (!playing) {
      videoRef.current?.pause()
      engine?.pause()
      return
    }
    void (async () => {
      const at = useProject.getState().playheadMs / 1000

      // 第一步：起音频。它是主时钟也是唯一声源，只有它失败才算「播不了」。
      try {
        await engine?.play(at)
        setPlaybackError(null)
      } catch (e) {
        setPlaying(false)
        setPlaybackError(t('media.player.err.playFailed', { detail: describeError(e) }))
        return
      }

      // 第二步：起画面。视频只是从动方，起不来就地降级为纯音频预览，
      // **不许回头去动播放状态** —— 否则 WebKit 放不了 mkv 会把整段播放掐掉。
      const video = usableVideo()
      if (!video) return
      try {
        video.currentTime = at
        video.playbackRate = rateRef.current
        await video.play()
      } catch {
        markVideoUnplayable()
      }
    })()
  }, [playing, setPlaying, audioState, usableVideo, markVideoUnplayable])

  const onEnded = useCallback(() => setPlaying(false), [setPlaying])

  const onSeekBar = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const ms = Number(e.target.value)
      lastEmittedRef.current = ms
      setPlayhead(ms)
      seekTo(ms)
    },
    [seekTo, setPlayhead],
  )

  // --- 试听混音台 -------------------------------------------------------------

  /**
   * 套用一个预设。
   *
   * 「原声 / 伴奏」与导出的 ON/OFF VOCAL 一一对应，所以**写回 `audioMode`**：
   * 导出舞台上那个设置就是它，不写回的话同屏两个控件会各说各的。
   * 「仅人声」没有对应的导出变体，**绝不写** —— 这就是"编辑期 solo 人声"
   * 不可能变成"导出一条只有人声的成片"的结构性保证。
   */
  const applyPreset = useCallback(
    (preset: MonitorPreset) => {
      setLevels(presetLevels(preset, layers, trimsRef.current, guideEnabled))
      if (preset !== 'vocals') setAudioMode(preset)
    },
    [layers, setAudioMode, guideEnabled],
  )

  /** 拖某一层的音量。**滑块直接就是该层的增益**，不是"预设之上的修正量" */
  const setLayerLevel = useCallback((id: LayerId, value: number) => {
    // 只记非零值：拉到 0 是"暂时不要这层"，预设切回来时该还原成拉到 0 之前的音量
    if (value > AUDIBLE_EPS) trimsRef.current = { ...trimsRef.current, [id]: value }
    setLevels((prev) => ({ ...prev, [id]: value }))
  }, [])

  /**
   * 当前落在哪个预设上。**由"实际听得见哪几层"反推**，而不是记一个独立的选中态：
   * 把人声拉到 0 之后耳朵里就只剩伴奏，此时高亮「伴奏」才是实话。
   * 一个都不匹配（例如两层都拉到 0）就谁都不高亮。
   */
  // 引导声不参与反推：它是叠加层，开着它不该让「原声」这一档失去高亮
  const audible = layers.filter(
    (id) => id !== GUIDE_LAYER && (levels[id] ?? 0) > AUDIBLE_EPS,
  )
  const activePreset =
    MONITOR_PRESETS.find((p) => {
      const on = presetLayers(p, layers)
      return on.length > 0 && on.length === audible.length && on.every((id) => audible.includes(id))
    }) ?? null

  const ready = new Set(readyLayers)

  /**
   * 某条层为什么用不了。返回 null 表示可用。
   *
   * 缺的东西**禁用而不隐藏**：藏起来用户只会以为没这个功能，而真实原因
   * （还没分离 / 这条轨没加载上）是他自己能去解决的。
   */
  const layerBlockReason = (id: LayerId): string | null => {
    if (ready.has(id)) return null
    if (audioState === 'loading') return t('media.player.mix.loading')
    // 工程里压根没有这条轨 = 还没分离；有路径却没就绪 = 加载失败（详情在下方警告里）
    return layerPath(id) ? t('media.player.mix.loadFailed') : t('media.player.mix.needSeparate')
  }

  /** 某个预设为什么不能选。返回 null 表示可选 */
  const presetBlockReason = (preset: MonitorPreset): string | null => {
    if (audioState === 'loading') return t('media.player.mix.loading')
    // 一条轨都没有时，原因是"工程还没有音轨"，不是"音频引擎不可用"——
    // 后者会把"你还没导入素材"说成"你的浏览器有毛病"。
    if (layers.length === 0) return t('media.player.mix.noAudio')
    if (audioState !== 'webaudio') return t('media.player.mix.unavailable')
    const need = presetLayers(preset, layers)
    if (need.length === 0) return t('media.player.mix.needSeparate')
    for (const id of need) {
      const reason = layerBlockReason(id)
      if (reason) return reason
    }
    return null
  }

  // 只有一层时"分轨音量"就是主音量，多一个入口只会让人以为它们是两回事。
  // 引导声不算在内：它没有分轨滑块（见 `GUIDE_LAYER`）
  const stemLayers = layers.filter((id) => id !== GUIDE_LAYER)
  const mixerAvailable = stemLayers.length > 1

  /** 引导声这一层为什么不能开。返回 null 表示可开。 */
  const guideBlockReason = (): string | null => {
    if (!layers.includes(GUIDE_LAYER)) return t('media.player.mix.guideMissing')
    if (audioState === 'loading') return t('media.player.mix.loading')
    if (audioState !== 'webaudio') return t('media.player.mix.unavailable')
    return layerBlockReason(GUIDE_LAYER)
  }

  // --- 渲染 ------------------------------------------------------------------

  if (!project) {
    return (
      <div className={className} style={styles.placeholder}>
        {t('align.noProject')}
      </div>
    )
  }

  if (blocked) {
    return (
      <div className={className} style={styles.placeholder}>
        <IssueList issues={fatal} />
      </div>
    )
  }

  /*
   * 素材状态与降级状态必须分开算，这是本组件最容易搞错的一处。
   *
   * - **素材没准备好**（工程刚建 / 视频正在下载）是正常的中间状态，用户什么都
   *   不用做。它的归宿是画面区那行中性说明，**不进警告列表**。
   * - **降级**是"本该做到的事没做到，已经用次优方案顶着"，前提是**真的有东西可退**。
   *   没有视频时说"已改用视频自身的声音"就是无中生有 —— 那正是这次要修的 bug。
   */
  const busyJob = activity[0] ?? null
  const downloading = activity.some((j) => j.kind === 'media.download')
  const proxyBuilding = activity.some((j) => j.kind === 'media.proxy')
  /** 声音真的退回了 `<video>` 自带音轨。画面这条路不通时退无可退，不算降级 */
  const usingVideoAudio = videoActive && audioState === 'fallback'
  /** 画面放不了、又没有独立音轨：此刻预览既没画面也没声音，必须说出来 */
  const silent = videoUnplayable && !audioPath && audioState === 'fallback'

  const issues: PreviewIssue[] = [
    // 跨源隔离那条只关系到 libass 的渲染线程数，字幕层还没挂起来时提它没有意义，
    // 只会让"素材还没到"的空预览凭空多一条黄字
    ...(videoActive ? envIssues : envIssues.filter((i) => i.level === 'fatal')),
    ...overlayWarnings,
    ...audioWarnings,
    ...(rvfcMissing
      ? [
          {
            level: 'warn' as const,
            title: t('media.player.warn.noFrameSyncTitle'),
            detail: t('media.player.warn.noFrameSyncDetail'),
          },
        ]
      : []),
    ...(usingVideoAudio
      ? [
          {
            level: 'warn' as const,
            title: t('media.player.warn.fallbackTitle'),
            detail: t('media.player.warn.fallbackDetail'),
          },
        ]
      : []),
    ...(silent
      ? [
          {
            level: 'warn' as const,
            title: t('media.player.audioMissing'),
            detail: t('media.player.audioMissingHint'),
          },
        ]
      : []),
    ...(videoUnplayable
      ? [
          {
            level: 'warn' as const,
            title: t('media.player.warn.unplayableTitle'),
            detail:
              t('media.player.warn.unplayableDetail') +
              // 代理正在生成时不该催用户去生成代理——他已经在等了
              (proxyBuilding
                ? t('media.player.warn.unplayableBuilding')
                : proxyPath
                  ? t('media.player.warn.unplayableRetry')
                  : t('media.player.warn.unplayableNeedProxy')),
          },
        ]
      : []),
  ]

  /**
   * 画面区当前该说什么：主行说"是什么状态"，副行说"接下来会怎样 / 该做什么"。
   * 没有副行就不显示，不硬凑。
   */
  const stageNote = ((): { title: string; hint?: string } | null => {
    if (videoActive) return null
    if (videoUnplayable) {
      return {
        title: t('media.player.unplayable'),
        hint: proxyBuilding
          ? t('media.player.busyHint')
          : proxyPath
            ? undefined
            : t('media.player.unplayableProxyHint'),
      }
    }
    // 下载优先于"只有音轨"：下载中的工程随时会长出画面，说"只有音轨"是错的
    if (downloading) {
      return { title: t('media.player.downloading'), hint: t('media.player.busyHint') }
    }
    if (audioPath) return { title: t('media.player.audioOnly') }
    if (busyJob) {
      return {
        title: t(BUSY_LABEL[busyJob.kind] ?? 'media.player.preparing'),
        hint: t('media.player.busyHint'),
      }
    }
    return { title: t('media.player.noAssets'), hint: t('media.player.noAssetsHint') }
  })()

  /**
   * 画面区的比例跟着工程走，与「样式」舞台的 `--sty-aspect` 同一个道理：
   * 编辑器里看到的形状必须是成片的形状。1:1 的 MV 塞进写死的 16:9 盒子里，
   * 画面只占中间 56%，两侧一大片黑——那不是这支片子的样子。
   *
   * 尺寸未知时（工程还没有画面）退回 16:9。补边开着时它是**补边后**的画布比例，
   * 因为 `canvasSize` 取自 ASS 的 PlayRes。
   */
  const filmW = canvasSize?.width ?? project.video_width
  const filmH = canvasSize?.height ?? project.video_height
  const filmAspect = filmW > 0 && filmH > 0 ? `${filmW} / ${filmH}` : '16 / 9'

  return (
    <div className={className} style={styles.root}>
      {/*
       * 画面区分两层，**不能合成一层**。
       *
       * 外层 `stage` 只是一块黑底，它的高度由上下游布局说了算：编辑舞台给的是
       * `flex: 0 1 auto`、导出舞台给的是 `flex: 1 1 auto`，窗口一变形它就被压扁
       * 或拉高，`aspectRatio` 在这种时候是让位的一方。
       *
       * 内层 `film` 才是画布，比例恒等于 ASS 的 PlayRes：宽度按容器查询单位算出
       * 信箱式内缩的结果，高度交给宽高比推导，两个方向都不会被外面的形变带走。
       *
       * **已被验证是错的做法**：让字幕画布直接铺满 `stage`。画布模式下 JASSUB
       * 不碰 canvas 的 CSS 尺寸（`resize()` 里设 CSS 宽高那段有 `if (this._video)`
       * 守着），只把位图按 PlayRes 比例内缩后交给 CSS 去拉伸——盒子比例一旦不等于
       * PlayRes，字幕就被拉伸，且随窗口比例连续变化，而同一个盒子里的 `<video>`
       * 有 `object-fit: contain` 顶着、画面纹丝不动，看起来就像"只有字幕会变形"。
       * 视频模式没这个毛病是因为那时 JASSUB 自己把 canvas 摆到视频的内容矩形上。
       */}
      <div style={{ ...styles.stage, aspectRatio: filmAspect }}>
        <div
          style={{
            ...styles.film,
            aspectRatio: filmAspect,
            // 信箱式内缩：宽度取"盒子宽"与"盒子高 × 画幅比"里的小者。
            // 比例直接复用 `filmAspect`（`1920 / 1080` 这样的分式），
            // 与上一行同源——另算一份数值就多一处会漂移的地方
            width: `min(100cqw, calc(100cqh * ${filmAspect}))`,
          }}
        >
          {hasVideo && (
            <video
              ref={videoRef}
              // 跨源隔离页面里不加 crossOrigin，带 CORP 头的媒体会加载失败；
              // JASSUB 还要靠未被污染的画面读色彩空间来对齐字幕颜色矩阵
              crossOrigin="anonymous"
              playsInline
              muted
              preload="auto"
              src={api.mediaUrl(project.id, videoSrcKind)}
              onEnded={onEnded}
              // 元素报错就地降级为纯音频，**不当致命错误**：声音、播放头、打轴、
              // 导出全都不依赖这条视频轨（WebKit 放不了 .mkv 时走的正是这里）
              onError={markVideoUnplayable}
              style={styles.video}
            />
          )}
          {/* 字幕画布的宿主：铺满整个画布，字幕因此能画进补边的黑边里 */}
          <div ref={overlayHostRef} style={styles.overlayHost} />
          {stageNote && (
            <div style={styles.noVideo}>
              <span style={styles.noVideoTitle}>{stageNote.title}</span>
              {stageNote.hint && <span style={styles.noVideoHint}>{stageNote.hint}</span>}
            </div>
          )}
          {overlayLoading && videoActive && (
            <div style={styles.badge}>{t('media.player.overlayLoading')}</div>
          )}
        </div>
      </div>

      <div style={styles.controls}>
        <button type="button" onClick={() => setPlaying(!playing)} style={styles.button}>
          {playing ? t('media.player.pause') : t('media.player.play')}
        </button>

        <span ref={clockRef} style={styles.clock}>
          {formatTime(useProject.getState().playheadMs)}
        </span>
        <span style={styles.duration}>/ {formatTime(durationMs)}</span>

        <input
          ref={seekBarRef}
          type="range"
          min={0}
          max={Math.max(1, durationMs)}
          defaultValue={useProject.getState().playheadMs}
          onChange={onSeekBar}
          style={styles.seek}
        />

        <span style={styles.dim}>{t('media.player.mix.label')}</span>
        <div style={styles.group} role="group" aria-label={t('media.player.mix.label')}>
          {MONITOR_PRESETS.map((preset) => {
            const blocked = presetBlockReason(preset)
            return (
              <button
                key={preset}
                type="button"
                data-testid={`mix-preset-${preset}`}
                aria-pressed={activePreset === preset}
                disabled={!!blocked}
                title={blocked ?? undefined}
                onClick={() => applyPreset(preset)}
                style={{
                  ...styles.toggle,
                  ...(activePreset === preset ? styles.toggleActive : null),
                  ...(blocked ? styles.toggleDisabled : null),
                }}
              >
                {t(`media.player.mix.${preset}`)}
              </button>
            )
          })}
        </div>

        {/*
          引导声：**独立开关，不是第四档**。它能配原声也能配伴奏，与那三档正交。
          按下去写的是 store 的 `guideEnabled`，也就是导出设置里的「混入引导声」
          ——同一份状态，不可能出现"设置勾了、预览听不到"。
        */}
        {(() => {
          const blocked = guideBlockReason()
          return (
            <button
              type="button"
              data-testid="mix-guide-toggle"
              aria-pressed={guideEnabled && !blocked}
              disabled={!!blocked}
              title={blocked ?? undefined}
              onClick={() => setGuideEnabled(!guideEnabled)}
              style={{
                ...styles.toggle,
                ...(guideEnabled && !blocked ? styles.toggleActive : null),
                ...(blocked ? styles.toggleDisabled : null),
              }}
            >
              {t('media.player.mix.guide')}
            </button>
          )
        })()}

        {mixerAvailable && (
          <button
            type="button"
            data-testid="mix-tracks-toggle"
            aria-expanded={mixerOpen}
            title={t('media.player.mix.tracksHint')}
            onClick={() => setMixerOpen((v) => !v)}
            style={{ ...styles.toggle, ...(mixerOpen ? styles.toggleActive : null) }}
          >
            {t('media.player.mix.tracks')}
          </button>
        )}

        <label style={styles.volume}>
          {t('media.player.volume')}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>
      </div>

      {/*
        分轨音量。滑块直接就是各层增益——「原声」档把人声压到 20~30%
        就是日本卡拉OK 那种ガイドボーカル入り的试听方式，而这正是
        "原声/伴奏"两个固定档覆盖不到的中间地带（§8.7）。
      */}
      {mixerAvailable && mixerOpen && (
        <div style={styles.mixer} data-testid="mix-tracks">
          {stemLayers.map((id) => {
            const blocked = layerBlockReason(id)
            const disabled = !!blocked
            return (
              <label key={id} style={styles.mixerRow} title={blocked ?? undefined}>
                <span style={styles.mixerName}>{t(`media.player.track.${id}`)}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={disabled}
                  data-testid={`mix-level-${id}`}
                  value={levels[id] ?? 0}
                  onChange={(e) => setLayerLevel(id, Number(e.target.value))}
                  style={styles.mixerSlider}
                />
                <span style={styles.mixerValue}>{Math.round((levels[id] ?? 0) * 100)}%</span>
              </label>
            )
          })}
        </div>
      )}

      {(overlayError ?? playbackError) && (
        <IssueList
          issues={[
            ...(overlayError
              ? [{ level: 'fatal' as const, title: t('media.player.err.overlayTitle'), detail: overlayError }]
              : []),
            ...(playbackError
              ? [{ level: 'fatal' as const, title: t('media.player.err.playTitle'), detail: playbackError }]
              : []),
          ]}
        />
      )}
      {issues.length > 0 && <IssueList issues={issues} />}
    </div>
  )
}

function IssueList({ issues }: { issues: PreviewIssue[] }) {
  return (
    <ul style={styles.issues}>
      {issues.map((issue, i) => (
        <li
          key={`${issue.title}-${i}`}
          style={{
            ...styles.issue,
            ...(issue.level === 'fatal' ? styles.issueFatal : styles.issueWarn),
          }}
        >
          <strong>{issue.title}</strong>
          <div style={styles.issueDetail}>{issue.detail}</div>
        </li>
      ))}
    </ul>
  )
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 8 },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: 16,
    color: '#888',
    fontSize: 13,
  },
  // 画面区的外层：一块黑底，被压扁时露出来的就是它，画布本身在 `film` 里。
  //
  // aspectRatio 由工程的画面尺寸逐次覆盖（见 `filmAspect`）；这里的 16/9 只是
  // 还没有画面时的兜底。写死 16/9 会让 1:1 / 4:3 的片子被塞进一个横长的盒子里，
  // 画面缩在中间、两侧一大片黑，编辑时看到的形状根本不是成片的形状。
  //
  // `containerType: size` 是给 `film` 的宽度公式用的：它要按**这块盒子**的实际
  // 宽高去算内缩，而 cqw / cqh 取的正是最近的 size 容器
  stage: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#000',
    aspectRatio: '16 / 9',
    overflow: 'hidden',
    minHeight: 0,
    containerType: 'size',
  },
  // 画布。宽度由 JSX 处按画幅算出（`min(100cqw, 100cqh × 画幅比)`，即信箱式内缩），
  // 高度交给 aspect-ratio 推导，比例因此恒等于 ASS 的 PlayRes。
  //
  // **已被验证是错的做法**：`width: 100% + max-height: 100% + aspect-ratio`。
  // 看起来该由宽高比把高度上限转成宽度上限，chromium 与 WebKit 实测都**不会**：
  // `width` 是明确值时只有高度被截断、宽度纹丝不动，盒子比例照样被压扁，
  // 与不改之前逐个相同，等于没修。回归基线 `scripts/verify-preview-aspect.mjs`。
  film: {
    position: 'relative',
    aspectRatio: '16 / 9',
    overflow: 'hidden',
  },
  video: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
  // 铺满画布、不吃鼠标事件（走带与徽章仍要可点）
  overlayHost: { position: 'absolute', inset: 0, pointerEvents: 'none' },
  noVideo: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '0 16px',
    textAlign: 'center',
  },
  // 主行比副行亮：一眼先读到"现在是什么状态"，再读"接下来会怎样"。
  // 两行同色会糊成一段说明文字，正是要避免的观感
  noVideoTitle: { color: '#aab', fontSize: 14 },
  noVideoHint: { color: '#777', fontSize: 12 },
  badge: {
    position: 'absolute',
    left: 8,
    top: 8,
    padding: '2px 8px',
    borderRadius: 4,
    background: 'rgba(0,0,0,.6)',
    color: '#ddd',
    fontSize: 12,
  },
  controls: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  button: { padding: '4px 14px', cursor: 'pointer' },
  clock: { fontVariantNumeric: 'tabular-nums', fontSize: 13, minWidth: 64 },
  duration: { fontVariantNumeric: 'tabular-nums', fontSize: 13, color: '#888' },
  seek: { flex: 1, minWidth: 120 },
  group: { display: 'flex' },
  dim: { fontSize: 12, color: '#888' },
  toggle: { padding: '4px 12px', cursor: 'pointer' },
  toggleActive: { fontWeight: 700 },
  toggleDisabled: { cursor: 'not-allowed', opacity: 0.5 },
  volume: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 },
  // 分轨那一排单独占一行：挤进走带行会把进度条压没，而它本来就是"展开才看"的东西
  mixer: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12 },
  mixerRow: { display: 'flex', alignItems: 'center', gap: 6 },
  mixerName: { color: '#aab', minWidth: 28 },
  mixerSlider: { width: 96 },
  mixerValue: { color: '#888', fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' },
  issues: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  issue: { padding: '6px 10px', borderRadius: 4, fontSize: 12, lineHeight: 1.6 },
  issueFatal: { background: '#3a1414', color: '#ffb4b4' },
  issueWarn: { background: '#3a3214', color: '#ffe2a8' },
  issueDetail: { opacity: 0.85 },
} satisfies Record<string, CSSProperties>

export default Preview
