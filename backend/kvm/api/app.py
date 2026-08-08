"""FastAPI 应用装配。

路由按领域拆分到 `routes/` 下，本文件只负责装配与横切关注点。

## COOP/COEP

前端预览用 JASSUB（libass 的 WASM 构建），它需要 SharedArrayBuffer，
而后者要求页面处于跨源隔离状态。因此**从第一天就必须配好这组响应头**，
否则等到套 Tauri 壳时才发现，前端架构可能要返工（CLAUDE.md D14）。

后端提供的媒体资源要带 `Cross-Origin-Resource-Policy: cross-origin`，
否则在隔离页面里会被拒绝加载。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from kvm.api.routes import editor, fonts, lyrics, media, projects, render
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
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
    resp.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
    resp.headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
    return resp


app.include_router(projects.router)
app.include_router(lyrics.router)
app.include_router(media.router)
app.include_router(editor.router)
app.include_router(render.router)
app.include_router(fonts.router)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}
