/**
 * 字体选择：**一条有序候选链** + 四档卡拉OK 常用预置 + 可搜索的系统字体列表。
 *
 * ## 为什么是链，不是一个字体
 *
 * 没有一个日文字体覆盖得全。「鷗」「𠮷」「①」「㍿」这类字时有时无，而缺字的后果
 * 两端不同：预览（JASSUB，`ASS_FONTPROVIDER_NONE`）手里只有我们喂进去的字体，
 * 缺了就是空白；导出（ffmpeg）的系统回退**无法禁用**，它会自己找个字体顶上。
 * 链把"缺字时用谁"从两端各自的默认行为，变成工程里显式记着的一份数据，
 * 两端照同一份走，WYSIWYG 才成立（CLAUDE.md §5.12）。
 *
 * ## 搜索与链编辑是同一个控件的两半
 *
 * 分成两块的话，用户得先在一处找到字体、再到另一处把它加进链——中间那步没有任何
 * 信息量。所以下面是一条竖着的流水：**链在上（现状），搜索在下（改它的入口）**，
 * 搜索结果的主操作就是"加进链"，链里已有的项直接标出来。
 *
 * 862 个字体族摊不开，只能保留列表 + 搜索。这是"避免下拉框"那条界面规约的
 * 正当例外：真正该避免的是把少量选项藏进折叠层，而不是给几百项做检索。
 *
 * ## 搜索必须认日文名
 *
 * `family` 是英文（`Hiragino Kaku Gothic ProN`），而界面上、字体册上、用户脑子里
 * 都是「ヒラギノ角ゴ」。只按 `family` 搜，用户会以为本机没装这个字体。
 * 后端为此在 `FontInfo.alt_names` 里带上了 name 表里的全部语言写法，
 * 这里再补一道平假名↔片假名归一，打「ひらぎの」也搜得到。
 *
 * ## 字形覆盖预检就挂在这里
 *
 * 缺字必须在渲染前拦截（CLAUDE.md §2.6 / §6.3）。**选字体的这一刻正是唯一
 * 能"改"的地方**：换一个字体、或往链尾加一个，就是全部的解法，而它们都在下面。
 * 预检查的是整条链，并顺带告诉用户**每个字实际由哪个字体承担**——
 * 配了链却不知道链尾有没有被用到，等于配了个不知道有没有生效的东西。
 *
 * 导出前还有一道同样的预检（`ExportPanel`），走同一个缓存。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  PlusOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons'

import * as api from '../api/client'
import type { FontInfo, FontPreset, FontScanStatus } from '../api/types'
import { t } from '../i18n'
import { formatMissing, useFontCoverage } from '../lib/fontCoverage'
import { toHiragana } from '../lib/kana'

/** 扫描状态轮询间隔。太密没意义（后端是秒级推进的），太疏用户等得难受 */
const POLL_INTERVAL_MS = 1500

/**
 * 一次最多渲染多少个字体条目。
 *
 * 862 项全部实例化成 DOM 会让每次按键都重排几百个节点。截断而不是做虚拟滚动，
 * 是因为**用户翻不完 862 项，只会搜**：截断处直接告诉他"还有多少、请继续输入"，
 * 比一个能无限滚动却找不到东西的列表有用。
 */
const MAX_ROWS = 120

/** 搜索用的归一化：小写 + 片假名转平假名，让「ヒラギノ」与「ひらぎの」互相命中 */
function searchNormalize(text: string): string {
  return toHiragana(text.toLowerCase())
}

/** 预先算好每个字体的可搜索文本，避免每次按键都重新拼一遍几百条字符串 */
interface FontRow {
  info: FontInfo
  haystack: string
}

/**
 * 当前字体链的字形覆盖结论。
 *
 * **齐全时也要显式说一句**：预检默默通过与预检根本没跑，在界面上长得一模一样。
 */
function CoverageNote({
  chain,
  charset,
  bold,
}: {
  chain: string[]
  charset: string
  bold: boolean
}) {
  const state = useFontCoverage(chain, charset, bold)
  if (state.kind === 'idle') return null
  if (state.kind === 'checking') return <div className="sty-note">{t('style.font.covChecking')}</div>
  if (state.kind === 'failed') {
    return <div className="sty-note">{t('style.font.covFailed', { detail: state.detail })}</div>
  }

  const { missing, total_checked: total } = state.result
  return (
    <>
      {missing.length > 0 ? (
        <div className="sty-cov sty-cov--warn">
          <WarningOutlined />
          <span>
            {t('style.font.covMissing', { n: missing.length, chars: formatMissing(missing) })}
          </span>
        </div>
      ) : (
        <div className="sty-cov sty-cov--ok">
          <CheckCircleOutlined />
          <span>{t('style.font.covOk', { n: total })}</span>
        </div>
      )}
    </>
  )
}

/**
 * 链上某个字体承担了多少字。链尾承担 0 字时要说出来——
 * 那说明这一环当前没起作用，用户才好判断留不留。
 */
function ShareNote({
  chain,
  charset,
  bold,
  family,
}: {
  chain: string[]
  charset: string
  bold: boolean
  family: string
}) {
  const state = useFontCoverage(chain, charset, bold)
  if (state.kind !== 'done') return null
  const share = state.result.shares.find((s) => s.family === family)
  if (!share) return null
  return (
    <span className="sty-chain__share">
      {share.count > 0
        ? t('style.font.share', { n: share.count })
        : t('style.font.shareNone')}
    </span>
  )
}

export interface StyleFontPickerProps {
  /** 有序字体候选链，首项即主字体 */
  value: string[]
  /** 成片上会出现的全部字符（去重排序，由 `renderedCharset` 产出），供字形预检 */
  charset: string
  /** 是否勾了粗体。只影响**预热哪一档字重**的子集产物，不影响覆盖率结论 */
  bold?: boolean
  onChange: (chain: string[]) => void
}

export default function StyleFontPicker({
  value,
  charset,
  bold = false,
  onChange,
}: StyleFontPickerProps) {
  const [status, setStatus] = useState<FontScanStatus | null>(null)
  const [presets, setPresets] = useState<FontPreset[]>([])
  const [fonts, setFonts] = useState<FontInfo[]>([])
  const [cjkOnly, setCjkOnly] = useState(true)
  const [query, setQuery] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const pollTimerRef = useRef<number | null>(null)
  const lastStateRef = useRef<FontScanStatus['state'] | null>(null)

  const chain = value.length ? value : []
  const head = chain[0] ?? ''

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

  useEffect(() => {
    void loadFontList(cjkOnly)
  }, [cjkOnly, loadFontList])

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  // scanning → ready 时重新拉一次完整列表与预置；只拉一次会永久停在不完整的结果上
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
          pollTimerRef.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
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

  const scanning = status?.state === 'scanning'

  /*
   * 可搜索文本只在**字体列表变化**时重算一次（862 条），不跟着按键走。
   * 每次按键都重新归一化几百条字符串，正是"输入卡顿"的典型来源。
   */
  const rows = useMemo<FontRow[]>(
    () =>
      fonts.map((info) => ({
        info,
        haystack: searchNormalize([info.family, ...info.alt_names].join(' ')),
      })),
    [fonts],
  )

  /*
   * `useDeferredValue`：过滤与重排让给输入框，打字永远不掉帧。
   * 862 项的过滤本身很快，真正贵的是重建列表 DOM，而它正是这里要错开的东西。
   */
  const deferredQuery = useDeferredValue(query)
  const filtered = useMemo(() => {
    const needle = searchNormalize(deferredQuery.trim())
    if (!needle) return rows
    return rows.filter((r) => r.haystack.includes(needle))
  }, [rows, deferredQuery])

  const shown = filtered.slice(0, MAX_ROWS)

  const setChain = (next: string[]) => {
    // 去重保留首次位置：链尾重复链首毫无意义，只会让承担统计冒出两条同名条目
    const clean = next.map((f) => f.trim()).filter(Boolean)
    onChange(clean.filter((f, i) => clean.indexOf(f) === i))
  }

  /** 加进链尾。链为空时它自然成为主字体 */
  const append = (family: string) => {
    if (chain.includes(family)) return
    setChain([...chain, family])
  }

  /** 提到链首当主字体。已在链里的只是挪位置，不该冒出重复项 */
  const promote = (family: string) => setChain([family, ...chain.filter((f) => f !== family)])

  const move = (index: number, delta: number) => {
    const next = [...chain]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    setChain(next)
  }

  const remove = (family: string) => {
    // 链不能空：空链等于没有字体，libass 会退到自带的 Liberation Sans，
    // 日文整片渲成豆腐块且不报错。所以最后一个不给删。
    if (chain.length <= 1) return
    setChain(chain.filter((f) => f !== family))
  }

  return (
    <>
      {status && (status.state === 'scanning' || status.state === 'failed') && (
        <div className="sty-note">{status.message}</div>
      )}
      {loadError && <div className="sty-err">{t('style.font.loadFailed', { detail: loadError })}</div>}

      {/* 结论说的是**当前这条链**，所以排在最前：先看现状，再决定改不改 */}
      <div className="sty-covbox" data-testid="font-coverage">
        <CoverageNote chain={chain} charset={charset} bold={bold} />
      </div>

      <div className="sty-chain" data-testid="font-chain">
        {chain.map((family, i) => (
          <div
            key={family}
            className={`sty-chain__row${i === 0 ? ' sty-chain__row--head' : ''}`}
          >
            <span className="sty-chain__rank">
              {i === 0 ? t('style.font.primary') : t('style.font.fallbackN', { n: i })}
            </span>
            <span className="sty-chain__name">{family}</span>
            <ShareNote chain={chain} charset={charset} bold={bold} family={family} />
            <span className="sty-chain__ops">
              <button
                type="button"
                title={t('style.font.moveUp')}
                aria-label={t('style.font.moveUp')}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUpOutlined />
              </button>
              <button
                type="button"
                title={t('style.font.moveDown')}
                aria-label={t('style.font.moveDown')}
                disabled={i === chain.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDownOutlined />
              </button>
              <button
                type="button"
                title={t('style.font.remove')}
                aria-label={t('style.font.remove')}
                disabled={chain.length <= 1}
                onClick={() => remove(family)}
              >
                <CloseOutlined />
              </button>
            </span>
          </div>
        ))}
        <div className="sty-chain__hint">{t('style.font.chainHint')}</div>
      </div>

      <div className="sty-fontgrid">
        {presets.map((p) => {
          const on = p.resolved !== null && p.resolved === head
          return (
            <button
              key={p.key}
              type="button"
              disabled={p.resolved === null}
              className={`sty-fontpreset${on ? ' sty-fontpreset--on' : ''}`}
              title={
                p.resolved === null
                  ? t('style.font.candidates', { list: p.candidates.join('、') })
                  : p.note
              }
              onClick={() => {
                if (p.resolved) promote(p.resolved)
              }}
            >
              <span className="sty-fontpreset__label">{p.label}</span>
              <span className="sty-fontpreset__sub">
                {p.pending
                  ? t('style.font.scanning')
                  : (p.resolved ?? t('style.font.unavailable'))}
              </span>
            </button>
          )
        })}
      </div>

      <div className="sty-fontbar">
        <span className="sty-search">
          <SearchOutlined />
          <input
            type="search"
            value={query}
            placeholder={t('style.font.searchHint')}
            aria-label={t('style.font.searchHint')}
            data-testid="font-search"
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <label className="sty-check">
          <input
            type="checkbox"
            checked={cjkOnly}
            onChange={(e) => setCjkOnly(e.target.checked)}
          />
          <span>{t('style.font.cjkOnly')}</span>
        </label>
      </div>

      <div className="sty-fontlist" data-testid="style-fontlist">
        {shown.map(({ info }) => {
          const inChain = chain.includes(info.family)
          return (
            <div
              key={info.family}
              className={`sty-fontitem${info.family === head ? ' sty-fontitem--on' : ''}`}
            >
              <button
                type="button"
                className="sty-fontitem__pick"
                title={t('style.font.setPrimary')}
                onClick={() => promote(info.family)}
              >
                <span className="sty-fontitem__name">{info.family}</span>
                {info.alt_names[0] && (
                  <span className="sty-fontitem__alt">{info.alt_names[0]}</span>
                )}
                {!info.is_cjk && (
                  <span className="sty-fontitem__warn">
                    <WarningOutlined /> {t('style.font.noCjk')}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="sty-fontitem__add"
                disabled={inChain}
                title={inChain ? t('style.font.inChain') : t('style.font.addFallback')}
                aria-label={inChain ? t('style.font.inChain') : t('style.font.addFallback')}
                onClick={() => append(info.family)}
              >
                {inChain ? <CheckCircleOutlined /> : <PlusOutlined />}
              </button>
            </div>
          )
        })}
        {filtered.length > shown.length && (
          <div className="sty-note sty-note--pad">
            {t('style.font.more', { n: filtered.length - shown.length })}
          </div>
        )}
        {/*
          三种空状态含义完全不同，不能合并成一句"没有字体"：
          还在扫 = 再等等；搜没中 = 换个词；真没有 = 后端或系统的问题。
        */}
        {filtered.length === 0 && (
          <div className="sty-note sty-note--pad">
            {scanning
              ? t('style.font.scanning')
              : query.trim()
                ? t('style.font.noMatch', { q: query.trim() })
                : t('style.font.empty')}
          </div>
        )}
      </div>
    </>
  )
}
