/**
 * 「编辑」舞台里**与时间有关**的文案（时间轴、逐字轴、整体偏移、检查器的时间栏）。
 * 读音那一半在 `ruby.ts`，两份合起来才是这一个舞台。
 *
 * 键名保留 `align.` 前缀：对轴与注音是合并成一步，不是合并成一件事，
 * 按前缀仍能一眼看出这条文案说的是时间还是读音。
 *
 * 播放/暂停/撤销/重做/来源徽章走 `common.ts`，这里不重复定义 ——
 * 同一个动作在不同舞台必须是同一个词。
 *
 * 文案按 docs/ui-redesign.md「文案：短，且准确」收紧过一轮：原先界面上
 * 「自动轴精度约 50–150ms」「整体偏移只改这一个数，随时可以归零重来」这类
 * 讲原理的句子全部移出 —— 它们属于文档，不属于工具条。
 */
export const align: Record<string, string> = {
  // ---- 工具条 ----
  'align.tap': '手工打轴',
  'align.tapOn': '打轴中',
  'align.tapEnter': '逐字打点（T）',
  'align.tapExit': '退出并提交（Esc）',
  'align.untimed': '未打轴 {n}/{total} 字',
  'align.rate': '速率',
  'align.rateHint': '变速由预览层执行，会同时改变音高',
  'align.follow': '跟随',
  'align.followHint': '播放时跟随播放头滚动',
  'align.split': '拆行',
  'align.splitHint': '在选中的字之前拆成两行',
  'align.merge': '合并行',
  'align.mergeHint': '与下一行合并',
  'align.link': '边界联动',
  'align.linkHint': '拖边界时连带改相邻的字，保持首尾相接',
  'align.audio': '试听',
  'align.audioInstrumental': '伴奏',
  'align.audioOriginal': '原声',
  'align.zoomIn': '放大',
  'align.zoomOut': '缩小',
  'align.fit': '整曲',
  'align.fitHint': '缩到整曲铺满',

  // ---- 歌词 / 波形分割条 ----
  'align.paneDivider': '歌词与波形分割条',
  'align.paneDividerHint': '拖动调整高度，双击复位',

  // ---- 逐字轴（这一步真正要编辑的东西，所以它是主角）----
  'align.tokenRail': '逐字轴',
  'align.tokenRailHint': '块宽 = 该字时长，拖块平移、拖两侧改边界',
  'align.railEmpty': '点歌词里的字，或按播放键',
  'align.gap': '空隙 {ms}ms',

  // ---- 检查器的时间栏 ----
  'align.time': '时间',
  'align.start': '起点',
  'align.dur': '时长',
  'align.shift': '平移',
  'align.lockTiming': '锁定时间',
  'align.selectHint': '点歌词或逐字轴里的字',

  // ---- 整体偏移（三级调轴的「整体」级）----
  'align.offset': '整体偏移',
  'align.offsetHint': '只改这一个数，不动逐字时间',
  'align.reset': '归零',

  // ---- 打轴面板 ----
  'align.tapKeys': '空格 打点 ・ Shift+空格 结束句 ・ 退格 回退',
  'align.tapCount': '已打 {n} 字',
  'align.tapProgress': '{pos}/{total}',
  'align.tapBack': '回退',
  'align.tapCommit': '提交',
  'align.tapEnd': '已到最后一个字，Esc 退出并提交',
  'align.tapNextLine': '下一句：{text}',
  'align.tapNoAudio': '音频未就绪，打点时间不准',
  'align.committing': '提交中 {done}/{total}',

  // ---- 波形状态 ----
  'align.waveLoading': '波形加载中 {percent}%',
  'align.waveError': '{message}，仍可调轴',
  'align.waveNone': '尚未导入音频',

  // ---- 图例与状态 ----
  'align.sources': '时间来源',
  'align.sourceUnset': '未打轴',
  'align.hintUnset': '按 T 逐字打点',
  'align.hintProvider': '歌词源自带',
  'align.hintAligned': '强制对齐实测',
  'align.hintInterpolated': '插值推算，优先复核',
  'align.hintManual': '手工，重算不覆盖',
  'align.locked': '已锁定',
  'align.keys': '方向键 ±{step}ms ・ Shift 1 帧 ・ Alt ±{fine}ms ・ Ctrl/Cmd+滚轮 缩放',
  'align.noProject': '尚未打开工程',
  'align.backendError': '后端出错：{message}',

  // ---- 拖动时的数值气泡 ----
  'align.dragLine': '整句平移 {delta} ・ 起点 {start}',
  'align.dragToken': '{text} {delta} ・ 起点 {start} ・ 时长 {dur}ms',
}
