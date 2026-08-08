import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import type { FontInfo, FontPreset, FontScanStatus, Palette, Style } from '../api/types'
import { useProject } from '../state/projectStore'
import PalettePicker, { PALETTE_PRESETS } from './PalettePicker'

/**
 * 样式面板：排版（`Style`）+ 声部配色（`Palette`）。
 *
 * 两者刻意分离（见 CLAUDE.md §8.5「声部」）——换声部只换配色，不动排版，
 * 所以这个面板下半部分直接复用 `PalettePicker` 而不是把颜色字段揉进同一套表单。
 *
 * 排版改动走 store 的 `updateStyle`（POST /api/projects/{id}/style），
 * 会刷新 store 里的工程，预览组件自行重渲染。**不对每次滑动都发请求**——
 * 拖动条用 debounce（松手或停顿 500ms 后再提交），数字/文本输入在失焦时提交。
 *
 * 声部配色目前没有对应的持久化接口：后端 `StylePatchDTO`
 * （backend/kvm/api/routes/projects.py）只覆盖 `Style` 的字段，不含
 * `palettes`，前端 `Partial<Style>` 类型也不包含它。所以配色编辑先维持在
 * 组件内部的草稿状态（可套预设、可微调、有独立取样预览），暂时不会写回
 * 工程文件，刷新页面会丢失。等后端补上类似 `POST /api/projects/{id}/palettes`
 * 的接口后，上层可以传入 `onPalettesChange` 接管持久化，这个文件不需要改。
 *
 * 样式内联在组件里（跟 `RubyEditor.tsx` / `LyricPanel.tsx` 一致的做法），
 * 类名以 `kvm-style-` 开头，避免和其他并行 agent 的全局类名冲突。
 */

export interface StylePanelProps {
  /** 声部配色持久化钩子（可选），见文件头说明。不传时配色编辑只影响本组件的草稿状态。 */
  onPalettesChange?: (palettes: Record<string, Palette>) => void
}

const COMMIT_DEBOUNCE_MS = 500

function parseNumber(raw: string): number | null {
  const v = Number(raw)
  return Number.isNaN(v) ? null : v
}

interface SliderFieldProps {
  label: string
  hint?: string
  warning?: string | null
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
  onCommit: () => void
}

function SliderField({ label, hint, warning, value, min, max, step = 1, unit = '', onChange, onCommit }: SliderFieldProps) {
  const handle = (raw: string) => {
    const v = parseNumber(raw)
    if (v !== null) onChange(v)
  }
  return (
    <div className="kvm-style-field">
      <div className="kvm-style-field-label-col">
        <div className="kvm-style-field-label">{label}</div>
        {hint && <div className="kvm-style-field-hint">{hint}</div>}
        {warning && <div className="kvm-style-field-warn">注意：{warning}</div>}
      </div>
      <input
        type="range"
        className="kvm-style-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => handle(e.target.value)}
        onMouseUp={onCommit}
        onTouchEnd={onCommit}
        onKeyUp={onCommit}
      />
      <input
        type="number"
        className="kvm-style-num"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => handle(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {unit && <span className="kvm-style-unit">{unit}</span>}
    </div>
  )
}

function CheckboxField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="kvm-style-checkbox-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <div className="kvm-style-field-label">{label}</div>
        {hint && <div className="kvm-style-field-hint">{hint}</div>}
      </span>
    </label>
  )
}

/** 字体扫描状态轮询间隔。太密没意义（后端扫描是秒级推进的），太疏用户等得难受。 */
const FONT_POLL_INTERVAL_MS = 1500

/**
 * 字体选择：四档卡拉OK 常用预置 + 完整系统字体列表，替换掉原来的自由输入框。
 *
 * 字体一律经后端从本机系统扫描取得（CLAUDE.md §2.6），冷启动扫描约需 30~40 秒，
 * 期间 `GET /api/fonts/status` 处于 `scanning`——本组件据此轮询，转为 `ready` 后
 * 重新拉取字体列表与预置，而不是让用户永远停留在扫描到一半的不完整列表上。
 *
 * 某档 `resolved=null` 且非 `pending` 时按钮禁用并说明原因，**绝不允许悄悄换成
 * 别的字体**——用户选了明朝体却渲染出黑体，比"该档不可用"更糟
 * （backend/kvm/api/routes/fonts.py 的 `PresetInfo` 文档）。
 */
function FontField({
  value,
  onChange,
  onCommit,
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
}) {
  const [status, setStatus] = useState<FontScanStatus | null>(null)
  const [presets, setPresets] = useState<FontPreset[]>([])
  const [fonts, setFonts] = useState<FontInfo[]>([])
  const [cjkOnly, setCjkOnly] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const pollTimerRef = useRef<number | null>(null)
  const lastStateRef = useRef<FontScanStatus['state'] | null>(null)

  const loadFontList = useCallback(async (onlyCjk: boolean) => {
    try {
      setFonts(await api.listFonts(onlyCjk))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadPresets = useCallback(async () => {
    try {
      setPresets(await api.listFontPresets())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // cjkOnly 切换（或首次挂载）时重新拉字体列表
  useEffect(() => {
    void loadFontList(cjkOnly)
  }, [cjkOnly, loadFontList])

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  // 轮询扫描状态；scanning → ready 时重新拉一次完整列表与预置——
  // 冷启动期间只拉一次会永久停留在不完整的结果上（任务背景问题 2）
  useEffect(() => {
    let cancelled = false

    const poll = async (): Promise<void> => {
      try {
        const s = await api.getFontStatus()
        if (cancelled) return
        setStatus(s)
        setLoadError(null)
        const prevState = lastStateRef.current
        lastStateRef.current = s.state
        if (prevState === 'scanning' && s.state === 'ready') {
          void loadFontList(cjkOnly)
          void loadPresets()
        }
        if (s.state === 'scanning') {
          pollTimerRef.current = window.setTimeout(() => void poll(), FONT_POLL_INTERVAL_MS)
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    }
  }, [cjkOnly, loadFontList, loadPresets])

  const pick = (family: string) => {
    onChange(family)
    onCommit()
  }

  return (
    <div className="kvm-font-field">
      <div className="kvm-style-field-label">字体</div>
      <div className="kvm-style-field-hint">
        先在下面四档卡拉OK 常用字体里选一档；也可以在系统字体列表里直接选具体字体。
        字体经后端从本机系统扫描并子集化后供预览与导出共用，首次冷启动扫描约需 30~40 秒。
      </div>

      {status && (status.state === 'scanning' || status.state === 'failed') && (
        <div
          className={
            'kvm-font-status' +
            (status.state === 'failed' ? ' kvm-font-status-error' : ' kvm-font-status-scanning')
          }
        >
          {status.message}
        </div>
      )}
      {loadError && <div className="kvm-font-status kvm-font-status-error">获取字体信息失败：{loadError}</div>}

      <div className="kvm-font-presets">
        {presets.length === 0 && <div className="kvm-font-status">正在加载预置字体…</div>}
        {presets.map((p) => {
          const selected = p.resolved !== null && p.resolved === value
          const unavailable = p.resolved === null && !p.pending
          return (
            <button
              key={p.key}
              type="button"
              disabled={p.resolved === null}
              className={
                'kvm-font-preset' +
                (selected ? ' kvm-font-preset-selected' : '') +
                (unavailable ? ' kvm-font-preset-unavailable' : '') +
                (p.pending ? ' kvm-font-preset-pending' : '')
              }
              title={unavailable ? `本机未安装以下任一候选字体：${p.candidates.join('、')}` : undefined}
              onClick={() => {
                if (p.resolved) pick(p.resolved)
              }}
            >
              <div className="kvm-font-preset-label">{p.label}</div>
              <div className="kvm-font-preset-note">{p.note}</div>
              <div className="kvm-font-preset-resolved">
                {p.pending
                  ? '系统字体扫描中，稍后可能可用…'
                  : p.resolved
                    ? `实际字体：${p.resolved}`
                    : '本机不可用'}
              </div>
            </button>
          )
        })}
      </div>

      <div className="kvm-font-list-header">
        <span>系统字体列表{cjkOnly ? '（仅显示覆盖日文的）' : '（全部）'}</span>
        <label className="kvm-font-toggle">
          <input type="checkbox" checked={!cjkOnly} onChange={(e) => setCjkOnly(!e.target.checked)} />
          显示全部字体
        </label>
      </div>
      <div className="kvm-font-list">
        {fonts.map((f) => (
          <button
            key={f.family}
            type="button"
            className={'kvm-font-item' + (f.family === value ? ' kvm-font-item-selected' : '')}
            onClick={() => pick(f.family)}
          >
            <span>{f.family}</span>
            {!f.is_cjk && <span className="kvm-font-item-warn">不含日文字形</span>}
          </button>
        ))}
        {fonts.length === 0 && (
          <div className="kvm-font-status">
            {status?.state === 'scanning' ? status.message : '没有匹配的系统字体'}
          </div>
        )}
      </div>

      {value && !fonts.some((f) => f.family === value) && !presets.some((p) => p.resolved === value) && (
        <div className="kvm-font-current">
          当前字体：{value}（未出现在上方列表中，可能是历史数据或扫描尚未覆盖到）
        </div>
      )}
    </div>
  )
}

export default function StylePanel({ onPalettesChange }: StylePanelProps) {
  const project = useProject((s) => s.project)
  const updateStyle = useProject((s) => s.updateStyle)
  const storeError = useProject((s) => s.error)

  const [draft, setDraft] = useState<Style | null>(project?.style ?? null)
  const pendingPatchRef = useRef<Partial<Style>>({})
  const timerRef = useRef<number | null>(null)

  const [palettes, setPalettes] = useState<Record<string, Palette>>(project?.palettes ?? {})
  const [activePart, setActivePart] = useState<string>(() => Object.keys(project?.palettes ?? {})[0] ?? 'main')

  // 只在切换工程时从后端状态重新同步草稿。面板打开期间，别处的编辑操作
  // （比如调轴）也会触发工程整体刷新——如果这里对 project.style 的任何变化
  // 都重新同步，会把用户正在拖但还没提交的滑块冲掉。
  useEffect(() => {
    setDraft(project?.style ?? null)
    pendingPatchRef.current = {}
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const initialPalettes = project?.palettes ?? {}
    setPalettes(initialPalettes)
    setActivePart(Object.keys(initialPalettes)[0] ?? 'main')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const flush = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const patch = pendingPatchRef.current
    if (Object.keys(patch).length === 0) return
    pendingPatchRef.current = {}
    void updateStyle(patch)
  }

  const scheduleCommit = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flush, COMMIT_DEBOUNCE_MS)
  }

  const set = <K extends keyof Style>(key: K, value: Style[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    pendingPatchRef.current = { ...pendingPatchRef.current, [key]: value }
    scheduleCommit()
  }

  const setNow = <K extends keyof Style>(key: K, value: Style[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    pendingPatchRef.current = { ...pendingPatchRef.current, [key]: value }
    flush()
  }

  const applyRecommendedDefaults = () => {
    if (!project) return
    const fontSize = Math.max(36, Math.round(project.video_height * 0.075))
    const outline = Math.round(fontSize * 0.055 * 10) / 10
    const shadow = Math.round(fontSize * 0.022 * 10) / 10
    const marginV = Math.round(project.video_height * 0.055)
    const lineGap = Math.round(fontSize * 0.18)
    const patch: Partial<Style> = {
      font_size: fontSize,
      outline,
      shadow,
      margin_v: marginV,
      line_gap: lineGap,
      stagger: true,
      max_lead_ms: 5000,
    }
    setDraft((d) => (d ? { ...d, ...patch } : d))
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch }
    flush()
  }

  // ---- 声部配色（草稿态，见文件头说明） ----

  const handleChangeColors = (name: string, patch: Partial<Omit<Palette, 'name'>>) => {
    const current = palettes[name]
    if (!current) return
    const next = { ...palettes, [name]: { ...current, ...patch } }
    setPalettes(next)
    onPalettesChange?.(next)
  }

  const handleCreatePart = (name: string) => {
    const base = palettes[activePart] ?? palettes.main ?? Object.values(palettes)[0]
    const colors: Omit<Palette, 'name'> = base
      ? {
          unsung_fill: base.unsung_fill,
          unsung_outline: base.unsung_outline,
          sung_fill: base.sung_fill,
          sung_outline: base.sung_outline,
        }
      : PALETTE_PRESETS[0].colors
    const next = { ...palettes, [name]: { name, ...colors } }
    setPalettes(next)
    onPalettesChange?.(next)
    setActivePart(name)
  }

  const handleRenamePart = (oldName: string, newName: string) => {
    const palette = palettes[oldName]
    if (!palette) return
    const rest = Object.fromEntries(Object.entries(palettes).filter(([key]) => key !== oldName))
    const next: Record<string, Palette> = { ...rest, [newName]: { ...palette, name: newName } }
    setPalettes(next)
    onPalettesChange?.(next)
    setActivePart(newName)
  }

  const handleDeletePart = (name: string) => {
    const names = Object.keys(palettes)
    if (names.length <= 1) return
    const next = Object.fromEntries(Object.entries(palettes).filter(([key]) => key !== name)) as Record<string, Palette>
    setPalettes(next)
    onPalettesChange?.(next)
    if (activePart === name) {
      const fallback = names.find((n) => n !== name)
      if (fallback) setActivePart(fallback)
    }
  }

  if (!project || !draft) {
    return (
      <div className="kvm-style-panel">
        <style>{CSS}</style>
        <p className="kvm-style-empty">请先打开一个工程。</p>
      </div>
    )
  }

  const videoHeight = project.video_height > 0 ? project.video_height : null
  const recommendedFontSize = videoHeight ? Math.max(36, Math.round(videoHeight * 0.075)) : null
  const fontSizeRatio = videoHeight ? draft.font_size / videoHeight : null
  const fontSizeWarning =
    fontSizeRatio !== null && fontSizeRatio < 0.06
      ? `当前字号只占画面高度的 ${(fontSizeRatio * 100).toFixed(1)}%，明显低于推荐的 7.5%，在实际观看距离下可能看不清`
      : null
  const outlineRatio = draft.font_size > 0 ? draft.outline / draft.font_size : null
  const outlineWarning =
    outlineRatio !== null && outlineRatio < 0.03
      ? `当前描边只占字号的 ${(outlineRatio * 100).toFixed(1)}%，明显低于推荐的 5.5%，高分辨率下会细到几乎看不见`
      : null
  const maxLeadWarning = draft.max_lead_ms > 8000 ? '提前显示时间偏长，可能会让一句歌词孤零零挂在屏幕上很久' : null
  const fontSizeMax = videoHeight ? Math.max(200, Math.round(videoHeight * 0.25)) : 300

  return (
    <div className="kvm-style-panel">
      <style>{CSS}</style>

      {storeError && <div className="kvm-style-error">保存失败：{storeError}</div>}

      <div className="kvm-style-section">
        <div className="kvm-style-section-title">快速操作</div>
        <button type="button" className="kvm-style-btn" onClick={applyRecommendedDefaults}>
          恢复推荐默认值
        </button>
        <div className="kvm-style-quick-hint">
          {videoHeight
            ? `按当前画面高度 ${videoHeight}px 换算：字号 ${recommendedFontSize}px（画面高度 7.5%）、描边为字号的 5.5%、阴影为字号的 2.2%。这些比例是实测得出的——固定像素值在 4K 下会细到几乎看不见。`
            : '工程还没有画面尺寸信息，无法按比例换算，先导入视频后再用这个按钮。'}
        </div>
      </div>

      <div className="kvm-style-section">
        <div className="kvm-style-section-title">字体与排版</div>
        <FontField value={draft.font_name} onChange={(v) => set('font_name', v)} onCommit={flush} />
        <SliderField
          label="字号"
          hint="默认取画面高度的 7.5%（4K → 162px）；调太小在实际观看距离下会看不清"
          warning={fontSizeWarning}
          value={draft.font_size}
          min={24}
          max={fontSizeMax}
          step={1}
          unit="px"
          onChange={(v) => set('font_size', v)}
          onCommit={flush}
        />
        <CheckboxField label="粗体" checked={draft.bold} onChange={(v) => setNow('bold', v)} />
        <SliderField
          label="描边宽度"
          hint="默认取字号的 5.5%；固定小值在 4K 下会细到几乎不可见"
          warning={outlineWarning}
          value={draft.outline}
          min={0}
          max={20}
          step={0.1}
          unit="px"
          onChange={(v) => set('outline', v)}
          onCommit={flush}
        />
        <SliderField
          label="阴影"
          hint="默认取字号的 2.2%"
          value={draft.shadow}
          min={0}
          max={10}
          step={0.1}
          unit="px"
          onChange={(v) => set('shadow', v)}
          onCommit={flush}
        />
        <SliderField
          label="注音缩放"
          hint="注音字号相对主文字号的比例"
          value={draft.ruby_scale}
          min={0.1}
          max={1}
          step={0.01}
          unit="×"
          onChange={(v) => set('ruby_scale', v)}
          onCommit={flush}
        />
        <SliderField
          label="注音间距"
          hint="注音基线与主文字顶部的间距"
          value={draft.ruby_gap}
          min={0}
          max={40}
          step={1}
          unit="px"
          onChange={(v) => set('ruby_gap', v)}
          onCommit={flush}
        />
        <SliderField
          label="底部边距"
          value={draft.margin_v}
          min={0}
          max={400}
          step={1}
          unit="px"
          onChange={(v) => set('margin_v', v)}
          onCommit={flush}
        />
        <SliderField
          label="左右边距"
          hint="上行贴左边距，下行贴右边距"
          value={draft.margin_h}
          min={0}
          max={400}
          step={1}
          unit="px"
          onChange={(v) => set('margin_h', v)}
          onCommit={flush}
        />
        <SliderField
          label="行间距"
          hint="同屏两行之间的间距"
          value={draft.line_gap}
          min={0}
          max={100}
          step={1}
          unit="px"
          onChange={(v) => set('line_gap', v)}
          onCommit={flush}
        />
        <CheckboxField
          label="上下行错开"
          hint="日式卡拉OK 的标志性布局：上行偏左、下行偏右，同屏也能一眼分清哪句在唱。关掉会变成普通字幕的居中观感"
          checked={draft.stagger}
          onChange={(v) => setNow('stagger', v)}
        />
      </div>

      <div className="kvm-style-section">
        <div className="kvm-style-section-title">时间行为</div>
        <SliderField
          label="提前入场"
          hint="行至少提前出现的时间，避免和开唱同时冒出来"
          value={draft.lead_in_ms}
          min={0}
          max={3000}
          step={50}
          unit="ms"
          onChange={(v) => set('lead_in_ms', v)}
          onCommit={flush}
        />
        <SliderField
          label="最大提前量"
          hint="下一句最多提前多久显示，默认 5s；只提前几百毫秒不符合真实卡拉OK 观感"
          warning={maxLeadWarning}
          value={draft.max_lead_ms}
          min={0}
          max={12000}
          step={100}
          unit="ms"
          onChange={(v) => set('max_lead_ms', v)}
          onCommit={flush}
        />
        <SliderField
          label="唱完停留"
          hint="行唱完后继续停留的时间"
          value={draft.lead_out_ms}
          min={0}
          max={3000}
          step={50}
          unit="ms"
          onChange={(v) => set('lead_out_ms', v)}
          onCommit={flush}
        />
        <SliderField
          label="间奏判定阈值"
          hint="超过这个空档就判定为间奏：间奏后重新从上行开始，并显示开唱引导点"
          value={draft.paragraph_gap_ms}
          min={500}
          max={10000}
          step={100}
          unit="ms"
          onChange={(v) => set('paragraph_gap_ms', v)}
          onCommit={flush}
        />
        <SliderField
          label="同槽位最小间隔"
          hint="上下槽位只有两个，隔一行复用同一位置；这里控制前一行消失与后一行出现之间必须留出的空档"
          value={draft.slot_gap_ms}
          min={0}
          max={2000}
          step={50}
          unit="ms"
          onChange={(v) => set('slot_gap_ms', v)}
          onCommit={flush}
        />
      </div>

      <div className="kvm-style-section">
        <div className="kvm-style-section-title">开唱引导点</div>
        <SliderField
          label="点数"
          hint="0 表示关闭。点从右往左依次熄灭，剩几个点就是还剩几拍，只在首句与间奏后出现"
          value={draft.countdown_dots}
          min={0}
          max={8}
          step={1}
          unit="个"
          onChange={(v) => set('countdown_dots', v)}
          onCommit={flush}
        />
        <SliderField
          label="点间隔"
          hint="相邻两个点熄灭之间的时间；理想情况下应踩在真实拍点上"
          value={draft.countdown_beat_ms}
          min={100}
          max={2000}
          step={10}
          unit="ms"
          onChange={(v) => set('countdown_beat_ms', v)}
          onCommit={flush}
        />
        <SliderField
          label="触发所需最小空档"
          hint="只有空档达到这个阈值才显示引导点，避免正常换行也满屏是点"
          value={draft.countdown_min_gap_ms}
          min={500}
          max={10000}
          step={100}
          unit="ms"
          onChange={(v) => set('countdown_min_gap_ms', v)}
          onCommit={flush}
        />
      </div>

      <div className="kvm-style-section">
        <div className="kvm-style-section-title">声部配色</div>
        <PalettePicker
          palettes={palettes}
          activePart={activePart}
          onSelectPart={setActivePart}
          onChangeColors={handleChangeColors}
          onCreatePart={handleCreatePart}
          onRenamePart={handleRenamePart}
          onDeletePart={handleDeletePart}
        />
      </div>
    </div>
  )
}

/**
 * 样式内联在组件里：本项目还没有统一的全局样式方案，多个 agent 并行开发时
 * 各写各的、类名各自加前缀（`kvm-style-`）就不会互相冲突。深色配色与
 * `RubyEditor.tsx` 的 `--kvm-panel-bg` / `--kvm-fg` / `--kvm-border` 变量名保持
 * 一致，便于外层日后统一换肤。
 */
const CSS = `
.kvm-style-panel {
  background: var(--kvm-panel-bg, #1b1d22);
  color: var(--kvm-fg, #e6e6e6);
  padding: 12px;
  font-size: 13px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.kvm-style-panel * { box-sizing: border-box; }
.kvm-style-empty { color: #8b909a; margin: 4px 0; }

.kvm-style-error {
  padding: 8px 10px;
  border-radius: 4px;
  background: #3a1c1c;
  color: #ef8080;
  font-size: 12px;
}

.kvm-style-section {
  border: 1px solid var(--kvm-border, #33363d);
  border-radius: 6px;
  padding: 10px 12px;
}
.kvm-style-section-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #9aa0aa;
  margin-bottom: 8px;
}

.kvm-style-quick-hint { margin-top: 8px; font-size: 11.5px; color: #9aa0aa; }

.kvm-style-btn {
  padding: 6px 12px;
  border: 1px solid #4a8fd0;
  border-radius: 4px;
  background: #24303d;
  color: #cfe0f5;
  font-size: 12px;
  cursor: pointer;
}
.kvm-style-btn:hover { border-color: #6fb0ea; }

.kvm-style-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.kvm-style-field:first-of-type { border-top: none; }
.kvm-style-field-label-col { flex: 0 0 148px; }
.kvm-style-field-label { font-size: 12.5px; font-weight: 600; color: #e6e6e6; }
.kvm-style-field-hint { font-size: 11px; color: #8b909a; margin-top: 1px; }
.kvm-style-field-warn { font-size: 11px; color: #e0a83e; margin-top: 2px; }

.kvm-style-range { flex: 1 1 auto; accent-color: #4a8fd0; }
.kvm-style-num {
  width: 68px;
  padding: 3px 5px;
  border: 1px solid #444852;
  border-radius: 3px;
  background: #14161a;
  color: inherit;
  font-size: 12px;
}
.kvm-style-num:focus { outline: none; border-color: #4a8fd0; }
.kvm-style-unit { flex: 0 0 20px; font-size: 11px; color: #8b909a; }

.kvm-style-select {
  padding: 5px 8px;
  border: 1px solid #444852;
  border-radius: 3px;
  background: #14161a;
  color: inherit;
  font-size: 12.5px;
}
.kvm-style-text {
  padding: 5px 8px;
  border: 1px solid #444852;
  border-radius: 3px;
  background: #14161a;
  color: inherit;
  font-size: 12.5px;
  flex: 1 1 auto;
  min-width: 0;
}
.kvm-style-select:focus, .kvm-style-text:focus { outline: none; border-color: #4a8fd0; }

.kvm-style-checkbox-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 6px 0;
  cursor: pointer;
}
.kvm-style-checkbox-row input { margin-top: 3px; accent-color: #4a8fd0; }

.kvm-font-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.kvm-font-status {
  padding: 6px 10px;
  border-radius: 4px;
  background: #24303d;
  color: #cfe0f5;
  font-size: 11.5px;
}
.kvm-font-status-scanning { background: #24303d; color: #cfe0f5; }
.kvm-font-status-error { background: #3a1c1c; color: #ef8080; }

.kvm-font-presets {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.kvm-font-preset {
  text-align: left;
  padding: 8px 10px;
  border: 1px solid #444852;
  border-radius: 5px;
  background: #14161a;
  color: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kvm-font-preset:hover:not(:disabled) { border-color: #4a8fd0; }
.kvm-font-preset:disabled { cursor: not-allowed; opacity: 0.55; }
.kvm-font-preset-selected { border-color: #4a8fd0; background: #1c2733; }
.kvm-font-preset-unavailable { border-style: dashed; }
.kvm-font-preset-pending { border-color: #e0a83e; }
.kvm-font-preset-label { font-size: 12.5px; font-weight: 700; }
.kvm-font-preset-note { font-size: 11px; color: #9aa0aa; }
.kvm-font-preset-resolved { font-size: 11px; color: #6fb0ea; }
.kvm-font-preset-unavailable .kvm-font-preset-resolved { color: #e0a83e; }

.kvm-font-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: #9aa0aa;
  margin-top: 4px;
}
.kvm-font-toggle { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.kvm-font-toggle input { accent-color: #4a8fd0; }

.kvm-font-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid #444852;
  border-radius: 5px;
  background: #14161a;
  display: flex;
  flex-direction: column;
}
.kvm-font-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.kvm-font-item:last-child { border-bottom: none; }
.kvm-font-item:hover { background: #1c1f26; }
.kvm-font-item-selected { background: #1c2733; color: #cfe0f5; font-weight: 700; }
.kvm-font-item-warn { font-size: 10.5px; color: #e0a83e; flex: 0 0 auto; }

.kvm-font-current { font-size: 11px; color: #9aa0aa; }
`
