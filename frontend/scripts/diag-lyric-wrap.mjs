// 诊断歌词正文在奇怪位置换行：量各层实际宽度，找出是谁把可用宽度掐窄的。
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
await page.getByText('代理验证 4K AV1', { exact: false }).first().click()
await page.waitForTimeout(3000)
await page.locator('button', { hasText: /^歌词$/ }).first().click()
await page.waitForTimeout(2000)

const r = await page.evaluate(() => {
  const film = document.querySelector('.lyr-film')
  if (!film) return { err: '没找到 .lyr-film' }
  // 找一个确实发生了换行的行：行盒高度明显大于单行
  const lines = [...film.querySelectorAll('.lyr-line')]
  const info = lines.slice(0, 12).map((el, i) => {
    const r = el.getBoundingClientRect()
    const text = el.querySelector('[class*="text"], .lyr-line__text') ?? el.lastElementChild
    const tr = text?.getBoundingClientRect()
    return {
      i,
      lineW: Math.round(r.width),
      lineH: Math.round(r.height),
      textW: tr ? Math.round(tr.width) : null,
      textCls: text?.className || '',
      wrapped: r.height > 120,
      sample: (el.innerText || '').replace(/\n/g, '·').slice(0, 24),
    }
  })
  // 逐层往上量可用宽度
  const chain = []
  let el = lines.find((l) => l.getBoundingClientRect().height > 120) ?? lines[0]
  while (el && el !== document.body) {
    const cs = getComputedStyle(el)
    chain.push({
      cls: el.className || el.tagName,
      clientW: el.clientWidth,
      scrollW: el.scrollWidth,
      display: cs.display,
      flexWrap: cs.flexWrap,
      width: cs.width,
      maxWidth: cs.maxWidth,
      whiteSpace: cs.whiteSpace,
      wordBreak: cs.wordBreak,
      lineBreak: cs.lineBreak,
    })
    el = el.parentElement
  }
  return { film: { clientW: film.clientWidth }, info, chain: chain.slice(0, 6) }
})

console.log(JSON.stringify(r, null, 2))
await browser.close()
