/**
 * 保音高变速的离线客观验证。
 *
 * 跑的是**生产代码本身** —— 直接 import `public/audio/timestretch-processor.js` 里的
 * `WsolaStretcher`，不是复制一份算法来测（复制品测过了不代表线上那份对）。
 *
 * 覆盖四件事：
 *
 * 1. **保音高**：合成信号量基频、真实音乐量对数频谱的整体平移。
 *    合成信号能给出精确到音分的真值，但只测正弦波会漏掉真实素材上的问题
 *    （CLAUDE.md §5.4 记过"绝不用合成信号测分离模型"的教训，那条针对的是分离模型，
 *    但"只测合成信号就收工"这个毛病是共通的），所以两者都要有。
 * 2. **时长**：输出时长应当严格等于 输入时长 / rate。
 * 3. **双 stem 相加不产生相位问题**：共享帧偏移下
 *    `stretch(v) + stretch(i) === stretch(v + i)` 应当在浮点精度上成立；
 *    同时跑一个**故意做错**的对照组（两条 stem 各跑各的拉伸器），
 *    量出梳状滤波到底长什么样 —— 没有对照组就无法证明测量本身有分辨力。
 * 4. **播放头准不准**：用互相关量出"输出某时刻实际对应输入哪个时刻"，
 *    与理想映射 `input = anchor + out * rate` 比，给出中位/p90/最大误差。
 *
 * 用法：
 *   node frontend/scripts/verify-timestretch.mjs [--rate 0.75] [--seconds 20]
 *
 * 素材：`workspace/ts_test/{v,i}.wav`（32-bit float WAV，见文件末尾的生成命令）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const PROCESSOR = resolve(REPO, 'frontend/public/audio/timestretch-processor.js')

const { WsolaStretcher } = await import(pathToFileURL(PROCESSOR).href)

// ---------------------------------------------------------------------------
// WAV 读写（只支持本脚本用到的 32-bit float / 16-bit PCM）
// ---------------------------------------------------------------------------

function readWav(path) {
  const buf = readFileSync(path)
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(`${path} 不是 WAV`)
  }
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, body + size)
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error(`${path} 缺 fmt/data 块`)
  const { channels, sampleRate, bits } = fmt
  const bytes = bits >> 3
  const frames = Math.floor(data.length / (bytes * channels))
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const off = (i * channels + c) * bytes
      out[c][i] = bits === 32 ? data.readFloatLE(off) : data.readInt16LE(off) / 32768
    }
  }
  return { channels: out, sampleRate, length: frames }
}

function writeWav(path, channels, sampleRate) {
  const nc = channels.length
  const frames = channels[0].length
  const dataBytes = frames * nc * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVEfmt ', 8, 'latin1')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(nc, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * nc * 2, 28)
  buf.writeUInt16LE(nc * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'latin1')
  buf.writeUInt32LE(dataBytes, 40)
  let p = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nc; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]))
      buf.writeInt16LE(Math.round(v * 32767), p)
      p += 2
    }
  }
  writeFileSync(path, buf)
}

// ---------------------------------------------------------------------------
// 基础 DSP：FFT / 频谱 / 基频
// ---------------------------------------------------------------------------

/** 就地基 2 FFT。re/im 长度必须是 2 的幂 */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

function hann(n) {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n))
  return w
}

/** 长时平均幅度谱（LTAS） */
function ltas(x, fftSize = 4096, hop = 2048) {
  const w = hann(fftSize)
  const bins = fftSize / 2
  const acc = new Float64Array(bins)
  let frames = 0
  for (let s = 0; s + fftSize <= x.length; s += hop) {
    const re = new Float64Array(fftSize)
    const im = new Float64Array(fftSize)
    for (let i = 0; i < fftSize; i++) re[i] = x[s + i] * w[i]
    fft(re, im)
    for (let k = 0; k < bins; k++) acc[k] += Math.hypot(re[k], im[k])
    frames++
  }
  if (frames > 0) for (let k = 0; k < bins; k++) acc[k] /= frames
  return acc
}

const LOG_F_LO = 80
const LOG_F_HI = 6000
const LOG_STEP = 0.25 // 1/4 半音
const LOG_PTS = Math.round((12 * Math.log2(LOG_F_HI / LOG_F_LO)) / LOG_STEP)

/** 把一帧的幅度谱重采样到对数频率轴（1/4 半音一格）并取 log10、去均值 */
function logSpectrum(x, start, fftSize, sampleRate) {
  const w = hann(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  for (let k = 0; k < fftSize; k++) re[k] = (x[start + k] ?? 0) * w[k]
  fft(re, im)
  const out = new Float64Array(LOG_PTS)
  let mean = 0
  for (let idx = 0; idx < LOG_PTS; idx++) {
    const f = LOG_F_LO * Math.pow(2, (idx * LOG_STEP) / 12)
    const bin = (f * fftSize) / sampleRate
    const i0 = Math.floor(bin)
    const t = bin - i0
    const m0 = Math.hypot(re[i0], im[i0])
    const m1 = Math.hypot(re[i0 + 1] ?? 0, im[i0 + 1] ?? 0)
    out[idx] = Math.log10(m0 * (1 - t) + m1 * t + 1e-12)
    mean += out[idx]
  }
  mean /= LOG_PTS
  for (let idx = 0; idx < LOG_PTS; idx++) out[idx] -= mean
  return out
}

/**
 * 两帧频谱在对数频率轴上的整体平移（半音）。
 *
 * **必须逐帧配对做，不能拿长时平均谱（LTAS）来做。** 这是被自己的对照组抓出来的：
 * 先前的实现比较整段 LTAS，结果连"整体重采样降 4.98 半音"这个已知真值都测成 0.013 半音
 * —— 20 秒平均之后谐波梳状结构被抹平，只剩一条平缓的谱包络，互相关峰宽到没有分辨力。
 * 若当时只跑 WSOLA、不跑对照组，就会拿着一个失灵的尺子宣布"保音高通过"。
 * 逐帧谱保留谐波梳，互相关峰很锐，对照组能稳定报出 -4.98。
 */
function frameShiftSemitones(A, B) {
  const maxShift = Math.round(12 / LOG_STEP) // ±12 半音
  let best = 0
  let bestScore = -Infinity
  const scores = new Map()
  for (let s = -maxShift; s <= maxShift; s++) {
    let dot = 0
    let ea = 0
    let eb = 0
    for (let i = 0; i < LOG_PTS; i++) {
      const j = i + s
      if (j < 0 || j >= LOG_PTS) continue
      dot += A[i] * B[j]
      ea += A[i] * A[i]
      eb += B[j] * B[j]
    }
    const sc = ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : -1
    scores.set(s, sc)
    if (sc > bestScore) {
      bestScore = sc
      best = s
    }
  }
  const y0 = scores.get(best - 1) ?? bestScore
  const y2 = scores.get(best + 1) ?? bestScore
  const denom = y0 - 2 * bestScore + y2
  const frac = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
  return (best + frac) * LOG_STEP
}

/**
 * 逐帧配对量"输出相对输入平移了多少半音"。
 * 输出的 T 时刻对应输入的 `T * rate` 时刻 —— 拉伸与重采样都满足这条映射，
 * 所以同一把尺子可以同时量两者，这是对照组成立的前提。
 */
function pairedPitchShift(inSig, outSig, sampleRate, rate, fftSize = 4096) {
  const shifts = []
  for (let t = 1; ; t += 0.25) {
    const oStart = Math.round(t * sampleRate)
    const iStart = Math.round(oStart * rate)
    if (oStart + fftSize >= outSig.length || iStart + fftSize >= inSig.length) break
    let e = 0
    for (let k = 0; k < fftSize; k++) e += outSig[oStart + k] * outSig[oStart + k]
    if (Math.sqrt(e / fftSize) < 1e-3) continue
    shifts.push(
      frameShiftSemitones(
        logSpectrum(inSig, iStart, fftSize, sampleRate),
        logSpectrum(outSig, oStart, fftSize, sampleRate),
      ),
    )
  }
  shifts.sort((a, b) => a - b)
  const q = (p) => shifts[Math.min(shifts.length - 1, Math.floor(shifts.length * p))] ?? NaN
  return { n: shifts.length, median: q(0.5), p10: q(0.1), p90: q(0.9) }
}

/** 单帧自相关基频。返回 {f0, conf}，无声/无周期性返回 f0=0 */
function frameF0(x, start, size, sampleRate, fMin = 70, fMax = 900) {
  let rms = 0
  for (let i = 0; i < size; i++) rms += x[start + i] * x[start + i]
  rms = Math.sqrt(rms / size)
  if (rms < 1e-4) return { f0: 0, conf: 0 }

  const n = 1 << Math.ceil(Math.log2(size * 2))
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const w = hann(size)
  for (let i = 0; i < size; i++) re[i] = x[start + i] * w[i]
  fft(re, im)
  for (let k = 0; k < n; k++) {
    const p = re[k] * re[k] + im[k] * im[k]
    re[k] = p
    im[k] = 0
  }
  fft(re, im) // 实偶序列，正/逆变换只差常数因子，用于取自相关足够
  const r0 = re[0]
  if (r0 <= 0) return { f0: 0, conf: 0 }
  const lagMin = Math.floor(sampleRate / fMax)
  const lagMax = Math.min(Math.floor(sampleRate / fMin), size - 1)
  let bestLag = 0
  let bestVal = -Infinity
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (re[lag] > bestVal) {
      bestVal = re[lag]
      bestLag = lag
    }
  }
  if (bestLag === 0) return { f0: 0, conf: 0 }
  const y0 = re[bestLag - 1]
  const y1 = re[bestLag]
  const y2 = re[bestLag + 1] ?? y1
  const d = y0 - 2 * y1 + y2
  const frac = d !== 0 ? (0.5 * (y0 - y2)) / d : 0
  return { f0: sampleRate / (bestLag + frac), conf: bestVal / r0 }
}

// ---------------------------------------------------------------------------
// 渲染帮手
// ---------------------------------------------------------------------------

/**
 * 离线跑一遍拉伸器。按 128 帧（渲染量子）分块，与浏览器里的调用形态一致 ——
 * 一次性 render 整段会把"分块处理有没有状态 bug"这类问题全部掩盖掉。
 */
function renderOffline(core, layers, outFrames, quantum = 128) {
  const out = layers.map((l) => l.channels.map(() => new Float32Array(outFrames)))
  const chunk = layers.map((l) => l.channels.map(() => new Float32Array(quantum)))
  const t0 = process.hrtime.bigint()
  let done = 0
  while (done < outFrames) {
    const n = Math.min(quantum, outFrames - done)
    for (const layer of chunk) for (const ch of layer) ch.fill(0)
    core.render(chunk, 0, n)
    for (let li = 0; li < layers.length; li++) {
      for (let c = 0; c < layers[li].channels.length; c++) {
        out[li][c].set(chunk[li][c].subarray(0, n), done)
      }
    }
    done += n
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { out, ms }
}

function makeCore(sampleRate, layers, rate) {
  const core = new WsolaStretcher(sampleRate)
  core.setLayers(layers)
  core.setRate(rate)
  core.reset(0)
  return core
}

const mono = (chs) => {
  const n = chs[0].length
  const m = new Float32Array(n)
  for (const ch of chs) for (let i = 0; i < n; i++) m[i] += ch[i] / chs.length
  return m
}

const rms = (x) => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

const db = (v) => 20 * Math.log10(Math.max(v, 1e-20))

// ---------------------------------------------------------------------------
// 各项检查
// ---------------------------------------------------------------------------

function checkSynthetic(sampleRate, rate) {
  console.log('\n=== 1. 合成信号：基频与时长 ===')
  const secs = 8
  const n = secs * sampleRate
  const f0 = 220
  // 纯正弦不足以暴露拼接问题，用带谐波的锯齿更接近乐音
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h
    x[i] = v * 0.2
  }
  const layers = [{ channels: [x], length: n, reference: true }]
  const outFrames = Math.round(n / rate)
  const core = makeCore(sampleRate, layers, rate)
  const { out } = renderOffline(core, layers, outFrames)
  const y = out[0][0]

  const est = (sig) => {
    const vals = []
    for (let s = 0; s + 4096 < sig.length; s += 4096) {
      const r = frameF0(sig, s, 4096, sampleRate)
      if (r.f0 > 0) vals.push(r.f0)
    }
    vals.sort((a, b) => a - b)
    return vals[vals.length >> 1]
  }
  const fIn = est(x)
  const fOut = est(y)
  const cents = 1200 * Math.log2(fOut / fIn)

  // 对照：现有实现（重采样）会把频率整体乘以 rate
  const naiveCents = 1200 * Math.log2(rate)

  console.log(`  输入基频            ${fIn.toFixed(2)} Hz（真值 ${f0} Hz）`)
  console.log(`  WSOLA ${rate}x 输出   ${fOut.toFixed(2)} Hz → 偏差 ${cents.toFixed(2)} 音分`)
  console.log(`  重采样（现状）对照    偏差 ${naiveCents.toFixed(1)} 音分`)
  console.log(
    `  时长                ${(y.length / sampleRate).toFixed(3)}s（期望 ${(n / sampleRate / rate).toFixed(3)}s）`,
  )
  return Math.abs(cents)
}

function checkRealPitch(v, i, sampleRate, rate, outDir) {
  console.log('\n=== 2. 真实音乐：保音高 ===')
  const layers = [
    { channels: v.channels, length: v.length, reference: true },
    { channels: i.channels, length: i.length, reference: true },
  ]
  const outFrames = Math.round(Math.max(v.length, i.length) / rate)
  const core = makeCore(sampleRate, layers, rate)
  const { out, ms } = renderOffline(core, layers, outFrames)

  const mixIn = new Float32Array(v.length)
  const vm = mono(v.channels)
  const im = mono(i.channels)
  for (let k = 0; k < v.length; k++) mixIn[k] = vm[k] + im[k]
  const mixOut = new Float32Array(outFrames)
  const vom = mono(out[0])
  const iom = mono(out[1])
  for (let k = 0; k < outFrames; k++) mixOut[k] = vom[k] + iom[k]

  // 对照：线性插值重采样 = 现有 playbackRate 的行为。
  // **对照组不是可选项** —— 它是这把尺子有没有分辨力的唯一证据，见 frameShiftSemitones 的注释。
  const naive = new Float32Array(outFrames)
  for (let k = 0; k < outFrames; k++) {
    const p = k * rate
    const p0 = Math.floor(p)
    const t = p - p0
    naive[k] = (mixIn[p0] ?? 0) * (1 - t) + (mixIn[p0 + 1] ?? 0) * t
  }

  const okShift = pairedPitchShift(mixIn, mixOut, sampleRate, rate)
  const naiveShift = pairedPitchShift(mixIn, naive, sampleRate, rate)
  const theory = 12 * Math.log2(rate)
  console.log(
    `  逐帧谱平移（WSOLA，${okShift.n} 帧）  中位 ${okShift.median.toFixed(3)} 半音` +
      `（p10 ${okShift.p10.toFixed(2)} / p90 ${okShift.p90.toFixed(2)}）`,
  )
  console.log(
    `  逐帧谱平移（重采样对照组）        中位 ${naiveShift.median.toFixed(3)} 半音` +
      `（理论 ${theory.toFixed(3)}）← 尺子的分辨力证明`,
  )

  // 逐帧配对的人声基频比较：输出 T 时刻 ↔ 输入 T*rate 时刻
  const size = 4096
  const f0Diff = (sig) => {
    const diffs = []
    for (let s = 0; s + size < sig.length; s += 2048) {
      const a = frameF0(sig, s, size, sampleRate)
      const inStart = Math.round(s * rate)
      if (inStart + size >= vm.length) break
      const b = frameF0(vm, inStart, size, sampleRate)
      if (a.f0 > 0 && b.f0 > 0 && a.conf > 0.3 && b.conf > 0.3) {
        diffs.push(1200 * Math.log2(a.f0 / b.f0))
      }
    }
    diffs.sort((x, y) => x - y)
    const q = (p) => diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * p))] ?? NaN
    return { n: diffs.length, median: q(0.5), p90abs: q(0.9) }
  }
  // 人声轨单独走一遍拉伸（它就是 out[0]），与输入人声配对比基频
  const vStretched = f0Diff(vom)
  const vNaive = new Float32Array(outFrames)
  for (let k = 0; k < outFrames; k++) {
    const p = k * rate
    const p0 = Math.floor(p)
    const t = p - p0
    vNaive[k] = (vm[p0] ?? 0) * (1 - t) + (vm[p0 + 1] ?? 0) * t
  }
  const vNaiveDiff = f0Diff(vNaive)
  console.log(
    `  人声基频偏差（WSOLA，${vStretched.n} 帧）  中位 ${vStretched.median.toFixed(1)} 音分`,
  )
  console.log(
    `  人声基频偏差（重采样对照组）        中位 ${vNaiveDiff.median.toFixed(1)} 音分（理论 ${(1200 * Math.log2(rate)).toFixed(0)}）`,
  )
  console.log(
    `  输出时长                     ${(outFrames / sampleRate).toFixed(3)}s（期望 ${(v.length / sampleRate / rate).toFixed(3)}s）`,
  )
  console.log(
    `  渲染耗时                     ${ms.toFixed(0)}ms / ${(outFrames / sampleRate).toFixed(1)}s 输出 = ${((outFrames / sampleRate / ms) * 1000).toFixed(0)}x 实时`,
  )

  if (outDir) {
    writeWav(resolve(outDir, `out_${rate}x_mix.wav`), [mixOut], sampleRate)
    writeWav(resolve(outDir, `out_${rate}x_naive.wav`), [naive], sampleRate)
    writeWav(resolve(outDir, `in_mix.wav`), [mixIn], sampleRate)
  }
  return { out, mixOut, ms }
}

function checkStemCoherence(v, i, sampleRate, rate, correctMixOut, outDir) {
  console.log('\n=== 3. 双 stem 相加：相位一致性 ===')
  const outFrames = correctMixOut.length

  // (a) 把"和"当成单层直接拉伸 —— 与"分层拉伸再相加"必须逐样本相等
  const vm = mono(v.channels)
  const im = mono(i.channels)
  const sum = new Float32Array(v.length)
  for (let k = 0; k < v.length; k++) sum[k] = vm[k] + im[k]
  const sumLayers = [{ channels: [sum], length: sum.length, reference: true }]
  const sumCore = makeCore(sampleRate, sumLayers, rate)
  const { out: sumOut } = renderOffline(sumCore, sumLayers, outFrames)

  let maxAbs = 0
  for (let k = 0; k < outFrames; k++) {
    maxAbs = Math.max(maxAbs, Math.abs(sumOut[0][0][k] - correctMixOut[k]))
  }
  console.log(`  stretch(v)+stretch(i) vs stretch(v+i)`)
  console.log(`    最大逐样本差   ${maxAbs.toExponential(3)}（${db(maxAbs).toFixed(1)} dBFS）`)
  console.log(`    信号 RMS       ${db(rms(correctMixOut)).toFixed(1)} dBFS`)
  console.log(`    差/信号        ${(db(maxAbs) - db(rms(correctMixOut))).toFixed(1)} dB`)

  // (b) 故意做错的对照组：两条 stem 各跑各的拉伸器（各自只看自己的信号）
  const vLayers = [{ channels: [vm], length: v.length, reference: true }]
  const iLayers = [{ channels: [im], length: i.length, reference: true }]
  const vCore = makeCore(sampleRate, vLayers, rate)
  const iCore = makeCore(sampleRate, iLayers, rate)
  const vTrace = traceOffsets(vCore)
  const iTrace = traceOffsets(iCore)
  const { out: vOut } = renderOffline(vCore, vLayers, outFrames)
  const { out: iOut } = renderOffline(iCore, iLayers, outFrames)
  const broken = new Float32Array(outFrames)
  for (let k = 0; k < outFrames; k++) broken[k] = vOut[0][0][k] + iOut[0][0][k]

  // **互补 stem 的真实症状不是频谱陷波，是两条轨互相错位。**
  // 人声与伴奏内容基本不重叠，各自独立拉伸时各自都好听，坏的是"人声相对节拍浮动"。
  // 直接量两个独立拉伸器选的帧偏移差多少 —— 这是最不含糊的证据。
  const nCmp = Math.min(vTrace.length, iTrace.length)
  const rel = []
  for (let k = 1; k < nCmp; k++) rel.push((Math.abs(vTrace[k] - iTrace[k]) / sampleRate) * 1000)
  rel.sort((a, b) => a - b)
  const qr = (p) => rel[Math.min(rel.length - 1, Math.floor(rel.length * p))] ?? NaN
  console.log(`  故意做错（各自独立拉伸）的对照组：`)
  console.log(
    `    两器帧偏移之差   中位 ${qr(0.5).toFixed(1)}ms / p90 ${qr(0.9).toFixed(1)}ms / 最大 ${qr(1).toFixed(1)}ms`,
  )
  console.log(`      → 人声相对伴奏就是这么多的浮动；共享偏移时恒为 0`)
  console.log(`    整体 RMS 差      ${(db(rms(broken)) - db(rms(correctMixOut))).toFixed(2)} dB`)

  // (c) **共享内容的场景才是梳状滤波真正会出现的地方**，而它就是本应用当下的形态：
  // AudioEngine 现在装的是 (原混音, 伴奏) 两层，交叉淡入的 60ms 里两者同时出声，
  // 而伴奏在两层里都有 —— 同一份内容以两个不同的时间偏移相加，必然梳状滤波。
  const mixLayers = [
    { channels: [sum], length: sum.length, reference: true },
    { channels: [im], length: i.length, reference: true },
  ]
  const { out: sharedOk } = renderOffline(makeCore(sampleRate, mixLayers, rate), mixLayers, outFrames)
  const okShared = new Float32Array(outFrames)
  for (let k = 0; k < outFrames; k++) okShared[k] = sharedOk[0][0][k] + sharedOk[1][0][k]
  const mixOnly = [{ channels: [sum], length: sum.length, reference: true }]
  const { out: sharedA } = renderOffline(makeCore(sampleRate, mixOnly, rate), mixOnly, outFrames)
  const badShared = new Float32Array(outFrames)
  for (let k = 0; k < outFrames; k++) badShared[k] = sharedA[0][0][k] + iOut[0][0][k]

  const specOk = ltas(okShared)
  const specBad = ltas(badShared)
  let worstDip = 0
  let worstHz = 0
  let sumSq = 0
  let cnt = 0
  for (let k = 4; k < specOk.length; k++) {
    const f = (k * sampleRate) / 4096
    if (f < 100 || f > 8000) continue
    const d = db(specBad[k]) - db(specOk[k])
    sumSq += d * d
    cnt++
    if (d < worstDip) {
      worstDip = d
      worstHz = f
    }
  }
  console.log(`  共享内容场景（原混音 + 伴奏同时出声，= 当前交叉淡入的那 60ms）：`)
  console.log(`    整体 RMS 差      ${(db(rms(badShared)) - db(rms(okShared))).toFixed(2)} dB`)
  console.log(`    频谱偏差 RMS     ${Math.sqrt(sumSq / cnt).toFixed(2)} dB`)
  console.log(`    最深陷波         ${worstDip.toFixed(2)} dB @ ${worstHz.toFixed(0)} Hz`)

  if (outDir) {
    writeWav(resolve(outDir, `out_${rate}x_broken.wav`), [broken], sampleRate)
    writeWav(resolve(outDir, `out_${rate}x_shared_ok.wav`), [okShared], sampleRate)
    writeWav(resolve(outDir, `out_${rate}x_shared_broken.wav`), [badShared], sampleRate)
  }
  return maxAbs
}

/** 挂钩 `pickOffset`，把每帧选中的帧偏移记下来。只用于对照实验 */
function traceOffsets(core) {
  const log = []
  const orig = core.pickOffset.bind(core)
  core.pickOffset = (ideal) => {
    const d = orig(ideal)
    log.push(d)
    return d
  }
  return log
}

function checkPlayheadAccuracy(mixIn, mixOut, sampleRate, rate) {
  console.log('\n=== 4. 播放头准确度（变速下）===')
  // 取输出上的一小段，在输入里理想位置附近做互相关，看实际落点偏了多少
  const win = Math.round(sampleRate * 0.03)
  const search = Math.round(sampleRate * 0.05)
  const errs = []
  for (let t = 2; t * sampleRate + win < mixOut.length; t += 0.25) {
    const oStart = Math.round(t * sampleRate)
    const ideal = Math.round(oStart * rate)
    if (ideal - search < 0 || ideal + search + win >= mixIn.length) continue
    let e = 0
    for (let k = 0; k < win; k++) e += mixOut[oStart + k] * mixOut[oStart + k]
    if (Math.sqrt(e / win) < 1e-3) continue
    let best = 0
    let bestScore = -Infinity
    for (let d = -search; d <= search; d++) {
      let dot = 0
      let en = 0
      for (let k = 0; k < win; k += 2) {
        const a = mixIn[ideal + d + k]
        dot += a * mixOut[oStart + k]
        en += a * a
      }
      const sc = en > 0 ? dot / Math.sqrt(en) : -Infinity
      if (sc > bestScore) {
        bestScore = sc
        best = d
      }
    }
    errs.push((Math.abs(best) / sampleRate) * 1000)
  }
  errs.sort((a, b) => a - b)
  const q = (p) => errs[Math.min(errs.length - 1, Math.floor(errs.length * p))] ?? NaN
  console.log(`  样本数 ${errs.length}`)
  console.log(
    `  |实际 - 理想| 中位 ${q(0.5).toFixed(1)}ms / p90 ${q(0.9).toFixed(1)}ms / 最大 ${q(1).toFixed(1)}ms`,
  )
  console.log(`  （搜索半径参数上界 = searchMs = 10ms；误差有界、不随时间累积）`)
}

function checkBypass(v, sampleRate) {
  console.log('\n=== 5. 1.0x 直通 ===')
  const layers = [{ channels: v.channels, length: v.length, reference: true }]
  const core = makeCore(sampleRate, layers, 1)
  const n = Math.min(v.length, sampleRate * 5)
  const { out, ms } = renderOffline(core, layers, n)
  let maxAbs = 0
  for (let c = 0; c < v.channels.length; c++) {
    for (let k = 0; k < n; k++) maxAbs = Math.max(maxAbs, Math.abs(out[0][c][k] - v.channels[c][k]))
  }
  console.log(`  与原始样本最大差 ${maxAbs.toExponential(3)}（0 = 逐比特相同）`)
  console.log(`  5s 渲染耗时 ${ms.toFixed(1)}ms`)
  return maxAbs
}

function checkSeekAndRateSwitch(v, sampleRate) {
  console.log('\n=== 6. seek / 变速切换的连续性 ===')
  const layers = [{ channels: v.channels, length: v.length, reference: true }]
  const core = makeCore(sampleRate, layers, 0.75)
  const quantum = 128
  const chunk = layers.map((l) => l.channels.map(() => new Float32Array(quantum)))
  const tail = []
  let worstJump = 0
  const events = [
    { at: 40, run: () => core.reset(sampleRate * 6) },
    { at: 80, run: () => core.setRate(0.5) },
    { at: 120, run: () => core.setRate(1) },
    { at: 160, run: () => core.setRate(0.75) },
    { at: 200, run: () => core.reset(sampleRate * 2) },
  ]
  for (let q = 0; q < 260; q++) {
    for (const e of events) if (e.at === q) e.run()
    for (const layer of chunk) for (const ch of layer) ch.fill(0)
    core.render(chunk, 0, quantum)
    for (let k = 0; k < quantum; k++) {
      const cur = chunk[0][0][k]
      if (tail.length > 0) {
        const jump = Math.abs(cur - tail[tail.length - 1])
        if (jump > worstJump) worstJump = jump
      }
      tail.push(cur)
      if (tail.length > 4) tail.shift()
    }
  }
  // 与"同一素材不做任何切换"时的最大相邻样本差比较，判断是否引入了额外的跳变
  const ref = v.channels[0]
  let natural = 0
  for (let k = 1; k < Math.min(ref.length, sampleRate * 10); k++) {
    natural = Math.max(natural, Math.abs(ref[k] - ref[k - 1]))
  }
  console.log(`  切换过程中最大相邻样本跳变 ${worstJump.toFixed(4)}`)
  console.log(`  素材本身最大相邻样本跳变   ${natural.toFixed(4)}`)
  console.log(`  ${worstJump <= natural * 1.5 ? '  → 无爆音（未超出素材本身的斜率）' : '  → 有可疑跳变，检查 reset() 的预填'}`)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt
}
const rate = argOf('--rate', 0.75)
const seconds = argOf('--seconds', 20)

const dataDir = resolve(REPO, 'workspace/ts_test')
const vPath = resolve(dataDir, 'v.wav')
const iPath = resolve(dataDir, 'i.wav')
if (!existsSync(vPath) || !existsSync(iPath)) {
  console.error(`缺素材：${vPath} / ${iPath}
生成方式（真实音乐，不是合成信号）：
  ffmpeg -ss 60 -t 30 -i "workspace/sep_full/audio_44k_(Vocals)_htdemucs.flac" -c:a pcm_f32le workspace/ts_test/v.wav
  ffmpeg -ss 60 -t 30 -i workspace/sep_full/instrumental.wav -c:a pcm_f32le workspace/ts_test/i.wav`)
  process.exit(1)
}

const vFull = readWav(vPath)
const iFull = readWav(iPath)
const sampleRate = vFull.sampleRate
const n = Math.min(vFull.length, iFull.length, Math.round(seconds * sampleRate))
const v = { channels: vFull.channels.map((c) => c.subarray(0, n)), length: n, sampleRate }
const i = { channels: iFull.channels.map((c) => c.subarray(0, n)), length: n, sampleRate }

console.log(`素材 ${(n / sampleRate).toFixed(1)}s @ ${sampleRate}Hz，速率 ${rate}x`)
const core0 = new WsolaStretcher(sampleRate)
console.log(
  `参数 frame=${core0.frameLen}(${((core0.frameLen / sampleRate) * 1000).toFixed(1)}ms) ` +
    `hop=${core0.hop} search=±${core0.searchRadius}(${((core0.searchRadius / sampleRate) * 1000).toFixed(1)}ms) ` +
    `corr=${core0.corrLen} decim=${core0.decim}`,
)

checkSynthetic(sampleRate, rate)
const real = checkRealPitch(v, i, sampleRate, rate, dataDir)

const vm = mono(v.channels)
const im = mono(i.channels)
const mixIn = new Float32Array(n)
for (let k = 0; k < n; k++) mixIn[k] = vm[k] + im[k]

checkStemCoherence(v, i, sampleRate, rate, real.mixOut, dataDir)
checkPlayheadAccuracy(mixIn, real.mixOut, sampleRate, rate)
checkBypass(v, sampleRate)
checkSeekAndRateSwitch(v, sampleRate)

console.log(`\n试听产物写在 ${dataDir}/`)
