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

/** 字号占版面锚点高度的比例（CLAUDE.md §8.5）。 */
const FONT_SIZE_RATIO = 0.075
/** 全角字符 advance ÷ Fontsize，已实测（§5.7：字号 72 时 CJK advance 50px）。 */
const CJK_ADVANCE_RATIO = 0.694
/** 一行按多少个全角字预留宽度。取 §5.8「12–20 全角字符」的上端。 */
const REFERENCE_LINE_CHARS = 20
/** 推荐左右边距占宽度的比例（§8.5），左右各一份。 */
const MARGIN_H_RATIO = 0.045

const WIDTH_CAP_RATIO =
  (1 - 2 * MARGIN_H_RATIO) / (REFERENCE_LINE_CHARS * CJK_ADVANCE_RATIO * FONT_SIZE_RATIO)

/**
 * 版面锚点高度：**以画面高度为准，但受"一行放得下"封顶**。
 *
 * 字号同时决定"读起来多大"（看高度）和"一行放得下几个字"（看宽度）。
 * 16:9 上这两者被画幅绑死，换个画幅就分家——只锚高度的话，窄画面上一行放不下
 * 就被 `\fscx` 压扁，那是字真的变形。
 *
 * **封顶只在真的放不下时才生效**：16:9 与 4:3 都不受影响（4:3 一行本来就能放
 * 23 个全角字），1:1 与竖屏才会压。
 */
export function layoutRefHeight(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0
  return Math.max(1, Math.min(Math.round(height), Math.round(width * WIDTH_CAP_RATIO)))
}
