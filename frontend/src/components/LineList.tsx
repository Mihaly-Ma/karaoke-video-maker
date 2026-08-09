import { useProject } from '../state/projectStore'

/**
 * 歌词行列表，写全局选中行。
 *
 * 注音舞台需要它：RubyEditor 只编辑"当前选中行"，而选中行此前唯一的来源是
 * 时间轴——注音步骤里没有时间轴，没有这个列表整个舞台就是个死胡同。
 * 第二阶段把注音舞台改成整屏渲染歌词后，这里会被那份渲染取代。
 */
export default function LineList() {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const select = useProject((s) => s.select)

  if (!project) return null

  return (
    <div className="linelist">
      {project.lines.map((line, i) => (
        <button
          key={line.id}
          type="button"
          className={`linelist__item${selection.kind !== 'none' && selection.lineId === line.id ? ' linelist__item--active' : ''}`}
          onClick={() => select({ kind: 'line', lineId: line.id })}
        >
          <span className="linelist__no">{i + 1}</span>
          <span className="linelist__text">{line.tokens.map((t) => t.text).join('') || '（空行）'}</span>
        </button>
      ))}
    </div>
  )
}
