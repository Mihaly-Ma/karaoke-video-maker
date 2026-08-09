// 验证「歌词搜索」路径：进歌词步骤 → 换歌词 → 搜索 → 页面是否仍在。
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
const errs = []
page.on('pageerror', (e) =>
  errs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 8).join('\n')}`),
)
page.on('console', (m) => m.type() === 'error' && errs.push(`[console] ${m.text().slice(0, 400)}`))

const dump = async (label) => {
  const s = await page.evaluate(() => ({
    len: document.body.innerText.length,
    root: document.getElementById('root')?.childElementCount ?? -1,
    head: document.body.innerText.slice(0, 150).replace(/\n+/g, ' | '),
  }))
  console.log(`=== ${label} === len=${s.len} root=${s.root}`)
  console.log('   ' + s.head)
}

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
await page.getByText('代理验证 4K AV1', { exact: false }).first().click()
await page.waitForTimeout(3500)
await page.locator('button', { hasText: /^歌词$/ }).first().click()
await page.waitForTimeout(1500)
await dump('歌词步骤')

// 已有歌词时先点「换歌词」才会出现搜索界面
const swap = page.locator('button', { hasText: /换歌词/ }).first()
if (await swap.count()) {
  await swap.click()
  await page.waitForTimeout(1200)
  await dump('换歌词后')
}

errs.length = 0
const input = page.locator('input').filter({ hasNot: page.locator('[type=file]') }).first()
console.log(`\n找到输入框 ${await input.count()} 个`)
if (await input.count()) {
  await input.fill('赤春花')
  await input.press('Enter')
  console.log('已提交搜索，等待 12s…')
  await page.waitForTimeout(12000)
  await dump('搜索后')
}

console.log(`\n报错 ${errs.length} 条：`)
errs.slice(0, 6).forEach((e) => console.log('---\n' + e))
await page.screenshot({ path: '/tmp/lyric-search.png' })
await browser.close()
