/**
 * 简体中文文案（源语言）。
 *
 * **按舞台拆成多个文件**，而不是塞进一个大对象——重构期各舞台由不同的人/agent
 * 并行改写，共享一个文件必然互相冲突。每个舞台只改自己那一份。
 *
 * 键名的命名空间与文件名一致（`media.*` 在 `media.ts` 里），
 * 新增文案前先看 `common.ts` 有没有可复用的：同一个动作在不同舞台应当用同一个词。
 *
 * 文案规则见 docs/ui-redesign.md「文案：短，且准确」——
 * 按钮用动词、状态用结果、解释性长句一律不进界面。
 */

import { align } from './align'
import { common } from './common'
import { exportStage } from './export'
import { home } from './home'
import { lyrics } from './lyrics'
import { media } from './media'
import { ruby } from './ruby'
import { style } from './style'

export const zhCN: Record<string, string> = {
  ...common,
  ...home,
  ...media,
  ...lyrics,
  ...align,
  ...ruby,
  ...style,
  ...exportStage,
}
