/**
 * 「编辑」舞台 —— 对轴与注音合并成的一步（docs/ui-redesign.md §四）。
 *
 * ## 一个选中项驱动全部
 *
 * 三块面板读写 store 里的**同一个 `selection`**，不各存一份"当前选中"：
 *
 * ```
 * 歌词正文点词  ──┐                        ┌──> 逐字轴高亮同一个字
 *                 ├──> selection (token) ──┤
 * 逐字轴点字    ──┘                        ├──> 正文高亮覆盖它的那个词
 *                                          └──> 底栏检查器给出它的时间与读音
 * ```
 *
 * ## 版面比例是按"要改什么"排的，不是按"什么好看"
 *
 * 优先级：**逐字轴 > 波形 > 歌词正文 > 视频**。视频只用于随时确认观感，
 * 所以它小、靠左、固定宽度；实际工作发生在下半区的波形与逐字轴上。
 * 上一版把画面放到 626×352 居中、两侧留空黑，逐字轴反而被压成波形底下的一条边——
 * 那是把"这一步在看什么"排反了。
 *
 * ## 高度链（docs/ui-redesign.md §七点五）
 *
 * 本舞台有三个独立滚动区：左栏（画面 + 偏移，窗口矮时可滚）、歌词正文、
 * 时间轴。纵向 flex 子项的 `min-height` 默认是 `auto`，装着长内容会把自己撑开，
 * 内部写了 `overflow-y:auto` 的元素就永远成不了滚动容器 ——
 * 所以链路上每一层都显式写了 `min-height: 0`，见 styles.css 的 `.edit-*`。
 */

import { useEffect, useState } from 'react'

import { useProject } from '../state/projectStore'
import EditInspector from './EditInspector'
import EditOffset from './EditOffset'
import Preview from './Preview'
import { RubyPaper, RubyStyles, useRubyEditing } from './RubyEditor'
import { RubyReviewList } from './RubyInspector'
import StageSplit from './StageSplit'
import Timeline from './Timeline'

/**
 * 上下分割位置。**全工程共用一个键**，不按工程分：它是"我这块屏幕上画面留多高"
 * 的偏好，跟在编哪首歌无关。键名带 `edit` 而不是沿用旧的 `align`——
 * 版面已经完全换了，旧比例套过来不再有意义。
 */
const SPLIT_KEY = 'kvm.split.edit'

/**
 * 上下各占一半。
 *
 * 下半区的高度需求是**定死的**：工具条 + 刻度 22 + 波形 150 + 逐字轴 78 + 概览 26 +
 * 图例 ≈ 370px，再多给也只是一片空白（时间轴按固定几何排版，不会自己长高）。
 * 上半区则是"给多少用多少"——歌词正文多一行就多看一行。
 *
 * 所以不再照搬旧对轴舞台"波形占更大比例"的 0.42：那时上半区只有画面，
 * 现在上半区还装着歌词正文，它同样是这一步的工作对象。
 */
const SPLIT_DEFAULT = 0.5

export default function EditStage() {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const select = useProject((s) => s.select)

  const editing = useRubyEditing()
  const [reviewOpen, setReviewOpen] = useState(false)

  /**
   * 进来时自动选中第一条正文行。
   *
   * 逐字轴与检查器都以"选中项"为输入，不自动选的话这一步打开就是两块空面板，
   * 用户还得先猜到要去歌词里点一下。跳过制作名单行（「词：xxx」这类），
   * 它们既不需要注音、也不该是第一个被调轴的对象。
   */
  useEffect(() => {
    if (selection.kind !== 'none' || !project) return
    const first = project.lines.find((l) => !l.is_metadata && l.tokens.length > 0)
    // 直接选到**首字**而不是整行：选中项是 token 级的，三处（逐字轴高亮、
    // 正文高亮、检查器的时间与读音）才从第一眼起就说的是同一个东西
    if (first) select({ kind: 'token', lineId: first.id, tokenIndex: 0 })
  }, [project, selection.kind, select])

  return (
    <main className="stage stage--edit">
      <RubyStyles />

      <StageSplit
        storageKey={SPLIT_KEY}
        defaultTop={SPLIT_DEFAULT}
        topClassName="edit-top"
        bottomClassName="edit-rail"
        top={
          <>
            {/*
              画面固定窄栏。给 Preview 传 className 是为了从**容器侧**约束它——
              它是全应用唯一的播放时钟，不能改，而它内部把 16:9 画面块、走带控件条、
              问题提示堆在一列里。样式见 styles.css 的 .edit-preview。
            */}
            <div className="edit-video">
              <Preview className="edit-preview" />
            </div>

            {/*
              整体偏移并排在画面右侧，而不是压在时间轴上占一整条横带：
              它是全曲改一次的旋钮，挤掉的却是每个字都要动的逐字轴。
            */}
            <div className="edit-tools">
              <EditOffset />
            </div>

            <div className="edit-lyrics">
              <RubyPaper
                editing={editing}
                reviewOpen={reviewOpen}
                onToggleReview={() => setReviewOpen((v) => !v)}
              />
            </div>

            {/* 待检查清单默认收着：它吃横向空间，而正文才是主对象 */}
            {reviewOpen && (
              <aside className="edit-review">
                <RubyReviewList
                  items={editing.review}
                  activeKey={editing.selectedKey}
                  onPick={(u) => editing.pick(u, false)}
                />
              </aside>
            )}
          </>
        }
        bottom={<Timeline />}
      />

      <EditInspector editing={editing} />
    </main>
  )
}
