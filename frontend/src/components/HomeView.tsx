import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useState } from 'react'

import * as api from '../api/client'
import type { Project, ProjectSummary } from '../api/types'
import { t } from '../i18n'
import { STEP_LABEL, STEP_ORDER, stepStatus } from '../workflow'

/**
 * 首页：新建工程 + 浏览既有工程。
 *
 * 工程不是从某一步开始的，是从"打开哪个工程"开始的（docs/ui-redesign.md §三点五），
 * 所以应用启动落在这里，而不是直接钻进上次的步骤。
 */

interface HomeViewProps {
  /** 打开既有工程；新建成功后也走这里，由 App 统一负责加载与跳转 */
  onOpen: (id: string) => void
}

export default function HomeView({ onOpen }: HomeViewProps) {
  const [list, setList] = useState<ProjectSummary[]>([])
  /**
   * 六段进度需要 audio_path / ruby / timing_source 这些字段，而
   * `GET /api/projects` 的摘要里只有 title/artist/updated_at/duration/line_count。
   * 只能列表到手后再逐个取详情——工程数量是个位数量级，这个 N+1 可以接受；
   * 真要去掉它得后端在摘要里补上各步骤的完成标记。
   */
  const [details, setDetails] = useState<Record<string, Project>>({})
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setList(await api.listProjects())
      setError(null)
    } catch (e) {
      setError(t('home.loadFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const pairs = await Promise.all(
        list.map(async (s) => [s.id, await api.getProject(s.id).catch(() => null)] as const),
      )
      if (cancelled) return
      const next: Record<string, Project> = {}
      for (const [id, p] of pairs) if (p) next[id] = p
      setDetails(next)
    })()
    return () => {
      cancelled = true
    }
  }, [list])

  const create = async () => {
    setBusy(true)
    try {
      const p = await api.createProject(title.trim(), artist.trim())
      onOpen(p.id)
    } catch (e) {
      setError(t('home.createFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (s: ProjectSummary) => {
    if (!window.confirm(t('home.confirmDelete', { title: s.title || t('common.untitled') }))) return
    try {
      await api.deleteProject(s.id)
      await reload()
    } catch (e) {
      setError(t('home.deleteFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <div className="home">
      <div className="home__inner">
        <div className="home__head">
          {/* 紧邻的标题已经写着应用名，图标在这里是装饰性的，alt 留空才不会被读屏重复播报 */}
          <img className="home__logo" src="/icon.png" width={36} height={36} alt="" />
          <h1 className="home__title">{t('home.appTitle')}</h1>
          <span className="home__count">{t('home.count', { n: list.length })}</span>
        </div>

        {error && <p className="error">{error}</p>}

        {creating ? (
          <div className="card newform" style={{ maxWidth: 420 }}>
            <div className="newform__row">
              <input
                autoFocus
                placeholder={t('home.fieldTitle')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <input
                placeholder={t('home.fieldArtist')}
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
              />
            </div>
            <div className="newform__row">
              <button type="button" className="primary" disabled={busy} onClick={() => void create()}>
                {t('home.create')}
              </button>
              <button type="button" className="ghost" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : null}

        <div className="home__grid">
          {!creating && (
            <button type="button" className="pcard pcard--new" onClick={() => setCreating(true)}>
              <span className="step__icon">
                <PlusOutlined />
              </span>
              {t('home.newProject')}
            </button>
          )}

          {list.map((s) => {
            const status = stepStatus(details[s.id] ?? null)
            return (
              // 卡片整体可点，但删除按钮嵌在里面——button 套 button 是非法 HTML，
              // 所以外层用 div + role=button，并自己补上键盘可达性。
              <div
                key={s.id}
                className="pcard"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(s.id)
                  }
                }}
              >
                <button
                  type="button"
                  className="iconbtn pcard__del"
                  title={t('home.delete')}
                  aria-label={t('home.delete')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(s)
                  }}
                >
                  <DeleteOutlined />
                </button>

                <div>
                  <div className="pcard__title">{s.title || t('common.untitled')}</div>
                  <div className="pcard__artist">{s.artist || '—'}</div>
                </div>

                <div className="pcard__steps" aria-label={t('home.progress')}>
                  {STEP_ORDER.map((k) => (
                    <span
                      key={k}
                      className={`pcard__seg${status[k].done ? ' pcard__seg--done' : ''}`}
                      title={`${STEP_LABEL[k]}${status[k].done ? ` ${t('common.done')}` : ''}`}
                    />
                  ))}
                </div>

                <div className="pcard__meta">
                  <span>{formatDuration(s.duration_ms)}</span>
                  <span>{t('topbar.lineCount', { n: s.line_count })}</span>
                  <span>{formatWhen(s.updated_at)}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (!ms) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

/** 后端给的是 Unix 秒（浮点）。近处用相对时间，远处用日期——相对时间超过几天就没信息量了。 */
function formatWhen(sec: number): string {
  if (!sec) return '—'
  const d = new Date(sec * 1000)
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000)
  if (diffMin < 1) return t('home.justNow')
  if (diffMin < 60) return t('home.minutesAgo', { n: diffMin })
  if (diffMin < 60 * 24) return t('home.hoursAgo', { n: Math.floor(diffMin / 60) })
  if (diffMin < 60 * 24 * 7) return t('home.daysAgo', { n: Math.floor(diffMin / (60 * 24)) })
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}
