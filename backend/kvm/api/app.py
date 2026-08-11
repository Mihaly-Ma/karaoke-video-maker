"""FastAPI 应用装配。

路由按领域拆分到 `routes/` 下，本文件只负责装配与横切关注点。

## COOP/COEP

前端预览用 JASSUB（libass 的 WASM 构建），它需要 SharedArrayBuffer，
而后者要求页面处于跨源隔离状态。因此**从第一天就必须配好这组响应头**，
否则等到套 Tauri 壳时才发现，前端架构可能要返工（CLAUDE.md D14）。

后端提供的媒体资源要带 `Cross-Origin-Resource-Policy: cross-origin`，
否则在隔离页面里会被拒绝加载。

**下面那个 `@app.middleware("http")` 的设头位置（`call_next` 之后）不是随手写的，
不要改成"提前构造响应头"或挪进各路由。** 它之所以正确，是因为装在最外层、
对**每一个**响应对象补头——包括 `StaticFiles` 因条件请求返回的 **304**。
已实测：`If-None-Match` 命中时 304 上照样带着 COOP/COEP/CORP。这一点很关键：
WebKit 在合并 304 与缓存里那份 200 时**不会**把原来的 COEP 带回来，缺头就会
把页面里第二个 worker 拒掉（Vite 的 sirv 正是先判 304 再调 setHeaders 才踩了这个坑，
见 `frontend/vite.config.ts` 的注释）。

## 打包后的应用为什么由本服务下发前端

实测（构建后的 Tauri 壳，macOS 27 / wry 0.55）：页面跑在 `tauri://localhost`
自定义协议上时 `crossOriginIsolated` 为 true，但**全局 `SharedArrayBuffer` 不存在**；
而 JASSUB 的 wasm 是带 pthread 编译的，拿不到 SAB 直接实例化失败——不是退回
单线程，是完全跑不起来。同一份页面改从 `http://127.0.0.1:<port>` 下发则一切正常。
所以外壳只负责开窗口，界面由本服务在同源下发（见 `kvm.server` 与 `src-tauri/src/lib.rs`）。
顺带的好处是 `/api`、`/media` 与页面同源，CORS 在真界面上根本不参与。

COEP 用标准值 `require-corp`（契约 §5.9 表格里写的就是它），不用 Chromium 私有的
`credentialless`：WebKit 不实现后者，Safari 上会导致 `crossOriginIsolated` 恒为
false、SharedArrayBuffer 不可用，JASSUB 被迫退回单线程。本服务的每个响应都由下面
的中间件补上 CORP，前端又只经 Vite 代理同源访问，因此 require-corp 的严格性不带来
额外代价。
"""

from __future__ import annotations

import sys
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from kvm.api.routes import bootstrap, editor, fonts, lyrics, media, projects, render
from kvm.api.store import ProjectStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = ProjectStore()
    # 系统字体冷扫描本机实测 40.9 秒（862 个 family）。放到启动时的后台线程里预热，
    # 用户打开样式面板时通常已经扫完；没扫完也能查 `GET /api/fonts/status` 显示
    # "正在扫描系统字体…"，而不是干等一个 41 秒不返回的请求。
    # 这里只启动线程、不等待，绝不能阻塞 lifespan——否则后端 41 秒起不来。
    fonts.ensure_scan_started()
    yield


app = FastAPI(
    title="karaoke-video-maker API",
    version="0.2.1",
    lifespan=lifespan,
)

# 白名单只放**确实需要跨源**的两类来源，不要再宽：
#
# - `:5173` 是开发期的 Vite dev server。
# - `tauri://localhost`（macOS/Linux）与 `http://tauri.localhost`（Windows）
#   是打包后**启动页**的来源。启动页由 Tauri 的 app 协议下发，要跨源轮询
#   `/api/health` 与 `/api/bootstrap/*` 才能显示"正在准备环境"。
#   一旦环境就绪、窗口导航到本服务，真界面就是**同源**的，不再经过 CORS。
#
# 换句话说：这两条 tauri 来源只服务于"还没进主界面的那几秒"。
# 不要因为"反正打包后要用"就把 `*` 或整个 localhost 段放进来。
CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "tauri://localhost",
    "http://tauri.localhost",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def cross_origin_isolation(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """让 JASSUB 能用 SharedArrayBuffer，同时允许跨源加载媒体资源。"""
    resp = await call_next(request)
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    resp.headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
    return resp


app.include_router(projects.router)
app.include_router(lyrics.router)
app.include_router(media.router)
app.include_router(editor.router)
app.include_router(render.router)
app.include_router(fonts.router)
app.include_router(bootstrap.router)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


def _webui_dir() -> Path | None:
    """找到要下发的前端构建产物目录，找不到返回 None。

    两种运行形态：

    - **打包后**：`scripts/package.py` 用 PyInstaller 的 `--add-data` 把
      `frontend/dist` 放进 `sys._MEIPASS/webui`。
    - **源码运行**：仓库里的 `frontend/dist`（跑过 `npm run build` 才有）。
      开发时通常没有、也不需要——开发走 Vite dev server，那边有 HMR。

    找不到不是错误，只是"这个进程不负责下发界面"，所以不抛异常。
    """
    if getattr(sys, "frozen", False):
        bundled = Path(getattr(sys, "_MEIPASS", "")) / "webui"
        return bundled if (bundled / "index.html").is_file() else None
    repo_dist = Path(__file__).resolve().parents[3] / "frontend" / "dist"
    return repo_dist if (repo_dist / "index.html").is_file() else None


# 静态挂载必须在**所有 API 路由注册之后**：Starlette 按注册顺序匹配，
# 挂在 "/" 上的 StaticFiles 会吃掉一切路径，早注册就把 /api 和 /media 全遮住了。
_webui = _webui_dir()
if _webui is not None:
    app.mount("/", StaticFiles(directory=_webui, html=True), name="webui")
