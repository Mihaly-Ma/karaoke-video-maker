// 字幕渲染链路的回归验证：**跨源隔离下 libass 真的把字栅格化出了像素**。
//
// ## 被验证的那个 bug
//
// 页面跨源隔离后 JASSUB 走 emscripten 的 pthread 路径，在 worker 里再起嵌套 worker；
// 而 Vite dev server 会往它转换过的每个 worker 文件顶部注入
// `import '/node_modules/vite/dist/client/env.mjs'`，WebKit 拒绝加载嵌套 worker 里的
// 这个 import（"Worker load was blocked by Cross-Origin-Embedder-Policy"），JASSUB 于是
// 超时不就绪 —— 画面有、字幕整块没有。Chromium 不受影响，生产构建也没有这段注入。
// 修法是把 worker/wasm 挪到 public/jassub/ 让 Vite 原样下发
// （scripts/sync-jassub-assets.mjs + src/lib/jassub.ts 的 JASSUB_ASSETS）。
//
// ## 为什么测夹具而不是整个编辑器界面
//
// 这个 bug 完全落在「worker 起不起得来、libass 出不出像素」这一层，与工程、歌词、
// 系统字体、后端都无关。夹具直接按 jassub.js 的构造协议把 public/jassub/ 下的 worker
// 拉起来：不依赖后端在线，不受编辑器 UI 迭代影响，dev 与 preview 两种形态跑同一套断言。
// 应用整体的联调另有 verify-proxy-video.mjs 等脚本。
//
// ## 两个必须知道的取证前提（都是无头浏览器的限制，不是产品问题）
//
// 1. **worker 里用 WebGL 画到 OffscreenCanvas，画面到不了占位 canvas。**
//    实测：worker 里 2D 绘制能传到占位 canvas（200×100 全部采到），换成 WebGL2 清屏
//    就恒为 0；chromium 加 `headless:false` 后正常，**Playwright 的 WebKit 无论有头
//    无头都传不过来**。JASSUB 只要 `getContext('webgl2')` 成功就走 WebGL 渲染器，
//    于是它的输出在这个环境里既截不到图也采不到像素 —— 与字幕本身画没画无关。
//    所以夹具在 worker 启动前把 OffscreenCanvas 的 webgl/webgl2 上下文屏蔽掉，
//    逼 JASSUB 退到 Canvas2DRenderer。被换掉的只有最后一步 GPU 上传；
//    worker 启动、嵌套 pthread worker、wasm 加载、libass 排版与字形栅格化 —— 也就是
//    本次修复真正牵涉的部分 —— 全部照旧。
// 2. **同一页面里第二次 `new Worker('/jassub/worker/worker.js')`**，WebKit 会以
//    "Refused to load ... because of Cross-Origin-Embedder-Policy" 拒掉：同一 URL 先被
//    当模块 import、再当 worker 用时，它对内存缓存里那份的 COEP 判定会出错。
//    首次加载一切正常，换新页面即可绕开，所以每轮都开新 page。
//
// ## 判据不是"没报错"
//
//   1. crossOriginIsolated 且 SharedArrayBuffer 可用 —— 证明修复不是靠把 COEP 退回
//      credentialless 换来的（那样 WebKit 会丢掉隔离、退回单线程，等于把问题藏起来）；
//   2. THREAD_COUNT > 1 —— 多线程启用，也就是会去起嵌套 worker、原来翻车的那条路径；
//   3. worker 在超时前就绪；
//   4. 画布上**存在 alpha>0 的像素**且有成片的不透明像素，报出占比与主色分布；
//   5. 换时间点重绘，像素统计必须变化 —— 字幕跟着时间走，不是一帧糊在那儿；
//   6. 字幕结束后的时刻近乎全透明 —— 反证前面量到的是字，不是底噪；
//   7. 两份 wasm：本引擎按 SIMD 探测选中的那份必须能跑出像素，另一份必须能取到
//      （实测 chromium 选 modern、WebKit 选 legacy —— 少传一个就会有一端拿不到资源）；
//   8. 控制台没有 COEP / worker 加载类报错。
//
//   用法：node scripts/verify-subtitles.mjs [chromium|webkit]
//   环境变量：KVM_APP（默认 http://localhost:5173/，dev server 或 vite preview 都行）

import { chromium, webkit } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const ENGINES = { chromium, webkit }
const wanted = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit']

/** 应用侧 READY_TIMEOUT_MS 是 20s；夹具比应用轻，逼近它就说明还在走慢路径 */
const READY_BUDGET_MS = 20_000

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

// ---------------------------------------------------------------------------
// 夹具用的 ASS
// ---------------------------------------------------------------------------
//
// 字体只用 jassub 自带的 Liberation Sans（public/jassub/default.woff2，无 CJK），
// 所以正文写 ASCII —— 这条用例测的是"libass 出不出像素"，不是中日文字形覆盖，
// 掺进系统字体只会把失败原因搅浑。
// 三段时间：1.5s 一串字、5.5s 换成更长的一串（像素数必然更多）、9s 什么都没有。
const FIXTURE_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes
LayoutResX: 1280
LayoutResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Test,liberation sans,96,&H00FFFFFF,&H000000C8,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,0,5,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:03.00,Test,,0,0,0,,{\\pos(640,360)}KARAOKE
Dialogue: 0,0:00:04.50,0:00:07.00,Test,,0,0,0,,{\\pos(640,360)}KARAOKE VIDEO MAKER
`

const T_TEXT_A = 1.5
const T_TEXT_B = 5.5
const T_EMPTY = 9.0

/**
 * JASSUB 用来在 modern / legacy 两份 wasm 之间二选一的那段探测，原样照抄自
 * jassub.js 的 `JASSUB._test()`：校验一个用了 relaxed SIMD（i8x16.relaxed_swizzle）
 * 的最小模块能否通过验证。抄过来是为了让"本引擎会选哪一份"在报告里是实测值而非猜测。
 */
const SIMD_PROBE = `WebAssembly.validate(Uint8Array.of(
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
  0x01,0x05,0x01,0x60,0x00,0x01,0x7b,
  0x03,0x02,0x01,0x00,
  0x0a,0x2b,0x01,0x29,0x00,
  0xfd,0x0c,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0xfd,0x0c,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0xfd,0x80,0x02,
  0x0b))`

/**
 * 在页面里跑起 jassub 的 worker 并采样像素。
 *
 * 这里手工复刻 jassub.js 构造函数的那几行（worker → abslink.wrap → new Renderer(
 * data, proxy(getFont), transfer(offscreenCanvas))），而不是 import 'jassub' ——
 * 因为 dev 下那是 node_modules 里的模块、preview 下是带 hash 的构建产物，两种形态没有
 * 统一的 URL；而 public/jassub/ 下这几个文件两种形态下路径完全一样。
 * 协议随 jassub 2.5.14 锁死，上游改了这里会直接报错，不会假通过。
 */
const runFixture = (page, wasmUrl) =>
  page.evaluate(
    async ([wasmUrl, ass, tA, tB, tEmpty, budget]) => {
      const t0 = performance.now()
      const [{ proxy, transfer }, { wrap }] = await Promise.all([
        import('/jassub/vendor/abslink/src/abslink.js'),
        import('/jassub/vendor/abslink/adapters/w3c.js'),
      ])

      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 720
      document.body.appendChild(canvas)
      const ctrl = canvas.transferControlToOffscreen()

      // worker 入口套一层 blob 壳：先屏蔽 OffscreenCanvas 的 WebGL 上下文，再加载真正的
      // worker。目的见文件头"取证前提 1"：无头环境下 worker 的 WebGL 画面传不到占位 canvas。
      //
      // 两处细节都踩过坑：
      // - 必须是**两个静态 import**。写成 `await import(...)` 会晚一拍：worker.js 求值时
      //   才调 expose() 装上消息监听，而构造消息此时已经投递过了，于是永远等不到就绪。
      //   静态依赖图在 worker 事件循环启动前就求值完，顺序也保证补丁先于 worker.js。
      // - blob: 模块的基准 URL 不透明，`/jassub/...` 这种绝对路径解析不了
      //   （"does not resolve to a valid URL"），必须把 origin 拼全。
      //   拼全之后取到的仍是同源资源，跨源隔离照常生效，嵌套 pthread worker 也照样从
      //   public/ 起 —— 也就是说本次修复要验的那条路径一步没少。
      // 顺带把 worker 里的 console.error 转播回主线程：jassub 的 ASSRenderer 构造函数
      // 写的是 `.catch(console.error)`，构造失败会被吞成一个 undefined 返回值，
      // 主线程只看得到 abslink 的 "Unserializable return value" —— 真正的原因全在 worker
      // 那一侧。不转播就没法排查。
      const patchUrl = URL.createObjectURL(
        new Blob(
          [
            `const _get = OffscreenCanvas.prototype.getContext
             OffscreenCanvas.prototype.getContext = function (id, ...rest) {
               if (id === 'webgl' || id === 'webgl2' || id === 'webgpu') return null
               return _get.call(this, id, ...rest)
             }
             const _err = console.error
             console.error = (...a) => {
               try {
                 new BroadcastChannel('jassub-verify').postMessage(
                   a.map((x) => (x && x.stack) || String(x)).join(' | '),
                 )
               } catch {}
               _err(...a)
             }`,
          ],
          { type: 'text/javascript' },
        ),
      )
      const workerUrl = URL.createObjectURL(
        new Blob(
          [`import '${patchUrl}'\nimport '${location.origin}/jassub/worker/worker.js'\n`],
          { type: 'text/javascript' },
        ),
      )
      const worker = new Worker(workerUrl, { name: 'jassub-worker', type: 'module' })
      const workerErrors = []
      worker.addEventListener('error', (e) => workerErrors.push(`worker error: ${e.message}`))
      const relay = new BroadcastChannel('jassub-verify')
      relay.onmessage = (e) => workerErrors.push(`worker console.error: ${e.data}`)
      const Renderer = wrap(worker)

      // 字体必须**在建轨之前**以字节形式灌进去：libass 的 rawRender 是同步的，
      // "缺字再去 fetch"那条异步补字路径救不回当前这一帧。应用侧同样是预加载。
      const fontBytes = new Uint8Array(
        await fetch('/jassub/default.woff2').then((r) => r.arrayBuffer()),
      )

      const ready = new Renderer(
        {
          // 同样因为 blob worker 的基准 URL 不透明：worker.js 会把 globalThis.fetch 换成
          // 「无论要什么都去取 data.wasmUrl」，而在 blob 上下文里相对路径解析不了，
          // 会以一个只剩 `fetch@[native code]` 的 TypeError 收场。应用侧 worker 挂在
          // 正常 http URL 上，传相对路径没有这个问题。
          wasmUrl: new URL(wasmUrl, location.origin).href,
          width: 1280,
          height: 720,
          subContent: ass,
          fonts: [fontBytes],
          // 不联网、不查系统字体：预览与导出必须用同一套字体，测试更要可复现
          availableFonts: {},
          defaultFont: 'liberation sans',
          debug: false,
          libassMemoryLimit: 0,
          libassGlyphLimit: 0,
          queryFonts: false,
        },
        proxy(() => undefined),
        transfer(ctrl, [ctrl]),
      )

      let renderer
      let readyMs = -1
      try {
        renderer = await Promise.race([
          ready,
          new Promise((_, rej) => setTimeout(() => rej(new Error('worker 就绪超时')), budget)),
        ])
        readyMs = Math.round(performance.now() - t0)
      } catch (e) {
        // 给转播回来的 worker 侧报错一点到达时间，否则失败原因常常是空的
        await new Promise((res) => setTimeout(res, 300))
        return { ok: false, readyMs: Math.round(performance.now() - t0), reason: String(e), workerErrors }
      }

      // 走一次真实布局路径：应用侧也是先 _resizeCanvas 再 _draw
      await renderer._resizeCanvas(1280, 720, 1280, 720)

      const probe = document.createElement('canvas')
      probe.width = 640
      probe.height = 360
      const g = probe.getContext('2d', { willReadFrequently: true })

      const readPixels = () => {
        g.clearRect(0, 0, 640, 360)
        g.drawImage(canvas, 0, 0, 640, 360)
        const d = g.getImageData(0, 0, 640, 360).data
        const total = 640 * 360
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
        return {
          total,
          opaque,
          solid,
          ratio: opaque / total,
          top: [...colors.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3),
        }
      }

      /**
       * 画一帧再采样。
       *
       * 空结果要重试几次：Canvas2DRenderer 把 resize 推迟到第一次 render 时才执行，
       * 那一帧会先清空画布，加上 worker→占位 canvas 的推送要过合成，**第一次采样常常
       * 采到空的**（实测偶发，重画一次必有）。重试只会把假的 0 变成真值，
       * 不会把真的空帧变成非空，所以对"无字时刻应当为空"那条断言是安全的。
       */
      const sampleAt = async (time) => {
        let last = null
        for (let attempt = 0; attempt < 4; attempt++) {
          await renderer._draw(time, true)
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
          last = readPixels()
          if (last.opaque > 0) return last
        }
        return last
      }

      const a = await sampleAt(tA)
      const b = await sampleAt(tB)
      const empty = await sampleAt(tEmpty)

      worker.terminate()
      URL.revokeObjectURL(workerUrl)
      URL.revokeObjectURL(patchUrl)
      canvas.remove()
      return { ok: true, readyMs, a, b, empty, workerErrors }
    },
    [wasmUrl, FIXTURE_ASS, T_TEXT_A, T_TEXT_B, T_EMPTY, READY_BUDGET_MS],
  )

const fmt = (s) =>
  `非透明 ${s.opaque}/${s.total}（${(s.ratio * 100).toFixed(2)}%）不透明 ${s.solid}` +
  `　主色 ${s.top.map(([k, n]) => `[${k}]×${n}`).join(' ')}`

// ---------------------------------------------------------------------------

async function runEngine(name) {
  console.log(`\n########## ${name} @ ${APP} ##########`)
  const browser = await ENGINES[name].launch()
  const errors = []
  const freshPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
    return page
  }

  const page = await freshPage()

  // --- 跨源隔离仍在（修复不是靠降级 COEP 换来的）---
  const iso = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated === true,
    sab: typeof SharedArrayBuffer === 'function',
    cores: navigator.hardwareConcurrency,
  }))
  check(iso.isolated, 'crossOriginIsolated === true')
  check(iso.sab, 'SharedArrayBuffer 可用', `hardwareConcurrency=${iso.cores}`)

  // --- 多线程真的启用：这正是会去起嵌套 pthread worker、原来在 WebKit 上翻车的路径 ---
  const threads = await page.evaluate(async () => {
    const { THREAD_COUNT } = await import('/jassub/worker/util.js')
    return THREAD_COUNT
  })
  check(threads > 1, 'libass 走多线程（会创建嵌套 pthread worker）', `THREAD_COUNT=${threads}`)

  // --- 本引擎按 SIMD 探测会选哪一份 wasm ---
  const simd = await page.evaluate(`(() => ${SIMD_PROBE})()`)
  const chosen = simd
    ? ['modern', '/jassub/wasm/jassub-worker-modern.wasm']
    : ['legacy', '/jassub/wasm/jassub-worker.wasm']
  const other = simd
    ? ['legacy', '/jassub/wasm/jassub-worker.wasm']
    : ['modern', '/jassub/wasm/jassub-worker-modern.wasm']
  console.log(`   本引擎 relaxed SIMD=${simd} → 选用 ${chosen[0]} wasm`)

  // 另一份也必须能取到：换台机器 / 换个浏览器就会选到它，404 会当场变成"字幕消失"
  const otherStatus = await page.evaluate(
    async (url) => (await fetch(url, { method: 'HEAD' })).status,
    other[1],
  )
  check(otherStatus === 200, `另一份 wasm（${other[0]}）也在位`, `HTTP ${otherStatus}`)

  const p = await freshPage()
  const r = await runFixture(p, chosen[1])
  await p.close()

  if (!r.ok) {
    check(false, `${chosen[0]}: worker 就绪`, `${r.readyMs}ms ${r.reason}`)
    r.workerErrors.forEach((e) => console.log(`      ${e}`))
  } else {
    check(r.readyMs < READY_BUDGET_MS, `${chosen[0]}: worker 就绪`, `${r.readyMs}ms`)
    console.log(`      A@${T_TEXT_A}s  ${fmt(r.a)}`)
    console.log(`      B@${T_TEXT_B}s  ${fmt(r.b)}`)
    console.log(`      空@${T_EMPTY}s  ${fmt(r.empty)}`)
    check(r.a.opaque > 0, '有字时刻画布有非透明像素', `${(r.a.ratio * 100).toFixed(2)}%`)
    check(r.a.solid > 500, '有成片的不透明像素（不是零星抗锯齿）', `solid=${r.a.solid}`)
    check(r.b.opaque > r.a.opaque, '换时间点后像素统计变化（字幕跟着时间走）',
      `${r.a.opaque} → ${r.b.opaque}`)
    check(r.empty.opaque * 20 < r.a.opaque, '无字时刻近乎全透明（反证量到的是字）',
      `${r.empty.opaque} ≪ ${r.a.opaque}`)
    r.workerErrors.forEach((e) => console.log(`      ⚠️ ${e}`))
  }

  // --- 控制台 ---
  const coep = errors.filter((e) =>
    /Cross-Origin-Embedder-Policy|Worker load was blocked|Importing a module script/i.test(e),
  )
  check(coep.length === 0, '控制台没有 COEP / worker 加载报错', `${coep.length} 条`)
  coep.slice(0, 4).forEach((e) => console.log(`      ${e.slice(0, 200)}`))

  const rest = errors.filter((e) => !coep.includes(e))
  if (rest.length) {
    console.log(`   ℹ️  其它控制台错误 ${rest.length} 条（与本用例无关，不计失败）：`)
    rest.slice(0, 6).forEach((e) => console.log(`      ${e.slice(0, 200)}`))
  }

  await browser.close()
}

for (const name of wanted) await runEngine(name)

console.log(`\n通过 ${pass}　失败 ${fail}`)
process.exit(fail ? 1 : 0)
