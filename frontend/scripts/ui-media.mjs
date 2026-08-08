// 带真实媒体的 UI 验证：导入音频后，波形与预览是否真的渲染。
// 上一轮 canvas=0 是因为工程没有媒体（wavesurfer 无从画波形），属预期降级；
// 这一轮补上媒体，验证有音频时的真实表现。

import { chromium } from 'playwright'

const ROOT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md'
const OUT = `${ROOT}/workspace/out/ui`
const errors = []
let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label} ${extra}`)
}

const browser = await chromium.launch()
const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage())
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

console.log('=== 1. 选择已有工程（上一轮已导入 60 行歌词）===')
const sel = page.locator('select').first()
const opts = await sel.locator('option').count()
check(opts > 1, '工程下拉有历史工程', `${opts} 项`)
if (opts > 1) {
  await sel.selectOption({ index: 1 })
  await page.waitForTimeout(2500)
}
const head = await page.evaluate(() => document.body.innerText.slice(0, 120))
console.log(`   顶栏：${head.split('\n').filter(Boolean).slice(0, 4).join(' | ')}`)

console.log('\n=== 2. 导入真实音频（手工旁路）===')
await page.locator('text=① 下载').first().click()
await page.waitForTimeout(800)
const inputs = page.locator('input[type="file"]')
const nInput = await inputs.count()
check(nInput > 0, '找到本地文件导入入口', `${nInput} 个`)
let imported = false
for (let i = 0; i < nInput; i++) {
  const acc = await inputs.nth(i).getAttribute('accept')
  if (acc && acc.includes('audio')) {
    await inputs.nth(i).setInputFiles(`${ROOT}/workspace/media/audio_44k.wav`)
    imported = true
    console.log(`   用第 ${i + 1} 个入口（accept=${acc}）上传 audio_44k.wav`)
    break
  }
}
check(imported, '音频已提交')
// 导入 54MB 音频 + 服务端 ffprobe，给足时间
await page.waitForTimeout(15000)
await page.screenshot({ path: `${OUT}/20-media.png` })
const afterImport = await page.evaluate(() => document.body.innerText)
check(/audio_44k|音频|已导入|4:43|283/.test(afterImport), '界面反映音频已就绪')

console.log('\n=== 3. 时间轴波形 ===')
await page.locator('text=④ 对轴').first().click()
await page.waitForTimeout(8000)
await page.screenshot({ path: `${OUT}/21-waveform.png` })
// wavesurfer 7.x 把 canvas 放在 shadow root 里，document.querySelectorAll 查不到；
// 时间轴的覆盖层是它的兄弟节点、刻意没有 portal 进去。所以必须穿透 shadow DOM。
const tl = await page.evaluate(() => {
  const found = []
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS') found.push(`${el.width}x${el.height}`)
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)
  const t = document.body.innerText
  return { n: found.length, sizes: found.slice(0, 4), dur: t.match(/\/\s*(\d+:\d+\.\d+)/)?.[1] ?? '' }
})
check(tl.n > 0, '波形 canvas 已渲染（穿透 shadow DOM）', `${tl.n} 个 ${tl.sizes.join(', ')}`)
check(!!tl.dur && tl.dur !== '0:00.00', '播放器已识别音频时长', tl.dur)

console.log('\n=== 4. 控制台 ===')
console.log(`   ${errors.length} 条`)
errors.slice(0, 8).forEach((e) => console.log(`   ❌ ${e.slice(0, 200)}`))

await page.screenshot({ path: `${OUT}/22-final.png`, fullPage: true })
await browser.close()
console.log(`\n通过 ${pass}　失败 ${fail}　控制台错误 ${errors.length}`)
process.exit(fail ? 1 : 0)
