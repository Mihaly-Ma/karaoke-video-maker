// 验证：**字体链在预览与成片两端选中的是同一个字体**。
//
//   用法：node scripts/verify-font-chain.mjs [chromium|webkit]
//   环境变量：KVM_APP（默认 http://localhost:5173/）、KVM_API（默认同源 /api）
//            KVM_SABOTAGE=nochain|samefont（对照组，判据必须在它们上面转红）
//
// ## 要证的是什么
//
// 字体是一条有序候选链（`style.font_names`）。链首缺哪个字形，就该落到链尾那个。
// 两端拿到字体的方式完全不同：
//
//   - 预览：JASSUB（`ASS_FONTPROVIDER_NONE`），字体由 `GET /api/fonts/subset` 逐个喂进去；
//   - 成片：ffmpeg（`ASS_FONTPROVIDER_AUTODETECT`，系统回退**无法禁用**），
//           字体 UUEncode 在 ASS 的 `[Fonts]` 段里。
//
// 两端只要有一端没照链走，同一个生僻字就会长得不一样——而这种事只有把成片放出来
// 逐字比对才看得见。"列表里能配置一条链"完全不构成证据。
//
// ## 判据：换掉链尾，那个字必须跟着变；链首的字必须**不**变
//
// 素材是 `あ𠮷`。链首 `Hiragino Kaku Gothic StdN` **真的没有** `𠮷`（U+20BB7，
// SIP 区；本机实测该族 cmap 里没有这个码位），链尾用明朝体 / 丸ゴ体各跑一次：
//
//   - `𠮷` 两次**不同** → 画它的是链尾，这一端确实照链走了；
//   - `𠮷` 两次**相同** → 画它的是别的东西（系统回退、或干脆是豆腐块），链没生效；
//   - `あ` 两次必须**相同** → 链首对自己有的字保有优先权，链序不是摆设。
//
// 链里只有一个链尾，所以"两端各自都跟着链尾变"就等于"两端用的是同一个字体"——
// 没有第二个候选能产生这种变化，系统字体更不会随我们改工程而变。
//
// ## 为什么不直接比预览截图与成片抽帧的像素
//
// 两端是两份不同的 libass 构建（JASSUB 锁的是 master，ffmpeg 用的是它自己链接的
// 那份），加上光栅尺寸、抗锯齿、hinting 都不同，逐像素相等做不到，勉强比就会
// 得到一个"差不多"的阈值——而"差不多"正好盖住了"换了个字体"这种量级的差异。
// 所以两端各自与**自己的对照**比，结论再合起来，全程不跨引擎比像素。
//
// ## 取证坑（沿用 diag-font-render.mjs 的教训）
//
//   - **绝不能对字幕画布调 `getContext('2d')`**：会永久绑定 2D 上下文，之后
//     `transferControlToOffscreen()` 直接抛 InvalidStateError。只用 drawImage 读。
//   - 读像素要**等到连续两帧一致**：worker 画到 OffscreenCanvas 后要过一次合成。
//   - **只数着墨像素分不出字体**：两个字体画同一句话覆盖面积可以只差 0.4%。
//     必须用字形指纹（把字压成 32×32 二值网格）。

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, webkit } from 'playwright'

const execFileAsync = promisify(execFile)

const APP = process.env.KVM_APP ?? 'http://localhost:5173/'
const API = process.env.KVM_API ?? `${new URL(APP).origin}/api`
const SABOTAGE = process.env.KVM_SABOTAGE ?? ''
const ENGINES = { chromium, webkit }
const engineName = process.argv[2] ?? 'chromium'

/** 链首。本机实测它的 cmap 里没有 `𠮷`，是天然的缺字，不是造出来的 */
const HEAD = 'Hiragino Kaku Gothic StdN'
/** 两个风格差异极大的链尾：明朝 vs 圆体。差异越大，"是不是同一个面"越无可辩驳 */
const TAILS = ['Hiragino Mincho ProN', 'Hiragino Maru Gothic ProN']

/** 左边这个字链首自己有，右边这个只有链尾有 */
const TEXT = 'あ𠮷'
const TITLE = 'KVM font chain check'

/**
 * 指纹算法。**两端共用同一份源码**：一份在浏览器里对 canvas 跑，一份在 Node 里
 * 对 ffmpeg 的裸灰度帧跑。两处各写一遍的话，比出来的差异分不清是字体不同
 * 还是算法不同。
 *
 * ## 每个字各按**自己的**包围盒归一化，不许共用一个盒
 *
 * 一开始是求整行的盒、再从水平中点切两半——**那样是错的**，而且错得很隐蔽：
 * 换链尾会让右边那个字的墨迹宽度变一点，中点跟着挪，于是左边那个字被切进/切出
 * 几列，指纹就变了。判据"链首的字不该受链尾影响"因此在实现完全正确的情况下
 * 也会转红（实测就是这么红的）。
 *
 * 所以先按**空列**把整行切成若干墨迹簇（两个全角字之间必有 side bearing 形成的
 * 空列），再拿每个簇自己的盒去归一化。这样一个字的度量变化传不到另一个字上，
 * 两端光栅尺寸不同也一并被归一化掉。
 */
const FINGERPRINT_SRC = `
(ink, w, h) => {
  const cols = new Array(w).fill(0)
  let y0 = h, y1 = -1, count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink(x, y)) continue
      cols[x]++
      count++
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (y1 < 0) return { ink: 0, glyphs: [] }

  // 空列切簇。两个全角字之间的 side bearing 必然留出空列
  const clusters = []
  let start = -1
  for (let x = 0; x <= w; x++) {
    const on = x < w && cols[x] > 0
    if (on && start < 0) start = x
    if (!on && start >= 0) { clusters.push([start, x - 1]); start = -1 }
  }

  const grid = (gx0, gx1) => {
    // 每个簇取自己的纵向范围：不同字的上下伸展不一样，共用整行的 y 会引入串扰
    let gy0 = h, gy1 = -1
    for (let y = 0; y < h; y++) {
      for (let x = gx0; x <= gx1; x++) {
        if (!ink(x, y)) continue
        if (y < gy0) gy0 = y
        if (y > gy1) gy1 = y
        break
      }
    }
    const N = 32
    const bw = (gx1 - gx0 + 1) / N
    const bh = (gy1 - gy0 + 1) / N
    let bits = ''
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        let on = 0, tot = 0
        for (let y = Math.floor(gy0 + gy * bh); y < Math.floor(gy0 + (gy + 1) * bh); y++) {
          for (let x = Math.floor(gx0 + gx * bw); x < Math.floor(gx0 + (gx + 1) * bw); x++) {
            tot++
            if (ink(x, y)) on++
          }
        }
        bits += tot && on * 2 > tot ? '1' : '0'
      }
    }
    let hex = ''
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16)
    }
    return hex
  }

  return { ink: count, glyphs: clusters.map(([a, b]) => grid(a, b)) }
}
`

const fingerprintNode = eval(FINGERPRINT_SRC)

/** 指纹摘要：8 位短哈希 + 着墨格数。直接打印整串没用，肉眼看不出差别 */
const digest = (fp) => {
  if (!fp) return '（无）'
  const ink = [...fp].reduce((n, ch) => n + (parseInt(ch, 16).toString(2).match(/1/g)?.length ?? 0), 0)
  return `${createHash('sha1').update(fp).digest('hex').slice(0, 8)}/格${ink}`
}

const GRID_CELLS = 32 * 32

/**
 * 判据的倍数余量：**异字体的差异必须至少是噪声底的这个倍数**。
 *
 * 这么写而不是钉一个格数，是因为噪声底本来就该现场测（见第三轮"复现"）。
 * 阈值一旦写死，换台机器、换个字号，红了之后第一反应会是调阈值。
 */
const MARGIN = 4

/**
 * 两个指纹的汉明距离（不同的格子数）。
 *
 * **不能用"完全相等"当判据**：同一个字体连渲两次，抗锯齿会让边缘格子在
 * 过半阈值上下抖动一两格（实测成片侧同一个「あ」两次着墨像素 13110 / 13119）。
 * 要求逐格相等的话，实现完全正确也会红——而红过一次之后，
 * 下一个人多半会去调阈值，而不是去看是不是真的换了字体。
 *
 * 所以判据是距离 + **把两侧的实际距离都打出来**：同字体几格、异字体几百格，
 * 中间的空档有多宽一眼可见，阈值取在哪里不重要。
 */
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return GRID_CELLS
  let n = 0
  for (let i = 0; i < a.length; i++) {
    let v = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (v) {
      n += v & 1
      v >>= 1
    }
  }
  return n
}

const api = async (path, init) => {
  const resp = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!resp.ok) throw new Error(`${path} → ${resp.status} ${await resp.text()}`)
  return resp.headers.get('content-type')?.includes('json') ? resp.json() : resp.text()
}

// ---------------------------------------------------------------------------
// 成片侧：拿导出用的那份 ASS（带 `[Fonts]`），用 ffmpeg 渲一帧
// ---------------------------------------------------------------------------

/** `H:MM:SS.cc` → 秒 */
const assSeconds = (v) => {
  const [hh, mm, ss] = v.split(':')
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss)
}

async function renderExportFrame(projectId, tmp, tag, size) {
  const ass = await api(`/render/preview.ass?project_id=${projectId}&embed_fonts=true`)
  if (!ass.includes('[Fonts]')) {
    throw new Error('导出用的 ASS 里没有 [Fonts] 段——字体根本没嵌进去，后面比什么都没意义')
  }
  const assPath = join(tmp, `${tag}.ass`)
  await writeFile(assPath, ass, 'utf-8')

  /*
   * 取样时刻从**第一条 Dialogue 的窗口中点**算，不要写死一个秒数。
   * 行的出现/消失时刻由提前量、淡化、槽位避让共同决定，跟歌词里的时间戳
   * 差着好几秒；写死的话很容易落在窗口外，而那时的症状是"一个字都没有"——
   * 与"字体没生效"长得一模一样，极易误判。
   */
  const first = ass.split('\n').find((ln) => ln.startsWith('Dialogue:'))
  if (!first) throw new Error('ASS 里一条 Dialogue 都没有')
  const [, start, end] = first.split(',')
  const atMs = ((assSeconds(start) + assSeconds(end)) / 2) * 1000

  // 裸灰度帧直接读字节，省掉 PNG 解码依赖；白字黑底，> 60 即着墨
  // 底片必须比取样时刻长：`-ss` 放在 `-i` 之后是**输出 seek**，源只有 1 秒的话
  // seek 到第 4 秒得到的是空文件，而空文件在下游只表现为"一个字都没有"
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=black:s=${size.w}x${size.h}:d=${atMs / 1000 + 2}`,
      '-vf', `ass=${assPath}:shaping=complex`,
      '-ss', String(atMs / 1000), '-frames:v', '1',
      '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
    ],
    { encoding: 'buffer', maxBuffer: 1 << 28 },
  )
  const buf = stdout
  if (buf.length < size.w * size.h) {
    throw new Error(`ffmpeg 只给了 ${buf.length} 字节，取样时刻 ${atMs}ms 上没有帧`)
  }
  return fingerprintNode((x, y) => buf[y * size.w + x] > 60, size.w, size.h)
}

// ---------------------------------------------------------------------------
// 预览侧：浏览器里的 JASSUB 画布
// ---------------------------------------------------------------------------

const SAMPLE = `
  (() => {
    const c = document.querySelector('canvas.sty-film__canvas')
    if (!c) return null
    const w = Math.min(960, c.width || 960)
    const h = Math.min(540, c.height || 540)
    const p = document.createElement('canvas')
    p.width = w; p.height = h
    const g = p.getContext('2d', { willReadFrequently: true })
    g.clearRect(0, 0, w, h)
    g.drawImage(c, 0, 0, w, h)
    const d = g.getImageData(0, 0, w, h).data
    const fp = (${FINGERPRINT_SRC})((x, y) => d[(y * w + x) * 4 + 3] > 128, w, h)
    return { ...fp, cw: c.width, ch: c.height, sig: fp.ink * 1009 + fp.glyphs.length }
  })()
`

async function samplePreview(page) {
  let prev = null
  for (let i = 0; i < 30; i++) {
    const now = await page.evaluate(SAMPLE)
    // 等到连续两帧一致：worker 画到 OffscreenCanvas 后要过一次合成才到得了占位 canvas
    if (now && prev && prev.sig === now.sig && now.ink > 0) return now
    prev = now
    await page.waitForTimeout(300)
  }
  return prev
}

// ---------------------------------------------------------------------------

const engine = ENGINES[engineName]
if (!engine) {
  console.error(`未知引擎 ${engineName}`)
  process.exit(2)
}

const tmp = await mkdtemp(join(tmpdir(), 'kvm-chain-'))
let projectId = null
let browser = null

try {
  // ---- 造一个只有一行的工程，行内两个字：一个链首有、一个只有链尾有 ----
  const created = await api('/projects/', {
    method: 'POST',
    body: JSON.stringify({ title: TITLE, artist: 'verify' }),
  })
  projectId = created.id
  await api('/lyrics/import', {
    method: 'POST',
    body: JSON.stringify({
      project_id: projectId,
      kind: 'lrc',
      content: `[00:02.00]${TEXT}\n[00:08.00]\n`,
    }),
  })
  // 关掉引导点：它们也会在画面上着墨，会把包围盒撑歪
  await api(`/projects/${projectId}/style`, {
    method: 'POST',
    body: JSON.stringify({ countdown_dots: 0, font_size: 220, stagger: false }),
  })

  const project = await api(`/projects/${projectId}`)
  const size = { w: project.video_width || 1920, h: project.video_height || 1080 }

  browser = await engine.launch()
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`   [pageerror] ${e.message.slice(0, 160)}`))

  if (SABOTAGE === 'samefont') {
    // 对照组：无论请求哪个族名都回同一份字节。此时画面照样有字、指纹却会撞在一起
    let cached = null
    await page.route('**/api/fonts/subset*', async (route) => {
      if (!cached) {
        const r = await page.request.get(
          `${API}/fonts/subset?family=${encodeURIComponent(HEAD)}&as=${encodeURIComponent(HEAD)}`,
        )
        cached = await r.body()
      }
      await route.fulfill({ status: 200, contentType: 'font/otf', body: cached })
    })
    console.log('   ⚠️ 对照组 samefont：所有字体请求一律返回同一份字节')
  }

  console.log(`\n########## 字体链两端一致性 @ ${engineName} ##########`)
  console.log(`   链首 ${HEAD}（本机 cmap 无「𠮷」）　素材「${TEXT}」\n`)

  /*
   * 六轮。前两轮是被测配置，后四轮全是**参照**——判据因此不需要任何阈值：
   * 每个字形去问"你最像哪一份参照"，答案就是画它的那个字体。
   *
   * 只比"换链尾后变了多少格"是不够的：那只能说明"变了"，说不出**变成谁**。
   * 而且实测同一个字被同一个字体画两次也不是逐格相同（换链尾会让 libass 的
   * 排版落在不同的亚像素位置上，边缘格子抖十几格），拿一个魔数去卡，
   * 红了之后第一反应会是调阈值，而不是去看是不是真的换了字体。
   */
  const ROUNDS = [
    { name: '链 [首,明朝]', chain: [HEAD, TAILS[0]] },
    { name: '链 [首,丸ゴ]', chain: [HEAD, TAILS[1]] },
    { name: '链 [首,明朝] 复现', chain: [HEAD, TAILS[0]] },
    { name: '参照 明朝独用', chain: [TAILS[0]] },
    { name: '参照 丸ゴ独用', chain: [TAILS[1]] },
    { name: '参照 链首独用', chain: [HEAD] },
  ]
  const results = []
  for (const round of ROUNDS) {
    const chain = SABOTAGE === 'nochain' ? [round.chain[0]] : round.chain
    const tail = round.name
    await api(`/projects/${projectId}/style`, {
      method: 'POST',
      body: JSON.stringify({ font_names: chain }),
    })

    // 预热：冷裁剪一份约 10 秒，先把这段等待挪到打开页面之前
    await api('/fonts/coverage', {
      method: 'POST',
      body: JSON.stringify({ families: chain, text: TEXT + TITLE }),
    })

    const exported = await renderExportFrame(projectId, tmp, `round-${results.length}`, size)

    await page.goto(`${APP}?project=${projectId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('.pcard:not(.pcard--new)', { timeout: 30000 })
    const index = await page.evaluate(async (id) => {
      const list = await (await fetch('/api/projects/')).json()
      return list.findIndex((p) => p.id === id)
    }, projectId)
    await page.locator('.pcard:not(.pcard--new)').nth(index).click()
    await page.waitForSelector('.topbar', { timeout: 30000 })
    await page.locator('.stepbar .step', { hasText: '样式' }).first().click()
    await page.waitForSelector('.sty-stage', { timeout: 30000 })
    // 字体冷裁剪 + JASSUB 起 worker + 灌字体 + 建轨
    await page.waitForTimeout(9000)
    const scrub = page.locator('.sty-transport__scrub')
    const span = Number(await scrub.getAttribute('max'))
    await scrub.fill(String(Math.round(span * 0.5)))
    await page.waitForTimeout(1200)

    const preview = await samplePreview(page)
    results.push({ tail, chain, preview, exported })
    const show = (label, fp) =>
      console.log(
        `     ${label}　字形 ${(fp?.glyphs ?? []).map(digest).join('  ')}   着墨 ${fp?.ink ?? 0}`,
      )
    console.log(`   链尾 ${tail}`)
    show('预览', preview)
    show('成片', exported)
  }

  // ---- 判据：每个字形去认领它最像的那份参照 ----
  const [r0, r1, rRepeat, refMincho, refMaru, refHead] = results
  const checks = []
  const push = (ok, text) => checks.push({ ok, text })

  const headGlyph = (fp) => fp?.glyphs?.[0]
  const rareGlyph = (fp) => fp?.glyphs?.[1]

  // 被测的四帧必须各切出两个字形，否则下面按下标取的根本不是那两个字。
  // 参照帧不强求：链首独用时「𠮷」在预览里根本画不出来，只有一个簇——
  // 这恰恰是"链首没有这个字"的直接证据。
  push(
    [r0, r1].flatMap((r) => [r.preview, r.exported]).every((fp) => fp?.glyphs?.length === 2),
    '被测四帧都恰好切出两个字形（切不出两个就不知道在比什么）',
  )

  /** 在若干参照里挑最像的一个，返回 `[名字, 距离, 次近距离]` */
  const identify = (fp, refs) => {
    const scored = refs
      .map(([name, ref]) => [name, hamming(fp, ref)])
      .sort((x, y) => x[1] - y[1])
    return [scored[0][0], scored[0][1], scored[1]?.[1] ?? GRID_CELLS]
  }

  console.log(`\n=== 字形认领（汉明距离，共 ${GRID_CELLS} 格） ===`)
  for (const [end, pick] of [
    ['预览', (r) => r.preview],
    ['成片', (r) => r.exported],
  ]) {
    const floor = hamming(headGlyph(pick(r0)), headGlyph(pick(rRepeat)))
    const headRefs = [
      ['链首', headGlyph(pick(refHead))],
      ['明朝', headGlyph(pick(refMincho))],
      ['丸ゴ', headGlyph(pick(refMaru))],
    ]
    const rareRefs = [
      ['明朝', rareGlyph(pick(refMincho))],
      ['丸ゴ', rareGlyph(pick(refMaru))],
    ]

    const [hWho, hNear, hNext] = identify(headGlyph(pick(r0)), headRefs)
    const [t0Who, t0Near, t0Next] = identify(rareGlyph(pick(r0)), rareRefs)
    const [t1Who, t1Near, t1Next] = identify(rareGlyph(pick(r1)), rareRefs)

    console.log(`   ${end}　同配置复现差 ${floor} 格`)
    console.log(`     「あ」链[首,明朝]　→ ${hWho}（${hNear} 格，次近 ${hNext}）`)
    console.log(`     「𠮷」链[首,明朝]　→ ${t0Who}（${t0Near} 格，次近 ${t0Next}）`)
    console.log(`     「𠮷」链[首,丸ゴ]　→ ${t1Who}（${t1Near} 格，次近 ${t1Next}）`)

    push(floor === 0, `${end}：同配置两次渲染逐格相同（${floor} 格）→ 差异都是有原因的`)
    push(hWho === '链首' && hNear * 2 < hNext, `${end}：「あ」认的是链首 → 链首对自己有的字保有优先权`)
    push(t0Who === '明朝' && t0Near * 2 < t0Next, `${end}：「𠮷」认的是明朝 → 链尾接管了缺字`)
    push(t1Who === '丸ゴ' && t1Near * 2 < t1Next, `${end}：换成丸ゴ后「𠮷」认的是丸ゴ → 换链尾真的换了字体`)
  }

  console.log('\n=== 判据 ===')
  for (const c of checks) console.log(`   ${c.ok ? '✅' : '❌'} ${c.text}`)

  const failed = checks.filter((c) => !c.ok).length
  console.log(
    failed === 0
      ? '\n   ✅ 预览与成片各自认领出的字体完全相同 → 同一个字用的是同一个字体'
      : `\n   ❌ ${failed} 条判据未通过`,
  )
  console.log(`\n   产物留在 ${tmp}\n`)
  process.exitCode = failed ? 1 : 0
} finally {
  if (browser) await browser.close()
  // 验证用的临时工程不留在用户的工程列表里
  if (projectId) {
    await fetch(`${API}/projects/${projectId}`, { method: 'DELETE' }).catch(() => {})
  }
}
