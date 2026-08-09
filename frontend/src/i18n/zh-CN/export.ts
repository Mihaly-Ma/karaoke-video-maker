/** 「导出」舞台文案。export 是保留字，故变量名用 exportStage。 */
export const exportStage: Record<string, string> = {
  'export.settings': '设置',
  'export.artifacts': '产物',
  'export.instrumental': '伴奏音轨（OFF VOCAL）',
  'export.instrumentalMissing': '工程还没有伴奏轨，先做人声分离',
  'export.withGuide': '混入引导声',
  'export.withGuideMissing': '工程还没有人声轨，先做人声分离',
  'export.start': '导出',
  'export.running': '导出中',
  'export.empty': '还没有导出过',
  'export.excerpt': '片段',
  // 产物一行的元信息：体积 · 时长 · 生成时间
  'export.meta': '{size} · {duration} · {time}',
}
