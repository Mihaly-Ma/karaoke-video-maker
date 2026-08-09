// 「素材正在下载」这一状态 + 完成后自动恢复的验收。
//
// 用法：先在后端对目标工程发起一次下载，然后
//   node scripts/ui-preview-downloading.mjs <projectId> [chromium|webkit]
//
// 断言两件事：
//   1. 下载进行中，画面区说的是"正在下载视频"而**不是**"还没有素材"，
//      也不是任何降级/失败提示——这是正常的中间状态，用户什么都不用做
//   2. 下载完成后**不刷新页面**画面自己出来（工程刷新由预览区自己发起，
//      不依赖 App 那份只认自己发起过的任务的 JobProgress）

import { chromium, webkit } from 'playwright'

const PROJECT = process.argv[2]
const ENGINE = process.argv[3] ?? 'chromium'
if (!PROJECT) throw new Error('用法：node scripts/ui-preview-downloading.mjs <projectId> [engine]')
const launcher = ENGINE === 'webkit' ? webkit : chromium

let failed = 0
const check = (ok, msg, extra = '') => {
  if (!ok) failed++
  console.log(`   ${ok ? '✅' : '❌'} ${msg}${extra ? ` — ${extra}` : ''}`)
}

const browser = await launcher.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.addInitScript((id) => localStorage.setItem(`kvm.step.${id}`, 'edit'), PROJECT)
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })

/**
 * 打开目标工程的编辑步骤。
 *
 * 做成可重入的：dev 模式下别人改一次源码就会触发 HMR 整页重载，应用状态里的
 * "当前在哪个工程/哪一步"会退回首页——那不是被测行为，但会让这条几分钟的用例
 * 无声地测了个空。每轮采样前先确认还在工程里，退回去了就再进来。
 */
let reopens = -1
async function ensureOpen() {
  if (!(await page.locator('.home').count())) return
  reopens++
  // 列表顺序按 updated_at，下载写回工程会让它变，每次都要重新定位
  const list = await page.evaluate(() => fetch('/api/projects/').then((r) => r.json()))
  const cards = page.locator('.pcard:not(.pcard--new)')
  await cards.first().waitFor({ timeout: 20000 })
  await cards.nth(list.findIndex((s) => s.id === PROJECT)).click()
  await page.waitForSelector('.home', { state: 'detached', timeout: 20000 })
}
await ensureOpen()

const stageText = () =>
  page.evaluate(() => {
    const leaves = [...document.querySelectorAll('body *')].filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent?.trim() &&
        !['STYLE', 'SCRIPT', 'TITLE'].includes(el.tagName),
    )
    return leaves
      .map((el) => el.textContent.trim())
      .filter((s) =>
        /还没有素材|只有音轨|正在下载|正在准备|正在生成|放不了|自带音轨|加载失败|不可用|降级|完成后自动/.test(s),
      )
  })

const seen = new Set()
let sawDownloading = false
let sawVideoAt = null
const t0 = Date.now()

// 最多盯 10 分钟：4K MV 下载 + 抽音频 + 生成代理本来就要几分钟
for (let i = 0; i < 600 && sawVideoAt === null; i++) {
  await ensureOpen()
  const texts = await stageText()
  for (const s of texts) seen.add(s)
  if (texts.some((s) => s.includes('正在下载'))) sawDownloading = true
  const hasVideo = await page.evaluate(() => !!document.querySelector('video'))
  if (hasVideo) sawVideoAt = Date.now() - t0
  await page.waitForTimeout(1000)
}

console.log(`引擎 ${ENGINE}`)
console.log('   看到的提示：', JSON.stringify([...seen]))
check(sawDownloading, '下载中显示"正在下载视频"')
check(
  seen.has('完成后自动显示，进度见任务栏'),
  '并说明不用管它（完成后自动显示，进度见任务栏）',
)
check(![...seen].some((s) => /自带音轨|降级|加载失败|不可用/.test(s)), '全程没有降级/失败提示')
check(sawVideoAt !== null, '下载完成后未刷新页面即出现画面', sawVideoAt ? `${sawVideoAt} ms` : '超时')
check(errors.length === 0, '无未捕获异常', errors.join(' | '))
console.log(`   （期间因 HMR 整页重载而重新进入工程 ${reopens} 次，不计入判定）`)

await page.screenshot({ path: `/tmp/ui-preview-downloading-${ENGINE}.png` })
await browser.close()
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
