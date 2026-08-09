/**
 * 字体选择：四档卡拉OK 常用预置 + 完整系统字体列表。
 *
 * 字体一律经后端从本机系统扫描取得（CLAUDE.md §2.6），冷启动扫描约需 30~40 秒，
 * 期间 `GET /api/fonts/status` 是 `scanning`——本组件据此轮询，转为 `ready` 后重新
 * 拉一次列表与预置，而不是让用户永远停在扫描到一半的不完整列表上。
 *
 * 某档 `resolved=null` 且非 `pending` 时按钮禁用并说明原因，**绝不悄悄换成别的
 * 字体**：用户选了明朝体却渲染出黑体，比"该档不可用"更糟
 * （backend/kvm/api/routes/fonts.py 的 `PresetInfo` 文档）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { WarningOutlined } from '@ant-design/icons'

import * as api from '../api/client'
import type { FontInfo, FontPreset, FontScanStatus } from '../api/types'
import { t } from '../i18n'

/** 扫描状态轮询间隔。太密没意义（后端是秒级推进的），太疏用户等得难受 */
const POLL_INTERVAL_MS = 1500

export interface StyleFontPickerProps {
  value: string
  onPick: (family: string) => void
}

export default function StyleFontPicker({ value, onPick }: StyleFontPickerProps) {
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

  return (
    <>
      {status && (status.state === 'scanning' || status.state === 'failed') && (
        <div className="sty-note">{status.message}</div>
      )}
      {loadError && <div className="sty-err">{t('style.font.loadFailed', { detail: loadError })}</div>}

      <div className="sty-fontgrid">
        {presets.map((p) => {
          const on = p.resolved !== null && p.resolved === value
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
                if (p.resolved) onPick(p.resolved)
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
        <span>{cjkOnly ? t('style.font.cjkOnly') : t('style.font.all')}</span>
        <span className="sty-fontbar__spacer" />
        <label className="sty-check">
          <input
            type="checkbox"
            checked={!cjkOnly}
            onChange={(e) => setCjkOnly(!e.target.checked)}
          />
          <span>{t('style.font.showAll')}</span>
        </label>
      </div>

      <div className="sty-fontlist" data-testid="style-fontlist">
        {fonts.map((f) => (
          <button
            key={f.family}
            type="button"
            className={`sty-fontitem${f.family === value ? ' sty-fontitem--on' : ''}`}
            onClick={() => onPick(f.family)}
          >
            <span>{f.family}</span>
            {!f.is_cjk && (
              <span className="sty-fontitem__warn">
                <WarningOutlined /> {t('style.font.noCjk')}
              </span>
            )}
          </button>
        ))}
        {fonts.length === 0 && (
          <div className="sty-note sty-note--pad">
            {scanning ? t('style.font.scanning') : t('style.font.empty')}
          </div>
        )}
      </div>

      {value && !fonts.some((f) => f.family === value) && (
        <div className="sty-note">{t('style.font.current', { family: value })}</div>
      )}
    </>
  )
}
