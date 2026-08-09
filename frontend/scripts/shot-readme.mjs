/**
 * README 截图：一条命令重跑全部图。
 *
 *     node frontend/scripts/shot-readme.mjs            # 全部
 *     node frontend/scripts/shot-readme.mjs --probe    # 只打印 DOM 结构，不写图
 *     node frontend/scripts/shot-readme.mjs home,style # 只重截其中几张
 *
 * 前置：后端（127.0.0.1:8000）与前端（localhost:5173）都已在跑。本脚本**不负责**
 * 起服务，也不会去关它们——开发时它们通常由别的终端持有。
 *
 * 产物固定写到 docs/images/，三份 README 共用同一批文件名。改了界面就重跑一次，
 * 不要手工截图往里塞：手工图没人记得是哪个版本截的。
 *
 * ## 为什么只用 chromium
 *
 * 文档图要的是**可重复**，不是覆盖面：同一个引擎、同一个视口、同一个工程，跑两次
 * 得到同一批图，界面改了才看得出差别。跨引擎验证是 verify-* 那几个脚本的事，
 * 与截图无关。
 *
 * 预览用 JASSUB（libass 的 WASM 版）在 worker 里跑，与导出用的 ffmpeg/libass 吃的是
 * 同一份 ASS——所以浏览器里截到的字幕就是成片里的字幕，这正是文档该展示的那一份。
 *
 * ## 隐私
 *
 * 界面里可能出现本机绝对路径（`/Users/<用户名>/…`）。截图前统一扫一遍页面文本，
 * 命中就把该元素抹掉并在控制台报出来——README 是要给陌生人看的。
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { chromium } from 'playwright'

const execFileP = promisify(execFile)

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(REPO, 'docs/images')
const FRONTEND = 'http://localhost:5173/'
const BACKEND = 'http://127.0.0.1:8000'

/** 截图视口。1600×1000 是编辑器实际可用的最小体面尺寸，再小时间轴就挤了。 */
const VIEWPORT = { width: 1600, height: 1000 }

/**
 * 拿来当样例的工程：**挑数据最全的那个**。
 *
 * 配色和成片记录不全的工程，样式页和导出页会截出一片空，读者会以为功能不存在。
 * 所以按「配色数 + 成片数 + 行数」排个序自动挑，而不是把 id 写死——写死的 id
 * 换台机器就失效，而这个脚本的全部意义就是随时能重跑。
 */
async function pickProject() {
  const list = await fetch(`${BACKEND}/api/projects/`).then((r) => r.json())
  const detailed = await Promise.all(
    list.map(async (s) => {
      const p = await fetch(`${BACKEND}/api/projects/${s.id}`).then((r) => r.json())
      return {
        id: p.id,
        title: p.title,
        score:
          Object.keys(p.palettes ?? {}).length * 100 +
          (p.exports?.length ?? 0) * 50 +
          (p.lines?.length ?? 0) +
          (p.instrumental_path ? 30 : 0) +
          (p.proxy_video_path ? 30 : 0),
      }
    }),
  )
  detailed.sort((a, b) => b.score - a.score)
  return detailed[0]
}

/**
 * 首页上的草稿工程（`aaaa` / 未命名 / 各种验证用的临时工程）在文档图里纯属噪声。
 * 这里只是**视觉上藏掉**，不删任何数据——别的 agent 可能正靠这些工程干活。
 */
const SCRATCH = /^\s*$|^(aaa+|test|tmp|临时|未命名)|验证/i

const shown = (t) => !SCRATCH.test(t ?? '')

/** 扫出页面上疑似本机绝对路径的元素，抹掉并报警。 */
async function scrubPrivatePaths(page) {
  return page.evaluate(() => {
    const pat = /\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|C:\\Users\\[^\\\s]+\\/
    const hits = []
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const bad = []
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (pat.test(n.nodeValue ?? '')) bad.push(n)
    }
    for (const n of bad) {
      hits.push((n.nodeValue ?? '').trim().slice(0, 80))
      n.nodeValue = '…'
    }
    // input/textarea 的值不在文本节点里
    for (const el of document.querySelectorAll('input, textarea')) {
      if (pat.test(el.value ?? '')) {
        hits.push(`[input] ${el.value.slice(0, 80)}`)
        el.value = '…'
      }
      if (pat.test(el.getAttribute('title') ?? '')) el.setAttribute('title', '')
    }
    return hits
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 落图 + 压缩。pngquant 把界面截图压到原来的 1/4 左右，肉眼看不出差别。 */
async function save(target, name, opts = undefined) {
  const path = join(OUT, `${name}.png`)
  await target.screenshot({ path, ...opts })
  await squeeze(path)
  console.log(`   ✅ ${name}.png  ${(statSync(path).size / 1024).toFixed(0)} KB`)
}

async function squeeze(path) {
  try {
    await execFileP('pngquant', ['--quality', '55-88', '--speed', '1', '--force', '--ext', '.png', path])
  } catch {
    console.warn(`   ⚠️  pngquant 不可用，${path} 未压缩（brew install pngquant）`)
  }
}

/* ------------------------------------------------------------------ 界面截图 */

async function shootUI(only) {
  const proj = await pickProject()
  console.log(`样例工程：${proj.title}（${proj.id}）`)

  const browser = await chromium.launch()
  // 外壳是无条件深色，但个别面板的内联 CSS 只在 prefers-color-scheme:dark 下才切深色。
  // headless 默认 light，不设这一项会截出深浅混杂的图。
  const ctx = await browser.newContext({ ...{ viewport: VIEWPORT }, colorScheme: 'dark', deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(FRONTEND, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForSelector('.home', { timeout: 20000 })
  await sleep(2500) // 首页要为每张卡片拉一次工程详情才能画进度条

  if (!only || only.has('home')) {
    console.log('\n=== 首页 ===')
    const titles = await page.locator('.pcard:not(.pcard--new) .pcard__title').allInnerTexts()
    await page.evaluate((keep) => {
      document.querySelectorAll('.pcard:not(.pcard--new)').forEach((el) => {
        const t = el.querySelector('.pcard__title')?.textContent ?? ''
        if (!keep.includes(t.trim())) el.style.display = 'none'
      })
      // 藏了卡片，标题旁的计数也得跟着改，否则图上写着 6 个却只看得到 2 个。
      const count = document.querySelector('.home__count')
      if (count) count.textContent = count.textContent.replace(/\d+/, String(keep.length))
    }, titles.filter(shown).map((t) => t.trim()))
    console.log(`   卡片 ${titles.length} 张，文档图里保留 ${titles.filter(shown).length} 张`)
    await scrubPrivatePaths(page)
    // 首页内容只占屏幕上面一条，整屏截会拖一大片死黑。按实际内容裁。
    const box = await page.evaluate(() => {
      const g = document.querySelector('.home__grid')?.getBoundingClientRect()
      const h = document.querySelector('.home__head')?.getBoundingClientRect()
      if (!g || !h) return null
      return { x: 0, y: 0, width: Math.ceil(g.right + h.left), height: Math.ceil(g.bottom + h.top) }
    })
    await save(page, 'editor-home', box ? { clip: box } : undefined)
  }

  // 进入样例工程
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.home', { timeout: 20000 })
  await sleep(2000)
  await page.locator('.pcard', { hasText: proj.title }).first().click()
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await sleep(2500)

  const steps = await page.locator('.stepbar .step').allInnerTexts()
  console.log(`\n步骤条（${steps.length} 步）：${steps.map((s) => s.trim()).join(' / ')}`)

  const goStep = async (i, waitMs) => {
    await page.locator('.stepbar .step').nth(i).click()
    await sleep(waitMs)
  }

  const shots = [
    { idx: 0, name: 'step-media', wait: 6000 },
    { idx: 1, name: 'step-lyrics', wait: 4000 },
    { idx: 2, name: 'editor-timing', wait: 9000 },
    { idx: 3, name: 'step-style', wait: 9000 },
    { idx: 4, name: 'step-export', wait: 8000 },
  ]

  for (const s of shots) {
    if (only && !only.has(s.name)) continue
    console.log(`\n=== ${steps[s.idx]?.trim() ?? s.idx} ===`)
    await goStep(s.idx, s.wait)

    // 歌词步：工程已经有歌词时进来看到的是正文，而这一步真正值得展示的是**怎么找到歌词**。
    // 切回选源面板并真的搜一次。搜索走网络，失败就照现状截——文档图不该卡在联网上。
    if (s.name === 'step-lyrics') {
      const change = page.locator('button', { hasText: '换歌词' }).first()
      if (await change.count()) {
        await change.click()
        await sleep(1200)
      }
      const go = page.locator('button', { hasText: /^搜索$/ }).first()
      if (await go.count()) {
        await go.click()
        await page
          .locator('.lyr-cand, .lyrcand, [class*="cand"]')
          .first()
          .waitFor({ timeout: 25000 })
          .catch(() => console.warn('   ⚠️  搜索没返回候选（网络？），按现状截图'))
        await sleep(1500)
      }
    }

    const hits = await scrubPrivatePaths(page)
    if (hits.length) console.log(`   🔒 抹掉 ${hits.length} 处本机路径：${hits[0]}`)
    await save(page, s.name)

    // 「编辑」这一步同屏既有时间轴又有注音。整屏图（editor-timing）已经把时间轴讲清楚了，
    // 再来一张整屏只会是重复；所以这里选中一个**带注音的**词，只截歌词纸那一块——
    // 读音来源配色、逐字区间、待检查计数在那里才看得清。
    if (s.name === 'editor-timing' && (!only || only.has('editor-ruby'))) {
      const unit = page.locator('.kvm-ruby__unit:has(rt)').first()
      if (await unit.count()) {
        // 滚过去就够了，**不要点**：点一下会弹出行内读音输入框，盖住旁边的歌词。
        await unit.scrollIntoViewIfNeeded()
        await sleep(2500)
        await scrubPrivatePaths(page)
        await save(page.locator('.kvm-ruby__canvas'), 'editor-ruby')
      } else {
        console.warn('   ⚠️  没找到带注音的词，editor-ruby 跳过')
      }
    }
  }

  if (errors.length) console.warn(`\n⚠️  页面报错 ${errors.length} 条：${errors.slice(0, 3).join(' | ')}`)
  await browser.close()
}

/* ------------------------------------------------------- 成片画面（不经浏览器） */

/**
 * 成片截帧。这是这个工具的**产出**，README 里最该出现的东西，所以哪怕它依赖
 * 本机 workspace 里的素材（`workspace/` 是 gitignore 的），也值得单独走一条路。
 *
 * 素材不在时**跳过而不是报错**：别人克隆下来跑这个脚本，界面图照样应该能重截。
 */
async function shootRender(only) {
  const video = join(REPO, 'workspace/media/HCC-0sr_-lo.mkv')
  const ass = join(REPO, 'workspace/out/readme_shots.ass')
  if (!existsSync(video) || !existsSync(ass)) {
    console.log('\n=== 成片画面 ===\n   ⏭  跳过：workspace 里没有素材/ASS。')
    console.log('   先跑一次 backend/kvm/pipeline/make_video.py --ass-only 生成 ASS（见 README）。')
    return
  }
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) {
    console.log('\n=== 成片画面 ===\n   ⏭  跳过：找不到带 ass 滤镜的 ffmpeg。')
    return
  }
  console.log(`\n=== 成片画面 ===\n   ffmpeg: ${ffmpeg}`)

  // 挑的两帧各有分工：
  //   hero    走字进行中——已唱蓝、未唱白、汉字上带振り仮名、下一句已在右下等着
  //   countdown 间奏结束前的开唱引导点，三点踩在鼓点上自右向左熄灭
  const frames = [
    { name: 'hero-render', at: '215.6' },
    { name: 'render-countdown', at: '33.75' },
  ]
  for (const f of frames) {
    if (only && !only.has(f.name)) continue
    const out = join(OUT, `${f.name}.png`)
    // -copyts + 输入 seek：字幕时间是绝对的，不保留原始时间戳就会整体错位。
    await execFileP(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-copyts', '-ss', f.at, '-i', video,
      '-vf', `ass=${ass},scale=1400:-2`,
      '-frames:v', '1', '-y', out,
    ])
    await squeeze(out)
    console.log(`   ✅ ${f.name}.png  ${(statSync(out).size / 1024).toFixed(0)} KB  @${f.at}s`)
  }
}

/** 找一个**真的带 ass 滤镜**的 ffmpeg——版本号说明不了问题，Homebrew 主线就不带。 */
function findFfmpeg() {
  const cands = [
    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
    '/usr/local/opt/ffmpeg-full/bin/ffmpeg',
    'ffmpeg',
  ]
  for (const c of cands) {
    try {
      const out = execFileSync(c, ['-hide_banner', '-h', 'filter=ass'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (!/Unknown filter/.test(out)) return c
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/* ------------------------------------------------------------------------ 主 */

mkdirSync(OUT, { recursive: true })
const arg = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(',')
const only = arg ? new Set(arg.split(',').map((s) => s.trim())) : null

await shootUI(only)
await shootRender(only)

console.log('\n=== docs/images ===')
let total = 0
for (const f of readdirSync(OUT).sort()) {
  const s = statSync(join(OUT, f)).size
  total += s
  console.log(`   ${f.padEnd(26)} ${(s / 1024).toFixed(0).padStart(5)} KB`)
}
console.log(`   ${'合计'.padEnd(24)} ${(total / 1024).toFixed(0).padStart(5)} KB`)
