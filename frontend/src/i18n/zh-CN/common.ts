/**
 * 跨舞台通用文案。新增前先确认它真的会被多处使用。
 *
 * 语域：专业工具的界面文字是**状态与标签**，不是对话。不寒暄、不安慰、
 * 不解释内部实现、不用感叹号；按钮用动词，标签用名词，状态用结果。
 */
export const common: Record<string, string> = {
  'topbar.lineCount': '{n} 行',
  'topbar.home': '返回工程列表',
  'topbar.steps': '工作流步骤',
  'topbar.undo': '撤销 (Ctrl/Cmd+Z)',
  'topbar.redo': '重做 (Shift+Ctrl/Cmd+Z)',
  'common.play': '播放',
  'common.pause': '暂停',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.use': '使用',
  'common.save': '保存',
  'common.retry': '重试',
  'common.undo': '撤销',
  'common.redo': '重做',
  'common.loading': '加载中',
  'common.ready': '已就绪',
  'common.failed': '失败',
  'common.done': '已完成',
  /** 工程没有标题时的占位。全应用一处定义，免得出现"未命名"/"未命名工程"两种写法。 */
  'common.untitled': '未命名',
  'common.selectProjectFirst': '未选择工程',
  // 来源徽章：CLAUDE.md §7.4 要求这四种来源在界面上可见地区分
  'source.provider': '歌词源',
  'source.aligned': '对齐',
  'source.interpolated': '插值',
  'source.manual': '手工',
  // 与 workflow.ts 的 STEP_LABEL 一一对应；对轴与注音已合并为「编辑」
  'step.media': '素材',
  'step.lyrics': '歌词',
  'step.edit': '编辑',
  'step.style': '样式',
  'step.export': '导出',
  // 步骤前置条件不满足时的说明。是**状态陈述**而不是命令，所以用「需要…」
  'step.needLyrics': '需要先导入歌词',
  'step.needMediaAndLyrics': '需要素材与歌词',

  // ---- 字幕渲染器（编辑与样式两个舞台共用同一个渲染层）----
  //
  // 这一组原先把 JASSUB / libass / COOP-COEP / vite.config.ts / public/jassub/ 这些
  // 内部构件直接摆给了用户。他在这一刻能做的只有三件事之一：换浏览器、去样式步骤
  // 换字体、或者什么都不用做。文案只说**结果与这三条出路**，排查线索留在代码注释里。
  'overlay.noWorkerTitle': '浏览器不支持 Web Worker',
  'overlay.noWorkerDetail': '无法渲染字幕。请改用较新版本的 Chrome / Edge / Firefox / Safari',
  'overlay.noWasmTitle': '浏览器不支持 WebAssembly',
  'overlay.noWasmDetail': '无法渲染字幕。请改用较新版本的 Chrome / Edge / Firefox / Safari',
  'overlay.noOffscreenTitle': '浏览器不支持 OffscreenCanvas',
  'overlay.noOffscreenDetail': '无法渲染字幕。Safari 16.4 以下与部分嵌入式 WebView 不支持',
  // 这条是**降级不是故障**，语气要与上面三条明显不同
  'overlay.noIsolationTitle': '字幕渲染已降为单线程',
  'overlay.noIsolationDetail': '字幕正常显示，复杂特效帧率下降；导出不受影响',
  'overlay.noFontTitle': '工程未设置字体',
  'overlay.noFontDetail': '在「样式」步骤选择字体',
  'overlay.fontPendingTitle': '字体准备中',
  'overlay.fontPendingDetail': '{list}。完成后切换一次字体即可显示',
  'overlay.fontPreparing': '字体准备中',
  'overlay.fontMissingTitle': '预览缺少字体，日文字形显示为方块',
  'overlay.fontMissingDetail': '未取到：{list}。预览与成片可能不一致',
  'overlay.fontChainGapTitle': '字体链缺一环，预览可能与成片不一致',
  'overlay.fontChainGapDetail': '未取到：{list}。主字体覆盖不到的字，预览空白而成片正常',
  'overlay.primaryMissingTitle': '主字体「{family}」未加载',
  'overlay.primaryMissingDetail': '预览改用「{fallback}」，字宽与换行位置可能与成片不一致',
  'overlay.initFailed': '字幕渲染器初始化失败：{detail}',
  'overlay.timeout': '字幕渲染器在 {sec} 秒内没有就绪',

  // ---- 长任务（任务栏）----
  // 状态用结果，不用「进行中…」这类口语；与音轨波形的排队状态共用「排队中」
  'job.pending': '排队中',
  'job.running': '进行中',
  'job.done': '已完成',
  'job.failed': '失败',
  'job.cancelled': '已取消',
  'job.dismiss': '关闭（不影响后台任务）',
  'job.download': '下载视频',
  'job.separate': '人声分离',
  'job.export': '导出视频',
}
