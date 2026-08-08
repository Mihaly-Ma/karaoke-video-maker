// 真实 UI 冒烟：在浏览器里打开应用，看它到底能不能用。
// 此前所有验证都是静态的（tsc/lint/build）与后端 API 层的，从未真的渲染过界面。

import { chromium } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui'
const errors = []
const warnings = []

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()

page.on('console', (m) => {
  const t = m.type()
  if (t === 'error') errors.push(m.text())
  else if (t === 'warning') warnings.push(m.text())
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

console.log('=== 1. 打开应用 ===')
const resp = await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 60000 })
console.log(`   HTTP ${resp.status()}`)

// 跨源隔离：JASSUB 的 SharedArrayBuffer 前提
const isolated = await page.evaluate(() => ({
  crossOriginIsolated: globalThis.crossOriginIsolated,
  hasSAB: typeof SharedArrayBuffer !== 'undefined',
}))
console.log(`   crossOriginIsolated=${isolated.crossOriginIsolated}  SharedArrayBuffer=${isolated.hasSAB}`)

await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/01-initial.png`, fullPage: false })

// 页面到底渲染出东西没有
const body = await page.evaluate(() => ({
  text: document.body.innerText.slice(0, 400),
  nodes: document.body.querySelectorAll('*').length,
  buttons: document.querySelectorAll('button').length,
}))
console.log(`   DOM 节点 ${body.nodes} 个，按钮 ${body.buttons} 个`)
console.log(`   可见文本首 200 字：\n   ${body.text.slice(0, 200).replace(/\n/g, ' | ')}`)

console.log('\n=== 2. 新建工程 ===')
const newBtn = page.locator('button', { hasText: /新建|新規|New/ }).first()
if (await newBtn.count()) {
  await newBtn.click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/02-created.png` })
  const after = await page.evaluate(() => document.body.innerText.slice(0, 300))
  console.log('   点击后文本：', after.replace(/\n/g, ' | ').slice(0, 180))
} else {
  console.log('   ❌ 找不到「新建」按钮')
}

console.log('\n=== 3. 界面主要区块 ===')
for (const kw of ['歌词', '时间轴', '注音', '样式', '预览', '下载', '分离', '导出']) {
  const n = await page.locator(`text=${kw}`).count()
  console.log(`   ${n > 0 ? '✅' : '❌'} ${kw}  (${n})`)
}

console.log('\n=== 4. 控制台 ===')
console.log(`   错误 ${errors.length} 条，警告 ${warnings.length} 条`)
errors.slice(0, 12).forEach((e) => console.log(`   ❌ ${e.slice(0, 220)}`))

await page.screenshot({ path: `${OUT}/03-final.png`, fullPage: true })
await browser.close()

console.log(`\n截图已存到 ${OUT}`)
process.exit(errors.length ? 1 : 0)
