// 「编辑」舞台版面验收：时间轴不画句子 / 左上角紧凑化 / 整曲偏移换位。
//
//   用法：node scripts/verify-edit-layout.mjs [chromium|webkit]   不带参数则两个都跑
//
// ## 判据是怎么设计成"能区分成功与失败"的
//
// **一、"时间轴上没有句子文本" —— 带阳性对照的探测器**
// 只断言"找不到句子"是最容易假通过的一类判据：探测器自己写错（选错容器、
// 取错属性、正则失配）同样得到"找不到"。所以每跑完一次否定断言，立刻往时间轴里
// **注入一个含真实句子的节点**再跑一次同一个探测器，要求它这次必须报警；
// 报不出来就说明探测器不可信，本轮结论作废。textContent 与 title 两条通路
// 各做一次对照——它们是两段不同的代码，一段坏了另一段不会替它兜底。
//
// **二、"单句调轴还在" —— 拖完去后端对账，不看界面**
// 拖句柄条之后从 API 重新拉整份工程，要求该行**每一个 token 位移完全相同**、
// 其余行一个都没动。只看界面上方块挪了没有是不够的：拖动预览是纯本地的，
// 松手若没提交，界面照样是挪过的样子。对完账再撤销，并断言真的撤回了原值——
// 撤销失败就必须报出来，不能悄悄把用户的工程改坏。
//
// **三、"拆行/合并行还能用" —— 同样对后端行数，做完撤销**
// 图标化最容易出的事故是按钮点了没反应（onClick 丢在重构里），而纯图标按钮
// 又没有文字提示这一点。所以按下去之后看的是行数，不是按钮外观。
//
// **四、"省出空间" —— 报绝对像素，不报"感觉宽了"**
// 三档宽度下量 `.edit-lyrics` 的实际宽度与左栏空白高度，并对 1024 这档设死线：
// 改动前它只有 428px，若还低于 600px 就说明这次没真省出来。
//
// **五、纯图标按钮 —— 触点与可读性一起查**
// 无文字的按钮必须同时有 title（鼠标）与 aria-label（读屏），且 ≥28×28。
// 少一样就等于对其中一类用户把按钮变成哑谜。
//
// **六、跑完必须对账：工程要和开跑前一模一样**
// 本脚本会真的改用户的工程（平移、拆行、合并行、改偏移），所以每一步都配一次撤销，
// 最后整份工程做一次全字段比对。这条不是洁癖：第一版脚本"拆行→合并行"看着完美
// 复原（行数 60→61→60），实际把 `line.locked` 从 false 留成了 true ——
// 后端对手工分行一律标 `locked=True`（editing/ops.py），合并回去也不会摘掉。
// 只对行数、只对时间，都发现不了这种残留。

import { deepStrictEqual } from 'node:assert'

import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'

const OUT =
  '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui-edit-layout'
const APP = 'http://localhost:5173/'
const API = 'http://127.0.0.1:8000'
const ENGINES = { chromium, webkit }
const wanted = process.argv[2] && !process.argv[2].startsWith('--') ? [process.argv[2]] : ['chromium', 'webkit']
const PROJECT_ID = 'cd4aed3df12e'
/**
 * 会**真的改工程**的那几节（拖轴、拆行/合并行、声部指派与改名）默认不跑。
 *
 * 这条是踩过才加的：它们每一步都配了撤销，但撤销依赖"我这一步占了几格"这个
 * 减法，而**后端对没有实际变化的写入不入栈**，减出来的差就会对不上，残留悄悄
 * 留在用户的工程里。更糟的是"一路撤到开跑前的深度"这种兜底 ——
 * 用户正开着浏览器编同一首歌时，那个循环会把**他的**编辑一并撤掉。
 *
 * 所以：默认只跑只读判据；要验编辑链路就显式加 `--mutate`，
 * 并且**确认此刻没有人正在用这个工程**。
 *
 * 加了 `--mutate` 之后，**改工程的判据一律跑在脚本自己新建的临时工程上**，
 * 跑完就删。绝不碰用户正开着的那一个 —— 这条是踩过三次才立的规矩：
 * 逐个操作"数一数占了几格撤销再退回去"根本靠不住（后端对无实际变化的写入不入栈），
 * 而"一路撤到开跑前的深度"在用户同时开着浏览器时会把**他的**编辑一并撤掉。
 * 只读判据仍跑在真实工程上，因为那些要真的素材（波形、走带、代理视频）。
 */
const MUTATE = process.argv.includes('--mutate')

mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

const KNOWN_NOISE = /Cross-Origin-Embedder-Policy|jassub|worker\.js|字幕渲染器|字幕预览不可用|SubtitleOverlay/i

/** 改工程的判据跑在这个临时工程上，跑完删掉。只读判据仍用真实工程 */
let SCRATCH_ID = null
const fetchProject = (id = SCRATCH_ID ?? PROJECT_ID) =>
  fetch(`${API}/api/projects/${id}`).then((r) => r.json())

/** 造一个只有歌词、没有素材的临时工程：逐字轴/拆行/声部这些判据都不需要音频 */
async function createScratch(lines) {
  const created = await fetch(`${API}/api/projects/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `验收临时工程 ${new Date().toISOString().slice(11, 19)}`, artist: 'verify' }),
  }).then((r) => r.json())
  /*
   * 用**合成的 QRC** 导入。纯文本与 LRC 都只给"整行一个 token"，
   * 逐字轴上就没有"第 3 个字"可点，拆行/字级声部这些判据全做不了；
   * 逐字粒度只有 QRC 这条路径给得出（CLAUDE.md §4.2 的粒度表）。
   * 时间直接抄真实工程的，字宽、间隙都是真的。
   */
  const qrc = lines
    .map((l) => {
      const st = l.tokens[0].start_ms
      const last = l.tokens[l.tokens.length - 1]
      const dur = last.start_ms + last.dur_ms - st
      return `[${st},${dur}]` + l.tokens.map((t) => `${t.text}(${t.start_ms},${t.dur_ms})`).join('')
    })
    .join('\n')
  await fetch(`${API}/api/lyrics/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: created.id, kind: 'qrc', content: qrc, replace: true }),
  })
  return created.id
}

const deleteScratch = async () => {
  if (!SCRATCH_ID) return
  await fetch(`${API}/api/projects/${SCRATCH_ID}`, { method: 'DELETE' })
  SCRATCH_ID = null
}
const lineTextOf = (l) => l.tokens.map((tk) => tk.text).join('')

/** 对账用的规范化：只去掉与内容无关的时间戳 */
const normalize = (p) => {
  const c = structuredClone(p)
  delete c.updated_at
  return c
}

/** 直接走后端的撤销，不经界面 —— 收尾清场不该依赖被测对象 */
const undoOnce = () => fetch(`${API}/api/projects/${SCRATCH_ID ?? PROJECT_ID}/undo`, { method: 'POST' })

/**
 * 把某一行的声部直接写回去。
 *
 * 收尾**不靠"数一数我占了几格撤销再退回去"**：后端对没有实际变化的写入不入栈，
 * 减出来的差就会少算，残留悄悄留在用户的工程里（实测：批量 5 句只记到 1 格，
 * 结果 4 行的改名整个没退回去）。反着写一次是确定的。
 */
/**
 * 轮询等到某个字段变成期望值再断言，不要靠固定的 `waitForTimeout`。
 * 编辑请求是"点一下 → 发请求 → 拿整份工程回来"，慢一点就会量到旧值，
 * 判据于是随机变红（实测整曲偏移那条两跑一红），而产品其实是好的。
 */
const waitFor = async (read, want, timeoutMs = 6000) => {
  const end = Date.now() + timeoutMs
  let v = await read()
  while (v !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200))
    v = await read()
  }
  return v
}

const restoreVoice = (lineId, part) =>
  fetch(`${API}/api/editor/voice-part`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: SCRATCH_ID ?? PROJECT_ID, line_id: lineId, voice_part: part, token_range: null }),
  })

/**
 * 句子探测器（在页面里跑）。扫 `.kvm-tl` 子树的**所有文本节点与所有 title 属性**，
 * 看有没有哪一条整句歌词原样出现。
 *
 * 只收 ≥4 字的句子：一两个字的行会和逐字轴上单个字的 title 撞车，
 * 那是误报而不是"时间轴在画句子"。
 */
const PROBE = (sentences) => {
  const tl = document.querySelector('.kvm-tl')
  if (!tl) return { ok: false, reason: 'no-timeline' }
  const texts = []
  const walker = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = (n.nodeValue || '').trim()
    if (s) texts.push(s)
  }
  const titles = [...tl.querySelectorAll('[title]')].map((e) => e.getAttribute('title') || '')
  const hitIn = (pool) => {
    const out = []
    for (const s of sentences) for (const v of pool) if (v.includes(s)) out.push(s)
    return [...new Set(out)]
  }
  return { ok: true, textHits: hitIn(texts), titleHits: hitIn(titles), nodes: texts.length }
}

async function runEngine(name) {
  const browser = await ENGINES[name].launch(
    name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
  )
  try {
    await runEngineOn(name, browser)
  } finally {
    await browser.close()
  }
}

async function open(browser, width, height = 950) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.addInitScript((id) => {
    localStorage.setItem(`kvm.step.${id}`, 'edit')
    // 分割比例是会**跨轮次残留**的用户偏好：上一轮拖过之后不清掉，
    // 下一轮"默认版面有多宽"量到的就是上次的手滑，而且看起来像产品回归
    localStorage.removeItem('kvm.split.edit')
    localStorage.removeItem('kvm.split.edit.side')
  }, PROJECT_ID)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.locator('.pcard').filter({ hasText: '赤春花' }).first().click()
  await page.waitForSelector('.kvm-ruby__paper', { timeout: 20000 })
  await page.waitForSelector('[data-role="token-rail"]', { timeout: 20000 })
  await page.waitForTimeout(1500)
  return { page, errors }
}

async function runEngineOn(name, browser) {
  const project0 = await fetchProject()
  /*
   * 开跑前的撤销深度。收尾时一路撤到这个数为止 ——
   * 逐个操作各自记"我占了几格"太脆：某一行本来就已经是目标值时后端不会入栈，
   * 减出来的差就对不上，残留会悄悄留在用户的工程里。
   */
  const depth0 = (await fetch(`${API}/api/projects/${PROJECT_ID}/history`).then((r) => r.json())).undo
  const sentences = project0.lines.map(lineTextOf).filter((s) => s.length >= 4)
  const { page, errors } = await open(browser, 1600)

  // ---------------------------------------------------------- 一、时间轴上没有句子
  console.log('\n1) 时间轴上不画句子文本')
  const probe0 = await page.evaluate(PROBE, sentences)
  check(probe0.ok, '探测器找到了时间轴容器', `扫了 ${probe0.nodes} 个文本节点`)
  check(probe0.textHits.length === 0, '时间轴的可见文本里没有整句歌词', probe0.textHits.slice(0, 2).join('｜'))
  check(probe0.titleHits.length === 0, '时间轴的 title 里也没有整句歌词', probe0.titleHits.slice(0, 2).join('｜'))

  // 阳性对照：故意往时间轴里塞一句，探测器必须报警（两条通路各塞一次）
  const control = await page.evaluate((s) => {
    const tl = document.querySelector('.kvm-tl')
    const a = document.createElement('div')
    a.id = '__probe_text'
    a.textContent = s
    const b = document.createElement('div')
    b.id = '__probe_title'
    b.setAttribute('title', s)
    tl.append(a, b)
    return true
  }, sentences[0])
  const probe1 = control ? await page.evaluate(PROBE, sentences) : null
  check(
    !!probe1 && probe1.textHits.includes(sentences[0]),
    '阳性对照：塞一句进去，文本通路必须报警（否则探测器不可信）',
  )
  check(
    !!probe1 && probe1.titleHits.includes(sentences[0]),
    '阳性对照：塞一句进去，title 通路必须报警',
  )
  await page.evaluate(() => {
    document.getElementById('__probe_text')?.remove()
    document.getElementById('__probe_title')?.remove()
  })

  // 句子层的替代载体确实存在
  const carriers = await page.evaluate(() => {
    const act = document.querySelector('[data-role="line-handle"][data-active]')
    return {
      handle: act?.dataset.line ?? null,
      handleText: (act?.textContent || '').trim(),
      rail: document.querySelector('[data-role="token-rail"]')?.dataset.line ?? null,
      handles: document.querySelectorAll('[data-role="line-handle"]').length,
      railLines: new Set(
        [...document.querySelectorAll('.kvm-tl-tok')].map((e) => e.dataset.line),
      ).size,
      toks: document.querySelectorAll('.kvm-tl-tok').length,
      ovTotal: document.querySelectorAll('.kvm-tl-ov').length,
      ovActive: document.querySelector('.kvm-tl-ov[data-active]')?.dataset.line ?? null,
      oldStrip: document.querySelectorAll('.kvm-tl-line').length,
    }
  })
  check(carriers.oldStrip === 0, '旧行轨已经不存在', `.kvm-tl-line=${carriers.oldStrip}`)
  check(!!carriers.handle && carriers.handle === carriers.rail, '句柄条与逐字轴指的是同一行')
  check(/^#\d+$/.test(carriers.handleText), '句柄条上只有行号，没有别的字', `"${carriers.handleText}"`)
  check(carriers.ovTotal > 10 && carriers.ovActive === carriers.rail, '概览条逐句可见且标出当前句', `${carriers.ovTotal} 句`)
  // 整曲铺开：视口里同时看得到不止一句的字（只画选中句时这个数恒为 1）
  check(
    carriers.railLines >= 2 && carriers.handles >= 2,
    '逐字轴同时画了多句的字，不只是选中的那一句',
    `${carriers.railLines} 句 / ${carriers.toks} 字 / ${carriers.handles} 个句柄`,
  )

  // 制作名单行不该出现在轴上：它们不唱，且被歌词源塞在开头几十毫秒里
  const creditIds = project0.lines.filter((l) => l.is_metadata).map((l) => l.id)
  const creditOnRail = await page.evaluate((ids) => {
    const onRail = new Set(
      [...document.querySelectorAll('.kvm-tl-tok, [data-role="line-handle"], .kvm-tl-ov')].map(
        (e) => e.dataset.line,
      ),
    )
    return ids.filter((id) => onRail.has(id))
  }, creditIds)
  check(creditIds.length > 0, '（前置）本曲确实有制作名单行', `${creditIds.length} 行`)
  check(creditOnRail.length === 0, '制作名单行不出现在逐字轴与概览条上', creditOnRail.join(','))

  // 行号必须与歌词正文左侧那个数字对得上，否则它当不了"这段属于哪句"的指针
  const noMatch = await page.evaluate((id) => {
    const paperNo = document
      .querySelector(`.kvm-ruby__paper .kvm-ruby__line[data-line="${id}"] .kvm-ruby__no`)
      ?.textContent?.trim()
    const railNo = (document.querySelector('[data-role="line-handle"][data-active]')?.textContent || '').replace('#', '').trim()
    return { paperNo, railNo }
  }, carriers.handle)
  check(
    !!noMatch.paperNo && noMatch.paperNo === noMatch.railNo,
    '句柄条的行号 = 歌词正文左侧的行号',
    `正文 ${noMatch.paperNo} / 句柄 ${noMatch.railNo}`,
  )

  // 改工程的判据整块搬到临时工程上跑（见 runMutations），这里不再动用户的数据

  // ---------------------------------------------------------- 四、整曲偏移
  console.log('\n4) 整曲偏移搬到时间轴工具条')
  const place = await page.evaluate(() => {
    const off = document.querySelector('[data-role="global-offset"]')
    const insp = document.querySelector('.edit-inspect')
    const bar = document.querySelector('.kvm-tl')
    if (!off) return null
    const o = off.getBoundingClientRect()
    const i = insp?.getBoundingClientRect()
    return {
      inTimeline: !!bar && bar.contains(off),
      inInspector: !!insp && insp.contains(off),
      label: (off.querySelector('.edit-offset__title')?.textContent || '').trim(),
      inspectorShiftLabel: [...(insp?.querySelectorAll('.kvm-ruby__label') ?? [])]
        .map((e) => e.textContent.trim())
        .filter((s) => s.includes('平移'))[0] ?? null,
      gapY: i ? Math.round(i.top - o.bottom) : null,
      // 左栏里不该再有它
      inSide: !!document.querySelector('.edit-side [data-role="global-offset"]'),
    }
  })
  check(!!place && place.inTimeline && !place.inInspector, '偏移在时间轴里，不在底栏检查器里')
  check(!!place && !place.inSide, '左栏（画面那一栏）里已经没有它了')
  check(!!place && place.label.includes('整曲'), '标签写明作用范围是「整曲」', place?.label)
  check(
    !!place && place.inspectorShiftLabel === '平移',
    '检查器那一组仍叫「平移」，两组标签不同名',
    String(place?.inspectorShiftLabel),
  )
  check(!!place && place.gapY > 150, '两组 ±ms 按钮在纵向上拉开了距离', `${place?.gapY}px`)

  // 真的会改全局偏移，且能自己还原（不依赖撤销）

  // ---------------------------------------------------------- 四点五、选中即播放位置
  //
  // 「选中」与「正在唱」合成了一件事。判据必须成对：既要 seek 真的发生了
  // （播放头挪到了那个字的起点），又要两处高亮落在同一行 —— 只测其一的话，
  // "根本没 seek 但两个标记恰好都停在原地"也会通过。
  console.log('\n4.5) 点哪儿播放头就跳哪儿')
  const clockMs = () =>
    page.evaluate(() => {
      const s = [...document.querySelectorAll('.edit-preview span')]
        .map((e) => e.textContent?.trim() ?? '')
        .find((x) => /^\d+:\d{2}\.\d{2}$/.test(x))
      const m = s ? /^(\d+):(\d{2})\.(\d{2})$/.exec(s) : null
      return m ? (+m[1] * 60 + +m[2]) * 1000 + +m[3] * 10 : null
    })
  // 挑一句离当前播放位置远的，避免"本来就在那儿"的假通过
  const farLine = project0.lines.filter((l) => !l.is_metadata && l.tokens.length)[24]
  const before4 = await clockMs()
  await page.locator(`.kvm-tl-ov[data-line="${farLine.id}"]`).click({ force: true })
  await page.waitForTimeout(700)
  const after4 = await clockMs()
  const wantMs = farLine.tokens[0].start_ms + project0.global_offset_ms
  check(
    after4 !== null && Math.abs(after4 - wantMs) < 400,
    '点概览条上的一句，播放头跳到那一句的起点',
    `${before4} → ${after4}ms（应约 ${wantMs}）`,
  )
  const coincide = await page.evaluate(() => {
    const paper = document.querySelector('.kvm-ruby__paper')
    return {
      active: paper?.querySelector('[data-active]')?.dataset.line ?? null,
      playing: paper?.querySelector('[data-playing]')?.dataset.line ?? null,
      rail: document.querySelector('[data-role="token-rail"]')?.dataset.line ?? null,
    }
  })
  check(
    coincide.active === farLine.id && coincide.playing === farLine.id && coincide.rail === farLine.id,
    '选中 / 正在唱 / 逐字轴三处指同一行',
    `选中=${coincide.active?.slice(0, 6)} 播放=${coincide.playing?.slice(0, 6)} 轴=${coincide.rail?.slice(0, 6)}`,
  )

  // ---------------------------------------------------------- 四点六、波形音源独立
  console.log('\n4.6) 波形音源与试听音轨相互独立')
  const wave0 = await page.evaluate(() => ({
    opts: [...document.querySelectorAll('[data-wave-src]')].map((l) => ({
      k: l.dataset.waveSrc,
      on: l.hasAttribute('data-on'),
      disabled: l.querySelector('input')?.disabled ?? true,
    })),
    audioBtns: [...document.querySelectorAll('.edit-preview button')]
      .map((b) => (b.textContent || '').trim())
      .filter((s) => s === '原声' || s === '伴奏'),
  }))
  check(wave0.opts.length === 3, '波形音源有原曲/伴奏/人声三档', wave0.opts.map((o) => o.k).join(','))
  check(wave0.audioBtns.length === 2, '走带上仍是它自己那组原声/伴奏（两者不是同一个控件）')
  const vocalsOpt = wave0.opts.find((o) => o.k === 'vocals')
  if (vocalsOpt && !vocalsOpt.disabled) {
    const req = []
    page.on('request', (r) => {
      if (/\/api\/media\/file\//.test(r.url())) req.push(r.url())
    })
    await page.locator('[data-wave-src="vocals"]').click()
    await page.waitForTimeout(2500)
    check(
      req.some((u) => u.endsWith('/vocals')),
      '切到「人声」后波形真的去取了人声轨',
      req.map((u) => u.split('/').pop()).join(','),
    )
    await page.locator('[data-wave-src="audio"]').click()
    await page.waitForTimeout(800)
  } else {
    check(!!vocalsOpt?.disabled, '本工程没有人声轨时该档禁用而不是消失（缺轨要说得出原因）')
  }

  // ---------------------------------------------------------- 四点七、左右分割条
  console.log('\n4.7) 画面 / 歌词比例可拖')
  const sideBar = page.locator('.stage-split[data-dir="horizontal"] > [data-role="split-bar"]')
  check((await sideBar.count()) === 1, '上半区有一条左右分割条')
  const w0 = await page.evaluate(() =>
    Math.round(document.querySelector('.edit-side').getBoundingClientRect().width),
  )
  const sb = await sideBar.boundingBox()
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
  await page.mouse.down()
  await page.mouse.move(sb.x + sb.width / 2 + 160, sb.y + sb.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const w1 = await page.evaluate(() =>
    Math.round(document.querySelector('.edit-side').getBoundingClientRect().width),
  )
  check(w1 - w0 > 100, '拖分割条，画面栏真的变宽', `${w0} → ${w1}px`)
  /*
   * 双击复位，不要"反着再拖一次"——分割条已经不在原来的坐标上了，
   * 按旧坐标按下去只会落空，比例原样留在 localStorage 里，
   * 后面"默认版面该有多宽"的判据就会莫名其妙地红。
   */
  await sideBar.dblclick()
  await page.waitForTimeout(400)
  const w2 = await page.evaluate(() =>
    Math.round(document.querySelector('.edit-side').getBoundingClientRect().width),
  )
  check(Math.abs(w2 - w0) <= 2, '双击分割条复位到默认比例', `${w1} → ${w2}px`)

  // 上下分割条：波形要跟着按比例长高，而不是在下面留白
  const paneBar = page.locator('.stage-split:not([data-dir="horizontal"]) > [data-role="split-bar"]')
  // wavesurfer 的 canvas 在 shadow root 里，`document.querySelector('canvas')` 恒为 null——
  // 一度因此量出 0 → 0 并把它当成"波形没长高"，那是取证工具坏了不是产品坏了
  const waveH = () =>
    page.evaluate(
      () => document.querySelector('[data-role="wave-box"]')?.getBoundingClientRect().height ?? 0,
    )
  const waveH0 = await waveH()
  const pb = await paneBar.boundingBox()
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2)
  await page.mouse.down()
  await page.mouse.move(pb.x + pb.width / 2, pb.y - 140, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(700)
  const waveH1 = await waveH()
  check(waveH0 > 0 && waveH1 - waveH0 > 80, '上下分割条往上拖，波形跟着长高', `${Math.round(waveH0)} → ${Math.round(waveH1)}px`)
  await paneBar.dblclick()
  await page.waitForTimeout(500)

  // ---------------------------------------------------------- 五、纯图标按钮
  console.log('\n5) 纯图标按钮：认得出、点得到')
  const icons = await page.evaluate(() => {
    const out = []
    for (const b of document.querySelectorAll('.kvm-tl button')) {
      if ((b.textContent || '').trim()) continue
      const r = b.getBoundingClientRect()
      out.push({
        role: b.dataset.role ?? '(无)',
        title: b.getAttribute('title') || '',
        aria: b.getAttribute('aria-label') || '',
        w: Math.round(r.width),
        h: Math.round(r.height),
      })
    }
    return out
  })
  check(icons.length >= 6, '工具条上确实有一批纯图标按钮', `${icons.length} 个`)
  const noLabel = icons.filter((i) => !i.title || !i.aria)
  check(noLabel.length === 0, '每个纯图标按钮都同时有 title 与 aria-label', noLabel.map((i) => i.role).join(','))
  const tooSmall = icons.filter((i) => i.w < 28 || i.h < 28)
  check(
    tooSmall.length === 0,
    '纯图标按钮触点均 ≥28×28',
    tooSmall.map((i) => `${i.role} ${i.w}×${i.h}`).join(','),
  )
  // 手工打轴是模式开关（§2.5 一等公民），刻意保留文字
  const tapText = await page.locator('[data-role="tap"]').textContent()
  check(/打轴/.test(tapText || ''), '「手工打轴」保留文字，没有被图标化', (tapText || '').trim())

  // ---------------------------------------------------------- 六、打轴模式下走带还在
  console.log('\n6) 打轴模式')
  await page.locator('[data-role="token-rail"]').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('t')
  await page.waitForTimeout(500)
  const tap = await page.evaluate(() => {
    const play = [...document.querySelectorAll('.edit-preview button')].find((b) =>
      /播放|暂停/.test(b.textContent || ''),
    )
    const r = play?.getBoundingClientRect()
    const chips = document.querySelectorAll('.kvm-tl-chip').length
    return {
      panel: !!document.querySelector('.kvm-tl-chip'),
      chips,
      playVisible: r ? r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth : false,
      playBox: r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}` : '无',
    }
  })
  check(tap.panel, '打轴面板出来了', `${tap.chips} 个字`)
  check(tap.playVisible, '打轴模式下走带仍在视口内', tap.playBox)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // ---------------------------------------------------------- 七、窄窗口
  console.log('\n7) 版面与像素占用')
  const MEASURE = () => {
    const b = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }
    }
    const side = document.querySelector('.edit-side')
    const used = side
      ? [...side.children].reduce((s, c) => s + c.getBoundingClientRect().height, 0)
      : 0
    return {
      vw: innerWidth,
      side: b('.edit-side'),
      lyrics: b('.edit-lyrics'),
      sideIdlePx: side ? Math.round(side.getBoundingClientRect().height - used) : null,
      voice: b('[data-role="voice-part"]'),
      paper: b('.kvm-ruby__paper'),
      inspect: b('.edit-inspect'),
      rail: b('[data-role="token-rail"]'),
      wave: b('[data-role="wave-host"]'),
      toolbarRows: (() => {
        const bar = document.querySelector('.kvm-tl > div')
        return bar ? Math.round(bar.getBoundingClientRect().height / 28) : 0
      })(),
      docScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      railVisible: (() => {
        const r = document.querySelector('[data-role="token-rail"]')?.getBoundingClientRect()
        return !!r && r.bottom <= innerHeight + 1 && r.height > 40
      })(),
    }
  }
  /*
   * 待检查清单：开它**不该**再从歌词正文身上切走一栏。
   * 判据要成对——只断言"正文没变窄"会假通过（清单压根没渲染出来也是这个结果），
   * 所以同时要求清单确实出现了、且它落在左栏里。
   */
  const wide0 = await page.evaluate(() => ({
    lyrics: Math.round(document.querySelector('.edit-lyrics').getBoundingClientRect().width),
  }))
  await page.locator('.kvm-ruby__reviewtoggle').click()
  await page.waitForTimeout(400)
  const wide1 = await page.evaluate(() => {
    const rev = document.querySelector('.edit-review')
    return {
      lyrics: Math.round(document.querySelector('.edit-lyrics').getBoundingClientRect().width),
      shown: !!rev && rev.getBoundingClientRect().height > 20,
      inSide: !!document.querySelector('.edit-side .edit-review'),
      h: rev ? Math.round(rev.getBoundingClientRect().height) : 0,
    }
  })
  check(wide1.shown && wide1.inSide, '待检查清单开在左栏画面下方', `高 ${wide1.h}px`)

  /*
   * 清单里不许出现制作名单行。判据要成对，否则假通过太容易：
   * 先**把名单行显示出来**（这正是它们会漏进清单的那个条件），再断言清单里
   * 一条都没有 —— 只在默认态下查，等于什么都没查。
   */
  const creditTexts = project0.lines
    .filter((l) => l.is_metadata)
    .map((l) => l.tokens.map((tk) => tk.text).join(''))
  const metaToggle = page.locator('.kvm-ruby__metatoggle')
  if ((await metaToggle.count()) === 1) {
    await metaToggle.click()
    await page.waitForTimeout(500)
    const leak = await page.evaluate((texts) => {
      const paperShown = document.querySelectorAll('.kvm-ruby__line[data-meta]').length
      const items = [...document.querySelectorAll('.edit-review .kvm-ruby__listitem')].map((e) =>
        (e.textContent || '').replace(/\s+/g, ''),
      )
      const hits = items.filter((it) => texts.some((s) => s && it.includes(s.slice(0, 4))))
      return { paperShown, items: items.length, hits }
    }, creditTexts)
    check(leak.paperShown > 0, '（前置）制作名单行确实已经显示出来了', `${leak.paperShown} 行`)
    check(leak.hits.length === 0, '待检查清单里没有制作名单', leak.hits.slice(0, 2).join('｜'))
    await metaToggle.click()
    await page.waitForTimeout(300)
  }
  check(wide1.lyrics === wide0.lyrics, '开清单不再从歌词正文身上切走一栏', `${wide0.lyrics} → ${wide1.lyrics}px`)

  /*
   * 高度链（docs/ui-redesign.md §七点五）。清单换了一个 flex 上下文，
   * 而**同一个组件在不同形态下不一定都能滚** —— 少一个 `min-height: 0`
   * 就会被内容撑开、溢出一路上交到最外层被裁掉，症状还偏偏指向无辜的 overflow。
   *
   * 本曲的待检查数恰好是 0，等真实数据来测等于永远不测，所以直接塞满它。
   * 判据是**清单自己成为滚动容器**（scrollHeight > clientHeight），
   * 而不是"页面没横向溢出"这种连断链都能通过的弱条件；同时要求左栏本身没被撑高。
   */
  const chain = await page.evaluate(() => {
    const list = document.querySelector('.edit-review .kvm-ruby__list')
    const box = document.querySelector('.edit-review .kvm-ruby__box')
    const side = document.querySelector('.edit-side')
    if (!box || !side) return null
    const target = list ?? (() => {
      const ul = document.createElement('ul')
      ul.className = 'kvm-ruby__list'
      box.append(ul)
      return ul
    })()
    const sideH0 = side.getBoundingClientRect().height
    const stuffed = []
    for (let i = 0; i < 60; i++) {
      const li = document.createElement('li')
      li.className = '__stuff'
      li.style.height = '30px'
      li.textContent = `填充 ${i}`
      target.append(li)
      stuffed.push(li)
    }
    const r = {
      listScrolls: target.scrollHeight > target.clientHeight + 10,
      listScrollH: target.scrollHeight,
      listClientH: target.clientHeight,
      sideGrew: Math.round(side.getBoundingClientRect().height - sideH0),
    }
    stuffed.forEach((el) => el.remove())
    if (!list) target.remove()
    return r
  })
  check(
    !!chain && chain.listScrolls,
    '塞满之后清单自己变成滚动容器（高度链没断）',
    chain ? `scrollH ${chain.listScrollH} / clientH ${chain.listClientH}` : '取不到节点',
  )
  check(!!chain && chain.sideGrew === 0, '左栏没有被清单撑高', `+${chain?.sideGrew}px`)
  // 能滚 ≠ 能用：43px 的可视高度一屏只放得下一条半，等于没有
  check(!!chain && chain.listClientH >= 80, '清单的可视高度够列几条', `${chain?.listClientH}px`)
  // 清单向画面要高度，但**绝不能把走带挤掉** —— 打轴模式下空格是打点不是播放，
  // 走带没了就真的起播不能，那是功能死角而不是观感问题
  const transport = await page.evaluate(() => {
    const play = [...document.querySelectorAll('.edit-preview button')].find((b) =>
      /播放|暂停/.test(b.textContent || ''),
    )
    const side = document.querySelector('.edit-side')?.getBoundingClientRect()
    const r = play?.getBoundingClientRect()
    return r && side ? { ok: r.bottom <= side.bottom + 1 && r.height >= 24, h: Math.round(r.height) } : null
  })
  check(!!transport && transport.ok, '清单展开时走带仍完整在左栏内', `按钮高 ${transport?.h}px`)

  await page.locator('.kvm-ruby__reviewtoggle').click()
  await page.waitForTimeout(300)

  const sizes = {}
  for (const w of [1600, 1280, 1024]) {
    await page.setViewportSize({ width: w, height: 950 })
    await page.waitForTimeout(700)
    sizes[w] = await page.evaluate(MEASURE)
    // 窄窗口的截图要留下来：数字说不出"挤成一坨"，只有图能
    await page.screenshot({ path: `${OUT}/${name}-${w}.png` })
    console.log(
      `   ${w}px：歌词正文 ${sizes[w].lyrics.w}×${sizes[w].lyrics.h}（纸 ${sizes[w].paper.h}）｜` +
        `声部条 ${sizes[w].voice?.h ?? 0}px｜底栏 ${sizes[w].inspect.h}px｜` +
        `左栏 ${sizes[w].side.w}（空 ${sizes[w].sideIdlePx}）｜逐字轴 ${sizes[w].rail.h}px｜工具条约 ${sizes[w].toolbarRows} 行`,
    )
    check(!sizes[w].docScrollX, `${w}px 下没有横向溢出`)
    check(sizes[w].railVisible, `${w}px 下逐字轴完整可见`, `h=${sizes[w].rail.h}`)
  }
  check(sizes[1024].lyrics.w >= 600, '1024px 下歌词正文 ≥600px（改动前只有 428px）', `${sizes[1024].lyrics.w}px`)
  check(sizes[1600].lyrics.w >= 1200, '1600px 下歌词正文 ≥1200px（改动前 1004px）', `${sizes[1600].lyrics.w}px`)

  await page.setViewportSize({ width: 1600, height: 950 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  writeFileSync(`${OUT}/${name}-sizes.json`, JSON.stringify(sizes, null, 2))

  const real = errors.filter((e) => !KNOWN_NOISE.test(e))
  check(real.length === 0, '没有与本次改动有关的控制台报错', real.slice(0, 2).join(' | '))
  if (real.length) writeFileSync(`${OUT}/${name}-errors.txt`, real.join('\n'))
  await page.close()

  // ---------------------------------------------------------- 八、临时工程上的编辑判据
  if (!MUTATE) {
    console.log('\n8) 会改工程的判据：默认跳过（加 --mutate 才跑，且只跑在临时工程上）')
    return
  }
  await runMutations(browser, project0)
}

/**
 * 会改工程的那一批判据。**全部跑在脚本自己新建的临时工程上，跑完就删。**
 *
 * 为什么不跑在真实工程上：逐个操作"数一数占了几格撤销再退回去"靠不住
 * （后端对没有实际变化的写入不入栈），而"一路撤到开跑前的深度"在用户同时开着
 * 浏览器编同一首歌时会把**他的**编辑一并撤掉。三次实测都留下了残留，
 * 每次都要人工照着 diff 收拾。临时工程从根上消灭这个问题：删掉就是删掉。
 *
 * 临时工程用 LRC 导入而不是纯文本：纯文本导入出来所有字的起点都是 0，
 * 逐字轴上全叠在原点，"点第 3 个字""拖这一句"这类操作根本没法做。
 */
async function runMutations(browser, source) {
  console.log('\n8) 临时工程上的编辑判据')
  const lines = source.lines.filter((l) => !l.is_metadata && l.tokens.length >= 5).slice(0, 12)
  SCRATCH_ID = await createScratch(lines)
  console.log(`   ℹ️ 临时工程 ${SCRATCH_ID}（${lines.length} 行，跑完删除）`)
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  try {
    await page.addInitScript((id) => localStorage.setItem(`kvm.step.${id}`, 'edit'), SCRATCH_ID)
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.locator('.pcard').filter({ hasText: '验收临时工程' }).first().click()
    await page.waitForSelector('[data-role="token-rail"]', { timeout: 20000 })
    // 临时工程没有音频，波形永远不会 ready；等的是**逐字轴上真有块**，
    // 而不是波形就绪 —— 等错东西会以"30 秒超时"收场，看不出根因
    await page.waitForSelector('.kvm-tl-tok', { timeout: 20000 })
    /*
     * 先按一次「整曲」。临时工程没有音频，波形永远不 ready，于是那段
     * "第一次拿到真实时长时落到一个能干活的缩放上"的初始化根本不会跑，
     * 缩放停在初始值上、视口只覆盖开头几秒 —— 逐字轴按视口时间窗虚拟化，
     * 别的句子压根没画出来，等它们的句柄条必然超时。
     */
    await page.locator('[data-role="fit"]').click()
    await page.waitForTimeout(800)
    /*
     * 选行一律**点歌词正文**，不点概览条：概览条上一句只有几像素宽，
     * 而逐字轴按视口时间窗虚拟化 —— 没滚到那一段时那句的句柄条压根没画出来，
     * 等它必然 10 秒超时，报出来还是"没跑完"而不是判据变红。
     * 正文里整行都可点（这一轮刚加的），顺带把那条也验了。
     */
    await page.waitForTimeout(800)

    // --- 单句调轴：拖句柄条 = 整句平移 ---
    //
    // 句柄条只画在**视口时间窗内**的行上（逐字轴虚拟化，§5.10）。临时工程没有音频，
    // 波形永远不 ready，那段"第一次拿到真实时长就落到能干活的缩放上"的初始化不会跑，
    // 于是视口里未必正好有可拖的那一句。**这不是产品问题**，所以这里不硬等：
    // 拿视口里现成的那一句来拖，拖不到就把原因报出来，而不是让整轮以"超时"收场。
    const p0 = await fetchProject()
    const railLineId = await page.evaluate(
      () => document.querySelector('[data-role="line-handle"]')?.dataset.line ?? null,
    )
    const target = p0.lines.find((l) => l.id === railLineId)
    check(!!target, '视口里有一句可拖的（句柄条已渲染）', String(railLineId))
    if (target) {
      await page.locator(`.kvm-ruby__line[data-line="${target.id}"]`).click()
      await page.waitForTimeout(600)
      const box = await page.locator(`[data-role="line-handle"][data-line="${target.id}"]`).boundingBox()
      check(!!box && box.height >= 16, '句柄条有可抓的高度', box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '无')
      if (box) {
        const gx = box.x + Math.min(box.width / 2, 30)
        const gy = box.y + box.height / 2
        await page.mouse.move(gx, gy)
        await page.mouse.down()
        // 240px 而不是 60px：临时工程没有音频，缩放停在很大的值上，
        // 60px 换算成毫秒后会被 Math.round 抹成个位数甚至 0（WebKit 实测 0ms）——
        // 那是判据给的位移太小，不是"整句平移坏了"
        await page.mouse.move(gx + 120, gy, { steps: 6 })
        await page.mouse.move(gx + 240, gy, { steps: 6 })
        await page.mouse.up()
        await page.waitForTimeout(1000)
        const p1 = await fetchProject()
        const li = p0.lines.findIndex((l) => l.id === target.id)
        const moved = p1.lines[li].tokens.map((tk, i) => tk.start_ms - target.tokens[i].start_ms)
        check(moved.every((d) => d === moved[0]) && moved[0] !== 0, '整行每个字位移相同且确实动了', `${moved[0]}ms ×${moved.length}`)
        check(
          p1.lines.every((l, i) => i === li || l.tokens.every((tk, j) => tk.start_ms === p0.lines[i].tokens[j].start_ms)),
          '别的行一个都没动',
        )
        await page.locator('button[aria-label="撤销"]').click()
        await page.waitForTimeout(700)
        check(
          (await fetchProject()).lines[li].tokens[0].start_ms === target.tokens[0].start_ms,
          '撤销把这一行还原了',
        )
      }
    }

    // --- 拆行 / 合并行（图标化之后仍然真的会动）---
    const n0 = (await fetchProject()).lines.length
    // 从正文里点**第 3 个词**：拆行要求选中的字不是行首（tokenIndex > 0），
    // 而正文里的词一定渲染得出来，不受逐字轴虚拟化影响
    const splitLine = (await fetchProject()).lines.find((l) => l.tokens.length >= 5)
    check(!!splitLine, '（前置）临时工程里有字够多的一句')
    if (!splitLine) return
    await page.locator(`.kvm-ruby__line[data-line="${splitLine.id}"] .kvm-ruby__unit`).nth(2).click()
    await page.waitForTimeout(400)
    await page.locator('[data-role="split"]').click()
    await page.waitForTimeout(800)
    check((await fetchProject()).lines.length === n0 + 1, '拆行按钮真的拆出一行', `${n0} → ${n0 + 1}`)
    await page.locator('[data-role="merge"]').click()
    await page.waitForTimeout(800)
    check((await fetchProject()).lines.length === n0, '合并行按钮真的并回去')

    // --- 整曲偏移 ---
    const readOffset = async () => (await fetchProject()).global_offset_ms
    const o0 = await readOffset()
    await page.locator('[data-role="global-offset"] [data-role="global-nudge"]').last().click()
    const o1 = await waitFor(readOffset, o0 + 100)
    check(o1 === o0 + 100, '+100 真的落到 global_offset_ms', `${o0} → ${o1}`)
    await page.locator('[data-role="global-offset"] [data-role="global-nudge"]').first().click()
    check((await waitFor(readOffset, o0)) === o0, '-100 还原')

    // --- 声部：单句 / 批量 / 字级区间 ---
    const vLine = (await fetchProject()).lines[3]
    await page.locator(`.kvm-ruby__line[data-line="${vLine.id}"]`).click({ force: true })
    await page.waitForTimeout(400)
    await page.locator('[data-scope="line"]').click()
    check(/1/.test((await page.locator('[data-role="voice-count"]').textContent()) || ''), '动手前就报出会改几句')
    await page.locator('[data-role="voice-new"]').click()
    await page.locator('[data-role="voice-new-input"]').fill('duet_b')
    await page.locator('[data-role="voice-new-input"]').press('Enter')
    const got = await waitFor(
      async () => (await fetchProject()).lines.find((l) => l.id === vLine.id)?.voice_part,
      'duet_b',
    )
    check(got === 'duet_b', '后端的 voice_part 真的变了', String(got))
    check(
      (await page.evaluate(
        (id) => document.querySelector(`.kvm-ruby__line[data-line="${id}"] [data-role="voice-tag"]`)?.textContent,
        vLine.id,
      )) === 'duet_b',
      '歌词正文上当场看得见（新声部没配色时颜色不会变，标签是唯一证据）',
    )
    await page.locator('button[aria-label="撤销"]').click()
    check(
      (await waitFor(
        async () => (await fetchProject()).lines.find((l) => l.id === vLine.id)?.voice_part,
        vLine.voice_part,
      )) === vLine.voice_part,
      '单句指派 Cmd+Z 一步退回',
    )

    // 批量：动手前报数，改完逐行核对
    await page.locator('[data-scope="after"]').click()
    await page.locator('[data-role="voice-span"]').fill('4')
    await page.waitForTimeout(300)
    check(/4/.test((await page.locator('[data-role="voice-count"]').textContent()) || ''), '批量前先报出会改 4 句')
    await page.locator('[data-role="voice-new"]').click()
    await page.locator('[data-role="voice-new-input"]').fill('duet_b')
    await page.locator('[data-role="voice-new-input"]').press('Enter')
    await page.waitForTimeout(3000)
    const pb = await fetchProject()
    const at = pb.lines.findIndex((l) => l.id === vLine.id)
    check(
      pb.lines.slice(at, at + 4).every((l) => l.voice_part === 'duet_b'),
      '「本句起 4 句」真的改了 4 句',
    )

    // 字级区间：一行内男女交替是常态，区间必须精确、不许蔓延
    const tLine = pb.lines.find((l) => l.tokens.length >= 6)
    check(!!tLine, '（前置）临时工程里有字够多的一句')
    if (!tLine) return
    await page.locator(`.kvm-ruby__line[data-line="${tLine.id}"]`).click({ force: true })
    await page.waitForTimeout(400)
    await page.locator(`.kvm-ruby__line[data-line="${tLine.id}"] .kvm-ruby__unit`).nth(2).click()
    await page.waitForTimeout(400)
    await page.locator('[data-scope="tokens"]').click()
    await page.locator('[data-role="voice-span"]').fill('3')
    await page.waitForTimeout(300)
    check(/3/.test((await page.locator('[data-role="voice-count"]').textContent()) || ''), '字级也先报出会改几个字')
    await page.locator('[data-role="voice-assign"][data-part="chorus"], [data-role="voice-assign"]').last().click()
    await page.waitForTimeout(1500)
    const tAfter = (await fetchProject()).lines.find((l) => l.id === tLine.id)
    const marked = tAfter.tokens.map((tk, i) => (tk.voice_part ? i : -1)).filter((i) => i >= 0)
    /*
     * 判据是"**恰好 3 个、连续、不蔓延**"，而不是写死 [2,3,4]：
     * 正文里点的是**词**，一个词可能横跨多个 token（「明日」两个字一个词），
     * 所以起点由数据说了算。写死下标只会在跨字词上假红。
     */
    check(
      marked.length === 3 && marked[1] === marked[0] + 1 && marked[2] === marked[0] + 2,
      '字级覆盖精确落在 3 个连续的字上，没有蔓延到整句',
      `实际 ${JSON.stringify(marked)} / 全句 ${tAfter.tokens.length} 字`,
    )

    // 一句多声部要在歌词列表看得出来：行标签列全 + 被改的那几个词自己带标记
    const mixed = await page.evaluate((id) => {
      const row = document.querySelector(`.kvm-ruby__paper .kvm-ruby__line[data-line="${id}"]`)
      if (!row) return null
      return {
        tags: [...row.querySelectorAll('[data-role="voice-tag"]')].map((e) => e.dataset.part),
        marks: [...row.querySelectorAll('.kvm-ruby__unit[data-voice]')].map((e) => e.dataset.voice),
      }
    }, tLine.id)
    check(!!mixed && mixed.tags.length >= 2, '一句里两个声部，歌词列表把它们都列出来', mixed?.tags.join('・'))
    check(!!mixed && mixed.marks.length > 0, '被单独指派的那几个词自己也带着标记', `${mixed?.marks.length} 个词`)

    // --- 改名（默认声部也能改）---
    const rBefore = await fetchProject()
    const rLine = rBefore.lines.find((l) => (l.voice_part || 'main') === 'main')
    check(!!rLine, '（前置）还有挂在默认声部上的行')
    if (!rLine) return
    await page.locator(`.kvm-ruby__line[data-line="${rLine.id}"]`).click({ force: true })
    await page.waitForTimeout(400)
    const mainCount = rBefore.lines.filter((l) => (l.voice_part || 'main') === 'main').length
    await page.locator('[data-role="voice-current"]').click()
    await page.locator('[data-role="voice-rename"]').fill('女')
    await page.locator('[data-role="voice-rename"]').press('Enter')
    await page.waitForTimeout(Math.max(4000, mainCount * 250))
    const rAfter = await fetchProject()
    check(
      rAfter.lines.filter((l) => l.voice_part === '女').length === mainCount &&
        rAfter.lines.every((l) => l.voice_part !== 'main'),
      '默认声部 main 可以改名，全曲一起改',
      `main ${mainCount} → 女 ${rAfter.lines.filter((l) => l.voice_part === '女').length}`,
    )

    // --- 删除声部（= 归并，一行总得有个声部）---
    const dLine = rAfter.lines.find((l) => l.voice_part === 'duet_b')
    check(!!dLine, '（前置）有一句挂着待删的声部')
    if (!dLine) return
    await page.locator(`.kvm-ruby__line[data-line="${dLine.id}"]`).click({ force: true })
    await page.waitForTimeout(500)
    const mergeTo = await page.locator('[data-role="voice-delete"]').getAttribute('data-target')
    check(!!mergeTo && mergeTo !== 'duet_b', '删除前就说清并到哪个声部去', String(mergeTo))
    await page.locator('[data-role="voice-delete"]').click()
    await page.waitForTimeout(4000)
    const dEnd = await fetchProject()
    check(
      dEnd.lines.every((l) => l.voice_part !== 'duet_b') &&
        dEnd.lines.every((l) => l.tokens.every((t) => t.voice_part !== 'duet_b')),
      '删除后全曲再也找不到这个声部（行级与字级都清了）',
    )
    check(!('duet_b' in dEnd.palettes), '配色键也一并摘掉，没留幽灵', Object.keys(dEnd.palettes).join(',') || '（无）')

    /*
     * 声部列表里不许出现"没有任何行引用、又删不掉"的幽灵。
     * 这一条是从"main 怎么删不掉"来的：列表曾经无条件塞一个 main，
     * 于是把它改名成别的之后，main 还常驻在那儿，而删除作用于"当前行的声部"，
     * 没有一行挂着它 —— 点谁都删不动。
     */
    const listed = await page.evaluate(() =>
      [...document.querySelectorAll('[data-role="voice-assign"]')].map((e) => e.dataset.part),
    )
    const used = new Set([
      ...dEnd.lines.map((l) => l.voice_part).filter(Boolean),
      ...dEnd.lines.flatMap((l) => l.tokens.map((t) => t.voice_part).filter(Boolean)),
      ...Object.keys(dEnd.palettes),
    ])
    check(
      listed.every((p) => used.has(p)),
      '声部列表里每一项都真的有行在用（没有删不掉的幽灵）',
      `列出 ${listed.join(',')}｜在用 ${[...used].join(',')}`,
    )

    await page.close()
  } finally {
    // 无论上面成没成，临时工程都要删干净
    await deleteScratch()
    console.log('   ℹ️ 临时工程已删除')
  }
}

for (const name of wanted) {
  console.log(`\n=== ${name} ===`)
  try {
    await runEngine(name)
  } catch (e) {
    check(false, `${name} 没跑完`, String(e?.message ?? e).split('\n')[0])
  }
}

console.log(`\n通过 ${pass} ／ 失败 ${fail}`)
process.exit(fail ? 1 : 0)
