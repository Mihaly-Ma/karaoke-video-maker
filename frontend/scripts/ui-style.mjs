// 「样式」舞台验收：真实 JASSUB 渲染、改样式看得见、配色存得住、内部各区能滚。
//
// 只跑 chromium：webkit 在 dev 模式下有已知的 JASSUB 嵌套 worker 限制
// （vite.config.ts 文件头有说明），与本舞台无关。
//
// ## 一个必须先说清的取证前提
//
// **无头浏览器里 worker 侧的 WebGL 画面传不到占位 canvas**（scripts/verify-subtitles.mjs
// 文件头有实测记录），直接采样恒为 0 —— 那是取证手段的问题，不是字幕没画。
// 所以这里在 worker 启动前把 OffscreenCanvas 的 webgl/webgl2 上下文屏蔽掉，
// 逼 JASSUB 退到 Canvas2DRenderer：被替换的只有最后一步 GPU 上传，worker 启动、
// wasm 加载、libass 排版与字形栅格化全部照旧。
//
// 本机实测这一步其实不是必需的（不打补丁走 WebGL 也能采到，且像素计数与打补丁
// 完全相同：4880 / 4827 / 4837），但换台机器就未必——保留补丁是为了让这份用例
// 在"采不到"时报的是产品问题而不是取证问题。
//
// 判据不是"canvas 存在"：
//   1. 画布上有成片的不透明像素，并报出占比与主色分布；
//   2. 改字号后像素统计**变化**（改了真的看得见）；
//   3. 播放这一句时前后两帧像素分布不同（扫色在推进）；
//   4. 配色改完刷新页面仍在（这是"接上持久化"的验收）；
//   5. 右栏 / 句子条 / 字体表三处滚动容器 scrollHeight>clientHeight 且 scrollTop 改得动；
//   6. 控制台无 JS 报错（网络类单独归类）。
//
// 用法：node scripts/ui-style.mjs
// 环境变量：KVM_APP（默认 http://localhost:5173/）、KVM_API（默认 http://127.0.0.1:8000）

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const API = process.env.KVM_API ?? 'http://127.0.0.1:8000'
const OUT =
  '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui-style'
mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

/** worker 启动前屏蔽 OffscreenCanvas 的 WebGL，见文件头「取证前提」 */
const FORCE_CANVAS2D = () => {
  const Real = window.Worker
  const patchUrl = URL.createObjectURL(
    new Blob(
      [
        `const _get = OffscreenCanvas.prototype.getContext
         OffscreenCanvas.prototype.getContext = function (id, ...rest) {
           if (id === 'webgl' || id === 'webgl2' || id === 'webgpu') return null
           return _get.call(this, id, ...rest)
         }
         /* blob: worker 的基准 URL 不透明，worker.js 里 fetch('/jassub/wasm/…') 解析不了
            （"Failed to parse URL"），wasm 加载不上 → 构造被 .catch(console.error) 吞成
            "Unserializable return value"。这里把绝对路径补全成同源绝对 URL。
            origin 在页面侧就拼死，不能在 worker 里读 location（那是 blob:）。 */
         const _f = globalThis.fetch
         globalThis.fetch = (input, init) =>
           _f(typeof input === 'string' && input.startsWith('/') ? '${location.origin}' + input : input, init)`,
      ],
      { type: 'text/javascript' },
    ),
  )
  window.Worker = class extends Real {
    constructor(url, opts) {
      const href = String(url)
      if (href.includes('/jassub/worker/worker.js')) {
        // 必须是两个**静态** import：写成 await import(...) 会晚一拍，
        // worker.js 求值时才装上消息监听，而构造消息此时已经投递过了
        const shim = URL.createObjectURL(
          new Blob([`import '${patchUrl}'\nimport '${new URL(href, location.origin).href}'\n`], {
            type: 'text/javascript',
          }),
        )
        super(shim, { ...opts, type: 'module' })
        return
      }
      super(url, opts)
    }
  }
}

/** 把占位 canvas 画进探针再逐像素统计。drawImage 读得到 worker 提交的最后一帧 */
const SAMPLE = () => {
  const c = document.querySelector('canvas.sty-film__canvas')
  if (!c) return null
  const W = 480
  const H = 270
  const probe = document.createElement('canvas')
  probe.width = W
  probe.height = H
  const g = probe.getContext('2d', { willReadFrequently: true })
  g.clearRect(0, 0, W, H)
  g.drawImage(c, 0, 0, W, H)
  const d = g.getImageData(0, 0, W, H).data
  let opaque = 0
  let solid = 0
  const colors = new Map()
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    if (a === 0) continue
    opaque++
    if (a > 200) solid++
    const key = `${d[i] >> 6},${d[i + 1] >> 6},${d[i + 2] >> 6}`
    colors.set(key, (colors.get(key) ?? 0) + 1)
  }
  const rect = c.getBoundingClientRect()
  return {
    total: W * H,
    opaque,
    solid,
    ratio: opaque / (W * H),
    css: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    top: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
  }
}

const fmt = (s) =>
  s
    ? `非透明 ${s.opaque}/${s.total}（${(s.ratio * 100).toFixed(2)}%）不透明 ${s.solid}` +
      `　CSS ${s.css}　主色 ${s.top.map(([k, n]) => `[${k}]×${n}`).join(' ')}`
    : '（没有画布）'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
await ctx.addInitScript(FORCE_CANVAS2D)

const jsErrors = []
const netErrors = []
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text()
  ;/(Failed to load resource|net::|ERR_|HTTP 5\d\d|HTTP 4\d\d)/i.test(text)
    ? netErrors.push(text)
    : jsErrors.push(text)
})
page.on('pageerror', (e) => jsErrors.push(`[pageerror] ${e.message}`))

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` })
const sample = () => page.evaluate(SAMPLE)

console.log(`\n########## 样式舞台 @ ${APP} ##########`)

// --- 1. 进入样式舞台 -------------------------------------------------------

console.log('\n=== 1. 进入 ===')
await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 20000 })

// 挑歌词行数最多的那个工程：这一步要确认的是注音、扫色、上下行错开，
// 空工程什么都看不出来。首页卡片的顺序与 GET /api/projects/ 一致。
const target = await page.evaluate(async () => {
  const list = await (await fetch('/api/projects/')).json()
  let best = 0
  list.forEach((p, i) => {
    if (p.line_count > list[best].line_count) best = i
  })
  return { index: best, id: list[best].id, title: list[best].title, lines: list[best].line_count }
})
console.log(`   工程 ${target.id}「${target.title}」${target.lines} 行（卡片 #${target.index}）`)
const projectId = target.id

const openStyle = async () => {
  // 每次都按 id 重新定位卡片：列表按最后修改时间排序，本用例自己的编辑（以及并行
  // 跑着的别的用例）都会改变顺序，记死下标会在刷新之后点进另一个工程
  const index = await page.evaluate(async (id) => {
    const list = await (await fetch('/api/projects/')).json()
    return list.findIndex((p) => p.id === id)
  }, target.id)
  await page.locator('.pcard:not(.pcard--new)').nth(index).click()
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await page.locator('.stepbar .step', { hasText: '样式' }).first().click()
  await page.waitForSelector('.sty-stage', { timeout: 20000 })
  // 字幕层要拉 ASS + 字体 + 起 worker，给足时间
  await page.waitForTimeout(6000)
}
await openStyle()

const boxes = await page.evaluate(() => {
  const q = (s) => document.querySelector(s)?.getBoundingClientRect()
  const film = q('.sty-film-col')
  const side = q('.sty-side')
  const canvas = q('canvas.sty-film__canvas')
  const r = (b) => (b ? { w: Math.round(b.width), h: Math.round(b.height) } : null)
  return { film: r(film), side: r(side), canvas: r(canvas) }
})
console.log(`   预览列 ${boxes.film?.w}×${boxes.film?.h}　控件栏 ${boxes.side?.w}×${boxes.side?.h}`)
console.log(`   画布 ${boxes.canvas?.w}×${boxes.canvas?.h}`)
check(!!boxes.canvas, 'JASSUB 画布已挂载')
check(
  boxes.film && boxes.side && boxes.film.w > boxes.side.w * 2,
  '左大预览 + 右控件（预览列宽度是控件栏两倍以上）',
  `${boxes.film?.w} vs ${boxes.side?.w}`,
)
const aspect = boxes.canvas ? boxes.canvas.w / boxes.canvas.h : 0
check(Math.abs(aspect - 16 / 9) < 0.02, '画布宽高比与画面一致（没有被拉伸）', aspect.toFixed(3))
await shot('01-stage')

// --- 2. 字幕真的画出来了 ---------------------------------------------------

console.log('\n=== 2. 字幕像素 ===')
// 停在这一句的中段：扫色扫到一半，未唱色与已唱色同屏，正好能看出双层 clip 有没有生效
const scrub = page.locator('.sty-transport__scrub')
const span = Number(await scrub.getAttribute('max'))
await scrub.fill(String(Math.round(span * 0.5)))
await page.waitForTimeout(800)

let base = null
for (let i = 0; i < 5 && !base?.opaque; i++) {
  base = await sample()
  if (!base?.opaque) {
    // Canvas2DRenderer 把 resize 推迟到第一次 render，首帧常常采到空的；重画再采
    await scrub.fill(String(Math.round(span * (0.5 + 0.01 * i))))
    await page.waitForTimeout(600)
  }
}
console.log(`   ${fmt(base)}`)
check(!!base && base.opaque > 0, '画布上有非透明像素')
check(!!base && base.solid > 500, '有成片的不透明像素（不是零星抗锯齿）', `solid=${base?.solid}`)
await shot('02-mid-scan')

// --- 3. 改样式看得见 -------------------------------------------------------

console.log('\n=== 3. 改字号 → 预览变化 ===')
const fontNum = page.locator('input.sty-f__num[aria-label="字号"]')
const originalSize = Number(await fontNum.inputValue())
await fontNum.fill(String(originalSize + 48))
await fontNum.blur()
// 提交 → 后端重排 → 拉新 ASS → setTrack → 补一帧
await page.waitForTimeout(3000)
const bigger = await sample()
console.log(`   字号 ${originalSize} → ${originalSize + 48}`)
console.log(`   ${fmt(bigger)}`)
check(
  !!bigger && !!base && bigger.opaque !== base.opaque,
  '改字号后像素统计变化',
  `${base?.opaque} → ${bigger?.opaque}`,
)
check(!!bigger && !!base && bigger.opaque > base.opaque, '字号变大 → 覆盖面积变大')
await shot('03-bigger-font')

await fontNum.fill(String(originalSize))
await fontNum.blur()
await page.waitForTimeout(2500)

// --- 4. 播放这一句：扫色在推进 ---------------------------------------------

console.log('\n=== 4. 播放这一句 ===')
await scrub.fill(String(Math.round(span * 0.25)))
await page.waitForTimeout(600)
const beforePlay = await sample()
await page.locator('.sty-transport button.iconbtn').click()
await page.waitForTimeout(1400)
const during = await sample()
await page.locator('.sty-transport button.iconbtn').click() // 停
console.log(`   播放前 ${fmt(beforePlay)}`)
console.log(`   播放中 ${fmt(during)}`)
const clock = await page.locator('.sty-transport__clock').innerText()
check(
  !!during && !!beforePlay && during.top[0]?.[1] !== beforePlay.top[0]?.[1],
  '播放中像素分布变化（扫色在推进）',
  `主色计数 ${beforePlay?.top[0]?.[1]} → ${during?.top[0]?.[1]}`,
)
check(!/^0\.0s/.test(clock), '时钟在走', clock)
await shot('04-playing')

// --- 5. 换一句 -------------------------------------------------------------

console.log('\n=== 5. 换预览句 ===')
const beforeLine = await page.locator('.sty-line--on .sty-line__text').innerText()
await page.locator('.sty-lines .sty-line').nth(4).click()
await page.waitForTimeout(1500)
const afterLine = await page.locator('.sty-line--on .sty-line__text').innerText()
const other = await sample()
console.log(`   「${beforeLine}」→「${afterLine}」`)
console.log(`   ${fmt(other)}`)
check(beforeLine !== afterLine, '选中句已切换')
check(!!other && other.opaque > 0, '新句子同样画得出像素')
await shot('05-other-line')

// --- 6. 配色改完刷新还在 ---------------------------------------------------

console.log('\n=== 6. 配色持久化 ===')
const hexInputs = page.locator('.sty-color__hex')
const beforeColor = await hexInputs.nth(2).inputValue() // 已唱填充
// 两个探针色轮换：脚本跑第二遍时若沿用同一个值，等于什么都没改，断言会假通过
const probeColor = beforeColor === '&H0033EE22&' ? '&H00EE3322&' : '&H0033EE22&'
await hexInputs.nth(2).fill(probeColor)
await hexInputs.nth(2).blur()
await page.waitForTimeout(2500)

const apiPalette = await page.evaluate(async (id) => {
  const p = await (await fetch(`/api/projects/${id}`)).json()
  return p.palettes
}, projectId)
console.log(`   已唱填充 ${beforeColor} → ${probeColor}`)
console.log(`   后端 palettes：${JSON.stringify(apiPalette)}`)
check(apiPalette?.main?.sung_fill === probeColor, '配色已写回工程（后端已收到）')

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 20000 })
await openStyle()
const afterReload = await page.locator('.sty-color__hex').nth(2).inputValue()
console.log(`   刷新后读到 ${afterReload}`)
check(afterReload === probeColor, '刷新页面后配色仍在')
await shot('06-palette-persisted')

// 顺手验一下方案列表还在（逐声部施加与自定义方案的完整用例在 ui-palette.mjs）
const tplCount = await page.locator('.sty-scheme').count()
console.log(`   配色方案 ${tplCount} 套（来自后端 /api/palettes/schemes）`)
check(tplCount > 0, '配色方案来自后端方案库')

// --- 7. flex 高度链：每个滚动容器单独验 ------------------------------------

console.log('\n=== 7. 内部滚动 ===')
const scrolls = await page.evaluate(() => {
  const probe = (sel, axis) => {
    const el = document.querySelector(sel)
    if (!el) return { sel, missing: true }
    const scrollable =
      axis === 'y' ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth
    const before = axis === 'y' ? el.scrollTop : el.scrollLeft
    if (axis === 'y') el.scrollTop = 200
    else el.scrollLeft = 200
    const after = axis === 'y' ? el.scrollTop : el.scrollLeft
    return {
      sel,
      axis,
      client: axis === 'y' ? el.clientHeight : el.clientWidth,
      scroll: axis === 'y' ? el.scrollHeight : el.scrollWidth,
      scrollable,
      moved: after !== before && after > 0,
    }
  }
  return [probe('.sty-side', 'y'), probe('.sty-lines', 'x'), probe('.sty-fontlist', 'y')]
})
for (const s of scrolls) {
  if (s.missing) {
    check(false, `${s.sel} 存在`)
    continue
  }
  console.log(`   ${s.sel}  ${s.axis}  client=${s.client} scroll=${s.scroll}`)
  check(s.scrollable && s.moved, `${s.sel} 能滚且停得住`)
}

// 外层不滚：整页滚动会把预览顶出屏幕，那正是本舞台要避免的
const outer = await page.evaluate(() => {
  const el = document.querySelector('.stage--scroll')
  return el ? { client: el.clientHeight, scroll: el.scrollHeight } : null
})
console.log(`   .stage--scroll  client=${outer?.client} scroll=${outer?.scroll}`)
check(!!outer && outer.scroll <= outer.client + 1, '外层舞台自身不滚')
// 滚到底截一张：时间 / 引导点 / 声部配色三段都在下半截，不滚到底看不到
await page.evaluate(() => {
  const el = document.querySelector('.sty-side')
  if (el) el.scrollTop = el.scrollHeight
})
await page.waitForTimeout(400)
await shot('07-side-bottom')

// --- 8. 控制台 -------------------------------------------------------------

console.log('\n=== 8. 控制台 ===')
check(jsErrors.length === 0, 'JS 无报错', `${jsErrors.length} 条`)
jsErrors.slice(0, 8).forEach((e) => console.log(`      ${e.slice(0, 220)}`))
console.log(`   ℹ️ 网络类错误 ${netErrors.length} 条（单独归类，不计失败）`)
netErrors.slice(0, 6).forEach((e) => console.log(`      ${e.slice(0, 220)}`))

// --- 收尾：把改过的字号恢复原值（配色留着，它本来就是要存住的东西） --------

await page.evaluate(
  async ([id, size]) => {
    await fetch(`/api/projects/${id}/style`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ font_size: size }),
    })
  },
  [projectId, originalSize],
)

await browser.close()
console.log(`\n通过 ${pass}　失败 ${fail}　截图 ${OUT}`)
process.exit(fail ? 1 : 0)
