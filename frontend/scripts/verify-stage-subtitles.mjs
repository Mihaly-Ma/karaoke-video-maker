// 应用级验证：**编辑 / 样式 / 导出三个舞台上，libass 真的把字画到了画布上**。
//
//   用法：node scripts/verify-stage-subtitles.mjs [chromium|webkit] [工程ID]
//   环境变量：KVM_APP（默认 http://localhost:5173/，dev server 或 vite preview 都行）
//
// ## 为什么必须有这条应用级用例
//
// scripts/verify-subtitles.mjs 是夹具级的：它自己建 worker、自己喂 ASS，跑的是
// public/jassub/ 那几个文件。而真正把用户挡在门外的那个 bug（WebKit 在 304 上丢掉
// COEP，见 vite.config.ts 的 `crossOriginIsolationPlugin`）表现为「页面里第二个
// JASSUB 实例起不来」—— 它取决于**应用一共建几个实例、按什么顺序建**，
// 只有走真实界面才覆盖得到。本应用编辑与导出两个舞台共用 `Preview`（挂在 <video> 上），
// 样式舞台用 `StyleFilmPreview`（挂在自备画布上），逐个走一遍就是三次实例创建。
//
// ## 判据
//
// 直接量 JASSUB 那块画布上的像素：`drawImage` 到一块探针画布再 `getImageData`。
// **不打任何补丁** —— 不拦网络、不改 getContext、不屏蔽 WebGL，页面就是用户打开的那个页面。
//
// 三条一起才算通过，缺一条都可能假通过：
//   1. 画布上有**成片的不透明像素**（solid > 阈值）——只有 opaque>0 会被抗锯齿噪点糊弄；
//   2. **换一个播放位置后像素签名必须变化** —— 反证量到的是随时间走的字幕，
//      而不是某块静态装饰或视频画面漏进来的东西；
//   3. 控制台没有 COEP / worker 加载类报错。
//
// 判据有效性已在「故意弄坏」的对照组上验证过：把 vite.config.ts 里的
// `crossOriginIsolationPlugin` 摘掉（也就是让 304 重新丢掉 COEP），WebKit 上
// 第二、三个舞台立刻量到 0 像素并报 COEP，Chromium 不受影响。
//
// ## 两个已经踩过的取证坑
//
// 1. **读像素必须轮询。** worker 画到 OffscreenCanvas 后要过一次合成才到得了占位
//    canvas；而且轮询的判据要是「与上一次读数不同」，不能是「有像素就行」——
//    否则会把上一帧的残留当成本帧结果，第二条断言就永远相等而失效。
// 2. **绝不能靠 `getContext('2d')` 去认「这块画布是不是已经交给 worker 了」。**
//    对普通画布调它会**永久绑定一个 2D 上下文**，之后 `transferControlToOffscreen()`
//    直接抛 InvalidStateError —— 样式舞台的画布是 React 先渲染、JASSUB 稍后才接管的，
//    探针只要在这中间轮询一次就把它毁了，表现为「样式舞台永远找不到字幕画布」。
//    这是探针自己造成的故障，不是产品缺陷。改成按类名认：JASSUB 给自己插的画布带
//    `JASSUB` 类，样式舞台的是 `sty-film__canvas`。

import { chromium, webkit } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const ENGINES = { chromium, webkit }
const engineName = process.argv[2] ?? 'webkit'
const PROJECT_TITLE = process.argv[3] ?? '赤春花'

/** 字幕层就绪的等待上限：应用侧 READY_TIMEOUT_MS 是 20s，这里留出取 ASS 与字体的时间 */
const STAGE_TIMEOUT_MS = 45_000
/** 成片不透明像素的下限。一句日文歌词远超这个数；抗锯齿噪点到不了 */
const SOLID_MIN = 300

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

/**
 * 在页面里找到「字幕画布」并采样。
 *
 * 两种舞台的画布不同：编辑/导出是 JASSUB 自己插在 `<video>` 之后的那块（jassub.js
 * 给它加了 `JASSUB` 类），样式舞台是 `StyleFilmPreview` 自备的 `sty-film__canvas`。
 * **按类名认，不要用 `getContext` 去试探**（原因见文件头「取证坑 2」）。
 * 读像素只用 `drawImage`，对被采的画布没有任何副作用。
 */
const SUBTITLE_CANVAS = 'canvas.JASSUB, canvas.sty-film__canvas'
const SAMPLE = `
  (() => {
    const list = [...document.querySelectorAll(${JSON.stringify(SUBTITLE_CANVAS)})]
    if (!list.length) return null
    // 取面积最大的那块：一个舞台上只会有一块字幕画布，多出来的只可能是正在拆的旧实例
    const c = list.sort((a, b) => b.width * b.height - a.width * a.height)[0]
    const w = Math.min(480, c.width || 480)
    const h = Math.min(270, c.height || 270)
    const p = document.createElement('canvas')
    p.width = w
    p.height = h
    const g = p.getContext('2d', { willReadFrequently: true })
    g.clearRect(0, 0, w, h)
    g.drawImage(c, 0, 0, w, h)
    const d = g.getImageData(0, 0, w, h).data
    let opaque = 0
    let solid = 0
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] === 0) continue
      opaque++
      if (d[i] > 200) solid++
    }
    return { canvas: c.className || '(无class)', size: c.width + 'x' + c.height, opaque, solid, total: w * h }
  })()
`

/** 轮询采样直到签名与 prev 不同（或超时）。prev 为 null 时只等到"采到东西" */
async function sampleUntilChanged(page, prev, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(SAMPLE)
    if (last) {
      const s = `${last.opaque}/${last.solid}`
      if (prev === null ? last.opaque > 0 : s !== prev) return last
    }
    await page.waitForTimeout(200)
  }
  return last
}

const sigOf = (s) => (s ? `${s.opaque}/${s.solid}` : 'null')
const fmt = (s) =>
  s
    ? `画布[${s.canvas}] ${s.size}　非透明 ${s.opaque}/${s.total}　不透明 ${s.solid}`
    : '（没找到字幕画布 —— 字幕层根本没建起来）'

/**
 * 把播放位置拨到全长的 `ratio` 处，并派发 React 认的 input/change 事件。
 *
 * 三个舞台的滑块不是同一个：样式舞台是 `.sty-transport__scrub`（范围是当前这一句
 * 的窗口），编辑/导出是 `Preview` 里那条没有类名的进度条（范围是全曲毫秒数）。
 * 后者只能按 `max` 认 —— 同一块里还有个 `max=1` 的音量滑块，不排除会选错。
 */
async function scrub(page, ratio) {
  return page.evaluate((ratio) => {
    const el =
      document.querySelector('.sty-transport__scrub') ??
      [...document.querySelectorAll('input[type=range]')].find((e) => Number(e.max) > 1000)
    if (!el) return false
    const min = Number(el.min || 0)
    const max = Number(el.max || 100)
    const v = String(Math.round(min + (max - min) * ratio))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, ratio)
}

async function run() {
  console.log(`\n########## ${engineName} @ ${APP} ##########`)
  const browser = await ENGINES[engineName].launch()
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })

  const iso = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated === true,
    sab: typeof SharedArrayBuffer === 'function',
  }))
  check(iso.isolated, 'crossOriginIsolated === true')
  check(iso.sab, 'SharedArrayBuffer 可用（没有靠降级 COEP 换取兼容）')

  // --- 打开工程 ---
  const card = page.locator('.pcard', { hasText: PROJECT_TITLE }).first()
  await card.waitFor({ timeout: 20000 })
  await card.click()
  await page.locator('nav.stepbar').waitFor({ timeout: 20000 })

  // 三个挂字幕的舞台。编辑与导出共用 Preview（视频模式），样式是画布模式。
  // 顺序即用户的实际走法，也正是「同一页面里第 1/2/3 个 JASSUB 实例」这条路径。
  const STAGES = ['编辑', '样式', '导出']

  // 播放位置取几个不同的比例。**不从 0 开始**：播放头停在曲首时本来就可能没有字幕
  // （赤春花首句在 0.774s，而画面还没解出第一帧），拿它当"应该有字"的采样点会误报。
  const RATIOS = [0.3, 0.5, 0.7, 0.4, 0.6]

  for (const label of STAGES) {
    await page.locator('nav.stepbar button', { hasText: label }).first().click()
    console.log(`\n--- ${label} ---`)

    // 字幕层是异步建的（拉 ASS → 取字体 → 起 worker → 建轨），先等它出现
    await sampleUntilChanged(page, null, STAGE_TIMEOUT_MS)

    // 逐个位置采样，收集**不同的**签名。至少要有两个位置画出了成片的字，
    // 且两者不同 —— 一个位置只能证明"有东西"，两个不同才证明"是跟着时间走的字幕"。
    const seen = new Map()
    let prevSig = null
    for (const ratio of RATIOS) {
      if (!(await scrub(page, ratio))) break
      const s = await sampleUntilChanged(page, prevSig, 10000)
      console.log(`   位置 ${ratio}  ${fmt(s)}`)
      prevSig = sigOf(s)
      if (s && s.solid > SOLID_MIN) seen.set(sigOf(s), s)
      if (seen.size >= 2) break
    }

    const best = [...seen.values()].sort((a, b) => b.solid - a.solid)[0]
    check(!!best, `${label}: 画布上有成片的不透明像素`, `solid=${best?.solid ?? 0}`)
    check(
      seen.size >= 2,
      `${label}: 换播放位置后画面变化（字幕跟着时间走）`,
      `不同签名 ${seen.size} 个`,
    )
  }

  const coep = errors.filter((e) =>
    /Cross-Origin-Embedder-Policy|Worker load was blocked/i.test(e),
  )
  console.log('')
  check(coep.length === 0, '控制台没有 COEP / worker 加载报错', `${coep.length} 条`)
  coep.slice(0, 4).forEach((e) => console.log(`      ${e.slice(0, 180)}`))

  const rest = errors.filter((e) => !coep.includes(e))
  if (rest.length) {
    console.log(`   ℹ️  其它控制台错误 ${rest.length} 条（不计失败）：`)
    rest.slice(0, 6).forEach((e) => console.log(`      ${e.slice(0, 180)}`))
  }

  await browser.close()
}

await run()
console.log(`\n通过 ${pass}　失败 ${fail}`)
process.exit(fail ? 1 : 0)
