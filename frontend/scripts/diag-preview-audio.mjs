// 诊断：第一次进「编辑」步骤时预览区报音频加载失败。
//
// 用法：node scripts/diag-preview-audio.mjs [chromium|webkit] [projectId]
//
// 关键是**从冷启动进入**——刷新页面、直奔编辑步骤，不要先在应用里来回切。
// 竞态只在首次出现，测法不对会假通过。
//
// 输出三件事：预览区警告条随时间的变化、媒体请求的生命周期（含被中断的）、
// 控制台。警告条按时间采样而不是只看最终态——一闪而过的失败正是要抓的东西。

import { chromium, webkit } from 'playwright'

const ENGINE = process.argv[2] ?? 'chromium'
const PROJECT = process.argv[3] ?? 'cd4aed3df12e'
const launcher = ENGINE === 'webkit' ? webkit : chromium

const browser = await launcher.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()

const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6)
const logs = []
page.on('console', (m) => logs.push(`${ms()} [${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`${ms()} [pageerror] ${e.message}`))

const media = []
const short = (u) => u.replace(/^.*\/api\//, '/api/')
page.on('request', (r) => {
  if (r.url().includes('/api/media/')) media.push(`${ms()} →   ${short(r.url())}`)
})
page.on('requestfinished', async (r) => {
  if (!r.url().includes('/api/media/')) return
  const resp = await r.response()
  media.push(`${ms()} ok  ${resp?.status()} ${short(r.url())}`)
})
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/media/')) media.push(`${ms()} ✗   ${short(r.url())} ${r.failure()?.errorText}`)
})

// 让工程一打开就落在编辑步骤，模拟"刷新后直接进编辑页"
await page.addInitScript((id) => localStorage.setItem(`kvm.step.${id}`, 'edit'), PROJECT)

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
const summaries = await page.evaluate(() => fetch('/api/projects/').then((r) => r.json()))
const target = summaries.find((s) => s.id === PROJECT)
console.log(`工程 ${PROJECT} = ${JSON.stringify(target?.title)}`)
await page.locator('.pcard', { hasText: target.title }).first().click()

// 警告条按时间采样：一闪而过的失败提示只有这样才抓得到
const seen = new Map()
for (let i = 0; i < 40; i++) {
  const snap = await page.evaluate(() => {
    // 全页面扫**叶子元素**的文字：出错提示不一定在 <li> 里（波形那条就在别处），
    // 只看某一类容器会漏掉，正是这次差点误判的原因
    const leaves = [...document.querySelectorAll('body *')].filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent?.trim() &&
        !['STYLE', 'SCRIPT', 'TITLE'].includes(el.tagName),
    )
    return {
      issues: leaves
        .map((el) => el.textContent.trim())
        .filter((s) => /加载失败|不可用|失败|Web Audio|跨源|还没有素材|只有音轨|正在下载|放不了|正在准备|正在生成/.test(s)),
      stage: undefined,
    }
  })
  for (const s of snap.issues) if (!seen.has(s)) seen.set(s, ms())
  if (snap.stage && !seen.has(`STAGE: ${snap.stage}`)) seen.set(`STAGE: ${snap.stage}`, ms())
  await page.waitForTimeout(400)
}

console.log('\n=== 出现过的警告条 / 画面区文案（首次出现时刻） ===')
if (seen.size === 0) console.log('(无)')
for (const [text, at] of seen) console.log(`  ${at}  ${text}`)

console.log('\n=== 最终态 ===')
console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      issues: [...document.querySelectorAll('li')]
        .map((li) => li.innerText.replace(/\s*\n\s*/g, ' | '))
        .filter((s) => /音轨|音频|Web Audio|跨源|素材|字幕/.test(s)),
      video: !!document.querySelector('video'),
    })),
    null,
    2,
  ),
)

console.log('\n=== 媒体请求 ===')
console.log(media.join('\n') || '(无)')

console.log('\n=== 控制台（非 log） ===')
console.log(logs.filter((l) => !/\[log\]|\[debug\]/.test(l)).slice(0, 50).join('\n') || '(无)')

await page.screenshot({ path: `/tmp/diag-preview-${ENGINE}.png` })
await browser.close()
