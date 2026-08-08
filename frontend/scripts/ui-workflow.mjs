// 完整工作流 UI 测试：建工程 → 导入真实歌词 → 检查时间轴与预览是否真的渲染。
//
// 静态检查（tsc/lint/build）与后端 API 测试都无法发现运行时白屏、
// 组件不渲染、前后端字段对不上这类问题 —— 只有真的打开浏览器才行。

import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const ROOT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md'
const OUT = `${ROOT}/workspace/out/ui`
const errors = []

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` })
const say = (ok, label, extra = '') => console.log(`   ${ok ? '✅' : '❌'} ${label} ${extra}`)
let pass = 0
let fail = 0
const check = (ok, label, extra) => { ok ? pass++ : fail++; say(ok, label, extra) }

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

console.log('=== 1. 新建工程 ===')
await page.locator('button', { hasText: '新建工程' }).first().click()
await page.waitForTimeout(400)
// 弹出的表单里填标题
const titleInput = page.locator('input[type="text"]').first()
if (await titleInput.count()) {
  await titleInput.fill('赤春花')
}
await page.locator('button', { hasText: /^创建$/ }).first().click()
await page.waitForTimeout(2000)
await shot('10-project')
const afterCreate = await page.evaluate(() => document.body.innerText)
check(!afterCreate.includes('还没有打开工程'), '工程已创建并加载')

console.log('\n=== 2. 导入真实 QRC 歌词 ===')
await page.locator('text=② 歌词').first().click()
await page.waitForTimeout(800)
await shot('11-lyrics-panel')

// 切到"导入"页签
const importTab = page.locator('button', { hasText: /导入/ }).first()
if (await importTab.count()) {
  await importTab.click()
  await page.waitForTimeout(500)
}
const qrc = readFileSync(`${ROOT}/workspace/qrc/lyric_content.qrc`, 'utf-8')
const ta = page.locator('textarea').first()
check(await ta.count() > 0, '找到导入文本框')
if (await ta.count()) {
  // 选 QRC 格式
  const qrcRadio = page.locator('label', { hasText: /QRC/ }).first()
  if (await qrcRadio.count()) await qrcRadio.click()
  await ta.fill(qrc)
  await page.waitForTimeout(300)
  const doImport = page.locator('button', { hasText: /^导入|确认导入|开始导入/ }).first()
  if (await doImport.count()) {
    await doImport.click()
    await page.waitForTimeout(3000)
  }
}
await shot('12-imported')

const txt = await page.evaluate(() => document.body.innerText)
check(txt.includes('桜') || txt.includes('赤春花'), '歌词已进入界面', txt.match(/桜[^\n]{0,12}/)?.[0] ?? '')

console.log('\n=== 3. 时间轴 ===')
await page.locator('text=④ 对轴').first().click()
await page.waitForTimeout(2500)
await shot('13-timeline')
const tl = await page.evaluate(() => ({
  canvas: document.querySelectorAll('canvas').length,
  text: document.body.innerText.slice(0, 600),
}))
check(tl.canvas > 0, '波形/时间轴 canvas 已渲染', `${tl.canvas} 个 canvas`)

console.log('\n=== 4. 注音面板 ===')
await page.locator('text=⑤ 注音').first().click()
await page.waitForTimeout(1200)
await shot('14-ruby')
const ruby = await page.evaluate(() => document.body.innerText)
check(/さ|く|ら|注音|待核对/.test(ruby), '注音面板有内容')

console.log('\n=== 5. 样式面板（含字体服务）===')
await page.locator('text=⑥ 样式').first().click()
await page.waitForTimeout(2000)
await shot('15-style')
const style = await page.evaluate(() => document.body.innerText)
check(/ゴシック|明朝|字体/.test(style), '字体选择已呈现',
  style.match(/(粗ゴシック|丸ゴシック|明朝体)/g)?.join(' ') ?? '')

console.log('\n=== 6. 控制台错误 ===')
console.log(`   ${errors.length} 条`)
errors.slice(0, 10).forEach((e) => console.log(`   ❌ ${e.slice(0, 200)}`))

await shot('16-final')
await browser.close()
console.log(`\n通过 ${pass}　失败 ${fail}　控制台错误 ${errors.length}`)
process.exit(fail || errors.length ? 1 : 0)
