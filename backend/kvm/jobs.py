"""通用长任务编排：内存任务表 + 线程池调度 + 可取消（CLAUDE.md §5.13，已定 D5）。

## 设计要点

- **绝不在 FastAPI 的 async handler 或线程池线程里直接调 torch**：torch 的 MPS
  后端不是 fork-safe 的，段错误/OOM 会拖垮整个后端进程；同步阻塞调用会让
  event loop（或线程池线程）假死，也就无法响应取消请求。
  本模块的线程池因此只负责**调度**——发起子进程、读取其 JSON-lines 进度输出、
  更新任务表——真正的重计算必须由具体 runner 自己拆到独立子进程里完成
  （参见 `kvm/media/separate.py` 的 `--worker` 子命令）。下载（yt-dlp）是纯
  I/O，不涉及 torch，可以直接跑在线程里。
- **取消 = 终止子进程（进程组）**。子进程不会自己收拾摊子，临时文件的清理由
  各 runner 通过 `JobHandle.add_cleanup()` 注册回调，取消/失败后统一执行。
- 线程池的 `max_workers` 本身就是 §5.13 要求的**全局并发闸门**——分离动辄几
  GB 内存，不应该无限并发。
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from kvm.api.schemas import JobStatus


class JobCancelled(Exception):  # noqa: N818 —— 语义上是控制流信号，不是"错误"，但仍需可被 except 捕获
    """runner 内部用来表示『已按用户请求终止』，与真实失败区分开。"""


def _new_process_group_kwargs() -> dict[str, Any]:
    """让子进程成为独立进程组/组长，便于 `_kill_process_tree` 连它的子孙一起收了。"""
    if os.name == "posix":
        return {"start_new_session": True}
    return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}  # type: ignore[attr-defined]


def _kill_process_tree(proc: subprocess.Popen, grace_s: float = 3.0) -> None:
    """终止子进程（及其在 POSIX 上的进程组）。先 SIGTERM 给个收尾时间，超时再 SIGKILL。"""
    if proc.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        else:
            proc.terminate()
    except (ProcessLookupError, OSError):
        pass
    deadline = time.monotonic() + grace_s
    while proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.1)
    if proc.poll() is None:
        with contextlib.suppress(ProcessLookupError, OSError):
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()


class JobHandle:
    """传给 runner 的句柄：上报进度、检查/响应取消、登记子进程与清理回调。"""

    __slots__ = ("_manager", "job_id")

    def __init__(self, job_id: str, manager: JobManager) -> None:
        self.job_id = job_id
        self._manager = manager

    def report(self, progress: float, message: str = "") -> None:
        """上报进度（0~1）与状态文案。"""
        self._manager._update(self.job_id, progress=max(0.0, min(1.0, progress)), message=message)

    def is_cancelled(self) -> bool:
        return self._manager._is_cancelled(self.job_id)

    def check_cancelled(self) -> None:
        """在长流程的关键节点调用；已取消则立即抛出 `JobCancelled` 中止 runner。"""
        if self.is_cancelled():
            raise JobCancelled(self.job_id)

    def register_process(self, proc: subprocess.Popen) -> None:
        """登记一个子进程，取消时会被 `_kill_process_tree`。"""
        self._manager._register_process(self.job_id, proc)

    def unregister_process(self, proc: subprocess.Popen) -> None:
        self._manager._unregister_process(self.job_id, proc)

    def add_cleanup(self, fn: Callable[[], None]) -> None:
        """注册一个清理回调：任务被取消或失败后会依次执行（成功时不执行——
        产出文件是交付物，不该被清理）。
        """
        self._manager._add_cleanup(self.job_id, fn)


class JobManager:
    """内存任务表 + 线程池调度。"""

    def __init__(self, max_workers: int = 2) -> None:
        self._jobs: dict[str, JobStatus] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="kvm-job")
        self._cancel_events: dict[str, threading.Event] = {}
        self._procs: dict[str, list[subprocess.Popen]] = {}
        self._cleanups: dict[str, list[Callable[[], None]]] = {}

    # ---- 对外 API ----

    def submit(self, kind: str, run: Callable[[JobHandle], dict[str, Any]]) -> JobStatus:
        """登记一个新任务并立即安排执行，**不阻塞调用方**——路由层应立刻拿到这个
        `JobStatus`（state="pending"）返回给前端，真正的执行在线程池里异步进行。
        """
        job_id = uuid.uuid4().hex[:12]
        status = JobStatus(job_id=job_id, kind=kind, state="pending", message="排队中")
        with self._lock:
            self._jobs[job_id] = status
            self._cancel_events[job_id] = threading.Event()
        self._executor.submit(self._run, job_id, run)
        return status

    def get(self, job_id: str) -> JobStatus:
        with self._lock:
            status = self._jobs.get(job_id)
        if status is None:
            msg = f"任务不存在：{job_id}"
            raise KeyError(msg)
        return status

    def cancel(self, job_id: str) -> JobStatus:
        """请求取消：置位取消标志 + 真正 kill 已登记的子进程。

        最终状态（cancelled）由执行任务的工作线程落定；这里先把 message 更新为
        "正在取消…" 给前端即时反馈，同时保证与工作线程收尾时的状态更新不发生竞态
        （state 一旦落到终态，本方法不再触碰任务表）。
        """
        with self._lock:
            status = self._jobs.get(job_id)
            if status is None:
                msg = f"任务不存在：{job_id}"
                raise KeyError(msg)
            if status.state in ("done", "failed", "cancelled"):
                return status
            event = self._cancel_events.get(job_id)
            procs = list(self._procs.get(job_id, []))
            updated = status.model_copy(update={"message": "正在取消…"})
            self._jobs[job_id] = updated

        if event is not None:
            event.set()
        for proc in procs:
            _kill_process_tree(proc)
        return updated

    # ---- 内部：状态与登记表维护（均需持锁） ----

    def _is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            event = self._cancel_events.get(job_id)
        return event is not None and event.is_set()

    def _register_process(self, job_id: str, proc: subprocess.Popen) -> None:
        with self._lock:
            self._procs.setdefault(job_id, []).append(proc)
            already_cancelled = self._is_cancelled_locked(job_id)
        if already_cancelled:
            # 注册前就已经被取消（竞态）：立刻补杀，不能让它跑漏
            _kill_process_tree(proc)

    def _is_cancelled_locked(self, job_id: str) -> bool:
        event = self._cancel_events.get(job_id)
        return event is not None and event.is_set()

    def _unregister_process(self, job_id: str, proc: subprocess.Popen) -> None:
        with self._lock:
            procs = self._procs.get(job_id)
            if procs and proc in procs:
                procs.remove(proc)

    def _add_cleanup(self, job_id: str, fn: Callable[[], None]) -> None:
        with self._lock:
            self._cleanups.setdefault(job_id, []).append(fn)

    def _run_cleanup(self, job_id: str) -> None:
        with self._lock:
            fns = self._cleanups.pop(job_id, [])
        for fn in fns:
            with contextlib.suppress(Exception):
                fn()

    def _update(self, job_id: str, **kwargs: Any) -> JobStatus:
        with self._lock:
            status = self._jobs.get(job_id)
            if status is None:
                msg = f"任务不存在：{job_id}"
                raise KeyError(msg)
            updated = status.model_copy(update=kwargs)
            self._jobs[job_id] = updated
            return updated

    def _forget(self, job_id: str) -> None:
        with self._lock:
            self._procs.pop(job_id, None)
            self._cancel_events.pop(job_id, None)

    # ---- 工作线程主体 ----

    def _run(self, job_id: str, run: Callable[[JobHandle], dict[str, Any]]) -> None:
        handle = JobHandle(job_id, self)
        if self._is_cancelled(job_id):
            # 排队期间就被取消了，压根不该开始执行
            self._update(job_id, state="cancelled", message="已取消（尚未开始执行）")
            self._run_cleanup(job_id)
            self._forget(job_id)
            return

        self._update(job_id, state="running", message="正在执行")
        try:
            result = run(handle)
        except JobCancelled:
            self._update(job_id, state="cancelled", message="已取消")
            self._run_cleanup(job_id)
        except Exception as exc:  # 任务失败必须落到 JobStatus.error，不能被线程默默吞掉
            self._update(job_id, state="failed", error=str(exc), message="失败")
            self._run_cleanup(job_id)
        else:
            if self._is_cancelled(job_id):
                self._update(job_id, state="cancelled", message="已取消")
                self._run_cleanup(job_id)
            else:
                self._update(job_id, state="done", progress=1.0, message="完成", result=result or {})
                with self._lock:
                    self._cleanups.pop(job_id, None)  # 成功了，产出文件不清理
        finally:
            self._forget(job_id)


def run_cancelable(
    handle: JobHandle,
    cmd: list[str],
    *,
    on_line: Callable[[str], None] | None = None,
    poll_interval: float = 0.2,
    **popen_kwargs: Any,
) -> str:
    """跑一个可被 `handle` 取消的子进程，返回其合并后的 stdout+stderr 文本。

    `on_line` 可选：逐行回调子进程 stdout（配合 JSON-lines 进度协议使用，见
    `kvm/media/separate.py`）。用后台线程读管道而不是在主循环里 `readline()`，
    是为了避免子进程长时间无输出时阻塞住取消检查（ffmpeg 抽音频这类调用往往
    直到结束都不产生任何中间输出）。

    取消时先尝试 `SIGTERM`（进程组），给几秒钟收尾，超时再 `SIGKILL`——真正
    杀掉子进程，不是仅仅标记状态。
    """
    kwargs: dict[str, Any] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "bufsize": 1,
        **_new_process_group_kwargs(),
        **popen_kwargs,
    }
    proc = subprocess.Popen(cmd, **kwargs)
    handle.register_process(proc)

    lines: list[str] = []

    def _reader() -> None:
        assert proc.stdout is not None  # 内部实现断言，构造时已固定 stdout=PIPE
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            lines.append(line)
            if on_line is not None:
                with contextlib.suppress(Exception):
                    on_line(line)

    reader = threading.Thread(target=_reader, daemon=True, name="kvm-job-reader")
    reader.start()

    try:
        while proc.poll() is None:
            if handle.is_cancelled():
                _kill_process_tree(proc)
                break
            time.sleep(poll_interval)
        reader.join(timeout=5.0)
    finally:
        handle.unregister_process(proc)

    if handle.is_cancelled():
        raise JobCancelled(handle.job_id)

    output = "\n".join(lines)
    if proc.returncode != 0:
        msg = f"子进程执行失败（退出码 {proc.returncode}）：{' '.join(str(c) for c in cmd[:3])}…\n{output[-2000:]}"
        raise RuntimeError(msg)
    return output


# 全局单例：并发闸门 = max_workers。可用 KVM_JOB_WORKERS 环境变量临时调整
# （例如调试时想让分离与下载严格串行，设为 1）。
job_manager = JobManager(max_workers=int(os.environ.get("KVM_JOB_WORKERS", "2")))
