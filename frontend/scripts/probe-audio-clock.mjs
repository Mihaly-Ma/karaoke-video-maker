// 无头浏览器里 AudioContext 的时钟到底走不走。
//
// 为什么单独探一次：`Preview` 是全应用唯一的播放时钟，而它的主时钟就是
// AudioContext（CLAUDE.md D15）。时钟不走 = playheadMs 不动 = 任何"跟随播放"
// 的验收都会得到假阴性，而这跟被测代码毫无关系。
// 空白页测，不牵涉本项目任何代码。
//
//   用法：node scripts/probe-audio-clock.mjs

import { chromium, webkit } from 'playwright'

const probe = async (name, launcher, opts) => {
  const b = await launcher.launch(opts)
  const p = await b.newPage()
  await p.goto('about:blank')
  const d = await p.evaluate(async () => {
    const AC = window.AudioContext ?? window.webkitAudioContext
    const ac = new AC()
    await ac.resume().catch(() => undefined)
    const o = ac.createOscillator()
    o.connect(ac.destination)
    o.start()
    const t0 = ac.currentTime
    await new Promise((r) => setTimeout(r, 1500))
    return { advSec: +(ac.currentTime - t0).toFixed(3), state: ac.state }
  })
  console.log(`${name.padEnd(20)} ${JSON.stringify(d)}`)
  await b.close()
}

const AUTOPLAY = ['--autoplay-policy=no-user-gesture-required']
await probe('chromium-headless', chromium, { args: AUTOPLAY })
await probe('chromium-headed', chromium, { headless: false, args: AUTOPLAY })
await probe('webkit-headless', webkit, {})
await probe('webkit-headed', webkit, { headless: false })
