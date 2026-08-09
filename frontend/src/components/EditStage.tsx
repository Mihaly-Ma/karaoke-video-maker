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
 * 上半区因此只剩**两栏**：左边窄栏（画面 + 走带 + 待检查清单），右边全部给歌词正文。
 * 曾经夹在中间的那条 208px「整体偏移」栏已经拆掉——它只装着一张 112px 的小卡片，
 * 另外 272px 是空的，却让 1024px 窗口下的歌词正文只剩 428px。
 * 偏移搬进了时间轴工具条（见 `EditOffset` 的文件头）。
 *
 * ## 高度链（docs/ui-redesign.md §七点五）
 *
 * 本舞台有三个独立滚动区：待检查清单、歌词正文、时间轴。纵向 flex 子项的
 * `min-height` 默认是 `auto`，装着长内容会把自己撑开，内部写了 `overflow-y:auto`
 * 的元素就永远成不了滚动容器 —— 所以链路上每一层都显式写了 `min-height: 0`，
 * 见 styles.css 的 `.edit-*`。
 *
 * 清单换了容器就等于换了一条高度链，**同一个组件在旧容器里能滚不代表在新的里也能**
 * （§七点五 明说"每个形态都要单独验证"）。`scripts/verify-edit-layout.mjs` 会往清单里
 * 塞满条目，断言滚动条落在清单自己身上、左栏没被撑高。
 */

import { useEffect, useState } from 'react'

import { useProject } from '../state/projectStore'
import EditInspector from './EditInspector'
import EditVoice from './EditVoice'
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
/** 上半区里「画面 / 歌词正文」的左右分割，同样是屏幕偏好而非工程数据 */
const SIDE_SPLIT_KEY = 'kvm.split.edit.side'

/**
 * 上下各占一半。
 *
 * 上半区是"给多少用多少"——歌词正文多一行就多看一行；下半区现在**也是**：
 * 波形高度已经改成吃掉时间轴剩余空间（见 Timeline 的 `waveH`），
 * 所以把分割条往上拖，波形会跟着长高，而不是在下面留一片空白。
 */
const SPLIT_DEFAULT = 0.5

/**
 * 画面栏占上半区的两成。这不是"看着差不多"：走带控件条第一排实测要 312px
 * 才不折行，1600px 宽下 0.21 正好落在 340px 附近，再窄就要赔高度。
 * 拖不动的下限由 StageSplit 的 `minTopPx` 兜住。
 */
const SIDE_SPLIT_DEFAULT = 0.21

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
          /*
            上半区再横着分一次：左边画面、右边歌词正文，**中间的分割条可拖**。
            画面栏原先是写死的 340px —— 一个人想多看几行歌词、另一个想把画面放大
            核对观感，写死就只能二选一，而这两件事本来就该由用户当场决定。
            上下、左右用的是同一个 `StageSplit`（见其文件头）。
          */
          <StageSplit
            storageKey={SIDE_SPLIT_KEY}
            direction="horizontal"
            defaultTop={SIDE_SPLIT_DEFAULT}
            /* 走带第一排 312px 是硬需求，拖到比它窄只会让走带折行变高 */
            minTopPx={320}
            minBottomPx={240}
            topClassName="edit-side"
            bottomClassName="edit-lyrics"
            top={
              <>
                {/*
                  给 Preview 传 className 是为了从**容器侧**约束它——它是全应用唯一的
                  播放时钟，不能改，而它内部把 16:9 画面块、走带控件条、问题提示堆在
                  一列里。样式见 styles.css 的 .edit-preview。

                  **清单从右侧独立栏搬到了这里。** 左栏装的是 191px 的画面 + 67px 的
                  走带，此下常年空着 125px；而清单开在右边时又要从歌词正文身上再切走
                  236px。把空的填上、把切走的还回去，是同一步改动的两面。
                */}
                <Preview className="edit-preview" />

                {/* 清单默认收着，开关在正文顶栏（数量本身就是"还剩多少活"的指标） */}
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
            bottom={
              <>
                <RubyPaper
                  editing={editing}
                  reviewOpen={reviewOpen}
                  onToggleReview={() => setReviewOpen((v) => !v)}
                />
                {/*
                  声部指派贴在正文下方，而不是底栏检查器里：声部是行/token 的属性，
                  而"选中哪一行、哪个字"这个动作就发生在上面这块正文里。
                  见 EditVoice 的文件头。
                */}
                <EditVoice />
              </>
            }
          />
        }
        bottom={<Timeline />}
      />

      <EditInspector editing={editing} />
    </main>
  )
}
