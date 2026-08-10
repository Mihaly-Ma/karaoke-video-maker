/**
 * 播放器验收：**慢速试听保音高** + **试听混音台（层 × 增益）**。
 *
 *   用法：node scripts/verify-preview-mix.mjs [chromium|webkit]   不带参数则两个都跑
 *
 * 需要 dev server（5173）与后端（8000）已经在跑，本脚本只读不改。
 *
 * ## 判据是怎么设计成"能区分成功与失败"的
 *
 * 这个项目在取证上栽过好几次（验证脚本只建一个 JASSUB 实例、夹具自己算出 NaN、
 * 第一版"保音高"的尺子把已知的 −4.98 半音测成 0.013 半音），所以每条结论都要能
 * 说清"失败时它为什么会变红"。
 *
 * ### 一、音高：尺子必须在**真实素材**上量出已知真值
 *
 * 尺子 = 在**同一个媒体时刻**取两次短时谱，在对数频率轴上做互相关，峰位即音高平移
 * ——重采样变速把整个频谱等比例平移，正是它能测的东西。
 *
 * 三条踩过的坑写在这里，不要回头再走：
 *
 * 1. **不能用长时平均谱。** 真实音乐的长时平均谱是一条平滑下降的宽带曲线，
 *    没有可对齐的结构，两条这样的曲线互相关峰必落在 0 —— 于是"保音高"与
 *    "降 5 个半音"测出来都是 0。第一版就死在这里，而它的合成自检（纯谐波音）
 *    照样通过，因为谐波尖峰是长时平均也留得住的结构。**校准素材必须与被测素材同类**
 *    （CLAUDE.md §8.9：测量工具要在实际工作点上校准）。
 * 2. **必须先白化。** 短时谱同样带着宽带包络，不减掉它，互相关还是被包络主导。
 *    做法是在对数频率轴上减去 ±3 半音的滑动平均，只留谐波尖峰。
 * 3. **两次采样必须落在同一个媒体时刻**，否则比的是两段不同的音乐。
 *    采样点由界面上那个播放头时钟给出，不靠墙钟折算。
 *
 * 阴性对照（**故意弄坏**）：把 `AudioWorkletNode` 从全局摘掉，模拟不支持
 * AudioWorklet 的浏览器，应用必须退回 `AudioBufferSourceNode.playbackRate`
 * ——那条路就是重采样，真值 12·log2(0.75) = −4.98 半音。同一把尺子量不出它
 * 就说明尺子不可信，这一轮结论作废。
 *
 * **不要用 page.route 掐 worklet 脚本来造对照组**：实测 Playwright 的路由拦不到
 * AudioWorklet 的模块请求，`addModule` 照样成功，"对照组"根本没坏。
 *
 * ### 二、相位：只能有一个拉伸器
 *
 * "每条 stem 各起一个拉伸器"会在两层相加时相位抵消，而**单听任何一层都是好的**
 * ——听感判据在这里必然漏测，所以改成结构判据：整页只允许存在**一个**
 * `kvm-timestretch` 节点，输出数 = 层数。
 *
 * ### 三、增益：看 Web Audio 图里真实的自动化，不看 UI 状态
 *
 * 断言的是各 GainNode 上 `linearRampToValueAtTime` 的目标值，并且知道每个 gain
 * 挂在 worklet 的哪个**输出序号**上（靠 hook `connect` 记下来）——按钮高亮对了
 * 而增益接反，这种错只有从图里才看得出来。
 *
 * ### 四、采集点
 *
 * 在"谁连到 destination"这条边上挂一个 AnalyserNode（再经零增益接回 destination，
 * 保证它被音频线程拉取）。位置在 master 之后、destination 之前，
 * 拿到的就是用户耳朵里那份混音。
 *
 * ## 已知环境事实
 * - WebKit 下 seek 到中段再播会卡死（实测 seek 40s 后 6 秒只走了 1.05s），
 *   属媒体链路既有问题，**所有用例一律从头播**。
 * - Vite dev 会往 worker 注入 /@vite/env，WebKit 在 require-corp 下拒绝加载，
 *   控制台噪声与本脚本结论无关。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, webkit } from 'playwright'

const OUT = '/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md/workspace/out/ui-preview-mix'
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
const note = (label, extra = '') => console.log(`   ·  ${label}${extra ? `  ${extra}` : ''}`)

/**
 * 该引擎所有浏览器进程的常驻内存（MB）。
 *
 * 为什么不用页面里的 API：整曲 AudioBuffer 与转移给 worklet 的样本都在 JS 堆外，
 * `performance.memory` 看不见；`measureUserAgentSpecificMemory` 在本环境的
 * Chromium 上直接抛 SecurityError（实测）。RSS 是唯一能把它们算进去的口径。
 * 按可执行文件路径匹配整组进程（Playwright 的 `Browser` 没有 `process()`）。
 */
function browserRssMB(engine) {
  // 按 `ms-playwright/<引擎>…` 匹配整组进程。
  // **不能用 `executablePath()` 去匹配**：Playwright 无头模式实际跑的是
  // `chromium_headless_shell-<版本>`，而 `executablePath()` 报的是 `chromium-<版本>`，
  // 一条都对不上，于是内存全测成 0 —— 一个不会报错、只会给出漂亮假数的失败。
  const out = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8' })
  let kb = 0
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && m[2].includes('ms-playwright') && m[2].includes(engine)) kb += Number(m[1])
  }
  return kb / 1024
}

// ---------------------------------------------------------------- 音高尺子

const FMIN = 150
const FMAX = 5000
/** 对数频率网格：每半音 10 格 → 峰位精度 0.1 半音，足以分辨 0 与 −4.98 */
const PER_SEMITONE = 10
/** 白化用的滑动平均半宽（半音）。减掉宽带包络，只留谐波尖峰 */
const WHITEN_SEMITONES = 3

/** dB 谱（线性频率 bin）→ 对数频率轴上的曲线 */
function toLogAxis(specDb, binHz) {
  const bins = Math.round(12 * Math.log2(FMAX / FMIN) * PER_SEMITONE)
  const out = new Float64Array(bins)
  for (let i = 0; i < bins; i++) {
    const f = FMIN * Math.pow(2, i / (12 * PER_SEMITONE))
    const p = f / binHz
    const k = Math.floor(p)
    const frac = p - k
    const a = Number.isFinite(specDb[k]) ? specDb[k] : -140
    const b = Number.isFinite(specDb[k + 1]) ? specDb[k + 1] : -140
    out[i] = a + (b - a) * frac
  }
  return out
}

/** 减去滑动平均：去掉宽带包络，留下随音高一起平移的谐波结构 */
function whiten(curve) {
  const w = WHITEN_SEMITONES * PER_SEMITONE
  const out = new Float64Array(curve.length)
  for (let i = 0; i < curve.length; i++) {
    let s = 0
    let n = 0
    for (let j = Math.max(0, i - w); j <= Math.min(curve.length - 1, i + w); j++) {
      s += curve[j]
      n++
    }
    out[i] = curve[i] - s / n
  }
  return out
}

const zscore = (v) => {
  const m = v.reduce((s, x) => s + x, 0) / v.length
  const c = Array.from(v, (x) => x - m)
  const s = Math.sqrt(c.reduce((a, x) => a + x * x, 0) / c.length) || 1
  return c.map((x) => x / s)
}

/** B 相对 A 的整体频率平移（半音，负 = 变低）。附带峰相关，用来判断结论可不可信 */
function pitchShift(specA, specB, binHz) {
  const A = zscore(whiten(toLogAxis(specA, binHz)))
  const B = zscore(whiten(toLogAxis(specB, binHz)))
  const maxLag = 9 * PER_SEMITONE
  const scores = new Map()
  let best = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0
    let n = 0
    for (let i = 0; i < A.length; i++) {
      const j = i + lag
      if (j < 0 || j >= B.length) continue
      dot += A[i] * B[j]
      n++
    }
    const score = n > 0 ? dot / n : -Infinity
    scores.set(lag, score)
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  const y0 = scores.get(best - 1) ?? bestScore
  const y2 = scores.get(best + 1) ?? bestScore
  const denom = y0 - 2 * bestScore + y2
  const delta = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
  return { semitones: (best + delta) / PER_SEMITONE, corr: bestScore }
}

const median = (v) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * 逐媒体时刻比较两次采集，取平移量的中位数。
 *
 * 逐时刻比是这把尺子成立的前提：短时谱才留得住谐波结构，而两次采集必须落在
 * **同一段音乐**上——所以采样点由播放头给出，不由墙钟折算。
 */
/**
 * 配对时两次采集的媒体时刻最多差多少秒。
 *
 * 分析窗本身有 8192 样本（≈170ms），差 50ms 时两窗仍有七成重叠，谐波结构照样对得上；
 * 再松就开始比到不同的音了。
 */
const PAIR_TOL = 0.05

function comparePitch(capA, capB) {
  const shifts = []
  const corrs = []
  const gaps = []
  for (const a of capA.snaps) {
    // 按**真实媒体时刻**就近配对，不按预定采样点：两次播放的取样时刻本来就落不到
    // 同一个网格上（帧率、送帧节奏都不同）
    let b = null
    for (const x of capB.snaps) {
      if (!b || Math.abs(x.t - a.t) < Math.abs(b.t - a.t)) b = x
    }
    if (!b || Math.abs(b.t - a.t) > PAIR_TOL) continue
    const r = pitchShift(a.spec, b.spec, capA.binHz)
    shifts.push(r.semitones)
    corrs.push(r.corr)
    gaps.push(Math.abs(b.t - a.t))
  }
  if (!shifts.length) return { n: 0 }
  const med = median(shifts)
  return {
    n: shifts.length,
    semitones: med,
    spread: median(shifts.map((s) => Math.abs(s - med))),
    corr: median(corrs),
    gap: median(gaps),
    all: shifts,
  }
}

// ---------------------------------------------------------------- 页面探针

/**
 * 装在页面上的诊断钩子。**只观察，不改变行为**：
 * 采集用的 AnalyserNode 经零增益接回 destination，既保证它被音频线程拉取，
 * 又不会把信号叠加进输出。
 */
function initDiag() {
  const D = {
    worklets: [],
    bufferStarts: [],
    ramps: [],
    gainOf: {}, // worklet 输出序号 → gain 的 gid
    gidSeq: 0,
    analyser: null,
    sampleRate: 0,
  }
  window.__diag = D

  const AWN = window.AudioWorkletNode
  if (AWN) {
    window.AudioWorkletNode = class extends AWN {
      constructor(ctx, name, opts) {
        super(ctx, name, opts)
        const po = (opts && opts.processorOptions) || {}
        this.__wid = D.worklets.length
        D.worklets.push({
          name,
          outputs: opts && opts.numberOfOutputs,
          layerIds: po.layerIds,
          referenceLayerIds: po.referenceLayerIds,
        })
      }
    }
  }

  const origStart = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...a) {
    D.bufferStarts.push({ rate: this.playbackRate.value, state: this.context.state })
    return origStart.apply(this, a)
  }

  const origGain = BaseAudioContext.prototype.createGain

  /**
   * 给 GainNode 编号，并记下它的 `gain` 参数 → 编号的映射。
   *
   * **不能靠 patch `createGain` 来做**：WebKit 上 `createGain` 不在
   * `BaseAudioContext.prototype` 这一层，补丁根本不生效，于是所有增益断言
   * 都拿到 null 而**只有 WebKit 变红**。改成在 `connect` 里就地打标，
   * 与工厂方法挂在哪个原型上无关。
   */
  const taggedGains = []
  const tagGain = (n) => {
    if (!n || n.__gid !== undefined) return
    const p = n.gain
    if (!p || typeof p.linearRampToValueAtTime !== 'function') return
    n.__gid = D.gidSeq++
    taggedGains.push(n)
  }

  /**
   * 这个 AudioParam 属于哪个 GainNode。
   *
   * **不能用 `WeakMap<param, gid>`**：WebKit 会把 `gain.gain` 的包装对象回收重建，
   * 于是起播那一两次能查到、之后全部 undefined —— 表现为增益断言**只在 WebKit 变红**，
   * 而被测代码两边完全一样。改成调用当时现场比对（同一 tick 内取到的是同一个包装对象）。
   */
  const gidOfParam = (param) => {
    for (const n of taggedGains) {
      try {
        if (n.gain === param) return n.__gid
      } catch {
        /* 节点已失效 */
      }
    }
    return undefined
  }

  const origRamp = AudioParam.prototype.linearRampToValueAtTime
  AudioParam.prototype.linearRampToValueAtTime = function (v, tt) {
    const gid = gidOfParam(this)
    if (gid !== undefined) D.ramps.push({ gid, value: v, t: tt })
    return origRamp.call(this, v, tt)
  }

  let tapping = false
  const origConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (dest, out, inp) {
    if (!tapping) {
      tagGain(this)
      tagGain(dest)
    }
    const r = out === undefined ? origConnect.call(this, dest) : origConnect.call(this, dest, out, inp)
    if (tapping) return r
    // worklet 的哪个输出接到了哪个 gain —— 增益断言全靠这张表，不靠创建顺序猜
    if (this.__wid !== undefined && dest && dest.__gid !== undefined && out !== undefined) {
      D.gainOf[out] = dest.__gid
    }
    if (dest && this.context && dest === this.context.destination && !D.analyser) {
      tapping = true
      try {
        const an = this.context.createAnalyser()
        an.fftSize = 8192
        an.smoothingTimeConstant = 0
        an.minDecibels = -140
        const mute = origGain.call(this.context)
        mute.gain.value = 0
        origConnect.call(this, an)
        origConnect.call(an, mute)
        origConnect.call(mute, this.context.destination)
        D.analyser = an
        D.sampleRate = this.context.sampleRate
      } catch (e) {
        D.analyserError = String(e)
      }
      tapping = false
    }
    return r
  }

  /** 界面上那个 m:ss.cc 播放头时钟 → 秒。采样点由它给出，不由墙钟折算 */
  const readClock = () => {
    for (const el of document.querySelectorAll('span')) {
      const m = /^(\d+):(\d{2})\.(\d{2})$/.exec(el.textContent?.trim() ?? '')
      if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100
    }
    return null
  }

  /**
   * 在媒体时刻区间 `[from, to]` 内**密集**取短时谱，每帧记下取样时的真实播放头。
   *
   * **不能按预定的媒体时刻去取**：播放头文字由 rVFC 驱动，实测 WebKit 在 1.0x 下
   * 是成批送帧的，观察到的播放头会整体比预定点晚一大截，而 0.75x 下不会——
   * 于是"同一个媒体时刻"这个前提在两次采集之间系统性地对不上，被测速率整段作废。
   * 改成密集采样、事后按**真实时刻**就近配对，与帧什么时候来无关。
   */
  window.__capture = (fromSec, toSec, minGapSec, timeoutMs) =>
    new Promise((resolve) => {
      const an = D.analyser
      if (!an) return resolve({ error: 'no-analyser', snaps: [] })
      const binHz = D.sampleRate / an.fftSize
      const keep = Math.min(an.frequencyBinCount, Math.ceil(5200 / binHz))
      const buf = new Float32Array(an.frequencyBinCount)
      const snaps = []
      let last = -Infinity
      const t0 = performance.now()
      const tick = () => {
        const t = readClock()
        if (t !== null && t >= fromSec && t <= toSec && t - last >= minGapSec) {
          an.getFloatFrequencyData(buf)
          snaps.push({ t, spec: Array.from(buf.subarray(0, keep)) })
          last = t
        }
        if ((t === null || t <= toSec) && performance.now() - t0 < timeoutMs) requestAnimationFrame(tick)
        else resolve({ snaps, binHz, clock: t })
      }
      requestAnimationFrame(tick)
    })
}

// ---------------------------------------------------------------- 页面操作

const clockMs = (page) =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll('span')) {
      const m = /^(\d+):(\d{2})\.(\d{2})$/.exec(el.textContent?.trim() ?? '')
      if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) * 10
    }
    return null
  })

const clickPlay = (page) => page.locator('button', { hasText: /^播放$/ }).first().click()
const clickPause = async (page) => {
  const btn = page.locator('button', { hasText: /^暂停$/ }).first()
  if (await btn.count()) await btn.click()
}

const setRangeValue = (page, selector, value) =>
  page.evaluate(
    ([sel, v]) => {
      const el = document.querySelector(sel)
      if (!el) return
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, String(v))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    [selector, value],
  )

/** 采集的媒体时刻区间（秒）。避开开头 1s：起播与 AudioContext resume 的过渡不该进来 */
const CAP_FROM = 1.0
const CAP_TO = 3.4
/** 两次取样之间至少隔多久，避免同一帧被重复记 */
const CAP_GAP = 0.06

/**
 * 从头播、在固定的媒体时刻各取一帧短时谱。
 *
 * 采集靠 rAF 推进，所以**主线程被长任务占住时会整段采空**。实测踩到过一次：
 * 波形层切轨会在前端把整条 stem 整段解码（§5.10 待实现的后端峰值接口就是为了
 * 干掉它），那一下把 WebKit 的主线程堵住十几秒，采样点一个都没取到。
 * 因此这里给足超时，并把结束时的播放头一并带回来 —— 采空时能一眼看出是"没播"
 * 还是"播了但没采到"，而不是变成一条无从下手的红叉。
 */
async function playAndCapture(page) {
  await setRangeValue(page, 'input[type=range][max]', 0)
  await page.waitForTimeout(300)
  await clickPlay(page)
  // 确认播放头真的动了再开始采集。这台机器上偶尔会出现"点了播放但几秒内没起来"
  // （多半是解码/渲染把主线程占住），不确认的话整段采空，红叉却指向音高
  const moving = await page
    .waitForFunction(
      () => {
        for (const el of document.querySelectorAll('span')) {
          const m = /^(\d+):(\d{2})\.(\d{2})$/.exec(el.textContent?.trim() ?? '')
          if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100 > 0.3
        }
        return false
      },
      undefined,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!moving) {
    // 再给一次机会：暂停复位后重来一遍
    await clickPause(page)
    await setRangeValue(page, 'input[type=range][max]', 0)
    await page.waitForTimeout(500)
    await clickPlay(page)
  }
  // 墙钟只量采集本身：起播、seek、等待播放头启动都是两种速率下等量的固定开销，
  // 算进去只会把比值往 1 拉，掩盖"速率没生效"这类问题
  const t0 = Date.now()
  const cap = await page.evaluate(
    ([f, to, gap, timeout]) => window.__capture(f, to, gap, timeout),
    [CAP_FROM, CAP_TO, CAP_GAP, 25000],
  )
  const wallMs = Date.now() - t0
  await clickPause(page)
  await page.waitForTimeout(200)
  return { ...cap, wallMs }
}

/**
 * 空跑一次播放再丢掉。
 *
 * **第一次起播不能拿来测量**：那一下要顺带唤醒 AudioContext、起 `<video>`、
 * 让 JASSUB 首次渲染，WebKit 上实测把主线程占住好几秒（同一页里第二次播放就正常）。
 * 不预热的话，第一次测的那个速率会因为采样帧全被判为"迟到"而整段作废，
 * 看起来像是"1.0x 坏了"，其实与速率无关。
 */
async function warmUp(page) {
  await setRangeValue(page, 'input[type=range][max]', 0)
  await clickPlay(page)
  await page.waitForTimeout(2500)
  await clickPause(page)
  await page.waitForTimeout(400)
}

/** 设置走带速率（时间轴上的那组单选） */
async function setRate(page, rate) {
  await page.locator(`label[data-rate="${rate}"] input`).first().check()
  await page.waitForTimeout(150)
}

async function openPage(browser, { projectId, title, step, noWorklet, stripStems }) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await ctx.addInitScript(initDiag)
  if (noWorklet) {
    // 阴性对照：摘掉 AudioWorkletNode = 模拟不支持它的浏览器（理由见文件头）
    await ctx.addInitScript(() => {
      delete window.AudioWorkletNode
    })
  }
  await ctx.addInitScript(
    ([id, s]) => {
      localStorage.setItem(`kvm.step.${id}`, s)
    },
    [projectId, step],
  )
  const page = await ctx.newPage()
  if (stripStems) {
    // 装成"还没跑过人声分离"的工程：只有原始混音一层
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      const resp = await route.fetch()
      const body = await resp.json()
      body.vocals_path = null
      body.instrumental_path = null
      // 引导声是**从人声轨派生**的，没分离过就不可能有它。不一起抹掉的话，
      // 这个"没分离过的工程"会带着一条它本不该有的引导声轨，对照组自身就不成立。
      body.guide_audio_path = null
      await route.fulfill({ response: resp, body: JSON.stringify(body) })
    })
  }
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // 应用启动在首页，从卡片进工程（步骤由上面写进 localStorage 的 kvm.step.<id> 决定）
  await page.locator('.pcard', { hasText: title }).first().click()
  return { ctx, page, errors }
}

/** 等音频引擎就绪：「原声」档由 disabled 变可用 */
const waitReady = (page) =>
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

// ---------------------------------------------------------------- 用例

async function runEngine(name, projectId, title, durationSec) {
  console.log(`\n########## ${name} ##########`)
  const browser = await ENGINES[name].launch(
    name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
  )

  // ============ A. 正常路径：结构 + 增益 + 保音高 ============
  console.log(`\n=== A 正常路径（分离过的工程，两条 stem）===`)
  {
    const { ctx, page, errors } = await openPage(browser, { projectId, title, step: 'edit' })
    check(await waitReady(page), '音频引擎就绪')

    const diag = await page.evaluate(() => ({
      worklets: window.__diag.worklets,
      bufferStarts: window.__diag.bufferStarts,
      gainOf: window.__diag.gainOf,
      analyser: !!window.__diag.analyser,
      analyserError: window.__diag.analyserError ?? null,
    }))
    const ts = diag.worklets.filter((w) => w.name === 'kvm-timestretch')
    check(
      ts.length === 1,
      '整页只有一个拉伸器（每条 stem 各一个 = 相加时相位抵消，且只在原声档听得出来）',
      JSON.stringify(diag.worklets),
    )
    // 两条 stem 必须**排在前面且顺序固定**（下面的增益断言按输出序号 0/1 取），
    // 之后可以再挂一条 `guide`——引导声是叠加层，工程生成过它才会出现，
    // 它在不在都不影响 D15 那条"原声 = 人声 + 伴奏"的结构（见 Preview.tsx）。
    const stems = (ts[0]?.layerIds ?? []).filter((id) => id !== 'guide')
    check(
      ts[0] && JSON.stringify(stems) === '["vocals","instrumental"]' && ts[0].outputs === ts[0].layerIds.length,
      '层结构收敛到 D15：vocals + instrumental 两条 stem（引导声若已生成则追加在后）',
      ts[0] ? `outputs=${ts[0].outputs} layers=${JSON.stringify(ts[0].layerIds)}` : '(无)',
    )
    check(
      ts[0] && Array.isArray(ts[0].referenceLayerIds) && ts[0].referenceLayerIds.length === 0,
      '相似度搜索参考 = 所有层等增益和（不按当前增益加权）',
      ts[0] ? JSON.stringify(ts[0].referenceLayerIds) : '',
    )
    check(diag.bufferStarts.length === 0, '没有走 BufferSource 降级路径')
    check(diag.analyser, '采集探针挂上了', diag.analyserError ?? '')

    // --- 增益：看图里真实的自动化 ---
    const gainOf = diag.gainOf // 输出序号 → gid；0=vocals，1=instrumental
    const rampsSince = async (fn) => {
      const before = await page.evaluate(() => window.__diag.ramps.length)
      await fn()
      await page.waitForTimeout(250)
      return page.evaluate((n) => window.__diag.ramps.slice(n), before)
    }
    const target = (ramps, gid) => {
      const hit = ramps.filter((r) => r.gid === gid)
      return hit.length ? hit[hit.length - 1].value : null
    }

    let r = await rampsSince(() => page.click('[data-testid=mix-preset-vocals]'))
    check(
      target(r, gainOf[0]) === 1 && target(r, gainOf[1]) === 0,
      '「仅人声」：人声层 → 1、伴奏层 → 0',
      `vocals=${target(r, gainOf[0])} inst=${target(r, gainOf[1])}`,
    )
    check(r.length > 0, '切换走的是斜坡而不是跳变（linearRampToValueAtTime）')

    r = await rampsSince(() => page.click('[data-testid=mix-preset-instrumental]'))
    check(
      target(r, gainOf[0]) === 0 && target(r, gainOf[1]) === 1,
      '「伴奏」：人声层 → 0、伴奏层 → 1',
      `vocals=${target(r, gainOf[0])} inst=${target(r, gainOf[1])}`,
    )

    r = await rampsSince(() => page.click('[data-testid=mix-preset-original]'))
    check(
      target(r, gainOf[0]) === 1 && target(r, gainOf[1]) === 1,
      '「原声」= 两条 stem 相加（D15），两层都 → 1',
      `vocals=${target(r, gainOf[0])} inst=${target(r, gainOf[1])}`,
    )

    // --- 分轨音量 ---
    await page.click('[data-testid=mix-tracks-toggle]')
    r = await rampsSince(() => setRangeValue(page, '[data-testid=mix-level-vocals]', 0.3))
    check(
      Math.abs((target(r, gainOf[0]) ?? -1) - 0.3) < 1e-6 && target(r, gainOf[1]) === 1,
      '分轨音量：人声拉到 30%（ガイドボーカル入り 的中间地带），伴奏不动',
      `vocals=${target(r, gainOf[0])} inst=${target(r, gainOf[1])}`,
    )
    check(
      (await page.getAttribute('[data-testid=mix-preset-original]', 'aria-pressed')) === 'true',
      '两层都还听得见时仍算「原声」档',
    )
    r = await rampsSince(() => setRangeValue(page, '[data-testid=mix-level-vocals]', 0))
    check(
      (await page.getAttribute('[data-testid=mix-preset-instrumental]', 'aria-pressed')) === 'true',
      '人声拉到 0 后高亮跟着变成「伴奏」（高亮说的是"此刻听得见什么"）',
    )
    await setRangeValue(page, '[data-testid=mix-level-vocals]', 0.3)
    await page.click('[data-testid=mix-preset-instrumental]')
    r = await rampsSince(() => page.click('[data-testid=mix-preset-original]'))
    check(
      Math.abs((target(r, gainOf[0]) ?? -1) - 0.3) < 1e-6,
      '切一圈档回来，用户调过的分轨音量没被复位',
      `vocals=${target(r, gainOf[0])}`,
    )
    await setRangeValue(page, '[data-testid=mix-level-vocals]', 1)
    await page.click('[data-testid=mix-preset-original]')
    await page.waitForTimeout(200)

    // --- 播放头速率 + 采集 ---
    //
    // 放在波形切轨之前：切轨会触发一次整条 stem 的前端解码，把主线程占住十几秒，
    // 采集用的 rAF 就整段跑不起来（实测在 WebKit 上采空过一次）
    await setRate(page, 1)
    await warmUp(page)
    const cap1 = await playAndCapture(page)
    check(cap1.snaps.length >= 8, '1.0x 采到足够的谱帧', `${cap1.snaps.length} 帧`)

    await setRate(page, 0.75)
    const cap075 = await playAndCapture(page)
    check(cap075.snaps.length >= 8, '0.75x 采到足够的谱帧', `${cap075.snaps.length} 帧`)

    // 走完同一段音乐（第一个采样点 → 最后一个采样点），0.75x 该花 1/0.75 倍的墙钟
    const wall1 = cap1.wallMs / 1000
    const wall075 = cap075.wallMs / 1000
    const ratio = wall1 > 0 ? wall075 / wall1 : NaN
    note('走完同一段音乐的墙钟', `1.0x ${wall1.toFixed(2)}s，0.75x ${wall075.toFixed(2)}s`)
    check(
      Number.isFinite(ratio) && Math.abs(ratio - 1 / 0.75) < 0.12,
      '0.75x 下播放头按 0.75 倍推进（同一段音乐耗时 1.33 倍）',
      `实测比值 ${ratio.toFixed(3)}，期望 1.333`,
    )

    const res = comparePitch(cap1, cap075)
    check(
      res.n >= 6 && Math.abs(res.semitones) < 0.6,
      '0.75x 保音高（尺子的已知真值校验见对照组 B）',
      res.n
        ? `${res.semitones.toFixed(2)} 半音（配对 ${res.n} 组，离散度 ${res.spread.toFixed(2)}，配对时差 ${(res.gap * 1000).toFixed(0)}ms，峰相关 ${res.corr.toFixed(2)}）`
        : '无有效配对',
    )
    if (res.n) note('逐配对', res.all.map((s) => s.toFixed(2)).join(' '))

    // --- 波形与耳朵的解耦没被粘回去（放最后：切轨会占住主线程） ---
    const waveOk = await page.evaluate(async () => {
      const pick = document.querySelector('label[data-wave-src=vocals] input')
      if (!pick || pick.disabled) return 'no-control'
      pick.click()
      await new Promise((r2) => setTimeout(r2, 500))
      document.querySelector('[data-testid=mix-preset-instrumental]')?.click()
      await new Promise((r2) => setTimeout(r2, 500))
      return document.querySelector('label[data-wave-src=vocals]')?.dataset.on === 'true' ? 'ok' : 'lost'
    })
    check(waveOk === 'ok', '「波形画哪条轨」与「耳朵听哪条轨」仍然是两件事', waveOk)

    await page.screenshot({ path: `${OUT}/10-${name}-normal.png` })
    const real = errors.filter(
      (e) => !/Cross-Origin-Embedder-Policy|Importing a module script|Fetch is aborted|jassub|worker/i.test(e),
    )
    if (real.length) {
      real.slice(0, 5).forEach((e) => console.log(`   ❌ 控制台 ${e.slice(0, 180)}`))
      fail += real.length
    }
    await ctx.close()
  }

  // ============ B. 阴性对照：摘掉 AudioWorkletNode，逼它降级 ============
  console.log(`\n=== B 阴性对照（故意弄坏：浏览器"不支持" AudioWorklet）===`)
  {
    const { ctx, page } = await openPage(browser, { projectId, title, step: 'edit', noWorklet: true })
    check(await waitReady(page), '降级后播放依然可用（§2.5 失败要降级不能终止）')

    const txt = await page.evaluate(() => document.body.innerText)
    check(/慢速试听会降调/.test(txt), '界面上如实报出「慢速试听会降调」')
    check(
      (await page.evaluate(() => window.__diag.worklets.filter((w) => w.name === 'kvm-timestretch').length)) === 0,
      '拉伸器确实没建起来（对照组自身成立）',
    )

    await setRate(page, 1)
    await warmUp(page)
    const cap1 = await playAndCapture(page)
    await setRate(page, 0.75)
    const cap075 = await playAndCapture(page)
    check(
      cap1.snaps.length >= 8 && cap075.snaps.length >= 8,
      '两次采集都采到足够的谱帧',
      `${cap1.snaps.length} / ${cap075.snaps.length} 帧`,
    )

    const starts = await page.evaluate(() => window.__diag.bufferStarts)
    check(
      starts.some((s) => Math.abs(s.rate - 0.75) < 1e-6),
      '降级路径确实用了 BufferSource.playbackRate = 0.75（即重采样）',
      JSON.stringify(starts.slice(-2)),
    )

    const res = comparePitch(cap1, cap075)
    const truth = 12 * Math.log2(0.75)
    check(
      res.n >= 6 && Math.abs(res.semitones - truth) < 1.0,
      `同一把尺子在真实素材上量出已知真值 ${truth.toFixed(2)} 半音 → 尺子可信`,
      res.n
        ? `实测 ${res.semitones.toFixed(2)} 半音（配对 ${res.n} 组，离散度 ${res.spread.toFixed(2)}，配对时差 ${(res.gap * 1000).toFixed(0)}ms，峰相关 ${res.corr.toFixed(2)}）`
        : '无有效配对',
    )
    if (res.n) note('逐配对', res.all.map((s) => s.toFixed(2)).join(' '))
    await page.screenshot({ path: `${OUT}/20-${name}-fallback.png` })
    await ctx.close()
  }

  // ============ C. 缺轨：没分离过的工程 ============
  console.log(`\n=== C 没分离过的工程（只有原始混音一层）===`)
  {
    const { ctx, page } = await openPage(browser, { projectId, title, step: 'edit', stripStems: true })
    check(await waitReady(page), '「原声」仍然可用（退化成单层原始混音）')
    const s = await page.evaluate(() => {
      const g = (id) => document.querySelector(`[data-testid=mix-preset-${id}]`)
      return {
        inst: { disabled: g('instrumental')?.disabled, title: g('instrumental')?.title },
        voc: { disabled: g('vocals')?.disabled, title: g('vocals')?.title },
        tracks: !!document.querySelector('[data-testid=mix-tracks-toggle]'),
        worklets: window.__diag.worklets.filter((w) => w.name === 'kvm-timestretch'),
      }
    })
    check(s.inst.disabled === true && s.voc.disabled === true, '缺的档禁用而不隐藏')
    check(
      /人声分离/.test(s.inst.title ?? '') && /人声分离/.test(s.voc.title ?? ''),
      '并说明为什么不可用',
      `${s.inst.title}`,
    )
    check(!s.tracks, '只有一层时不出现「分轨」入口（那时它就是主音量）')
    check(
      s.worklets.length === 1 && JSON.stringify(s.worklets[0].layerIds) === '["mix"]',
      '单层也走同一条保音高路径',
      JSON.stringify(s.worklets[0]?.layerIds),
    )
    await page.screenshot({ path: `${OUT}/30-${name}-nostems.png` })
    await ctx.close()
  }

  // ============ D. 试听 ≠ 导出 ============
  console.log(`\n=== D 试听混音与导出音轨的关系 ===`)
  {
    const { ctx, page } = await openPage(browser, { projectId, title, step: 'export' })
    check(await waitReady(page), '导出舞台的预览就绪')

    const expState = () =>
      page.evaluate(() => {
        const items = [...document.querySelectorAll('.exp-seg__item')]
        const on = items.find((b) => b.getAttribute('aria-pressed') === 'true')
        const preset = ['original', 'instrumental', 'vocals'].find(
          (p) =>
            document.querySelector(`[data-testid=mix-preset-${p}]`)?.getAttribute('aria-pressed') === 'true',
        )
        return { exportTrack: on?.textContent?.trim() ?? null, preset: preset ?? null }
      })

    // 导出设置 → 预览（这条同步必须保留：否则"设置选了伴奏、预览还在放原声"）
    await page.locator('.exp-seg__item', { hasText: /OFF/i }).first().click()
    await page.waitForTimeout(300)
    let st = await expState()
    check(st.preset === 'instrumental', '导出切 OFF VOCAL，预览跟着切到伴奏', JSON.stringify(st))

    // 预览 → 导出：仅人声**不许**改动导出设置
    await page.click('[data-testid=mix-preset-vocals]')
    await page.waitForTimeout(300)
    st = await expState()
    check(
      st.preset === 'vocals' && /OFF/i.test(st.exportTrack ?? ''),
      '预览 solo 人声，导出音轨仍是 OFF VOCAL（不可能导出一条只有人声的成片）',
      JSON.stringify(st),
    )

    // 预览选「原声」才写回导出（两者一一对应）
    await page.click('[data-testid=mix-preset-original]')
    await page.waitForTimeout(300)
    st = await expState()
    check(/ON/i.test(st.exportTrack ?? ''), '预览选原声 = 导出 ON VOCAL（两档一一对应）', JSON.stringify(st))

    await page.screenshot({ path: `${OUT}/40-${name}-export.png` })
    await ctx.close()
  }

  await browser.close()

  // ============ E. 内存 ============
  //
  // 两条纪律：
  // 1. **每种配置各起一个全新的浏览器**。同一个实例里先后开两个上下文，前一个的
  //    内存不会立刻还给系统，"单层比双层省多少"就成了假数。
  // 2. **在导出舞台量，不在编辑舞台**。编辑舞台的波形层目前会把整条轨在前端整段
  //    解码一遍（§5.10 待实现的后端峰值接口就是为了干掉它），那部分内存与本次
  //    改动无关，量在一起会把音频引擎的开销淹掉。
  console.log(`\n=== E 内存实测（浏览器进程组 RSS，导出舞台）===`)
  {
    const measure = async (stripStems) => {
      const b = await ENGINES[name].launch(
        name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {},
      )
      await new Promise((r) => setTimeout(r, 1200))
      const base = browserRssMB(name)
      const { page } = await openPage(b, { projectId, title, step: 'export', stripStems })
      await waitReady(page)
      await page.waitForTimeout(3000)
      const loaded = browserRssMB(name)
      await b.close()
      await new Promise((r) => setTimeout(r, 1200))
      return { base, loaded, delta: loaded - base }
    }
    const two = await measure(false)
    const one = await measure(true)
    note('两条 stem（vocals + instrumental）', `基线 ${two.base.toFixed(0)} → ${two.loaded.toFixed(0)} MB，+${two.delta.toFixed(0)} MB`)
    note('单层原始混音', `基线 ${one.base.toFixed(0)} → ${one.loaded.toFixed(0)} MB，+${one.delta.toFixed(0)} MB`)
    note('多出来的那一层的边际成本', `${(two.delta - one.delta).toFixed(0)} MB`)
    note(
      '参考：整曲立体声 44.1k float32 每层理论占用',
      `${((durationSec * 44100 * 2 * 4) / 1e6).toFixed(0)} MB`,
    )
  }
}

// ---------------------------------------------------------------- 入口

const projects = await fetch(`${API}/api/projects/`).then((r) => r.json())
const withStems = []
for (const p of projects) {
  const full = await fetch(`${API}/api/projects/${p.id}`).then((r) => r.json())
  if (full.vocals_path && full.instrumental_path) withStems.push(full)
}
if (!withStems.length) {
  console.error('没有分离过的工程，无法验证双 stem 相加这条路径')
  process.exit(2)
}
const target = withStems[0]
console.log(`被测工程：${target.title || '(未命名)'}　${target.id}`)

for (const name of wanted) await runEngine(name, target.id, target.title, (target.duration_ms ?? 0) / 1000)

console.log(`\n通过 ${pass}　失败 ${fail}`)
process.exit(fail ? 1 : 0)
