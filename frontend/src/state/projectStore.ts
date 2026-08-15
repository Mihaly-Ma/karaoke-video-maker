import { create } from 'zustand'
import * as api from '../api/client'
import type { LockTarget, Palette, Project, TimingItem } from '../api/types'

/**
 * 编辑器状态层。
 *
 * 撤销/重做由**后端**持有（见 backend/kvm/api/store.py）：工程文件是唯一真源，
 * 前端只是它的视图。把历史放前端会在多窗口、崩溃恢复、以及"后端自动重算"
 * 这三种场景下与真源脱节。
 *
 * 前端只维护「选择」与「播放位置」这类纯视图状态。
 *
 * ## 播放状态的唯一写入者是 Preview（单一时钟）
 *
 * `playheadMs` / `playing` / `playbackRate` 这三个字段构成**唯一的播放时钟**，
 * 执行者只有 `Preview.tsx` 一个：它按 CLAUDE.md D15 用 Web Audio 当主时钟、
 * `<video>` 当从动方。别的组件一律**不许自己起播放器**，只能：
 *
 * - 写这三个字段 = 发出「跳到这里 / 播 / 停 / 变速」的**意图**；
 * - 读 `playheadMs` = 显示（画播放头、跟随滚动、打点取时间）。
 *
 * Preview 收到意图后执行真正的 seek / play，再把落地后的真实位置写回
 * `playheadMs`，并用「最后一次自己写入的值」切断回环（见 Preview 的 `lastEmittedRef`）。
 * 曾经波形层也有一份自己的时钟并把结果写回这里，两个时钟互相追时间，
 * 表现为播放头抖动 + 多余 seek —— 不要再引入第二个时钟。
 */

export type Selection =
  | { kind: 'none' }
  | { kind: 'line'; lineId: string }
  | { kind: 'token'; lineId: string; tokenIndex: number }

interface ProjectState {
  project: Project | null
  loading: boolean
  error: string | null

  /**
   * 播放头位置（毫秒，音频时间基准）。
   *
   * 播放中由 Preview 逐帧写入；其它组件写它表示「请求跳到这里」（见文件头）。
   */
  playheadMs: number
  /** 期望的播放状态。写 true/false 即「请播放/请暂停」，由 Preview 执行。 */
  playing: boolean
  /**
   * 播放速率。打轴推荐 0.5~0.75x（CLAUDE.md §5.10）。
   *
   * 放在 store 而不是时间轴本地状态：真正变速的是 Preview 的音频引擎与 `<video>`，
   * 时间轴只是那个下拉框所在的地方。
   */
  playbackRate: number
  selection: Selection
  /** 试听伴奏还是原声。调轴时切到伴奏更容易听清节拍。 */
  audioMode: 'original' | 'instrumental'
  /**
   * 是否叠加引导声（ガイドメロディ）。
   *
   * 与 `audioMode` 同一性质：它**既是导出设置也是试听设置**，只存一份。
   * 导出舞台那个「混入引导声」勾选框读写的就是它，预览的音频引擎也按它决定
   * 引导声那一层出不出声——结构上不可能出现"设置勾了、预览却听不到"。
   *
   * 与 ON/OFF VOCAL 不同的是它是**叠加层**而不是二选一：引导声可以配原声，
   * 也可以配伴奏，所以它不参与「原声 / 伴奏 / 仅人声」那组预设的互斥判断。
   */
  guideEnabled: boolean
  /**
   * 补黑边到 16:9。**既是导出设置也是预览设置，只存一份**——与 `guideEnabled`
   * 同一性质，理由也一样：补边改的是画布尺寸（ASS 的 PlayRes），字号相对画面的
   * 大小、边距、上下行错开、一行放几个字全都跟着变。它一旦只作用于导出，
   * 用户就只能靠导出成片来确认版面，而那正是这个工具要消灭的东西（§5.12）。
   *
   * 放在 store 而不是工程 JSON：它是"这次想输出成什么画幅"，不是歌词数据的一部分，
   * 也不该占撤销格。已经是 16:9 的工程上它是空操作（后端 `plan_canvas` 判定）。
   */
  padTo169: boolean
  /**
   * 时间轴波形**画**哪条轨。与 `audioMode`（耳朵听哪条轨）刻意分开：
   * 对着人声的波形能一眼看出每个字的起音在哪，而耳朵里放伴奏才不被原唱带着走，
   * 绑在一起就只能二选一。`audio` = 原曲混音。
   */
  waveSource: 'audio' | 'instrumental' | 'vocals'
  /**
   * 播放时是否跟着播放头走。
   *
   * 放在 store 而不是各面板自己一份：波形和歌词正文都要"跟随"，各存一份的话
   * 界面上就会出现两个都叫「跟随」的开关，而用户想说的是同一件事。
   * 一个开关同时管住波形滚动与歌词正文滚动，两处永远同进同退。
   */
  followPlayhead: boolean

  canUndo: boolean
  canRedo: boolean

  load: (id: string) => Promise<void>
  create: (title?: string, artist?: string) => Promise<string>
  refresh: () => Promise<void>
  /**
   * 重新核对导出产物清单。
   *
   * 打开工程时拉一次（步骤条据此把「导出」标成已完成，刷新页面也不会退回未完成），
   * 每次导出跑完再拉一次——后端在把任务标 `done` **之前**就登记好了产物，
   * 所以轮询到 done 时这一拉必定拿得到。
   */
  loadExports: () => Promise<void>

  setPlayhead: (ms: number) => void
  setPlaying: (v: boolean) => void
  setPlaybackRate: (v: number) => void
  select: (s: Selection) => void
  setAudioMode: (m: 'original' | 'instrumental') => void
  setGuideEnabled: (v: boolean) => void
  setPadTo169: (v: boolean) => void
  setWaveSource: (m: 'audio' | 'instrumental' | 'vocals') => void
  setFollowPlayhead: (v: boolean) => void

  undo: () => Promise<void>
  redo: () => Promise<void>

  /** 三级调轴统一入口。scope=global 时忽略 target。 */
  shift: (scope: 'global' | 'line' | 'token', deltaMs: number) => Promise<void>
  setTiming: (lineId: string, tokenIndex: number, startMs?: number, durMs?: number) => Promise<void>
  /**
   * 批量改时间，整批作为一个 undo 单元——打完一首歌的打轴结果应走这个，
   * 而不是循环调用 setTiming（后者会占掉同样多的撤销步数）。
   */
  setTimings: (items: TimingItem[]) => Promise<void>
  /**
   * 设置/清除 locked_timing 或 ruby 的 locked。
   *
   * 收单条或一批：后端本来就是批量接口，一批算一格撤销。**锁定操作要走这里**
   * 而不是自己打后端——store 每次写入后会重新拉一次历史深度，
   * 绕过去会让撤销/重做按钮的可用状态滞后一拍。
   */
  setLock: (target: LockTarget | LockTarget[]) => Promise<void>
  setRuby: (lineId: string, start: number, end: number, text: string) => Promise<void>
  splitLine: (lineId: string, tokenIndex: number) => Promise<void>
  mergeLine: (lineId: string) => Promise<void>
  setVoicePart: (lineId: string, voicePart: string, range?: [number, number]) => Promise<void>
  updateStyle: (patch: Partial<Project['style']>) => Promise<void>
  /**
   * `replace=true` 时整份配色被替换，未出现的声部配色会被删掉。
   * 声部**改名**要用它：合并式更新删不掉旧键，而 `collectParts` 会把配色里
   * 剩下的旧名当成一个还存在的声部继续列出来，界面上就多出一个幽灵声部。
   */
  updatePalettes: (patch: Record<string, Palette>, replace?: boolean) => Promise<void>
  /** 把歌词候选写入当前工程 */
  applyLyrics: (provider: string, songId: string) => Promise<void>
  /** 手工导入歌词：纯文本 / LRC / 已解密的 QRC。一站式的手工旁路，随时可用（CLAUDE.md §2.5） */
  importLyrics: (kind: 'text' | 'lrc' | 'qrc', content: string, replace?: boolean) => Promise<void>
}

export const useProject = create<ProjectState>((set, get) => {
  /**
   * 把后端返回的工程装进 store。
   *
   * `exports` 一律沿用客户端已核对过的那份，**丢弃响应里带回来的持久化原值**：
   * 后端那个字段是存储，可能含文件已被用户删掉的记录，而界面上"有没有可用产物"
   * 只由 `loadExports()`（会核对文件是否还在）说了算。
   */
  const apply = (p: Project) =>
    set((s) => ({ project: { ...p, exports: s.project?.exports ?? [] }, error: null }))

  const withProject = async (fn: (id: string) => Promise<Project>) => {
    const p = get().project
    if (!p) return
    try {
      apply(await fn(p.id))
      const h = await api.history(p.id)
      set({ canUndo: h.undo > 0, canRedo: h.redo > 0 })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return {
    project: null,
    loading: false,
    error: null,
    playheadMs: 0,
    playing: false,
    playbackRate: 1,
    selection: { kind: 'none' },
    audioMode: 'original',
    guideEnabled: false,
    padTo169: false,
    waveSource: 'audio',
    followPlayhead: true,
    canUndo: false,
    canRedo: false,

    load: async (id) => {
      set({ loading: true })
      try {
        const p = await api.getProject(id)
        // 换工程时先把产物清单清空再由 loadExports 填回来：留着上一个工程的清单，
        // 步骤条会在新工程上错误地显示「导出」已完成
        set({ project: { ...p, exports: [] }, error: null })
        const h = await api.history(id)
        set({ canUndo: h.undo > 0, canRedo: h.redo > 0 })
        await get().loadExports()
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) })
      } finally {
        set({ loading: false })
      }
    },

    create: async (title, artist) => {
      const p = await api.createProject(title, artist)
      // 新工程必然没有产物；不显式清空会沿用上一个工程的清单（见 apply 的说明）
      set({ project: { ...p, exports: [] }, error: null })
      return p.id
    },

    refresh: async () => {
      const p = get().project
      if (p) apply(await api.getProject(p.id))
    },

    loadExports: async () => {
      const p = get().project
      if (!p) return
      try {
        const list = await api.listExports(p.id)
        // 只更新当前仍打开着的那个工程：这是个异步请求，返回时用户可能已经切走了
        set((s) => (s.project?.id === p.id ? { project: { ...s.project, exports: list } } : {}))
      } catch {
        // 产物清单取不到不该影响编辑：保持现有清单，让用户继续干活
      }
    },

    setPlayhead: (ms) => set({ playheadMs: ms }),
    setPlaying: (v) => set({ playing: v }),
    setPlaybackRate: (v) => set({ playbackRate: v }),
    select: (s) => set({ selection: s }),
    setAudioMode: (m) => set({ audioMode: m }),
    setGuideEnabled: (v) => set({ guideEnabled: v }),
    setPadTo169: (v) => set({ padTo169: v }),
    setWaveSource: (m) => set({ waveSource: m }),
    setFollowPlayhead: (v) => set({ followPlayhead: v }),

    undo: () => withProject(api.undo),
    redo: () => withProject(api.redo),

    shift: async (scope, deltaMs) => {
      const sel = get().selection
      await withProject((id) =>
        api.shift({
          project_id: id,
          scope,
          delta_ms: deltaMs,
          line_id: sel.kind !== 'none' ? sel.lineId : null,
          token_index: sel.kind === 'token' ? sel.tokenIndex : null,
        }),
      )
    },

    setTiming: async (lineId, tokenIndex, startMs, durMs) =>
      withProject((id) =>
        api.setTiming({
          project_id: id,
          line_id: lineId,
          token_index: tokenIndex,
          start_ms: startMs ?? null,
          dur_ms: durMs ?? null,
        }),
      ),

    setTimings: async (items) => withProject((id) => api.setTimings(id, items)),

    setLock: async (target) =>
      withProject((id) => api.setLock(id, Array.isArray(target) ? target : [target])),

    setRuby: async (lineId, start, end, text) =>
      withProject((id) => api.setRuby({ project_id: id, line_id: lineId, start, end, text })),

    splitLine: async (lineId, tokenIndex) =>
      withProject((id) => api.splitLine({ project_id: id, line_id: lineId, token_index: tokenIndex })),

    mergeLine: async (lineId) => withProject((id) => api.mergeLine({ project_id: id, line_id: lineId })),

    setVoicePart: async (lineId, voicePart, range) =>
      withProject((id) =>
        api.setVoicePart({
          project_id: id,
          line_id: lineId,
          voice_part: voicePart,
          token_range: range ?? null,
        }),
      ),

    updateStyle: async (patch) => withProject((id) => api.updateStyle(id, patch)),

    updatePalettes: async (patch, replace) =>
      withProject((id) => api.updatePalettes(id, patch, replace)),

    applyLyrics: async (provider, songId) =>
      withProject((id) => api.applyLyrics(id, provider, songId)),

    importLyrics: async (kind, content, replace) =>
      withProject((id) => api.importLyrics(id, kind, content, replace)),
  }
})

/**
 * 播放头当前唱到哪一行。**"跟随播放高亮"的唯一定义**——歌词正文与时间轴行轨
 * 都调它，两处才不会各说各的。
 *
 * 三条不显然的规定：
 *
 * 1. **入参是音频时间**（`playheadMs` 的基准），内部换算成工程时间；
 *    调用方不必各自记得减 `global_offset_ms`。
 * 2. **句内空隙期间不熄灭**。换气与词间停顿是真实存在的（CLAUDE.md §4.2
 *    「句内空隙必须保住」，实测一首歌有 53 处正空隙、最大 280ms），
 *    严格按「落在某行的首尾之间」判定会让整屏歌词一亮一灭。
 *    落在空隙里时沿用**最近一个已经开唱的行**，到下一行开唱那一刻才交接。
 * 3. **不假设行之间时间互斥**。§8.5 明确允许 `Line` 时间重叠（为"同一时刻两个
 *    声部各走各的轴"预留），所以这里扫全部行取「起点最晚且已开唱」的那个，
 *    而不是命中第一个就返回。第一版仍只高亮一行，但换成多声部时改的是这一个
 *    函数，不是散落各处的判断。
 *
 * 复杂度 O(行数)，逐帧调用也远不到一帧预算（60 行 × 60fps ≈ 3.6k 次比较/秒）。
 */
/**
 * 判定"这一句已经开始"的容差。
 *
 * 点一句歌词会把播放头送到它的**首字起点**，但真正落到哪儿由播放层说了算：
 * `<video>` 会吸附到帧边界，23.976fps 一帧就是 41.7ms，于是实测常常落在目标
 * **之前**几十毫秒。没有容差的话，点第 25 句、高亮却停在第 24 句 ——
 * 而「选中」与「正在唱」现在是同一件事，这一下就是肉眼可见的错。
 *
 * 60ms 比一帧多一点，且远小于验收脚本判定用的 ±150ms 边界保护区。
 * 对正常播放的影响是高亮提早 60ms 出现，听感上察觉不到。
 */
const LINE_START_TOLERANCE_MS = 60

export function locateLineId(project: Project | null, audioMs: number): string | null {
  if (!project) return null
  const t = audioMs - project.global_offset_ms + LINE_START_TOLERANCE_MS
  let bestId: string | null = null
  let bestStart = -Infinity
  for (const line of project.lines) {
    // 制作名单行不参与：它在正文里默认就不显示，高亮一个看不见的行等于没有高亮
    if (!line.tokens.length || line.is_metadata) continue
    const s = line.tokens[0].start_ms
    if (s > t) continue
    // 取等也覆盖：同起点的重叠行按工程顺序取后者，与行轨的排布顺序一致
    if (s >= bestStart) {
      bestStart = s
      bestId = line.id
    }
  }
  return bestId
}
