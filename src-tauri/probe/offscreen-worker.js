// 在 worker 里对 transfer 过来的 OffscreenCanvas 真画一笔。
// 只测 `'transferControlToOffscreen' in HTMLCanvasElement.prototype` 是不够的：
// 属性存在不等于 transfer 后在 worker 里拿得到 2d/webgl 上下文。
self.onmessage = (e) => {
  try {
    const canvas = e.data.canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      self.postMessage({ ok: false, error: 'worker 内 getContext("2d") 返回 null' })
      return
    }
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const px = ctx.getImageData(1, 1, 1, 1).data
    self.postMessage({ ok: px[0] === 255 && px[1] === 0, pixel: [px[0], px[1], px[2], px[3]] })
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) })
  }
}
