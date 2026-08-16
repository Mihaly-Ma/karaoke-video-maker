/**
 * 保音高变速（time-stretching）：WSOLA 核心 + AudioWorklet 处理器。
 *
 * 打轴的主力手段是 tap-to-time，工作流要求 0.5~0.75x 慢速试听（CLAUDE.md §5.10）。
 * `AudioBufferSourceNode.playbackRate` 是重采样，0.75x 会整体降调约 5 个半音，
 * 跟着唱根本对不上音；本文件就是把那条"后续课题"做掉。
 *
 * ## 为什么是 WSOLA，而不是相位声码器
 *
 * 本项目同一时刻有**多条 stem 同时出声再相加**（D15：人声/伴奏两条源各带增益，
 * "原声" = 两者相加；§8.7 还要扩成主唱/和声/伴奏的混音台）。于是有一条硬性要求：
 *
 * > **各层的时间拉伸必须逐样本确定性一致**，否则相加时会梳状滤波 / 相位抵消，
 * > 听感是"发空、忽远忽近"，而且**只在相加档出现，单听任何一层都是好的**。
 *
 * WSOLA 满足它，而且是可证明的：给定一组共享的帧偏移 `a_k`，输出是
 *
 *     y_c[n] = Σ_k w[n - k·Hs] · x_c[n - k·Hs + a_k]
 *
 * 系数只跟 `k, n` 有关、与通道 c 无关 —— 这是一个**对输入线性的时变算子**，
 * 因此 `Σ_c stretch(x_c) === stretch(Σ_c x_c)`，逐样本成立（只差浮点求和顺序）。
 *
 * 相位声码器**不满足**：它的相位推进由每个 bin 的幅度/相位决定，是非线性的，
 * 各层各算各的相位，相加必然出上面那种问题。这是本文件不用相位声码器的决定性理由，
 * 不是"实现起来更简单"。
 *
 * 由此推出三条已被验证是错的做法，不要回头再走：
 *
 * 1. **每条 stem 各起一个拉伸器**（哪怕算法、参数完全相同）—— 相似度搜索的最佳滞后
 *    是各自算的，两条 stem 会选到不同的 δ，相加即梳状滤波。
 *    `frontend/scripts/verify-timestretch.mjs` 里的 `independent` 变体就是复现它用的。
 * 2. **用"当前增益加权"的信号当相似度搜索的参考** —— 原声/伴奏交叉淡入时增益在变，
 *    参考跟着变、δ 跟着变，切轨瞬间两条 stem 的对齐会一起跳。
 *    参考信号必须与增益无关（本实现固定用等增益和，或调用方显式指定的参考层）。
 * 3. **靠 `<video>.preservesPitch` 省事** —— media element 确实原生保音高，但 D15 已经
 *    否掉了这条路：多条 stem 要各带增益地相加，而 W3C 明确说明音频经
 *    `MediaElementAudioSourceNode` 离开 media element 之后无法再与其它流保持同步。
 *
 * ## 为什么是这个文件形态（public/ 下的纯 JS，且带 export）
 *
 * - 放 `public/`：Vite 对 `public/` 原样下发、不做任何转换。`src/` 下的文件在 dev
 *   会被注入 Vite client import，WebKit 在跨源隔离下会拒绝加载 —— jassub 的
 *   worker/wasm 已经踩过一模一样的坑（见 vite.config.ts 的长注释）。AudioWorklet
 *   同样是"浏览器直接 fetch 这个 URL"的加载方式，走 `public/` 最稳。
 * - 单文件、零 import：`audioWorklet.addModule()` 按 module script 加载，静态 import
 *   的浏览器支持面不确定，不赌。
 * - 带 `export`：module script 里的 export 没有 importer 时被忽略，浏览器侧无害；
 *   而 Node 侧可以直接 `import()` 本文件拿到 `WsolaStretcher` 做离线验证 ——
 *   **验证脚本跑的就是生产代码本身**，不是复制品。
 *   `AudioWorkletProcessor` / `registerProcessor` 只在 `if` 分支里出现，Node 下不求值。
 *
 * ## 时间基准
 *
 * 输出样本数 → 输入（媒体）位置的映射是**精确且不累积漂移**的：
 * `media = anchor + emitted * rate`。相似度搜索选的 δ 只影响"实际听到的波形"
 * 相对这个理想位置有 ±searchMs 的抖动，且**有界、不累积**（每帧都从理想位置重新起算）。
 */

/** 处理器名。TS 侧 `frontend/src/lib/timestretch.ts` 必须用同一个字符串 */
export const PROCESSOR_NAME = 'kvm-timestretch'

/**
 * 默认参数（毫秒）。按采样率换算成样本数，不写死样本数 —— 44.1k / 48k 都要对。
 *
 * - `frameMs` 40ms：窗越长低频越稳、瞬态越糊。40ms 是音乐上的常用折中。
 * - `searchMs` 10ms：相似度搜索半径。它同时是"听到的波形 vs 播放头"的误差上界，
 *   所以不能一味放大；10ms 已能覆盖 100Hz 以上的基音周期，低频靠窗长兜。
 * - `corrMs` 12ms：相关窗长度。
 * - `decim` 4：粗搜索的抽取倍数。全速率直接搜 883 个滞后 × 529 样本 ≈ 23M MAC/s，
 *   在音频线程上太重；抽取 4 倍做粗搜索再 ±4 样本精修，降到约 1.7M MAC/s。
 * - `centerBias` 0.08：对 |δ| 的加性惩罚（NCC 值域 [-1,1]）。作用有二：
 *   静音段 NCC 全 0 时让 δ=0 胜出（否则会随机跳），以及相关平坦时优先小 δ、
 *   把播放头误差压小。太大就会牺牲拼接质量，不要随手调高。
 */
export const DEFAULT_PARAMS = {
  frameMs: 40,
  searchMs: 10,
  corrMs: 12,
  decim: 4,
  centerBias: 0.08,
}

/** 速率与 1 的差小于它就走**直通**（bypass）：不加窗、不搭接，逐样本原样输出 */
export const BYPASS_EPS = 1e-6

/**
 * 一条待拉伸的音轨。
 *
 * @typedef {Object} StretchLayerData
 * @property {Float32Array[]} channels 各声道样本（长度可不等，取 `length` 为准）
 * @property {number} length 样本数
 * @property {boolean} reference 是否参与相似度搜索的参考信号
 */

/**
 * 多层共享决策的 WSOLA 时间拉伸器。
 *
 * 它同时是**采样源**：整段音频由它持有并按受控速率读取。这一点是刻意的 ——
 * AudioWorklet 的 `process()` 固定按图速率给 128 帧输出，若上游是别的节点，
 * 输入侧就必须以 `rate` 倍速消耗，注定要么饿死要么溢出。自己持有数据之后：
 * seek 只是改一个读指针，前瞻样本随手可取（所以**不引入任何附加延迟**），
 * 输出→输入的时间映射也是精确的。
 */
export class WsolaStretcher {
  /**
   * @param {number} sampleRate
   * @param {Partial<typeof DEFAULT_PARAMS>} [params]
   */
  constructor(sampleRate, params) {
    const p = { ...DEFAULT_PARAMS, ...(params ?? {}) }
    this.sampleRate = sampleRate
    this.decim = Math.max(1, Math.round(p.decim))
    this.centerBias = p.centerBias

    // 窗长取偶数，且合成跳距 Hs = L/2 —— 周期 Hann 在 50% 重叠下逐样本严格求和为 1
    // （COLA）。这保证了 rate=1 时 WSOLA 路径本身就是精确重建。
    const rawL = Math.round((sampleRate * p.frameMs) / 1000)
    this.frameLen = rawL + (rawL % 2)
    this.hop = this.frameLen >> 1
    this.searchRadius = Math.round((sampleRate * p.searchMs) / 1000)
    this.corrLen = Math.round((sampleRate * p.corrMs) / 1000)

    /** @type {Float32Array} 周期 Hann 窗 */
    this.window = new Float32Array(this.frameLen)
    for (let n = 0; n < this.frameLen; n++) {
      this.window[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / this.frameLen))
    }

    /** @type {StretchLayerData[]} */
    this.layers = []
    /** @type {Float32Array[]} 各层的抽取后单声道（用于快速重建参考信号） */
    this.layerRefDecim = []
    /** @type {Float32Array} 参考信号（抽取后单声道，等增益和） */
    this.refDecim = new Float32Array(0)
    this.maxLen = 0

    this.rate = 1
    /** 复位锚点：这一刻的输入位置（样本，可含小数） */
    this.anchorInput = 0
    /** 自复位以来已经输出的样本数 */
    this.emitted = 0
    /** 自复位以来已经合成的 OLA 帧数 */
    this.framesProduced = 0
    /** 上一帧实际使用的输入起点 */
    this.prevUsed = 0

    /** @type {Float32Array[][]} OLA 累加器 [层][声道] */
    this.acc = []
    /** @type {Float32Array[][]} 已完成样本的 FIFO [层][声道] */
    this.fifo = []
    this.fifoCount = 0
    this.fifoCap = this.hop + 512

    // 精修阶段用的全速率单声道参考（只覆盖当前帧需要的一小段，不常驻整曲）
    this.scratchLen = this.corrLen + 2 * this.decim + 2
    this.tmplFull = new Float32Array(this.scratchLen)
    this.candFull = new Float32Array(this.scratchLen + 2 * this.decim)
  }

  /** 全曲时长（秒）。以最长的一层为准 */
  get durationSec() {
    return this.maxLen / this.sampleRate
  }

  /**
   * 当前理想输入位置（秒）。
   * 这就是对外的播放头 —— 与实际听到的波形相差不超过 `searchMs`，且不累积。
   */
  get positionSec() {
    return (this.anchorInput + this.emitted * this.rate) / this.sampleRate
  }

  /**
   * 装载/替换所有音轨。**开销是 O(总样本数)**（要为每层算一份抽取后的单声道），
   * 5 分钟立体声约几十毫秒。放在起播前做没有问题，播放中途换层会掉一次帧。
   *
   * @param {StretchLayerData[]} layers
   */
  setLayers(layers) {
    this.layers = layers
    this.maxLen = 0
    for (const l of layers) this.maxLen = Math.max(this.maxLen, l.length)

    const D = this.decim
    const nD = Math.ceil(this.maxLen / D) + 1
    this.layerRefDecim = layers.map((layer) => {
      const out = new Float32Array(nD)
      const nc = layer.channels.length
      if (nc === 0) return out
      const scale = 1 / (nc * D)
      for (let c = 0; c < nc; c++) {
        const x = layer.channels[c]
        const len = Math.min(layer.length, x.length)
        for (let i = 0; i < len; i++) out[(i / D) | 0] += x[i]
      }
      for (let k = 0; k < nD; k++) out[k] *= scale
      return out
    })

    this.refDecim = new Float32Array(nD)
    let any = false
    for (let i = 0; i < layers.length; i++) {
      if (!layers[i].reference) continue
      any = true
      const src = this.layerRefDecim[i]
      for (let k = 0; k < nD; k++) this.refDecim[k] += src[k]
    }
    // 一层参考都没标就退化成"所有层等增益和"——绝不能用增益加权，见文件头第 2 条
    if (!any) {
      for (const src of this.layerRefDecim) {
        for (let k = 0; k < nD; k++) this.refDecim[k] += src[k]
      }
    }

    // 缓冲区按层数/声道数重建
    this.acc = layers.map((l) =>
      l.channels.map(() => new Float32Array(this.frameLen)),
    )
    this.fifo = layers.map((l) => l.channels.map(() => new Float32Array(this.fifoCap)))
    this.reset(this.anchorInput)
  }

  /** @param {number} rate 播放速率（>0）。1 视为直通 */
  setRate(rate) {
    if (!(rate > 0) || rate === this.rate) return
    // 先把已经播过的那段结算进锚点，再换速率 —— 否则历史输出会被按新速率重新折算，
    // 播放头会瞬间跳一大截（原 AudioEngine.setRate 的注释记的是同一件事）。
    this.reset(this.anchorInput + this.emitted * this.rate)
    this.rate = rate
  }

  /**
   * 复位到指定输入位置（样本）。seek / 变速 / 起播 / 直通↔拉伸切换都走这里。
   *
   * **无缝的关键在这里**：把累加器的前 Hs 个样本预填成 `(1 - w[n]) * x[pos + n]`，
   * 于是第一帧（δ 必为 0，见 `pickOffset`）叠上去之后
   * `(1-w)·x + w·x === x`，起始处逐样本等于原信号，没有淡入、也没有爆音。
   * 早先的实现是"累加器清零 + 第一帧直接叠"，起点会有一段 20ms 的淡入，
   * 每次 seek 都"嗒"一下 —— 那是错的。
   *
   * @param {number} inputPos
   */
  reset(inputPos) {
    this.anchorInput = Math.max(0, inputPos)
    this.emitted = 0
    this.framesProduced = 0
    this.prevUsed = Math.round(this.anchorInput) - this.hop
    this.fifoCount = 0

    const start = Math.round(this.anchorInput)
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li]
      for (let c = 0; c < layer.channels.length; c++) {
        const acc = this.acc[li][c]
        acc.fill(0)
        const x = layer.channels[c]
        const len = Math.min(layer.length, x.length)
        const n0 = Math.max(0, -start)
        const n1 = Math.min(this.hop, len - start)
        for (let n = n0; n < n1; n++) acc[n] = (1 - this.window[n]) * x[start + n]
      }
    }
  }

  /**
   * 产出 `count` 个输出样本。
   *
   * @param {Float32Array[][]} out [层][声道] 目标缓冲
   * @param {number} offset 写入起点
   * @param {number} count 样本数
   */
  render(out, offset, count) {
    if (this.layers.length === 0 || count <= 0) return
    if (Math.abs(this.rate - 1) < BYPASS_EPS) {
      this.renderBypass(out, offset, count)
      return
    }
    let done = 0
    while (done < count) {
      if (this.fifoCount === 0) this.produceFrame()
      const n = Math.min(count - done, this.fifoCount)
      for (let li = 0; li < this.layers.length; li++) {
        const chans = this.layers[li].channels
        for (let c = 0; c < chans.length; c++) {
          const dst = out[li] && out[li][c]
          if (dst) dst.set(this.fifo[li][c].subarray(0, n), offset + done)
        }
        for (let c = 0; c < chans.length; c++) {
          this.fifo[li][c].copyWithin(0, n, this.fifoCount)
        }
      }
      this.fifoCount -= n
      done += n
    }
    this.emitted += count
  }

  /**
   * 1.0x 直通：逐样本原样搬运。
   *
   * 这条路必须存在（不能指望"WSOLA 在 rate=1 时恰好等价"）：正常速度下不许有
   * 任何拉伸带来的音质损失，也不该白烧 CPU。
   */
  renderBypass(out, offset, count) {
    const base = Math.round(this.anchorInput) + this.emitted
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li]
      for (let c = 0; c < layer.channels.length; c++) {
        const dst = out[li] && out[li][c]
        if (!dst) continue
        const x = layer.channels[c]
        const len = Math.min(layer.length, x.length)
        const n0 = Math.max(0, -base)
        const n1 = Math.max(n0, Math.min(count, len - base))
        for (let n = n0; n < n1; n++) dst[offset + n] = x[base + n]
      }
    }
    this.emitted += count
  }

  /** 合成一帧并把完成的 Hs 个样本推进 FIFO */
  produceFrame() {
    const L = this.frameLen
    const Hs = this.hop
    const ideal = Math.round(this.anchorInput + this.framesProduced * Hs * this.rate)
    // 复位后第一帧必须落在锚点上，配合 reset() 的预填才无缝
    const start = this.framesProduced === 0 ? ideal : ideal + this.pickOffset(ideal)

    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li]
      for (let c = 0; c < layer.channels.length; c++) {
        const acc = this.acc[li][c]
        const x = layer.channels[c]
        const len = Math.min(layer.length, x.length)
        const n0 = Math.max(0, -start)
        const n1 = Math.max(n0, Math.min(L, len - start))
        for (let n = n0; n < n1; n++) acc[n] += this.window[n] * x[start + n]

        const fifo = this.fifo[li][c]
        fifo.set(acc.subarray(0, Hs), this.fifoCount)
        acc.copyWithin(0, Hs)
        acc.fill(0, Hs)
      }
    }
    this.fifoCount += Hs
    this.prevUsed = start
    this.framesProduced++
  }

  /**
   * 相似度搜索：在 ±searchRadius 内找一个偏移，使新帧的前半段与"上一帧的自然延续"
   * 最像。**这个偏移由参考信号单独算一次，然后原样套用到所有层** —— 全文件的
   * 相位一致性保证就在这一句上（见文件头）。
   *
   * 两段式：抽取 4 倍粗搜索 → 全速率 ±decim 精修。归一化互相关（NCC）避免
   * 一味挑能量大的地方；对 |δ| 加一点加性惩罚以打破静音段的平局。
   *
   * @param {number} ideal 理想输入起点
   * @returns {number} δ（样本）
   */
  pickOffset(ideal) {
    const D = this.decim
    const ref = this.refDecim
    const nD = ref.length
    const corrD = Math.max(4, Math.round(this.corrLen / D))
    const radD = Math.max(1, Math.round(this.searchRadius / D))

    const tIdxD = Math.round((this.prevUsed + this.hop) / D)
    if (tIdxD < 0 || tIdxD + corrD >= nD) return 0

    let tEnergy = 0
    for (let k = 0; k < corrD; k++) {
      const v = ref[tIdxD + k]
      tEnergy += v * v
    }
    if (tEnergy <= 0) return 0
    const tNorm = 1 / Math.sqrt(tEnergy)

    const baseD = Math.round(ideal / D)
    let bestD = 0
    let bestScore = -Infinity
    for (let d = -radD; d <= radD; d++) {
      const idx = baseD + d
      if (idx < 0 || idx + corrD >= nD) continue
      let dot = 0
      let energy = 0
      for (let k = 0; k < corrD; k++) {
        const a = ref[idx + k]
        const b = ref[tIdxD + k]
        dot += a * b
        energy += a * a
      }
      const score =
        (energy > 0 ? (dot * tNorm) / Math.sqrt(energy) : 0) -
        (this.centerBias * Math.abs(d)) / radD
      if (score > bestScore) {
        bestScore = score
        bestD = d
      }
    }

    // --- 全速率精修：粗搜索的量化误差是 ±D 个样本 ---
    const coarse = bestD * D
    const Lc = this.corrLen
    const tStart = this.prevUsed + this.hop
    this.fillMono(this.tmplFull, tStart, Lc)
    let te = 0
    for (let k = 0; k < Lc; k++) te += this.tmplFull[k] * this.tmplFull[k]
    if (te <= 0) return coarse
    const tn = 1 / Math.sqrt(te)

    const candStart = ideal + coarse - D
    this.fillMono(this.candFull, candStart, Lc + 2 * D + 1)
    let bestFine = coarse
    let bestFineScore = -Infinity
    for (let d = -D; d <= D; d++) {
      const off = d + D
      let dot = 0
      let energy = 0
      for (let k = 0; k < Lc; k++) {
        const a = this.candFull[off + k]
        dot += a * this.tmplFull[k]
        energy += a * a
      }
      const delta = coarse + d
      const score =
        (energy > 0 ? (dot * tn) / Math.sqrt(energy) : 0) -
        (this.centerBias * Math.abs(delta)) / this.searchRadius
      if (score > bestFineScore) {
        bestFineScore = score
        bestFine = delta
      }
    }
    return Math.max(-this.searchRadius, Math.min(this.searchRadius, bestFine))
  }

  /**
   * 把 `[start, start+count)` 的参考信号（等增益单声道和）填进 `dst`。
   * 只在精修阶段用，长度几百样本，所以不常驻整曲的全速率参考（那要多占 50MB）。
   */
  fillMono(dst, start, count) {
    dst.fill(0, 0, count)
    const strict = this.hasReference
    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li]
      if (strict && !layer.reference) continue
      const nc = layer.channels.length
      if (nc === 0) continue
      const inv = 1 / nc
      for (let c = 0; c < nc; c++) {
        const x = layer.channels[c]
        const len = Math.min(layer.length, x.length)
        const n0 = Math.max(0, -start)
        const n1 = Math.max(n0, Math.min(count, len - start))
        for (let n = n0; n < n1; n++) dst[n] += x[start + n] * inv
      }
    }
  }

  /** 是否有层被显式标为参考层 */
  get hasReference() {
    for (const l of this.layers) if (l.reference) return true
    return false
  }
}

// ---------------------------------------------------------------------------
// AudioWorklet 处理器（只在 worklet 全局作用域里注册；Node 里不求值）
// ---------------------------------------------------------------------------

if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
  /** 时钟上报周期（渲染量子数）。128 帧 @48k ≈ 2.67ms，20 个约 53ms */
  const REPORT_EVERY = 20

  class TimeStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      const opts = (options && options.processorOptions) || {}
      /** @type {string[]} */
      this.layerIds = opts.layerIds || []
      /** @type {string[]} */
      this.referenceLayerIds = opts.referenceLayerIds || []
      this.core = new WsolaStretcher(sampleRate, opts.params)
      /** @type {(StretchLayerData|null)[]} */
      this.slots = this.layerIds.map(() => null)
      /** 已到货的层 id，顺序与 core.layers 一致 */
      this.presentIds = []
      this.playing = false
      this.quantaSinceReport = 0
      this.alive = true
      this.port.onmessage = (e) => this.onCommand(e.data)

      // 构造期就位的数据通道。**OfflineAudioContext 必须走这条路**：
      // 实测（scripts/verify-timestretch-browser.mjs）Chrome 在离线渲染时
      // **整段渲染跑完才投递 port 消息** —— 渲染期间处理器收不到任何 setLayer/play，
      // 于是整段输出静音，而事后到达的那几条命令让"最后一次时钟上报"看起来一切正常
      // （playing: true、durationSec 正确），极具迷惑性。
      // 实时 AudioContext 没有这个问题，所以生产路径照旧用 postMessage + transfer
      // （processorOptions 是结构化克隆，不能转移所有权，整曲会多复制一份）。
      for (const l of opts.initialLayers || []) {
        this.onCommand({ type: 'layer', id: l.id, channels: l.channels, length: l.length })
      }
      if (opts.initialRate) this.onCommand({ type: 'rate', value: opts.initialRate })
      if (typeof opts.autoplayFromSec === 'number') {
        this.onCommand({ type: 'play', offsetSec: opts.autoplayFromSec })
      }
    }

    onCommand(msg) {
      const core = this.core
      switch (msg.type) {
        case 'layer': {
          const idx = this.layerIds.indexOf(msg.id)
          if (idx < 0) return
          this.slots[idx] = {
            channels: msg.channels.map((b) => new Float32Array(b)),
            length: msg.length,
            reference:
              this.referenceLayerIds.length === 0 || this.referenceLayerIds.includes(msg.id),
          }
          // 位置要跨越重装保持不变，否则分离作业跑完、伴奏轨到货那一刻会跳回开头
          const keep = core.positionSec * sampleRate
          core.setLayers(this.slots.filter((s) => s !== null))
          this.presentIds = this.layerIds.filter((_, i) => this.slots[i] !== null)
          core.reset(keep)
          this.report()
          break
        }
        case 'play':
          core.reset(msg.offsetSec * sampleRate)
          this.playing = true
          this.report()
          break
        case 'pause':
          core.reset(core.positionSec * sampleRate)
          this.playing = false
          this.report()
          break
        case 'seek':
          core.reset(msg.offsetSec * sampleRate)
          this.report()
          break
        case 'rate':
          core.setRate(msg.value)
          this.report()
          break
        case 'dispose': {
          this.alive = false
          // 大块内存（整曲样本 + 抽取参考）transfer 回主线程再置空引用。
          // WebKit 关闭 AudioContext 时不回收 worklet 堆里的 ArrayBuffer 后备内存
          // （实测来回切工程每轮净留 ~135MB，恰为转移进来的样本量），而 detach
          // 是立即生效的放手动作，不依赖 worklet 侧是否还会跑 GC。
          const bufs = new Set()
          for (const s of this.slots) {
            if (!s) continue
            for (const ch of s.channels) if (ch.buffer.byteLength > 0) bufs.add(ch.buffer)
          }
          for (const arr of core.layerRefDecim) if (arr.buffer.byteLength > 0) bufs.add(arr.buffer)
          if (core.refDecim.buffer.byteLength > 0) bufs.add(core.refDecim.buffer)
          this.slots = this.layerIds.map(() => null)
          this.presentIds = []
          core.layers = []
          core.layerRefDecim = []
          core.refDecim = new Float32Array(0)
          core.acc = []
          core.fifo = []
          try {
            this.port.postMessage({ type: 'disposed' }, [...bufs])
          } catch {
            // 端口已关：数据回不去，但引用已清空，只能指望作用域随线程销毁
          }
          break
        }
        default:
          break
      }
    }

    report() {
      this.quantaSinceReport = 0
      this.port.postMessage({
        type: 'clock',
        // 本量子第一个样本的输出时刻，与下面 render 的起点严格对应
        ctxTime: currentTime,
        mediaSec: this.core.positionSec,
        rate: this.core.rate,
        playing: this.playing,
        durationSec: this.core.durationSec,
      })
    }

    process(_inputs, outputs) {
      if (!this.alive) return false
      const frames = outputs.length && outputs[0].length ? outputs[0][0].length : 128
      if (++this.quantaSinceReport >= REPORT_EVERY) this.report()

      if (!this.playing || this.presentIds.length === 0) {
        for (const out of outputs) for (const ch of out) ch.fill(0)
        return true
      }

      // core 的层顺序 = 已到货的层顺序，要映射回节点的输出序号
      const used = new Set()
      const view = []
      for (let i = 0; i < this.presentIds.length; i++) {
        const outIdx = this.layerIds.indexOf(this.presentIds[i])
        view.push(outIdx >= 0 && outputs[outIdx] ? outputs[outIdx] : [])
        if (outIdx >= 0) used.add(outIdx)
      }
      for (let i = 0; i < outputs.length; i++) {
        if (!used.has(i)) for (const ch of outputs[i]) ch.fill(0)
      }

      // 单声道源要铺满立体声输出：core 只写它自己的声道数，这里先清零再补写
      for (const out of view) for (const ch of out) ch.fill(0)
      this.core.render(view, 0, frames)
      for (let i = 0; i < view.length; i++) {
        const layer = this.core.layers[i]
        if (!layer || layer.channels.length !== 1) continue
        const out = view[i]
        for (let c = 1; c < out.length; c++) out[c].set(out[0])
      }
      return true
    }
  }

  registerProcessor(PROCESSOR_NAME, TimeStretchProcessor)
}
