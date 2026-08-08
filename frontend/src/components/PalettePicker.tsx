import { useEffect, useState, type CSSProperties } from 'react'
import type { Palette } from '../api/types'
import { assToCssHex, cssHexToAss, formatAssColor, parseAssColor } from '../lib/assColor'

/**
 * 声部配色编辑器。
 *
 * 一个声部（`Palette`）需要**四个颜色**而不是一个：未唱填充 / 未唱描边 /
 * 已唱填充 / 已唱描边。因为渲染层用"双层 + 渐进 clip"实现描边跟着填充一起
 * 翻色（日式卡拉OK 的招牌观感，见 CLAUDE.md §8.5「声部」），未唱层与已唱层
 * 各需一组填充/描边。配色与排版（`Style`）分离——这里只管颜色，不碰字号、
 * 边距这些排版字段（那些在 `StylePanel.tsx` 里）。
 *
 * 本组件是纯受控组件，不直接发请求：颜色改动通过 `onChangeColors` 交给
 * 调用方决定怎么持久化，声部的增删改同理。
 *
 * 样式内联在组件里（跟 `RubyEditor.tsx` / `LyricPanel.tsx` 一致的做法）：
 * 多个 agent 并行开发，不共用一份全局样式表就不会有类名冲突风险。
 * 全部类名以 `kvm-palette-` 开头。
 */

export type PaletteColors = Omit<Palette, 'name'>

export interface PalettePreset {
  id: string
  label: string
  description: string
  colors: PaletteColors
}

/**
 * 预设配色。至少提供三套：nicokara 经典白蓝、高对比黄黑、柔和粉白。
 * 套用只改颜色，字号/描边宽度等排版字段不受影响，套用后仍可继续微调。
 *
 * 具体色值用 `cssHexToAss` 从普通 RGB 生成，不手写 `&HAABBGGRR&`——
 * ASS 的 BGR 字节序反直觉，手算最容易出错。
 */
export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: 'nicokara-classic',
    label: 'NicoKara 经典白蓝',
    description: '未唱白字近黑描边，唱到的字翻成蓝字深蓝描边——本项目的默认配色',
    colors: {
      unsung_fill: cssHexToAss('#ffffff'),
      unsung_outline: cssHexToAss('#202020'),
      sung_fill: cssHexToAss('#1090ff'),
      sung_outline: cssHexToAss('#001850'),
    },
  },
  {
    id: 'high-contrast-yellow-black',
    label: '高对比黄黑',
    description: '未唱白字黑描边，唱到的字翻成纯黄字黑描边，最大化可读性',
    colors: {
      unsung_fill: cssHexToAss('#ffffff'),
      unsung_outline: cssHexToAss('#000000'),
      sung_fill: cssHexToAss('#ffe100'),
      sung_outline: cssHexToAss('#000000'),
    },
  },
  {
    id: 'soft-pink-white',
    label: '柔和粉白',
    description: '未唱柔白字浅灰描边，唱到的字翻成柔粉字藕色描边，观感更温和',
    colors: {
      unsung_fill: cssHexToAss('#fdfdfd'),
      unsung_outline: cssHexToAss('#8a8a8a'),
      sung_fill: cssHexToAss('#ff9fc2'),
      sung_outline: cssHexToAss('#7a3350'),
    },
  },
]

export interface PalettePickerProps {
  /** 全部声部配色，key 是声部名（如 main / bg / duet_a / duet_b）。 */
  palettes: Record<string, Palette>
  /** 当前正在编辑的声部名。 */
  activePart: string
  /** 切换正在编辑的声部。 */
  onSelectPart: (name: string) => void
  /** 修改某个声部的部分颜色字段（不改 name）。 */
  onChangeColors: (name: string, patch: Partial<PaletteColors>) => void
  /** 新增一个声部配色。 */
  onCreatePart: (name: string) => void
  /** 重命名声部。 */
  onRenamePart: (oldName: string, newName: string) => void
  /** 删除一个声部配色；调用方应保证不删到一个都不剩。 */
  onDeletePart: (name: string) => void
}

function PresetSwatch({ colors }: { colors: PaletteColors }) {
  const bg = (assColor: string): string => {
    try {
      return assToCssHex(assColor)
    } catch {
      return '#000000'
    }
  }
  return (
    <span className="kvm-palette-swatches">
      <span className="kvm-palette-chip" style={{ background: bg(colors.unsung_fill) }} />
      <span className="kvm-palette-chip" style={{ background: bg(colors.unsung_outline) }} />
      <span className="kvm-palette-chip" style={{ background: bg(colors.sung_fill) }} />
      <span className="kvm-palette-chip" style={{ background: bg(colors.sung_outline) }} />
    </span>
  )
}

interface ColorFieldProps {
  label: string
  hint: string
  value: string
  onCommit: (nextAss: string) => void
}

/**
 * 单个颜色字段：普通取色器 + ASS 原始值文本框（给需要精确核对/粘贴的高级用户）。
 * 取色器只读写 RGB，写回时沿用原值的 alpha 字节，不覆盖用户可能手工设过的透明度。
 */
function ColorField({ label, hint, value, onCommit }: ColorFieldProps) {
  const [rawText, setRawText] = useState(value)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRawText(value)
    setError(null)
  }, [value])

  let cssHex = '#000000'
  try {
    cssHex = assToCssHex(value)
  } catch {
    /* 上游应始终传合法值；解析失败时取色器退回黑色占位，不阻塞渲染 */
  }

  const currentAlpha = (() => {
    try {
      return parseAssColor(value).alpha
    } catch {
      return 0
    }
  })()

  const handlePickerChange = (hex: string) => {
    const next = cssHexToAss(hex, currentAlpha)
    setRawText(next)
    setError(null)
    onCommit(next)
  }

  const commitRawText = () => {
    try {
      const normalized = formatAssColor(parseAssColor(rawText))
      setRawText(normalized)
      setError(null)
      onCommit(normalized)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="kvm-palette-field">
      <div className="kvm-palette-field-label-col">
        <div className="kvm-palette-field-label">{label}</div>
        <div className="kvm-palette-field-hint">{hint}</div>
      </div>
      <input
        type="color"
        className="kvm-palette-color-picker"
        value={cssHex}
        onChange={(e) => handlePickerChange(e.target.value)}
        aria-label={`${label} 取色器`}
      />
      <input
        type="text"
        className={`kvm-palette-color-text${error ? ' kvm-palette-color-text--error' : ''}`}
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
        onBlur={commitRawText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        spellCheck={false}
        aria-label={`${label} ASS 原始值`}
      />
      {error && <span className="kvm-palette-color-error">{error}</span>}
    </div>
  )
}

function SamplePreview({ palette }: { palette: Palette }) {
  const textStyle = (fill: string, outline: string): CSSProperties => {
    let fillHex = '#fff'
    let outlineHex = '#000'
    try {
      fillHex = assToCssHex(fill)
      outlineHex = assToCssHex(outline)
    } catch {
      /* 防御：正常情况下 palette 里的值恒合法 */
    }
    return {
      color: fillHex,
      WebkitTextStroke: `2px ${outlineHex}`,
      textShadow: `0 0 3px ${outlineHex}`,
    }
  }
  return (
    <div className="kvm-palette-sample">
      <span className="kvm-palette-sample-text" style={textStyle(palette.unsung_fill, palette.unsung_outline)}>
        未唱歌詞
      </span>
      <span className="kvm-palette-sample-text" style={textStyle(palette.sung_fill, palette.sung_outline)}>
        已唱歌詞
      </span>
    </div>
  )
}

export default function PalettePicker({
  palettes,
  activePart,
  onSelectPart,
  onChangeColors,
  onCreatePart,
  onRenamePart,
  onDeletePart,
}: PalettePickerProps) {
  const partNames = Object.keys(palettes)
  const active: Palette | undefined = palettes[activePart]

  const [newPartName, setNewPartName] = useState('')
  const [newPartError, setNewPartError] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState(activePart)
  const [renameError, setRenameError] = useState<string | null>(null)

  useEffect(() => {
    setRenameDraft(activePart)
    setRenameError(null)
  }, [activePart])

  const handleCreate = () => {
    const name = newPartName.trim()
    if (!name) {
      setNewPartError('声部名不能为空')
      return
    }
    if (partNames.includes(name)) {
      setNewPartError('这个声部名已经存在')
      return
    }
    onCreatePart(name)
    setNewPartName('')
    setNewPartError(null)
  }

  const handleRename = () => {
    const name = renameDraft.trim()
    if (!name) {
      setRenameError('声部名不能为空')
      return
    }
    if (name !== activePart && partNames.includes(name)) {
      setRenameError('这个声部名已经存在')
      return
    }
    if (name !== activePart) onRenamePart(activePart, name)
    setRenameError(null)
  }

  return (
    <div className="kvm-palette">
      <style>{CSS}</style>

      {/* 声部切换 + 新增 */}
      <div>
        <div className="kvm-palette-section-title">声部</div>
        <div className="kvm-palette-tabs">
          {partNames.map((name) => (
            <button
              key={name}
              type="button"
              className={`kvm-palette-tab${name === activePart ? ' kvm-palette-tab--active' : ''}`}
              onClick={() => onSelectPart(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="kvm-palette-row">
          <input
            type="text"
            className="kvm-palette-input"
            value={newPartName}
            onChange={(e) => {
              setNewPartName(e.target.value)
              setNewPartError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
            }}
            placeholder="新声部名，如 duet_b"
          />
          <button type="button" className="kvm-palette-btn" onClick={handleCreate}>
            新增声部
          </button>
        </div>
        {newPartError && <div className="kvm-palette-error">{newPartError}</div>}
      </div>

      {active ? (
        <>
          {/* 重命名 / 删除当前声部 */}
          <div>
            <div className="kvm-palette-section-title">编辑「{activePart}」</div>
            <div className="kvm-palette-row" style={{ marginTop: 0 }}>
              <input
                type="text"
                className="kvm-palette-input"
                value={renameDraft}
                onChange={(e) => {
                  setRenameDraft(e.target.value)
                  setRenameError(null)
                }}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
              <button
                type="button"
                className="kvm-palette-btn kvm-palette-btn--danger"
                onClick={() => onDeletePart(activePart)}
                disabled={partNames.length <= 1}
                title={partNames.length <= 1 ? '至少要保留一个声部配色' : '删除这个声部配色'}
              >
                删除该声部
              </button>
            </div>
            {renameError && <div className="kvm-palette-error">{renameError}</div>}
          </div>

          {/* 预设配色 */}
          <div>
            <div className="kvm-palette-section-title">预设配色</div>
            <div className="kvm-palette-presets">
              {PALETTE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="kvm-palette-preset"
                  onClick={() => onChangeColors(activePart, preset.colors)}
                  title={preset.description}
                >
                  <PresetSwatch colors={preset.colors} />
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="kvm-palette-note">
              套用预设只改颜色，不影响字号/描边宽度等排版设置；套用后仍可在下面继续微调。
            </div>
          </div>

          {/* 四个颜色 */}
          <div>
            <div className="kvm-palette-section-title">颜色</div>
            <ColorField
              label="未唱 · 填充"
              hint="还没唱到的字用这个颜色"
              value={active.unsung_fill}
              onCommit={(next) => onChangeColors(activePart, { unsung_fill: next })}
            />
            <ColorField
              label="未唱 · 描边"
              hint="未唱字的描边（外框）颜色"
              value={active.unsung_outline}
              onCommit={(next) => onChangeColors(activePart, { unsung_outline: next })}
            />
            <ColorField
              label="已唱 · 填充"
              hint="唱到这个字时翻成的颜色"
              value={active.sung_fill}
              onCommit={(next) => onChangeColors(activePart, { sung_fill: next })}
            />
            <ColorField
              label="已唱 · 描边"
              hint="双层 clip 会让描边跟着填充一起翻色，这里配已唱状态的描边"
              value={active.sung_outline}
              onCommit={(next) => onChangeColors(activePart, { sung_outline: next })}
            />
          </div>

          {/* 取样预览 */}
          <div>
            <div className="kvm-palette-section-title">取样预览</div>
            <SamplePreview palette={active} />
            <div className="kvm-palette-note">
              这是配色的示意效果（CSS 模拟描边），不是最终渲染画面；实际效果以视频预览为准。
            </div>
          </div>
        </>
      ) : (
        <div className="kvm-palette-note">还没有可编辑的声部配色，先在上面新增一个（比如「main」）。</div>
      )}
    </div>
  )
}

/**
 * 样式内联在组件里：本项目还没有统一的全局样式方案，多个 agent 并行开发时
 * 各写各的、类名各自加前缀（`kvm-palette-`）就不会互相冲突。深色配色与
 * `RubyEditor.tsx` 的 `--kvm-panel-bg` / `--kvm-fg` / `--kvm-border` 变量名保持
 * 一致，便于外层日后统一换肤。
 */
const CSS = `
.kvm-palette { display: flex; flex-direction: column; gap: 14px; color: var(--kvm-fg, #e6e6e6); }
.kvm-palette * { box-sizing: border-box; }

.kvm-palette-section-title {
  font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: #9aa0aa; margin-bottom: 6px;
}

.kvm-palette-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.kvm-palette-tab {
  padding: 4px 10px; border-radius: 999px; border: 1px solid var(--kvm-border, #33363d);
  background: #22252b; color: #cfd3da; font-size: 12px; cursor: pointer;
}
.kvm-palette-tab:hover { border-color: #6b7280; }
.kvm-palette-tab--active { border-color: #4a8fd0; background: #24303d; color: #fff; }

.kvm-palette-row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.kvm-palette-input {
  padding: 5px 8px; border: 1px solid var(--kvm-border, #33363d); border-radius: 3px;
  background: #14161a; color: inherit; font-size: 12.5px; flex: 1 1 auto; min-width: 0;
}
.kvm-palette-input:focus { outline: none; border-color: #4a8fd0; }

.kvm-palette-btn {
  padding: 5px 10px; border: 1px solid var(--kvm-border, #33363d); border-radius: 4px;
  background: #2e323a; color: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.kvm-palette-btn:hover:not(:disabled) { border-color: #6b7280; }
.kvm-palette-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.kvm-palette-btn--danger { color: #ef8080; }
.kvm-palette-btn--danger:hover:not(:disabled) { border-color: #c05252; }

.kvm-palette-error { font-size: 11px; color: #ef8080; margin-top: 4px; }

.kvm-palette-presets { display: flex; flex-wrap: wrap; gap: 8px; }
.kvm-palette-preset {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
  border: 1px solid var(--kvm-border, #33363d); border-radius: 4px; background: #2e323a;
  color: inherit; font-size: 12px; cursor: pointer;
}
.kvm-palette-preset:hover { border-color: #6b7280; }
.kvm-palette-swatches { display: inline-flex; gap: 2px; }
.kvm-palette-chip { width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.25); }

.kvm-palette-note { font-size: 11px; color: #8b909a; margin-top: 4px; }

.kvm-palette-field { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.kvm-palette-field-label-col { flex: 0 0 128px; }
.kvm-palette-field-label { font-size: 12.5px; font-weight: 600; }
.kvm-palette-field-hint { font-size: 11px; color: #8b909a; }

.kvm-palette-color-picker {
  width: 36px; height: 28px; padding: 0; border: 1px solid var(--kvm-border, #33363d);
  border-radius: 4px; cursor: pointer; background: transparent;
}
.kvm-palette-color-text {
  width: 132px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  padding: 4px 6px; border: 1px solid var(--kvm-border, #33363d); border-radius: 4px;
  background: #14161a; color: inherit;
}
.kvm-palette-color-text:focus { outline: none; border-color: #4a8fd0; }
.kvm-palette-color-text--error { border-color: #c0392b; }
.kvm-palette-color-error { font-size: 11px; color: #ef8080; }

.kvm-palette-sample {
  display: flex; gap: 20px; align-items: center; padding: 16px 14px; border-radius: 8px; background: #0e0e0e;
}
.kvm-palette-sample-text { font-weight: 700; font-size: 26px; }
`
