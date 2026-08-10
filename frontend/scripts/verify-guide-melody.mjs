/**
 * 引导声（ガイドメロディ）验收：素材页的生成/调参入口 + 导出预览真的能放出来。
 *
 *   用法：node scripts/verify-guide-melody.mjs [chromium|webkit]   不带参数则两个都跑
 *
 * 需要 dev server（5173）与后端（8000）已经在跑。
 *
 * ## 判据是怎么设计成"能区分成功与失败"的
 *
 * 这次要证明的核心命题是**"预览里真的听得到引导声"**，而这句话最容易被一个
 * 假判据糊弄过去：勾选框亮了、徽章文案变了，都不代表音频图里那一层在出声。
 * 本项目在这上面栽过（§8.9 那条教训：测量工具本身必须在实际工作点上校准），
 * 所以增益断言一律取自 **Web Audio 图里真实的 `linearRampToValueAtTime` 目标值**，
 * 并且知道每个 GainNode 挂在拉伸器的哪个**输出序号**上（靠 hook `connect` 记下来）
 * ——按钮高亮对了而增益接错，这种错只有从图里才看得出来。
 *
 * ## 阴性对照（故意弄坏）
 *
 * 用 `page.route` 把工程响应里的 `guide_audio_path` 抹成 null，模拟"还没生成过
 * 引导声"。此时**每一条断言都必须翻面**：
 *
 * - 音频图里不该有 `guide` 这一层（装了一层不存在的文件 = 白占内存又必然 404）
 * - 播放器上的「引导声」按钮必须禁用，而不是点了没反应
 * - 导出舞台的徽章必须变成「预览无引导声」，而不是继续显示「含引导声」
 *
 * 对照组全绿而正例也全绿，说明判据根本没在量东西——那一轮结论作废。
 *
 * ## 为什么调参那一段要拦网络
 *
 * 拖滑块会把参数写进工程并占一格撤销。验收脚本不该在用户的真实工程上留下副作用，
 * 所以 `POST /api/media/guide/params` 被拦下来：**请求体照样断言**（那才是要验的
 * 契约），响应用一份"参数已替换"的工程 JSON 顶上，后端一个字节都不动。
 *
 * ## 已知环境事实
 * - WebKit 下 seek 到中段再播会卡死（既有问题），本脚本一律不 seek。
 * - Vite dev 会往 worker 注入 /@vite/env，WebKit 在 require-corp 下拒绝加载，
 *   控制台噪声与本脚本结论无关。
 */

import { chromium, webkit } from 'playwright'

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
const note = (label, extra = '') => console.log(`   ·  ${label}${extra ? `  ${extra}` : ''}`)

/**
 * 装在页面上的诊断钩子：记下每个 GainNode 的增益自动化，以及拉伸器的哪个输出
 * 接到了哪个 gain。
 *
 * 两处写法是踩过坑才这么写的（与 verify-preview-mix.mjs 同源，原因也一样）：
 * `createGain` 在 WebKit 上不挂在 `BaseAudioContext.prototype`，所以打标改在
 * `connect` 里做；`gain.gain` 的包装对象会被 WebKit 回收重建，所以
 * "这个 AudioParam 属于哪个节点"必须在调用当时现场比对，不能用 WeakMap。
 * 两处都只在 WebKit 上失效——只跑 Chromium 会得到一份假绿。
 */
function initDiag() {
  const D = { worklets: [], ramps: [], gainOf: {}, gidSeq: 0 }
  window.__diag = D

  const AWN = window.AudioWorkletNode
  if (AWN) {
    window.AudioWorkletNode = class extends AWN {
      constructor(ctx, name, opts) {
        super(ctx, name, opts)
        const po = (opts && opts.processorOptions) || {}
        this.__wid = D.worklets.length
        D.worklets.push({ name, outputs: opts && opts.numberOfOutputs, layerIds: po.layerIds })
      }
    }
  }

  const tagged = []
  const tagGain = (n) => {
    if (!n || n.__gid !== undefined) return
    const p = n.gain
    if (!p || typeof p.linearRampToValueAtTime !== 'function') return
    n.__gid = D.gidSeq++
    tagged.push(n)
  }
  const gidOfParam = (param) => {
    for (const n of tagged) {
      try {
        if (n.gain === param) return n.__gid
      } catch {
        /* 节点已失效 */
      }
    }
    return undefined
  }

  const origRamp = AudioParam.prototype.linearRampToValueAtTime
  AudioParam.prototype.linearRampToValueAtTime = function (v, t) {
    const gid = gidOfParam(this)
    if (gid !== undefined) D.ramps.push({ gid, value: v })
    return origRamp.call(this, v, t)
  }

  const origConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (dest, out, inp) {
    tagGain(this)
    tagGain(dest)
    const r = out === undefined ? origConnect.call(this, dest) : origConnect.call(this, dest, out, inp)
    if (this.__wid !== undefined && dest && dest.__gid !== undefined && out !== undefined) {
      D.gainOf[out] = dest.__gid
    }
    return r
  }
}

async function openPage(browser, { projectId, title, step, project, stripGuide, onParams }) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
  await ctx.addInitScript(initDiag)
  await ctx.addInitScript(
    ([id, s]) => localStorage.setItem(`kvm.step.${id}`, s),
    [projectId, step],
  )
  const page = await ctx.newPage()

  if (stripGuide) {
    // 阴性对照：装成"还没生成过引导声"的工程
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      const resp = await route.fetch()
      const body = await resp.json()
      body.guide_audio_path = null
      body.guide_signature = ''
      await route.fulfill({ response: resp, body: JSON.stringify(body) })
    })
    await page.route(`**/api/media/guide/${projectId}`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: projectId,
          ready: false,
          stale: false,
          path: null,
          job: null,
          note: '还没有引导声',
        }),
      }),
    )
  }

  if (onParams) {
    // 拦下参数写入：请求体照样验，但不在用户的真实工程上留副作用（见文件头）。
    //
    // 光拦 POST 不够——组件写完会 `refresh()` 重拉工程，那一拉若走到真后端，
    // 拿回来的还是旧参数，界面立刻把刚拖的值弹回去。**这不是被测代码的问题，
    // 是这个假后端自己前后矛盾**，所以 GET 也要跟着一起记住最新参数。
    // （§8.9 的教训：测量工具本身必须在实际工作点上自洽，否则量到的是工具的毛病。）
    let lastParams = null
    await page.route('**/api/media/guide/params', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}')
      lastParams = body.params
      onParams(body)
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ...project, guide: body.params }),
      })
    })
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      const resp = await route.fetch()
      const body = await resp.json()
      if (lastParams) body.guide = lastParams
      await route.fulfill({ response: resp, body: JSON.stringify(body) })
    })
  }

  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('.pcard', { hasText: title }).first().click()
  return { ctx, page, errors }
}

/** 等音频引擎就绪：「原声」档由 disabled 变可用 */
const waitAudio = (page) =>
  page
    .waitForFunction(
      () => {
        const b = document.querySelector('[data-testid=mix-preset-original]')
        return !!b && !b.disabled
      },
      undefined,
      { timeout: 240000 },
    )
    .then(() => true)
    .catch(() => false)

const setRangeValue = (page, selector, value) =>
  page.evaluate(
    ([sel, v]) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, String(v))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      // 拖拽结束才写工程（组件里挂的是 pointerup），这里补一个
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      return true
    },
    [selector, value],
  )

async function runEngine(name, project) {
  const projectId = project.id
  const title = project.title
  console.log(`\n########## ${name} ##########`)
  const browser = await ENGINES[name].launch(
    name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
  )

  // ============ A. 素材页：生成入口 + 调参 + 可试听 ============
  console.log('\n=== A 素材页：引导声是一件可生成、可调参、可试听的素材 ===')
  {
    const posted = []
    const { ctx, page, errors } = await openPage(browser, {
      projectId,
      title,
      step: 'media',
      project,
      onParams: (b) => posted.push(b),
    })

    const card = page.locator('.kvm-media-guide')
    const shown = await card
      .first()
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    check(shown, '素材页上有引导声卡片')
    check(
      (await card.first().innerText()).includes('已就绪'),
      '状态如实显示（本工程已生成过）',
      (await card.first().innerText()).replace(/\s+/g, ' ').slice(0, 60),
    )

    await card.getByRole('button', { name: '调参' }).click()
    const ids = ['guide-timbre', 'guide-gain', 'guide-max_harmonics', 'guide-voicing_drop_db', 'guide-legato_gap_ms']
    const present = []
    for (const id of ids) present.push(await page.locator(`[data-testid=${id}]`).count())
    check(
      present.every((n) => n === 1),
      '暴露且只暴露五个参数',
      `${ids.map((s, i) => `${s.replace('guide-', '')}=${present[i]}`).join(' ')}`,
    )
    // 每个参数都要有一句中文说明——只给滑块和字段名，用户无从判断该往哪边拖
    const paramText = await page.locator('.kvm-guide-params').innerText()
    check(
      ['音色', '音量', '明亮度', '灵敏度', '连音'].every((w) => paramText.includes(w)),
      '五个参数各有中文名',
      paramText.replace(/\s+/g, ' ').slice(0, 40),
    )
    check(
      (paramText.match(/[，。：]/g) ?? []).length >= 5,
      '每个参数都带一句中文说明',
    )

    // 谐波数对正弦无效 → 必须禁用并说明，而不是给一个拖了没反应的滑块
    await page.selectOption('[data-testid=guide-timbre]', 'sine')
    await page.waitForTimeout(200)
    check(
      await page.locator('[data-testid=guide-max_harmonics]').isDisabled(),
      '正弦音色下「明亮度」禁用（它只有基波）',
    )
    await page.selectOption('[data-testid=guide-timbre]', 'square')
    await page.waitForTimeout(200)
    check(
      !(await page.locator('[data-testid=guide-max_harmonics]').isDisabled()),
      '换回方波后「明亮度」恢复可用',
    )

    posted.length = 0
    await setRangeValue(page, '[data-testid=guide-gain]', 0.25)
    await page.waitForTimeout(400)
    const gainPost = posted.find((p) => p.params && p.params.gain === 0.25)
    check(!!gainPost, '拖音量滑块把参数写进工程', JSON.stringify(posted.at(-1)?.params ?? null))
    check(
      gainPost && gainPost.project_id === projectId && gainPost.params.timbre === 'square',
      '写的是整组参数而不是单个字段（后端契约是 GuideParamsDTO）',
    )
    check(
      posted.filter((p) => p.params?.gain === 0.25).length === 1,
      '一次拖拽只写一次（不是每个 change 事件都写 = 几十格撤销）',
      `${posted.length} 次`,
    )

    // 可试听：引导声与人声/伴奏并列成一张音轨卡片
    const trackLabels = await page.locator('.kvm-media-track__label').allInnerTexts()
    check(trackLabels.includes('引导声'), '引导声有自己的音轨卡片', trackLabels.join('/'))
    const src = await page.evaluate(
      () => document.querySelector('audio[src*="/guide"]')?.getAttribute('src') ?? null,
    )
    check(src === `/api/media/file/${projectId}/guide`, '试听指向后端的引导声端点', String(src))
    const status = await page.evaluate(async (u) => (await fetch(u, { method: 'GET', headers: { Range: 'bytes=0-99' } })).status, src ?? '')
    check(status === 206 || status === 200, '该端点真的返回音频', `HTTP ${status}`)

    note('控制台错误', errors.length ? errors.slice(0, 2).join(' | ') : '（无）')
    await ctx.close()
  }

  // ============ B. 导出页：预览真的把引导声放出来 ============
  console.log('\n=== B 导出页：勾上「混入引导声」预览就听得到 ===')
  {
    const { ctx, page, errors } = await openPage(browser, { projectId, title, step: 'export', project })
    check(await waitAudio(page), '音频引擎就绪')

    const diag = await page.evaluate(() => ({
      worklets: window.__diag.worklets,
      gainOf: window.__diag.gainOf,
    }))
    const ts = diag.worklets.filter((w) => w.name === 'kvm-timestretch')
    const layerIds = ts[0]?.layerIds ?? []
    const guideIdx = layerIds.indexOf('guide')
    check(guideIdx >= 0, '引导声作为一层装进了音频图', JSON.stringify(layerIds))
    const guideGid = diag.gainOf[guideIdx]
    check(guideGid !== undefined, '引导声那一层有自己的 GainNode', `output#${guideIdx} → gid ${guideGid}`)

    const rampsSince = async (fn) => {
      const before = await page.evaluate(() => window.__diag.ramps.length)
      await fn()
      await page.waitForTimeout(300)
      return page.evaluate((n) => window.__diag.ramps.slice(n), before)
    }
    const target = (ramps, gid) => {
      const hit = ramps.filter((r) => r.gid === gid)
      return hit.length ? hit[hit.length - 1].value : null
    }

    const box = page.locator('.checkbox-row input[type=checkbox]').first()
    // 目标增益是 1/√2 而不是 1：引导声文件是单声道，导出时 amix 的上混矩阵会给它
    // 每声道乘 1/√2（实测差值恰好 3.01 dB，相关系数 1.0000）。预览按 1.0 播的话，
    // 用户是照着一个比成片响 3 dB 的声音在调「音量」——见 Preview.tsx 的 GUIDE_EXPORT_GAIN。
    const GUIDE_GAIN = Math.SQRT1_2
    const near = (v, want) => v !== null && Math.abs(v - want) < 1e-6
    let r = await rampsSince(() => box.check())
    check(
      near(target(r, guideGid), GUIDE_GAIN),
      '勾选「混入引导声」→ 引导声那一层的增益真的升到成片电平（看的是音频图，不是勾选框）',
      `guide=${target(r, guideGid)} 期望=${GUIDE_GAIN.toFixed(4)}`,
    )
    check(
      (await page.locator('[data-testid=export-guide-on]').count()) === 1 &&
        (await page.locator('[data-testid=export-guide-missing]').count()) === 0,
      '徽章显示「含引导声」，那句「预览不含引导声」已经撤掉',
    )
    const badgeText = await page.locator('.exp-head').innerText()
    check(!badgeText.includes('预览不含引导声'), '页面上再也找不到「预览不含引导声」', badgeText.replace(/\s+/g, ' '))

    r = await rampsSince(() => box.uncheck())
    check(target(r, guideGid) === 0, '取消勾选 → 增益降回 0', `guide=${target(r, guideGid)}`)

    // 设置与预览共用一份状态：播放器上那个「引导声」按钮按下去，勾选框跟着变
    r = await rampsSince(() => page.click('[data-testid=mix-guide-toggle]'))
    check(near(target(r, guideGid), GUIDE_GAIN), '播放器上的「引导声」按钮驱动同一层')
    check(await box.isChecked(), '导出设置跟着变（同一份状态，不是两份副本）')

    // 引导声是叠加层：切 ON/OFF VOCAL 不该把它关掉
    r = await rampsSince(() => page.click('button:has-text("OFF VOCAL")'))
    check(
      target(r, guideGid) === null || near(target(r, guideGid), GUIDE_GAIN),
      '切到 OFF VOCAL 不会顺手关掉引导声（它是叠加层，不是第四个档）',
      `guide=${target(r, guideGid)}`,
    )

    note('控制台错误', errors.length ? errors.slice(0, 2).join(' | ') : '（无）')
    await ctx.close()
  }

  // ============ C. 阴性对照：没有引导声产物时每条断言都必须翻面 ============
  console.log('\n=== C 阴性对照（故意弄坏：工程里没有引导声产物）===')
  {
    const { ctx, page, errors } = await openPage(browser, {
      projectId,
      title,
      step: 'export',
      project,
      stripGuide: true,
    })
    check(await waitAudio(page), '音频引擎仍然就绪（缺引导声不该阻断播放）')

    const layerIds = await page.evaluate(
      () => window.__diag.worklets.find((w) => w.name === 'kvm-timestretch')?.layerIds ?? [],
    )
    check(!layerIds.includes('guide'), '不装一层根本不存在的音轨', JSON.stringify(layerIds))
    check(
      await page.locator('[data-testid=mix-guide-toggle]').isDisabled(),
      '播放器上的「引导声」按钮禁用而不是点了没反应',
    )
    const tip = await page.locator('[data-testid=mix-guide-toggle]').getAttribute('title')
    check(!!tip && tip.includes('素材'), '禁用时说明去哪里生成', String(tip))

    await page.locator('.checkbox-row input[type=checkbox]').first().check()
    await page.waitForTimeout(300)
    check(
      (await page.locator('[data-testid=export-guide-missing]').count()) === 1 &&
        (await page.locator('[data-testid=export-guide-on]').count()) === 0,
      '徽章翻成「预览无引导声」',
    )

    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.locator('.pcard', { hasText: title }).first().click()
    await page.waitForTimeout(1200)

    note('控制台错误', errors.length ? errors.slice(0, 2).join(' | ') : '（无）')
    await ctx.close()
  }

  // ============ D. 阴性对照：素材页缺人声轨时禁用而不隐藏 ============
  console.log('\n=== D 阴性对照（故意弄坏：工程没有人声轨）===')
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
    await ctx.addInitScript(
      ([id, s]) => localStorage.setItem(`kvm.step.${id}`, s),
      [projectId, 'media'],
    )
    const page = await ctx.newPage()
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      const resp = await route.fetch()
      const body = await resp.json()
      body.vocals_path = null
      body.guide_audio_path = null
      await route.fulfill({ response: resp, body: JSON.stringify(body) })
    })
    await page.route(`**/api/media/guide/${projectId}`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: projectId,
          ready: false,
          stale: false,
          path: null,
          job: null,
          note: '需要先分离出人声轨才能合成引导声',
        }),
      }),
    )
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.locator('.pcard', { hasText: title }).first().click()
    const card = page.locator('.kvm-media-guide')
    const shown = await card
      .first()
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    check(shown, '卡片仍然显示（禁用而不隐藏）')
    const genBtn = card.getByRole('button', { name: /^生成$/ })
    check(await genBtn.isDisabled(), '生成按钮禁用')
    check(
      (await card.innerText()).includes('需要先分离人声'),
      '说明缺什么前提',
      (await card.innerText()).replace(/\s+/g, ' ').slice(0, 60),
    )
    check(
      (await genBtn.getAttribute('title'))?.includes('人声分离') ?? false,
      '悬浮提示给出下一步',
    )
    await ctx.close()
  }

  await browser.close()
}

const project = await (await fetch(`${API}/api/projects/cd4aed3df12e`)).json()
note('验证工程', `${project.title} / ${project.id} / guide=${project.guide_audio_path ?? '(无)'}`)
for (const name of wanted) await runEngine(name, project)

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
