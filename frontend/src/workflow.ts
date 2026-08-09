import type { Project } from './api/types'

/**
 * 六个工作流步骤的定义与"走到哪一步"的判据。
 *
 * 顶栏步骤条和首页卡片上的分段进度条**必须共用同一份判据**——两处各算一遍，
 * 迟早会算出不一样的结果，用户看到卡片说"已对轴"、进去步骤条却不打勾。
 *
 * 判定原则（docs/ui-redesign.md §八）：**看该步骤的产物在不在**，不看用户点没点过。
 * 工程文件是唯一真源，产物存在就是完成，跟用户走没走完流水线无关（§2.5 允许任意跳步）。
 */

export type StepKey = 'media' | 'lyrics' | 'align' | 'ruby' | 'style' | 'export'

export const STEP_ORDER: StepKey[] = ['media', 'lyrics', 'align', 'ruby', 'style', 'export']

export const STEP_LABEL: Record<StepKey, string> = {
  media: '素材',
  lyrics: '歌词',
  align: '对轴',
  ruby: '注音',
  style: '样式',
  export: '导出',
}

export interface StepStatus {
  /** 产物已存在 */
  done: boolean
  /**
   * 前置条件已满足。为 false 只表示"这一步现在做不了实事"，**不禁用按钮**——
   * 用户可能先来看看这一步长什么样，强制引导反而挡路。
   */
  ready: boolean
  /** ready=false 时说明还缺什么，挂在按钮的 title 上 */
  blockedBy: string
}

/** 该步骤的产物在不在。project 为 null 时（首页详情还没取到）一律未完成。 */
function isDone(step: StepKey, project: Project | null, exported: boolean): boolean {
  if (!project) return false
  switch (step) {
    // 音频才是下游真正消费的产物（分离、对齐、波形都吃它）；视频只影响观感，
    // 缺视频照样能把轴打完，所以不拿 video_path 参与判定。
    case 'media':
      return !!project.audio_path
    case 'lyrics':
      return project.lines.length > 0
    // 只认实测或人工的时间。interpolated 是按权威粒度等分推算出来的，契约 §4.2
    // 明确它不能当锚点；把它算作"已对轴"会让用户以为这批时间已经可信。
    // unset 则是从未定过时（纯文本导入后的状态）。
    case 'align':
      return project.lines.some((l) =>
        l.tokens.some(
          (t) => t.timing_source === 'provider' || t.timing_source === 'aligned' || t.timing_source === 'manual',
        ),
      )
    case 'ruby':
      return project.lines.some((l) => l.ruby.length > 0)
    // palettes 新建工程时是空对象，写进去就说明用户确实调过配色。
    // 不用 style 字段判定——它一建工程就带全套默认值，拿它判会全部误判为已完成。
    case 'style':
      return Object.keys(project.palettes).length > 0
    // 工程文件里没有任何导出产物的记录（后端也没给字段），只能靠本次会话的导出结果。
    // 于是刷新页面后这一格会退回未完成——需要后端补一个"最近产物"字段才能修。
    case 'export':
      return exported
  }
}

export function stepStatus(project: Project | null, exported = false): Record<StepKey, StepStatus> {
  const done = Object.fromEntries(STEP_ORDER.map((k) => [k, isDone(k, project, exported)])) as Record<StepKey, boolean>

  const gate = (key: StepKey, ok: boolean, blockedBy: string): StepStatus => ({
    done: done[key],
    ready: ok,
    blockedBy: ok ? '' : blockedBy,
  })

  return {
    media: gate('media', true, ''),
    lyrics: gate('lyrics', true, ''),
    // 没有歌词就没有 token，轴、注音、样式预览全都无从谈起
    align: gate('align', done.lyrics, '需要先导入歌词'),
    ruby: gate('ruby', done.lyrics, '需要先导入歌词'),
    style: gate('style', done.lyrics, '需要先导入歌词'),
    export: gate('export', done.media && done.lyrics, '需要素材和歌词'),
  }
}
