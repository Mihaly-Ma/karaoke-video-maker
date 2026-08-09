// 复现「无法开始播放：The operation is not supported.」
// 用户实测报告的 bug。抓住确切失败点：是 <video>.play() 还是 Web Audio。

import { chromium } from 'playwright'

const ROOT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md'
const OUT = `${ROOT}/workspace/out/ui`
const logs = []

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

// 选一个已有音频的工程
const sel = page.locator('select').first()
if ((await sel.locator('option').count()) > 1) {
  await sel.selectOption({ index: 1 })
  await page.waitForTimeout(4000)
}

console.log('=== 媒体元素与音频引擎状态 ===')
const st = await page.evaluate(() => {
  const v = document.querySelector('video')
  return {
    hasVideo: !!v,
    videoSrc: v?.currentSrc || v?.src || '(空)',
    videoReadyState: v?.readyState,
    videoError: v?.error ? `code=${v.error.code} ${v.error.message}` : null,
    duration: v?.duration,
    muted: v?.muted,
  }
})
console.log(JSON.stringify(st, null, 2))

console.log('\n=== 点击播放 ===')
logs.length = 0
const playBtn = page.locator('button', { hasText: /^播放$/ }).first()
console.log(`找到播放按钮: ${await playBtn.count()}`)
if (await playBtn.count()) {
  await playBtn.click()
  await page.waitForTimeout(3000)
}
await page.screenshot({ path: `${OUT}/30-playback.png` })

const after = await page.evaluate(() => {
  const v = document.querySelector('video')
  const t = document.body.innerText
  return {
    paused: v?.paused,
    currentTime: v?.currentTime,
    videoError: v?.error ? `code=${v.error.code}` : null,
    // 界面上的错误提示
    notice: t.match(/无法开始播放[^\n]*/)?.[0] ?? t.match(/[^\n]*not supported[^\n]*/i)?.[0] ?? '',
  }
})
console.log(JSON.stringify(after, null, 2))

console.log('\n=== 点击后的控制台 ===')
logs.slice(0, 25).forEach((l) => console.log('  ', l.slice(0, 240)))

// 直接在页面里试探：<video>.play() 与 AudioContext 各自能否工作
console.log('\n=== 隔离探测 ===')
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
  } else out.videoPlay = '(无 video 元素)'

  try {
    const ac = new AudioContext()
    out.audioCtxState = ac.state
    const r = await fetch('/api/projects')
    const projs = await r.json()
    const pid = projs[0]?.id
    if (pid) {
      const ar = await fetch(`/api/media/file/${pid}/audio`)
      out.audioFetch = `HTTP ${ar.status} ${ar.headers.get('content-type')}`
      if (ar.ok) {
        const buf = await ar.arrayBuffer()
        out.audioBytes = buf.byteLength
        try {
          const ab = await ac.decodeAudioData(buf)
          out.decoded = `${ab.duration.toFixed(2)}s ${ab.numberOfChannels}ch`
        } catch (e) {
          out.decoded = `解码失败 ${e.name}: ${e.message}`
        }
      }
    }
    await ac.close()
  } catch (e) {
    out.audioCtx = `${e.name}: ${e.message}`
  }
  return out
})
console.log(JSON.stringify(probe, null, 2))

await browser.close()
