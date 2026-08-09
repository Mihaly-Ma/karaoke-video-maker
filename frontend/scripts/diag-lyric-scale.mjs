// 复现「每行都要左右滚动」。在几档视口下量字号与每行的横向溢出情况。
import { chromium } from 'playwright'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
await page.getByText('代理验证 4K AV1', { exact: false }).first().click()
await page.waitForTimeout(3000)
await page.locator('button', { hasText: /^歌词$/ }).first().click()
await page.waitForTimeout(2500)

for (const w of [1600, 1440, 1280, 1024]) {
  await page.setViewportSize({ width: w, height: 900 })
  await page.waitForTimeout(1200)
  const r = await page.evaluate(() => {
    const film = document.querySelector('.lyr-film')
    if (!film) return { err: 'no film' }
    const fs = getComputedStyle(film).getPropertyValue('--lyr-fs').trim()
    const bodies = [...film.querySelectorAll('.lyr-line__body')]
    const overflow = bodies.filter((b) => b.scrollWidth > b.clientWidth + 1)
    const sample = overflow.slice(0, 3).map((b) => ({
      cw: b.clientWidth,
      sw: b.scrollWidth,
      txt: (b.innerText || '').replace(/\n/g, '').slice(0, 18),
    }))
    return {
      filmW: film.clientWidth,
      fs,
      lines: bodies.length,
      overflowing: overflow.length,
      sample,
      bg: getComputedStyle(film).backgroundColor,
    }
  })
  console.log(`视口 ${w}: film ${r.filmW}px  字号 ${r.fs}  横向溢出 ${r.overflowing}/${r.lines} 行  底色 ${r.bg}`)
  if (r.sample?.length) r.sample.forEach((s) => console.log(`    ${s.cw}→${s.sw}px  ${s.txt}`))
}
await browser.close()
