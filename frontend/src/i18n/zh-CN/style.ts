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
  'style.preview.playLine': '播放本行',
  'style.preview.scrub': '预览位置',
  // 与 media.player.overlayLoading 用同一句：同一个渲染器在两个舞台上
  // 曾经一处带省略号、一处不带，看起来像两件不同的事
  'style.preview.loading': '字幕渲染器加载中…',
  'style.preview.failed': '预览不可用：{detail}',
  'style.preview.noLines': '还没有歌词 · 在「歌词」步骤导入',

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
  'style.field.dotsHint': '从右往左依次熄灭，只在首行与间奏后出现',
  'style.unit.dots': '个',

  // 偏离推荐值的提醒
  'style.warn.fontSize': '占画面高度 {pct}%，推荐 7.5%',
  'style.warn.outline': '占字号 {pct}%，推荐 5.5%',
  'style.warn.maxLead': '提前量偏长，单行在屏时间过久',

  // 字体
  'style.font.scanning': '正在扫描系统字体',
  'style.font.unavailable': '本机不可用',
  'style.font.candidates': '本机没有：{list}',
  'style.font.cjkOnly': '只看含日文字形的',
  'style.font.noCjk': '不含日文字形',
  'style.font.empty': '没有匹配的字体',
  'style.font.loadFailed': '读取字体信息失败：{detail}',

  // 字体链。"兜底"比"回退"直白：用户要理解的是"前面那个没有这个字时用它"
  'style.font.primary': '主字体',
  'style.font.fallbackN': '兜底 {n}',
  'style.font.chainHint': '主字体缺失的字形，按顺序由下列字体补足',
  'style.font.moveUp': '上移',
  'style.font.moveDown': '下移',
  'style.font.remove': '移出',
  'style.font.share': '{n} 字',
  // 承担 0 字要说出来：那说明这一环当前没起作用，用户才好判断留不留
  'style.font.shareNone': '当前用不到',
  'style.font.setPrimary': '设为主字体',
  'style.font.addFallback': '加为兜底',
  'style.font.inChain': '已在链里',

  // 搜索与筛选
  'style.font.searchHint': '搜索字体名，支持中英日',
  'style.font.more': '另有 {n} 项 · 继续输入以缩小范围',
  // 与"还没扫完"分开说：一个是再等等，一个是换个词
  'style.font.noMatch': '没有匹配「{q}」的字体',

  // 字形覆盖预检。齐全时也要说一句——预检默默通过与预检没跑长得一模一样
  'style.font.covChecking': '正在检查字形',
  'style.font.covOk': '字形齐全 · 已查 {n} 字',
  'style.font.covMissing': '整条字体链缺 {n} 个字形：{chars}',
  'style.font.covFailed': '字形检查未完成：{detail}',

  // 配色
  'style.palette.unsungFill': '未唱填充',
  'style.palette.unsungOutline': '未唱描边',
  'style.palette.sungFill': '已唱填充',
  'style.palette.sungOutline': '已唱描边',
  'style.palette.editing': '正在改「{part}」',
  'style.palette.inherited': '「{part}」沿用上一级配色，修改后成为它的独立配色',

  // 配色方案：一组四色，点一下写给当前声部
  'style.scheme.applyTo': '方案 · 点击应用到「{part}」',
  'style.scheme.loadFailed': '方案列表读取失败，手工调色不受影响',
  'style.scheme.rename': '改名',
  'style.scheme.remove': '删除方案',
  'style.scheme.renameLabel': '方案名',
  // 按钮用动词，不用「确定」（docs/ui-redesign.md §六）
  'style.scheme.renameOk': '保存',
  'style.scheme.renameCancel': '取消',
  // 自动存出的自定义方案：名字要一眼看出它从哪来
  'style.scheme.derivedName': '{from} 改',
  'style.scheme.defaultName': '自定义配色',
  'style.scheme.derivedDesc': '由「{from}」改出',
  'style.scheme.customDesc': '在「样式」步骤手工调出',
}
