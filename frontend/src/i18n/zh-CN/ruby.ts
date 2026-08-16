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
  // 同屏还有一条「时间来源」图例（时间轴底部），只写「来源」两条会互相冒充
  'ruby.legend': '读音来源',
  'ruby.src.dict': '词典',
  'ruby.src.guess': '推断',
  'ruby.src.missing': '缺注音',
  'ruby.metadata': '制作名单',
  // 制作名单行默认不进正文，这个开关是它们唯一的出口，所以要带上数量
  'ruby.metadata.toggle': '制作名单 {n} 行',

  // 辅助栏
  'ruby.inspect.title': '选中词',
  'ruby.inspect.hint': '选中歌词或逐字轴里的字',
  'ruby.reading': '读音',
  'ruby.field.display': '表记读法',
  'ruby.field.phonetic': '发音形',
  'ruby.field.displayPlaceholder': '假名读音',
  'ruby.field.kanaOnly': '假名不注音',
  'ruby.field.derived': '推导值',
  // 徽章上就这两个字。这份值只存在本机、不随工程走，来龙去脉在 RubyModel 里，
  // 界面上不解释——那是注释该干的事
  'ruby.field.local': '本地',
  'ruby.mora': '{n} 拍',
  'ruby.candidates': '候选',
  // 底栏并排着两把锁（时间 / 读音），只写「锁定」的那把等于没说锁的是什么
  'ruby.lock': '锁定读音',

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
  'ruby.lineText.label': '本行歌词',
  'ruby.lineText.placeholder': '本行歌词',
  'ruby.lineText.save': '保存',
  // 回执说的是后果，不是"已保存"：推算出来的时间要复核，逐字轴上是插值色
  'ruby.lineText.done': '已改写：{kept} 字保留原时间，{guessed} 字待复核',
  'ruby.lineText.orphaned': '，{n} 项进了失效修正',

  // 读音输入校验。说清**哪几个字符不合法**，而不是笼统地说格式不对
  'ruby.invalid.empty': '读音不能为空',
  'ruby.invalid.kanji': '读音不能含汉字：{chars}',
  'ruby.invalid.latin': '读音不能含字母或数字：{chars}，请改写成片假名',
  'ruby.invalid.other': '含有非假名字符：{chars}',

  // 提示与报错
  'ruby.msg.splitFailed': '读音与该词不匹配，无法拆分',
  'ruby.msg.splitDone': '已拆成 {n} 段',
  'ruby.msg.noKanji': '纯假名，无需注音',
  'ruby.msg.saved': '已保存',
}
