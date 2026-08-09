// 外壳重构验收：首页 → 编辑器 → 六个步骤逐个切换 → 回首页。
//
// 只跑 chromium：webkit 在 dev 模式下有已知的 JASSUB 嵌套 worker 限制
// （vite.config.ts 文件头有说明），与本次外壳改动无关。

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui-shell'
mkdirSync(OUT, { recursive: true })

const errors = []
const browser = await chromium.launch()
// colorScheme 显式设成 dark：外壳是无条件深色，而 LyricPanel 的内联 CSS 只在
// prefers-color-scheme:dark 下才切深色——headless 默认是 light，不设这一项截出来的
// 歌词面板是一张白卡片，与真机（macOS 深色）不符。这个分叉本身是第二阶段要收编的。
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
const page = await ctx.newPage()

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` })

console.log('=== 1. 首页 ===')
const resp = await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 60000 })
console.log(`   HTTP ${resp.status()}`)
await page.waitForSelector('.home', { timeout: 15000 })
await page.waitForTimeout(1500)
const cards = await page.locator('.pcard:not(.pcard--new)').count()
const newCard = await page.locator('.pcard--new').count()
console.log(`   工程卡片 ${cards} 张，新建入口 ${newCard} 个`)
const firstCard = await page.locator('.pcard:not(.pcard--new)').first().innerText()
console.log(`   首张卡片：${firstCard.replace(/\n/g, ' | ')}`)
const segs = await page.locator('.pcard:not(.pcard--new)').first().locator('.pcard__seg').count()
const done = await page.locator('.pcard:not(.pcard--new)').first().locator('.pcard__seg--done').count()
console.log(`   进度分段 ${segs} 段，其中已完成 ${done} 段`)
await shot('01-home')

console.log('\n=== 2. 进入编辑器 ===')
await page.locator('.pcard:not(.pcard--new)').first().click()
await page.waitForSelector('.topbar', { timeout: 15000 })
await page.waitForTimeout(2000)
const steps = await page.locator('.stepbar .step').allInnerTexts()
console.log(`   步骤条：${steps.join(' / ')}`)
console.log(`   已完成打勾：${await page.locator('.stepbar .step__check').count()} 项`)
console.log(`   置灰步骤：${await page.locator('.stepbar .step--blocked').count()} 项`)
await shot('02-editor')

console.log('\n=== 3. 六个步骤逐个切换 ===')
const names = ['素材', '歌词', '对轴', '注音', '样式', '导出']
let bad = 0
for (let i = 0; i < names.length; i++) {
  await page.locator('.stepbar .step').nth(i).click()
  await page.waitForTimeout(i === 2 ? 3000 : 1200)
  const stage = page.locator('.stage')
  const box = await stage.boundingBox()
  const info = await stage.evaluate((el) => ({
    nodes: el.querySelectorAll('*').length,
    text: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 110),
  }))
  const current = await page.locator('.stepbar .step--current').innerText()
  const ok = info.nodes > 5 && box.height > 100
  if (!ok) bad++
  console.log(
    `   ${ok ? '✅' : '❌'} ${names[i]}  当前=${current.trim()}  舞台 ${info.nodes} 节点 ${Math.round(box.height)}px`,
  )
  console.log(`      「${info.text}」`)
  await shot(`03-${i + 1}-${names[i]}`)
}

console.log('\n=== 4. 撤销 / 重做 ===')
const undoBtn = page.locator('button[aria-label="撤销"]')
const redoBtn = page.locator('button[aria-label="重做"]')
console.log(`   撤销按钮存在=${(await undoBtn.count()) === 1} 可用=${await undoBtn.isEnabled()}`)
console.log(`   重做按钮存在=${(await redoBtn.count()) === 1} 可用=${await redoBtn.isEnabled()}`)
// 真的做一次改动，再撤销回去——只看按钮存在不算验证过。
// 先去注音步（进去会自动选中第一条正文行），再回对轴，选中行的平移工具条才在。
await page.locator('.stepbar .step').nth(3).click()
await page.waitForTimeout(1200)
await page.locator('.stepbar .step').nth(2).click()
await page.waitForTimeout(2500)
const nudge = page.locator('.nudges button', { hasText: '+100' }).first()
if (await nudge.count()) {
  await nudge.click()
  await page.waitForTimeout(1200)
  console.log(`   平移 +100ms 后 撤销可用=${await undoBtn.isEnabled()}`)
  await undoBtn.click()
  await page.waitForTimeout(1200)
  console.log(`   撤销后 重做可用=${await redoBtn.isEnabled()}`)
  await redoBtn.click()
  await page.waitForTimeout(1000)
  await undoBtn.click()
  await page.waitForTimeout(1000)
  console.log('   重做 → 再撤销，回到初始状态')
} else {
  console.log('   ❌ 找不到平移按钮')
  bad++
}
await shot('04-undo')

console.log('\n=== 5. 回首页 ===')
await page.locator('.topbar__project').click()
await page.waitForSelector('.home', { timeout: 10000 })
await page.waitForTimeout(800)
console.log(`   已回到首页，卡片 ${await page.locator('.pcard:not(.pcard--new)').count()} 张`)
await shot('05-home-again')

console.log('\n=== 6. 空工程：置灰但仍可点（契约 §2.5 允许任意跳步）===')
await page.locator('.pcard--new').click()
await page.locator('.newform input').first().fill('冒烟测试用')
await page.locator('.newform button', { hasText: '创建' }).click()
await page.waitForSelector('.topbar', { timeout: 10000 })
await page.waitForTimeout(1500)
const blocked = await page.locator('.stepbar .step--blocked').allInnerTexts()
console.log(`   置灰步骤：${blocked.map((t) => t.trim()).join(' / ') || '（无）'}`)
console.log(`   打勾步骤：${await page.locator('.stepbar .step__check').count()} 项`)
// 置灰的照样点得动：点"注音"应该真的切过去
await page.locator('.stepbar .step').nth(3).click()
await page.waitForTimeout(800)
const jumped = (await page.locator('.stepbar .step--current').innerText()).trim()
console.log(`   ${jumped.includes('注音') ? '✅' : '❌'} 点置灰的「注音」后当前步骤 = ${jumped}`)
if (!jumped.includes('注音')) bad++
await shot('06-empty-project')
// 收尾：删掉这个测试工程，别在首页留垃圾
page.on('dialog', (d) => void d.accept())
await page.locator('.topbar__project').click()
await page.waitForSelector('.home')
await page.waitForTimeout(800)
const target = page.locator('.pcard', { hasText: '冒烟测试用' }).first()
await target.locator('.pcard__del').click({ force: true })
await page.waitForTimeout(1200)
console.log(`   已删除测试工程，剩余卡片 ${await page.locator('.pcard:not(.pcard--new)').count()} 张`)

console.log('\n=== 7. 控制台 ===')
console.log(`   错误 ${errors.length} 条`)
errors.slice(0, 15).forEach((e) => console.log(`   ❌ ${e.slice(0, 240)}`))

await browser.close()
console.log(`\n截图：${OUT}`)
process.exit(errors.length || bad ? 1 : 0)
