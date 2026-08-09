/**
 * 「样式」舞台文案。由该舞台的实现者维护，其余舞台不要改本文件。
 *
 * 文案规则见 docs/ui-redesign.md「文案：短，且准确」：按钮用动词、状态用结果、
 * 解释性长句一律不进界面。参数为什么取这个值、比例从哪来，写在代码注释与文档里。
 */
export const style: Record<string, string> = {
  // 预览
  'style.preview.title': '成片预览',
  'style.preview.backdrop': '底色',
  'style.backdrop.black': '黑',
  'style.backdrop.green': '绿',
  'style.backdrop.white': '白',
  'style.preview.playLine': '播放这一句',
  'style.preview.scrub': '预览位置',
  'style.preview.loading': '字幕渲染器加载中',
  'style.preview.failed': '预览不可用：{detail}',
  'style.preview.noLines': '还没有歌词，先在「歌词」一步导入',

  // 分组
  'style.section.font': '字体',
  'style.section.layout': '排版',
  'style.section.timing': '时间',
  'style.section.countdown': '引导点',
  'style.section.palette': '声部配色',

  'style.recommend': '推荐值',
  'style.recommendNoVideo': '还没有画面尺寸',
  'style.saveFailed': '保存失败：{detail}',

  // 排版
  'style.field.fontSize': '字号',
  'style.field.bold': '粗体',
  'style.field.outline': '描边',
  'style.field.shadow': '阴影',
  'style.field.rubyScale': '注音缩放',
  'style.field.rubyGap': '注音间距',
  'style.field.marginV': '底部边距',
  'style.field.marginH': '左右边距',
  'style.field.lineGap': '行间距',
  'style.field.stagger': '上下行错开',
  'style.field.staggerHint': '上行贴左，下行贴右',

  // 时间
  'style.field.leadIn': '提前入场',
  'style.field.maxLead': '最大提前量',
  'style.field.leadOut': '唱完停留',
  'style.field.paragraphGap': '间奏阈值',
  'style.field.slotGap': '同槽位间隔',

  // 引导点
  'style.field.dots': '点数',
  'style.field.beat': '点间隔',
  'style.field.minGap': '触发空档',
  'style.field.dotsHint': '从右往左依次熄灭，只在首句与间奏后出现',
  'style.unit.dots': '个',

  // 偏离推荐值的提醒
  'style.warn.fontSize': '占画面高度 {pct}%，推荐 7.5%',
  'style.warn.outline': '占字号 {pct}%，推荐 5.5%',
  'style.warn.maxLead': '提前量偏长，一句会孤零零挂很久',

  // 字体
  'style.font.scanning': '正在扫描系统字体',
  'style.font.unavailable': '本机不可用',
  'style.font.candidates': '本机没有：{list}',
  'style.font.cjkOnly': '含日文字形的字体',
  'style.font.all': '全部字体',
  'style.font.showAll': '显示全部',
  'style.font.noCjk': '不含日文字形',
  'style.font.empty': '没有匹配的字体',
  'style.font.current': '当前：{family}（不在上面的列表里）',
  'style.font.loadFailed': '取字体信息失败：{detail}',

  // 字形覆盖预检。齐全时也要说一句——预检默默通过与预检没跑长得一模一样
  'style.font.covChecking': '正在检查字形',
  'style.font.covOk': '字形齐全 · 已查 {n} 字',
  'style.font.covMissing': '缺 {n} 个字形：{chars}',
  // 只有预览缺、成片是好的，所以说"预览缺"而不是"缺字"
  'style.font.covPreviewGap': '预览缺 {n} 字，成片不缺：{chars}',
  'style.font.covFailed': '字形检查未完成：{detail}',

  // 配色
  'style.palette.unsungFill': '未唱填充',
  'style.palette.unsungOutline': '未唱描边',
  'style.palette.sungFill': '已唱填充',
  'style.palette.sungOutline': '已唱描边',
  'style.palette.editing': '正在改「{part}」',
  'style.palette.inherited': '「{part}」还没有自己的配色，当前沿用上一级；改动即为它单独设置',
}
