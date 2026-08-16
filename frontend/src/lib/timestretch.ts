/**
 * 保音高变速播放器（time-stretching）——`public/audio/timestretch-processor.js` 的主线程封装。
 *
 * 打轴要 0.5~0.75x 慢速试听（CLAUDE.md §5.10），而 `AudioBufferSourceNode.playbackRate`
 * 是重采样：0.75x 会整体降调约 5 个半音，跟着唱对不上音。本模块用一个自持采样源的
 * AudioWorklet（WSOLA）替掉那条路，音高不变、时长按比例变。
 *
 * ## 对外形态：多输出的单个节点，而不是每层一个节点
 *
 * 一个 `AudioWorkletNode`、每条 stem 占一个**输出序号**，各自接自己的 `GainNode`。
 * 这样增益/交叉淡入仍在 Web Audio 图里做（沿用原 AudioEngine 的结构），
 * 而时间拉伸的**帧偏移决策在节点内部只做一次、所有层共用** ——
 * 这是"两条 stem 相加不产生梳状滤波"的唯一依据，理由与证明见处理器文件头。
 *
 * 由此有一条不能违反的用法约束：**不要给每条 stem 各建一个 TimeStretchPlayer**。
 * 那等于各跑各的相似度搜索，相加即相位抵消，而且只在"原声"档（两层同时出声）
 * 才听得出来，单听任何一层都是好的 —— 极易漏测。
 *
 * ## 降级
 *
 * `create()` 在浏览器不支持 AudioWorklet、或处理器脚本加载失败时抛错。调用方必须
 * 接住并退回原来的 `AudioBufferSourceNode` 路径（变调变速），只在界面上说明
 * "慢速试听会降调"，**不能让播放整个不可用**（CLAUDE.md §2.5）。
 */

/** 与处理器文件里的 `PROCESSOR_NAME` 必须一致 */
const PROCESSOR_NAME = 'kvm-timestretch'

/** 处理器脚本。放 public/ 是为了让 Vite 原样下发，理由见处理器文件头 */
const DEFAULT_PROCESSOR_URL = '/audio/timestretch-processor.js'

/** 可调参数，语义见处理器文件里的 `DEFAULT_PARAMS` */
export interface StretchParams {
  frameMs: number
  searchMs: number
  corrMs: number
  decim: number
  centerBias: number
}

export interface TimeStretchOptions {
  /** 层 id 列表。**顺序即输出序号**，构造后不可变 */
  layerIds: readonly string[]
  /**
   * 参与相似度搜索的层。省略则用所有层的等增益和。
   *
   * **绝不能按当前增益加权**：原声/伴奏交叉淡入时增益在变，参考跟着变、
   * 帧偏移跟着变，切轨瞬间两条 stem 的对齐会一起跳。
   *
   * 选哪一层只影响拉伸**质量**（对齐更贴合谁），不影响相加的相位一致性
   * —— 后者只取决于"偏移共享"这一件事。
   */
  referenceLayerIds?: readonly string[]
  params?: Partial<StretchParams>
  processorUrl?: string
  /**
   * 构造期就位的音轨 + 立即起播。**只给 OfflineAudioContext 用。**
   *
   * 实测 Chrome 在离线渲染时整段跑完才投递 port 消息，`setLayer()` / `play()`
   * 在渲染期间根本到不了处理器，输出全静音；而事后到达的命令会让时钟看起来正常，
   * 排查时极具迷惑性（见 scripts/verify-timestretch-browser.mjs）。
   *
   * 实时播放**不要用这条路**：processorOptions 是结构化克隆、无法转移所有权，
   * 整曲会多复制一份内存。
   */
  offline?: {
    layers: ReadonlyArray<{ id: string; buffer: AudioBuffer }>
    rate?: number
    fromSec?: number
  }
}

interface ClockReport {
  ctxTime: number
  mediaSec: number
  rate: number
  playing: boolean
  durationSec: number
}

/** 已经 addModule 过的 AudioContext，避免重复注册（重复调用本身是幂等的，但省一次网络往返） */
const registered = new WeakSet<BaseAudioContext>()

/** 当前环境是否可能支持保音高变速。真正能不能用要等 `create()` 的结果 */
export function isTimeStretchSupported(): boolean {
  return typeof AudioWorkletNode === 'function'
}

export class TimeStretchPlayer {
  private readonly ctx: BaseAudioContext
  private readonly node: AudioWorkletNode
  private readonly layerIds: readonly string[]
  private readonly loaded = new Set<string>()

  /**
   * 主线程侧的时钟镜像。
   *
   * 命令发出去之后先乐观地就地更新（否则从 `play()` 到 worklet 第一次上报之间
   * 播放头会停住），worklet 的上报到达后再校正。两者相差不超过一个渲染量子
   * （<3ms）加一次 postMessage 的投递延迟。
   */
  private clock: ClockReport = {
    ctxTime: 0,
    mediaSec: 0,
    rate: 1,
    playing: false,
    durationSec: 0,
  }
  private disposed = false

  private constructor(ctx: BaseAudioContext, node: AudioWorkletNode, layerIds: readonly string[]) {
    this.ctx = ctx
    this.node = node
    this.layerIds = layerIds
    node.port.onmessage = (e: MessageEvent<ClockReport & { type: string }>) => {
      if (e.data?.type === 'clock') this.clock = e.data
    }
  }

  static async create(
    ctx: BaseAudioContext,
    opts: TimeStretchOptions,
  ): Promise<TimeStretchPlayer> {
    if (!isTimeStretchSupported()) throw new Error('该浏览器不支持 AudioWorklet')
    if (opts.layerIds.length === 0) throw new Error('至少要有一条音轨')
    if (!registered.has(ctx)) {
      await ctx.audioWorklet.addModule(opts.processorUrl ?? DEFAULT_PROCESSOR_URL)
      registered.add(ctx)
    }
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: opts.layerIds.length,
      outputChannelCount: opts.layerIds.map(() => 2),
      processorOptions: {
        layerIds: [...opts.layerIds],
        referenceLayerIds: [...(opts.referenceLayerIds ?? [])],
        params: opts.params ?? {},
        initialLayers: (opts.offline?.layers ?? []).map((l) => ({
          id: l.id,
          channels: Array.from({ length: l.buffer.numberOfChannels }, (_, c) =>
            l.buffer.getChannelData(c),
          ),
          length: l.buffer.length,
        })),
        initialRate: opts.offline?.rate,
        autoplayFromSec: opts.offline ? (opts.offline.fromSec ?? 0) : undefined,
      },
    })
    const player = new TimeStretchPlayer(ctx, node, opts.layerIds)
    for (const l of opts.offline?.layers ?? []) {
      player.loaded.add(l.id)
      player.clock.durationSec = Math.max(player.clock.durationSec, l.buffer.duration)
    }
    return player
  }

  /**
   * 装载一条音轨。样本数据**复制一份再转移**给 worklet：
   * 直接转移 `AudioBuffer.getChannelData()` 的底层 buffer 会把 AudioBuffer 本身
   * 掏空（detach），调用方手上那份就静音了。复制的峰值代价是一条声道的大小，
   * 转移完成后主线程可以丢掉 AudioBuffer，净内存不变。
   */
  setLayer(id: string, buffer: AudioBuffer): void {
    if (this.disposed || !this.layerIds.includes(id)) return
    const channels: ArrayBuffer[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice().buffer)
    }
    this.node.port.postMessage({ type: 'layer', id, channels, length: buffer.length }, channels)
    this.loaded.add(id)
    this.clock = { ...this.clock, durationSec: Math.max(this.clock.durationSec, buffer.duration) }
  }

  has(id: string): boolean {
    return this.loaded.has(id)
  }

  /** 把某层的输出接到它自己的增益节点。层未装载时输出静音，接了也无害 */
  connectLayer(id: string, destination: AudioNode): void {
    const idx = this.layerIds.indexOf(id)
    if (idx < 0) return
    this.node.connect(destination, idx)
  }

  disconnectAll(): void {
    this.node.disconnect()
  }

  play(offsetSec: number): void {
    if (this.disposed) return
    this.node.port.postMessage({ type: 'play', offsetSec })
    this.clock = { ...this.clock, ctxTime: this.ctx.currentTime, mediaSec: offsetSec, playing: true }
  }

  pause(): void {
    if (this.disposed) return
    const at = this.positionSec
    this.node.port.postMessage({ type: 'pause' })
    this.clock = { ...this.clock, ctxTime: this.ctx.currentTime, mediaSec: at, playing: false }
  }

  seek(offsetSec: number): void {
    if (this.disposed) return
    this.node.port.postMessage({ type: 'seek', offsetSec })
    this.clock = { ...this.clock, ctxTime: this.ctx.currentTime, mediaSec: offsetSec }
  }

  /**
   * 变速。1.0 会走处理器里的**直通**分支：不加窗、不搭接、不额外耗 CPU，
   * 正常速度下没有任何拉伸带来的音质损失。
   */
  setRate(rate: number): void {
    if (this.disposed || !(rate > 0) || rate === this.clock.rate) return
    const at = this.positionSec
    this.node.port.postMessage({ type: 'rate', value: rate })
    this.clock = { ...this.clock, ctxTime: this.ctx.currentTime, mediaSec: at, rate }
  }

  get rate(): number {
    return this.clock.rate
  }

  get playing(): boolean {
    return this.clock.playing
  }

  get durationSec(): number {
    return this.clock.durationSec
  }

  /**
   * 当前媒体位置（秒）。
   *
   * 语义与原 AudioEngine 一致：以 `ctx.currentTime` 为准外推，因此**不含
   * `AudioContext.outputLatency`** —— 报的是"已渲染到哪里"，比"耳朵听到哪里"
   * 早 outputLatency（典型 10~30ms）。这是既有行为，改它会一并影响视频纠偏基准，
   * 要动就得连着 `<video>` 的比较基准一起动。
   */
  get positionSec(): number {
    if (!this.clock.playing) return this.clock.mediaSec
    const elapsed = Math.max(0, this.ctx.currentTime - this.clock.ctxTime)
    return this.clock.mediaSec + elapsed * this.clock.rate
  }

  /**
   * 释放。返回的 promise 在处理器交回样本内存后 resolve。
   *
   * 处理器收到 `dispose` 会把整曲样本 transfer **回主线程**——WebKit 关闭
   * AudioContext 时并不回收 worklet 堆里的 ArrayBuffer 后备内存（实测每切一次
   * 工程净留 ~135MB），transfer-back 的 detach 是唯一立即生效的放手动作。
   * 调用方应等这个 promise 再 `ctx.close()`，否则关闭可能抢在消息投递之前。
   * 带超时兜底：worklet 线程已死时（此时内存本来就随线程回收了）不能卡住关闭队列。
   */
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.disposed = true
    const ack = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000)
      this.node.port.onmessage = (e: MessageEvent<{ type?: string }>) => {
        if (e.data?.type !== 'disposed') return
        // 回执携带的 buffer 到这里就没有引用了，随消息一起进主线程的垃圾
        clearTimeout(timer)
        this.node.port.close()
        resolve()
      }
    })
    try {
      this.node.port.postMessage({ type: 'dispose' })
    } catch {
      /* port 已关闭 */
    }
    this.node.disconnect()
    return ack
  }
}
