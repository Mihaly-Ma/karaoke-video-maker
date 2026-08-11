/**
 * 「样式」舞台：**左边一块大预览，右边一栏控件**。
 *
 * 这一步存在的全部理由是"改了能立刻看到"（docs/ui-redesign.md §四），
 * 所以预览必须大、必须是真实歌词、必须能播——窄栏里的小色块确认不了任何东西。
 * 预览用真实 JASSUB 渲染而不是 CSS 近似，见 `StyleFilmPreview.tsx` 的文件头。
 *
 * ## 控件栏的排列顺序
 *
 * 字体 → 声部配色 → 排版 → 时间 → 引导点。**配色紧跟字体**：这两项是"这首歌
 * 长什么样"的主观选择，用户进这一步先定它们；排版/时间/引导点是数值微调，
 * 多数时候用一次「推荐值」就不再碰。配色原先排在最末，要滚到底才够得着。
 *
 * ## 提交策略
 *
 * 排版改动走 store 的 `updateStyle`（POST /api/projects/{id}/style），配色改动走
 * `updatePalettes`（POST /api/projects/{id}/palettes）。两者都**不对每次滑动发请求**：
 * 拖动条与取色器 debounce 后提交，数字/文本框失焦提交。每次提交是一格撤销。
 *
 * ## 撤销栈的边界（想清楚了再改）
 *
 * - **这首歌的配色**（施加方案 / 改颜色）走 `updatePalettes`，**进撤销栈**：
 *   调色本来就要反复试，能退回才敢试。
 * - **方案库**（自动存出的自定义方案、改名、删除）是**跨工程的全局资源**，
 *   **不进撤销栈**。撤销栈是这份工程文档的历史，Cmd+Z 不该跨过去改用户攒的方案库
 *   ——就像文档编辑器里的撤销从不回滚另一份文档。
 *
 * 由此有一个必须说明白的后果：改完颜色再 Cmd+Z，**工程配色退回去，但派生出的那条
 * 自定义方案仍留在库里**（只是不再被标成"当前"）。这是有意的：那条方案可能已经被
 * 用户改过名，跟着撤销删掉等于毁掉一件他刚命名的资产。要删就点方案上的删除按钮。
 *
 * ## 草稿何时回灌
 *
 * 有待提交的改动时**不**用后端状态覆盖草稿，否则正拖着的滑块会被刚返回的旧值拽回去；
 * 没有待提交改动时一律跟随工程，这样别处发起的撤销/重做才能反映到控件上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Palette, Style } from '../api/types'
import { t } from '../i18n'
import { renderedCharset } from '../lib/fontCoverage'
import { layoutRefHeight } from '../lib/geometry'
import { useProject } from '../state/projectStore'
import PalettePicker, {
  effectivePalette,
  matchingScheme,
  sameColors,
  usePaletteSchemes,
  type PaletteColors,
} from './PalettePicker'
import { CountdownControls, LayoutControls, TimingControls } from './StyleControls'
import StyleFilmPreview from './StyleFilmPreview'
import StyleFontPicker from './StyleFontPicker'
import { STYLE_STAGE_CSS } from './StyleStageCss'

/** 拖动停下多久算"改完了"。太短会把一次拖拽切成好几格撤销 */
const COMMIT_DEBOUNCE_MS = 400

/**
 * 界面上要列出的声部。
 *
 * **只列真的有行在用的声部。**这里曾经无条件 `new Set(['main'])` 起头，本意是
 * "至少要有一个声部可选"，写成无条件之后，用户把默认声部 `main` 改名成「男」，
 * 列表里就常驻一个谁也没在用的 `main` 幽灵条目——点进去调半天颜色，成片上
 * 一个字都不会变。兜底只在**一个声部都收不到**（空工程 / 还没导入歌词）时才给。
 *
 * 也不再把工程配色里的键并进来：声部被删除时后端会把配色键一并摘除，
 * 但历史工程里可能残留孤儿键，并进来同样会变成幽灵条目。
 */
function collectParts(
  lines: { voice_part: string; tokens: { voice_part: string | null }[] }[],
): string[] {
  const set = new Set<string>()
  for (const line of lines) {
    if (line.voice_part) set.add(line.voice_part)
    // 一行内可以有多个声部（token 级覆盖），对唱曲里男女交替是常态
    for (const tk of line.tokens) if (tk.voice_part) set.add(tk.voice_part)
  }
  if (set.size === 0) set.add('main')
  return [...set].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
}

export default function StylePanel() {
  const project = useProject((s) => s.project)
  const updateStyle = useProject((s) => s.updateStyle)
  const updatePalettes = useProject((s) => s.updatePalettes)
  const storeError = useProject((s) => s.error)

  const [draft, setDraft] = useState<Style | null>(project?.style ?? null)
  const stylePendingRef = useRef<Partial<Style>>({})
  const styleTimerRef = useRef<number | null>(null)

  const [palettes, setPalettes] = useState<Record<string, Palette>>(project?.palettes ?? {})
  const palettePendingRef = useRef<Record<string, Palette>>({})
  /** 未提交的那笔颜色改动属于哪个声部——自动保存要拿它取"改之前/之后"的四色 */
  const pendingPartRef = useRef<string | null>(null)
  const paletteTimerRef = useRef<number | null>(null)
  const [activePart, setActivePart] = useState('main')

  const schemes = usePaletteSchemes()
  /** 本次会话里最后点过的方案名。**只用于给派生出的自定义条目起名**，不参与绑定 */
  const lastAppliedRef = useRef<string | null>(null)
  /** 方案库的写入串行化：并发保存会互相盖掉，且后一次读到的列表还是旧的 */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())

  const styleDirty = () =>
    styleTimerRef.current !== null || Object.keys(stylePendingRef.current).length > 0
  const paletteDirty = () =>
    paletteTimerRef.current !== null || Object.keys(palettePendingRef.current).length > 0

  // 没有待提交改动时跟随工程（撤销/重做才反映得出来），有则保留草稿
  useEffect(() => {
    if (!project) {
      setDraft(null)
      setPalettes({})
      return
    }
    if (!styleDirty()) setDraft(project.style)
    if (!paletteDirty()) setPalettes(project.palettes)
  }, [project])

  useEffect(
    () => () => {
      if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current)
      if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current)
    },
    [],
  )

  // ---- 排版 ----

  const flushStyle = useCallback(() => {
    if (styleTimerRef.current !== null) {
      window.clearTimeout(styleTimerRef.current)
      styleTimerRef.current = null
    }
    const patch = stylePendingRef.current
    if (Object.keys(patch).length === 0) return
    stylePendingRef.current = {}
    void updateStyle(patch)
  }, [updateStyle])

  const set = useCallback(
    <K extends keyof Style>(key: K, value: Style[K]) => {
      setDraft((d) => (d ? { ...d, [key]: value } : d))
      stylePendingRef.current = { ...stylePendingRef.current, [key]: value }
      if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current)
      styleTimerRef.current = window.setTimeout(flushStyle, COMMIT_DEBOUNCE_MS)
    },
    [flushStyle],
  )

  const setNow = useCallback(
    <K extends keyof Style>(key: K, value: Style[K]) => {
      setDraft((d) => (d ? { ...d, [key]: value } : d))
      stylePendingRef.current = { ...stylePendingRef.current, [key]: value }
      flushStyle()
    },
    [flushStyle],
  )

  /**
   * 推荐默认值：字号取**版面锚点高度**的 7.5%、描边取字号 5.5%、阴影取字号 2.2%
   * （CLAUDE.md §8.5）。这些是**比例**不是固定像素——固定 3px 描边在 4K 下细到看不见。
   *
   * 锚点不是画面高度而是 `layoutRefHeight`（内接 16:9 框的高度）：字号同时决定
   * 读起来多大与一行放几个字，前者看高度、后者看宽度，只有 16:9 上两者才是
   * 一回事。16:9 工程上两者相等，推荐值一个像素都不变。
   *
   * 边距仍各取自己那一维：左右按宽度、上下按高度，不掺锚点。
   */
  const applyRecommended = () => {
    if (!project || project.video_height <= 0) return
    const ref = layoutRefHeight(project.video_width, project.video_height)
    const fontSize = Math.max(36, Math.round(ref * 0.075))
    const patch: Partial<Style> = {
      font_size: fontSize,
      outline: Math.round(fontSize * 0.055 * 10) / 10,
      shadow: Math.round(fontSize * 0.022 * 10) / 10,
      margin_h: Math.round(project.video_width * 0.045),
      margin_v: Math.round(project.video_height * 0.055),
      line_gap: Math.round(fontSize * 0.18),
      stagger: true,
      max_lead_ms: 5000,
    }
    setDraft((d) => (d ? { ...d, ...patch } : d))
    stylePendingRef.current = { ...stylePendingRef.current, ...patch }
    flushStyle()
  }

  // ---- 配色 ----

  /**
   * 改完颜色自动存成方案。
   *
   * 语义（这一段决定了列表会不会被"自定义 1/2/3…"淹没）：
   *
   * - 改之前那组颜色若**正好等于某个用户方案** → 就地更新它（同名覆盖）。
   *   于是"从内置改出来的第一笔修改新建一条，之后所有微调都落回同一条"。
   * - 否则派生一条新的，名字取自改之前生效的那套方案（内置或用户）；
   *   连这个都认不出来（例如刚把方案施加到某个声部、颜色是混合状态）就退到
   *   本次会话最后点过的方案名，再退到「自定义配色」。撞名就加序号。
   *
   * 绑定靠**内容**而不是存指针：改名不改颜色，绑定自然跟着走，不用同步任何引用。
   */
  const autoSaveScheme = useCallback(
    async (part: string, before: PaletteColors) => {
      const after = effectivePalette(
        useProject.getState().project?.palettes ?? {},
        part,
      ).colors
      if (sameColors(before, after)) return

      const list = schemes.latest()
      const bound = list.find((s) => !s.builtin && sameColors(s.colors, before))
      if (bound) {
        await schemes.save(bound.name, after, bound.description)
        return
      }
      const from = matchingScheme(list, before)?.name ?? lastAppliedRef.current
      const base = from
        ? t('style.scheme.derivedName', { from })
        : t('style.scheme.defaultName')
      const taken = new Set(list.map((s) => s.name))
      let name = base
      for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`
      await schemes.save(
        name,
        after,
        from ? t('style.scheme.derivedDesc', { from }) : t('style.scheme.customDesc'),
      )
    },
    [schemes],
  )

  const flushPalettes = useCallback(() => {
    if (paletteTimerRef.current !== null) {
      window.clearTimeout(paletteTimerRef.current)
      paletteTimerRef.current = null
    }
    const patch = palettePendingRef.current
    const part = pendingPartRef.current
    if (Object.keys(patch).length === 0) return
    palettePendingRef.current = {}
    pendingPartRef.current = null

    // 改之前的四色要在提交**之前**取：提交完成后 store 里已经是新值了
    const before = part
      ? effectivePalette(useProject.getState().project?.palettes ?? {}, part).colors
      : null

    void updatePalettes(patch).then(() => {
      if (!part || !before) return
      saveChainRef.current = saveChainRef.current
        .catch(() => {})
        .then(() => autoSaveScheme(part, before))
    })
  }, [updatePalettes, autoSaveScheme])

  const changeColors = (part: string, patch: Partial<PaletteColors>) => {
    // 中途换了声部：先把上一个声部那笔提交掉，否则两笔会混进同一个 patch
    if (pendingPartRef.current && pendingPartRef.current !== part) flushPalettes()
    // 该声部还没有自己的配色时，从它当前生效的那套（main 或内置默认）拓下来再改，
    // 免得只改一个字段、其余三个变成空值
    const next: Palette = { name: part, ...effectivePalette(palettes, part).colors, ...patch }
    setPalettes((p) => ({ ...p, [part]: next }))
    palettePendingRef.current = { ...palettePendingRef.current, [part]: next }
    pendingPartRef.current = part
    if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current)
    paletteTimerRef.current = window.setTimeout(flushPalettes, COMMIT_DEBOUNCE_MS)
  }

  /**
   * 把一套方案施加到当前声部。**只写这一个声部**，别的声部原样不动。
   *
   * 不触发自动保存：此刻的颜色恰好等于某套已存在的方案，没有"改出来的新配色"可存。
   * 同一个声部尚未提交的微调会被这次施加整体覆盖，直接丢弃即可；换了声部的那笔
   * 先提交掉，免得丢掉用户在别处的改动。
   */
  const applyScheme = (schemeName: string) => {
    const scheme = schemes.list.find((s) => s.name === schemeName)
    if (!scheme) return
    if (pendingPartRef.current === activePart) {
      if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current)
      paletteTimerRef.current = null
      palettePendingRef.current = {}
      pendingPartRef.current = null
    } else if (pendingPartRef.current) {
      flushPalettes()
    }
    lastAppliedRef.current = schemeName

    // 方案里的 `name` 是 PaletteDTO 的字段、在方案层面没有意义；写进工程时
    // 这一格要换成声部名，所以逐字段取而不是整个铺开
    const next: Palette = {
      name: activePart,
      unsung_fill: scheme.colors.unsung_fill,
      unsung_outline: scheme.colors.unsung_outline,
      sung_fill: scheme.colors.sung_fill,
      sung_outline: scheme.colors.sung_outline,
    }
    setPalettes((p) => ({ ...p, [activePart]: next }))
    void updatePalettes({ [activePart]: next })
  }

  const parts = useMemo(() => collectParts(project?.lines ?? []), [project?.lines])

  /**
   * 字形预检要查的字符集。**必须 memo**：它是 `useFontCoverage` 的依赖，
   * 每次渲染都新算一条串的话，引用虽变但内容相同——内容相同就命中缓存不会重发请求，
   * 但仍会白白跑一遍全曲遍历。歌词没变时这里一次都不重算。
   */
  const charset = useMemo(() => renderedCharset(project), [project])

  // 声部可能在编辑舞台被删掉（删 = 归并，配色键一并摘除），此时选中项要退回去
  useEffect(() => {
    if (!parts.includes(activePart)) setActivePart(parts[0] ?? 'main')
  }, [parts, activePart])

  // ---- 渲染 ----

  if (!project || !draft) {
    return (
      <div className="sty-stage">
        <style>{STYLE_STAGE_CSS}</style>
        <div className="sty-empty">{t('common.selectProjectFirst')}</div>
      </div>
    )
  }

  // 字号相关的滑块范围与警告线都以**版面锚点高度**为准，与推荐值同一把尺子；
  // 传画面高度的话，非 16:9 工程上"推荐值"会落在"字号偏小"的警告区里自相矛盾。
  const controls = {
    draft,
    refHeight: layoutRefHeight(project.video_width, project.video_height),
    set,
    setNow,
    commit: flushStyle,
  }

  return (
    <div className="sty-stage">
      <style>{STYLE_STAGE_CSS}</style>

      <StyleFilmPreview project={project} />

      <aside className="sty-side" data-testid="style-side">
        {storeError && (
          <div className="sty-sec">
            <div className="sty-err">{t('style.saveFailed', { detail: storeError })}</div>
          </div>
        )}

        <section className="sty-sec">
          <div className="sty-sec__head">{t('style.section.font')}</div>
          {/*
            改字体一律走 `font_names`（整条链），不发 `font_name`——后者是后端的
            派生量，只在兼容老前端时才用得上，从这里发只会让"改链尾"表达不出来。
          */}
          <StyleFontPicker
            value={draft.font_names}
            charset={charset}
            bold={draft.bold}
            onChange={(chain) => setNow('font_names', chain)}
          />
        </section>

        <section className="sty-sec" data-testid="style-palette-section">
          <div className="sty-sec__head">{t('style.section.palette')}</div>
          <PalettePicker
            palettes={palettes}
            parts={parts}
            activePart={activePart}
            onSelectPart={setActivePart}
            onChangeColors={changeColors}
            onApplyScheme={applyScheme}
            schemes={schemes}
          />
        </section>

        <section className="sty-sec">
          <div className="sty-sec__head">
            {t('style.section.layout')}
            <span className="sty-sec__spacer" />
            <button
              type="button"
              className="small ghost"
              disabled={project.video_height <= 0}
              title={project.video_height > 0 ? undefined : t('style.recommendNoVideo')}
              onClick={applyRecommended}
            >
              {t('style.recommend')}
            </button>
          </div>
          <LayoutControls {...controls} />
        </section>

        <section className="sty-sec">
          <div className="sty-sec__head">{t('style.section.timing')}</div>
          <TimingControls {...controls} />
        </section>

        <section className="sty-sec">
          <div className="sty-sec__head">{t('style.section.countdown')}</div>
          <CountdownControls {...controls} />
        </section>
      </aside>
    </div>
  )
}
