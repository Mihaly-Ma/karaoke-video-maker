// 诊断：**切换字体之后预览还画不画得出字**。
//
//   用法：node scripts/diag-font-render.mjs [chromium|webkit] [轮数]
//   环境变量：KVM_APP（默认 http://localhost:5173/）、KVM_PROJECT（默认 赤春花）
//
// 用户报告：样式舞台切字体后"只有粗体和明朝能用"，另外"有时"报
// `预览不可用：Unserializable return value`（刷新页面能修好）。
// 这两条是两个不同的故障，本脚本把它们分开量：
//
//   - **画不画得出字** → 画布上的不透明像素数（取样方式沿用 ui-palette.mjs，
//     那套已经在真实像素上验证过 36/0）。
//   - **JASSUB 有没有接管画布** → canvas 的 width/height。300×150 是 canvas 的
//     默认尺寸，意味着这一轮实例压根没建起来（构造失败或 ready 超时）。
//
// 判据不是"canvas 存在"，也不是"没报错"：
//   1. 画布上要有**成片的**不透明像素（solid > 阈值），零星抗锯齿糊弄不过去；
//   2. 每个字体都要单独过——这正是用户报告里"只有两个能用"的形状；
//   3. 连做多轮，间歇性故障要靠次数暴露，单轮全绿不算证据。
//
// 取证坑（已经踩过，别重蹈）：
//   - **绝不能对字幕画布调 `getContext('2d')` 去试探**：会永久绑定 2D 上下文，
//     之后 `transferControlToOffscreen()` 直接抛 InvalidStateError，
//     表现成"样式舞台永远找不到字幕画布"。只用 drawImage 读，对被采画布无副作用。
//   - 读像素要**等到连续两帧一致**：worker 画到 OffscreenCanvas 后要过一次合成
//     才到得了占位 canvas，直接读会拿到上一帧残留。

import { createHash } from 'node:crypto'
import { chromium, webkit } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const PROJECT_TITLE = process.env.KVM_PROJECT ?? '赤春花'
const ENGINES = { chromium, webkit }
const engineName = process.argv[2] ?? 'chromium'
const ROUNDS = Number(process.argv[3] ?? 2)
/**
 * 对照组。`samefont` 拦截 `/api/fonts/subset`，**无论请求哪个族名都回同一份字体字节**
 * ——这正是"libass 悄悄换了另一个面"的形状。此时画面照样有字、像素数照样几千，
 * 只有字形指纹会撞在一起。判据必须在这一组上转红，否则它证明不了任何事。
 */
const SABOTAGE = process.env.KVM_SABOTAGE ?? ''
/** 换字体之后等多久再采样。**这是本诊断的关键自变量**：用户是连着点的，
 *  而每次换字体都要销毁旧 JASSUB 实例、再建一个新的。等得久＝race 被等没了。 */
const WAIT_MS = Number(process.env.KVM_WAIT ?? 7000)

/** 四个 Hiragino + 一个非 Hiragino。后两列是用户的报告与后端给的字重 */
const FONTS = [
  'Hiragino Kaku Gothic StdN',
  'Hiragino Mincho ProN',
  'Hiragino Sans',
  'Hiragino Maru Gothic ProN',
  'Noto Sans CJK JP',
]

const SOLID_MIN = 500

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
    let opaque = 0, solid = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue
      opaque++
      if (d[i + 3] > 200) solid++
    }
    /*
     * **字形指纹**：把画面压成 64x36 的网格，每格记"这一格里不透明像素是否过半"，
     * 拼成一串十六进制。
     *
     * 只数像素总量**分不出字体**——两个字体画同一句话，覆盖面积可以只差 0.4%
     * （实测 Hiragino Sans 4764 vs 丸ゴ 4746）。而"这个字体到底有没有被用上"正是
     * 本诊断要回答的问题：libass 匹配不上族名时会退到手里已有的另一个面，
     * 画面照样有字、像素照样几千，只是**画的是别的字体**。指纹相同 = 同一个面。
     */
    const GW = 64, GH = 36
    const cw = w / GW, ch = h / GH
    let bits = ''
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        let on = 0, tot = 0
        const x0 = Math.floor(gx * cw), x1 = Math.floor((gx + 1) * cw)
        const y0 = Math.floor(gy * ch), y1 = Math.floor((gy + 1) * ch)
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            tot++
            if (d[(y * w + x) * 4 + 3] > 128) on++
          }
        }
        bits += on * 2 > tot ? '1' : '0'
      }
    }
    let hex = ''
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16)
    }
    return { opaque, solid, cw: c.width, ch: c.height, fp: hex, sig: solid * 1009 + opaque }
  })()
`

const engine = ENGINES[engineName]
if (!engine) {
  console.error(`未知引擎 ${engineName}`)
  process.exit(2)
}

const browser = await engine.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
const page = await ctx.newPage()

let jsErrors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') jsErrors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => jsErrors.push(`[pageerror] ${e.message}`))

if (SABOTAGE === 'samefont') {
  let cached = null
  await page.route('**/api/fonts/subset*', async (route) => {
    if (!cached) {
      const resp = await page.request.get(
        `${new URL(APP).origin}/api/fonts/subset?family=${encodeURIComponent('Hiragino Kaku Gothic StdN')}`,
      )
      cached = await resp.body()
    }
    await route.fulfill({ status: 200, contentType: 'font/otf', body: cached })
  })
  console.log('   ⚠️ 对照组 samefont：所有字体请求一律返回同一份字体字节')
}

await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 20000 })

const target = await page.evaluate(async (title) => {
  const list = await (await fetch('/api/projects/')).json()
  const hit = list.find((p) => p.title === title) ?? list[0]
  return { id: hit.id, title: hit.title }
}, PROJECT_TITLE)
console.log(`\n########## 字体渲染诊断 @ ${engineName}　工程「${target.title}」 ##########`)

const openStyle = async () => {
  const index = await page.evaluate(async (id) => {
    const list = await (await fetch('/api/projects/')).json()
    return list.findIndex((p) => p.id === id)
  }, target.id)
  await page.locator('.pcard:not(.pcard--new)').nth(index).click()
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await page.locator('.stepbar .step', { hasText: '样式' }).first().click()
  await page.waitForSelector('.sty-stage', { timeout: 20000 })
  await page.waitForTimeout(6000)
}
await openStyle()

const originalFont = (await page.evaluate(
  async (id) => (await (await fetch(`/api/projects/${id}`)).json()).style.font_name,
  target.id,
))
console.log(`   工程原字体 ${originalFont}`)

/**
 * 指纹摘要：8 位短哈希 + 着墨格数。
 * 直接打印指纹串没用——画面上半部没有字，前缀恒为一长串 0，肉眼看不出差别。
 */
const digest = (fp) => {
  if (!fp) return '（无）'
  const ink = [...fp].reduce(
    (n, ch) => n + (parseInt(ch, 16).toString(2).match(/1/g)?.length ?? 0),
    0,
  )
  return `${createHash('sha1').update(fp).digest('hex').slice(0, 8)}/ink${ink}`
}

const sampleStable = async () => {
  let prev = null
  for (let i = 0; i < 25; i++) {
    const now = await page.evaluate(SAMPLE)
    if (now) {
      if (prev && prev.sig === now.sig) return now
      prev = now
    }
    await page.waitForTimeout(300)
  }
  return prev
}

/** 在完整字体列表里按**精确族名**点一个字体（`Hiragino Sans` 不能点中 `Hiragino Sans GB`） */
const pickFont = async (family) => {
  // 只在列表里找不到时才去开"显示全部"，反复点会把开关来回切、把列表切没
  let item0 = page.locator('.sty-fontitem').filter({ hasText: new RegExp(`^${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
  if ((await item0.count()) === 0) {
    const showAll = page.locator('.sty-fontbar button', { hasText: '显示全部' })
    if (await showAll.count()) await showAll.first().click().catch(() => {})
    await page.waitForTimeout(800)
  }
  const item = page
    .locator('.sty-fontitem')
    .filter({ hasText: new RegExp(`^${family.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`) })
    .first()
  await item.scrollIntoViewIfNeeded()
  await item.click()
  // 换字体要重建 JASSUB 实例：拉子集字体 → 起 worker → 灌字体 → 建轨
  await page.waitForTimeout(WAIT_MS)
}

const results = []
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n=== 第 ${round} 轮 ===`)
  for (const family of FONTS) {
    jsErrors = []
    await pickFont(family)

    // 停在句子中段，扫色扫到一半
    const scrub = page.locator('.sty-transport__scrub')
    const span = Number(await scrub.getAttribute('max'))
    await scrub.fill(String(Math.round(span * 0.5)))
    await page.waitForTimeout(800)

    const shot = await sampleStable()
    const applied = await page.evaluate(
      async (id) => (await (await fetch(`/api/projects/${id}`)).json()).style.font_name,
      target.id,
    )
    const note = await page.locator('.sty-film__note').first().innerText().catch(() => '')
    const ok = !!shot && shot.solid > SOLID_MIN
    results.push({ round, family, ok, solid: shot?.solid ?? 0, cw: shot?.cw, ch: shot?.ch, fp: shot?.fp ?? '' })
    console.log(
      `   ${ok ? '✅' : '❌'} ${family.padEnd(28)} solid=${String(shot?.solid ?? 0).padStart(5)}` +
        `  canvas=${shot?.cw}×${shot?.ch}  指纹=${digest(shot?.fp)}  工程字体=${applied}` +
        (note ? `  提示「${note}」` : ''),
    )
    const real = jsErrors.filter((e) => !/Failed to load resource|net::|ERR_/i.test(e))
    real.slice(0, 3).forEach((e) => console.log(`        ${e.slice(0, 200)}`))
  }
}

// 还原
await page.evaluate(
  async ([id, font]) => {
    await fetch(`/api/projects/${id}/style`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ font_name: font }),
    })
  },
  [target.id, originalFont],
)

console.log('\n=== 汇总 ===')
for (const family of FONTS) {
  const mine = results.filter((r) => r.family === family)
  const good = mine.filter((r) => r.ok).length
  console.log(
    `   ${family.padEnd(28)} ${good}/${mine.length} 轮画出了字` +
      `　solid=${mine.map((r) => r.solid).join(',')}` +
      `　canvas=${[...new Set(mine.map((r) => `${r.cw}×${r.ch}`))].join(' ')}`,
  )
}

/*
 * **每个字体的字形指纹必须互不相同。**
 * 这是本诊断唯一能区分"这个字体真的被用上了"与"libass 悄悄换了另一个面"的判据：
 * 后者画面照样有字、像素数照样正常，只有指纹会暴露它画的是同一个面。
 */
console.log('\n=== 字形指纹（同一句歌词，逐字体） ===')
const byFamily = new Map()
for (const family of FONTS) {
  const fp = results.find((r) => r.family === family)?.fp ?? ''
  byFamily.set(family, fp)
  console.log(`   ${family.padEnd(28)} ${digest(fp)}`)
}
let collisions = 0
const names = [...byFamily.keys()]
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = byFamily.get(names[i])
    const b = byFamily.get(names[j])
    if (a && a === b) {
      collisions++
      console.log(`   ❌ 指纹相同：${names[i]} 与 ${names[j]} 画出来是同一个面`)
    }
  }
}
console.log(
  collisions === 0
    ? '   ✅ 五个字体两两指纹都不同（各自真的被用上了）'
    : `   ❌ ${collisions} 对字体撞了指纹`,
)

await browser.close()
const failed = results.filter((r) => !r.ok).length + collisions
console.log(`\n[${engineName}] ${results.length - failed}/${results.length} 次成功`)
process.exit(failed ? 1 : 0)
