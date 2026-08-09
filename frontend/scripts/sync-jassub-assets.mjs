/**
 * 把 jassub 的 worker / wasm 复制进 public/jassub/，让浏览器直接加载这份静态副本。
 *
 * ## 为什么必须绕开 Vite
 *
 * dev server 会往每个**被它转换过**的 worker 文件顶部注入一行
 * `import '/node_modules/vite/dist/client/env.mjs'`。页面处于跨源隔离时 JASSUB 会走
 * emscripten 的 pthread 路径，在 worker 内部再起嵌套 worker，而 WebKit 拒绝加载嵌套
 * worker 里的这个 import（报 "Worker load was blocked by Cross-Origin-Embedder-Policy"），
 * JASSUB 于是一直不就绪、字幕整块不出现。Chromium 不受影响，生产构建也没有这段注入。
 *
 * Vite 对 `public/` 下的文件原样下发、不做任何转换，注入也就无从谈起 —— 同时
 * COEP 仍是 require-corp、跨源隔离照旧。这一点很关键：修法不是把 COEP 降级换来的，
 * SharedArrayBuffer 与多线程 libass 都还在。
 *
 * ## 为什么不是一句 cp
 *
 * worker 入口 `dist/worker/worker.js` 有三个裸导入（abslink / abslink/w3c /
 * lfa-ponyfill），浏览器原样加载解析不了。这里把这三个包用到的源文件一并复制到
 * vendor/ 下，并只改写这三处 specifier；其余相对导入与目录层级一律原样保留。
 *
 * 目录层级尤其不能拍平：emscripten 胶水文件靠
 * `new URL('jassub-worker.js', import.meta.url)` 起嵌套 worker、靠
 * `new URL('jassub-worker.wasm', import.meta.url)` 找 wasm，`worker/` 与 `wasm/`
 * 的相对关系一变就会指错。生产构建里 Rollup 把同一处改写成了
 * `new Worker(self.location.href, ...)`，本质是同一个自引用。
 *
 * ## 一致性保障
 *
 * - 版本必须与 package.json 里锁死的 jassub 版本完全一致（CLAUDE.md §5.9），
 *   对不上直接报错退出，不静默复制出一份不匹配的资源；
 * - 复制完扫一遍所有 .js：还有裸导入、或相对导入指向没被复制的文件，都算失败。
 *   上游改了模块结构时这里会立刻炸，而不是等到运行时字幕空白。
 *
 * 产物不入库（见根 .gitignore），每次 `npm run dev` / `npm run build` 前重建。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_MODULES = join(FRONTEND, 'node_modules')
const OUT_DIR = join(FRONTEND, 'public', 'jassub')

/**
 * 复制清单：源文件（相对 node_modules）→ 目标（相对 public/jassub）。
 *
 * jassub 侧只取 worker 真正会加载到的那几个模块 —— `webgpu-renderer.js` 没有被
 * worker.js 导入（上游注释掉了 WebGPU 路径），复制它只会白白多 4MB 里的一块。
 */
const FILES = [
  // --- worker 入口与它的相对依赖 ---
  ['jassub/dist/worker/worker.js', 'worker/worker.js'],
  ['jassub/dist/worker/util.js', 'worker/util.js'],
  ['jassub/dist/worker/renderers/2d-renderer.js', 'worker/renderers/2d-renderer.js'],
  ['jassub/dist/worker/renderers/webgl1-renderer.js', 'worker/renderers/webgl1-renderer.js'],
  ['jassub/dist/worker/renderers/webgl2-renderer.js', 'worker/renderers/webgl2-renderer.js'],
  // --- emscripten 胶水 + 两份 wasm ---
  // 胶水既被 worker.js 当模块导入，又被自己当作嵌套 pthread worker 起起来，
  // 所以它这份副本正是本次修复的靶心。
  ['jassub/dist/wasm/jassub-worker.js', 'wasm/jassub-worker.js'],
  ['jassub/dist/wasm/jassub-worker.wasm', 'wasm/jassub-worker.wasm'],
  ['jassub/dist/wasm/jassub-worker-modern.wasm', 'wasm/jassub-worker-modern.wasm'],
  // 兜底字体（Liberation Sans，145KB，无 CJK）。应用侧一般用不到 —— 它总会把系统
  // 字体子集喂进来。留一份是给 scripts/verify-subtitles.mjs 的自检夹具用：那条用例
  // 要在不依赖后端字体接口的前提下让 libass 画出可测的像素。
  ['jassub/dist/default.woff2', 'default.woff2'],
  // --- 三个裸导入对应的包 ---
  ['abslink/src/abslink.js', 'vendor/abslink/src/abslink.js'],
  ['abslink/src/types.js', 'vendor/abslink/src/types.js'],
  ['abslink/adapters/w3c.js', 'vendor/abslink/adapters/w3c.js'],
  ['lfa-ponyfill/index.js', 'vendor/lfa-ponyfill/index.js'],
  // queryFonts=false 时用不到，但 index.js 里有 import('./fonts.json')，
  // 一并复制才能让下面的导入自检成立。
  ['lfa-ponyfill/fonts.json', 'vendor/lfa-ponyfill/fonts.json'],
]

/** worker.js 里仅有的三处裸导入 → 相对 public 的路径 */
const BARE_IMPORT_REWRITES = [
  ["'abslink'", "'../vendor/abslink/src/abslink.js'"],
  ["'abslink/w3c'", "'../vendor/abslink/adapters/w3c.js'"],
  ["'lfa-ponyfill'", "'../vendor/lfa-ponyfill/index.js'"],
]

const die = (msg) => {
  console.error(`[sync-jassub-assets] ${msg}`)
  process.exit(1)
}

// --- 版本闸门 -------------------------------------------------------------
// 期望值取自 package.json 而不是写死在脚本里：一处真源，顺带把「必须精确锁版本」
// 这条契约也一并校验了。
const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8'))
const pinned = pkg.dependencies?.jassub
if (!pinned) die('package.json 的 dependencies 里没有 jassub')
if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
  die(`jassub 必须锁死到精确版本（CLAUDE.md §5.9），当前是 "${pinned}"`)
}
const installedPath = join(NODE_MODULES, 'jassub/package.json')
if (!existsSync(installedPath)) die('没找到 node_modules/jassub，先跑 npm install')
const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version
if (installed !== pinned) {
  die(
    `jassub 版本不一致：package.json 锁的是 ${pinned}，装上的是 ${installed}。` +
      '静态副本与主线程侧的 jassub.js 必须同版本，否则 worker 协议对不上，' +
      '表现为字幕不出现且没有明显报错。请先 npm install 再跑本脚本。',
  )
}

// --- 复制 -----------------------------------------------------------------
// 整个目录先删后建：上游删文件时不留下孤儿副本，避免自检扫到过期文件而误判通过。
rmSync(OUT_DIR, { recursive: true, force: true })

/** 去掉 sourceMappingURL：.map 没被复制，留着只会在 devtools 里刷 404 */
const stripSourceMap = (text) => text.replace(/\n?\/\/# sourceMappingURL=.*$/gm, '')

const copied = new Set()
for (const [from, to] of FILES) {
  const src = join(NODE_MODULES, from)
  if (!existsSync(src)) die(`源文件缺失：node_modules/${from}（jassub ${installed} 的目录结构变了？）`)
  const dst = join(OUT_DIR, to)
  mkdirSync(dirname(dst), { recursive: true })

  if (to.endsWith('.js')) {
    let text = stripSourceMap(readFileSync(src, 'utf8'))
    if (to === 'worker/worker.js') {
      for (const [bare, rel] of BARE_IMPORT_REWRITES) {
        const hits = text.split(bare).length - 1
        // 必须恰好一处：0 处说明上游换了依赖，多处说明改写会误伤别的字符串
        if (hits !== 1) die(`worker.js 里 ${bare} 出现了 ${hits} 次，预期 1 次，改写不安全`)
        text = text.replace(bare, rel)
      }
    }
    writeFileSync(dst, text)
  } else {
    copyFileSync(src, dst)
  }
  copied.add(to)
}

// --- 自检：副本自身要能被浏览器原样解析 ------------------------------------
// 只认行首的 import/export ... from '...'（编译产物就是这个形状），外加同行的
// 动态 import('...')；`import.meta.url`、`new URL(...)` 不会被误判。
// 注释行整行跳过 —— JSDoc 里的 `@param {import('./typedef.d.ts').X}` 长得和动态
// 导入一模一样，但它只是类型标注，运行时不会去取那个文件。
const STATIC_IMPORT = /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/
const SIDE_EFFECT_IMPORT = /^\s*import\s*['"]([^'"]+)['"]/
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]/g

const problems = []
for (const to of copied) {
  if (!to.endsWith('.js')) continue
  const text = readFileSync(join(OUT_DIR, to), 'utf8')
  const specs = []
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    const m = STATIC_IMPORT.exec(line) ?? SIDE_EFFECT_IMPORT.exec(line)
    if (m) specs.push(m[1])
    for (const d of line.matchAll(DYNAMIC_IMPORT)) specs.push(d[1])
  }

  for (const spec of specs) {
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      problems.push(`${to}: 裸导入 "${spec}" 浏览器解析不了`)
      continue
    }
    // 相对导入必须落在已复制的文件上，否则运行时 404
    const target = posix.normalize(posix.join(posix.dirname(to), spec))
    if (!copied.has(target)) problems.push(`${to}: 相对导入 "${spec}" 指向未复制的 ${target}`)
  }
}
if (problems.length) {
  die(
    `静态副本的模块图不完整（jassub ${installed}）：\n  ` +
      problems.join('\n  ') +
      '\n请更新本脚本的 FILES / BARE_IMPORT_REWRITES 清单。',
  )
}

console.log(`[sync-jassub-assets] jassub ${installed} → public/jassub/（${copied.size} 个文件）`)
