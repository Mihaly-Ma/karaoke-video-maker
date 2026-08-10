/** 「导出」舞台文案。export 是保留字，故变量名用 exportStage。 */
export const exportStage: Record<string, string> = {
  'export.settings': '设置',
  'export.artifacts': '产物',
  // 音轨二选一：与产物的 variant_label 用同一套词，列表里才对得上
  'export.track': '音轨',
  'export.trackOn': 'ON VOCAL',
  'export.trackOff': 'OFF VOCAL',
  'export.instrumentalMissing': '还没有伴奏轨，需要先完成人声分离',
  'export.withGuide': '混入引导声',
  'export.withGuideMissing': '还没有人声轨，需要先完成人声分离',
  'export.start': '导出',
  'export.running': '导出中',
  // 字形预检：只警告不阻断，所以第二句要给出可操作的下一步
  'export.glyphMissing': '字体缺 {n} 个字形：{chars}',
  'export.glyphHint': '在「样式」步骤更换字体',
  'export.empty': '还没有导出过',
  'export.excerpt': '片段',
  'export.download': '下载',
  // 产物的细节行：体积 · 时长 · 导出时间。变体名（ON/OFF VOCAL…）单独在上一行
  'export.meta': '{size} · {duration} · {time}',

  // ---- 最终预览 ----
  'export.preview': '最终预览',
  // 预览与成片的两处差异，用状态而非解释的口吻
  'export.previewProxy': '代理画面',
  // 引导声生成过就真能在预览里听到，所以这里只剩两种状态：已在预览中 / 还没生成。
  // 那句笼统的「预览不含引导声」已经不成立，撤掉了。
  'export.previewGuideOn': '含引导声',
  'export.previewGuideMissing': '预览无引导声',
  'export.previewGuideMissingHint': '在「素材」步骤生成引导声后可试听；导出时会自动合成',
  // 预览字体是子集化产物，字符集比系统原字体小：这些字只有预览缺，成片是好的
  'export.previewGlyphGap': '预览缺 {n} 字',
  'export.cues': '关键位置',
  'export.cuesEmpty': '还没有歌词',
  'export.cueCredits': '制作名单',
  // 同一张清单里曾经「第一句」「最长行」「末句」三种叫法混排，
  // 全部统一到「行」（见 align.ts 文件头）
  'export.cueFirst': '首行',
  'export.cueParagraph': '间奏后',
  'export.cueWidest': '最长行',
  'export.cueRuby': '注音最密',
  'export.cueEnd': '末行',
}
