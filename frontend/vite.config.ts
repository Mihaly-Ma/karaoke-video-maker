import react from '@vitejs/plugin-react'
import type { Connect, Plugin } from 'vite'
import { defineConfig } from 'vite'

// JASSUB（libass 的 WASM 构建）依赖 SharedArrayBuffer，而后者要求页面处于
// 跨源隔离状态。这组响应头必须从第一天就配上 —— 等到套 Tauri 壳时才发现
// 缺了它，前端架构可能要返工（CLAUDE.md D14）。
// `require-corp` 是标准值，也是契约 §5.9 表格里写死的那一个。
//
// 这里曾经用 `credentialless`（它对没带 CORP 头的第三方资源更宽容），代价是
// **只有 Chromium 认这个值**：WebKit 至今没有实现 credentialless，Safari 上
// `crossOriginIsolated` 恒为 false、`SharedArrayBuffer` 不可用，JASSUB 只能退回
// 单线程渲染。本项目根本没有第三方跨源资源 —— /api 与 /media 都经下面的 proxy
// 变成同源请求，jassub 的 wasm/worker 也是同源产物，所以 require-corp 的严格性
// 在这里不构成成本，反而换来 WebKit 侧真正的跨源隔离。
// **不要把 COEP 退回 credentialless** —— 那只是让 WebKit 拿不到跨源隔离、
// JASSUB 退回单线程，把问题藏起来而已。
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * 把跨源隔离响应头装进**最前面**的中间件，让它对每一个响应都生效 —— 包括 304。
 *
 * ## 为什么 `server.headers` / `preview.headers` 不够（这是 Safari 字幕消失的真因）
 *
 * Vite 把这两处配置交给 sirv 的 `setHeaders` 回调去落实，而 sirv 的顺序是
 * **先判条件请求、再调 setHeaders**：命中 `If-None-Match` 时直接
 * `res.writeHead(304); res.end()` 就返回了，setHeaders 根本没被调用
 * （vite 6 打包进 dist 的 sirv，`if (isEtag && req.headers['if-none-match'] === …)`）。
 * Vite 自己的 `send()` 与 `cachedTransformMiddleware` 同样是先 304 后设头。
 * 于是 **dev 和 preview 的 304 响应上都没有 COOP/COEP**（`curl -H 'If-None-Match: …'`
 * 可直接复现）。
 *
 * 而 WebKit 在「304 合并缓存响应」时**不会把原来那份 200 上的 COEP 带回来**，
 * 于是 worker 脚本的 COEP 被算成 unsafe-none，与文档的 require-corp 不兼容，
 * HTML 规范的 "check a global object's embedder policy" 判否 ——
 * 报 `Refused to load '…/worker.js' worker because of Cross-Origin-Embedder-Policy`。
 * 表现极具迷惑性：**页面里第一个 worker 正常，第二个就起不来**（第一次是 200，
 * 第二次才走条件请求），而本应用编辑舞台与样式舞台各要一个 JASSUB 实例，
 * 于是「编辑有字幕、样式一直转圈」。被拒之后 WebKit 会丢掉那条缓存条目，
 * 所以第三次又变成 200 而成功 —— 成功/失败逐次交替，看起来像随机时序问题。
 *
 * 实测矩阵见 `scripts/probe-coep-headers.mjs`（自建服务器、单变量对照）：
 * 只要 304 上带了 COOP/COEP，WebKit 连起 4 个 worker 全部成功；不带就 ok/❌ 交替。
 * Chromium 两种情况都正常 —— 所以这个坑**只在 WebKit 上暴露**，光在 Chromium 上
 * 验证必然漏掉。
 *
 * ## 为什么是这个修法，不是别的
 *
 * - **不是把 COEP 降级**：降级会丢掉跨源隔离与 SharedArrayBuffer，等于藏问题。
 * - **不是给资源加 `Cache-Control: no-store` 逼出 200**：那能绕开，但把「缺头」
 *   这个真正的缺陷留在原地，任何别的 worker 脚本仍会中招；而且每次都要重下。
 * - **不是只改 dev**：dev 与 preview 走的是同一个 sirv 代码路径，缺陷一模一样，
 *   所以这里 `configureServer` 与 `configurePreviewServer` 装的是同一个中间件。
 * - **不能只写 `server.headers`**：见上，它对 304 无效。配置项仍然保留，
 *   因为它是 Vite 的标准旋钮、也是契约里写明的那一项；本插件是它的补漏。
 *
 * `server.middlewares.use()` 在 hook 内**直接调用**时装在 Vite 内建中间件之前
 * （返回函数才是装在之后），这正是需要的顺序：先 setHeader，后面无论谁
 * `writeHead(304)` 都会把已设的头一起发出去（Node 的 writeHead 不会清掉 setHeader）。
 *
 * ## Tauri 壳那边的情况（已实测，2026-08-10）
 *
 * 打好包的应用里，前端**不由 Tauri 的协议处理器下发**，而是由 Python 后端在
 * `http://127.0.0.1:<port>` 上同源下发（原因见 `backend/kvm/api/app.py` 的模块注释：
 * `tauri://` 自定义协议下没有 `SharedArrayBuffer` 全局，JASSUB 起不来）。
 * 后端那边的 COOP/COEP 由 FastAPI 中间件在 `call_next` **之后**统一补，实测
 * 条件请求命中的 **304 上照样带着这两个头**，所以同一个坑在成品链路上不存在。
 *
 * 顺带实测到的：Tauri 的 app 协议**根本没有条件请求**（永远 200，不发 ETag），
 * 而 WKWebView 在"304 不带 COEP"时连起 4 个 worker 也全都成功了。
 *
 * **但绝不要拿这两条去删掉上面那个中间件。** 本文件服务的是 Vite dev/preview，
 * 那两条结论来自 WKWebView 与 Tauri 协议，与这里是两套链路；而"304 缺 COEP →
 * worker 被拒"是在**真 Safari** 上实测出来的（playwright 的 webkit 与系统
 * WKWebView 也不是一回事）。判据仍以 `scripts/probe-coep-headers.mjs` 为准。
 */
const applyIsolationHeaders: Connect.NextHandleFunction = (_req, res, next) => {
  for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value)
  next()
}

const crossOriginIsolationPlugin: Plugin = {
  name: 'kvm:cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use(applyIsolationHeaders)
  },
  configurePreviewServer(server) {
    server.middlewares.use(applyIsolationHeaders)
  },
}

// 后端一律经代理变成同源，跨源隔离下就不必给每个媒体请求单独操心 CORP/CORS。
//
// dev 与 preview 都要有：preview 跑的是构建产物，「生产形态下 WebKit 到底行不行」
// 只能在那上面验证，而没有代理连工程列表都拉不到。
//
// 两边唯一的差别是 `changeOrigin`：FastAPI 的 `redirect_slashes` 会用请求的 Host
// 拼出**绝对** Location（`/api/projects` → `/api/projects/`）。改写 Host 之后那个
// Location 指向后端自己，浏览器跟过去就成了跨源请求，撞上 CORS 白名单
// （只放行了 5173）。preview 跑在别的端口，所以这里保留原 Host，让重定向落回同源。
const backendTarget = 'http://127.0.0.1:8000'
const devProxy = {
  '/api': { target: backendTarget, changeOrigin: true },
  '/media': { target: backendTarget, changeOrigin: true },
}
const previewProxy = {
  '/api': { target: backendTarget },
  '/media': { target: backendTarget },
}

export default defineConfig({
  plugins: [react(), crossOriginIsolationPlugin],
  server: {
    port: 5173,
    headers: crossOriginIsolation,
    proxy: devProxy,
  },
  preview: { headers: crossOriginIsolation, proxy: previewProxy },
  optimizeDeps: {
    // jassub 的 worker 与 wasm 需要以资源形式产出，不能被内联
    exclude: ['jassub'],
    // 补充：真正被加载的 worker/wasm 来自 public/jassub/（见 src/lib/jassub.ts 的
    // JASSUB_ASSETS —— 那是为了 dev 与构建产物加载同一份字节）。这条 exclude
    // 仍然要留着：主线程侧的 jassub.js 照旧走正常 import，被预构建内联会连带把
    // `new Worker(new URL(...))` 一起改写坏。
    // 但排除 jassub 会连带跳过它的依赖预构建，而 `throughput` 是 CJS 包
    // （无 type:module / exports）。浏览器直接 ESM import 一个 CJS 包会抛
    // "does not provide an export named 'default'"，整个应用白屏 ——
    // 且这个错误只在运行时出现，tsc / lint / vite build 全部检测不到。
    include: ['throughput'],
  },
  worker: { format: 'es' },
})
