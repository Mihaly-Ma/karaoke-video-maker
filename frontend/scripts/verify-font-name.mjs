// 预览字体的**族名匹配**回归验证：后端 /api/fonts/subset 产出的字体，
// libass 必须能按「调用方请求的族名」找到它。
//
// ## 被验证的那个 bug
//
// libass 建内存字体索引时只认 name 表里 **Windows 平台（platformID=3）的
// nameID 1（Family）**；nameID 16（Typographic Family）、nameID 4（Full name）、
// nameID 6（PostScript 名）与 Mac 平台（platformID=1）的记录一概不参与匹配
// —— 四者都单独试过，只有 nameID 1 那份能渲出字（见 A 组）。
//
// 而 macOS 的日文字体普遍把字重写进 nameID 1：ヒラギノ丸ゴ ProN 的
// (3,0x409) nameID1 是 "Hiragino Maru Gothic ProN W4"，nameID4 是 "HiraMaruProN-W4"，
// 真正的族名 "Hiragino Maru Gothic ProN" 只出现在 nameID 16 里。
// 后端字体列表用的又是 fontTools 的 getDebugName(1)——它优先取 Mac 平台记录，
// 那条恰好没有 " W4"。于是**接口对外通报的族名，在子集产物里一条都匹配不上**：
// JASSUB 用 ASS_FONTPROVIDER_NONE，匹配不上就没有任何回退，libass 每帧返回 0 张图，
// 且不报错。ffmpeg 侧因为走系统 fontconfig 自动探测，同一个工程烧录完全正常，
// 所以这个 bug 只在预览侧出现、成片看不出来。
//
// 修法见 backend/kvm/render/font_subset.py 的 `_rewrite_family_name`：
// 子集化后把请求的族名写进 nameID 1/4/16。
//
// ## 判据为什么不会假通过
//
// 正文是**纯 CJK**（"愛憎塗世情無常テスト歌詞"）。JASSUB 自带的 default.woff2 是
// Liberation Sans、不含 CJK，本用例又关掉了 queryFonts，所以画面上只要有成片的
// 不透明像素，就只能是喂进去的那份字体真的被匹配上并栅格化了——
// 匹配不上时 libass 连豆腐块都画不出来（没有任何字体可退），画布严格全透明。
//
// 此外把 worker 里 libass 的 `fontselect:` 日志转播回来一并打印：
// 那是 libass 自己说的"这个族名解析到了哪个字体文件"，比像素计数更直接。
//
// ## 两组用例
//
// A. **根因证伪**：拿同一份子集产物（字形字节完全相同）改出四个只有 name 表不同的
//    变体，逐个渲染。只有"nameID 1 等于请求族名"的那份能出字——这才叫证明，
//    而不是"改完好了所以原因就是它"。变体由 /tmp/kvm-fontname/gen.py 生成，
//    缺失时这一组自动跳过（该脚本是一次性取证工具，不进仓库）。
// B. **端到端验收**：直接打后端 /api/fonts/subset，覆盖原本就坏的（ヒラギノ丸ゴ）、
//    原本就好的（Noto，防回归）、以及多子族的（ヒラギノ角ゴ / 明朝）。
//
// ## 取证前提（照抄 scripts/verify-subtitles.mjs，那里有完整说明）
//
// 无头浏览器里 worker 侧的 WebGL 画面传不到占位 canvas，所以 worker 启动前屏蔽
// OffscreenCanvas 的 webgl/webgl2，逼 JASSUB 退到 Canvas2DRenderer；blob worker 的
// 基准 URL 不透明，绝对路径要补成同源绝对 URL。WebKit 下同一页面第二次
// new Worker('/jassub/worker/worker.js') 会被 COEP 拒掉，所以每个用例都开新 page。
//
// 用法：node scripts/verify-font-name.mjs [chromium|webkit]
// 环境变量：KVM_APP（默认 http://localhost:5173/）、KVM_API（默认 http://127.0.0.1:8000）

import { existsSync, readFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const API = process.env.KVM_API ?? 'http://127.0.0.1:8000'
const VARIANTS = process.env.KVM_FONT_VARIANTS ?? '/tmp/kvm-fontname'
const ENGINES = { chromium, webkit }
const wanted = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit']

const READY_BUDGET_MS = 30_000
/**
 * worker 就绪超时的重试次数。
 *
 * WebKit 下连开十几个页面轮流起 jassub worker 时，偶发某一轮迟迟不就绪（实测每次
 * 命中的用例都不同，单独重跑必过），是无头 WebKit 的启动抖动而非产品问题。
 * **只对"就绪超时"重试**：起来了但画不出像素的用例照样判失败，不会被重试掩盖。
 */
const READY_RETRIES = 2
const TEXT = '愛憎塗世情無常テスト歌詞'

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

/** 正文纯 CJK；Bold=0，避免 libass 去找粗体面把失败原因搅浑 */
const assFor = (family) => `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes
LayoutResX: 1280
LayoutResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,${family},110,&H00FFFFFF,&H000000C8,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,5,0,5,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,T,,0,0,0,,{\\pos(640,360)}${TEXT}
`

/** 与 scripts/verify-subtitles.mjs 相同的 SIMD 探测，用来判断本引擎会选哪份 wasm */
const SIMD_PROBE = `WebAssembly.validate(Uint8Array.of(
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
  0x01,0x05,0x01,0x60,0x00,0x01,0x7b,
  0x03,0x02,0x01,0x00,
  0x0a,0x2b,0x01,0x29,0x00,
  0xfd,0x0c,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0xfd,0x0c,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0xfd,0x80,0x02,
  0x0b))`

/** 在页面里起一个 jassub worker，喂指定字体与 ASS，画一帧并采样 */
const renderOnce = (page, args) =>
  page.evaluate(async ([wasmUrl, ass, family, fontB64, fontUrl, budget]) => {
    const [{ proxy, transfer }, { wrap }] = await Promise.all([
      import('/jassub/vendor/abslink/src/abslink.js'),
      import('/jassub/vendor/abslink/adapters/w3c.js'),
    ])

    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    document.body.appendChild(canvas)
    const ctrl = canvas.transferControlToOffscreen()

    // 屏蔽 OffscreenCanvas 的 WebGL + 把 worker 的 console 转播回来（含 libass 的 fontselect 日志）
    const patchUrl = URL.createObjectURL(
      new Blob(
        [
          `const _get = OffscreenCanvas.prototype.getContext
           OffscreenCanvas.prototype.getContext = function (id, ...rest) {
             if (id === 'webgl' || id === 'webgl2' || id === 'webgpu') return null
             return _get.call(this, id, ...rest)
           }
           const relay = (tag, orig) => (...a) => {
             try {
               new BroadcastChannel('kvm-fontname').postMessage(
                 tag + ' ' + a.map((x) => (x && x.stack) || String(x)).join(' | '),
               )
             } catch {}
             orig(...a)
           }
           console.debug = relay('debug', console.debug.bind(console))
           console.warn = relay('warn', console.warn.bind(console))
           console.error = relay('error', console.error.bind(console))`,
        ],
        { type: 'text/javascript' },
      ),
    )
    const workerUrl = URL.createObjectURL(
      new Blob([`import '${patchUrl}'\nimport '${location.origin}/jassub/worker/worker.js'\n`], {
        type: 'text/javascript',
      }),
    )
    const worker = new Worker(workerUrl, { name: 'jassub-worker', type: 'module' })
    const logs = []
    const relay = new BroadcastChannel('kvm-fontname')
    relay.onmessage = (e) => logs.push(e.data)
    worker.addEventListener('error', (e) => logs.push(`worker error ${e.message}`))
    const Renderer = wrap(worker)

    let fontBytes
    let fontBytesLen = 0
    try {
      fontBytes = fontB64
        ? Uint8Array.from(atob(fontB64), (c) => c.charCodeAt(0))
        : new Uint8Array(await fetch(fontUrl).then((r) => r.arrayBuffer()))
      fontBytesLen = fontBytes.byteLength
    } catch (e) {
      return { ok: false, reason: `字体取不到：${e}`, logs }
    }

    const ready = new Renderer(
      {
        wasmUrl: new URL(wasmUrl, location.origin).href,
        width: 1280,
        height: 720,
        subContent: ass,
        fonts: [fontBytes],
        // 与应用侧一致：不查系统字体、不联网，唯一可用字形就是喂进去的这一份
        availableFonts: {},
        defaultFont: family,
        debug: false,
        libassMemoryLimit: 0,
        libassGlyphLimit: 0,
        queryFonts: false,
      },
      proxy(() => undefined),
      transfer(ctrl, [ctrl]),
    )

    let renderer
    try {
      renderer = await Promise.race([
        ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('worker 就绪超时')), budget)),
      ])
    } catch (e) {
      await new Promise((res) => setTimeout(res, 300))
      return { ok: false, reason: String(e), logs, fontBytesLen }
    }

    await renderer._resizeCanvas(1280, 720, 1280, 720)

    const probe = document.createElement('canvas')
    probe.width = 640
    probe.height = 360
    const g = probe.getContext('2d', { willReadFrequently: true })
    const readPixels = () => {
      g.clearRect(0, 0, 640, 360)
      g.drawImage(canvas, 0, 0, 640, 360)
      const d = g.getImageData(0, 0, 640, 360).data
      let opaque = 0
      let solid = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue
        opaque++
        if (d[i + 3] > 200) solid++
      }
      return { total: 640 * 360, opaque, solid, ratio: opaque / (640 * 360) }
    }

    // 空结果重试：Canvas2DRenderer 把 resize 推迟到第一次 render，那一帧常常是空的。
    // 重试只会把假的 0 变成真值，不会把真的空帧变成非空。
    let px = null
    for (let i = 0; i < 4; i++) {
      await renderer._draw(1.0, true)
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
      px = readPixels()
      if (px.opaque > 0) break
    }

    worker.terminate()
    URL.revokeObjectURL(workerUrl)
    URL.revokeObjectURL(patchUrl)
    canvas.remove()
    return { ok: true, ...px, fontBytesLen, logs }
  }, args)

/** A 组：字形相同、只有 name 表不同的变体。expect=true 表示应当出字 */
const VARIANT_CASES = [
  ['hmg_asis.otf', 'Hiragino Maru Gothic ProN', false, '子集原样：nameID1="…ProN W4"、族名只在 nameID16'],
  ['hmg_win_id1.otf', 'Hiragino Maru Gothic ProN', true, '只改 nameID1 → 等于请求族名'],
  // 全名（nameID4）与 PostScript 名（nameID6）都试过，都不参与匹配 —— 只有 nameID1 算数
  ['hmg_win_id4.otf', 'Hiragino Maru Gothic ProN', false, '只改 nameID4（全名）→ 仍匹配不上'],
  ['hmg_win_id6.otf', 'Hiragino Maru Gothic ProN', false, '只改 nameID6（PostScript 名）→ 仍匹配不上'],
  ['hmg_mac_kept.otf', 'Hiragino Maru Gothic ProN', false, '保留 Mac 平台记录（其 nameID1 就是族名），Windows 侧仍是 "…W4"'],
  ['noto_asis.otf', 'Noto Sans CJK JP', true, '对照：本来就好的 Noto'],
  ['noto_id16_only.otf', 'Noto Sans CJK JP', false, '反向破坏 Noto：nameID1/4 改成假名字，只留 nameID16 是真族名'],
]

/** B 组：直接打后端接口 */
const ENDPOINT_CASES = [
  'Hiragino Maru Gothic ProN',
  'Noto Sans CJK JP',
  'Hiragino Sans',
  'Hiragino Mincho ProN',
  'Hiragino Kaku Gothic StdN',
]

const fontselectLines = (logs) =>
  logs.filter((l) => /fontselect/i.test(l)).map((l) => l.replace(/^debug\s+/, '').trim())

async function runEngine(name) {
  console.log(`\n########## ${name} @ ${APP} ##########`)
  const browser = await ENGINES[name].launch()
  const freshPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
    return page
  }

  const probePage = await freshPage()
  const simd = await probePage.evaluate(`(() => ${SIMD_PROBE})()`)
  const wasmUrl = simd ? '/jassub/wasm/jassub-worker-modern.wasm' : '/jassub/wasm/jassub-worker.wasm'
  console.log(`   relaxed SIMD=${simd} → ${simd ? 'modern' : 'legacy'} wasm`)
  await probePage.close()

  const run = async (label, family, { b64 = null, url = null }) => {
    let r
    for (let attempt = 0; attempt <= READY_RETRIES; attempt++) {
      const page = await freshPage()
      try {
        r = await renderOnce(page, [wasmUrl, assFor(family), family, b64, url, READY_BUDGET_MS])
      } finally {
        await page.close()
      }
      if (r.ok || !/就绪超时/.test(r.reason ?? '')) break
      console.log(`   ↻ ${label} 就绪超时，换新页面重试（第 ${attempt + 1} 次）`)
    }
    if (!r.ok) {
      console.log(`   ⚠️  ${label} 跑不起来：${r.reason}`)
      r.logs.slice(0, 4).forEach((l) => console.log(`      ${l.slice(0, 200)}`))
    }
    return r
  }

  // --- A 组：根因证伪 ---
  if (existsSync(`${VARIANTS}/hmg_asis.otf`)) {
    console.log(`\n   —— A 组：name 表变体（字形字节完全相同）——`)
    for (const [file, family, expect, note] of VARIANT_CASES) {
      const b64 = readFileSync(`${VARIANTS}/${file}`).toString('base64')
      const r = await run(file, family, { b64 })
      const got = r.ok && r.opaque > 0
      const detail = r.ok
        ? `非透明 ${r.opaque}/${r.total}（${(r.ratio * 100).toFixed(2)}%）不透明 ${r.solid}`
        : r.reason
      check(got === expect, `${file}：${expect ? '应出字' : '应空白'}　${note}`, detail)
      const fs = fontselectLines(r.logs ?? [])
      fs.slice(0, 2).forEach((l) => console.log(`      libass: ${l.slice(0, 160)}`))
    }
  } else {
    console.log(`\n   ℹ️  跳过 A 组（未找到 ${VARIANTS}/hmg_asis.otf）`)
  }

  // --- B 组：后端接口端到端 ---
  console.log(`\n   —— B 组：GET ${API}/api/fonts/subset ——`)
  for (const family of ENDPOINT_CASES) {
    const url = `${API}/api/fonts/subset?family=${encodeURIComponent(family)}`
    const r = await run(family, family, { url })
    const detail = r.ok
      ? `非透明 ${r.opaque}/${r.total}（${(r.ratio * 100).toFixed(2)}%）不透明 ${r.solid}　字体 ${(r.fontBytesLen / 1e6).toFixed(2)}MB`
      : r.reason
    check(r.ok && r.opaque > 0, `「${family}」渲染出字形`, detail)
    check(r.ok && r.solid > 500, `「${family}」有成片的不透明像素（不是零星抗锯齿）`,
      r.ok ? `solid=${r.solid}` : '—')
    const fs = fontselectLines(r.logs ?? [])
    fs.slice(0, 2).forEach((l) => console.log(`      libass: ${l.slice(0, 160)}`))
  }

  await browser.close()
}

for (const name of wanted) await runEngine(name)

console.log(`\n通过 ${pass}　失败 ${fail}`)
process.exit(fail ? 1 : 0)
