/**
 * 画布几何（前端侧）。
 *
 * **与后端 `kvm/render/geometry.py` 是同一个公式的两份实现**，与
 * `lib/fontCoverage.ts` 的 `renderedCharset` 同类：各自服务于自己那侧的时机——
 * 样式面板要在用户拖滑块的当帧就算出推荐值与警告线，为此发一次请求不划算。
 * 改任一处都要看另一处。
 */

/** 版面基准画幅。CLAUDE.md §8.5 的全部数值都是在它上面校准的。 */
export const REFERENCE_ASPECT = 16 / 9

/**
 * 版面锚点高度 = 画面内接的最大 16:9 框的高度 = `min(h, w × 9/16)`。
 *
 * 字号同时决定"读起来多大"（看高度）和"一行放得下几个字"（看宽度）。
 * 16:9 上这两者被画幅绑死，换个画幅就分家——只锚高度的话，4:3 上字相对宽度大
 * 33%、竖屏大 3.16 倍，一行放不下就被 `\fscx` 压扁，那是字真的变形。
 *
 * 16:9 时返回值恒等于画面高度，所以 16:9 工程的推荐值一个像素都不变。
 */
export function layoutRefHeight(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0
  return Math.max(1, Math.min(Math.round(height), Math.round((width * 9) / 16)))
}
