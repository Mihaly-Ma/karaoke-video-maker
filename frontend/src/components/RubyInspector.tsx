/**
 * 注音舞台的右侧辅助栏：选中词的两份读音、候选、锁定，以及「待检查」清单。
 *
 * 两份读音必须同时在场（CLAUDE.md §4.2）：
 * **表记读法**是渲染到注音行的形态（助词「は」这里写「は」），
 * **发音形**是喂 G2P / 强制对齐的形态（同一个字这里是「ワ」）。
 * 只存一份的后果是二选一的系统性错误——要么注音行显示错，要么对齐器去找 /h/。
 */

import { DeleteOutlined, LockOutlined, ScissorOutlined, UnlockOutlined, WarningOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'

import { t } from '../i18n'
import {
  alignReading,
  normalizeKana,
  splitMora,
  toCodePoints,
  toHiragana,
  toKatakana,
  validateKana,
} from '../lib/kana'
import {
  canAnnotate,
  derivePhonetic,
  readingCandidates,
  SOURCE_LABEL_KEY,
  unitKey,
  type RubyUnit,
} from './RubyModel'

export interface RubyInspectorProps {
  unit: RubyUnit | null
  units: Map<string, RubyUnit[]>
  busy: boolean
  /** 已保存的发音形覆盖；为空表示还没人改过，用推导值 */
  phoneticOverride: string
  onApplyReading: (unit: RubyUnit, text: string) => void
  onSplit: (unit: RubyUnit, reading: string) => void
  onDelete: (unit: RubyUnit) => void
  onToggleLock: (unit: RubyUnit) => void
  onPhonetic: (unit: RubyUnit, value: string) => void
}

export function RubyInspector({
  unit,
  units,
  busy,
  phoneticOverride,
  onApplyReading,
  onSplit,
  onDelete,
  onToggleLock,
  onPhonetic,
}: RubyInspectorProps) {
  const key = unit ? unitKey(unit) : ''
  const saved = unit?.span?.text ?? ''
  const [draft, setDraft] = useState(saved)
  const [phonetic, setPhonetic] = useState('')

  // 换词或后端回写新值时重置草稿。依赖里带上 saved，是为了让「应用」之后
  // 输入框显示后端真正落库的那个值，而不是用户敲进去的那一版
  useEffect(() => {
    setDraft(saved)
  }, [key, saved])

  // 发音形跟着表记读法走，除非用户单独改过——助词「は」正是靠这条覆盖
  useEffect(() => {
    setPhonetic(phoneticOverride || derivePhonetic(saved || (unit?.kind === 'kana' ? unit.text : '')))
  }, [key, saved, phoneticOverride, unit])

  if (!unit) {
    return (
      <section className="kvm-ruby__box">
        <h4 className="kvm-ruby__boxtitle">{t('ruby.inspect.title')}</h4>
        <p className="kvm-ruby__muted">{t('ruby.inspect.hint')}</p>
      </section>
    )
  }

  const annotatable = canAnnotate(unit)
  const validation = validateKana(draft)
  const moras = draft && validation.ok ? splitMora(draft) : []
  const candidates = readingCandidates(units, unit, draft)
  const pieces = draft && validation.ok ? alignReading(unit.text, draft) : null
  // 只切出「整段还是它自己」时按不可拆处理：那一下点下去什么也不会变
  const wholeLen = toCodePoints(unit.text).length
  const canSplit =
    !!pieces &&
    pieces.length > 0 &&
    !(pieces.length === 1 && pieces[0].end - pieces[0].start === wholeLen)
  const locked = unit.span?.locked ?? false

  const apply = () => {
    if (!annotatable) return
    onApplyReading(unit, normalizeKana(draft))
  }

  return (
    <section className="kvm-ruby__box">
      <h4 className="kvm-ruby__boxtitle">{t('ruby.inspect.title')}</h4>

      <div className="kvm-ruby__word">
        <span className="kvm-ruby__wordtext">{unit.text}</span>
        {/* 纯假名本来就不该有注音，这里不挂徽章；缺注音的汉字才要红牌提醒 */}
        {(unit.span || unit.missing) && (
          <span className="kvm-ruby__chip" data-src={unit.span ? unit.src : 'none'}>
            {t(SOURCE_LABEL_KEY[unit.span ? unit.src : 'none'])}
          </span>
        )}
      </div>

      {/* 表记读法：渲染进注音行的形态，落库到 RubySpan.text */}
      <label className="kvm-ruby__field">
        <span className="kvm-ruby__label">{t('ruby.field.display')}</span>
        <input
          type="text"
          value={draft}
          disabled={!annotatable || busy}
          placeholder={annotatable ? t('ruby.field.displayPlaceholder') : t('ruby.field.kanaOnly')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply()
          }}
        />
      </label>

      {draft && !validation.ok && <p className="kvm-ruby__error">{validation.message}</p>}
      {moras.length > 0 && (
        <p className="kvm-ruby__meta">
          <span className="num">{t('ruby.mora', { n: moras.length })}</span>
          <span className="kvm-ruby__moras">{moras.join(' ')}</span>
        </p>
      )}

      <div className="kvm-ruby__row">
        <button type="button" className="primary" disabled={!annotatable || busy || !validation.ok} onClick={apply}>
          {t('ruby.action.apply')}
        </button>
        <button type="button" className="small" disabled={!draft || busy} onClick={() => setDraft(toHiragana(draft))}>
          {t('ruby.action.hiragana')}
        </button>
        <button type="button" className="small" disabled={!draft || busy} onClick={() => setDraft(toKatakana(draft))}>
          {t('ruby.action.katakana')}
        </button>
      </div>

      {/* 发音形：喂对齐器的形态。后端还没有这个字段，见 RubyModel 的说明 */}
      <label className="kvm-ruby__field">
        <span className="kvm-ruby__label">
          {t('ruby.field.phonetic')}
          <span className="kvm-ruby__badge" title={t('ruby.field.localHint')}>
            {t('ruby.field.local')}
          </span>
        </span>
        <input
          type="text"
          value={phonetic}
          disabled={busy}
          placeholder={t('ruby.field.derived')}
          onChange={(e) => setPhonetic(e.target.value)}
          onBlur={() => onPhonetic(unit, phonetic)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onPhonetic(unit, phonetic)
          }}
        />
      </label>

      {candidates.length > 0 && (
        <div className="kvm-ruby__cands">
          <span className="kvm-ruby__label">{t('ruby.candidates')}</span>
          <div className="kvm-ruby__chips">
            {candidates.map((c) => (
              <button key={c} type="button" className="kvm-ruby__cand" disabled={busy} onClick={() => setDraft(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="kvm-ruby__row">
        <button
          type="button"
          className="small"
          aria-pressed={locked}
          data-on={locked || undefined}
          disabled={!unit.span || busy}
          onClick={() => onToggleLock(unit)}
        >
          {locked ? <LockOutlined /> : <UnlockOutlined />} {t('ruby.lock')}
        </button>
        <button type="button" className="small" disabled={!canSplit || busy} onClick={() => onSplit(unit, draft)}>
          <ScissorOutlined /> {t('ruby.action.split')}
        </button>
        <button type="button" className="small" disabled={!unit.span || busy} onClick={() => onDelete(unit)}>
          <DeleteOutlined /> {t('ruby.action.delete')}
        </button>
      </div>
    </section>
  )
}

export interface RubyReviewListProps {
  items: RubyUnit[]
  activeKey: string | null
  onPick: (unit: RubyUnit) => void
}

/**
 * 待检查清单：把机器猜的读音和没注音的汉字聚到一处。
 *
 * 逐行翻找「哪几个是机器猜的」是这一步最费时间的部分——歌词渲染出来以后
 * 每条注音看起来同样自信，颜色只解决「看得见」，聚合才解决「过得完」。
 */
export function RubyReviewList({ items, activeKey, onPick }: RubyReviewListProps) {
  return (
    <section className="kvm-ruby__box kvm-ruby__box--grow">
      <h4 className="kvm-ruby__boxtitle">
        <WarningOutlined /> {t('ruby.review.title')}
        <span className="kvm-ruby__count num">{t('ruby.review.count', { n: items.length })}</span>
      </h4>

      {items.length === 0 ? (
        <p className="kvm-ruby__muted">{t('ruby.review.empty')}</p>
      ) : (
        <ul className="kvm-ruby__list">
          {items.map((u) => {
            const k = unitKey(u)
            return (
              <li key={k}>
                <button
                  type="button"
                  className="kvm-ruby__listitem"
                  data-active={k === activeKey || undefined}
                  onClick={() => onPick(u)}
                >
                  <span className="kvm-ruby__listbase">{u.text}</span>
                  <span className="kvm-ruby__listrt">{u.span?.text ?? ''}</span>
                  <span className="kvm-ruby__chip" data-src={u.missing ? 'none' : u.src}>
                    {t(u.missing ? 'ruby.src.missing' : SOURCE_LABEL_KEY[u.src])}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
