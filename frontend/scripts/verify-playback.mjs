// 播放路径回归验证：**声音与播放头不依赖 <video>**。
//
// 起因是用户在 Safari 上点播放只得到「无法开始播放：The operation is not supported.」。
// 根因不是 Web Audio，而是工程里那份 yt-dlp 下下来的 .mkv —— WebKit 没有 Matroska
// 解复用器，<video> 报 MEDIA_ERR_SRC_NOT_SUPPORTED，而当时播放入口把 video.play()
// 和音频写在同一个 try 里，视频一抛异常就把整段 catch 掉、顺手 setPlaying(false)，
// 声音刚起来就被掐断。
//
// ## 判据为什么不是"播放头有没有走"
//
// 播放头由 AudioContext 主时钟推动，而**无头浏览器不一定有可用的音频输出设备**：
// 本机实测（scripts 里的裸 AudioContext 探针，一个空白页、不含本项目任何代码）
// headless Chromium 的 `ctx.currentTime` 2 秒只走了 5ms，等于冻住。这跟被测代码
// 无关，却会把整份验证变成噪声。
//
// 所以真正的判据是**播放是否真的启动了**，与音频设备无关：
//   1. 界面没有"无法开始播放"提示；
//   2. 播放按钮变成"暂停"（store 里 playing 为真，没有被 catch 分支复位）；
//   3. **采样源真的被命令起播了**，且当时 AudioContext 已 running。
// 时钟能不能走另算，环境允许时才断言。
//
// 第 3 条的观察点有两个，缺一不可：慢速试听保音高之后，正常路径的采样源是
// `lib/timestretch` 的 AudioWorklet（起播 = 往它的 port 发一条 `play`），
// 只有在它建不起来时才退回 `AudioBufferSourceNode.start()`。
// 只盯 BufferSource 的话，正常路径会一直报"音频没起播"——一个纯属判据过期的红叉。
//
// 每个工程都开一个全新的浏览器上下文，并预先把它的 id 写进 localStorage
// （App.tsx 启动时读 `kvm.lastProjectId` 恢复上次工程）。**不要用页面上的下拉框
// 切工程**：切换是异步的，音频引擎重建前那一瞬间界面还是上一个工程的就绪状态，
// 等待条件会瞬间通过，于是在音轨还没解码完时就去点播放，误报成"播放没起来"。
//
//   用法：node scripts/verify-playback.mjs [chromium|webkit]   不带参数则两个都跑

import { chromium, webkit } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui'
const APP = 'http://localhost:5173/'
const API = 'http://127.0.0.1:8000'
const ENGINES = { chromium, webkit }
const wanted = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit']

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

const projects = await fetch(`${API}/api/projects/`).then((r) => r.json())

/** 这个无头引擎里 AudioContext 的时钟走不走。空白页测，不牵涉应用代码 */
async function audioClockTicks(browser) {
  const page = await browser.newPage()
  await page.goto('about:blank')
  const r = await page.evaluate(async () => {
    const AC = window.AudioContext ?? window.webkitAudioContext
    const ac = new AC()
    await ac.resume().catch(() => undefined)
    const osc = ac.createOscillator()
    osc.connect(ac.destination)
    osc.start()
    const t0 = ac.currentTime
    await new Promise((res) => setTimeout(res, 1500))
    return ac.currentTime - t0
  })
  await page.close()
  return r > 0.5
}

/** 预览区的时钟文字（m:ss.cc），转成毫秒。取不到返回 null */
const clockMs = (page) =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll('span')) {
      const m = /^(\d+):(\d{2})\.(\d{2})$/.exec(el.textContent?.trim() ?? '')
      if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) * 10
    }
    return null
  })

async function runEngine(name) {
  console.log(`\n########## ${name} ##########`)
  const browser = await ENGINES[name].launch()
  const clockOk = await audioClockTicks(browser)
  console.log(`   本引擎的 AudioContext 时钟：${clockOk ? '会走' : '冻住（无头无音频设备，播放头断言跳过）'}`)

  for (const summary of projects) {
    const full = await fetch(`${API}/api/projects/${summary.id}`).then((r) => r.json())
    const kind = full.video_path ? `有视频（.${full.video_path.split('.').pop()}）` : '纯音频工程'
    console.log(`\n=== 工程 ${summary.title || '(未命名)'}　${kind} ===`)

    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    await ctx.addInitScript(([id]) => {
      localStorage.setItem('kvm.lastProjectId', id)
      // 走带在「编辑」步骤上；不指定的话新上下文会落到「素材」，那里没有播放器
      localStorage.setItem(`kvm.step.${id}`, 'edit')
      // 记录音频引擎是否真的起播了。挂在原型上，被测代码完全无感
      window.__diag = { started: false, stateAtStart: null, via: null, ctx: null }
      const origStart = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...a) {
        window.__diag.started = true
        window.__diag.via = 'buffer-source'
        window.__diag.stateAtStart = this.context.state
        return origStart.apply(this, a)
      }
      // 保音高路径的起播 = 往 worklet 的 port 发一条 play。
      // **补在 MessagePort 原型上而不是节点实例上**：WebKit 会重建 `node.port`
      // 的包装对象，挂在实例上的补丁过一会儿就失效了
      const AWN = window.AudioWorkletNode
      if (AWN) {
        window.AudioWorkletNode = class extends AWN {
          constructor(ctx, name, opts) {
            super(ctx, name, opts)
            window.__diag.ctx = ctx
          }
        }
      }
      const origPost = MessagePort.prototype.postMessage
      MessagePort.prototype.postMessage = function (msg, ...rest) {
        if (msg && msg.type === 'play') {
          window.__diag.started = true
          window.__diag.via = 'timestretch-worklet'
          window.__diag.stateAtStart = window.__diag.ctx?.state ?? null
        }
        return origPost.call(this, msg, ...rest)
      }
    }, [summary.id])

    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 应用启动在首页，从卡片进工程。**曾经靠 localStorage 里的 kvm.lastProjectId
    // 自动恢复上次工程，界面重排后 App 不再这么做**，脚本却一直没跟上：
    // 于是整轮都停在首页，"音频引擎就绪"直接超时——一个看起来像被测代码坏了、
    // 其实是脚本自己过期的假阴性。
    await page.locator('.pcard', { hasText: summary.title || '未命名' }).first().click()

    const iso = await page.evaluate(() => ({
      crossOriginIsolated: globalThis.crossOriginIsolated,
      sab: typeof SharedArrayBuffer !== 'undefined',
    }))
    check(iso.crossOriginIsolated && iso.sab, '跨源隔离生效', JSON.stringify(iso))

    // 几十 MB 的 wav 要 fetch + decodeAudioData，分离过的工程还要解两条。
    // 「原声」按钮由 disabled 变可用 = 音频引擎真正就绪。
    const ready = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('button')].some(
            (b) => b.textContent?.trim() === '原声' && !b.disabled,
          ),
        undefined,
        { timeout: 180000 },
      )
      .then(() => true)
      .catch(() => false)
    check(ready, '音频引擎就绪（原声按钮可用）')

    const v = await page.evaluate(() => {
      const el = document.querySelector('video')
      return { hasEl: !!el, err: el?.error?.code ?? null }
    })
    console.log(`   <video> ${v.hasEl ? `存在，error=${v.err ?? '无'}` : '未渲染（纯音频工程）'}`)

    // --- 播放 ---
    const before = await clockMs(page)
    await page.locator('button', { hasText: /^播放$/ }).first().click()
    await page.waitForTimeout(2500)

    const notice = await page.evaluate(
      () => document.body.innerText.match(/[^\n]*(无法开始播放|NotSupported)[^\n]*/i)?.[0] ?? '',
    )
    check(!notice, '没有「无法开始播放」', notice || '(界面无错误提示)')

    const after = await page.evaluate(() => ({
      pausedLabel: [...document.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === '暂停',
      ),
      diag: window.__diag,
    }))
    check(after.pausedLabel, '播放状态保持为「正在播放」（没被 catch 分支复位）')
    check(
      after.diag.started && after.diag.stateAtStart === 'running',
      '音频真的起播了（采样源收到起播命令）',
      `via=${after.diag.via} state=${after.diag.stateAtStart}`,
    )

    if (clockOk) {
      let during = before
      for (let t = 0; t < 10 && (during ?? 0) - (before ?? 0) <= 800; t++) {
        await page.waitForTimeout(1000)
        during = await clockMs(page)
      }
      check(during - before > 800, '播放头在往前走', `${before} → ${during} ms`)
    }

    // --- 暂停 ---
    await page.locator('button', { hasText: /^暂停$/ }).first().click()
    await page.waitForTimeout(400)
    check(
      await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '播放'),
      ),
      '暂停生效',
    )

    // --- seek（拖预览区进度条）---
    await page.evaluate(() => {
      const bar = document.querySelector('input[type=range][max]')
      if (!bar) return
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(bar, String(Math.round(Number(bar.max) * 0.4)))
      bar.dispatchEvent(new Event('input', { bubbles: true }))
      bar.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForTimeout(800)
    check(((await clockMs(page)) ?? 0) > 30_000, 'seek 生效')

    await page.screenshot({ path: `${OUT}/50-${name}-${summary.id}.png` })

    // Vite 在 dev 会往 worker 里注入 /@vite/env，WebKit 在 require-corp 下拒绝加载
    // 嵌套 worker 里的这个 import（生产构建没有这段注入，实测 preview 下零报错）。
    // 与播放无关，单列出来不计失败。
    const known = errors.filter((e) =>
      /Cross-Origin-Embedder-Policy|Importing a module script|Fetch is aborted/i.test(e),
    )
    const real = errors.filter((e) => !known.includes(e))
    console.log(`   控制台：真实错误 ${real.length} 条，已知 dev 噪声 ${known.length} 条`)
    real.slice(0, 6).forEach((e) => console.log(`   ❌ ${e.slice(0, 200)}`))
    known.slice(0, 3).forEach((e) => console.log(`   ⚠️  ${e.slice(0, 150)}`))
    if (real.length) fail += real.length

    await ctx.close()
  }

  await browser.close()
}

for (const name of wanted) await runEngine(name)

console.log(`\n通过 ${pass}　失败 ${fail}`)
process.exit(fail ? 1 : 0)
