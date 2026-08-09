// 预览区「素材未就绪 vs 真降级」状态划分的验收。
//
// 用法：node scripts/ui-preview-state.mjs [chromium|webkit]
//
// 断言的都是**用户真的会看到的字**，不是分支是否存在：
//   1. 只有歌词、没有任何素材的工程 → 画面区说"还没有素材"，且**一条警告都没有**
//      （历史 bug：此时会弹「正在使用视频自带音轨」，而根本没有视频可退）
//   2. 只有音轨的工程 → 说"只有音轨，没有画面"，同样不报警告（这是正常起点）
//   3. 素材齐全的工程 → 画面区没有任何遮罩文案，波形不报「音频加载失败」
//      （历史 bug：进编辑步骤时音源默认切到伴奏会中断首次加载，被误报成失败）
//
// 每次都从**冷启动**进入编辑步骤：竞态只在首次出现，先在应用里来回切几次再测会假通过。

import { chromium, webkit } from 'playwright'

const ENGINE = process.argv[2] ?? 'chromium'
const launcher = ENGINE === 'webkit' ? webkit : chromium

let failed = 0
const check = (ok, msg, extra = '') => {
  if (!ok) failed++
  console.log(`   ${ok ? '✅' : '❌'} ${msg}${extra ? ` — ${extra}` : ''}`)
}

const browser = await launcher.launch()

/** 冷启动打开某个工程的编辑步骤，采样这段时间里出现过的全部提示文字 */
async function visit(projectId, seconds = 8) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript((id) => localStorage.setItem(`kvm.step.${id}`, 'edit'), projectId)
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  // 按列表顺序点卡片，不按标题：工程标题可能为空（首页显示"未命名"），
  // 用 hasText:'' 会匹配到全部卡片，first() 于是打开了别的工程 —— 假通过的经典来源
  // 注意排除 `.pcard--new`（"新建工程"那张），它也挂着 .pcard，算进去会整体错位一格
  const list = await page.evaluate(() => fetch('/api/projects/').then((r) => r.json()))
  const cards = page.locator('.pcard:not(.pcard--new)')
  await cards.first().waitFor({ timeout: 20000 })
  await cards.nth(list.findIndex((s) => s.id === projectId)).click()
  await page.waitForSelector('.home', { state: 'detached', timeout: 20000 })

  const seen = new Set()
  for (let i = 0; i < seconds * 2; i++) {
    const snap = await page.evaluate(() => {
      // 扫叶子元素而不是某一类容器：提示分散在预览区遮罩、警告列表、时间轴状态条里
      const leaves = [...document.querySelectorAll('body *')].filter(
        (el) =>
          el.children.length === 0 &&
          el.textContent?.trim() &&
          !['STYLE', 'SCRIPT', 'TITLE'].includes(el.tagName),
      )
      return leaves
        .map((el) => el.textContent.trim())
        .filter((s) =>
          /加载失败|不可用|失败|Web Audio|自带音轨|跨源|还没有素材|只有音轨|正在下载|放不了|正在准备|正在生成|降级|「素材」步骤|任务栏|media\.player/.test(
            s,
          ),
        )
    })
    for (const s of snap) seen.add(s)
    await page.waitForTimeout(500)
  }
  await page.screenshot({ path: `/tmp/ui-preview-${ENGINE}-${projectId}.png` })
  await ctx.close()
  return { seen: [...seen], errors }
}

const list = await fetch('http://127.0.0.1:8000/api/projects/').then((r) => r.json())
const detail = async (id) => fetch(`http://127.0.0.1:8000/api/projects/${id}`).then((r) => r.json())

const all = await Promise.all(list.map((s) => detail(s.id)))
/** 该工程此刻有没有素材任务在跑——挑用例时必须排除掉，否则"没素材"和"正在下载"会混起来 */
const idle = async (id) =>
  fetch(`http://127.0.0.1:8000/api/media/activity/${id}`)
    .then((r) => r.json())
    .then((jobs) => jobs.length === 0)
const bareCandidates = all.filter((p) => !p.video_path && !p.audio_path && p.lines.length)
const bareFlags = await Promise.all(bareCandidates.map((p) => idle(p.id)))
const bare = bareCandidates.find((_, i) => bareFlags[i])
const audioOnly = all.find((p) => !p.video_path && p.audio_path)
const full = all.find((p) => p.video_path && p.audio_path && p.instrumental_path)

console.log(`引擎 ${ENGINE}`)

console.log('\n=== 1. 只有歌词、没有素材（用户报告的那个状态）===')
if (!bare) {
  console.log('   ⚠️ 找不到这样的工程，跳过')
} else {
  const { seen, errors } = await visit(bare.id)
  console.log('   看到的提示：', JSON.stringify(seen))
  check(
    seen.some((s) => s.includes('还没有素材')),
    '画面区说"还没有素材"',
  )
  check(
    !seen.some((s) => /自带音轨|降级/.test(s)),
    '没有"已改用视频自带音轨"这类自相矛盾的降级提示',
  )
  check(
    !seen.some((s) => /失败|不可用/.test(s)),
    '没有任何失败/不可用提示',
    seen.filter((s) => /失败|不可用/.test(s)).join(' / '),
  )
  check(errors.length === 0, '无未捕获异常', errors.join(' | '))
}

console.log('\n=== 2. 只有音轨（"先只有音轨、边听边打轴"，正常起点）===')
if (!audioOnly) {
  console.log('   ⚠️ 找不到这样的工程，跳过')
} else {
  const { seen } = await visit(audioOnly.id)
  console.log('   看到的提示：', JSON.stringify(seen))
  check(
    seen.some((s) => s.includes('只有音轨')),
    '画面区说"只有音轨，没有画面"',
  )
  check(!seen.some((s) => /自带音轨|降级/.test(s)), '不报降级')
}

console.log('\n=== 3. 素材齐全（回归：波形首次加载不应报失败）===')
if (!full) {
  console.log('   ⚠️ 找不到这样的工程，跳过')
} else {
  const { seen, errors } = await visit(full.id, 10)
  console.log('   看到的提示：', JSON.stringify(seen))
  check(
    !seen.some((s) => s.includes('音频加载失败')),
    '波形没有报"音频加载失败"',
    seen.filter((s) => s.includes('音频加载失败')).join(' / '),
  )
  check(!seen.some((s) => s.includes('还没有素材')), '画面区没有"还没有素材"')
  check(errors.length === 0, '无未捕获异常', errors.join(' | '))
}

await browser.close()
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
