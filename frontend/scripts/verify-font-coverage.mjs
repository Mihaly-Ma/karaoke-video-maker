// 字形覆盖预检的界面验收：缺字必须在渲染**之前**被用户看到。
//
// 起因：`POST /api/fonts/coverage` 与前端的 `checkFontCoverage()` 早就写好了，
// 但界面上一处都没调用过——CLAUDE.md §2.6 / §6.3 定的这道硬性 pre-flight check
// 是死代码。后果正是契约警告的那个：用户一路做到导出，成片里才发现某个生僻字
// 变成豆腐块，而一次烧录要几分钟。
//
// ## 必须造出缺字才算验过
//
// 只验"字体齐全时不报警"等于没验。本用例主动制造两类缺字，两类症状相反：
//
//   A. 字体本身没有的字形     → 预览与成片**都缺**   → 换字体能解决 → 报警告
//   B. 字体有、预览子集裁掉的 → **只有预览缺**、成片好 → 换字体没用 → 单独提示
//
// A 的造法是选一个覆盖面窄的字体（Helvetica 之流没有任何日文字形），
// 这也正是真实场景——用户看中了某个好看的西文字体。
// B 的造法是往歌词里放「鷗」「α」：Noto Sans CJK JP 有它们，而预览用的子集字体
// 按 JIS X 0208 第一/第二水准裁剪，这两个字都在集合外（后端 `default_charset()`）。
//
// ## 判据为什么不会假通过
//
// 断言的不是"有没有出现警告框"，而是**警告里列出的字符与预期逐个吻合**，
// 且这些字符只可能来自后端响应；同时反向断言另一类字符**没有**被算进来
// （B 类不许出现在 A 类清单里，否则用户会被引去做无用的换字体）。
// 再加一条：切回覆盖完整的字体后警告必须**消失**——只验"能出现"不验"能消失"，
// 一个恒亮的警告也能通过。
//
// ## 后端必须是新的
//
// 本次改动同时改了 `POST /api/fonts/coverage` 的请求契约（query → 请求体，
// 并新增 `preview_missing`）。**后端没有 --reload**，跑本用例前要确认 8000 上
// 那个进程已经重启过；否则第 1 步就会停在"字形检查未完成"。
//
// `KVM_COVERAGE_API` 是给"手上那个后端还没法重启"准备的旁路：只把这一个接口的
// 请求转发到另一个端口上的实例（同一份后端代码），其余请求照常走 Vite 代理。
// 被替换的只有目标端口，请求体、响应体与前端代码路径完全不变。默认关闭。
//
// 用法：node scripts/verify-font-coverage.mjs
// 环境变量：KVM_APP（默认 http://localhost:5173/）、KVM_API（默认 http://127.0.0.1:8000）、
//           KVM_COVERAGE_API（默认空 = 不转发）

import { chromium, webkit } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const API = process.env.KVM_API ?? 'http://127.0.0.1:8000'
const COVERAGE_API = process.env.KVM_COVERAGE_API ?? ''

// 歌词里塞进三类字符：普通日文（两种字体都有）、B 类（字体有但预览子集裁掉）、
// 以及一个**只出现在制作名单里**的 B 类字符 —— 曲名/歌手/词曲那几行同样会被烧进
// 画面（`render/ass_builder.py` 的 `_emit_credits`），漏扫它就会出现
// "歌词都好、片头曲名是豆腐块"。用只在歌手名里出现的「Ⅲ」把这条单独钉住。
const RARE_PREVIEW_ONLY = ['鷗', 'α'] // 歌词正文里的 B 类
const CREDIT_ONLY = 'Ⅲ' // 只在歌手名里出现的 B 类，用于证明制作名单也被扫到
const PLAIN_KANJI = ['春', '君', '触'] // 两种字体的差异靠它们体现
const LYRICS = ['春の鷗が飛ぶ', '君に触れるα']
const TITLE = 'カバレッジ' // 全是 JIS X 0208 内的假名，不给结论添噪声
const ARTIST = `${CREDIT_ONLY}番隊`

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

/** 造一个专用工程：复用别的工程会被并行跑着的用例改掉字体，结论不可复现 */
async function makeProject(tag) {
  const created = await fetch(`${API}/api/projects/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${TITLE} ${tag}`, artist: ARTIST }),
  })
  const project = await created.json()
  await fetch(`${API}/api/lyrics/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: project.id, kind: 'text', content: LYRICS.join('\n') }),
  })
  // 起点必须是覆盖完整的 CJK 字体，否则第一步就分不清"警告出现"是不是本来就在
  await fetch(`${API}/api/projects/${project.id}/style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ font_name: 'Noto Sans CJK JP' }),
  })
  return project.id
}

async function run(name, engine) {
  console.log(`\n########## ${name} ##########`)
  const projectId = await makeProject(name)
  console.log(`   工程 ${projectId}`)

  const browser = await engine.launch()
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark' })
  const page = await ctx.newPage()

  const jsErrors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    // 网络类与 JASSUB 的 worker 限制归到另一堆：本用例与字幕渲染无关，
    // 拿它们判失败会把无关缺陷算到自己头上（webkit dev 下 JASSUB 有已知限制）
    if (/(Failed to load resource|net::|ERR_|HTTP \d{3}|jassub|worker)/i.test(text)) return
    jsErrors.push(text)
  })
  page.on('pageerror', (e) => {
    if (/jassub|worker|SharedArrayBuffer/i.test(e.message)) return
    jsErrors.push(`[pageerror] ${e.message}`)
  })

  // 统计预检请求次数——"不要变成每次按键都发一次请求"是本次改动的硬性要求
  const covRequests = []
  page.on('request', (r) => {
    if (r.url().includes('/api/fonts/coverage')) covRequests.push(r.url())
  })
  if (COVERAGE_API) {
    await page.route('**/api/fonts/coverage', async (route) => {
      const req = route.request()
      const resp = await route.fetch({ url: `${COVERAGE_API}/api/fonts/coverage`, method: 'POST', postData: req.postData() })
      await route.fulfill({ response: resp })
    })
  }

  const openStage = async (label, selector) => {
    await page.locator('.stepbar .step', { hasText: label }).first().click()
    await page.waitForSelector(selector, { timeout: 20000 })
  }

  // --- 1. 进入样式舞台 -----------------------------------------------------

  console.log('\n=== 1. 样式舞台：覆盖完整的字体 ===')
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 20000 })
  const index = await page.evaluate(async (id) => {
    const list = await (await fetch('/api/projects/')).json()
    return list.findIndex((p) => p.id === id)
  }, projectId)
  await page.locator('.pcard:not(.pcard--new)').nth(index).click()
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await openStage('样式', '.sty-stage')

  const cov = page.locator('[data-testid="font-coverage"]')
  await cov.locator('.sty-cov').waitFor({ timeout: 20000 })
  let text = (await cov.innerText()).replace(/\s+/g, ' ')
  console.log(`   ${text}`)
  check(/字形齐全/.test(text), 'CJK 字体：结论是「字形齐全」')
  check(!/缺 \d+ 个字形/.test(text), 'CJK 字体：不报缺字')
  // B 类：字体有、预览子集没有。必须作为**另一条**提示出现，且列出的就是那两个字
  check(/预览缺 \d+ 字/.test(text), 'B 类（只有预览缺）被单独提示', '')
  check(
    RARE_PREVIEW_ONLY.every((c) => text.includes(c)),
    'B 类提示里列出了 鷗 与 α',
    RARE_PREVIEW_ONLY.join(' '),
  )
  // 这个字只出现在歌手名里：它出现在结论里，证明扫的不只是歌词正文
  check(text.includes(CREDIT_ONLY), '制作名单（曲名/歌手）也进了扫描范围', CREDIT_ONLY)
  const afterFirst = covRequests.length
  check(afterFirst >= 1, '确实发出了预检请求（接口不再是死代码）', `${afterFirst} 次`)

  // --- 2. 造出缺字：换成没有日文字形的字体 ---------------------------------

  console.log('\n=== 2. 造出缺字：换成覆盖面窄的字体 ===')
  await page.locator('.sty-fontbar .sty-check input').check()
  // 列表项的 innerText 还带着「不含日文字形」那条角标，整项做全等匹配永远不中；
  // 对族名那个 span 用 text-is 才是精确匹配（点它会冒泡到按钮）
  const item = (family) => page.locator(`.sty-fontitem span:text-is("${family}")`).first()
  const narrow = item('Helvetica')
  await narrow.waitFor({ timeout: 20000 })
  await narrow.scrollIntoViewIfNeeded()
  await narrow.click()
  await page.waitForFunction(
    () => /缺 \d+ 个字形/.test(document.querySelector('[data-testid="font-coverage"]')?.innerText ?? ''),
    { timeout: 20000 },
  )
  text = (await cov.innerText()).replace(/\s+/g, ' ')
  console.log(`   ${text}`)
  check(/缺 \d+ 个字形/.test(text), '窄字体：报出缺字')
  check(
    PLAIN_KANJI.every((c) => text.includes(c)),
    '缺字清单里列出了实际缺的汉字',
    PLAIN_KANJI.join(' '),
  )
  check(!/字形齐全/.test(text), '缺字时不再显示「字形齐全」')

  // --- 3. 缓存：同一个 (字体, 字符集) 不重复发请求 -------------------------

  console.log('\n=== 3. 不发重复请求 ===')
  const beforeToggle = covRequests.length
  // 在两个字体之间来回点：第二次回到已查过的组合，应当直接命中缓存
  const wide = item('Noto Sans CJK JP')
  await wide.scrollIntoViewIfNeeded()
  await wide.click()
  await page.waitForTimeout(1200)
  await narrow.scrollIntoViewIfNeeded()
  await narrow.click()
  await page.waitForTimeout(1200)
  const afterToggle = covRequests.length
  console.log(`   来回切换两次，新增请求 ${afterToggle - beforeToggle} 次`)
  check(afterToggle === beforeToggle, '重复的 (字体, 字符集) 组合不再发请求', `${afterToggle} 次累计`)

  // --- 4. 导出舞台：拦而不断 ----------------------------------------------

  console.log('\n=== 4. 导出舞台 ===')
  const beforeExport = covRequests.length
  await openStage('导出', '.exp-stage')
  const warn = page.locator('[data-testid="export-glyph-warn"]')
  await warn.waitFor({ timeout: 20000 })
  const warnText = (await warn.innerText()).replace(/\s+/g, ' ')
  console.log(`   ${warnText}`)
  check(/字体缺 \d+ 个字形/.test(warnText), '导出前报出缺字')
  check(/样式/.test(warnText), '给出可操作的下一步（去样式换字体）')
  const exportBtn = page.locator('.exp-card button.primary')
  check(!(await exportBtn.isDisabled()), '导出按钮仍然可用（警告不阻断）')
  check(
    covRequests.length === beforeExport,
    '导出舞台复用样式舞台的结果，没有新增请求',
    `${covRequests.length} 次累计`,
  )

  // --- 5. 换回好字体：警告必须消失，B 类徽章出现 ---------------------------

  console.log('\n=== 5. 换回覆盖完整的字体 ===')
  await openStage('样式', '.sty-stage')
  const wideAgain = page.locator('.sty-fontitem span:text-is("Noto Sans CJK JP")').first()
  await wideAgain.waitFor({ timeout: 20000 })
  await wideAgain.scrollIntoViewIfNeeded()
  await wideAgain.click()
  await page.waitForTimeout(1000)
  await openStage('导出', '.exp-stage')
  await page.waitForTimeout(1200)
  const stillWarn = await page.locator('[data-testid="export-glyph-warn"]').count()
  check(stillWarn === 0, '换回好字体后缺字警告消失（不是恒亮的装饰）')
  const gap = page.locator('[data-testid="export-preview-gap"]')
  check((await gap.count()) === 1, 'B 类差异在导出舞台标成「预览缺 N 字」徽章')
  if (await gap.count()) {
    const title = await gap.getAttribute('title')
    console.log(`   徽章 ${(await gap.innerText()).trim()}　悬停 ${title}`)
    check(
      RARE_PREVIEW_ONLY.every((c) => (title ?? '').includes(c)),
      '徽章悬停列出具体是哪几个字',
    )
  }

  console.log(`\n   预检请求总数 ${covRequests.length}`)
  check(jsErrors.length === 0, '无 JS 报错', jsErrors.slice(0, 3).join(' | '))

  await ctx.close()
  await browser.close()
  // 清理：本用例造的工程没有素材，留在列表里只会干扰别的验收
  await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE' })
}

await run('chromium', chromium)
await run('webkit', webkit)

console.log(`\n########## 合计 ${pass} 通过 / ${fail} 失败 ##########`)
process.exit(fail === 0 ? 0 : 1)
