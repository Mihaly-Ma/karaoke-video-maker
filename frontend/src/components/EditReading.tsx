/**
 * 注音编辑条 —— 贴在歌词正文下方。
 *
 * ## 为什么从舞台底栏搬上来
 *
 * 它此前挂在整个舞台的最底部，与时间栏并排。那个位置离歌词正文隔着**整条时间轴**
 * （波形 + 逐字轴，占了半屏）：在正文里点一个词，眼睛要跨过半个屏幕去底栏改读音，
 * 改完再抬回来找下一个词。而"检查 163 处注音"正是这一步最长的一段活，
 * 每处都要走一趟这条来回。
 *
 * 判据与 `EditVoice` 是同一条：**控件跟操作对象待在一起**。注音的操作对象是
 * 正文里的词，时间的操作对象是逐字轴上的字——所以读音上来、时间留在底栏
 * （那儿正好在逐字轴下方，见 `EditInspector`）。
 *
 * 两半分开并不会让"同一个词的时间与读音"散架：它们读的是 store 里**同一个
 * `selection`**，点哪个词，两处一起跟过去。物理相邻从来不是那条设计的要求，
 * 共享选中项才是。
 */

import type { RubyEditing } from './RubyEditor'
import { RubyInspector } from './RubyInspector'

export interface EditReadingProps {
  editing: RubyEditing
}

export default function EditReading({ editing }: EditReadingProps) {
  const {
    selectedUnit,
    lineUnits,
    busy,
    phoneticOf,
    applyReading,
    split,
    remove,
    toggleLock,
    setPhonetic,
  } = editing

  return (
    <div className="edit-reading" data-role="reading">
      <RubyInspector
        unit={selectedUnit}
        units={lineUnits}
        busy={busy}
        layout="bar"
        phoneticOverride={selectedUnit ? phoneticOf(selectedUnit) : ''}
        onApplyReading={applyReading}
        onSplit={split}
        onDelete={remove}
        onToggleLock={toggleLock}
        onPhonetic={setPhonetic}
      />
    </div>
  )
}
