// 「样式」舞台的**配色**验收：逐声部施加方案、真实像素变色、自定义方案自动保存/改名、
// 内置不可改、Cmd+Z 的边界。
//
//   用法：node scripts/ui-palette.mjs [chromium|webkit]
//   对照组：KVM_SABOTAGE=nocolor node scripts/ui-palette.mjs chromium
//           KVM_SABOTAGE=allparts node scripts/ui-palette.mjs chromium
//   环境变量：KVM_APP（默认 http://localhost:5173/）
//
// ## 两个引擎都要跑
//
// 用户实际用 Safari。docs/ui-redesign.md §七点四：只在 Chromium 下验证等于没验证。
// 本应用的 COEP/304 修复之后 WebKit 能正常起 JASSUB（vite.config.ts 文件头有实测），
// 所以这里**不打任何补丁**——不拦网络、不改 getContext、不屏蔽 WebGL，
// 页面就是用户打开的那个页面。
//
// ## 判据为什么不会假通过
//
// 1. **颜色生效看真实像素，而且用「通道占优」而不是比对绝对色值。**
//    ASS 头写着 `YCbCr Matrix: TV.709`，libass 按有限范围作画，落到画布上的值
//    不等于声明值（大致是 `声明值 × 219/255 + 16`，还叠着抗锯齿与描边混色）。
//    拿声明值直接比会全部对不上——**那是量法错，不是颜色错**。
//    这里改成：把已唱填充设成纯红，数「R 明显压过 G/B」的像素；再设成纯蓝，
//    数「B 明显压过 R/G」的像素。有限范围是**逐通道单调**的映射，不改变谁最大，
//    所以这个判据对量法不敏感，同时又真的在看画布上的颜色。
//    两个方向都要求发生**反转**（红多→蓝多、蓝多→红多），单向断言会被
//    "画布上本来就有红" 之类的巧合蒙混过去。
// 2. **"别的声部没变"直接读后端工程 JSON**，不看界面——界面可能只是没重绘。
// 3. **自定义条目的持久化跨了一次真实刷新**，不是读组件内部 state。
// 4. **对照组**：`KVM_SABOTAGE=nocolor` 让探针写回同一个颜色（等于什么都没改），
//    像素判据必须转红；`KVM_SABOTAGE=allparts` 在施加方案之后再把同一组色刷给
//    另一个声部（复现"整套覆盖"的旧行为），"别的声部没变"必须转红。
//    两个对照组都跑过，见报告。
//
// ## 取证坑（已经踩过的，不要重蹈）
//
// - **绝不能对字幕画布调 `getContext('2d')` 去试探**：那会永久绑定 2D 上下文，
//   之后 `transferControlToOffscreen()` 直接抛 InvalidStateError，表现成
//   "样式舞台永远找不到字幕画布"。只用 `drawImage` 读，对被采画布无副作用。
// - **读像素要轮询到"与上一次不同"**：worker 画到 OffscreenCanvas 后要过一次
//   合成才到得了占位 canvas，直接读会拿到上一帧的残留。

import { chromium, webkit } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const ENGINES = { chromium, webkit }
const engineName = process.argv[2] ?? 'chromium'
const SABOTAGE = process.env.KVM_SABOTAGE ?? ''
const PROJECT_TITLE = process.argv[3] ?? '赤春花'

/** 第二个声部的名字。**刻意用中文自定义名**：方案一旦按 `duet_a` 之类的固定键取色，
 *  这里就会静默退回 main，本用例正是要挡住那个已经犯过的错。 */
const SECOND_PART = '女'

const PROBE_RED = '&H000000FF&' // ASS 是 BGR 序：alpha 00 / B 00 / G 00 / R FF
const PROBE_BLUE = '&H00FF0000&'

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

/**
 * 采样字幕画布：统计红占优 / 蓝占优像素数，并回报最亮的那个饱和色。
 * 阈值 40 是为了把抗锯齿灰边和白色未唱字排除掉——它们三通道接近，不会占优。
 */
const SAMPLE = `
  (() => {
    const c = document.querySelector('canvas.sty-film__canvas')
    if (!c) return null
    const w = Math.min(480, c.width || 480)
    const h = Math.min(270, c.height || 270)
    const p = document.createElement('canvas')
    p.width = w
    p.height = h
    const g = p.getContext('2d', { willReadFrequently: true })
    g.clearRect(0, 0, w, h)
    g.drawImage(c, 0, 0, w, h)
    const d = g.getImageData(0, 0, w, h).data
    let opaque = 0, red = 0, blue = 0
    let bestSat = -1, best = null
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue
      opaque++
      const r = d[i], gg = d[i + 1], b = d[i + 2]
      if (r - Math.max(gg, b) > 40) red++
      if (b - Math.max(r, gg) > 40) blue++
      const sat = Math.max(r, gg, b) - Math.min(r, gg, b)
      if (sat > bestSat) { bestSat = sat; best = [r, gg, b] }
    }
    return { opaque, red, blue, best, sig: red * 1000003 + blue * 1009 + opaque }
  })()
`

const engine = ENGINES[engineName]
if (!engine) {
  console.error(`未知引擎 ${engineName}，可选 chromium / webkit`)
  process.exit(2)
}

const browser = await engine.launch()
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  colorScheme: 'dark',
})
const page = await ctx.newPage()

const jsErrors = []
const netErrors = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text()
  ;/(Failed to load resource|net::|ERR_|HTTP 5\d\d|HTTP 4\d\d)/i.test(text)
    ? netErrors.push(text)
    : jsErrors.push(text)
})
page.on('pageerror', (e) => jsErrors.push(`[pageerror] ${e.message}`))

/** 在页面里发 API 请求：同源，走 vite 代理，与应用自己的请求同一条路径 */
const apiGet = (path) => page.evaluate((p) => fetch(p).then((r) => r.json()), path)
const apiSend = (path, method, body) =>
  page.evaluate(
    ([p, m, b]) =>
      fetch(p, {
        method: m,
        headers: { 'Content-Type': 'application/json' },
        body: b === null ? undefined : JSON.stringify(b),
      }).then(async (r) => ({ status: r.status, body: await r.text() })),
    [path, method, body ?? null],
  )

console.log(`\n########## 配色验收 @ ${engineName}${SABOTAGE ? `（对照组 ${SABOTAGE}）` : ''} ##########`)

// --- 0. 找工程 -------------------------------------------------------------

await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 20000 })

const target = await page.evaluate(async (title) => {
  const list = await (await fetch('/api/projects/')).json()
  const hit = list.find((p) => p.title === title) ?? list[0]
  return { id: hit.id, title: hit.title }
}, PROJECT_TITLE)
console.log(`   工程 ${target.id}「${target.title}」`)
const PID = target.id

// 备份：这一轮会改配色（也可能临时造一个声部），跑完必须还原，
// 不能把用户的工程留在测试状态
const original = await apiGet(`/api/projects/${PID}`)
const originalPalettes = original.palettes
const firstLine = original.lines.find((l) => !l.is_metadata && l.tokens.length > 0)
const originalPart = firstLine.voice_part

/**
 * 界面**应当**列出哪些声部：只数真的有行在用的（行级 + token 级覆盖），
 * 一个都没有才兜底 main。拿它跟界面上的按钮逐一对比，就能挡住那个幽灵条目——
 * 无条件塞进去的 `main` 在用户把默认声部改名之后会一直挂在列表里，
 * 而没有任何一行在用它。
 */
const partsOf = (project) => {
  const set = new Set()
  for (const line of project.lines) {
    if (line.voice_part) set.add(line.voice_part)
    for (const tk of line.tokens) if (tk.voice_part) set.add(tk.voice_part)
  }
  if (set.size === 0) set.add('main')
  return [...set].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
}

// 至少要有两个声部才验得了"只有选中的那个会变"。工程里不够就临时造一个中文名的
let createdPart = false
if (partsOf(original).length < 2) {
  await apiSend('/api/editor/voice-part', 'POST', {
    project_id: PID,
    line_id: firstLine.id,
    voice_part: SECOND_PART,
    token_range: null,
  })
  createdPart = true
}
const expectedParts = partsOf(await apiGet(`/api/projects/${PID}`))
const [PART_A, PART_B] = expectedParts
console.log(`   声部（来自歌词数据）${expectedParts.join(' / ')}`)

const openStyle = async () => {
  const index = await page.evaluate(async (id) => {
    const list = await (await fetch('/api/projects/')).json()
    return list.findIndex((p) => p.id === id)
  }, PID)
  await page.locator('.pcard:not(.pcard--new)').nth(index).click()
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await page.locator('.stepbar .step', { hasText: '样式' }).first().click()
  await page.waitForSelector('.sty-stage', { timeout: 20000 })
  await page.waitForTimeout(6000) // 字幕层要拉 ASS + 字体 + 起 worker
}

await openStyle()

// --- 1. 版面：配色紧跟字体，且预览没被挤小 ---------------------------------

console.log('\n=== 1. 版面 ===')
const boxes = await page.evaluate(() => {
  const q = (s) => document.querySelector(s)?.getBoundingClientRect()
  const r = (b) => (b ? { w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.top) } : null)
  const heads = [...document.querySelectorAll('.sty-side .sty-sec__head')].map((el) =>
    el.textContent.trim().replace(/推荐值$/, ''),
  )
  return {
    film: r(q('.sty-film-col')),
    side: r(q('.sty-side')),
    canvas: r(q('canvas.sty-film__canvas')),
    heads,
  }
})
console.log(`   预览列 ${boxes.film?.w}×${boxes.film?.h}　控件栏 ${boxes.side?.w}×${boxes.side?.h}`)
console.log(`   画布 ${boxes.canvas?.w}×${boxes.canvas?.h}`)
console.log(`   区块顺序 ${boxes.heads.join(' → ')}`)
check(!!boxes.canvas, 'JASSUB 画布已挂载')
check(
  boxes.heads[0] === '字体' && boxes.heads[1] === '声部配色',
  '配色紧跟在字体下面',
  boxes.heads.slice(0, 3).join(' / '),
)
check(
  boxes.film && boxes.side && boxes.film.w > boxes.side.w * 2,
  '预览没被挤小（预览列宽度是控件栏两倍以上）',
  `${boxes.film?.w} vs ${boxes.side?.w}`,
)
const aspect = boxes.canvas ? boxes.canvas.w / boxes.canvas.h : 0
check(Math.abs(aspect - 16 / 9) < 0.02, '画布宽高比与画面一致（没有被拉伸）', aspect.toFixed(3))

// --- 2. 方案列表 -----------------------------------------------------------

console.log('\n=== 2. 方案列表 ===')
const schemes = await apiGet('/api/palettes/schemes')
const builtins = schemes.filter((s) => s.builtin)
console.log(`   共 ${schemes.length} 套，内置 ${builtins.length} 套`)
check(builtins.length >= 8, '内置方案 ≥ 8 套', `${builtins.length}`)
check(
  builtins.every((s) => s.colors && !('palettes' in s)),
  '方案是一组四色、不带声部键（那正是会静默失效的建模）',
)
const uiCount = await page.locator('.sty-schemes .sty-scheme').count()
check(uiCount >= builtins.length, '界面列出了全部方案', `${uiCount} 条`)
const builtinActs = await page.locator('.sty-scheme--builtin [data-act]').count()
check(builtinActs === 0, '内置方案没有改名/删除按钮', `${builtinActs} 个`)

// --- 3. 逐声部施加：只有选中的声部会变 -------------------------------------

console.log('\n=== 3. 逐声部施加 ===')
const partButtons = await page.locator('.sty-parts .sty-part').allInnerTexts()
console.log(`   声部列表 ${JSON.stringify(partButtons)}`)
check(
  partButtons.some((p) => p !== 'main'),
  '用户自定义的声部名照常列出（方案取色不依赖固定声部名）',
  partButtons.join(' / '),
)
// 比集合不比顺序：Node 与浏览器的 localeCompare 用的是不同的 ICU 排序表，
// 中文声部名在两边的先后本来就会不一样，而这条要的是"有哪些"
const sortedJoin = (xs) => [...xs].sort().join('|')
check(
  sortedJoin(partButtons) === sortedJoin(expectedParts),
  '声部列表恰好等于"真的有行在用"的那些（没有幽灵 main）',
  `界面 ${partButtons.join('/')}　应有 ${expectedParts.join('/')}`,
)

const clickPart = async (name) => {
  await page.locator('.sty-parts .sty-part', { hasText: new RegExp(`^${name}$`) }).first().click()
  await page.waitForTimeout(200)
}
const clickScheme = async (name) => {
  await page.locator(`.sty-scheme[data-scheme="${name}"] .sty-scheme__main`).click()
  await page.waitForTimeout(1200)
}

const schemeA = builtins[0]
const schemeB = builtins.find((s) => s.colors.sung_fill !== schemeA.colors.sung_fill)

await clickPart(PART_A)
await clickScheme(schemeA.name)
await clickPart(PART_B)
await clickScheme(schemeB.name)

if (SABOTAGE === 'allparts') {
  // 对照组：复现"点一下把所有声部一起刷掉"的旧行为，下面那条断言必须转红
  await apiSend(`/api/projects/${PID}/palettes`, 'POST', {
    palettes: { [PART_A]: { ...schemeB.colors, name: PART_A } },
  })
  await page.waitForTimeout(600)
}

const afterApply = (await apiGet(`/api/projects/${PID}`)).palettes
console.log(`   ${PART_A}.sung_fill = ${afterApply[PART_A]?.sung_fill}（方案 A ${schemeA.colors.sung_fill}）`)
console.log(
  `   ${PART_B}.sung_fill = ${afterApply[PART_B]?.sung_fill}（方案 B ${schemeB.colors.sung_fill}）`,
)
const bMatches = ['unsung_fill', 'unsung_outline', 'sung_fill', 'sung_outline'].every(
  (k) => afterApply[PART_B]?.[k] === schemeB.colors[k],
)
check(bMatches, `点方案 B → 声部「${PART_B}」拿到的正是色板上那四色`)
check(
  afterApply[PART_A]?.sung_fill === schemeA.colors.sung_fill,
  `别的声部没被冲掉（「${PART_A}」仍是方案 A）`,
  `${afterApply[PART_A]?.sung_fill}`,
)

// 当前方案的高亮：选中 女 时，方案 B 应当被标成"当前"
const activeName = await page.locator('.sty-scheme--on').first().getAttribute('data-scheme')
check(activeName === schemeB.name, '列表里标出了当前生效的方案', `${activeName}`)

// --- 4. 真实像素：改颜色，画布上的颜色跟着变 -------------------------------

console.log('\n=== 4. 画布像素 ===')
/*
 * 必须先把预览切到**一句属于被改声部的歌词**上。
 * 这一步栽过一次：默认预览句归「男」，而颜色改的是「合」，画面纹丝不动，
 * 断言于是因为"没变化"而红——那是用例挑错了对象，不是产品坏了。
 */
const previewLines = original.lines.filter((l) => !l.is_metadata && l.tokens.length > 0)
const previewIndex = previewLines.findIndex((l) => l.voice_part === PART_A)
check(previewIndex >= 0, `找得到一句属于「${PART_A}」的歌词来预览`, `第 ${previewIndex + 1} 句`)
await page.locator('.sty-lines .sty-line').nth(previewIndex).click()
await page.waitForTimeout(1500)

await clickPart(PART_A)
const hexInput = page.locator('.sty-color__hex[aria-label="已唱填充 ASS"]')
const outlineInput = page.locator('.sty-color__hex[aria-label="已唱描边 ASS"]')

/** 停在句子中段：扫色扫到一半，未唱色与已唱色同屏 */
const scrub = page.locator('.sty-transport__scrub')
const span = Number(await scrub.getAttribute('max'))
await scrub.fill(String(Math.round(span * 0.5)))
await page.waitForTimeout(800)

/**
 * 轮询到"画面上确实有字、且与上一次读数不同"为止。
 * 两个条件缺一不可：worker 画到 OffscreenCanvas 后要过一次合成才到得了占位 canvas
 * （直接读会拿到上一帧残留），而重新喂 ASS 的瞬间画布会短暂为空（读到 0 像素
 * 就下结论会得出"字幕没画出来"的假阴性）。
 */
const sampleUntilChanged = async (prevSig) => {
  let last = null
  for (let i = 0; i < 30; i++) {
    const now = await page.evaluate(SAMPLE)
    if (now && now.opaque > 500) {
      last = now
      if (now.sig !== prevSig) return now
    }
    await page.waitForTimeout(400)
  }
  return last
}

/**
 * 已唱层的**填充与描边一起**换成探针色。
 *
 * 只换填充是不够的：描边也是画在屏幕上的像素，方案 A 的已唱描边本来就是深蓝
 * （#001850，蓝通道压过其余两个），只改填充的话画面上仍留着一圈蓝边，
 * "红占优压过蓝占优"于是永远不成立——这是量法没覆盖全，不是颜色没生效。
 */
const setSungColors = async (value) => {
  await hexInput.fill(value)
  await hexInput.blur()
  await page.waitForTimeout(1200)
  await outlineInput.fill(value)
  await outlineInput.blur()
  await page.waitForTimeout(2500) // debounce → 提交 → 后端重排 → 拉新 ASS → 重绘
}

const base = await sampleUntilChanged(-1)
console.log(`   基线  不透明 ${base?.opaque}  红占优 ${base?.red}  蓝占优 ${base?.blue}`)

await setSungColors(PROBE_RED)
const redState = await sampleUntilChanged(base?.sig ?? -1)
console.log(
  `   红探针 不透明 ${redState?.opaque}  红占优 ${redState?.red}  蓝占优 ${redState?.blue}` +
    `  最饱和像素 rgb(${redState?.best})`,
)

// 对照组 nocolor：这一步写回同一个颜色，等于什么都没改，下面的反转断言必须转红
await setSungColors(SABOTAGE === 'nocolor' ? PROBE_RED : PROBE_BLUE)
const blueState = await sampleUntilChanged(redState?.sig ?? -1)
console.log(
  `   蓝探针 不透明 ${blueState?.opaque}  红占优 ${blueState?.red}  蓝占优 ${blueState?.blue}` +
    `  最饱和像素 rgb(${blueState?.best})`,
)

check(!!redState && redState.opaque > 500, '画布上有成片的字（不是空画布）', `${redState?.opaque}`)
check(
  !!redState && redState.red > 200 && redState.red > redState.blue * 3,
  '已唱色设成红 → 画布上红占优像素显著占多数',
  `红 ${redState?.red} / 蓝 ${redState?.blue}`,
)
check(
  !!blueState && blueState.blue > 200 && blueState.blue > blueState.red * 3,
  '已唱色设成蓝 → 反转成蓝占优',
  `红 ${blueState?.red} / 蓝 ${blueState?.blue}`,
)
// 反转本身也要断言：只看单向的话，"画布上本来就有红"这种巧合能蒙混过去
check(
  !!redState && !!blueState && redState.red > blueState.red * 3 && blueState.blue > redState.blue * 3,
  '红↔蓝两个方向都发生了反转（不是画面里本来就有那个颜色）',
  `红探针 ${redState?.red}/${redState?.blue}　蓝探针 ${blueState?.red}/${blueState?.blue}`,
)
// 有限范围的换算只作参考打印，不作断言：抗锯齿与描边混色会让它偏，
// 判据用的是通道占优（对单调映射不敏感），见文件头
const predict = (v) => Math.round((v * 219) / 255 + 16)
console.log(`   参考：声明 255 在 TV.709 有限范围下约为 ${predict(255)}`)

// --- 5. 自定义方案：自动保存 / 只增一条 / 刷新还在 / 能改名 ----------------

console.log('\n=== 5. 自定义方案 ===')
const userAfterEdit = (await apiGet('/api/palettes/schemes')).filter((s) => !s.builtin)
console.log(`   用户方案 ${userAfterEdit.map((s) => s.name).join(' / ') || '（无）'}`)
check(userAfterEdit.length >= 1, '改了颜色 → 自动派生出一条自定义方案')
const derived = userAfterEdit[userAfterEdit.length - 1]
check(
  derived?.colors.sung_fill === (SABOTAGE === 'nocolor' ? PROBE_RED : PROBE_BLUE),
  '自定义方案存的是改完之后的颜色',
  `${derived?.colors.sung_fill}`,
)

// 再改一次：应当更新同一条，而不是又冒出一条
await setSungColors('&H0000FF00&')
const userAfterSecond = (await apiGet('/api/palettes/schemes')).filter((s) => !s.builtin)
console.log(`   再改一次后 ${userAfterSecond.map((s) => s.name).join(' / ')}`)
check(
  userAfterSecond.length === userAfterEdit.length,
  '继续微调只更新同一条，列表不会被"自定义 1/2/3…"淹没',
  `${userAfterEdit.length} → ${userAfterSecond.length}`,
)
check(
  userAfterSecond.find((s) => s.name === derived?.name)?.colors.sung_fill === '&H0000FF00&',
  '同一条被更新成了最新颜色',
)

// 刷新页面：方案库是落盘的全局资源
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 20000 })
await openStyle()
const shownAfterReload = await page.locator('.sty-scheme--user').count()
check(shownAfterReload === userAfterSecond.length, '刷新页面后自定义方案仍在列表里', `${shownAfterReload} 条`)

// 改名
const RENAMED = `夜色版 ${Date.now() % 10000}`
const row = page.locator(`.sty-scheme[data-scheme="${derived.name}"]`)
await row.locator('[data-act="rename"]').click()
await page.locator('.sty-scheme__input').fill(RENAMED)
await page.locator('.sty-scheme__input').press('Enter')
await page.waitForTimeout(1200)
const afterRename = (await apiGet('/api/palettes/schemes')).filter((s) => !s.builtin)
console.log(`   改名后 ${afterRename.map((s) => s.name).join(' / ')}`)
check(
  afterRename.some((s) => s.name === RENAMED),
  '改名成功',
)
check(
  afterRename.find((s) => s.name === RENAMED)?.colors.sung_fill === '&H0000FF00&',
  '改名没有把颜色弄丢',
)
check(afterRename.length === userAfterSecond.length, '改名没有多出/少掉条目')

// --- 6. 内置不可改名 / 不可删除（界面之外后端也要拒） ----------------------

console.log('\n=== 6. 内置只读 ===')
const patchBuiltin = await apiSend(
  `/api/palettes/schemes/${encodeURIComponent(schemeA.name)}`,
  'PATCH',
  { new_name: '我的' },
)
const deleteBuiltin = await apiSend(
  `/api/palettes/schemes/${encodeURIComponent(schemeA.name)}`,
  'DELETE',
)
check(patchBuiltin.status === 400, '后端拒绝给内置方案改名', `HTTP ${patchBuiltin.status}`)
check(deleteBuiltin.status === 400, '后端拒绝删除内置方案', `HTTP ${deleteBuiltin.status}`)

// --- 7. Cmd+Z：工程配色退回，方案库不受影响 --------------------------------

console.log('\n=== 7. 撤销的边界 ===')
// 比**整组四色**而不是单个字段：最后一次提交改的可能是描边，只盯填充会看不出撤销发生过
const paletteOf = (proj) => JSON.stringify(proj.palettes[PART_A])
const beforeUndo = paletteOf(await apiGet(`/api/projects/${PID}`))
await page.locator('.sty-film-wrap').click() // 焦点移出输入框，否则快捷键被忽略
await page.keyboard.press('Meta+z')
await page.waitForTimeout(1200)
const afterUndo = paletteOf(await apiGet(`/api/projects/${PID}`))
const libraryAfterUndo = (await apiGet('/api/palettes/schemes')).filter((s) => !s.builtin)
console.log(`   ${PART_A}.sung_fill ${beforeUndo} → ${afterUndo}`)
console.log(`   撤销后方案库 ${libraryAfterUndo.map((s) => s.name).join(' / ')}`)
check(afterUndo !== beforeUndo, 'Cmd+Z 退回了上一套工程配色', `${beforeUndo} → ${afterUndo}`)
check(
  libraryAfterUndo.some((s) => s.name === RENAMED),
  '撤销不动方案库（全局资源不占工程的撤销格）',
)

// --- 8. 控制台 -------------------------------------------------------------

console.log('\n=== 8. 控制台 ===')
check(jsErrors.length === 0, 'JS 无报错', `${jsErrors.length} 条`)
jsErrors.slice(0, 8).forEach((e) => console.log(`      ${e.slice(0, 220)}`))
console.log(`   ℹ️ 网络类错误 ${netErrors.length} 条（单独归类，不计失败）`)
netErrors.slice(0, 6).forEach((e) => console.log(`      ${e.slice(0, 200)}`))

// --- 收尾：还原工程与方案库 ------------------------------------------------

if (createdPart) {
  await apiSend('/api/editor/voice-part', 'POST', {
    project_id: PID,
    line_id: firstLine.id,
    voice_part: originalPart,
    token_range: null,
  })
}
// replace=true 才能把测试造出来的声部配色键删掉（合并式更新删不掉键）
await apiSend(`/api/projects/${PID}/palettes`, 'POST', {
  palettes: originalPalettes,
  replace: true,
})
for (const s of await apiGet('/api/palettes/schemes')) {
  if (!s.builtin) await apiSend(`/api/palettes/schemes/${encodeURIComponent(s.name)}`, 'DELETE')
}

await browser.close()
console.log(`\n[${engineName}] 通过 ${pass}　失败 ${fail}`)
process.exit(fail ? 1 : 0)
