import type { Project } from './api/types'

/**
 * 五个工作流步骤的定义与"走到哪一步"的判据。
 *
 * 顶栏步骤条和首页卡片上的分段进度条**必须共用同一份判据**——两处各算一遍，
 * 迟早会算出不一样的结果，用户看到卡片说"已对轴"、进去步骤条却不打勾。
 *
 * 判定原则（docs/ui-redesign.md §八）：**看该步骤的产物在不在**，不看用户点没点过。
 * 工程文件是唯一真源，产物存在就是完成，跟用户走没走完流水线无关（§2.5 允许任意跳步）。
 *
 * ## 对轴与注音合并成「编辑」
 *
 * 二者修正的是**同一个选中词**（一个管何时唱、一个管怎么读），拆成两步等于同一个词
 * 要在两处各选一次；且独立的注音步骤没有任何播放能力，而读音只能靠耳朵验证
 * （docs/ui-redesign.md §四）。
 */

export type StepKey = 'media' | 'lyrics' | 'edit' | 'style' | 'export'

export const STEP_ORDER: StepKey[] = ['media', 'lyrics', 'edit', 'style', 'export']

export const STEP_LABEL: Record<StepKey, string> = {
  media: '素材',
  lyrics: '歌词',
  edit: '编辑',
  style: '样式',
  export: '导出',
}

/**
 * 已被合并掉的旧步骤 → 新步骤。
 *
 * 每个工程记着自己"上次在哪一步"（`localStorage['kvm.step.<id>']`），老工程里存的
 * 可能还是 `align` / `ruby`。不认它就会静默退回「素材」，用户打开一个已经调了一半的
 * 工程却被扔回第一步。
 */
const LEGACY_STEP: Record<string, StepKey> = {
  align: 'edit',
  ruby: 'edit',
}

/** 把存下来的步骤名归一化成当前的步骤集合，认不出来的一律回「素材」。 */
export function normalizeStep(saved: string | null | undefined): StepKey {
  if (!saved) return 'media'
  if ((STEP_ORDER as string[]).includes(saved)) return saved as StepKey
  return LEGACY_STEP[saved] ?? 'media'
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
    /*
     * 「编辑」= 对轴 + 注音，但判据**只看时间轴**：
     *
     * - 只认实测或人工的时间。interpolated 是按权威粒度等分推算出来的，契约 §4.2
     *   明确它不能当锚点；把它算作"已对轴"会让用户以为这批时间已经可信。
     *   unset 则是从未定过时（纯文本导入后的状态）。
     * - **不要求有注音**：纯假名歌词（以及英文曲）本来就一处注音都不该有，
     *   把 `ruby.length > 0` 与进来会让这类曲目永远显示未完成。注音缺不缺，
     *   舞台里那份「待检查」清单说得比一个勾清楚。
     */
    case 'edit':
      return project.lines.some((l) =>
        l.tokens.some(
          (t) => t.timing_source === 'provider' || t.timing_source === 'aligned' || t.timing_source === 'manual',
        ),
      )
    // palettes 新建工程时是空对象，写进去就说明用户确实调过配色。
    // 不用 style 字段判定——它一建工程就带全套默认值，拿它判会全部误判为已完成。
    case 'style':
      return Object.keys(project.palettes).length > 0
    // `project.exports` 在前端只装 `GET /api/render/exports/{id}` 核对过、文件确实
    // 还在的那批（见 projectStore 的 loadExports），**不是**工程 JSON 里的持久化原值——
    // 后者可能留着用户已经删掉的成片，据此打勾就是在说一件不成立的事。
    // 有它之后刷新页面这一格不再退回未完成；`exported` 仍保留，用于本次会话刚导完、
    // 清单还没拉回来的那一小段时间。
    case 'export':
      return exported || project.exports.length > 0
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
    edit: gate('edit', done.lyrics, '需要先导入歌词'),
    style: gate('style', done.lyrics, '需要先导入歌词'),
    export: gate('export', done.media && done.lyrics, '需要素材和歌词'),
  }
}
