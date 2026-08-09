/** 「导出」舞台文案。export 是保留字，故变量名用 exportStage。 */
export const exportStage: Record<string, string> = {
  'export.settings': '设置',
  'export.artifacts': '产物',
  // 音轨二选一：与产物的 variant_label 用同一套词，列表里才对得上
  'export.track': '音轨',
  'export.trackOn': 'ON VOCAL',
  'export.trackOff': 'OFF VOCAL',
  'export.instrumentalMissing': '工程还没有伴奏轨，先做人声分离',
  'export.withGuide': '混入引导声',
  'export.withGuideMissing': '工程还没有人声轨，先做人声分离',
  'export.start': '导出',
  'export.running': '导出中',
  'export.empty': '还没有导出过',
  'export.excerpt': '片段',
  'export.download': '下载',
  // 产物的细节行：体积 · 时长 · 导出时间。变体名（ON/OFF VOCAL…）单独在上一行
  'export.meta': '{size} · {duration} · {time}',

  // ---- 最终预览 ----
  'export.preview': '最终预览',
  // 预览与成片的两处差异，用状态而非解释的口吻
  'export.previewProxy': '代理画面',
  'export.previewNoGuide': '预览不含引导声',
  'export.cues': '关键位置',
  'export.cuesEmpty': '还没有歌词',
  'export.cueCredits': '制作名单',
  'export.cueFirst': '第一句',
  'export.cueParagraph': '间奏后',
  'export.cueWidest': '最长行',
  'export.cueRuby': '注音最密',
  'export.cueEnd': '末句',
}
