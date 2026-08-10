/**
 * 「素材」舞台文案。由该舞台的实现者维护，其余舞台不要改本文件。
 *
 * 语域：这是专业工具，文案是**状态与标签，不是对话**。
 * 不写安慰与保证（「只做一次」「很快就好」）、不对用户寒暄（「请稍候」「您需要」）、
 * 不在状态里解释原因、不用感叹号。进度用「正在 + 动词」或名词短语，
 * 按钮用动词，标签用名词；有确切体积/时长/数量就给出来。
 */
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
  'media.preview.unplayable': '当前浏览器无法播放，生成编辑代理后恢复画面',
  'media.preview.noResolution': '分辨率未知',
  'media.preview.usingProxy': '预览源：编辑代理',
  'media.preview.usingOriginal': '预览源：原始文件',
  // 代理没有音轨（契约 D15），所以画面要配一条音轨才有声音
  'media.preview.companion': '伴随音轨',
  'media.preview.companionNone': '静音',

  // ---- 编辑代理 ----
  'media.proxy.title': '编辑代理',
  'media.proxy.missing': '未生成',
  'media.proxy.needVideo': '需要先获取视频',
  'media.proxy.build': '生成',
  'media.proxy.rebuild': '重新生成',
  'media.proxy.building': '生成编辑代理',
  'media.proxy.buildingState': '生成中',

  // ---- 人声分离 ----
  'media.separate.title': '人声分离',
  'media.separate.optional': '可选 · 跳过则无 OFF VOCAL 音轨',
  'media.separate.recommended': '推荐',
  'media.separate.start': '分离',
  'media.separate.running': '分离中…',
  'media.separate.fallbackNote': '档位列表读取失败，已用内置默认档位',
  'media.separate.manualTitle': '导入已分离音轨',
  'media.separate.drumsHint': '用于节拍检测',
  // 档位名。正常情况由后端下发，这三条只在档位列表取不到时兜底，
  // 取值必须与后端 MODEL_TIERS 的 label 一致，否则同一档位会有两个名字。
  'media.tierName.fast': '快速',
  'media.tierName.standard': '标准',
  'media.tierName.best': '最佳',
  // 档位名（快速 / 标准 / 最佳）由后端下发，这里只补**选型依据**。
  // 两者并排显示，所以绝不能写成档位名的同义词——曾经是「快速 最快」「标准 均衡」，
  // 一个概念占两个词、却一个数字都没给。选型依据要带体积与倍率。
  'media.tier.fast': '84 MB · 最快',
  'media.tier.standard': '质量接近最佳 · 快 2.4 倍',
  'media.tier.best': '639 MB · 最慢',
  'media.tier.generic': '',

  // ---- 引导声（ガイドメロディ）----
  //
  // 每个参数都给一句"改它会怎样"，而不是字段名 + 滑块：滑块上写着
  // `voicing_drop_db` 用户无从判断该往哪边拖。句子说的是**症状与方向**，
  // 不解释原理（原理在 CLAUDE.md §8.9），也不带口语评价（原先的
  // 「只引导不抢主体」「没人唱的地方也可能响」是聊天口吻，不是参数说明）。
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
  'media.guide.needVocalsHint': '引导声由人声轨提取音高合成，需要先完成人声分离',
  'media.guide.timbre': '音色',
  'media.guide.timbre.hint': '方波接近卡拉OK 引导音；正弦最干净，穿透力最弱',
  'media.guide.timbre.sine': '正弦',
  'media.guide.timbre.triangle': '三角',
  'media.guide.timbre.square': '方波',
  'media.guide.timbre.saw': '锯齿',
  'media.guide.gain': '音量',
  'media.guide.gain.hint': '相对伴奏的响度，默认低 5 dB',
  'media.guide.max_harmonics': '明亮度',
  'media.guide.max_harmonics.hint': '谐波数上限，调大更亮、调小更柔和',
  'media.guide.max_harmonics.inert': '正弦只有基波，此项无效',
  'media.guide.voicing_drop_db': '灵敏度',
  'media.guide.voicing_drop_db.hint': '越负越灵敏，弱唱尾音也会发声，无人声处也可能发声',
  'media.guide.legato_gap_ms': '连音',
  'media.guide.legato_gap_ms.hint': '短于此的空档不断开，调大更连贯、调小更贴合换气',

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
  'media.player.busyHint': '进度见任务栏',
  'media.player.unplayable': '当前浏览器无法播放此视频',
  'media.player.unplayableProxyHint': '在「素材」步骤生成编辑代理',
  'media.player.audioMissing': '没有可播放的音轨',
  'media.player.audioMissingHint': '在「素材」步骤重新获取或导入音频',
  'media.player.warn.fallbackTitle': '正在使用视频自带音轨',
  // 原文解释了内部走的是 Web Audio、退回时又"临时"改用什么——用户要知道的只有
  // "现在不能切轨"和"什么时候恢复"。实现细节属于代码注释，不属于界面。
  'media.player.warn.fallbackDetail': '当前无法切换音轨。音频抽取或人声分离完成后自动恢复',
  'media.player.warn.unplayableTitle': '当前浏览器无法播放此视频，已切换为纯音频预览',
  // 原文把 mkv / WebKit 解复用器 / AV1 在 M1 上没有硬解整段搬到了界面上。
  // 用户此刻要判断的是"这影响我干活吗"，答案是不影响——只说这一句。
  'media.player.warn.unplayableDetail': '声音、播放头、打轴与导出均不受影响，仅无画面与叠加字幕',
  'media.player.warn.unplayableRetry': '当前已在使用编辑代理。重新生成代理可再试一次',
  'media.player.warn.unplayableNeedProxy': '在「素材」步骤生成编辑代理后恢复画面',
  'media.player.warn.unplayableBuilding': '编辑代理生成中，完成后自动恢复画面',
  'media.player.warn.noContextTitle': '音频引擎不可用',
  'media.player.warn.noContextDetail': '已改用视频自带音轨，分轨试听不可用',
  // rVFC 缺失时的降级。不写 API 名（requestVideoFrameCallback），
  // 用户既不认识它、也无从据此行动；只说它对成品有没有影响。
  'media.player.warn.noFrameSyncTitle': '画面帧同步不可用',
  'media.player.warn.noFrameSyncDetail': '逐字高亮可能与画面相差半帧到一帧，导出不受影响',
  'media.player.err.overlayTitle': '字幕预览不可用',
  'media.player.err.overlayRebuild': '字幕更新失败：{detail}',
  'media.player.err.playTitle': '播放出错',
  'media.player.err.playFailed': '无法开始播放：{detail}',
  'media.player.warn.trackFailed': '{track}轨加载失败',
  'media.player.warn.trackFailedMix': '需要已下载的视频与已抽出的原始音频',
  'media.player.warn.trackFailedStem': '需要先完成人声分离',
  'media.player.warn.trackFailedGuide': '在「素材」步骤重新生成引导声',
  // 保音高变速用不上时的降级说明。不是错误——播放照常，只是慢速试听会走调
  'media.player.warn.pitchFallbackTitle': '慢速试听会降调',
  'media.player.warn.pitchFallbackDetail':
    '当前浏览器不支持保音高变速。0.75x 试听整体降调约 5 个半音；' +
    '正常速度、打轴与导出不受影响',

  // ---- 试听混音台（播放器控制条）----
  //
  // 这几档是**试听**，不是导出设置：「原声 / 伴奏」与导出的 ON/OFF VOCAL 一一对应
  // 并共用状态，而「仅人声」纯属试听，没有对应的导出变体。
  'media.player.mix.label': '试听',
  // 与波形源、音轨卡片统一叫「原曲」。此处曾叫「原声」，同一条混音在三处
  // 各有一个名字（原声 / 原曲 / 原始音频），切换时读不出说的是不是同一样东西。
  'media.player.mix.original': '原曲',
  'media.player.mix.instrumental': '伴奏',
  'media.player.mix.vocals': '仅人声',
  // 引导声是**叠加层**，不参与上面三档的互斥：它能配原曲也能配伴奏
  'media.player.mix.guide': '引导声',
  'media.player.mix.guideMissing': '在「素材」步骤生成引导声',
  'media.player.mix.tracks': '分轨',
  'media.player.mix.tracksHint': '分别调整各层音量。原曲 = 人声 + 伴奏；压低人声即ガイドボーカル入り',
  'media.player.mix.needSeparate': '需要先完成人声分离',
  'media.player.mix.loading': '音轨解码中',
  'media.player.mix.loadFailed': '音轨加载失败，原因见下方',
  'media.player.mix.unavailable': '音频引擎不可用，无法切换音轨',
  // 工程里一条音轨都没有时的独立说法。原先这里复用 unavailable，于是空工程上
  // 会显示「Web Audio 不可用」——把"没有素材"说成了"浏览器有问题"。
  'media.player.mix.noAudio': '还没有音轨',
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
  'media.track.waveLoading': '波形生成中…',
  // 与任务栏的状态用同一个词，同一种"还没轮到"在两处不能有两种说法
  'media.track.waveQueued': '排队中…',
  'media.track.waveError': '波形不可用',
}
