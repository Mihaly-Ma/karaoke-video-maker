/**
 * 保音高变速的**浏览器端**验证：真的走 AudioWorklet，不是在 Node 里跑纯 DSP。
 *
 * Node 那份（verify-timestretch.mjs）证明的是算法本身；这份补的是"接线"层面
 * 只有浏览器才答得了的四个问题：
 *
 * 1. `audioWorklet.addModule()` 吃不吃带 `export` 的模块脚本
 *    —— 处理器文件要同时被 Node import 做离线验证，所以它必须带 export。
 * 2. 一个节点开多个输出、每个输出各接一个 GainNode，路由对不对（层有没有串台）。
 * 3. worklet 渲染出来的样本与 Node 核心逐样本一致 —— 一致才说明接线没有改变行为。
 * 4. 实时性：OfflineAudioContext 渲染 N 秒要多少墙钟时间（= CPU 余量）。
 *
 * 需要 dev server 已经在 5173 跑着（由主会话持有，本脚本只做导航，不改任何东西）。
 * 素材经 page.route 从磁盘喂进去，不落进 public/。
 *
 * 用法：node frontend/scripts/verify-timestretch-browser.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const DATA = resolve(REPO, 'workspace/ts_test')
const RATE = 0.75

const { WsolaStretcher } = await import(
  pathToFileURL(resolve(REPO, 'frontend/public/audio/timestretch-processor.js')).href
)

// --- Node 侧参考渲染（与浏览器逐样本对比用）---------------------------------

function readWavF32(path) {
  const buf = readFileSync(path)
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4) }
    } else if (id === 'data') data = buf.subarray(body, body + size)
    pos = body + size + (size % 2)
  }
  const frames = Math.floor(data.length / (4 * fmt.channels))
  const chs = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) chs[c][i] = data.readFloatLE((i * fmt.channels + c) * 4)
  }
  return { channels: chs, sampleRate: fmt.sampleRate, length: frames }
}

const v = readWavF32(resolve(DATA, 'v12.wav'))
const i = readWavF32(resolve(DATA, 'i12.wav'))
const sr = v.sampleRate
const outFrames = Math.floor(Math.min(v.length, i.length) / RATE)

const layers = [
  { channels: v.channels, length: v.length, reference: true },
  { channels: i.channels, length: i.length, reference: true },
]
const core = new WsolaStretcher(sr)
core.setLayers(layers)
core.setRate(RATE)
core.reset(0)
const nodeOut = layers.map((l) => l.channels.map(() => new Float32Array(outFrames)))
{
  const chunk = layers.map((l) => l.channels.map(() => new Float32Array(128)))
  let done = 0
  while (done < outFrames) {
    const n = Math.min(128, outFrames - done)
    for (const l of chunk) for (const ch of l) ch.fill(0)
    core.render(chunk, 0, n)
    for (let li = 0; li < layers.length; li++) {
      for (let c = 0; c < layers[li].channels.length; c++) {
        nodeOut[li][c].set(chunk[li][c].subarray(0, n), done)
      }
    }
    done += n
  }
}

// --- 浏览器 ------------------------------------------------------------------

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
page.on('console', (m) => console.log(`  [page:${m.type()}] ${m.text()}`.slice(0, 300)))
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`.slice(0, 300)))

for (const name of ['v12', 'i12']) {
  await page.route(`**/testdata/${name}.wav`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'audio/wav', 'cross-origin-resource-policy': 'same-origin' },
      body: readFileSync(resolve(DATA, `${name}.wav`)),
    }),
  )
}

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })

const result = await page.evaluate(
  async ({ rate, outFrames, sampleRate }) => {
    const mod = await import('/src/lib/timestretch.ts')
    const report = { steps: [] }

    const load = async (ctx, url) => {
      const buf = await (await fetch(url)).arrayBuffer()
      return ctx.decodeAudioData(buf)
    }

    // --- 离线渲染：逐样本对照 + CPU 余量 ---
    const off = new OfflineAudioContext({
      numberOfChannels: 2,
      length: outFrames,
      sampleRate,
    })
    const vBuf = await load(off, '/testdata/v12.wav')
    const iBuf = await load(off, '/testdata/i12.wav')

    let player
    try {
      player = await mod.TimeStretchPlayer.create(off, {
        layerIds: ['vocals', 'inst'],
        // 离线渲染必须走构造期数据通道，理由见 TimeStretchOptions.offline 的注释
        offline: {
          layers: [
            { id: 'vocals', buffer: vBuf },
            { id: 'inst', buffer: iBuf },
          ],
          rate,
          fromSec: 0,
        },
      })
      report.addModuleOk = true
    } catch (e) {
      report.addModuleOk = false
      report.addModuleError = String(e)
      return report
    }

    // 两条 stem 各接自己的 GainNode —— 与 AudioEngine 的图结构一致。
    // 这里刻意只开人声那条，用来验证"输出序号没有串台"。
    // 诊断：worklet 在离线渲染期间到底跑没跑（时钟上报是唯一的活体信号）
    const seen = []
    const rawPort = player.node.port
    const prev = rawPort.onmessage
    rawPort.onmessage = (e) => {
      seen.push(e.data)
      prev?.call(rawPort, e)
    }

    const gV = off.createGain()
    const gI = off.createGain()
    gV.gain.value = 1
    gI.gain.value = 0
    gV.connect(off.destination)
    gI.connect(off.destination)
    player.connectLayer('vocals', gV)
    player.connectLayer('inst', gI)

    const t0 = performance.now()
    const rendered = await off.startRendering()
    report.renderMs = performance.now() - t0
    report.renderedSec = rendered.duration
    report.xRealtime = rendered.duration / (report.renderMs / 1000)

    await new Promise((r) => setTimeout(r, 200))
    report.clockMessages = seen.length
    report.lastClock = seen[seen.length - 1] ?? null

    const left = rendered.getChannelData(0)
    let rms = 0
    for (let k = 0; k < left.length; k++) rms += left[k] * left[k]
    report.rms = Math.sqrt(rms / left.length)

    // 把渲染结果传回 Node（base64），在那边与核心输出逐样本比
    const bytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
    let bin = ''
    const CH = 0x8000
    for (let k = 0; k < bytes.length; k += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(k, k + CH))
    }
    report.leftB64 = btoa(bin)

    // --- 实时上下文：时钟是否真的在走 ---
    try {
      const rt = new AudioContext({ sampleRate })
      const p2 = await mod.TimeStretchPlayer.create(rt, { layerIds: ['vocals'] })
      const g = rt.createGain()
      g.gain.value = 0.0001 // 无声跑，只看时钟
      g.connect(rt.destination)
      p2.connectLayer('vocals', g)
      const vb = await load(rt, '/testdata/v12.wav')
      p2.setLayer('vocals', vb)
      p2.setRate(rate)
      await rt.resume()
      const startCtx = rt.currentTime
      p2.play(1)
      await new Promise((r) => setTimeout(r, 1500))
      const wall = rt.currentTime - startCtx
      report.clock = {
        wallSec: wall,
        positionSec: p2.positionSec,
        expected: 1 + wall * rate,
        durationSec: p2.durationSec,
        playing: p2.playing,
      }
      // 变速状态下跳转：位置必须立刻落到目标点，并继续按 rate 推进
      const seekTo = 5
      const seekCtx = rt.currentTime
      p2.seek(seekTo)
      await new Promise((r) => setTimeout(r, 700))
      const seekWall = rt.currentTime - seekCtx
      report.seek = {
        wallSec: seekWall,
        positionSec: p2.positionSec,
        expected: seekTo + seekWall * rate,
      }
      p2.pause()
      report.clockAfterPause = p2.positionSec
      p2.dispose()
      await rt.close()
    } catch (e) {
      report.clockError = String(e)
    }
    player.dispose()
    return report
  },
  { rate: RATE, outFrames, sampleRate: sr },
)

console.log('\n=== 浏览器端 AudioWorklet 验证 ===')
console.log(`  addModule（带 export 的模块脚本） ${result.addModuleOk ? '通过' : '失败: ' + result.addModuleError}`)
if (!result.addModuleOk) {
  await browser.close()
  process.exit(1)
}
console.log(
  `  离线渲染 ${result.renderedSec.toFixed(2)}s 用时 ${result.renderMs.toFixed(0)}ms = ${result.xRealtime.toFixed(0)}x 实时`,
)
console.log(`  输出 RMS ${(20 * Math.log10(result.rms)).toFixed(1)} dBFS`)
console.log(
  `  离线渲染期间收到的时钟上报 ${result.clockMessages} 条，最后一条 ${JSON.stringify(result.lastClock)}`,
)

const raw = Buffer.from(result.leftB64, 'base64')
const browserLeft = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
let maxDiff = 0
let firstBad = -1
const n = Math.min(browserLeft.length, outFrames)
for (let k = 0; k < n; k++) {
  const d = Math.abs(browserLeft[k] - nodeOut[0][0][k])
  if (d > maxDiff) {
    maxDiff = d
    if (firstBad < 0 && d > 1e-5) firstBad = k
  }
}
console.log(`  与 Node 核心逐样本最大差 ${maxDiff.toExponential(3)}（比较 ${n} 个样本）`)
console.log(
  `  串台检查：只开了人声增益，输出应当等于人声层 → ${maxDiff < 1e-5 ? '未串台' : `可疑，首个偏差样本 #${firstBad}`}`,
)

if (result.clock) {
  const c = result.clock
  console.log(
    `  实时时钟：墙钟 ${c.wallSec.toFixed(3)}s → positionSec ${c.positionSec.toFixed(3)}s（期望 ${c.expected.toFixed(3)}s，差 ${((c.positionSec - c.expected) * 1000).toFixed(1)}ms）`,
  )
  const s = result.seek
  console.log(
    `  变速中跳转到 5s：${s.wallSec.toFixed(3)}s 后 positionSec ${s.positionSec.toFixed(3)}s（期望 ${s.expected.toFixed(3)}s，差 ${((s.positionSec - s.expected) * 1000).toFixed(1)}ms）`,
  )
  console.log(`  暂停后位置保持 ${result.clockAfterPause.toFixed(3)}s，时长 ${c.durationSec.toFixed(2)}s`)
} else {
  console.log(`  实时时钟检查未完成：${result.clockError}`)
}

await browser.close()
