// 「编辑」舞台验收：跟随播放高亮 + 控件统一。
//
//   用法：node scripts/verify-edit-follow.mjs [chromium|webkit]   不带参数则两个都跑
//
// ## 判据是怎么设计成"能区分成功与失败"的
//
// **一、高亮跟得对不对 —— 用独立实现当真值，不拿界面自证**
// 脚本这边按契约（§4.2 句内空隙 / §8.5 行可重叠）在 Node 里**另写一份**
// "此刻该高亮哪一行"，拿它去核对页面上的 `[data-playing]`。两份实现来自同一份
// 规格但不是同一段代码，所以"两边都错成一样"不会静默通过。
// 采样点刻意避开行边界 ±150ms：那里差一帧就会换行，测的是抖动不是正确性。
//
// **二、有没有每帧重渲 —— MutationObserver + 阳性对照**
// 直接数歌词纸子树上的 DOM 变更次数。命令式实现下一次跨行只该产生个位数变更，
// 而"把 playheadMs 订阅成 React state"会让整屏歌词每帧重建，变更数与帧数同阶。
// 两者差三个数量级，判据不可能模棱两可。
//
// **但只测到"几乎没有变更"是不够的** —— 观察器自己坏掉也是这个结果。
// 所以同时在**波形播放头**那个 div 上挂一个同样的观察器：它的 style.transform
// 是逐帧命令式改写的，必须数出接近帧数的变更。阳性对照过不了就说明测量工具本身
// 不可信，这一轮结论作废（CLAUDE.md §8.9「测量工具必须能证伪」）。
//
// **三、自动滚动克制 —— 先证明"本来会滚"，再证明"这次没滚"**
// 只断言"用户滚动后 scrollTop 没变"会假通过：万一自动滚动压根就没工作，
// 它当然不会变。所以每个抑制用例都要求**同一段时间里高亮确实换过行**
// （也就是自动滚动本该被触发），且事先已经验证过不抑制时它会滚。
//
// ## 已知噪声
// WebKit 下 JASSUB 的 worker 被 COEP 拦掉（另有改动在修），控制台会有
// `Refused to load ... worker` 与随之而来的字幕层报错。这些**不计入本脚本的结论**。

import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui-edit-follow'
const APP = 'http://localhost:5173/'
const API = 'http://127.0.0.1:8000'
const ENGINES = { chromium, webkit }
const wanted = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit']

mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  ok ? pass++ : fail++
  console.log(`   ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

/** 与 WebKit 的 COEP/JASSUB 已知问题有关的控制台噪声，不计入结论 */
const KNOWN_NOISE = /Cross-Origin-Embedder-Policy|jassub|worker\.js|字幕渲染器|字幕预览不可用|SubtitleOverlay/i

// ---------------------------------------------------------------- 真值（独立实现）

/**
 * "此刻该高亮哪一行"的**第二实现**，只依据契约，不看前端代码：
 * 跳过制作名单行、跳过空行；取所有「已经开唱」的行里起点最晚的那个
 * （空隙期间沿用上一行；行可重叠时取最新开始的那句）。
 */
function expectedLineId(project, audioMs) {
  const t = audioMs - project.global_offset_ms
  let id = null
  let best = -Infinity
  for (const line of project.lines) {
    if (line.is_metadata || !line.tokens.length) continue
    const s = line.tokens[0].start_ms
    if (s > t) continue
    if (s >= best) {
      best = s
      id = line.id
    }
  }
  return id
}

/** 全部行起点，用来判断某个采样点离换行边界够不够远 */
function lineStarts(project) {
  return project.lines
    .filter((l) => !l.is_metadata && l.tokens.length)
    .map((l) => l.tokens[0].start_ms)
}

const nearBoundary = (starts, offset, ms, guard = 150) =>
  starts.some((s) => Math.abs(ms - (s + offset)) < guard)

// ---------------------------------------------------------------- 页面工具

/** 读页面当前状态。播放头取自预览走带上的时钟文字，与 store 是同一次写入 */
const SNAPSHOT = () => {
  const paper = document.querySelector('.kvm-ruby__paper')
  const clock = [...document.querySelectorAll('.edit-preview span')]
    .map((s) => s.textContent?.trim() ?? '')
    .find((s) => /^\d+:\d{2}\.\d{2}$/.test(s))
  const m = clock ? /^(\d+):(\d{2})\.(\d{2})$/.exec(clock) : null
  const playing = paper?.querySelector('[data-playing]')
  const railLine = document.querySelector('[data-role="token-rail"]')?.dataset.line ?? null
  /*
   * 时间轴这边"正在唱的是哪一句"的载体。
   *
   * 原先读的是行轨（`.kvm-tl-line[data-playing]`），行轨已经拆掉——它把整句歌词
   * 文本画在波形上，与右侧正文重复且盖住能量曲线。现在句子层落在**概览条**上，
   * 每句一个不含文本的小块，正在唱的那块带 `data-playing`。
   */
  const stripPlaying = document.querySelector('.kvm-tl-ov[data-playing]')?.dataset.line ?? null
  return {
    ms: m ? (+m[1] * 60 + +m[2]) * 1000 + +m[3] * 10 : null,
    playingLine: playing instanceof HTMLElement ? (playing.dataset.line ?? null) : null,
    activeLine:
      paper?.querySelector('[data-active]') instanceof HTMLElement
        ? paper.querySelector('[data-active]').dataset.line
        : null,
    railLine,
    stripPlaying,
    scrollTop: paper ? Math.round(paper.scrollTop) : -1,
    scrollHeight: paper?.scrollHeight ?? 0,
    clientHeight: paper?.clientHeight ?? 0,
    /**
     * 高亮行**整行**是否落在歌词纸可视区内。
     * 判据不能用"有重叠"——只露出半行的情况会被算成可见，
     * 而那恰恰是自动滚动该出手却没出手的样子。
     */
    playingVisible: (() => {
      if (!(paper instanceof HTMLElement) || !(playing instanceof HTMLElement)) return null
      const pr = paper.getBoundingClientRect()
      const er = playing.getBoundingClientRect()
      return er.top >= pr.top - 1 && er.bottom <= pr.bottom + 1
    })(),
  }
}

/** 每 `everyMs` 采一次，共 `durMs` */
async function sample(page, durMs, everyMs = 220) {
  const out = []
  const end = Date.now() + durMs
  while (Date.now() < end) {
    out.push(await page.evaluate(SNAPSHOT))
    await page.waitForTimeout(everyMs)
  }
  return out
}

async function setPlaying(page, want) {
  const label = want ? '播放' : '暂停'
  const btn = page.locator('.edit-preview button', { hasText: label }).first()
  if ((await btn.count()) > 0) await btn.click()
}

/**
 * 跳到某个时刻。走走带上的进度条（`fill` 会用原生 setter 赋值再派发事件，
 * React 的 value tracker 拦不住它——直接 `input.value = x` 会被 React 当成没变，
 * 这一步曾经静默失败，表现为"seek 完时间还在原处"）。
 *
 * **seek 不是滚动手势**，所以它不会触发"用户在滚"的抑制——正好拿来当
 * "本该发生一次自动滚动"的确定性触发器。
 */
async function seek(page, ms) {
  /*
   * **不能用 `fill()`**：它会先 focus 进度条，于是正在改写的那个行内输入框被 blur、
   * 触发 onBlur 提交，改写态当场结束。后面那条"改写期间不抢视口"的判据因此
   * 测不到自己想测的东西 —— 量的时候改写早已退出，滚动是**正确行为**，
   * 却会被记成"抢视口"（或反过来假通过）。
   *
   * 所以自己派事件、不碰焦点。value 必须用原型上的原生 setter 赋值：
   * 直接 `el.value = x` 会被 React 的 value tracker 当成没变，静默失效。
   */
  await page.evaluate((v) => {
    // 走带上有两个 range（进度条、音量），第一个才是进度条
    const el = document.querySelector('.edit-preview input[type="range"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, ms)
  await page.waitForTimeout(450)
}

// ---------------------------------------------------------------- 主流程

const projects = await fetch(`${API}/api/projects/`).then((r) => r.json())
// 挑行数最多、且素材齐的那个：验收要的是"真的能播 + 有足够多的换行"
const target = projects.find((p) => p.id === 'cd4aed3df12e') ?? projects[0]
const project = await fetch(`${API}/api/projects/${target.id}`).then((r) => r.json())
const starts = lineStarts(project)
const offset = project.global_offset_ms

console.log(`工程：${project.title}（${starts.length} 行，offset ${offset}ms）\n`)

/**
 * 跑完一个引擎。**页面中途被重载就整轮作废重来**（外层重试），不要把半截数据
 * 当结论：dev server 在别的改动落盘时会整页刷新，届时计数器归零、
 * "歌词纸零变更"这种最关键的判据会以最漂亮的姿态假通过。
 */
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

async function runEngineOn(name, browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const consoleErrors = []
  let reloads = 0
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })

  // 直接落进「编辑」步骤：App 按工程记步骤（kvm.step.<id>）
  await page.addInitScript((id) => {
    localStorage.setItem(`kvm.step.${id}`, 'edit')
  }, project.id)

  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) reloads++
  })
  await page.locator('.pcard', { hasText: project.title }).first().click()
  await page.waitForSelector('.kvm-ruby__paper', { timeout: 20000 })
  await page.waitForSelector('[data-role="token-rail"]', { timeout: 20000 })
  await page.waitForTimeout(2500) // 让音轨解码完

  // ---------------------------------------------------------- 一、控件统一
  console.log('\n1) 控件统一')
  const controls = await page.evaluate(() => {
    const stage = document.querySelector('.stage--edit')
    const txt = (el) => (el.textContent ?? '').replace(/\s+/g, '')
    const btns = [...document.querySelectorAll('button')]
    return {
      selects: stage ? stage.querySelectorAll('select').length : -1,
      // 工具条上现在有**两组** radio（试听速率、波形画哪条轨），
      // 各自定位——早先笼统数 `.kvm-tl-seg label` 会把两组加在一起，
      // 表现为"速率不是 3 档""有两档同时选中"，而实际两组各自都是对的
      rateGroups: document.querySelectorAll('[aria-label="速率"].kvm-tl-seg').length,
      rateItems: document.querySelectorAll('[aria-label="速率"].kvm-tl-seg label').length,
      rateOn: [...document.querySelectorAll('[aria-label="速率"].kvm-tl-seg label[data-on]')].map((l) => txt(l)),
      waveSrcGroups: document.querySelectorAll('[aria-label="波形"].kvm-tl-seg').length,
      waveSrcOn: [...document.querySelectorAll('[aria-label="波形"].kvm-tl-seg label[data-on]')].map((l) => txt(l)),
      undoBtns: btns.filter((b) => txt(b) === '撤销').length,
      redoBtns: btns.filter((b) => txt(b) === '重做').length,
      originalBtns: btns.filter((b) => txt(b) === '原声').length,
      instrumentalBtns: btns.filter((b) => txt(b) === '伴奏').length,
      lockLabels: btns.filter((b) => txt(b).includes('锁定')).map((b) => txt(b)),
      shiftLabelled: !!document.querySelector('.edit-inspect__timing .kvm-ruby__label + .kvm-ruby__label, .edit-inspect__timing'),
      togglesWithoutAriaPressed: btns.filter(
        (b) => b.dataset.on !== undefined && !b.hasAttribute('aria-pressed'),
      ).length,
    }
  })
  check(controls.selects === 0, '编辑舞台没有下拉框', `select=${controls.selects}`)
  check(controls.rateGroups === 1 && controls.rateItems === 3, '速率是一组 3 档按钮 radio')
  check(controls.rateOn.length === 1, '速率恰好一档处于选中态', controls.rateOn.join(','))
  check(
    controls.waveSrcGroups === 1 && controls.waveSrcOn.length === 1,
    '波形音源是另一组独立的 radio，且恰好一档选中',
    controls.waveSrcOn.join(','),
  )
  check(controls.undoBtns === 1 && controls.redoBtns === 1, '撤销/重做全页各只有一处', `撤销${controls.undoBtns} 重做${controls.redoBtns}`)
  check(
    controls.originalBtns === 1 && controls.instrumentalBtns === 1,
    '原声/伴奏全页只有一组',
    `原声${controls.originalBtns} 伴奏${controls.instrumentalBtns}`,
  )
  check(
    controls.lockLabels.every((l) => l !== '锁定'),
    '两把锁各自说清锁的是什么',
    controls.lockLabels.join('｜'),
  )
  check(controls.togglesWithoutAriaPressed === 0, '所有开关按钮都有 aria-pressed', `缺${controls.togglesWithoutAriaPressed}`)

  // 键盘可达性：Tab 进 radio 组 → 焦点可见 → 方向键换档
  const kbd = await (async () => {
    await page.evaluate(() => document.querySelector('[data-role="tap"]')?.focus())
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => {
      const el = document.activeElement
      const label = el?.closest('.kvm-tl-seg label')
      if (!el || el.type !== 'radio' || !label) return null
      return {
        visible: el.matches(':focus-visible'),
        outline: getComputedStyle(label).outlineWidth,
        before: label.textContent?.trim(),
      }
    })
    if (!focused) return null
    await page.keyboard.press('ArrowRight')
    const after = await page.evaluate(() => ({
      on: document.querySelector('.kvm-tl-seg label[data-on]')?.textContent?.trim(),
    }))
    return { ...focused, after: after.on }
  })()
  check(!!kbd, 'Tab 能落到速率 radio 上')
  if (kbd) {
    check(kbd.visible && parseFloat(kbd.outline) >= 2, '焦点态可见', `outline=${kbd.outline}`)
    check(kbd.after !== kbd.before, '方向键切换档位', `${kbd.before} → ${kbd.after}`)
    // 还原成 1x，后面的计时判据都按 1x 算
    await page.locator('.kvm-tl-seg label', { hasText: '1x' }).first().click()
  }

  // ---------------------------------------------------------- 二、跟随高亮
  console.log('\n2) 跟随播放高亮')
  const geom = await page.evaluate(SNAPSHOT)
  check(
    geom.scrollHeight > geom.clientHeight + 40,
    '歌词纸确实可滚（否则后面的滚动判据无意义）',
    `${geom.scrollHeight} > ${geom.clientHeight}`,
  )

  // 逐帧变更计数器 + 阳性对照。两个观察器配置完全一样，只是挂在不同节点上
  await page.evaluate(() => {
    const paper = document.querySelector('.kvm-ruby__paper')
    // 波形播放头：style.transform 是逐帧命令式改写的，用作"观察器真的在数"的对照。
    // 必须精确选中它——早先选的是 `div[style*=translate3d]`，document 顺序上先命中的
    // 是刻度尺轨道（只在滚动时才动），对照因此数出 44 次而不是接近帧数，
    // 于是"歌词纸几乎没有变更"这个结论一度无法与"观察器坏了"区分开。
    const head = document.querySelector('[data-role="playhead"]')
    const cfg = { subtree: true, childList: true, attributes: true, characterData: true }
    const st = { paper: 0, control: 0, frames: 0, t0: performance.now() }
    new MutationObserver((rs) => (st.paper += rs.length)).observe(paper, cfg)
    new MutationObserver((rs) => (st.control += rs.length)).observe(head, cfg)
    const tick = () => {
      st.frames++
      st.raf = requestAnimationFrame(tick)
    }
    st.raf = requestAnimationFrame(tick)
    window.__kvm = st
  })

  /*
   * 一律**从头播**，不 seek 到中段再播。
   *
   * WebKit 实测：seek 到 40s 再播，6 秒里播放头只走了 1.05s（代理 MP4 在那一端
   * 从中段起播会长时间卡顿）。那是媒体链路的问题、与本次改动无关，但它会让
   * "12 秒里应当换 4 次行"这类判据凭空变红。从头播两端都顺，且本曲前 13 秒
   * 就有 5 行，足够把高亮推出视口、把自动滚动逼出来。
   */
  await seek(page, 0)
  await setPlaying(page, true)
  await page.waitForTimeout(600)
  const run = await sample(page, 16000)
  const perf = await page.evaluate(() => {
    const s = window.__kvm
    // 计数器不见了 = 页面在测量期间重新加载过（dev server 的 HMR 最常见）。
    // 这时的数字毫无意义，必须报出来而不是当成"变更 0 次"通过
    if (!s) return null
    cancelAnimationFrame(s.raf)
    return { ...s, elapsed: performance.now() - s.t0 }
  })
  await setPlaying(page, false)

  const moved = run.filter((s) => s.ms !== null)
  const advanced = moved.length > 1 && moved[moved.length - 1].ms - moved[0].ms > 6000
  check(advanced, '播放头真的在走', moved.length ? `${moved[0].ms} → ${moved[moved.length - 1].ms}ms` : '无采样')

  const seen = []
  for (const s of run) if (s.playingLine && s.playingLine !== seen[seen.length - 1]) seen.push(s.playingLine)
  check(seen.length >= 3, '跨行时高亮确实换行', `换了 ${seen.length - 1} 次`)

  const order = seen.map((id) => project.lines.findIndex((l) => l.id === id))
  check(
    order.every((v, i) => i === 0 || v > order[i - 1]),
    '换行顺序单调向后',
    order.join('→'),
  )

  const judged = run.filter((s) => s.ms !== null && !nearBoundary(starts, offset, s.ms))
  const wrong = judged.filter((s) => s.playingLine !== expectedLineId(project, s.ms))
  check(
    judged.length >= 20 && wrong.length === 0,
    '高亮行与独立实现算出来的真值一致',
    `核对 ${judged.length} 个采样点，错 ${wrong.length}`,
  )
  if (wrong.length) {
    console.log(
      '      前 3 个不一致：',
      wrong.slice(0, 3).map((s) => `${s.ms}ms 页面=${s.playingLine} 真值=${expectedLineId(project, s.ms)}`),
    )
  }

  const bothShown = run.filter((s) => s.playingLine && s.stripPlaying)
  check(
    bothShown.length > 0 && bothShown.every((s) => s.playingLine === s.stripPlaying),
    '歌词纸与时间轴概览条指的是同一行',
    `比对 ${bothShown.length} 次`,
  )
  /*
   * 「选中」与「正在唱」已经合成一件事（用户要求：不要区分这两者）。
   * 这条判据因此**整个反过来**：从"必须出现过落在不同行的时刻"改成
   * "任何一个采样点上都不许分家"。
   *
   * 只断言"没分家"会假通过 —— 两个标记都不存在也满足它。所以先要求确实
   * 采到了足够多两者都在的时刻，再要求它们逐点相等。
   */
  const bothMarks = run.filter((s) => s.playingLine && s.activeLine)
  const split = bothMarks.filter((s) => s.playingLine !== s.activeLine)
  check(bothMarks.length >= 20, '（前置）采到了足够多"两个标记都在"的时刻', `${bothMarks.length} 个`)
  check(
    split.length === 0,
    '播放高亮与选中始终落在同一行（两者已合并为一件事）',
    split.length ? `分家 ${split.length} 次，例如 ${split[0].playingLine} vs ${split[0].activeLine}` : '',
  )

  // ---------------------------------------------------------- 三、渲染开销
  console.log('\n3) 渲染开销')
  check(!!perf, '测量期间页面没有重新加载（计数器还在）')
  if (perf) {
    const sec = perf.elapsed / 1000
    const fps = perf.frames / sec
    const lineChanges = Math.max(1, seen.length - 1)
    console.log(
      `   ${sec.toFixed(1)}s：帧 ${perf.frames}（${fps.toFixed(1)} fps）｜` +
        `歌词纸变更 ${perf.paper} 次｜对照（播放头）${perf.control} 次（${(perf.control / sec).toFixed(1)}/s）｜` +
        `换行 ${lineChanges} 次`,
    )
    /*
     * 对照的基准是**播放头更新频率**，不是帧率：播放头由 rVFC 驱动，
     * 也就是视频帧率（本曲 23.976fps），而不是显示器的 60fps。
     * 一度拿 frames*0.5 当阈值，对照因此"失败"——错的是判据不是被测对象。
     * 这个数正好就是"若把 playheadMs 订阅成 React state，歌词纸会重渲多少次"。
     */
    check(
      perf.control > sec * 15,
      '阳性对照：观察器数得到播放头的逐次更新（否则测量本身不可信）',
      `${perf.control} 次 / ${sec.toFixed(1)}s`,
    )
    /*
     * 阈值随「选中跟着播放走」一起放宽过一次。
     *
     * 以前跨一行只动 `data-playing` 一个属性（命令式），实测 9 次变更；现在选中
     * 与正在唱是同一件事，跨行还会连带移动 `data-active`、词上的 `data-selected`、
     * 以及声部标签，实测 41 次。**这不是回归**：变更数仍然只跟换行次数走，
     * 与帧数无关（4 次换行 41 次变更，而播放头更新了 400 次）。
     *
     * 判据的本意是"没有把 playheadMs 订阅成 React state"，那种写法下变更数会与
     * **帧数**同阶（数百上千次）。所以这里改成按"每次换行摊多少次"来卡，
     * 并保留一条与逐帧更新的距离比 —— 两者都留着，单看任一条都可能被绕过。
     */
    check(
      perf.paper <= lineChanges * 15 + 12,
      '歌词纸的 DOM 变更只与换行次数同阶',
      `${perf.paper} 次 / ${lineChanges} 次换行 = ${(perf.paper / lineChanges).toFixed(1)} 次每行`,
    )
    check(
      perf.paper * 4 < perf.control,
      '歌词纸变更数远低于"每次播放头更新都动"',
      `${perf.paper} vs ${perf.control}`,
    )
    check(fps > 40, '播放期间帧率正常', `${fps.toFixed(1)} fps`)
  }

  // ---------------------------------------------------------- 四、自动滚动克制
  //
  // 抑制类判据全部用「跳到远处的一行」当触发器，而不是等自然换行：
  // 一次 seek 必然换行、必然把高亮行甩出视口，因此"本来会滚"是确定的，
  // 剩下的差别就只有抑制生效与否。等自然换行则受歌曲密度摆布，
  // 上一版就因为 3 秒里只换了一行而得出无意义的绿灯。
  //
  // 注意**不要用 `scrollTop = 0` 来复位**：那会触发 scroll 事件，被正确地
  // 认成"用户在滚"，于是接下来 4 秒的抑制判据全部假通过。
  console.log('\n4) 自动滚动克制')

  /** 跳到 ms，返回 (跳之前, 跳之后) 两个快照 */
  const seekAndWatch = async (ms) => {
    const before = await page.evaluate(SNAPSHOT)
    await seek(page, ms)
    const after = await page.evaluate(SNAPSHOT)
    return { before, after, changed: before.playingLine !== after.playingLine }
  }

  // (a) 播放中：高亮行滚出视口时自动带回来。用的就是上面那一段真实播放的采样
  const scrollValues = new Set(run.map((s) => s.scrollTop))
  const vis = run.filter((s) => s.playingVisible !== null)
  const visibleRatio = vis.filter((s) => s.playingVisible).length / Math.max(1, vis.length)
  check(scrollValues.size > 1, '播放中歌词纸确实自动滚了', `scrollTop 取过 ${scrollValues.size} 个值`)
  check(visibleRatio > 0.9, '高亮行整行绝大多数时间在视口内', `${(visibleRatio * 100).toFixed(0)}%`)

  // (b) 用户手动滚动后不抢视口，且到点自愈
  const box = await page.locator('.kvm-ruby__paper').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  try {
    await page.mouse.wheel(0, -800)
  } catch {
    // WebKit 上 mouse.wheel 不一定可用，退回直接改 scrollTop（走的是同一个 scroll 监听）
    await page.evaluate(() => {
      const p = document.querySelector('.kvm-ruby__paper')
      if (p) p.scrollTop = Math.max(0, p.scrollTop - 800)
    })
  }
  await page.waitForTimeout(200)
  const wheeled = await seekAndWatch(150000)
  check(wheeled.changed, '（前置）seek 确实换了行，本该触发一次自动滚动')
  check(
    wheeled.after.scrollTop === wheeled.before.scrollTop,
    '用户滚动后不抢视口',
    `scrollTop ${wheeled.before.scrollTop} → ${wheeled.after.scrollTop}`,
  )
  await page.waitForTimeout(4200) // 越过 FOLLOW_RESUME_MS
  const healed = await seekAndWatch(180000)
  check(
    healed.changed && healed.after.scrollTop !== healed.before.scrollTop,
    '抑制到点自愈，跟随不会就此永久失效',
    `scrollTop ${healed.before.scrollTop} → ${healed.after.scrollTop}`,
  )

  /*
   * (c) 就地改写行文本时不抢视口。
   *
   * 这里有个会让判据假通过的陷阱：`hover()` / `click()` 会先把目标滚进视口，
   * 那次滚动会**正确地**被认成用户滚动，于是后面 4 秒无论如何都不会自动滚 ——
   * 测到的其实是上一条抑制，不是"正在改写"这一条。所以先把那 4 秒等掉，
   * 让改写态成为此刻唯一还在生效的抑制原因。
   */
  await page.locator('.kvm-ruby__paper .kvm-ruby__line').first().hover()
  await page.locator('[data-role="edit-line-text"]').first().click()
  await page.waitForSelector('.edit-linetext__input')
  await page.waitForTimeout(4300)
  const edited = await seekAndWatch(60000)
  check(edited.changed, '（前置）改写期间 seek 确实换了行')
  // 前置条件必须自己断言：改写态一旦提前结束，"没滚"和"该滚"就分不开了
  check(
    await page.locator('.edit-linetext__input').count() === 1,
    '（前置）量的时候改写态还开着',
  )
  check(
    edited.after.scrollTop === edited.before.scrollTop,
    '就地改写行文本时不抢视口（且已排除"刚滚过"的干扰）',
    `scrollTop ${edited.before.scrollTop} → ${edited.after.scrollTop}`,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const resumed = await seekAndWatch(200000)
  check(
    resumed.changed && resumed.after.scrollTop !== resumed.before.scrollTop,
    '退出改写后跟随恢复',
    `scrollTop ${resumed.before.scrollTop} → ${resumed.after.scrollTop}`,
  )

  // (d) 「跟随」关掉之后不再滚，高亮照常走；再打开又能滚
  await page.locator('[data-role="follow"]').click()
  const offRun = await seekAndWatch(90000)
  check(offRun.changed, '关掉「跟随」后高亮照常换行', `${offRun.before.playingLine} → ${offRun.after.playingLine}`)
  check(
    offRun.after.scrollTop === offRun.before.scrollTop,
    '关掉「跟随」后歌词不再自动滚',
    `scrollTop ${offRun.before.scrollTop} → ${offRun.after.scrollTop}`,
  )
  await page.locator('[data-role="follow"]').click()
  const onAgain = await seekAndWatch(20000)
  check(
    onAgain.after.scrollTop !== onAgain.before.scrollTop,
    '重新打开「跟随」后又能滚（证明上一条不是别的原因造成的）',
    `scrollTop ${onAgain.before.scrollTop} → ${onAgain.after.scrollTop}`,
  )

  // ---------------------------------------------------------- 五、变速
  console.log('\n5) 变速下仍然正确')
  await seek(page, 0)
  await page.locator('.kvm-tl-seg label', { hasText: '0.5x' }).first().click()
  await setPlaying(page, true)
  const slow = await sample(page, 14000, 200)
  await setPlaying(page, false)
  const slowJudged = slow.filter((s) => s.ms !== null && !nearBoundary(starts, offset, s.ms))
  const slowWrong = slowJudged.filter((s) => s.playingLine !== expectedLineId(project, s.ms))
  const slowSpan = slow.filter((s) => s.ms !== null)
  const slowRate =
    slowSpan.length > 1
      ? (slowSpan[slowSpan.length - 1].ms - slowSpan[0].ms) / (slow.length * 200)
      : 0
  check(
    new Set(slow.map((s) => s.playingLine)).size > 1,
    '（前置）0.5x 下确实在播且换过行',
    `实测约 ${slowRate.toFixed(2)}x`,
  )
  check(
    slowJudged.length >= 15 && slowWrong.length === 0,
    '0.5x 下高亮仍与真值一致',
    `核对 ${slowJudged.length} 个采样点，错 ${slowWrong.length}`,
  )
  await page.locator('.kvm-tl-seg label', { hasText: '1x' }).first().click()

  // ---------------------------------------------------------- 六、空隙不熄灭
  //
  // 25s 落在本曲 18.2s→35.3s 那段间奏里：严格按"落在某行首尾之间"判定的话
  // 这里没有任何行命中，高亮会整个熄灭；每句之间的换气空隙同理会造成闪烁。
  console.log('\n6) 间奏期间不熄灭')
  await seek(page, 25000)
  const gap = await page.evaluate(SNAPSHOT)
  check(gap.ms !== null && Math.abs(gap.ms - 25000) < 400, 'seek 真的落到了间奏里', `ms=${gap.ms}`)
  check(
    !!gap.playingLine && gap.playingLine === expectedLineId(project, gap.ms ?? 25000),
    '落在间奏里时沿用上一行，不是空白',
    `line=${gap.playingLine}`,
  )

  // ---------------------------------------------------------- 收尾
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  if (reloads > 0) throw new Error(`页面中途重载了 ${reloads} 次，本轮数据作废`)
  const real = consoleErrors.filter((e) => !KNOWN_NOISE.test(e))
  check(real.length === 0, '没有与本次改动有关的控制台报错', real.slice(0, 2).join(' | '))
  if (real.length) writeFileSync(`${OUT}/${name}-errors.txt`, real.join('\n'))
}

for (const name of wanted) {
  const p0 = pass
  const f0 = fail
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`\n=== ${name}${attempt > 1 ? `（第 ${attempt} 次）` : ''} ===`)
    try {
      await runEngine(name)
      break
    } catch (e) {
      pass = p0
      fail = f0
      const msg = String(e?.message ?? e).split('\n')[0]
      if (attempt === 3) check(false, `${name} 三次都没跑完`, msg)
      else console.log(`   ⚠️ 被打断，整轮作废重来：${msg.slice(0, 100)}`)
    }
  }
}

console.log(`\n通过 ${pass} ／ 失败 ${fail}`)
process.exit(fail ? 1 : 0)
