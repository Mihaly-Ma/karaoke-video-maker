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

  // ---- 引导声（ガイドメロディ）----
  //
  // 每个参数都给一句"改它会怎样"，而不是字段名 + 滑块：滑块上写着
  // `voicing_drop_db` 用户无从判断该往哪边拖。句子说的是**症状与方向**，
  // 不解释原理（原理在 CLAUDE.md §8.9）。
  'media.guide.title': '引导声',
  'media.guide.build': '生成',
  'media.guide.rebuild': '重新生成',
  'media.guide.tune': '调参',
  'media.guide.building': '合成引导声',
  'media.guide.buildingState': '合成中',
  'media.guide.missing': '未生成',
  'media.guide.stale': '参数已变',
  'media.guide.unsaved': '参数已改',
  'media.guide.needVocals': '需要先分离人声',
  'media.guide.needVocalsHint': '引导声由人声轨提取音高合成，请先做人声分离',
  'media.guide.timbre': '音色',
  'media.guide.timbre.hint': '方波最像卡拉OK 引导音；正弦最干净，但容易被编曲盖住',
  'media.guide.timbre.sine': '正弦',
  'media.guide.timbre.triangle': '三角',
  'media.guide.timbre.square': '方波',
  'media.guide.timbre.saw': '锯齿',
  'media.guide.gain': '音量',
  'media.guide.gain.hint': '相对伴奏的响度。默认约低 5dB，只引导不抢主体',
  'media.guide.max_harmonics': '明亮度',
  'media.guide.max_harmonics.hint': '谐波数上限。调大更亮更容易听清，调小更柔和',
  'media.guide.max_harmonics.inert': '正弦只有基波，明亮度对它无效',
  'media.guide.voicing_drop_db': '灵敏度',
  'media.guide.voicing_drop_db.hint': '越负越灵敏：弱唱的尾音也会有引导声，但没人唱的地方也可能响',
  'media.guide.legato_gap_ms': '连音',
  'media.guide.legato_gap_ms.hint': '短于此的空档不断开。调大更连贯，调小更贴合换气',

  // ---- 播放器（Preview.tsx，对轴/导出舞台共用）----
  //
  // 这里的键分成两类，界线不能糊：
  //   `media.player.*`          素材状态，是**中间状态**，语气中性、说"在做什么"
  //   `media.player.warn.*`     真的降级了，语气是警告、说"出了什么事 + 怎么办"
  // 曾经二者混在一起，于是没有视频时也会报「已改用视频自身的声音」——
  // 此刻根本没有可退回的目标，用户看到的是一条自相矛盾的黄色警告。
  'media.player.play': '播放',
  'media.player.pause': '暂停',
  'media.player.volume': '音量',
  'media.player.overlayLoading': '字幕渲染器加载中…',
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
  'media.player.warn.noContextTitle': '无法创建 Web Audio 上下文',
  'media.player.warn.noContextDetail': '预览将回退到视频自带音轨，试听混音不可用。',
  'media.player.warn.trackFailed': '{track}轨加载失败',
  'media.player.warn.trackFailedMix': '请确认视频已下载并抽出了音频。',
  'media.player.warn.trackFailedStem': '这条轨要先跑一次人声分离，完成后会自动可用。',
  'media.player.warn.trackFailedGuide': '请到「素材」步骤重新生成引导声。',
  // 保音高变速用不上时的降级说明。不是错误——播放照常，只是慢速试听会走调
  'media.player.warn.pitchFallbackTitle': '慢速试听会降调',
  'media.player.warn.pitchFallbackDetail':
    '这个浏览器没能启用保音高变速，0.75x 试听会整体降调约 5 个半音，跟着唱对不上音。' +
    '正常速度、打轴与导出都不受影响。',

  // ---- 试听混音台（播放器控制条）----
  //
  // 这几档是**试听**，不是导出设置：「原声 / 伴奏」与导出的 ON/OFF VOCAL 一一对应
  // 并共用状态，而「仅人声」纯属试听，没有对应的导出变体。
  'media.player.mix.label': '试听',
  'media.player.mix.original': '原声',
  'media.player.mix.instrumental': '伴奏',
  'media.player.mix.vocals': '仅人声',
  // 引导声是**叠加层**，不参与上面三档的互斥：它能配原声也能配伴奏
  'media.player.mix.guide': '引导声',
  'media.player.mix.guideMissing': '到「素材」步骤生成引导声',
  'media.player.mix.tracks': '分轨',
  'media.player.mix.tracksHint':
    '分别调整各条音轨的音量。「原声」= 人声 + 伴奏，把人声压到两三成就是ガイドボーカル入り那种试听方式。',
  'media.player.mix.needSeparate': '需要先完成人声分离',
  'media.player.mix.loading': '音轨还在解码',
  'media.player.mix.loadFailed': '这条音轨没能加载，原因见下方提示',
  'media.player.mix.unavailable': 'Web Audio 不可用，无法切换音轨',
  'media.player.track.mix': '原曲',
  'media.player.track.vocals': '人声',
  'media.player.track.instrumental': '伴奏',
  'media.player.track.guide': '引导声',

  // ---- 音轨卡片 ----
  'media.track.video': '视频',
  'media.track.audio': '原始音频',
  'media.track.vocals': '人声',
  'media.track.instrumental': '伴奏',
  'media.track.drums': '鼓声',
  'media.track.guide': '引导声',
  'media.track.empty.audio': '还没有音频',
  'media.track.empty.vocals': '尚未分离',
  'media.track.empty.instrumental': '尚未分离',
  'media.track.empty.drums': '尚未分离',
  'media.track.empty.guide': '尚未生成',
  'media.track.playError': '试听不可用',
  'media.track.seek': '拖动跳转',
  'media.track.waveLoading': '生成波形中…',
  'media.track.waveQueued': '等待中…',
  'media.track.waveError': '波形不可用',
}
