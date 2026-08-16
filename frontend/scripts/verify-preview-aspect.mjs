// 版面验收：**字幕画布的盒子比例必须恒等于画幅比例**，窗口怎么变都一样。
//
//   用法：node scripts/verify-preview-aspect.mjs [chromium|webkit]   不带参数则两个都跑
//
// ## 为什么需要这条用例
//
// 字幕层是画布模式挂的（CLAUDE.md §5.9）。这个模式下 JASSUB **不碰 canvas 的 CSS
// 尺寸**（`resize()` 里设 CSS 宽高那段有 `if (this._video)` 守着），它只把位图按
// ASS 的 PlayRes 比例内缩，之后交给 CSS 去拉伸。于是画布盒子的比例一旦不等于
// PlayRes，字幕就被拉伸——而同一个盒子里的 `<video>` 有 `object-fit: contain` 顶着、
// 画面纹丝不动，用户看到的现象是"只有字幕会跟着窗口变形"。
//
// 这类形变不会在任何单元测试里暴露，也不会在"窗口正好够大"的开发机上暴露：
// 它只在盒子被上下游布局压扁时发作，而两个舞台恰好都允许压扁
// （编辑侧 `flex: 0 1 auto`、导出侧 `flex: 1 1 auto`）。
//
// ## 判据是怎么设计成"能区分成功与失败"的
//
// **一、量的是形变倍数，不是"看起来对不对"**
// 形变倍数 = 画布盒子的宽高比 ÷ 画幅宽高比。1.000 表示不形变，2.000 表示字被横向
// 拉成两倍宽。阈值 ±0.005 是给亚像素取整留的余量，不是"差不多就行"。
//
// **二、CSS 从源码里取，不在本脚本里另抄一份**
// 样式舞台整份 CSS 直接从 `StyleStageCss.ts` 抠出来注入；编辑/导出侧的画布盒子是
// 内联样式，从 `Preview.tsx` 里把 `stage` / `film` 两个样式对象解析成 CSS 声明。
// 抄一份的话，源码改回旧写法脚本照样绿——那就成了一个只会说"通过"的装饰品。
//
// **三、阳性对照：旧写法必须被判红**
// 每轮都额外跑一遍 `width: 100% + max-height: 100% + aspect-ratio` 的旧写法，
// 要求它**至少在一个场景里形变**。这条不通过就说明本脚本的探测器坏了（选错节点、
// 量错属性、场景全都太宽松），本轮结论作废——它比正向断言更重要。
//
// 旧写法为什么不成立，实测结论记在这里：宽高比**不会**把 `max-height` 转成宽度上限。
// `width` 是明确值时，被压扁的盒子只有高度被截断，宽度纹丝不动。
//
// **四、画幅要覆盖非 16:9**
// 1:1 的画幅在"空间充裕"的窗口下就已经被压扁了（盒子高度需求 = 宽度），
// 只测 16:9 会漏掉这一整类，而本工具明确要支持任意画幅（CLAUDE.md §8.5「画幅」）。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../src')

/** 从 `export const X = \`...\`` 里抠出模板字符串正文 */
function extractCssConst(file, name) {
  const text = readFileSync(resolve(SRC, file), 'utf8')
  const start = text.indexOf(`export const ${name} = \``)
  if (start < 0) throw new Error(`${file} 里找不到 ${name}`)
  const from = text.indexOf('`', start) + 1
  const to = text.indexOf('\n`', from)
  if (to < 0) throw new Error(`${file} 里 ${name} 的模板字符串没有收尾`)
  return text.slice(from, to)
}

const UNITLESS = new Set(['flex', 'flex-grow', 'flex-shrink', 'z-index', 'opacity', 'line-height'])

/**
 * 从 `Preview.tsx` 的 `const styles = {...}` 里把一个样式对象解析成 CSS 声明串。
 *
 * 只认 `key: value,` 这种平铺写法——本文件里的样式对象就是这么写的，
 * 出现嵌套或表达式时宁可抛错，也不要静默解析出半份样式来验一个假的东西。
 */
function inlineStyleToCss(name) {
  const text = readFileSync(resolve(SRC, 'components/Preview.tsx'), 'utf8')
  const head = text.indexOf(`\n  ${name}: {`)
  if (head < 0) throw new Error(`Preview.tsx 里找不到 styles.${name}`)
  const open = text.indexOf('{', head)
  // 花括号配对找结尾。单行写法（`root: { ... },`）与多行写法都要认——
  // 只按 `\n  },` 找的话，单行对象会一路吞掉它后面的整个样式表，
  // 而解析出来的垃圾声明浏览器只是忽略，脚本表面照样"通过"
  let depth = 0
  let close = -1
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) throw new Error(`Preview.tsx 里 styles.${name} 没有收尾`)
  const body = text.slice(open + 1, close)
  const decls = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    // 一行里可能有多条（单行写法），逐条抓；带引号的值整段取，免得被值里的逗号切断
    const re = /([A-Za-z]+):\s*('[^']*'|"[^"]*"|[^,]+)/g
    let m
    let hit = false
    while ((m = re.exec(line))) {
      hit = true
      const prop = m[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
      let value = m[2].trim().replace(/,$/, '')
      if (/^['"].*['"]$/.test(value)) value = value.slice(1, -1)
      // React 给无单位数字补 px，但不是对所有属性都补
      else if (/^\d+$/.test(value) && value !== '0' && !UNITLESS.has(prop)) value = value + 'px'
      decls.push(`${prop}: ${value};`)
    }
    if (!hit) throw new Error(`styles.${name} 里这行解析不了：${line}`)
  }
  return decls.join(' ')
}

const STYLE_STAGE_CSS = extractCssConst('components/StyleStageCss.ts', 'STYLE_STAGE_CSS')
const EXPORT_STAGE_CSS = extractCssConst('components/ExportStageCss.ts', 'EXPORT_STAGE_CSS')
const GLOBAL_CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8')
const PREVIEW_STAGE = inlineStyleToCss('stage')
const PREVIEW_FILM = inlineStyleToCss('film')
const PREVIEW_HOST = inlineStyleToCss('overlayHost')
const PREVIEW_VIDEO = inlineStyleToCss('video')
const PREVIEW_ROOT = inlineStyleToCss('root')

// JSX 里给画布盒子补的两条动态声明（`filmAspect` 同时喂给宽高比与宽度公式）。
// 源码若不再用容器查询单位，下面这条断言会先红，脚本不会拿着旧结论继续跑。
const previewSrc = readFileSync(resolve(SRC, 'components/Preview.tsx'), 'utf8')
if (!previewSrc.includes('min(100cqw, calc(100cqh * ${filmAspect}))')) {
  throw new Error('Preview.tsx 的画布宽度不再是信箱式内缩的写法，判据已失效')
}

/** 待测的四种挂法。`legacy*` 是阳性对照：它们必须形变 */
const VARIANTS = {
  // 编辑舞台：Preview 挂在 .edit-preview 下，画面块允许被压缩（flex: 0 1 auto）
  edit: (ar) => `
    <div class="mock-col">
      <div class="edit-preview" style="${PREVIEW_ROOT}">
        <div style="${PREVIEW_STAGE} aspect-ratio: ${ar};">
          <div style="${PREVIEW_FILM} aspect-ratio: ${ar}; width: min(100cqw, calc(100cqh * ${ar}));">
            <video style="${PREVIEW_VIDEO}"></video>
            <div style="${PREVIEW_HOST}"><canvas data-probe></canvas></div>
          </div>
        </div>
        <div class="mock-controls"></div>
      </div>
    </div>`,
  // 导出舞台：同一个组件，外面换成 .exp-preview（flex: 1 1 auto，空间富余时会被拉高）
  export: (ar) => `
    <div class="mock-col">
      <div class="exp-preview" style="${PREVIEW_ROOT}">
        <div style="${PREVIEW_STAGE} aspect-ratio: ${ar};">
          <div style="${PREVIEW_FILM} aspect-ratio: ${ar}; width: min(100cqw, calc(100cqh * ${ar}));">
            <div style="${PREVIEW_HOST}"><canvas data-probe></canvas></div>
          </div>
        </div>
        <div class="mock-controls"></div>
      </div>
    </div>`,
  // 样式舞台：真实类名 + 真实 CSS
  style: (ar) => `
    <div class="mock-col">
      <div class="sty-film-col">
        <div class="sty-bar"></div>
        <div class="sty-film-wrap">
          <div class="sty-film" style="--sty-aspect: ${ar};">
            <div class="sty-film__host"><canvas class="sty-film__canvas" data-probe></canvas></div>
          </div>
        </div>
        <div class="sty-transport"></div>
      </div>
    </div>`,
  // 阳性对照：被推翻的旧写法
  legacy: (ar) => `
    <div class="mock-col">
      <div class="edit-preview" style="${PREVIEW_ROOT}">
        <div style="${PREVIEW_STAGE} aspect-ratio: ${ar};">
          <div style="position: relative; overflow: hidden; width: 100%; max-height: 100%; aspect-ratio: ${ar};">
            <div style="${PREVIEW_HOST}"><canvas data-probe></canvas></div>
          </div>
        </div>
        <div class="mock-controls"></div>
      </div>
    </div>`,
}

const MOCK_CSS = `
  html, body { margin: 0 }
  /* 舞台外壳：模拟"一栏里纵向叠着画面块与别的东西"，高度由用例给定 */
  .mock-col { display: flex; flex-direction: column; width: var(--w); height: var(--h); }
  .mock-controls { flex: 0 0 auto; height: 40px; }
  .sty-bar, .sty-transport { flex: 0 0 auto; height: 32px; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
`

/** 画幅：16:9 常规、4:3 与 1:1（补边关掉时的真实画幅），以及一个竖屏 */
const ASPECTS = [
  { label: '16:9', w: 1920, h: 1080 },
  { label: '4:3', w: 1440, h: 1080 },
  { label: '1:1', w: 1080, h: 1080 },
  { label: '9:16', w: 1080, h: 1920 },
]

/** 窗口：从"空间充裕"一路到"被压扁"，外加宽而矮 / 窄而高两个极端 */
const BOXES = [
  { label: '充裕', w: 900, h: 700 },
  { label: '略压', w: 900, h: 460 },
  { label: '压扁', w: 900, h: 320 },
  { label: '宽而矮', w: 1400, h: 320 },
  { label: '窄而高', w: 420, h: 900 },
]

const TOLERANCE = 0.005

async function run(browserName) {
  const { [browserName]: launcher } = await import('playwright')
  const browser = await launcher.launch()
  const page = await browser.newPage()
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>${GLOBAL_CSS}</style>
     <style>${STYLE_STAGE_CSS}</style>
     <style>${EXPORT_STAGE_CSS}</style>
     <style>${MOCK_CSS}</style>
     <div id="mount"></div>`,
  )

  const rows = []
  const overflows = []
  for (const [variant, build] of Object.entries(VARIANTS)) {
    for (const a of ASPECTS) {
      for (const b of BOXES) {
        const ar = `${a.w} / ${a.h}`
        const box = await page.evaluate(
          ({ html, w, h }) => {
            const mount = document.getElementById('mount')
            mount.innerHTML = html
            const col = mount.querySelector('.mock-col')
            col.style.setProperty('--w', w + 'px')
            col.style.setProperty('--h', h + 'px')
            void document.body.offsetHeight
            const r = mount.querySelector('[data-probe]').getBoundingClientRect()
            return { w: r.width, h: r.height }
          },
          { html: build(ar), w: b.w, h: b.h },
        )
        const skew = box.h > 0 ? box.w / box.h / (a.w / a.h) : 0
        // 画布高过了窗口高，说明这条挂法的外部约束在本脚本里没接上（少注入了一份
        // CSS、少了 min-height: 0…）——盒子根本没被压扁，"没形变"就什么也证明不了
        if (box.h > b.h + 1) {
          overflows.push({
            挂法: variant,
            画幅: a.label,
            窗口: `${b.label} ${b.w}×${b.h}`,
            画布高: Math.round(box.h),
          })
        }
        rows.push({
          挂法: variant,
          画幅: a.label,
          窗口: `${b.label} ${b.w}×${b.h}`,
          画布: `${Math.round(box.w)}×${Math.round(box.h)}`,
          形变: skew.toFixed(3),
        })
      }
    }
  }
  await browser.close()

  const real = rows.filter((r) => r.挂法 !== 'legacy')
  const control = rows.filter((r) => r.挂法 === 'legacy')
  const bad = real.filter((r) => Math.abs(Number(r.形变) - 1) > TOLERANCE)
  const controlSkewed = control.filter((r) => Math.abs(Number(r.形变) - 1) > 0.05)

  console.log(`\n=== ${browserName} ===`)
  // 通过时也把实测尺寸摆出来：只报一句"全部通过"的话，探测器量到的是不是
  // 一块 0×0 的画布就无从判断了（0 高会被判红，但塌掉的版面仍值得看见）
  console.table(bad.length ? bad : real.filter((r) => r.窗口.startsWith('压扁')))
  console.log(
    bad.length === 0
      ? `✅ 画布比例：${real.length} 个组合全部不形变（形变倍数 1.000 ± ${TOLERANCE}）`
      : `❌ 画布比例：${bad.length}/${real.length} 个组合形变`,
  )
  console.log(
    controlSkewed.length > 0
      ? `✅ 阳性对照：旧写法在 ${controlSkewed.length}/${control.length} 个组合里形变（最大 ${Math.max(
          ...controlSkewed.map((r) => Number(r.形变)),
        ).toFixed(2)}×），判据有效`
      : '❌ 阳性对照：旧写法居然没形变，本脚本的探测器不可信，结论作废',
  )
  if (overflows.length) {
    console.table(overflows)
    console.log('❌ 上列组合的画布高过了窗口高：盒子没被压扁，这些行的"没形变"不作数')
  } else {
    console.log('✅ 每个挂法都真的被压扁过（画布高从未超过窗口高）')
  }
  return bad.length === 0 && controlSkewed.length > 0 && overflows.length === 0
}

const targets = process.argv[2] ? [process.argv[2]] : ['chromium', 'webkit']
let ok = true
for (const t of targets) ok = (await run(t)) && ok
process.exit(ok ? 0 : 1)
