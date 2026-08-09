/**
 * 「编辑」舞台里**与读音有关**的文案（歌词正文、注音、待检查清单、检查器的读音栏）。
 * 时间那一半在 `align.ts`，两份合起来才是这一个舞台。
 */
export const ruby: Record<string, string> = {
  'ruby.empty.project': '还没有打开工程',
  'ruby.empty.lines': '这个工程还没有歌词',
  'ruby.empty.line': '这一行没有文字',
  'ruby.empty.allMetadata': '这些行全是制作名单',

  // 顶部统计与图例
  'ruby.stat.spans': '{n} 处注音',
  'ruby.stat.review': '{n} 处待检查',
  'ruby.stat.locked': '{n} 处已锁定',
  'ruby.legend': '来源',
  'ruby.src.dict': '词典',
  'ruby.src.guess': '推断',
  'ruby.src.missing': '缺注音',
  'ruby.metadata': '制作名单',
  // 制作名单行默认不进正文，这个开关是它们唯一的出口，所以要带上数量
  'ruby.metadata.toggle': '制作名单 {n} 行',

  // 辅助栏
  'ruby.inspect.title': '选中词',
  'ruby.inspect.hint': '点歌词或逐字轴里的字',
  'ruby.reading': '读音',
  'ruby.field.display': '表记读法',
  'ruby.field.phonetic': '发音形',
  'ruby.field.displayPlaceholder': '假名读音',
  'ruby.field.kanaOnly': '假名不注音',
  'ruby.field.derived': '推导值',
  'ruby.field.local': '本地',
  'ruby.field.localHint': '发音形暂存在本机，工程文件里还没有这个字段',
  'ruby.mora': '{n} 拍',
  'ruby.candidates': '候选',
  'ruby.lock': '锁定',

  // 动作
  'ruby.action.apply': '应用',
  'ruby.action.hiragana': '平假名',
  'ruby.action.katakana': '片假名',
  'ruby.action.split': '拆送り仮名',
  'ruby.action.delete': '删除注音',

  // 待检查
  'ruby.review.title': '待检查',
  'ruby.review.empty': '没有待检查的项',
  'ruby.review.count': '{n} 处',

  // 改写行文本（§2.5 的手工旁路：歌词本身也得能改）
  'ruby.lineText.edit': '改文字',
  'ruby.lineText.label': '这一行的歌词',
  'ruby.lineText.placeholder': '这一行的歌词',
  'ruby.lineText.save': '保存',
  // 回执说的是后果，不是"已保存"：推算出来的时间要复核，逐字轴上是插值色
  'ruby.lineText.done': '已改写：{kept} 字保留原时间，{guessed} 字待复核',
  'ruby.lineText.orphaned': '，{n} 项进了失效修正',

  // 提示与报错
  'ruby.msg.splitFailed': '读音与这个词对不上，无法拆分',
  'ruby.msg.splitDone': '已拆成 {n} 段',
  'ruby.msg.noKanji': '这个词是纯假名，不需要注音',
  'ruby.msg.saved': '已保存',
}
