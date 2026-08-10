"""环境自动获取的 HTTP 接口（CLAUDE.md §2.6「获取」阶段的对外面）。

给两类调用方用：

- **启动页**（Tauri 壳里 `tauri://localhost` 上那个 HTML）：跨源轮询这里，
  显示"正在准备环境"的进度，或在失败时把原因摆出来。
- 主界面：将来在设置里做"重新检查环境"时复用同一组接口。

## 为什么不用 `kvm.jobs`

`kvm.jobs` 是给重计算作业（分离/对齐/烧录）设计的：独立子进程、
按输入哈希缓存、可取消（§5.13）。下载几十 MB 的 ffmpeg 不满足其中任何一条
前提——它没有输入哈希、不吃 CPU、也不该派生子进程。这里只需要一个后台线程
加一份状态，硬套作业框架反而要处理一堆不相干的语义。

## 响应里不放给人看的中文句子

§8.8：后端返回**错误码 + 结构化参数**，文案由前端翻译。所以失败时给的是
`code`（如 `bootstrap.hash_mismatch`）与 `args`，`message` 只作为开发者可见的
兜底，不应该直接贴到界面上。
"""

from __future__ import annotations

import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from kvm import bootstrap as bs
from pydantic import BaseModel

router = APIRouter(prefix="/api/bootstrap", tags=["bootstrap"])


class ProgressOut(BaseModel):
    component: str
    stage: str
    downloaded: int = 0
    total: int = 0


class ErrorOut(BaseModel):
    code: str
    args: dict[str, str] = {}
    message: str = ""


class ArtifactOut(BaseModel):
    """一个待下载文件的**可核对信息**（§2.6「知情下载」）。

    启动页在开始下载前把这些摆出来：从哪个域名下、多大、SHA256 是多少。
    下载的是第三方构建的可执行文件，把信任点藏起来只留一条进度条是不合适的；
    清单本来就写死在代码里，如实报出来不多暴露任何东西。
    """

    key: str
    url: str
    bytes: int
    sha256: str


class ComponentOut(BaseModel):
    key: str
    ready: bool
    available: bool
    bytes: int
    artifacts: list[ArtifactOut] = []


class StatusOut(BaseModel):
    platform: str
    components: list[ComponentOut]
    manual_install: str = ""
    """自动获取之外的手工安装命令；空串表示本平台没有现成的一条命令。

    它是**并列的出路，不是推荐路径**——会装进用户系统，而本项目的原则是
    装进应用私有目录、卸载即删目录。措辞归前端。
    """
    running: str | None = None
    """正在获取哪个组件；None 表示空闲。"""
    progress: ProgressOut | None = None
    error: ErrorOut | None = None
    install_dir: str
    """装到哪儿了——排查问题时用户需要知道，也用来说明"卸载即删目录"。"""


class _State:
    """获取动作的全局状态。

    同一时刻只允许一个获取在跑：并行下几个大文件既抢带宽又让进度条没法读。
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.running: str | None = None
        self.progress: bs.Progress | None = None
        self.error: bs.BootstrapError | None = None


_state = _State()


def _snapshot() -> StatusOut:
    raw = bs.status()
    with _state.lock:
        running, progress, error = _state.running, _state.progress, _state.error
    return StatusOut(
        platform=str(raw["platform"]),
        manual_install=str(raw["manual_install"]),
        components=[ComponentOut(**c) for c in raw["components"]],  # type: ignore[arg-type]
        running=running,
        progress=(
            ProgressOut(
                component=progress.component,
                stage=progress.stage,
                downloaded=progress.downloaded,
                total=progress.total,
            )
            if progress
            else None
        ),
        error=(
            ErrorOut(code=error.code, args=error.detail_args, message=str(error)) if error else None
        ),
        install_dir=str(bs.paths.private_bin_dir()),
    )


@router.get("/status", response_model=StatusOut)
def get_status() -> StatusOut:
    return _snapshot()


class FetchIn(BaseModel):
    component: str


@router.post("/fetch", response_model=StatusOut)
def start_fetch(body: FetchIn) -> StatusOut:
    """启动一次获取。已经在跑就直接返回当前状态，不排队也不并发。"""
    with _state.lock:
        if _state.running is not None:
            return _snapshot()
        _state.running = body.component
        _state.error = None
        _state.progress = None

    def _report(p: bs.Progress) -> None:
        with _state.lock:
            _state.progress = p

    def _work() -> None:
        try:
            bs.fetch_component(body.component, _report)
        except bs.BootstrapError as exc:
            with _state.lock:
                _state.error = exc
        except Exception as exc:
            # 预期外的异常也要变成有码的失败——否则启动页只会看到"还在跑"，
            # 而线程已经死了，用户对着一个永不推进的进度条干等。
            with _state.lock:
                _state.error = bs.BootstrapError(
                    "bootstrap.unexpected", f"{type(exc).__name__}: {exc}"
                )
        finally:
            with _state.lock:
                _state.running = None

    threading.Thread(target=_work, name=f"bootstrap-{body.component}", daemon=True).start()
    return _snapshot()


class ImportIn(BaseModel):
    path: str


@router.post("/import", response_model=StatusOut)
def import_archive(body: ImportIn) -> StatusOut:
    """离线导入用户自己下好的归档（§5.14）。哈希仍然要对得上清单。"""
    try:
        bs.import_offline(Path(body.path).expanduser())
    except bs.BootstrapError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": exc.code, "args": exc.detail_args, "message": str(exc)},
        ) from exc
    return _snapshot()
