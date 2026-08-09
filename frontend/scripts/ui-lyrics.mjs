// 「歌词」舞台验收：候选列表 / 成片样式大预览（含 <ruby> 注音）/ 手工导入 / 拆行并行。
//
// 只跑 chromium：webkit 在 dev 模式下有已知的 JASSUB 嵌套 worker 限制
// （vite.config.ts 文件头有说明），与本舞台无关——本舞台压根不用 JASSUB。
//
// 用法：node scripts/ui-lyrics.mjs [appUrl]

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const APP = process.argv[2] ?? 'http://localhost:5173/'
const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui-lyrics'
mkdirSync(OUT, { recursive: true })

const errors = []
// 歌词源取不到内容时后端回 502，浏览器会把它记成 console error。那是"某个源没货"，
// 不是前端缺陷（界面此时要显示预览失败，见第 6 步的断言），单独归类。
const netNoise = []
let bad = 0
const check = (ok, msg) => {
  if (!ok) bad++
  console.log(`   ${ok ? '✅' : '❌'} ${msg}`)
}

const browser = await chromium.launch()
// 显式 dark：新外壳是无条件深色，headless 默认 light。本舞台已经没有
// prefers-color-scheme 分支了，设这一项只是为了截图与真机一致。
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() !== 'error') return
  if (m.text().includes('Failed to load resource')) netNoise.push(m.text())
  else errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` })
const gotoLyrics = async (p = page) => {
  await p.locator('.stepbar .step', { hasText: '歌词' }).first().click()
  // 工程详情是异步拉的：没拉到时舞台还停在选源态，等歌词真的渲染出来再断言
  await p.waitForSelector('.lyr-script', { timeout: 30000 })
  await p.waitForTimeout(500)
}

// 首页按最后修改时间排序，所以"第一张卡"会随本脚本自己造的工程漂移。
// 按标题定位那个 60 行的验证曲，测试才可重复。
const summaries = await fetch(new URL('api/projects/', APP)).then((r) => r.json())
const target = summaries.filter((s) => s.line_count > 0).sort((a, b) => b.line_count - a.line_count)[0]
const openByTitle = async (p, title) => {
  await p.waitForSelector('.pcard:not(.pcard--new)', { timeout: 30000 })
  const titles = await p.locator('.pcard:not(.pcard--new) .pcard__title').allInnerTexts()
  const idx = titles.findIndex((x) => x.trim() === title.trim())
  await p.locator('.pcard:not(.pcard--new)').nth(idx < 0 ? 0 : idx).click()
  await p.waitForSelector('.topbar', { timeout: 20000 })
}

console.log('=== 1. 打开已有歌词的工程 ===')
await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.home', { timeout: 20000 })
await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 30000 })
console.log(`   工程卡片 ${await page.locator('.pcard:not(.pcard--new)').count()} 张；测试曲「${target.title}」${target.line_count} 行`)
await openByTitle(page, target.title)
await gotoLyrics()

console.log('\n=== 2. 全文编辑态：整屏成片样式渲染 ===')
check((await page.locator('.lyr-script').count()) === 1, '成片渲染容器存在')
const lineCount = await page.locator('.lyr-line').count()
console.log(`   渲染 ${lineCount} 行`)
check(lineCount > 0, '渲染出歌词行')

const rubies = await page.$$eval('.lyr-text ruby', (els) =>
  els.map((e) => ({
    base: (e.childNodes[0]?.textContent ?? '').trim(),
    rt: (e.querySelector('rt')?.textContent ?? '').trim(),
  })),
)
console.log(`   <ruby> 共 ${rubies.length} 处，前 6 处：`)
for (const r of rubies.slice(0, 6)) console.log(`      ${r.base} → ${r.rt}`)
check(rubies.length > 0, '大预览里真的有 <ruby> 元素')
check(
  rubies.length > 0 && rubies.every((r) => r.base.length > 0 && r.rt.length > 0),
  '每处 <ruby> 的基字与 <rt> 注音都非空',
)

const filmStyle = await page.$eval('.lyr-film', (el) => {
  const cs = getComputedStyle(el)
  const text = el.querySelector('.lyr-text')
  const ts = text ? getComputedStyle(text) : null
  const rt = el.querySelector('rt')
  return {
    bg: cs.backgroundColor,
    fill: ts?.color,
    stroke: ts?.webkitTextStrokeWidth,
    strokeColor: ts?.webkitTextStrokeColor,
    paintOrder: ts?.paintOrder,
    fontSize: ts?.fontSize,
    fontFamily: ts?.fontFamily?.slice(0, 60),
    rtFontSize: rt ? getComputedStyle(rt).fontSize : null,
  }
})
console.log(`   成片区：${JSON.stringify(filmStyle)}`)
check(filmStyle.bg === 'rgb(0, 85, 0)', '预览背景是成片兜底色 #005500（不套界面配色）')
check(filmStyle.fill === 'rgb(255, 255, 255)', '未唱填充是白色')
check(parseFloat(filmStyle.stroke) > 0 && filmStyle.strokeColor !== filmStyle.fill, '有文字描边且与填充异色')
check(filmStyle.paintOrder.includes('stroke'), 'paint-order 把描边画在填充下面')
check(parseFloat(filmStyle.rtFontSize) < parseFloat(filmStyle.fontSize), '注音字号小于主文字号')

const srcBars = await page.$$eval('.lyr-line__src', (els) =>
  els.map((e) => getComputedStyle(e).backgroundColor).filter((c) => c !== 'rgba(0, 0, 0, 0)'),
)
console.log(`   来源色杠 ${srcBars.length} 条，取值：${[...new Set(srcBars)].join(' / ')}`)
check(srcBars.length > 0, '行首有来源色标记（§7.4）')
await shot('01-script')

console.log('\n=== 3. 拆行 / 并行入口 ===')
const firstLine = page.locator('.lyr-line').first()
await firstLine.hover()
await page.waitForTimeout(300)
const ops = await firstLine.locator('.lyr-line__ops button').count()
check(ops === 2, `行内操作按钮 ${ops} 个（拆行 / 并入下一行）`)
await shot('02-line-ops')

// 真拆一次再撤销回去：只看按钮在不在不算验证过写入路径（store action → 后端 → 撤销栈）
const splitRow = page.locator('.lyr-line').nth(5)
await splitRow.hover()
await splitRow.locator('.lyr-line__ops button').first().click()
await page.waitForTimeout(400)
const pts = await splitRow.locator('.lyr-split__pt').count()
const risky = await splitRow.locator('.lyr-split__pt--risky').count()
console.log(`   第 6 行进入拆分态：${pts} 个拆分位置，其中 ${risky} 个会切断注音`)
check(pts > 0, '拆分态逐 token 平铺出可点的拆分位置')
// QRC 实测 99.1% 的块是单个字符，注音也多是一字一注，所以本曲里几乎不会出现
// "拆分点落在注音中间"。这里只报数不作断言，警示逻辑本身是个纯谓词
console.log(`   （本曲注音多为单字，危险拆分点 ${risky} 个属正常）`)
await shot('02b-split-points')
await splitRow.locator('.lyr-split__pt').nth(2).click()
await page.waitForTimeout(2500)
const afterSplit = await page.locator('.lyr-line').count()
console.log(`   拆行后 ${afterSplit} 行`)
check(afterSplit === lineCount + 1, '拆行真的写进了工程')
await page.locator('button[aria-label="撤销"]').click()
await page.waitForTimeout(2500)
const afterUndo = await page.locator('.lyr-line').count()
console.log(`   撤销后 ${afterUndo} 行`)
check(afterUndo === lineCount, '拆行进了撤销栈（走的是 store action，不是绕过状态层直写）')

console.log('\n=== 4. 换歌词 → 选源态 ===')
await page.locator('.lyr-bar button', { hasText: '换歌词' }).click()
await page.waitForTimeout(600)
check((await page.locator('.lyr-side').count()) === 1, '左侧窄列出现')
check((await page.locator('.lyr-tab').count()) === 2, '搜索 / 导入 两个等宽入口')
const tabW = await page.$$eval('.lyr-tab', (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)))
check(tabW[0] === tabW[1], `两个入口等宽（${tabW.join(' / ')}px）——导入不是降级路径`)
const sideW = await page.$eval('.lyr-side', (e) => Math.round(e.getBoundingClientRect().width))
const mainW = await page.$eval('.lyr-main', (e) => Math.round(e.getBoundingClientRect().width))
console.log(`   左列 ${sideW}px / 主区 ${mainW}px`)
check(mainW > sideW * 2, '主区显著宽于候选列（窄列 + 大预览）')
await shot('03-source')

console.log('\n=== 5. 手工导入：粘贴 → 大预览 → 导入 ===')
await page.locator('.lyr-tab', { hasText: '导入' }).click()
await page.waitForTimeout(400)
check((await page.locator('.lyr-drop textarea').count()) === 1, '导入文本框可用')
const SAMPLE = ['桜舞う空に', '君の声が響く', '春、また会おう'].join('\n')
await page.locator('.lyr-drop textarea').fill(SAMPLE)
await page.waitForTimeout(600)
const draftLines = await page.$$eval('.lyr-main .lyr-text', (els) => els.map((e) => e.innerText.trim()))
console.log(`   草稿预览 ${draftLines.length} 行：${JSON.stringify(draftLines)}`)
check(draftLines.length === 3, '粘贴的内容立刻按成片样式渲染')
const metaText = (await page.locator('.lyr-meta').innerText()).replace(/\s+/g, ' ')
console.log(`   元信息栏：${metaText}`)
check(metaText.includes('3 行'), '元信息栏报出行数')
await shot('04-import')

console.log('\n=== 6. 搜索入口 ===')
await page.locator('.lyr-tab', { hasText: '搜索' }).click()
await page.waitForTimeout(400)
const q = await page.locator('.lyr-form input[type="search"]').inputValue()
console.log(`   建议搜索词：「${q}」`)
check((await page.locator('.lyr-form input[type="search"]').count()) === 1, '搜索框存在')
await page.locator('.lyr-form button.primary').click()
await page.waitForTimeout(12000)
const cands = await page.locator('.lyr-cand').count()
const sideText = (await page.locator('.lyr-side').innerText()).replace(/\s+/g, ' ').slice(0, 200)
console.log(`   候选 ${cands} 条；左列文字：${sideText}`)
if (cands > 0) {
  check((await page.locator('.lyr-cand--active').count()) === 1, '搜索完成后自动预览打分最高的一条')
  // 逐条点过去，直到有一条真的取回了内容——歌词源取不到时后端回 502，
  // 那种情况界面必须显示"预览失败"而不是一片空白（CLAUDE.md §2.5：失败要降级、不能终止）
  let rendered = 0
  let ruby = 0
  let sawFailure = false
  for (let i = 0; i < Math.min(cands, 6); i++) {
    await page.locator('.lyr-cand').nth(i).click()
    await page.waitForTimeout(3500)
    rendered = await page.locator('.lyr-main .lyr-text').count()
    ruby = await page.locator('.lyr-main .lyr-text ruby').count()
    const failed = await page.locator('.lyr-main .lyr-blank.error').count()
    console.log(`   第 ${i + 1} 条：${rendered} 行 / <ruby> ${ruby} 处${failed ? '（预览失败已提示）' : ''}`)
    if (failed) sawFailure = true
    if (rendered > 0) break
  }
  check(rendered > 0, '候选内容按成片样式渲染进大预览')
  if (sawFailure) check(true, '取不到内容的候选显示预览失败，不留空白')
  const meta = (await page.locator('.lyr-meta').innerText()).replace(/\s+/g, ' ')
  console.log(`   元信息栏：${meta}`)
  check(/\d+ 行/.test(meta), '元信息栏汇总行数 / 粒度 / 注音')
  // 徽章说有注音就必须真的画出 <ruby>，说没有就不该凭空造一个
  check(meta.includes('含注音') === ruby > 0, `注音徽章与实际 <ruby> 数一致（${ruby} 处）`)
} else {
  console.log('   （本次搜索没有候选——歌词源需要外网，离线环境属正常，不计入失败）')
}
await shot('05-search')

console.log('\n=== 6.5 新建工程 → 手工导入写入 → 并行 → 撤销 ===')
await page.locator('.topbar__project').click()
await page.waitForSelector('.home', { timeout: 15000 })
await page.locator('.pcard--new').click()
await page.locator('.newform input').first().fill('歌词舞台验收')
await page.locator('.newform button', { hasText: '创建' }).click()
await page.waitForSelector('.topbar', { timeout: 15000 })
await page.waitForTimeout(1200)
await page.locator('.stepbar .step', { hasText: '歌词' }).first().click()
await page.waitForTimeout(1200)
check((await page.locator('.lyr-side').count()) === 1, '空工程直接落在选源态')
await page.locator('.lyr-tab', { hasText: '导入' }).click()
await page.locator('.lyr-drop textarea').fill(SAMPLE)
await page.waitForTimeout(500)
await page.locator('.lyr-meta button.primary').click()
await page.waitForSelector('.lyr-script', { timeout: 20000 })
await page.waitForTimeout(1200)
const imported = await page.locator('.lyr-line').count()
console.log(`   导入后 ${imported} 行，且自动切到全文编辑态`)
check(imported === 3, '手工导入写进工程并切到编辑态')
await page.locator('.lyr-line').first().hover()
await page.locator('.lyr-line').first().locator('.lyr-line__ops button').nth(1).click()
await page.waitForTimeout(2500)
const merged = await page.locator('.lyr-line').count()
console.log(`   并行后 ${merged} 行`)
check(merged === 2, '并入下一行生效')
await page.locator('button[aria-label="撤销"]').click()
await page.waitForTimeout(2500)
check((await page.locator('.lyr-line').count()) === 3, '并行可撤销')
await shot('05b-import-write')
// 收尾删掉临时工程，下次跑首页还是那几张卡
// 收尾用 API 删，不走界面：删除按钮 hover 才出现、还带 confirm 弹窗，
// 收尾步骤失手会把临时工程留在列表里污染下一次运行
const created = await fetch(new URL('api/projects/', APP)).then((r) => r.json())
for (const s of created.filter((x) => x.title === '歌词舞台验收')) {
  await fetch(new URL(`api/projects/${s.id}`, APP), { method: 'DELETE' })
}
console.log('   已清理临时工程')

console.log('\n=== 7. 浅色系统外观下不应变成白卡片 ===')
const light = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' })
const lp = await light.newPage()
await lp.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
await lp.waitForSelector('.home', { timeout: 20000 })
await openByTitle(lp, target.title)
await gotoLyrics(lp)
const lightBg = await lp.$eval('.lyr-film', (e) => getComputedStyle(e).backgroundColor)
const lightBar = await lp.$eval('.lyr-bar', (e) => getComputedStyle(e).backgroundColor)
console.log(`   成片区 ${lightBg} / 工具条 ${lightBar}`)
check(lightBg === 'rgb(0, 85, 0)' && lightBar === 'rgb(28, 31, 38)', '浅色系统下配色不变（媒体查询已删）')
await lp.screenshot({ path: `${OUT}/06-light.png` })
await light.close()

console.log('\n=== 控制台 ===')
if (errors.length === 0) console.log('   ✅ 无 JS 报错')
else {
  bad++
  for (const e of errors.slice(0, 10)) console.log(`   ❌ ${e.slice(0, 240)}`)
}
if (netNoise.length) console.log(`   ℹ️ ${netNoise.length} 条歌词源取不到内容的网络记录（界面已提示，非缺陷）`)

console.log(`\n${bad === 0 ? '✅ 全部通过' : `❌ ${bad} 项未通过`}  截图：${OUT}`)
await browser.close()
process.exit(bad === 0 ? 0 : 1)
