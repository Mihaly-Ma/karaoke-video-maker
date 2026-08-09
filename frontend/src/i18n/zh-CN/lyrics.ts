/**
 * 「歌词」舞台文案。由该舞台的实现者维护，其余舞台不要改本文件。
 *
 * 文案规则见 docs/ui-redesign.md「文案：短，且准确」：按钮用动词、状态用结果、
 * 解释性长句一律不进界面。通用词（使用/取消/播放/来源徽章）在 common.ts，别在这里重复定义。
 */
export const lyrics: Record<string, string> = {
  // 搜索阶段拿不到歌词正文，粒度与有无注音都只有 fetch 之后才确定。
  // 「未知」必须与「没有」区分：画成没有会让用户排除掉其实有注音的候选。
  'lyrics.granUnknown': '粒度未知',
  'lyrics.rubyUnknown': '注音未知',
  // ---- 两个一等入口（CLAUDE.md §2.5：导入不是搜索失败后的回退）----
  'lyrics.tabSearch': '搜索',
  'lyrics.tabImport': '导入',

  // ---- 搜索 ----
  'lyrics.queryPlaceholder': '曲名 / 歌手',
  'lyrics.search': '搜索',
  'lyrics.searching': '搜索中',
  'lyrics.suggestQuery': '建议词',
  'lyrics.suggestQueryTitle': '用工程标题重新生成搜索词',
  'lyrics.emptyQuery': '输入搜索词',
  'lyrics.noCandidates': '没有结果。换个写法再搜，或改用导入。',
  'lyrics.beforeSearch': '搜索，或改用导入。',
  'lyrics.providerErrors': '{n} 个源没有结果',
  'lyrics.searchFailed': '搜索失败：{msg}',

  // ---- 候选与预览 ----
  'lyrics.pickCandidate': '选一条候选',
  'lyrics.loadingPreview': '载入歌词',
  'lyrics.previewFailed': '预览失败：{msg}',
  'lyrics.applyFailed': '使用失败：{msg}',
  'lyrics.granWord': '逐字轴',
  'lyrics.granLine': '句级轴',
  'lyrics.granPlain': '无时间轴',
  'lyrics.hasRuby': '含注音',
  'lyrics.noRuby': '无注音',
  'lyrics.hasTranslation': '含译文',
  'lyrics.durationDiff': '差 {n}s',
  'lyrics.durationDiffTitle': '与视频时长不符，可能是 live / remix 版本',
  'lyrics.lineCount': '{n} 行',
  'lyrics.emptyLyric': '这条候选没有歌词',

  // ---- 导入 ----
  'lyrics.kindText': '纯文本',
  'lyrics.kindLrc': 'LRC',
  'lyrics.kindQrc': 'QRC',
  'lyrics.kindTextTitle': '一行一句，无时间轴',
  'lyrics.kindLrcTitle': '[mm:ss.xx] 行级时间轴',
  'lyrics.kindQrcTitle': '逐字轴，可带 [kana:] 假名',
  'lyrics.contentPlaceholder': '粘贴歌词，或把文件拖进来',
  'lyrics.chooseFile': '选择文件',
  'lyrics.pasteClipboard': '粘贴',
  'lyrics.clear': '清空',
  'lyrics.loadedFile': '已加载 {name}',
  'lyrics.fileFailed': '文件读不出来，改用粘贴',
  'lyrics.clipboardDenied': '浏览器不允许读剪贴板，在框内按 Cmd/Ctrl+V',
  'lyrics.modeReplace': '替换',
  'lyrics.modeAppend': '追加',
  'lyrics.import': '导入',
  'lyrics.importing': '导入中',
  'lyrics.importFailed': '导入失败：{msg}',
  'lyrics.unrecognized': '{n} 行无法识别',
  'lyrics.kanaTrack': '含 [kana:]',
  'lyrics.parsePending': '行数以后端解析为准',
  'lyrics.beforePaste': '粘贴或拖入歌词',

  // ---- 确认后：全文编辑态 ----
  'lyrics.script': '歌词',
  'lyrics.changeSource': '换歌词',
  'lyrics.splitStart': '拆行',
  'lyrics.splitPick': '点击拆分位置',
  'lyrics.splitHere': '在这里拆',
  'lyrics.splitRisky': '拆在注音中间，该注音会失效',
  'lyrics.merge': '并入下一行',
  'lyrics.metadata': '制作名单',
  'lyrics.metadataTitle': '歌词源把词/曲/编曲塞进了正文，渲染时单独成屏',
  'lyrics.editHint': '拆行 / 并行',
  'lyrics.editFailed': '改不动：{msg}',
  'lyrics.noLines': '还没有歌词',
}
