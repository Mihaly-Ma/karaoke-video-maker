// 验证各舞台是否真的铺满宽度。
// 只断言"容器存在"没意义——要量实际像素宽度，并与舞台宽度比。
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser
  .newContext({ viewport: { width: 1600, height: 1000 } })
  .then((c) => c.newPage())
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

// 首页 → 进第一个工程卡片（卡片是 button，内含曲名与时长）
const cards = page.locator('.pcard, button').filter({ hasText: /\d:\d\d/ })
const n = await cards.count()
console.log(`首页候选卡片 ${n} 个`)
if (n) {
  await cards.first().click()
  await page.waitForTimeout(3500)
}

const inEditor = await page.locator('main.stage').count()
console.log(`进入编辑器: ${inEditor ? '是' : '否'}`)
if (!inEditor) {
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 300))
  console.log('页面文本：', txt.replace(/\n+/g, ' | ').slice(0, 260))
}

const steps = ['素材', '歌词', '对轴', '注音', '样式', '导出']
let fail = 0
for (const s of steps) {
  // 步骤条按钮：优先 role=tab，退回按文本找顶栏按钮
  let tab = page.locator('[role="tab"]', { hasText: s }).first()
  if (!(await tab.count())) tab = page.locator('button', { hasText: new RegExp(`^${s}$`) }).first()
  if (!(await tab.count())) {
    console.log(`  ?? 找不到步骤 ${s}`)
    fail++
    continue
  }
  await tab.click()
  await page.waitForTimeout(1200)
  const m = await page.evaluate(() => {
    const stage = document.querySelector('main.stage')
    if (!stage) return null
    const r = stage.getBoundingClientRect()
    // 量子元素的**整体横向覆盖范围**，而不是最宽的单个子元素：
    // 舞台是 flex 行时每个子元素本来就窄于舞台，按单个量会误判成"被限宽"。
    // 真正要抓的是"两侧有没有大片空白"——限宽容器会让内容居中并留出大留白。
    const kids = [...stage.children]
    if (!kids.length) return { stage: Math.round(r.width), span: 0, gutter: 0 }
    const boxes = kids.map((c) => c.getBoundingClientRect())
    const left = Math.min(...boxes.map((b) => b.left))
    const right = Math.max(...boxes.map((b) => b.right))
    return {
      stage: Math.round(r.width),
      span: Math.round(right - left),
      gutter: Math.round(left - r.left),
    }
  })
  if (!m) {
    console.log(`  ?? ${s}: 没有 main.stage`)
    fail++
    continue
  }
  // 允许 stage--scroll 的内边距（每侧 24px），但不允许限宽造成的大留白
  const ok = m.span >= m.stage - 60 && m.gutter <= 30
  if (!ok) fail++
  console.log(
    `  ${ok ? '✅' : '❌'} ${s.padEnd(3)} 舞台 ${m.stage}px  内容跨度 ${m.span}px  左留白 ${m.gutter}px`,
  )
}

console.log(`\n控制台错误 ${errors.length} 条`)
errors.slice(0, 5).forEach((e) => console.log('   ', e.slice(0, 160)))
await browser.close()
console.log(fail ? `\n${fail} 项未通过` : '\n全部舞台已铺满')
process.exit(fail ? 1 : 0)
