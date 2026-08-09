// 「真的降级了」两种状态的验收：这两条**必须保留**，不能被这次的状态划分吞掉。
//
// 用法：node scripts/ui-preview-degraded.mjs [chromium|webkit]
//
//   A. 有视频、Web Audio 拿不到音轨 → 声音退回 <video> 自带音轨，报「正在使用视频自带音轨」
//   B. 有视频、这个浏览器放不了（WebKit + MKV/AV1，且没有编辑代理）→ 报「已降级为纯音频预览」
//
// 这两种状态在本机的工程数据上造不出来（下载/导入都会顺手抽出音频并生成代理），
// 所以改用**改写工程响应**的办法构造：只动 `audio_path` / `proxy_video_path` 两个字段，
// 组件里被测的判断逻辑与真实情况完全一致。B 只在 WebKit 上成立，Chromium 放得了 MKV。

import { chromium, webkit } from 'playwright'

const ENGINE = process.argv[2] ?? 'chromium'
const launcher = ENGINE === 'webkit' ? webkit : chromium

let failed = 0
const check = (ok, msg, extra = '') => {
  if (!ok) failed++
  console.log(`   ${ok ? '✅' : '❌'} ${msg}${extra ? ` — ${extra}` : ''}`)
}

const list = await fetch('http://127.0.0.1:8000/api/projects/').then((r) => r.json())
const all = await Promise.all(
  list.map((s) => fetch(`http://127.0.0.1:8000/api/projects/${s.id}`).then((r) => r.json())),
)
const full = all.find((p) => p.video_path && p.audio_path && p.proxy_video_path)
if (!full) throw new Error('找不到素材齐全的工程，无法构造降级状态')

const browser = await launcher.launch()

async function visit(patch, seconds = 9) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  // 只改目标工程的详情响应；列表接口（结尾是 /projects/）不能碰，否则首页空掉
  await page.route(
    (url) => /\/api\/projects\/[0-9a-f]{8,}$/.test(url.pathname),
    async (route) => {
      const resp = await route.fetch()
      const body = await resp.json()
      route.fulfill({ json: body.id === full.id ? { ...body, ...patch } : body })
    },
  )

  await page.addInitScript((id) => localStorage.setItem(`kvm.step.${id}`, 'edit'), full.id)
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  const summaries = await page.evaluate(() => fetch('/api/projects/').then((r) => r.json()))
  const cards = page.locator('.pcard:not(.pcard--new)')
  await cards.first().waitFor({ timeout: 20000 })
  await cards.nth(summaries.findIndex((s) => s.id === full.id)).click()
  await page.waitForSelector('.home', { state: 'detached', timeout: 20000 })

  const seen = new Set()
  for (let i = 0; i < seconds * 2; i++) {
    const texts = await page.evaluate(() => {
      const leaves = [...document.querySelectorAll('body *')].filter(
        (el) =>
          el.children.length === 0 &&
          el.textContent?.trim() &&
          !['STYLE', 'SCRIPT', 'TITLE'].includes(el.tagName),
      )
      return leaves
        .map((el) => el.textContent.trim())
        .filter((s) => /自带音轨|降级|还没有素材|只有音轨|放不了|没有可播放|加载失败|不可用|编辑代理/.test(s))
    })
    for (const s of texts) seen.add(s)
    await page.waitForTimeout(500)
  }
  await page.screenshot({ path: `/tmp/ui-preview-degraded-${ENGINE}-${Object.keys(patch).join('-')}.png` })
  await ctx.close()
  return { seen: [...seen], errors }
}

console.log(`引擎 ${ENGINE}`)

console.log('\n=== A. 有视频，Web Audio 没有可用音轨 ===')
{
  const { seen, errors } = await visit({ audio_path: null, instrumental_path: null, vocals_path: null })
  console.log('   看到的提示：', JSON.stringify(seen))
  check(seen.some((s) => s.includes('正在使用视频自带音轨')), '仍然报「正在使用视频自带音轨」')
  check(!seen.some((s) => s.includes('还没有素材')), '不会误报成"还没有素材"')
  check(errors.length === 0, '无未捕获异常', errors.join(' | '))
}

console.log('\n=== B. 有视频，但这个浏览器放不了（且没有编辑代理）===')
{
  const { seen, errors } = await visit({ proxy_video_path: null })
  console.log('   看到的提示：', JSON.stringify(seen))
  if (ENGINE === 'webkit') {
    check(seen.some((s) => s.includes('放不了')), '报出"这个浏览器放不了当前视频"')
    check(
      seen.some((s) => s.includes('降级为纯音频预览')),
      '并说明已降级为纯音频预览',
    )
  } else {
    // Chromium 放得了 MKV/H.264，这里本来就不该降级——断言"不误报"
    check(!seen.some((s) => s.includes('放不了')), 'Chromium 能放，不误报放不了')
  }
  check(errors.length === 0, '无未捕获异常', errors.join(' | '))
}

await browser.close()
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
