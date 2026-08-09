// 截对轴舞台的图，用于与设计原型比对。
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
await page.getByText('代理验证 4K AV1', { exact: false }).first().click()
await page.waitForTimeout(3000)
await page.locator('button', { hasText: /^对轴$/ }).first().click()
await page.waitForTimeout(4000)

const layout = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return {
    viewport: pick('.stage__viewport'),
    rail: pick('.stage__rail'),
    video: pick('video'),
    toolbarBtns: [...document.querySelectorAll('.kvm-tl button, .stage__rail button')]
      .map((b) => b.innerText.trim())
      .filter(Boolean)
      .slice(0, 16),
  }
})
console.log(JSON.stringify(layout, null, 2))

await page.screenshot({ path: '/Users/Mihaly/.claude/jobs/8d97f8fb/tmp/align-now.png' })
await browser.close()
