/** 「素材」舞台文案。由该舞台的实现者维护，其余舞台不要改本文件。 */
export const media: Record<string, string> = {
  // ---- 获取 ----
  'media.acquire.title': '获取素材',
  'media.download.placeholder': 'YouTube 链接',
  'media.download.button': '下载',
  'media.download.downloading': '下载中…',
  'media.local.dropVideo': '拖放视频，或点击选择',
  'media.local.dropAudio': '拖放音频，或点击选择',
  'media.local.importing': '导入中…',
  'media.status.missing': '未获取',

  // ---- 画面预览 ----
  'media.preview.empty': '还没有视频',
  'media.preview.unplayable': '当前浏览器无法播放，请生成或重新生成编辑代理',
  'media.preview.noResolution': '分辨率未知',
  'media.preview.usingProxy': '预览用代理',
  'media.preview.usingOriginal': '预览用原始文件',
  // 代理没有音轨（契约 D15），所以画面要配一条音轨才有声音
  'media.preview.companion': '伴随音轨',
  'media.preview.companionNone': '静音',

  // ---- 编辑代理 ----
  'media.proxy.title': '编辑代理',
  'media.proxy.missing': '未生成',
  'media.proxy.needVideo': '需要先获取视频',
  'media.proxy.build': '生成代理',
  'media.proxy.rebuild': '重新生成',
  'media.proxy.building': '生成编辑代理',
  'media.proxy.buildingState': '生成中',

  // ---- 人声分离 ----
  'media.separate.title': '人声分离',
  'media.separate.optional': '可选步骤，跳过也能导出，只是没有 ON/OFF VOCAL 双音轨。',
  'media.separate.recommended': '推荐',
  'media.separate.start': '开始分离',
  'media.separate.running': '分离中…',
  'media.separate.fallbackNote': '读取不到分离档位列表，已使用内置默认档位。',
  'media.separate.manualTitle': '导入已分离音轨：',
  'media.separate.drumsHint': '用于节拍检测，可单独导入',
  // 三档的选型依据：速度/质量取舍，短文案，完整说明放 title 悬浮
  'media.tier.fast': '最快',
  'media.tier.standard': '均衡',
  'media.tier.best': '最高质量',
  'media.tier.generic': '',

  // ---- 播放器（Preview.tsx，对轴/导出舞台共用）----
  //
  // 这里的键分成两类，界线不能糊：
  //   `media.player.*`          素材状态，是**中间状态**，语气中性、说"在做什么"
  //   `media.player.warn.*`     真的降级了，语气是警告、说"出了什么事 + 怎么办"
  // 曾经二者混在一起，于是没有视频时也会报「已改用视频自身的声音」——
  // 此刻根本没有可退回的目标，用户看到的是一条自相矛盾的黄色警告。
  'media.player.noAssets': '还没有素材',
  'media.player.noAssetsHint': '到「素材」步骤下载或导入',
  'media.player.audioOnly': '只有音轨，没有画面',
  'media.player.preparing': '正在准备素材',
  'media.player.downloading': '正在下载视频',
  'media.player.separating': '正在分离人声',
  'media.player.buildingProxy': '正在生成编辑代理',
  // 明确"不用管它"：进度条在任务栏里，预览区不重复做一个
  'media.player.busyHint': '完成后自动显示，进度见任务栏',
  'media.player.unplayable': '这个浏览器放不了当前视频',
  'media.player.unplayableProxyHint': '到「素材」步骤生成编辑代理',
  'media.player.audioMissing': '没有可播放的音轨',
  'media.player.audioMissingHint': '到「素材」步骤重新获取或导入音频',
  'media.player.warn.fallbackTitle': '正在使用视频自带音轨',
  'media.player.warn.fallbackDetail':
    'Web Audio 没拿到可用音轨，已临时改用视频自身的声音，此时无法切换伴奏。' +
    '音频抽取或人声分离完成后会自动切回 Web Audio。',
  'media.player.warn.unplayableTitle': '这个浏览器放不了当前视频，已降级为纯音频预览',
  'media.player.warn.unplayableDetail':
    '声音、播放头、打轴、导出都不受影响，只是看不到画面和叠在画面上的字幕。' +
    '常见原因是视频用的容器/编码本浏览器不支持 —— 例如 yt-dlp 下载得到的 .mkv 在 Safari' +
    '（WebKit）上没有解复用器，AV1 在 M1/M2 上也没有解码支持。',
  'media.player.warn.unplayableRetry': '当前放的已经是编辑用代理，仍然放不了的话请重新生成一次代理。',
  'media.player.warn.unplayableNeedProxy': '请到「素材」步骤生成编辑用代理视频（H.264/MP4），生成完这里会自动恢复画面。',
  'media.player.warn.unplayableBuilding': '编辑用代理正在生成，完成后这里会自动恢复画面。',

  // ---- 音轨卡片 ----
  'media.track.video': '视频',
  'media.track.audio': '原始音频',
  'media.track.vocals': '人声',
  'media.track.instrumental': '伴奏',
  'media.track.drums': '鼓声',
  'media.track.empty.audio': '还没有音频',
  'media.track.empty.vocals': '尚未分离',
  'media.track.empty.instrumental': '尚未分离',
  'media.track.empty.drums': '尚未分离',
  'media.track.playError': '试听不可用',
  'media.track.seek': '拖动跳转',
  'media.track.waveLoading': '生成波形中…',
  'media.track.waveQueued': '等待中…',
  'media.track.waveError': '波形不可用',
}
