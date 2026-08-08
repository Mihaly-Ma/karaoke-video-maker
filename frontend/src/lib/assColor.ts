/**
 * ASS 颜色 ⇄ CSS 颜色互转。
 *
 * ASS 颜色的字面格式是 `&HAABBGGRR&`（也接受不带首尾 `&H`/`&`、大小写混合、
 * 不满 8 位的简写，如 `&H0&`）。**字节序是 AA BB GG RR —— 与直觉的 RGB 相反**，
 * 这是整个转换里最容易出错的地方，所以这里只暴露纯函数，不掺任何 UI 逻辑，
 * 方便单独用 node 验证往返转换（见文件末尾的自测说明）。
 *
 * 另外 ASS 的 alpha 字节语义与 CSS/HTML 相反：**`00` = 完全不透明，
 * `FF` = 完全透明**。原生 `<input type="color">` 取色器不支持 alpha，
 * 所以本项目的用法是：取色器只读写 RGB，alpha 字节原样透传（见
 * `PalettePicker.tsx` 里对 `cssHexToAss` 的调用），不在取色器里暴露透明度。
 */

/** 拆解后的颜色分量，均为 0-255 的整数字节。 */
export interface AssColorParts {
  r: number
  g: number
  b: number
  /** ASS 语义：0 = 不透明，255 = 完全透明。 */
  alpha: number
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function toHexByte(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0').toUpperCase()
}

/** 去掉 `&H`/`&` 包裹并校验、补齐成 8 位十六进制（AABBGGRR）。 */
function normalizeAssHex(ass: string): string {
  const cleaned = ass.trim().toUpperCase().replace(/^&H/, '').replace(/&$/, '')
  if (!/^[0-9A-F]{1,8}$/.test(cleaned)) {
    throw new Error(`不是合法的 ASS 颜色: ${ass}`)
  }
  return cleaned.padStart(8, '0')
}

/** 解析 `&HAABBGGRR&` 为 `{r,g,b,alpha}`。 */
export function parseAssColor(ass: string): AssColorParts {
  const hex = normalizeAssHex(ass)
  const value = Number.parseInt(hex, 16)
  return {
    alpha: (value >>> 24) & 0xff,
    b: (value >>> 16) & 0xff,
    g: (value >>> 8) & 0xff,
    r: value & 0xff,
  }
}

/** 由 `{r,g,b,alpha}` 组装回 `&HAABBGGRR&`。 */
export function formatAssColor({ r, g, b, alpha }: AssColorParts): string {
  return `&H${toHexByte(alpha)}${toHexByte(b)}${toHexByte(g)}${toHexByte(r)}&`
}

/**
 * ASS 颜色 → CSS 十六进制颜色（`#rrggbb`），供 `<input type="color">` 使用。
 * alpha 字节被丢弃——取色器不表达透明度，见文件头说明。
 */
export function assToCssHex(ass: string): string {
  const { r, g, b } = parseAssColor(ass)
  return `#${toHexByte(r).toLowerCase()}${toHexByte(g).toLowerCase()}${toHexByte(b).toLowerCase()}`
}

/**
 * CSS 十六进制颜色（`#rrggbb`，也接受不带 `#`）→ ASS 颜色。
 * `keepAlpha` 默认为 0（完全不透明），需要保留原 alpha 时由调用方传入
 * `parseAssColor(原值).alpha`，避免覆盖用户手工设置过的透明度。
 */
export function cssHexToAss(hex: string, keepAlpha = 0): string {
  const cleaned = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new Error(`不是合法的 CSS 颜色: ${hex}`)
  }
  const r = Number.parseInt(cleaned.slice(0, 2), 16)
  const g = Number.parseInt(cleaned.slice(2, 4), 16)
  const b = Number.parseInt(cleaned.slice(4, 6), 16)
  return formatAssColor({ r, g, b, alpha: keepAlpha })
}

/** ASS alpha 字节（0=不透明..255=透明）→ CSS 语义的不透明度（0..1）。 */
export function assAlphaToOpacity(assAlpha: number): number {
  return 1 - clampByte(assAlpha) / 255
}

/** CSS 语义的不透明度（0..1）→ ASS alpha 字节（0=不透明..255=透明）。 */
export function opacityToAssAlpha(opacity: number): number {
  return clampByte((1 - opacity) * 255)
}

/*
 * 自测（往返转换）：
 *   node --experimental-strip-types assColor.ts
 * 见开发过程中使用的临时脚本，已在 PalettePicker 报告中记录结果，
 * 不随本文件常驻——上面每个函数都是纯函数，任何单测框架接入时可直接复用。
 */
