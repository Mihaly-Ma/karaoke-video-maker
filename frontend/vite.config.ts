import react from '@vitejs/plugin-react'
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
//
// **已知代价（只在 dev server 上）**：隔离一旦生效，JASSUB 就走 emscripten 的
// pthread 路径，在 worker 内部再起嵌套 worker；而 Vite 在 dev 会往每个被它转换过的
// worker 文件里注入 `import '/node_modules/vite/dist/client/env.mjs'`，WebKit 拒绝
// 加载嵌套 worker 里的这个 import（报 "Worker load was blocked by
// Cross-Origin-Embedder-Policy"），于是 Safari 上 dev 模式看不到字幕预览。
// 补 `Cross-Origin-Resource-Policy` 无效——这些资源本来就是同源的。
// 生产构建没有这个注入，实测 `vite preview` 下 WebKit 隔离生效且控制台零报错，
// 所以最终形态（Tauri 壳里跑构建产物）不受影响。
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
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
  plugins: [react()],
  server: {
    port: 5173,
    headers: crossOriginIsolation,
    proxy: devProxy,
  },
  preview: { headers: crossOriginIsolation, proxy: previewProxy },
  optimizeDeps: {
    // jassub 的 worker 与 wasm 需要以资源形式产出，不能被内联
    exclude: ['jassub'],
    // 但排除 jassub 会连带跳过它的依赖预构建，而 `throughput` 是 CJS 包
    // （无 type:module / exports）。浏览器直接 ESM import 一个 CJS 包会抛
    // "does not provide an export named 'default'"，整个应用白屏 ——
    // 且这个错误只在运行时出现，tsc / lint / vite build 全部检测不到。
    include: ['throughput'],
  },
  worker: { format: 'es' },
})
