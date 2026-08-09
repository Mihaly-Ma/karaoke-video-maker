// 「对轴」舞台换肤验收。
//
// 断言的都是**看得见的结果**，不是"元素存在"：
//   1. 波形 canvas 真的画出来了（wavesurfer 的 canvas 在 shadow root 里，要穿透）
//   2. 四种时间来源的计算样式取到的正是 --src-* 四个 token 值，且互不相同
//   3. 全页面只剩一个播放按钮（docs/ui-redesign.md §五）
//   4. 空格按一次只触发一次 —— 这是历史 bug 的回归测试，见下方说明
//   5. tap-to-time 入口可见（CLAUDE.md §2.5：它是一等公民）
//   6. 控制台无 JS 报错
//
// 只跑 chromium：webkit 在 dev 模式下有已知的 JASSUB 嵌套 worker 限制，与本次改动无关。

import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { chromium } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui-align'
mkdirSync(OUT, { recursive: true })

const errors = []
let failed = 0
const check = (ok, msg) => {
  if (!ok) failed++
  console.log(`   ${ok ? '✅' : '❌'} ${msg}`)
}

/** #rrggbb → "rgb(r, g, b)"，好和 getComputedStyle 的输出直接比 */
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return hex.trim()
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`
}

/**
 * 后端离线时的兜底：直接拿磁盘上的工程文件把 `/api/**` 顶起来。
 *
 * 存在的理由很实际 —— 后端归主会话所有、且此刻正被别的改动带着重启，
 * 而本次验收要断言的东西（配色 token、按钮数量、空格独占、波形绘制）
 * 全都只依赖前端。不该因为后端在重装依赖就验不了前端。
 * 工程文件本身就是 API 的 DTO 形状，所以原样吐回去即可。
 */
const PROJ_DIR = `${homedir()}/.karaoke-video-maker/projects`
/** 由真实伴奏转出来的小体积代餐，见下方 media 分支的说明 */
const PROBE_WAV = '/tmp/kvm-align-probe.wav'
const loadProjects = () =>
  readdirSync(PROJ_DIR)
    .filter((f) => f.endsWith('.kvm.json'))
    .map((f) => ({ file: `${PROJ_DIR}/${f}`, data: JSON.parse(readFileSync(`${PROJ_DIR}/${f}`, 'utf8')) }))
    // 词轨有内容的排前面：验收要看的就是逐字轴
    .sort((a, b) => b.data.lines.length - a.data.lines.length)

async function installStubs(page) {
  const projects = loadProjects()
  const byId = new Map(projects.map((p) => [p.data.id, p]))
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  // 用谓词而不是 '**/api/**' 通配：后者会连 /src/api/client.ts 一起截走，
  // 于是模块脚本被当成 JSON 返回，整个应用直接白屏
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\/api/, '')
      let m

      if (p === '/projects/' || p === '/projects') {
        return json(
          route,
          projects.map(({ file, data }) => ({
            id: data.id,
            title: data.title,
            artist: data.artist,
            updated_at: statSync(file).mtimeMs / 1000,
            duration_ms: data.duration_ms,
            line_count: data.lines.length,
          })),
        )
      }
      if (/^\/projects\/([^/]+)\/history$/.test(p)) return json(route, { undo: 2, redo: 0 })
      if ((m = /^\/projects\/([^/]+)$/.exec(p))) {
        const hit = byId.get(m[1])
        if (!hit) return json(route, { detail: 'not found' }, 404)
        // 老工程文件里没有 exports / proxy_video_path 这些后加的字段，
        // 真后端会在反序列化时补默认值，桩这边也得补，否则前端读 .length 会炸
        return json(route, { exports: [], orphans: [], proxy_video_path: null, ...hit.data })
      }
      if ((m = /^\/media\/file\/([^/]+)\/([^/]+)$/.exec(p))) {
        // 视频一律 404：mkv 在 headless chromium 里本来就解不了，Preview 会按设计
        // 降级成纯音频；照实吐 80–150MB 只会把渲染进程撑爆。
        // 音频走 PROBE_WAV（真实伴奏降到 8k 单声道，全长保留）—— 波形形状是真的，
        // 内存却只有原始 54MB 的十分之一。route.fulfill 要把整个文件塞过 CDP，
        // 直接吐原文件会连着两次解码把页面搞崩。
        if (m[2] === 'video') return route.fulfill({ status: 404, body: '' })
        return route.fulfill({ path: PROBE_WAV, contentType: 'audio/wav' })
      }
      if (/^\/media\/proxy\//.test(p)) return json(route, { ready: false, path: null, job: null })
      if (p === '/render/ass') return json(route, { ass: '[Script Info]\n', event_count: 0 })
      if (/^\/fonts/.test(p)) return json(route, [])
      return json(route, {})
    },
  )
}

const backendUp = await fetch('http://127.0.0.1:8000/api/projects/', {
  signal: AbortSignal.timeout(4000),
})
  .then((r) => r.ok)
  .catch(() => false)
console.log(backendUp ? '后端在线，走真实 API' : '⚠ 后端离线，用磁盘上的工程文件桩住 /api/**')

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
const page = await ctx.newPage()
if (!backendUp) await installStubs(page)
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` })

console.log('=== 1. 打开一个带逐字轴的工程，切到「对轴」 ===')
// 不用 networkidle：dev server 的 HMR websocket 长连接会让它永远等不到空闲
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.home', { timeout: 15000 })
await page.waitForTimeout(1200)

const cardCount = await page.locator('.pcard:not(.pcard--new)').count()
console.log(`   首页工程卡片 ${cardCount} 张`)
if (!cardCount) {
  console.log('   ❌ 首页没有工程卡片 —— 后端没起来或没有工程，无法继续验收')
  errors.slice(0, 6).forEach((e) => console.log(`      ⚠ ${e.slice(0, 300)}`))
  await shot('00-no-project')
  await browser.close()
  process.exit(1)
}
let opened = null
for (let i = 0; i < cardCount; i++) {
  await page.locator('.pcard:not(.pcard--new)').nth(i).click()
  await page.waitForSelector('.topbar', { timeout: 15000 })
  // 步骤条第 3 项 = 对轴
  await page.locator('.stepbar .step').nth(2).click()
  await page.waitForTimeout(3500)
  // 词轨只画**当前行**（一首歌几百个音节全实例化会卡死）。整曲铺满时每条行轨
  // 只有几个像素宽，点不准；改成点波形定位播放头 —— 播放头所在的行就是当前行。
  // 落点可能砸在间奏里，所以多试几处。
  const lines = await page.locator('.kvm-tl-line').count()
  const box = await page.locator('[data-role="wave-host"]').boundingBox()
  let toks = 0
  for (const f of [0.25, 0.35, 0.45, 0.55, 0.15]) {
    if (!box) break
    await page.mouse.click(box.x + box.width * f, box.y + box.height * 0.55)
    await page.waitForTimeout(700)
    toks = await page.locator('.kvm-tl-tok').count()
    if (toks > 0) break
  }
  const title = await page.locator('.topbar__project-name').innerText()
  console.log(`   卡片 ${i + 1}/${cardCount}「${title}」行轨 ${lines} 条、词轨 token ${toks} 个`)
  if (toks > 0) {
    opened = title
    break
  }
  await page.locator('.topbar__project').click()
  await page.waitForSelector('.home', { timeout: 10000 })
  await page.waitForTimeout(800)
}
check(!!opened, `进入对轴舞台（工程「${opened}」）`)
await page.waitForTimeout(2000)
await shot('01-align')

console.log('\n=== 2. 波形 canvas（穿透 shadow root）===')
// 等解码完成再量：50MB WAV 解出来要好几秒，早一步量到的是 0 张 canvas
const countCanvas = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('*')]
        .filter((el) => el.shadowRoot)
        .reduce((n, h) => n + h.shadowRoot.querySelectorAll('canvas').length, 0),
  )
for (let i = 0; i < 40 && (await countCanvas()) === 0; i++) await page.waitForTimeout(1000)

const wave = await page.evaluate(() => {
  const hosts = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot)
  const out = []
  for (const h of hosts) {
    for (const c of h.shadowRoot.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect()
      let ink = 0
      try {
        const g = c.getContext('2d')
        const d = g.getImageData(0, 0, Math.min(c.width, 400), c.height).data
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++
      } catch (e) {
        ink = -1
      }
      out.push({ w: Math.round(r.width), h: Math.round(r.height), ink })
    }
  }
  return { hosts: hosts.length, canvases: out }
})
console.log(`   shadow host ${wave.hosts} 个，canvas ${wave.canvases.length} 张`)
wave.canvases.slice(0, 4).forEach((c, i) =>
  console.log(`     canvas${i}: ${c.w}×${c.h}px 非透明像素 ${c.ink}`),
)
check(wave.canvases.length > 0, '波形 canvas 存在于 shadow root 内')
check(
  wave.canvases.some((c) => c.w > 100 && c.h > 10 && c.ink > 100),
  '波形已实际绘制（存在大量非透明像素）',
)

console.log('\n=== 3. 四种时间来源 = --src-* 四个 token，互不相同 ===')
const src = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement)
  const legend = {}
  for (const el of document.querySelectorAll('span[data-source]')) {
    legend[el.getAttribute('data-source')] = getComputedStyle(el).borderTopColor
  }
  return {
    legend,
    tokens: {
      provider: root.getPropertyValue('--src-provider'),
      aligned: root.getPropertyValue('--src-aligned'),
      interpolated: root.getPropertyValue('--src-interp'),
      manual: root.getPropertyValue('--src-manual'),
    },
    rootBg: getComputedStyle(document.querySelector('.kvm-tl')).backgroundColor,
    panelToken: root.getPropertyValue('--bg-panel'),
  }
})
const keys = ['provider', 'aligned', 'interpolated', 'manual']
for (const k of keys) {
  const want = hexToRgb(src.tokens[k])
  const got = src.legend[k]
  check(got === want, `${k}: 计算值 ${got} === --src-${k === 'interpolated' ? 'interp' : k} ${want}`)
}
console.log(`   unset（非来源，用 --fg-3）: ${src.legend.unset}`)
check(new Set(keys.map((k) => src.legend[k])).size === 4, '四种来源色互不相同')
check(
  src.rootBg === hexToRgb(src.panelToken),
  `时间轴底色 ${src.rootBg} === --bg-panel ${hexToRgb(src.panelToken)}`,
)

console.log('\n=== 4. 全页面只剩一个播放按钮 ===')
const transport = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  const hit = btns.filter((b) => {
    const txt = (b.innerText || '').trim()
    const aria = b.getAttribute('aria-label') || ''
    return /^(播放|暂停)$/.test(txt) || /^(播放|暂停)$/.test(aria)
  })
  // 图标形态的播放/暂停也要一并数进来，否则换成 Ant 图标后这条断言会失效
  const icons = document.querySelectorAll(
    'button .anticon-caret-right, button .anticon-play-circle, button .anticon-pause',
  )
  return {
    texts: hit.map((b) => (b.innerText || b.getAttribute('aria-label')).trim()),
    icons: icons.length,
  }
})
console.log(`   文字型 ${JSON.stringify(transport.texts)}，图标型 ${transport.icons} 个`)
check(transport.texts.length + transport.icons === 1, '播放/暂停按钮全页面共 1 个')

console.log('\n=== 5. tap-to-time 入口 ===')
const tapBtn = page.locator('.kvm-tl button[data-role="tap"]')
check((await tapBtn.count()) === 1 && (await tapBtn.isVisible()), 'tap-to-time 按钮在工具条上可见')
console.log(`   按钮文案：「${(await tapBtn.innerText()).trim()}」`)
console.log(`   带图标：${(await tapBtn.locator('.anticon').count()) === 1 ? '是' : '否'}`)

console.log('\n=== 6. 空格键：按一次只触发一次（历史 bug 回归）===')
// 原理：Timeline 用 stopImmediatePropagation() 掐断同一事件上后续的 window 监听器
// （App.tsx 的「空格 = 播放/暂停」就在其中）。这里在页面加载完之后再挂一个探针 —— 它
// 必然排在 Timeline 与 App 之后，所以：
//   探针收到 0 次  → Timeline 排在最前且成功掐断 = 独占完好
//   探针收到 1 次  → 掐断失效，App 那个监听器同样会跑 → 一次按键触发两次
await page.evaluate(() => {
  window.__spaceLeak = 0
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') window.__spaceLeak++
  })
})
const transportBtn = page.locator('button').filter({ hasText: /^(播放|暂停)$/ }).first()
const label = async () => (await transportBtn.innerText()).trim()

// 先把播放真正跑起来再测：音频是 50MB WAV，解码完成前按播放会被 Preview 拒掉并
// 立刻回落成暂停 —— 那不是"空格没生效"，会把这条断言变成偶发假阳性。
let warm = 0
while ((await label()) === '播放' && warm++ < 12) {
  await transportBtn.click()
  await page.waitForTimeout(1000)
}
console.log(`   预热 ${warm} 次后走带按钮：${await label()}`)
// 焦点必须从按钮上挪开：原生 button 会把空格当成"激活自己"，否则测的是按钮不是快捷键
await page.locator('.kvm-tl').click({ position: { x: 3, y: 3 } })
await page.waitForTimeout(400)
await page.evaluate(() => {
  window.__spaceLeak = 0
})

const before = await label()
await page.keyboard.press('Space')
await page.waitForTimeout(900)
const after1 = await label()
const leak1 = await page.evaluate(() => window.__spaceLeak)
await page.keyboard.press('Space')
await page.waitForTimeout(900)
const after2 = await label()
const leak2 = await page.evaluate(() => window.__spaceLeak)

console.log(`   走带按钮：${before} → 空格 → ${after1} → 空格 → ${after2}`)
console.log(`   探针收到的空格事件：第一次后 ${leak1}，第二次后 ${leak2}`)
check(leak2 === 0, 'stopImmediatePropagation 完好：后续 window 监听器一个都没跑到')
check(before !== after1 && after1 !== after2, '每按一次空格，播放状态恰好翻转一次')
await shot('02-space')

console.log('\n=== 7. 打轴模式：空格只打点，不顺手把播放掐掉 ===')
// 这才是历史 bug 的原始形态：两个监听器都跑的话，每打一个点就会顺手 setPlaying(false)，
// playheadMs 随之冻住，后面几个点全落在同一时刻。
await tapBtn.click()
await page.waitForTimeout(800)
console.log(`   打轴面板字块 ${await page.locator('.kvm-tl-chip').count()} 个`)
check((await page.locator('.kvm-tl-chip').count()) > 0, '打轴面板已展开')
await page.locator('.kvm-tl').click({ position: { x: 3, y: 3 } })
await page.waitForTimeout(300)

const tapped = async () => {
  const m = /已打\s*(\d+)\s*字/.exec(await page.locator('.kvm-tl').innerText())
  return m ? Number(m[1]) : -1
}
const playBefore = await label()
const n0 = await tapped()
await page.keyboard.press('Space')
await page.waitForTimeout(500)
const n1 = await tapped()
await page.keyboard.press('Space')
await page.waitForTimeout(500)
const n2 = await tapped()
const playAfter = await label()
console.log(`   已打字数：${n0} → ${n1} → ${n2}；走带 ${playBefore} → ${playAfter}`)
check(n1 === n0 + 1 && n2 === n1 + 1, '每按一次空格恰好打一个点')
check(playBefore === playAfter, '打点没有把播放状态带翻（历史 bug 的原始表现）')
await shot('03-tap')
// 退出打轴会把草稿落库 —— 验收不该改用户的工程。先用退格把这两个点撤回去，
// 草稿清空后退出就什么都不发。
await page.keyboard.press('Backspace')
await page.waitForTimeout(300)
await page.keyboard.press('Backspace')
await page.waitForTimeout(300)
const nBack = await tapped()
console.log(`   退格回滚后已打字数：${nBack}`)
check(nBack === 0, '打轴草稿已回滚，工程未被验收脚本改动')
await page.keyboard.press('Escape')
await page.waitForTimeout(1500)

console.log('\n=== 8. 控制台 ===')
if (errors.length) errors.slice(0, 10).forEach((e) => console.log(`   ⚠ ${e.slice(0, 200)}`))
check(errors.length === 0, `无 JS 报错（实际 ${errors.length} 条）`)

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项未通过`}　截图：${OUT}`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
