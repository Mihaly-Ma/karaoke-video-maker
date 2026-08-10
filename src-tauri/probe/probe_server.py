"""探针配套的最小 HTTP 服务器（stdlib only，不进生产链路）。

用来回答三个「只能在真壳里问」的问题：

1. Tauri 的 WebView 向 `http://127.0.0.1` 发跨源请求时，`Origin` 头到底是什么
   （macOS 的 `tauri://localhost` 与 Windows 的 `http://tauri.localhost` 不一样，
   后端 CORS 白名单要照着填，猜错就是整条 /api 全挂）。
2. 跨源隔离页面里的 `<video>` 能不能加载 HTTP 上的媒体并 seek
   （需要 Range/206 + CORP；本项目的媒体全部由 FastAPI 提供，形态与这里一致）。
3. 复刻 WebKit 的「304 不带 COEP → worker 被拒」那个坑，确认它在壳里是否重现。

Python 自带的 SimpleHTTPRequestHandler **不支持 Range**，直接拿它测视频 seek 会得出
「seek 不了」的假结论，所以这里自己实现了 206。

用法（素材现生成，不进仓库）：

    ffmpeg -f lavfi -i testsrc=size=640x360:rate=25 -t 8 -an \\
           -c:v libx264 -preset veryfast -g 24 -movflags +faststart \\
           -y src-tauri/probe/sample.mp4
    python3 src-tauri/probe/probe_server.py 8321 src-tauri/probe/sample.mp4

然后二选一跑探针：

    npx tauri dev --config src-tauri/tauri.probe.conf.json --no-watch      # app 协议
    npx tauri build --debug --config src-tauri/tauri.probe.conf.json
    KVM_UI_URL=http://127.0.0.1:8321/ src-tauri/target/debug/kvm-shell     # HTTP 源

**注意 `tauri dev` 测不出生产形态**：dev 模式下前端由 Tauri 自己起的 HTTP dev server
（127.0.0.1:1430）下发，那台服务器不发 COOP/COEP，`crossOriginIsolated` 恒为 false。
要看真形态必须 `tauri build`（哪怕 `--debug`）。
"""

from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ETAG = 'W/"probe-1"'
WORKER_BODY = b"self.postMessage('alive')\n"


class Handler(BaseHTTPRequestHandler):
    video_path: Path = Path()
    static_dir: Path = Path()

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("[probe-server] " + fmt % args + "\n")

    def _common(self) -> None:
        origin = self.headers.get("Origin")
        # 反射 Origin 而不是写 `*`：带 credentials 的请求下 `*` 无效，
        # 而这里要测的正是真实前端会用的那种请求。
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Vary", "Origin")

    def do_POST(self) -> None:
        """接收探针结果。

        页面跑在 HTTP 源上时**拿不到 Tauri 的 IPC**（打包后的壳不给远程页面注入
        `window.__TAURI__`，除非在 capability 里显式放行 remote urls），
        所以结果必须有一条不依赖 IPC 的回传通道。
        """
        if self.path != "/report":
            self.send_response(404)
            self._common()
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        sys.stdout.write("__KVM_PROBE__" + body.decode("utf-8", "replace") + "\n")
        sys.stdout.flush()
        self.send_response(204)
        self._common()
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._common()
        self.send_header("Access-Control-Allow-Methods", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in {"/", "/index.html", "/worker.js", "/offscreen-worker.js"}:
            # 把探针页面本身也从 HTTP 上发一份，用来对照「同一份页面跑在
            # `tauri://localhost` 自定义协议上 vs 跑在 `http://127.0.0.1` 上」
            # 有没有能力差异——WKWebView 对自定义协议的待遇和普通 HTTP 不一样，
            # 而这决定了外壳该把窗口指向哪里。
            name = "index.html" if path == "/" else path.lstrip("/")
            body = (self.static_dir / name).read_bytes()
            ctype = "text/html" if name.endswith(".html") else "text/javascript"
            self.send_response(200)
            self._common()
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/sample.mp4":
            self._serve_video()
            return

        if path == "/health":
            body = json.dumps(
                {"ok": True, "origin": self.headers.get("Origin")}, ensure_ascii=False
            ).encode()
            self.send_response(200)
            self._common()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/etag-worker.js":
            # 复刻 Vite/sirv 的缺陷分支：304 上**不**补 COOP/COEP。
            if self.headers.get("If-None-Match") == ETAG:
                self.send_response(304)
                self._common()
                self.send_header("ETag", ETAG)
                self.end_headers()
                return
            self.send_response(200)
            self._common()
            self.send_header("ETag", ETAG)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(WORKER_BODY)))
            self.end_headers()
            self.wfile.write(WORKER_BODY)
            return

        if path == "/video.mp4":
            self._serve_video()
            return

        self.send_response(404)
        self._common()
        self.end_headers()

    def _serve_video(self) -> None:
        data = self.video_path.read_bytes()
        total = len(data)
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d+)-(\d*)", rng or "")
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else total - 1
            end = min(end, total - 1)
            chunk = data[start : end + 1]
            self.send_response(206)
            self._common()
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
            return
        self.send_response(200)
        self._common()
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(total))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    port = int(sys.argv[1])
    Handler.video_path = Path(sys.argv[2])
    Handler.static_dir = Path(__file__).parent
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
