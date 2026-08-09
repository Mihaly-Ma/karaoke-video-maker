/**
 * 声部配色编辑器。
 *
 * 一个声部需要**四个颜色**而不是一个：未唱填充 / 未唱描边 / 已唱填充 / 已唱描边。
 * 因为渲染层用"双层 + 渐进 clip"让描边跟着填充一起翻色（日式卡拉OK 的招牌观感，
 * CLAUDE.md §8.5「声部」），未唱层与已唱层各需一组填充/描边。配色与排版分离——
 * 这里只管颜色，字号边距那些在 `StyleControls.tsx`。
 *
 * ## 两处与旧版的关键差异
 *
 * 1. **改了要存得住。** 旧版把配色留在组件内部草稿态，刷新即丢
 *    （docs/ui-redesign.md §六点五点名的问题）。现在颜色改动经 `onChangeColors`
 *    交给 `StylePanel` 走 store 的 `updatePalettes`（POST /api/projects/{id}/palettes，
 *    进撤销栈）。本组件仍是纯受控组件，不自己发请求。
 * 2. **声部不再由用户新建/重命名/删除。** 声部名来自歌词数据（`Line.voice_part` /
 *    `Token.voice_part`）与已有配色，凭空造一个没有任何行引用的声部没有意义；
 *    真正要做的只有"给这个声部换颜色"。
 *
 * 预设走后端的配色模板（`GET /api/palettes/templates`，内置 + 用户保存的），
 * 而不是前端再硬编码一份——两份预设迟早对不上。
 */

import { useEffect, useState } from 'react'

import * as api from '../api/client'
import type { Palette, PaletteTemplate } from '../api/types'
import { t } from '../i18n'
import { assToCssHex, cssHexToAss, formatAssColor, parseAssColor } from '../lib/assColor'

export type PaletteColors = Omit<Palette, 'name'>

/**
 * 工程没设过配色时后端实际会用的那套（backend/kvm/models/karaoke.py 的
 * `VoicePalette` 默认值）。照抄一份是为了让界面显示的颜色与成片一致——
 * 显示成黑色或空白会让用户以为"还没有配色"，而成片里其实是有的。
 */
export const DEFAULT_PALETTE: PaletteColors = {
  unsung_fill: '&H00F0F0F0&',
  unsung_outline: '&H00303030&',
  sung_fill: '&H0040C0FF&',
  sung_outline: '&H00202020&',
}

/**
 * 取某个声部**实际生效**的四个颜色，与后端 `Project.palette_for` 同一套回退顺序：
 * 本声部 → main → 内置默认。`explicit=false` 表示这套颜色是继承来的，不是这个
 * 声部自己的——界面要标出来，否则用户会以为改它只影响这一个声部。
 */
export function effectivePalette(
  palettes: Record<string, Palette>,
  part: string,
): { colors: PaletteColors; explicit: boolean } {
  const own = palettes[part]
  if (own) return { colors: own, explicit: true }
  const main = palettes.main
  return { colors: main ?? DEFAULT_PALETTE, explicit: false }
}

function safeHex(assColor: string): string {
  try {
    return assToCssHex(assColor)
  } catch {
    return '#000000'
  }
}

interface ColorRowProps {
  label: string
  value: string
  onCommit: (nextAss: string) => void
}

/**
 * 一个颜色字段：取色器 + ASS 原始值。
 *
 * 取色器只读写 RGB，写回时沿用原值的 alpha 字节——ASS 的 alpha 语义与 CSS 相反
 * （00 = 不透明），取色器表达不了，覆盖掉会把用户手工设的透明度抹平。
 */
function ColorRow({ label, value, onCommit }: ColorRowProps) {
  const [raw, setRaw] = useState(value)
  const [bad, setBad] = useState(false)

  useEffect(() => {
    setRaw(value)
    setBad(false)
  }, [value])

  const alpha = (() => {
    try {
      return parseAssColor(value).alpha
    } catch {
      return 0
    }
  })()

  const commitRaw = () => {
    try {
      const normalized = formatAssColor(parseAssColor(raw))
      setRaw(normalized)
      setBad(false)
      onCommit(normalized)
    } catch {
      setBad(true)
    }
  }

  return (
    <div className="sty-color">
      <input
        type="color"
        className="sty-color__pick"
        value={safeHex(value)}
        aria-label={label}
        onChange={(e) => onCommit(cssHexToAss(e.target.value, alpha))}
      />
      <span className="sty-color__label">{label}</span>
      <input
        type="text"
        className={`sty-color__hex${bad ? ' sty-color__hex--bad' : ''}`}
        value={raw}
        spellCheck={false}
        aria-label={`${label} ASS`}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commitRaw}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </div>
  )
}

export interface PalettePickerProps {
  /** 工程当前的配色，key 是声部名 */
  palettes: Record<string, Palette>
  /** 界面上要列出的声部（由歌词数据与已有配色汇总得出） */
  parts: string[]
  activePart: string
  onSelectPart: (name: string) => void
  /** 改某个声部的部分颜色字段 */
  onChangeColors: (name: string, patch: Partial<PaletteColors>) => void
  /** 套用一整套模板（覆盖模板里出现的每个声部） */
  onApplyTemplate: (palettes: Record<string, Palette>) => void
}

export default function PalettePicker({
  palettes,
  parts,
  activePart,
  onSelectPart,
  onChangeColors,
  onApplyTemplate,
}: PalettePickerProps) {
  const [templates, setTemplates] = useState<PaletteTemplate[]>([])

  useEffect(() => {
    let cancelled = false
    void api
      .listPaletteTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list)
      })
      .catch(() => {
        // 模板取不到不该挡住手工调色：这是锦上添花的入口，不是主路径
      })
    return () => {
      cancelled = true
    }
  }, [])

  const { colors, explicit } = effectivePalette(palettes, activePart)

  return (
    <>
      <div className="sty-parts">
        {parts.map((name) => (
          <button
            key={name}
            type="button"
            className={`sty-part${name === activePart ? ' sty-part--on' : ''}`}
            onClick={() => onSelectPart(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {templates.length > 0 && (
        <div className="sty-tpls">
          {templates.map((tpl) => {
            const sample = tpl.palettes.main ?? Object.values(tpl.palettes)[0]
            return (
              <button
                key={tpl.name}
                type="button"
                className="sty-tpl"
                title={tpl.description}
                onClick={() => onApplyTemplate(tpl.palettes)}
              >
                <span className="sty-tpl__swatch">
                  {sample &&
                    (
                      [
                        sample.unsung_fill,
                        sample.unsung_outline,
                        sample.sung_fill,
                        sample.sung_outline,
                      ] as const
                    ).map((c, i) => (
                      <span key={i} className="sty-tpl__dot" style={{ background: safeHex(c) }} />
                    ))}
                </span>
                <span className="sty-tpl__name">{tpl.name}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="sty-note">
        {explicit
          ? t('style.palette.editing', { part: activePart })
          : t('style.palette.inherited', { part: activePart })}
      </div>

      <ColorRow
        label={t('style.palette.unsungFill')}
        value={colors.unsung_fill}
        onCommit={(v) => onChangeColors(activePart, { unsung_fill: v })}
      />
      <ColorRow
        label={t('style.palette.unsungOutline')}
        value={colors.unsung_outline}
        onCommit={(v) => onChangeColors(activePart, { unsung_outline: v })}
      />
      <ColorRow
        label={t('style.palette.sungFill')}
        value={colors.sung_fill}
        onCommit={(v) => onChangeColors(activePart, { sung_fill: v })}
      />
      <ColorRow
        label={t('style.palette.sungOutline')}
        value={colors.sung_outline}
        onCommit={(v) => onChangeColors(activePart, { sung_outline: v })}
      />
    </>
  )
}
