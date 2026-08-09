// 字幕渲染链路的回归验证：**跨源隔离下 libass 真的把字栅格化出了像素**，
// 而且**同一个页面里连开两个实例都能出像素**。
//
//   用法：node scripts/verify-subtitles.mjs [chromium|webkit]
//   环境变量：KVM_APP（默认 http://localhost:5173/，dev server 或 vite preview 都行）
//
// ## 被验证的那个 bug：WebKit 在 304 上丢掉 COEP
//
// 页面跨源隔离（COEP: require-corp）时，worker 脚本自己的响应也必须带 COEP，
// 否则按 HTML 规范的 "check a global object's embedder policy" 判否。
// 而 **WebKit 在用 304 合并缓存响应时不会把原来那份 200 上的 COEP 带回来**，
// worker 的 COEP 被算成 unsafe-none，于是报
// `Refused to load '…/worker.js' worker because of Cross-Origin-Embedder-Policy`。
//
// 症状极具迷惑性：**页面里第一个 worker 正常，第二个才起不来**（第一次 200、
// 第二次才是条件请求），而应用的编辑舞台与样式舞台各要一个 JASSUB 实例，
// 于是「编辑有字幕、样式一直转圈」。被拒后 WebKit 丢掉缓存条目，第三次又成功 ——
// 成功/失败逐次交替，看起来像随机时序问题。Chromium 完全不受影响。
//
// 修法见 vite.config.ts 的 `crossOriginIsolationPlugin`：把 COOP/COEP 装进最前面的
// 中间件，让 304 也带上（Vite 的 `server.headers` / `preview.headers` 由 sirv 的
// setHeaders 落实，而 sirv 是先判条件请求再调 setHeaders，304 上根本没有这两个头）。
// 单变量对照实验见 scripts/probe-coep-headers.mjs。
//
// ## 因此本用例必须建**两个**实例
//
// 旧版本只建一个，结构上就抓不到这个 bug —— 它当时是绿的，而 Safari 上样式舞台
// 一个字都画不出来。「同页面第二个实例」是这条用例存在的主要理由，不要精简掉。
//
// ## 关于取证方式
//
// 不打任何补丁：直接 `new Worker('/jassub/worker/worker.js', { type: 'module' })`，
// 与 jassub.js 构造函数里那一行形状完全一致，渲染器由 JASSUB 自己按环境挑
// （两个引擎在无头下都拿得到 webgl2，走的就是 WebGL2 渲染器）。
//
// 早先一版夹具在这里栽过一次，教训值得留着：它先把占位 canvas 设成 1280×720
// 再 `_resizeCanvas(1280,720,…)`，于是没有构成尺寸变化，而 JASSUB 的 WebGL2 渲染器
// **只在尺寸变化的分支里设 u_resolution**，结果一个像素都没光栅化。当时的结论是
// 「无头浏览器下 worker 的 WebGL 画面传不到占位 canvas」，还据此加了
// 「屏蔽 worker 里的 WebGL 逼它退回 Canvas2D」的取证补丁 —— 补丁掩盖了夹具自身的 bug。
// 现已实测：WebGL2 与 Canvas2D 两条路径给出的像素数完全一致（5724），
// **无头、有头、两个引擎都一样**，补丁已删除。
// 教训与 CLAUDE.md §8.9 那条一致：测量工具必须在**实际工作点**上校准。
//
// **读像素要轮询**：worker 画到 OffscreenCanvas 后，内容要过一次合成才到得了占位
// canvas，只等一两帧会把「慢」误判成「读不到」。轮询只会把假的 0 变成真值，
// 不会把真的空帧变成非空，所以对「无字时刻应当为空」那条断言仍然安全。
//
// ## 判据不是"没报错"
//
//   1. crossOriginIsolated 且 SharedArrayBuffer 可用 —— 证明修复不是靠把 COEP 退回
//      credentialless 换来的（那样 WebKit 会丢掉隔离、退回单线程，等于把问题藏起来）；
//   2. THREAD_COUNT > 1 —— 多线程启用，也就是会去起嵌套 pthread worker；
//   3. **两个**实例都在超时前就绪；
//   4. 每个实例：有字时刻画布上有成片的不透明像素；
//   5. 换时间点重绘，像素统计必须变化 —— 字幕跟着时间走，不是一帧糊在那儿；
//   6. 字幕结束后的时刻近乎全透明 —— 反证前面量到的是字，不是底噪；
//   7. 两份 wasm：本引擎按 SIMD 探测选中的那份必须能跑出像素，另一份必须能取到
//      （实测 chromium 选 modern、WebKit 选 legacy —— 少传一个就会有一端拿不到资源）；
//   8. 控制台没有 COEP / worker 加载类报错。

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
 * 在**同一个页面**里连开 `count` 个 jassub 实例并各自采样像素。
 *
 * 这里手工复刻 jassub.js 构造函数的那几行（worker → abslink.wrap → new Renderer(
 * data, proxy(getFont), transfer(offscreenCanvas))），而不是 import 'jassub' ——
 * 因为 dev 下那是 node_modules 里的模块、preview 下是带 hash 的构建产物，两种形态没有
 * 统一的 URL；而 public/jassub/ 下这几个文件两种形态下路径完全一样。
 * 协议随 jassub 2.5.14 锁死，上游改了这里会直接报错，不会假通过。
 */
const runFixture = (page, wasmUrl, count) =>
  page.evaluate(
    async ([wasmUrl, ass, tA, tB, tEmpty, budget, count]) => {
      const [{ proxy, transfer }, { wrap }] = await Promise.all([
        import('/jassub/vendor/abslink/src/abslink.js'),
        import('/jassub/vendor/abslink/adapters/w3c.js'),
      ])

      // 字体必须**在建轨之前**以字节形式灌进去：libass 的 rawRender 是同步的，
      // "缺字再去 fetch"那条异步补字路径救不回当前这一帧。应用侧同样是预加载。
      const fontBytes = new Uint8Array(
        await fetch('/jassub/default.woff2').then((r) => r.arrayBuffer()),
      )

      const one = async () => {
        const t0 = performance.now()
        // 刻意**不**预设宽高，让下面的 `_resizeCanvas` 真的构成一次尺寸变化。
        // JASSUB 的 WebGL2 渲染器只在「尺寸变了」的分支里设 u_resolution，而
        // `resizeCanvas` 对同尺寸会早退；夹具若先把画布设成目标尺寸，u_resolution
        // 恒为 (0,0)，顶点着色器算出 NaN，一个像素都不会被光栅化 ——
        // 看起来就像「WebGL 的输出传不到占位 canvas」。**这正是早先那版夹具的误判来源**，
        // 它据此加了「屏蔽 worker 里的 WebGL」的补丁，把一个夹具 bug 当成了环境限制。
        // 应用里画布是 JASSUB 自己建的默认 300×150 再 resize 到画面尺寸，天然走到那个分支。
        const canvas = document.createElement('canvas')
        document.body.appendChild(canvas)
        const ctrl = canvas.transferControlToOffscreen()

        // 与 jassub.js 第 58 行同形：同一个 URL、module worker。
        // 「同一个 URL 连开两次」正是本用例要覆盖的那条路径，不要改成 blob 或加 query。
        const worker = new Worker('/jassub/worker/worker.js', {
          name: 'jassub-worker',
          type: 'module',
        })
        const workerErrors = []
        worker.addEventListener('error', (e) =>
          workerErrors.push(`worker error: ${e.message || '(空)'}`),
        )
        const Renderer = wrap(worker)

        const ready = new Renderer(
          {
            wasmUrl,
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
          worker.terminate()
          canvas.remove()
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
         * 画一帧，**等到画面真的变了**再采样。
         *
         * worker 画到 OffscreenCanvas 后要过一次合成才到得了占位 canvas，快的时候
         * 一次就采到，慢的时候要等几十毫秒。若只等到"有像素"就返回，会把**上一帧的
         * 残留**当成本帧的结果 —— 于是"换时间点后统计要变化"那条断言永远相等而失效
         * （实测就这么假过一次：A 与 B 都读出 5724）。所以等的是"与上次读数不同"。
         *
         * 超时就把最后一次读数原样交出去，让断言自己失败，不静默放过。
         */
        const sig = (s) => `${s.opaque}/${s.solid}`
        const sampleAfter = async (time, prevSig) => {
          await renderer._draw(time, true)
          let last = null
          for (let i = 0; i < 40; i++) {
            await new Promise((res) => setTimeout(res, 50))
            last = readPixels()
            if (sig(last) !== prevSig) return last
          }
          return last
        }

        // 起点是一块空画布，所以第一次"变了"就等于"画出了东西"
        const a = await sampleAfter(tA, '0/0')
        const b = await sampleAfter(tB, sig(a))
        const empty = await sampleAfter(tEmpty, sig(b))

        worker.terminate()
        canvas.remove()
        return { ok: true, readyMs, a, b, empty, workerErrors }
      }

      const out = []
      for (let i = 0; i < count; i++) out.push(await one())
      return out
    },
    [wasmUrl, FIXTURE_ASS, T_TEXT_A, T_TEXT_B, T_EMPTY, READY_BUDGET_MS, count],
  )

const fmt = (s) =>
  `非透明 ${s.opaque}/${s.total}（${(s.ratio * 100).toFixed(2)}%）不透明 ${s.solid}` +
  `　主色 ${s.top.map(([k, n]) => `[${k}]×${n}`).join(' ')}`

// ---------------------------------------------------------------------------

/** 同页面里连开几个实例。应用最多同时/相继用到两个（编辑舞台 + 样式舞台） */
const INSTANCES = 2

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

  // --- 多线程真的启用：这正是会去起嵌套 pthread worker 的路径 ---
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
  await page.close()

  // --- 同一页面里连开 INSTANCES 个实例，每个都要出像素 ---
  const p = await freshPage()
  const results = await runFixture(p, chosen[1], INSTANCES)
  await p.close()

  results.forEach((r, i) => {
    const tag = `${chosen[0]} 第 ${i + 1} 个实例`
    if (!r.ok) {
      check(false, `${tag}: worker 就绪`, `${r.readyMs}ms ${r.reason}`)
      r.workerErrors.forEach((e) => console.log(`      ${e}`))
      return
    }
    check(r.readyMs < READY_BUDGET_MS, `${tag}: worker 就绪`, `${r.readyMs}ms`)
    console.log(`      A@${T_TEXT_A}s  ${fmt(r.a)}`)
    console.log(`      B@${T_TEXT_B}s  ${fmt(r.b)}`)
    console.log(`      空@${T_EMPTY}s  ${fmt(r.empty)}`)
    check(r.a.solid > 500, `${tag}: 有成片的不透明像素（不是零星抗锯齿）`, `solid=${r.a.solid}`)
    check(
      r.b.opaque > r.a.opaque,
      `${tag}: 换时间点后像素统计变化（字幕跟着时间走）`,
      `${r.a.opaque} → ${r.b.opaque}`,
    )
    check(
      r.empty.opaque * 20 < r.a.opaque,
      `${tag}: 无字时刻近乎全透明（反证量到的是字）`,
      `${r.empty.opaque} ≪ ${r.a.opaque}`,
    )
    r.workerErrors.forEach((e) => console.log(`      ⚠️ ${e}`))
  })

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
