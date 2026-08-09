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
  'media.proxy.missing': '还没有编辑代理',
  'media.proxy.needVideo': '需要先获取视频',
  'media.proxy.build': '生成代理',
  'media.proxy.rebuild': '重新生成',
  'media.proxy.building': '生成编辑代理',

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
  'media.track.waveLoading': '生成波形中…',
  'media.track.waveQueued': '等待中…',
  'media.track.waveError': '波形不可用',
}
