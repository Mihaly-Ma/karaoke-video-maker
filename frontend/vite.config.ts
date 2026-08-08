import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// JASSUB（libass 的 WASM 构建）依赖 SharedArrayBuffer，而后者要求页面处于
// 跨源隔离状态。这组响应头必须从第一天就配上 —— 等到套 Tauri 壳时才发现
// 缺了它，前端架构可能要返工（CLAUDE.md D14）。
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  // credentialless 而非 require-corp：后者会连带拒绝没有显式 CORP 头的
  // 第三方资源，开发期极易踩坑
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: crossOriginIsolation,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  preview: { headers: crossOriginIsolation },
  // jassub 的 worker 与 wasm 需要以资源形式产出，不能被内联
  optimizeDeps: { exclude: ['jassub'] },
  worker: { format: 'es' },
})
