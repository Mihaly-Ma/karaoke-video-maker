/**
 * 界面文案的取值入口。
 *
 * ## 为什么现在是自己实现而不是直接上 react-i18next
 *
 * 契约（CLAUDE.md §8.8）定的顺序是：界面重排先落地，**但重排时就必须走翻译函数**
 * ——否则等重排完再抽取文案，等于把所有组件再摸一遍。
 *
 * 所以这里先把**接口面**定下来，用一个零依赖的实现顶着。组件只认识 `t()`，
 * 将来换成 react-i18next 只改本文件内部，不动任何组件。
 *
 * ## 使用约定
 *
 * - 界面上给用户看的文字**一律走 `t()`**，不要写字面量
 * - 键名按舞台分命名空间，见 `zh-CN.ts`
 * - 带变量的文案用 `{name}` 占位：`t('lyrics.lineCount', { n: 60 })`
 * - **开发者可见的东西不走这里**：日志、诊断信息、代码注释保持自然语言即可
 *
 * ## 还没做的事
 *
 * 语言切换入口、日文与英文语言包、以及后端错误码 → 文案的映射都还没有。
 * 后端目前直接返回中文句子并被前端原样显示，那是一次独立的 API 契约改造
 * （见 CLAUDE.md §8.8），不在本模块范围内。
 */

import { zhCN } from './zh-CN'

export type Locale = 'zh-CN'

/** 语言包表。加日文/英文时在这里注册，组件侧无需改动。 */
const CATALOGS: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
}

let current: Locale = 'zh-CN'

export const getLocale = (): Locale => current
export const setLocale = (loc: Locale): void => {
  current = loc
}

/** 已在本次会话里报过缺失的键，避免同一个键刷屏。 */
const warned = new Set<string>()

/**
 * 取一条文案。
 *
 * 查不到时**返回键名本身**而不是空字符串或抛错：界面上出现 `lyrics.candidates`
 * 这样的字样很扎眼、一眼就能发现漏了文案，而空白会被误认为"这里本来就没内容"。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = CATALOGS[current][key]
  if (raw === undefined) {
    // 不区分开发/生产：漏文案在哪个环境都是缺陷，控制台留一条即可，
    // 同一个键只报一次以免刷屏
    if (!warned.has(key)) {
      warned.add(key)
      console.warn(`[i18n] 缺少文案：${key}`)
    }
    return key
  }
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}
