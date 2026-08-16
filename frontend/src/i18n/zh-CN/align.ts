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
 *
 * **歌词的基本单位在全应用统一叫「行」，不叫「句」。** 数据模型是 `Line`，
 * 主要动作是「拆行」「合并行」，行数统计也是「{n} 行」；本文件曾在句柄条与
 * 声部面板里改口叫「句」，于是同一个东西在同屏的两个控件上有两个名字。
 */
export const align: Record<string, string> = {
  // ---- 工具条 ----
  'align.tap': '手工打轴',
  'align.tapOn': '打轴中',
  'align.tapEnter': '逐字打点（T）',
  'align.tapExit': '退出并提交（Esc）',
  'align.untimed': '未打轴 {n}/{total} 字',
  'align.rate': '速率',
  'align.rateHint': '变速会同时改变音高',
  'align.follow': '跟随',
  // 一个开关同时管波形与歌词正文，所以文案要把两处都说出来
  'align.followHint': '播放时波形与歌词跟着播放头滚',
  'align.split': '拆行',
  'align.splitHint': '在选中的字之前拆成两行',
  'align.merge': '合并行',
  'align.mergeHint': '与下一行合并',
  'align.link': '边界联动',
  'align.linkHint': '拖边界时连带改相邻的字，保持首尾相接',
  // 原「试听 伴奏/原声」下拉框已删：预览层的走带上本来就有同一组按钮，
  // 改的还是 store 里同一个 audioMode。文案随控件一起去掉，不留孤儿键。
  // 波形画哪条轨，与走带上"听哪条轨"是两个独立的选择
  'align.waveSrc': '波形',
  'align.waveSrcHint': '只改画出来的曲线，不改试听的音轨',
  'align.waveSrc.audio': '原曲',
  'align.waveSrc.instrumental': '伴奏',
  'align.waveSrc.vocals': '人声',
  'align.waveSrcMissing': '这条轨还没分离出来',
  'align.zoomIn': '放大',
  'align.zoomOut': '缩小',
  'align.fit': '整曲',
  'align.fitHint': '缩到整曲铺满',

  // ---- 分割条 ----
  'align.paneDivider': '歌词与波形分割条',
  'align.sideDivider': '画面与歌词分割条',
  'align.paneDividerHint': '拖动调整比例，双击复位',

  // ---- 逐字轴（这一步真正要编辑的东西，所以它是主角）----
  'align.tokenRail': '逐字轴',
  'align.tokenRailHint': '块宽 = 该字时长，拖块平移、拖两侧改边界',
  'align.railEmpty': '选中歌词或逐字轴里的字',
  'align.gap': '空隙 {ms}ms',
  // 句柄条与概览条上**只出现行号**，不出现歌词文本：文本在右侧正文里已经整屏摆着
  'align.lineHandleHint': '第 {no} 行・拖动整行平移',
  'align.overviewLine': '第 {no} 行・{start}',

  // ---- 检查器的时间栏 ----
  'align.time': '时间',
  'align.start': '起点',
  'align.dur': '时长',
  'align.shift': '平移',
  'align.lockTiming': '锁定时间',
  'align.selectHint': '选中歌词或逐字轴里的字',

  // ---- 声部指派（§2.5 表格里声部那一行的自动栏写的是"暂无可靠自动方案"，
  //      手工旁路"选中词句指派声部"因此不是锦上添花，是这一环唯一的入口）----
  'align.voice': '声部',
  // 范围是算出来的：没划就是当前行，在正文里划过一段就是那一段
  'align.voiceRangeLine': '本行',
  'align.voiceRangeSel': '划选 {n} 行',
  'align.voiceTo': '改为',
  'align.voiceToEnd': '到曲末',
  'align.voiceAffectLines': '将改 {n} 行',
  'align.voiceAffectTokens': '将改 {n} 字',
  'align.voiceNew': '新声部',
  'align.voiceNewPlaceholder': '新声部名，回车指派',
  'align.voiceClear': '清除字级',
  // 默认声部也能改名：声部名是给人看的标签（「男」「女」「合」比 duet_a 好读得多）
  'align.voiceRename': '改名',
  'align.voiceRenameHint': '点击给「{part}」改名（全曲一起改）',
  // 删除 = 归并：一行总得有个声部，所以要说清并到哪儿去
  'align.voiceDelete': '删除声部',
  'align.voiceDeleteHint': '删除「{part}」，它的行并入「{to}」',
  'align.voiceDeleteLast': '仅剩一个声部，无法删除',
  'align.voiceDone': '已将 {n} 处改为 {part}',

  // ---- 整曲偏移（三级调轴的「整体」级）----
  // 叫「整曲」而不是「整体」：底栏检查器上有一组作用于**单个字**的「平移」，
  // 两者都是 ±ms 按钮，标签是它们唯一能靠文字讲清的差别，必须说出作用范围
  'align.offset': '整曲偏移',
  'align.offsetHint': '整首歌一起平移，不动逐字时间',
  'align.reset': '归零',

  // ---- 打轴面板 ----
  'align.tapKeys': '空格 打点 ・ Shift+空格 结束本行 ・ 退格 回退',
  'align.tapCount': '已打 {n} 字',
  'align.tapProgress': '{pos}/{total}',
  'align.tapBack': '回退',
  'align.tapCommit': '提交',
  'align.tapEnd': '已到最后一个字，Esc 退出并提交',
  'align.tapNextLine': '下一行：{text}',
  'align.tapNoAudio': '音频未就绪，打点时间不准',
  'align.committing': '提交中 {done}/{total}',

  // ---- 波形状态 ----
  'align.waveLoading': '波形加载中 {percent}%',
  'align.waveError': '{message}，仍可调轴',
  'align.waveNone': '尚未导入音频',
  'align.waveLoadFailed': '音频加载失败',
  'align.waveLoadFailedDetail': '音频加载失败：{detail}',

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
  // 「后端出错」是内部分工，用户既看不见后端也管不着它
  'align.backendError': '操作失败：{message}',

  // ---- 拖动时的数值气泡 ----
  'align.dragLine': '整行平移 {delta} ・ 起点 {start}',
  'align.dragToken': '{text} {delta} ・ 起点 {start} ・ 时长 {dur}ms',
}
