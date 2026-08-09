/**
 * 「样式」舞台：**左边一块大预览，右边一栏控件**。
 *
 * 这一步存在的全部理由是"改了能立刻看到"（docs/ui-redesign.md §四），
 * 所以预览必须大、必须是真实歌词、必须能播——窄栏里的小色块确认不了任何东西。
 * 预览用真实 JASSUB 渲染而不是 CSS 近似，见 `StyleFilmPreview.tsx` 的文件头。
 *
 * ## 提交策略
 *
 * 排版改动走 store 的 `updateStyle`（POST /api/projects/{id}/style），配色改动走
 * `updatePalettes`（POST /api/projects/{id}/palettes）。两者都**不对每次滑动发请求**：
 * 拖动条与取色器 debounce 后提交，数字/文本框失焦提交。每次提交是一格撤销。
 *
 * 配色此前只停在组件内部草稿态、刷新即丢（docs/ui-redesign.md §六点五点名的问题），
 * 而 store 里 `updatePalettes` 一直都在——这次接上的就是它。
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
import { useProject } from '../state/projectStore'
import PalettePicker, { effectivePalette, type PaletteColors } from './PalettePicker'
import { CountdownControls, LayoutControls, TimingControls } from './StyleControls'
import StyleFilmPreview from './StyleFilmPreview'
import StyleFontPicker from './StyleFontPicker'
import { STYLE_STAGE_CSS } from './StyleStageCss'

/** 拖动停下多久算"改完了"。太短会把一次拖拽切成好几格撤销 */
const COMMIT_DEBOUNCE_MS = 400

/** 声部名一律来自歌词数据与已有配色：凭空造一个没有行引用的声部没有意义 */
function collectParts(
  lines: { voice_part: string; tokens: { voice_part: string | null }[] }[],
  palettes: Record<string, Palette>,
): string[] {
  const set = new Set<string>(['main'])
  for (const line of lines) {
    if (line.voice_part) set.add(line.voice_part)
    for (const tk of line.tokens) if (tk.voice_part) set.add(tk.voice_part)
  }
  for (const name of Object.keys(palettes)) set.add(name)
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
  const paletteTimerRef = useRef<number | null>(null)
  const [activePart, setActivePart] = useState('main')

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
   * 推荐默认值：字号取画面高度 7.5%、描边取字号 5.5%、阴影取字号 2.2%
   * （CLAUDE.md §8.5）。这些是**比例**不是固定像素——固定 3px 描边在 4K 下细到看不见。
   */
  const applyRecommended = () => {
    if (!project || project.video_height <= 0) return
    const fontSize = Math.max(36, Math.round(project.video_height * 0.075))
    const patch: Partial<Style> = {
      font_size: fontSize,
      outline: Math.round(fontSize * 0.055 * 10) / 10,
      shadow: Math.round(fontSize * 0.022 * 10) / 10,
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

  const flushPalettes = useCallback(() => {
    if (paletteTimerRef.current !== null) {
      window.clearTimeout(paletteTimerRef.current)
      paletteTimerRef.current = null
    }
    const patch = palettePendingRef.current
    if (Object.keys(patch).length === 0) return
    palettePendingRef.current = {}
    void updatePalettes(patch)
  }, [updatePalettes])

  const changeColors = (part: string, patch: Partial<PaletteColors>) => {
    // 该声部还没有自己的配色时，从它当前生效的那套（main 或内置默认）拓下来再改，
    // 免得只改一个字段、其余三个变成空值
    const next: Palette = { name: part, ...effectivePalette(palettes, part).colors, ...patch }
    setPalettes((p) => ({ ...p, [part]: next }))
    palettePendingRef.current = { ...palettePendingRef.current, [part]: next }
    if (paletteTimerRef.current !== null) window.clearTimeout(paletteTimerRef.current)
    paletteTimerRef.current = window.setTimeout(flushPalettes, COMMIT_DEBOUNCE_MS)
  }

  const applyTemplate = (tpl: Record<string, Palette>) => {
    setPalettes((p) => ({ ...p, ...tpl }))
    palettePendingRef.current = { ...palettePendingRef.current, ...tpl }
    flushPalettes()
  }

  const parts = useMemo(
    () => collectParts(project?.lines ?? [], palettes),
    [project?.lines, palettes],
  )

  /**
   * 字形预检要查的字符集。**必须 memo**：它是 `useFontCoverage` 的依赖，
   * 每次渲染都新算一条串的话，引用虽变但内容相同——内容相同就命中缓存不会重发请求，
   * 但仍会白白跑一遍全曲遍历。歌词没变时这里一次都不重算。
   */
  const charset = useMemo(() => renderedCharset(project), [project])

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

  const controls = { draft, videoHeight: project.video_height, set, setNow, commit: flushStyle }

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
          <StyleFontPicker
            value={draft.font_name}
            charset={charset}
            onPick={(f) => setNow('font_name', f)}
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

        <section className="sty-sec">
          <div className="sty-sec__head">{t('style.section.palette')}</div>
          <PalettePicker
            palettes={palettes}
            parts={parts}
            activePart={activePart}
            onSelectPart={setActivePart}
            onChangeColors={changeColors}
            onApplyTemplate={applyTemplate}
          />
        </section>
      </aside>
    </div>
  )
}
