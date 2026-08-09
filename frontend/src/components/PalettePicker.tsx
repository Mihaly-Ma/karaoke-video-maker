/**
 * 声部配色编辑器。
 *
 * 一个声部需要**四个颜色**而不是一个：未唱填充 / 未唱描边 / 已唱填充 / 已唱描边。
 * 因为渲染层用"双层 + 渐进 clip"让描边跟着填充一起翻色（日式卡拉OK 的招牌观感，
 * CLAUDE.md §8.5「声部」），未唱层与已唱层各需一组填充/描边。配色与排版分离——
 * 这里只管颜色，字号边距那些在 `StyleControls.tsx`。
 *
 * ## 操作模型：先选声部，再点方案
 *
 * **方案就是一组四色，不带声部。**点它就是把这组色写给当前选中的那个声部，
 * 别的声部不动。色板上看到什么，点下去就得到什么。
 *
 * 这里有过一个会静默失效的错误设计：方案曾经是 `dict[声部名 → 四色]`，
 * 内置方案按 `main` / `duet_a` / `duet_b` / `chorus` 写死，取色靠
 * "该声部 → main → 第一个"三级回退。**而声部名是用户自定义的**——编辑舞台
 * 可以新建任意名字的声部、也可以就地改名（连 `main` 都能改），真实工程里的
 * 声部叫「男」「女」「合」。于是按名字取色全部落空、每个声部拿到同一组颜色，
 * 不报错也不提示。那个三级回退本身就是症状：需要三级兜底才能取出颜色，
 * 说明这个键根本不该长在方案上。**不要再把声部名写进方案。**
 *
 * 对唱要两套"能分辨、但看起来是一首歌"的配色，靠的是**方案列表按家族成组**
 * （`家族 · 变体`，同家族共享未唱色、只有已唱色不同）：给一个声部选家族里的
 * 一个变体，另一个声部选另一个。选择权在用户，因为只有他知道自己建了几个声部。
 *
 * ## 自定义方案：改了颜色就派生一条，之后一直更新它
 *
 * 绑定关系**不存指针，靠内容判定**（见 `matchingScheme`）。理由是改名：
 * 存了指针就得在改名时同步更新所有指向它的工程；按内容判定的话，改名不改颜色，
 * 绑定自然跟着走，一个字都不用同步。代价是内容一被改动就"脱钩"，而这恰好
 * 就是我们要的语义——脱钩的那一刻正是该派生新条目的时刻。
 *
 * ## 本组件是纯受控组件
 *
 * 不自己发请求、不自己拿方案列表。方案库的读写集中在 `usePaletteSchemes`，
 * 由 `StylePanel` 持有——因为"改完颜色自动存成方案"必须挂在提交管线上
 * （颜色改动是 debounce 后才提交的），而管线在 StylePanel 那边。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'

import * as api from '../api/client'
import type { Palette, PaletteScheme } from '../api/types'
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

const COLOR_KEYS = ['unsung_fill', 'unsung_outline', 'sung_fill', 'sung_outline'] as const

/**
 * 取某个声部**实际生效**的四个颜色，与后端 `Project.palette_for` 同一套回退顺序：
 * 本声部 → main → 内置默认。`explicit=false` 表示这套颜色是继承来的，不是这个
 * 声部自己的——界面要标出来，否则用户会以为改它只影响这一个声部。
 *
 * 注意这里的 `main` 回退是**后端渲染层既有的行为**（没给配色的声部用 main 的色），
 * 与"方案不带声部"不冲突：这是工程配色的回退，不是方案的取色规则。
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

export function sameColors(a: PaletteColors, b: PaletteColors): boolean {
  return COLOR_KEYS.every((k) => a[k] === b[k])
}

/**
 * 找出与这组颜色完全一致的那套方案。**这就是"自定义条目"的绑定关系**：
 * 没有存任何指针，一致即绑定。
 *
 * 用当前声部**生效的四色**去比，而不是拿整首歌的配色字典去比——方案只有一组色，
 * 拿它跟多声部字典比是类型层面的错配，也正是上一版把声部焊进方案的起点。
 */
export function matchingScheme(
  schemes: PaletteScheme[],
  colors: PaletteColors,
): PaletteScheme | null {
  return schemes.find((s) => sameColors(s.colors, colors)) ?? null
}

// ---- 方案库（跨工程的全局资源） ----

export interface PaletteSchemeLibrary {
  list: PaletteScheme[]
  /** 取列表时出的错。取不到不该挡住手工调色，所以只作提示 */
  error: string | null
  save: (name: string, colors: PaletteColors, description: string) => Promise<void>
  rename: (name: string, newName: string) => Promise<void>
  remove: (name: string) => Promise<void>
  /** 供提交管线读取最新列表——它跑在异步回调里，闭包拿到的 `list` 会是旧值 */
  latest: () => PaletteScheme[]
}

/**
 * 配色方案库：内置 + 用户自存，来自 `GET /api/palettes/schemes`。
 *
 * **方案是全局资源，不属于任何工程**（后端 `PaletteScheme` 的文档写明了理由：
 * 调出一套满意的配色，下一首歌还要用）。所以它的增删改**不进工程的撤销栈**——
 * 撤销栈是这份工程文档的历史，Cmd+Z 不该跨过去改用户的方案库。
 */
export function usePaletteSchemes(): PaletteSchemeLibrary {
  const [list, setList] = useState<PaletteScheme[]>([])
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<PaletteScheme[]>([])

  const apply = useCallback((next: PaletteScheme[]) => {
    listRef.current = next
    setList(next)
  }, [])

  const reload = useCallback(async () => {
    try {
      apply(await api.listPaletteSchemes())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [apply])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (name: string, colors: PaletteColors, description: string) => {
      // 后端的 PaletteDTO 带 name 字段，但方案层面它没有意义，给空串
      await api.savePaletteScheme(name, { name: '', ...colors }, { description })
      await reload()
    },
    [reload],
  )

  const rename = useCallback(
    async (name: string, newName: string) => {
      await api.renamePaletteScheme(name, newName)
      await reload()
    },
    [reload],
  )

  const remove = useCallback(
    async (name: string) => {
      await api.deletePaletteScheme(name)
      await reload()
    },
    [reload],
  )

  return { list, error, save, rename, remove, latest: () => listRef.current }
}

// ---- 颜色字段 ----

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

// ---- 方案条目 ----

interface SchemeRowProps {
  scheme: PaletteScheme
  active: boolean
  onApply: () => void
  onRename: (newName: string) => void
  onRemove: () => void
}

/**
 * 一条方案：色板 + 名字（+ 用户方案的改名/删除）。
 *
 * 内置的没有改名/删除按钮——按钮存在但点了报错是最差的一种交互，不可用的能力
 * 就不该出现在界面上。后端也会拒（400），两道门都要有。
 */
function SchemeRow({ scheme, active, onApply, onRename, onRemove }: SchemeRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(scheme.name)

  useEffect(() => {
    setDraft(scheme.name)
  }, [scheme.name])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== scheme.name) onRename(next)
    else setDraft(scheme.name)
  }

  if (editing) {
    return (
      <div className="sty-scheme sty-scheme--editing">
        <input
          className="sty-scheme__input"
          value={draft}
          autoFocus
          spellCheck={false}
          aria-label={t('style.scheme.renameLabel')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(scheme.name)
              setEditing(false)
            }
          }}
        />
        <button
          type="button"
          className="sty-scheme__act"
          title={t('style.scheme.renameOk')}
          aria-label={t('style.scheme.renameOk')}
          onClick={commit}
        >
          <CheckOutlined />
        </button>
        <button
          type="button"
          className="sty-scheme__act"
          title={t('style.scheme.renameCancel')}
          aria-label={t('style.scheme.renameCancel')}
          onClick={() => {
            setDraft(scheme.name)
            setEditing(false)
          }}
        >
          <CloseOutlined />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`sty-scheme${active ? ' sty-scheme--on' : ''}${
        scheme.builtin ? ' sty-scheme--builtin' : ' sty-scheme--user'
      }`}
      data-scheme={scheme.name}
    >
      <button
        type="button"
        className="sty-scheme__main"
        title={scheme.description || scheme.name}
        onClick={onApply}
      >
        <span className="sty-scheme__swatch">
          {COLOR_KEYS.map((k) => (
            <span
              key={k}
              className="sty-scheme__dot"
              style={{ background: safeHex(scheme.colors[k]) }}
            />
          ))}
        </span>
        <span className="sty-scheme__name">{scheme.name}</span>
      </button>
      {!scheme.builtin && (
        <>
          <button
            type="button"
            className="sty-scheme__act"
            data-act="rename"
            title={t('style.scheme.rename')}
            aria-label={t('style.scheme.rename')}
            onClick={() => setEditing(true)}
          >
            <EditOutlined />
          </button>
          <button
            type="button"
            className="sty-scheme__act"
            data-act="delete"
            title={t('style.scheme.remove')}
            aria-label={t('style.scheme.remove')}
            onClick={onRemove}
          >
            <DeleteOutlined />
          </button>
        </>
      )}
    </div>
  )
}

// ---- 主体 ----

export interface PalettePickerProps {
  /** 工程当前的配色，key 是声部名 */
  palettes: Record<string, Palette>
  /** 界面上要列出的声部（由歌词数据与已有配色汇总得出） */
  parts: string[]
  activePart: string
  onSelectPart: (name: string) => void
  /** 改某个声部的部分颜色字段 */
  onChangeColors: (name: string, patch: Partial<PaletteColors>) => void
  /** 把某套方案施加到当前声部 */
  onApplyScheme: (schemeName: string) => void
  schemes: PaletteSchemeLibrary
}

export default function PalettePicker({
  palettes,
  parts,
  activePart,
  onSelectPart,
  onChangeColors,
  onApplyScheme,
  schemes,
}: PalettePickerProps) {
  const { colors, explicit } = effectivePalette(palettes, activePart)
  const current = matchingScheme(schemes.list, colors)

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

      <div className="sty-schemes__head">{t('style.scheme.applyTo', { part: activePart })}</div>
      {schemes.error && <div className="sty-note">{t('style.scheme.loadFailed')}</div>}
      <div className="sty-schemes" data-testid="palette-schemes">
        {schemes.list.map((scheme) => (
          <SchemeRow
            key={scheme.name}
            scheme={scheme}
            active={current?.name === scheme.name}
            onApply={() => onApplyScheme(scheme.name)}
            onRename={(next) => void schemes.rename(scheme.name, next)}
            onRemove={() => void schemes.remove(scheme.name)}
          />
        ))}
      </div>
    </>
  )
}
