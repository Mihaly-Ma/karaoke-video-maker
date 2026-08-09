// 逐个点击界面上的「播放」按钮，定位哪一个会报
// 「无法开始播放：The operation is not supported.」

import { chromium } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui'
const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

const sel = page.locator('select').first()
if ((await sel.locator('option').count()) > 1) {
  await sel.selectOption({ index: 1 })
  await page.waitForTimeout(4000)
}

await page.locator('text=④ 对轴').first().click()
await page.waitForTimeout(6000)

const grabError = () =>
  page.evaluate(
    () =>
      document.body.innerText.match(/[^\n]*(无法开始播放|not supported|NotSupported)[^\n]*/i)?.[0] ?? '',
  )

const btns = await page.locator('button').all()
for (let i = 0; i < btns.length; i++) {
  let t = ''
  try {
    t = (await btns[i].innerText()).trim()
  } catch {
    continue
  }
  if (!/播放/.test(t)) continue
  console.log(`\n=== 点击按钮 [${i}] "${t}" ===`)
  logs.length = 0
  try {
    await btns[i].click({ timeout: 5000 })
  } catch (e) {
    console.log('  点击失败:', String(e).slice(0, 120))
    continue
  }
  await page.waitForTimeout(2500)
  const err = await grabError()
  console.log('  界面提示:', err || '(无)')
  const st = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { paused: v?.paused, t: v?.currentTime?.toFixed(2) }
  })
  console.log('  video:', JSON.stringify(st))
  logs.slice(0, 8).forEach((l) => console.log('  ', l.slice(0, 200)))
}

await page.screenshot({ path: `${OUT}/31-timeline-play.png` })
await browser.close()
