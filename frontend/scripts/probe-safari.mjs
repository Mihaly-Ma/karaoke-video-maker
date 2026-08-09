// 用 Playwright 的 WebKit 引擎复现 Safari 上的
// 「无法开始播放：The operation is not supported.」
//
// Chromium 下一切正常，说明这是 WebKit 特有问题。契约 §5.9 记着
// JASSUB 要求 Safari 17+ 且 WebKit 路径踩过坑，但从未实测过。

import { webkit } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui'
const logs = []

const browser = await webkit.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(2000)

console.log('=== WebKit 环境能力 ===')
const env = await page.evaluate(() => ({
  ua: navigator.userAgent.slice(0, 90),
  crossOriginIsolated: globalThis.crossOriginIsolated,
  SharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  AudioContext: typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined',
  rVFC: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  OffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  transferControl: !!HTMLCanvasElement.prototype.transferControlToOffscreen,
}))
console.log(JSON.stringify(env, null, 2))

const sel = page.locator('select').first()
if ((await sel.locator('option').count()) > 1) {
  await sel.selectOption({ index: 1 })
  await page.waitForTimeout(5000)
}
await page.screenshot({ path: `${OUT}/40-safari-loaded.png` })

console.log('\n=== 页面是否渲染 ===')
const dom = await page.evaluate(() => ({
  nodes: document.body.querySelectorAll('*').length,
  buttons: document.querySelectorAll('button').length,
  video: !!document.querySelector('video'),
}))
console.log(JSON.stringify(dom))

console.log('\n=== 点击播放 ===')
logs.length = 0
const playBtn = page.locator('button', { hasText: /播放/ }).first()
if (await playBtn.count()) {
  await playBtn.click()
  await page.waitForTimeout(3000)
}
const err = await page.evaluate(
  () => document.body.innerText.match(/[^\n]*(无法开始播放|not supported|NotSupported)[^\n]*/i)?.[0] ?? '',
)
console.log('  界面提示:', err || '(无)')
const st = await page.evaluate(() => {
  const v = document.querySelector('video')
  return { paused: v?.paused, t: v?.currentTime, err: v?.error?.code ?? null }
})
console.log('  video:', JSON.stringify(st))
logs.slice(0, 15).forEach((l) => console.log('  ', l.slice(0, 220)))
await page.screenshot({ path: `${OUT}/41-safari-play.png` })

console.log('\n=== 隔离探测：到底哪个 API 不被支持 ===')
const probe = await page.evaluate(async () => {
  const out = {}
  const v = document.querySelector('video')
  if (v) {
    try {
      await v.play()
      out.videoPlay = 'ok'
      v.pause()
    } catch (e) {
      out.videoPlay = `${e.name}: ${e.message}`
    }
  }
  try {
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext
    const ac = new AC()
    out.acState = ac.state
    const r = await fetch('/api/projects')
    const pid = (await r.json())[0]?.id
    const ar = await fetch(`/api/media/file/${pid}/audio`)
    out.fetch = `HTTP ${ar.status}`
    const buf = await ar.arrayBuffer()
    out.bytes = buf.byteLength
    try {
      const ab = await ac.decodeAudioData(buf.slice(0))
      out.decode = `${ab.duration.toFixed(2)}s`
      // 关键：WebKit 上 AudioBufferSourceNode 的 playbackRate / start 行为
      try {
        const src = ac.createBufferSource()
        src.buffer = ab
        src.playbackRate.value = 0.75
        src.connect(ac.destination)
        src.start(0, 0)
        out.sourceStart = 'ok'
        src.stop()
      } catch (e) {
        out.sourceStart = `${e.name}: ${e.message}`
      }
    } catch (e) {
      out.decode = `${e.name}: ${e.message}`
    }
    await ac.close()
  } catch (e) {
    out.audio = `${e.name}: ${e.message}`
  }
  return out
})
console.log(JSON.stringify(probe, null, 2))

await browser.close()
