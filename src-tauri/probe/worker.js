// 探针用的最小 worker：起来了就报一声。
// 关键不在它做什么，而在于「同一个 URL 连起 4 次能不能次次成功」——
// WebKit 的 304 缺 COEP 那个坑正是表现为第 2 次起被拒（见 frontend/vite.config.ts 的注释）。
self.postMessage('alive')
