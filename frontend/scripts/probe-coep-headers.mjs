// 根因探针（第二层）：把 Vite 完全摘出去，用一台自建的最小静态服务器，
// 逐个变量地测「跨源隔离页面里重复加载同一个 worker 脚本」在 WebKit 上什么时候会被拒。
//
// 只做取证，不参与门禁。用法：node scripts/probe-coep-headers.mjs [chromium|webkit]
//
// 变量：Cache-Control 取值 × 是否带 Vary × 是否带 ETag（→ 会不会走 304）×
//       304 上带不带 COEP × worker 类型。
// 每组都在一个全新的浏览器上下文里跑（HTTP 缓存清空），同一页面内连起 4 次。

import { createServer } from 'node:http'
import { chromium, webkit } from 'playwright'

const engineName = process.argv[2] ?? 'webkit'
const PORT = 5199

// 每组用不同的路径前缀，彼此的缓存条目互不干扰
const VARIANTS = [
  { id: 'no-header', cc: null, vary: false, etag: false, coepOn304: false },
  { id: 'no-cache', cc: 'no-cache', vary: true, etag: false, coepOn304: false },
  { id: 'no-store', cc: 'no-store', vary: false, etag: false, coepOn304: false },
  { id: 'immutable', cc: 'max-age=31536000, immutable', vary: false, etag: false, coepOn304: false },
  // ↓ 关键三组：带 ETag 才会有条件请求，才会出现 304
  // vite-etag 复刻 Vite dev server 现状：no-cache + ETag + Vary，且 304 上不带 COEP
  { id: 'vite-etag', cc: 'no-cache', vary: true, etag: true, coepOn304: false },
  { id: 'etag-nocc', cc: null, vary: false, etag: true, coepOn304: false },
  // 同样走 304，但把 COEP 补在 304 上 —— 用来证明「304 缺 COEP」就是那个变量
  { id: 'etag-coep304', cc: 'no-cache', vary: true, etag: true, coepOn304: true },
  // 走 304 但 Cache-Control: no-store（浏览器不该缓存，也就不该有条件请求）
  { id: 'etag-nostore', cc: 'no-store', vary: false, etag: true, coepOn304: false },
]

const PAGE = `<!doctype html><meta charset=utf-8><title>coep probe</title><body>probe</body>`
const WORKER = `postMessage('alive')\n`

const ETAG = 'W/"probe-1"'
/** 服务器实际发了什么，按变体记账，供报告里区分 200 与 304 */
const served = new Map()

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname

  if (path === '/') {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Content-Type', 'text/html')
    res.end(PAGE)
    return
  }
  const m = /^\/w\/([^/]+)\/worker\.js$/.exec(path)
  if (m) {
    const v = VARIANTS.find((x) => x.id === m[1])
    if (v?.cc) res.setHeader('Cache-Control', v.cc)
    if (v?.vary) res.setHeader('Vary', 'Origin')
    if (v?.etag) res.setHeader('ETag', ETAG)

    const log = served.get(v.id) ?? []
    served.set(v.id, log)

    if (v?.etag && req.headers['if-none-match'] === ETAG) {
      // 304 上是否补 COEP —— 这正是本轮要区分的那个变量。
      // 现实里 Vite/sirv 走的是「不补」这一支（实测 curl 已确认）。
      if (v.coepOn304) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      }
      log.push(304)
      res.statusCode = 304
      res.end()
      return
    }
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Content-Type', 'text/javascript')
    log.push(200)
    res.end(WORKER)
    return
  }
  res.statusCode = 404
  res.end('')
})
await new Promise((r) => server.listen(PORT, r))

const browser = await { chromium, webkit }[engineName].launch()

const spawn = (page, url, type) =>
  page.evaluate(
    async ([url, type]) => {
      const w = new Worker(url, { type })
      const r = await new Promise((res) => {
        const t = setTimeout(() => res('超时'), 5000)
        w.onmessage = () => (clearTimeout(t), res('ok'))
        w.onerror = (e) => (clearTimeout(t), res(`❌${e.message ? `:${e.message}` : ''}`))
      })
      w.terminate()
      return r
    },
    [url, type],
  )

console.log(`\n########## ${engineName} @ http://localhost:${PORT}/ ##########`)
for (const type of ['module', 'classic']) {
  console.log(`\n=== worker type: ${type} ===`)
  for (const v of VARIANTS) {
    // 每组一个全新 context：HTTP 缓存与内存缓存都不带上一组的残留
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const errs = []
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
    await page.goto(`http://localhost:${PORT}/`)
    const iso = await page.evaluate(() => globalThis.crossOriginIsolated === true)
    served.delete(v.id)
    const seq = []
    for (let i = 0; i < 4; i++) seq.push(await spawn(page, `/w/${v.id}/worker.js`, type))
    console.log(
      `  ${v.id.padEnd(14)} isolated=${iso}  ${seq.map((s) => s.padEnd(3)).join(' ')}` +
        `  服务端发出=${(served.get(v.id) ?? []).join(',')}` +
        `  COEP报错×${errs.filter((e) => /Embedder-Policy/.test(e)).length}`,
    )
    await ctx.close()
  }
}

await browser.close()
server.close()
