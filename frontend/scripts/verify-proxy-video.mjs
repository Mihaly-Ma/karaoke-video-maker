// 编辑用代理视频的回归验证：**Safari（WebKit）里 <video> 真的出画面**。
//
// 起因：yt-dlp 拿回来的最佳画质是 AV1 / 3840×2160 / Matroska + Opus，WebKit 三重
// 放不了（没有 Matroska 解复用器、不认 MKV 里的 Opus、M1/M2 也没有 AV1 硬解），
// 于是预览一路降级成纯音频。后端 kvm/media/proxy.py 把它转成 H.264 / MP4 /
// 约 1 秒 GOP / 无音轨的代理，前端优先用代理当 <video> 的 src。
//
// ## 判据不是"没报错"
//
// 元素存在、控制台干净都证明不了画面出来了 —— MEDIA_ERR 是异步事件，src 指错了
// 也可能一时看不出来。所以这里逐条断言：
//   1. <video> 的 src 指向 /api/media/file/{id}/proxy（真的走了代理）；
//   2. videoWidth > 0 且 readyState ≥ 2（解码器真的解出了一帧的尺寸）；
//   3. 把当前帧 drawImage 进 canvas，像素**不是纯黑一片**（画面真的画出来了，
//      而不是一个尺寸对但全黑的占位）；
//   4. 播放后 video.currentTime 确实推进。
//
// 第 4 条有个环境陷阱：预览里 <video> 是**从动方**，播放头由 AudioContext 主时钟
// 驱动，而无头浏览器不一定有可用音频设备（verify-playback.mjs 实测 headless
// chromium 的 ctx.currentTime 2 秒只走 5ms）。主时钟冻在 0 时，纠偏逻辑会把视频
// 一直拉回 0，currentTime 自然不动 —— 那是环境噪声，不是被测代码的问题。
// 所以先单独探一下这个引擎的音频时钟：会走就断言应用驱动下的推进，不会走就退回
// 直接对 <video> 调 play() 来验证"这个浏览器确实解得动这份代理"。
//
//   用法：node scripts/verify-proxy-video.mjs [chromium|webkit]
//   环境变量：KVM_APP（默认 http://localhost:5173/）、KVM_API（默认 http://127.0.0.1:8000）
//             KVM_PROJECT（只测指定工程，默认测全部有视频的工程）

import { chromium, webkit } from 'playwright'

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const API = process.env.KVM_API ?? 'http://127.0.0.1:8000'
const ONLY = process.env.KVM_PROJECT ?? ''
const OUT = new URL('../../workspace/out/ui/', import.meta.url).pathname
const ENGINES = { chromium, webkit }
const wanted = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit']

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

const summaries = await fetch(`${API}/api/projects/`).then((r) => r.json())
const projects = []
for (const s of summaries) {
  if (ONLY && s.id !== ONLY) continue
  const full = await fetch(`${API}/api/projects/${s.id}`).then((r) => r.json())
  if (full.video_path) projects.push(full)
}
if (projects.length === 0) {
  console.log('没有带视频的工程可测')
  process.exit(1)
}

/** 这个无头引擎里 AudioContext 的时钟走不走。空白页测，不牵涉应用代码 */
async function audioClockTicks(browser) {
  const page = await browser.newPage()
  await page.goto('about:blank')
  const delta = await page.evaluate(async () => {
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
  return delta > 0.5
}

/** 读 <video> 的解码状态，并把当前帧画进 canvas 采样像素 —— 证明画面真的出来了 */
const inspectVideo = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('video')
    if (!el) return { hasEl: false }
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 36
    let sample = null
    try {
      const ctx = canvas.getContext('2d')
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let min = 255
      let max = 0
      let sum = 0
      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
        min = Math.min(min, lum)
        max = Math.max(max, lum)
        sum += lum
      }
      sample = { min: Math.round(min), max: Math.round(max), mean: Math.round(sum / (data.length / 4)) }
    } catch (e) {
      sample = { error: String(e) }
    }
    return {
      hasEl: true,
      src: el.currentSrc || el.src,
      error: el.error?.code ?? null,
      readyState: el.readyState,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      currentTime: el.currentTime,
      sample,
    }
  })

async function runEngine(name) {
  console.log(`\n########## ${name} ##########`)
  const browser = await ENGINES[name].launch()
  const clockOk = await audioClockTicks(browser)
  console.log(
    `   本引擎的 AudioContext 时钟：${clockOk ? '会走' : '冻住（无头无音频设备，改用直接 play() 验证解码）'}`,
  )

  for (const project of projects) {
    const container = project.video_path.split('.').pop()
    console.log(
      `\n=== 工程 ${project.title || '(未命名)'}　原始素材 .${container}　代理 ${
        project.proxy_video_path ? '已就绪' : '无'
      } ===`,
    )

    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    // 应用启动落在首页，`<video>` 只挂在「对轴」这一步的舞台上。预先把该工程的
    // 步骤记忆写成 align，进去就直接是预览+时间轴，不必再点步骤条。
    await ctx.addInitScript(([id]) => localStorage.setItem(`kvm.step.${id}`, 'align'), [project.id])
    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 首页 → 点开这个工程的卡片（卡片是 div[role=button]，标题在 .pcard__title）
    const title = project.title || '未命名'
    await page.locator('.pcard', { hasText: title }).first().click({ timeout: 30000 })

    // 等解码器真的解出一帧的尺寸（readyState≥2 且 videoWidth>0），而不是等元素出现
    const decoded = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('video')
          return !!el && el.readyState >= 2 && el.videoWidth > 0
        },
        undefined,
        { timeout: 60000 },
      )
      .then(() => true)
      .catch(() => false)

    const info = await inspectVideo(page)
    check(info.hasEl, '<video> 已渲染')
    check(
      !!info.src && info.src.includes('/api/media/file/') && info.src.endsWith('/proxy'),
      '画面走的是编辑用代理',
      info.src ?? '(无 src)',
    )
    check(decoded && info.videoWidth > 0, 'videoWidth > 0（解码器解出了画面尺寸）',
      `${info.videoWidth}×${info.videoHeight} readyState=${info.readyState} error=${info.error ?? '无'}`)
    check(
      !!info.sample && info.sample.max > info.sample.min,
      '当前帧不是纯色占位（drawImage 采样有明暗差）',
      JSON.stringify(info.sample),
    )

    // 没有降级提示 = 应用没走「这个浏览器放不了当前视频」那条路
    const degraded = await page.evaluate(
      () => document.body.innerText.includes('这个浏览器放不了当前视频'),
    )
    check(!degraded, '没有降级为纯音频预览')

    // --- 播放后 currentTime 是否推进 ---
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '原声' && !b.disabled),
      undefined,
      { timeout: 180000 },
    ).catch(() => undefined)

    const t0 = (await inspectVideo(page)).currentTime
    await page.locator('button', { hasText: /^播放$/ }).first().click()
    await page.waitForTimeout(2500)
    const t1 = (await inspectVideo(page)).currentTime

    if (clockOk) {
      check(t1 - t0 > 0.3, '播放后 video.currentTime 推进（应用驱动）', `${t0.toFixed(3)} → ${t1.toFixed(3)}`)
    } else {
      console.log(`   ⏸  应用驱动下 currentTime ${t0.toFixed(3)} → ${t1.toFixed(3)}（音频主时钟冻住，属环境限制）`)
      const direct = await page.evaluate(async () => {
        const el = document.querySelector('video')
        const before = el.currentTime
        await el.play()
        await new Promise((res) => setTimeout(res, 2000))
        const after = el.currentTime
        el.pause()
        return { before, after }
      })
      check(
        direct.after - direct.before > 0.3,
        '播放后 video.currentTime 推进（直接 play()，绕开被冻住的音频时钟）',
        `${direct.before.toFixed(3)} → ${direct.after.toFixed(3)}`,
      )
    }

    // --- seek：短 GOP 的实际收益，拖到 40% 处应能立刻解出新画面 ---
    // 必须先暂停：播放中 <video> 是从动方，rVFC 里的纠偏逻辑会把它一路拉回音频
    // 主时钟的位置，直接改 currentTime 会被立刻改回去（那是同步在正常工作，不是 seek 失败）。
    await page.locator('button', { hasText: /^暂停$/ }).first().click().catch(() => undefined)
    await page.waitForTimeout(300)
    const seeked = await page.evaluate(async () => {
      const el = document.querySelector('video')
      const target = Math.max(1, el.duration * 0.4)
      const t0 = performance.now()
      el.currentTime = target
      await new Promise((res) => {
        el.addEventListener('seeked', res, { once: true })
        setTimeout(res, 5000)
      })
      return { ms: performance.now() - t0, at: el.currentTime, target, width: el.videoWidth }
    })
    check(
      Math.abs(seeked.at - seeked.target) < 1 && seeked.width > 0,
      'seek 到 40% 处能解出新画面',
      `${seeked.ms.toFixed(0)}ms → ${seeked.at.toFixed(2)}s`,
    )

    await page.screenshot({ path: `${OUT}60-proxy-${name}-${project.id}.png` })

    // Vite dev 会往 worker 里注入 /@vite/env，WebKit 在 require-corp 下拒绝加载嵌套
    // worker 里的这个 import（生产构建没有这段注入）。与画面无关，单列不计失败。
    const known = errors.filter((e) =>
      /Cross-Origin-Embedder-Policy|Importing a module script|Fetch is aborted/i.test(e),
    )
    const real = errors.filter((e) => !known.includes(e))
    console.log(`   控制台：真实错误 ${real.length} 条，已知 dev 噪声 ${known.length} 条`)
    real.slice(0, 6).forEach((e) => console.log(`   ❌ ${e.slice(0, 200)}`))
    if (real.length) fail += real.length

    await ctx.close()
  }

  await browser.close()
}

for (const name of wanted) await runEngine(name)

console.log(`\n通过 ${pass}　失败 ${fail}`)
process.exit(fail ? 1 : 0)
