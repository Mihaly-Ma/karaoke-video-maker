"""引导声（ガイドメロディ）作业：把人声轨合成成一条可试听、可调参的引导音轨。

合成算法本身在 `kvm.pipeline.guide_melody`（CREPE 提基频 → 中值滤波 → 切音符 →
半音量化 → 合成，理由全部写在那个模块与 CLAUDE.md §8.9）。**本模块不碰算法**，
只负责把它变成素材页上的一件产物。

## 为什么它必须是"素材"，而不是导出时才现场合成

引导声好不好用**只能靠耳朵判断**。参数改完必须立刻听得到，等到导出才发现跑调，
一次几分钟的烧录就白费了。所以它和人声分离、代理视频是同一类东西——先做好、
后面反复用——摆在素材页与它们并列，心智模型才一致。

顺带补上一个缺口：此前引导声没有任何可播放的端点，导出舞台的预览只能如实标注
"预览不含引导声"。产物落到 `ProjectDTO.guide_audio_path` 之后，
`GET /api/media/file/{id}/guide` 就和其它音轨一样可播了。

## 长任务形态（CLAUDE.md §5.13，已定 D5）

与分离/代理同一套，不另起一套：

- **独立子进程**。CREPE 是 torch 推理，绝不能在 FastAPI 的 handler 或线程池线程
  里跑（MPS 不 fork-safe；整曲十几到几十秒的阻塞会让后端假死且无法取消）。
  本文件因此身兼两职：库（`run_guide`）与子进程入口
  （`python -m kvm.media.guide --worker`）。
- **JSON-lines 进度**。torchcrepe 的 `predict()` 是一次前向、没有回调，所以阶段
  之间是跳变的；提取音高那一段用一个心跳线程持续上报**已用秒数**——
  进度条停在原地不动会被读成"卡死了"，而伪造一个匀速前进的百分比是撒谎。
- **按 `(vocals_sha256, 参数, 实现版本)` 缓存**。
- **可取消**：`run_cancelable` 杀的是进程组，torch 推理正在跑也照样收得掉。

## 两个不同的"指纹"，各管一件事

| 用途 | 键 | 为什么 |
|---|---|---|
| 缓存命中（要**正确**） | `(vocals_sha256, 参数, 版本)` | 内容寻址，§5.13 规定的形态 |
| 界面上的"参数改了、产物是旧的" | `(人声轨路径/体积/mtime, 参数, 版本)` | 前端要轮询它，为一次状态查询去哈希几十 MB 的 wav 纯属浪费 |

第二个是**显示用的启发式**，不承担正确性：即便它偶然漏判，真正生成时第一个键
仍会未命中并重算，绝不会拿一份别的输入的产物冒充。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from kvm.api.schemas import GuideParamsDTO, GuideRequest, JobStatus, ProjectDTO
from kvm.api.store import ProjectStore
from kvm.jobs import JobCancelled, JobHandle, job_manager, run_cancelable
from kvm.media import deps

# 一个工程只保留一份引导声，重生成直接原子替换掉旧的（与代理视频同一策略）。
GUIDE_FILENAME = "guide.wav"

# 缓存键与指纹里的实现版本。**改了合成算法或参数映射就要 +1**，
# 否则旧算法产出的音轨会被当成命中而继续沿用。
GUIDE_VERSION = "1"

# 引导声依赖：(import 名, pip 需求串)。与 pyproject.toml 的 `audio` extra 保持一致。
#
# **权重不在这个清单的职责范围内**：torchcrepe 把 full(89MB)/tiny(2MB) 两份
# 权重打进了 wheel 自己的 `assets/`，运行时不联网、不下载（CLAUDE.md §8.9、§2.1）。
# 所以这里没有、也不该有任何 §5.14 意义上的"权重获取"步骤。
GUIDE_REQUIREMENTS: tuple[tuple[str, str], ...] = (
    ("soundfile", "soundfile>=0.12"),
    ("librosa", "librosa>=0.11"),
    ("torchcrepe", "torchcrepe>=0.0.23"),
)

_DEPENDENCY_HINT = "安装命令：`uv sync --extra audio`，安装后需重启后端。"

# 每个工程最近一次引导声任务的 job_id。与代理同理：前端刷新过页面之后手里就没有
# job_id 了，只能按工程反查。
_LATEST_JOBS: dict[str, str] = {}


# ---------------------------------------------------------------------------
# 参数映射与指纹
# ---------------------------------------------------------------------------


def to_config(params: GuideParamsDTO) -> Any:
    """`GuideParamsDTO`（暴露给用户的 5 个）→ `GuideConfig`（完整参数集）。

    没有暴露的字段一律保持 `GuideConfig` 的默认值——它们是 f0 管线的标准步骤或
    按实测间隙分布定死的阈值（CLAUDE.md §8.9），不该由界面去动。

    返回值标注成 `Any`：`GuideConfig` 定义在 `kvm.pipeline.guide_melody`，
    那个模块顶层 import numpy，而本模块会被没装 `audio` extra 的环境加载
    （路由层要能列出状态并给出"依赖没装"的说明，而不是自己先崩掉）。
    """
    from kvm.pipeline.guide_melody import GuideConfig

    return GuideConfig(
        gain=params.gain,
        timbre=params.timbre,
        max_harmonics=params.max_harmonics,
        voicing_drop_db=params.voicing_drop_db,
        legato_gap_s=params.legato_gap_ms / 1000.0,
    )


def params_key(params: GuideParamsDTO) -> str:
    """参数的稳定文本表示。

    用固定字段顺序手写而不是 `model_dump_json()`：将来给 DTO 加一个**不影响音频**
    的字段（比如界面折叠状态）时，`model_dump_json` 会让全体缓存失效、
    让所有工程平白显示"参数改过了"。
    """
    return (
        f"gain={params.gain:.4f},timbre={params.timbre},harm={params.max_harmonics},"
        f"voice={params.voicing_drop_db:.2f},legato={params.legato_gap_ms}"
    )


def _vocals_fingerprint(vocals: Path) -> str:
    """人声轨的**廉价**身份：路径 + 体积 + mtime。只用于界面上的"产物是旧的"判断。

    不做 sha256：这个值会被前端轮询，为一次状态查询哈希几十 MB 的 wav 是纯浪费。
    正确性由 `cache_key()` 的内容哈希兜底（见模块文档的两个指纹）。
    """
    try:
        st = vocals.stat()
    except OSError:
        return f"{vocals}:missing"
    return f"{vocals}:{st.st_size}:{st.st_mtime_ns}"


def signature(vocals: Path, params: GuideParamsDTO) -> str:
    """产物指纹：`(人声轨, 参数, 实现版本)`。与工程里存着的那份不等即为 stale。"""
    return f"{_vocals_fingerprint(vocals)}|{params_key(params)}|{GUIDE_VERSION}"


def project_signature(project: ProjectDTO) -> str:
    """按工程当前状态算出的指纹；没有人声轨时为空串（此时压根生成不了）。"""
    if not project.vocals_path:
        return ""
    return signature(Path(project.vocals_path), project.guide)


def cache_key(vocals_sha256: str, params: GuideParamsDTO) -> str:
    """`(输入哈希, 参数, 实现版本)`——CLAUDE.md §5.13 规定的缓存键形态。"""
    return f"{vocals_sha256}:{params_key(params)}:{GUIDE_VERSION}"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# 缓存清单
# ---------------------------------------------------------------------------


def _manifest_path(media_dir: Path) -> Path:
    return media_dir / "guide_manifest.json"


def _load_cache_entry(media_dir: Path, key: str) -> str | None:
    path = _manifest_path(media_dir)
    if not path.is_file():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    entry = manifest.get(key)
    if not isinstance(entry, str) or not Path(entry).is_file():
        return None  # 命中键但产物已经不在了（被手动清理过），不算命中
    return entry


def _save_cache_entry(media_dir: Path, key: str, guide_path: str) -> None:
    """写入清单。**整体覆盖，不与旧条目合并。**

    一个工程只保留一份引导声（固定文件名 `guide.wav`），所以清单里最多只能有一条
    有效记录——新音轨一落盘，之前所有键指向的就都是这个新文件了。代理视频那边
    实测踩过这个坑：合并旧条目会让"换回上一组参数"被判成缓存命中，
    拿到的其实是最后一次生成的那份，症状是"改了参数却没变化"。
    """
    _manifest_path(media_dir).write_text(
        json.dumps({key: guide_path}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# 任务
# ---------------------------------------------------------------------------


def _write_back(store: ProjectStore, project_id: str, guide_path: str, sig: str) -> None:
    """登记引导声路径与指纹。**走 `update_derived`，不占撤销格。**

    产物是后台作业的派生物，不是用户的一次编辑意图（CLAUDE.md §8）。
    真正占撤销格的是**参数**（`POST /api/media/guide/params` 走 `mutate`）——
    那是用户拖滑块表达的意图，撤销回去理应回到上一组参数。
    """

    def _apply(p: ProjectDTO) -> None:
        p.guide_audio_path = guide_path
        p.guide_signature = sig

    store.update_derived(project_id, _apply, label="登记引导声音轨")


def _backend_dir() -> Path:
    """`backend/` 目录（`kvm` 包的父目录）。子进程用 `cwd=` 指向这里，
    这样 `python -m kvm.media.guide` 才找得到 `kvm` 包。
    """
    return Path(__file__).resolve().parent.parent.parent


def _worker_command(
    vocals: Path, dest: Path, duration_s: float, params: GuideParamsDTO
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "kvm.media.guide",
        "--worker",
        "--vocals",
        str(vocals),
        "--out",
        str(dest),
        "--duration",
        f"{duration_s:.3f}",
        "--gain",
        f"{params.gain}",
        "--timbre",
        params.timbre,
        "--max-harmonics",
        str(params.max_harmonics),
        "--voicing-drop-db",
        f"{params.voicing_drop_db}",
        "--legato-gap-ms",
        str(params.legato_gap_ms),
    ]


def run_guide(handle: JobHandle, store: ProjectStore, req: GuideRequest) -> dict[str, Any]:
    """引导声生成主流程，运行在 `kvm.jobs.JobManager` 的工作线程里。"""
    from kvm.media.download import project_media_dir

    started = time.monotonic()
    try:
        project = store.get(req.project_id)
    except KeyError as exc:
        raise RuntimeError(str(exc)) from exc

    if not project.vocals_path:
        msg = "工程没有人声轨。需要先完成人声分离，或手工导入人声轨"
        raise RuntimeError(msg)
    vocals = Path(project.vocals_path)
    if not vocals.is_file():
        msg = f"工程记录的人声轨不存在（可能已被移动/清理）：{vocals}"
        raise RuntimeError(msg)

    params = project.guide
    media_dir = project_media_dir(project.id)
    media_dir.mkdir(parents=True, exist_ok=True)
    dest = media_dir / GUIDE_FILENAME
    sig = signature(vocals, params)

    handle.report(0.03, "正在核对引导声缓存…")
    key = cache_key(_sha256_file(vocals), params)
    if not req.force:
        cached = _load_cache_entry(media_dir, key)
        if cached is not None:
            _write_back(store, project.id, cached, sig)
            handle.report(1.0, "完成（缓存命中，未重新合成）")
            return {
                "project_id": project.id,
                "guide_audio_path": cached,
                "cached": True,
            }

    handle.check_cancelled()
    # 先写临时文件再原子替换：重生成期间旧引导声一直可播，中途取消/失败也不会
    # 留下一个能被 <audio> 打开却只有半截的 guide.wav。
    tmp = media_dir / f"guide.{uuid.uuid4().hex[:8]}.part.wav"
    handle.add_cleanup(lambda: tmp.unlink(missing_ok=True))

    duration_s = max(project.duration_ms / 1000.0, 0.0)
    notes = 0
    last_error: str | None = None

    def _on_line(line: str) -> None:
        nonlocal last_error, notes
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return  # 第三方库偶发的非 JSON 输出，忽略而不是崩掉整条流水线
        kind = event.get("event")
        if kind == "progress":
            # 子进程报 0~1 的相对进度，映射到父任务的 [0.05, 0.95]，
            # 给缓存检查与回写留出可见的头尾
            handle.report(
                0.05 + 0.9 * float(event.get("progress", 0.0)), str(event.get("message", ""))
            )
        elif kind == "error":
            last_error = str(event.get("message", "引导声子进程报告了未知错误"))
        elif kind == "done":
            notes = int(event.get("notes", 0))

    cmd = _worker_command(vocals, tmp, duration_s, params)
    try:
        run_cancelable(handle, cmd, on_line=_on_line, cwd=str(_backend_dir()))
    except JobCancelled:
        raise
    except RuntimeError as exc:
        # 子进程按协议以非零码退出时 `run_cancelable` 自己也会抛 RuntimeError
        # （它不认识 JSON-lines 协议的语义）。已经拿到结构化中文错误就优先用它，
        # 而不是把裸 stdout 尾巴糊给用户。
        if last_error:
            raise RuntimeError(last_error) from exc
        raise

    if last_error:
        raise RuntimeError(last_error)
    if not tmp.is_file():
        msg = "引导声子进程正常退出但没有产出文件，需要检查后端日志"
        raise RuntimeError(msg)

    handle.check_cancelled()
    tmp.replace(dest)
    _save_cache_entry(media_dir, key, str(dest))
    _write_back(store, project.id, str(dest), sig)

    elapsed = time.monotonic() - started
    handle.report(1.0, f"完成（{notes} 个音符，耗时 {elapsed:.1f}s）")
    return {
        "project_id": project.id,
        "guide_audio_path": str(dest),
        "cached": False,
        "notes": notes,
        "size_bytes": dest.stat().st_size,
        "elapsed_s": round(elapsed, 2),
    }


def submit_guide_job(store: ProjectStore, req: GuideRequest) -> JobStatus:
    """把引导声合成排进统一任务队列，并记住 job_id 供前端按工程反查进度。"""
    job = job_manager.submit(kind="media.guide", run=lambda handle: run_guide(handle, store, req))
    _LATEST_JOBS[req.project_id] = job.job_id
    return job


def latest_job(project_id: str) -> JobStatus | None:
    """该工程最近一次引导声任务的状态；从未跑过或后端重启过则为 None。"""
    job_id = _LATEST_JOBS.get(project_id)
    if job_id is None:
        return None
    try:
        return job_manager.get(job_id)
    except KeyError:
        return None


# ---------------------------------------------------------------------------
# 导出侧：优先复用素材页已经做好的那份
# ---------------------------------------------------------------------------


def resolve_for_export(project: ProjectDTO, fallback_out: Path, duration_s: float) -> Path:
    """导出烧录时要混进去的引导声文件。

    **优先复用素材页的产物**：那正是用户刚刚试听并认可的那一份，直接拿来用既省掉
    十几到几十秒的 CREPE，也保证"听到的"与"导出的"是同一条音轨。

    素材页还没做过（或参数改了没重新生成）时**就地合成一份，不阻断导出**
    （CLAUDE.md §2.5：失败要降级，不能终止），且用工程里当前那组参数——
    否则用户调了半天参数，导出却拿到一条默认参数的引导声。

    注意这条回退路径会在导出线程里直接跑 torch，与 §5.13 的纪律相悖；
    它是导出作业尚未并入 `kvm.jobs` 之前的既有行为，等那次归并时一并解决。
    """
    from kvm.pipeline.guide_melody import build_guide_track

    ready = project.guide_audio_path and Path(project.guide_audio_path).is_file()
    if ready and project.guide_signature == project_signature(project):
        return Path(str(project.guide_audio_path))

    if not project.vocals_path:
        msg = "工程未关联人声轨（vocals_path），无法合成引导声"
        raise RuntimeError(msg)
    build_guide_track(
        Path(project.vocals_path),
        fallback_out,
        duration_s,
        config=to_config(project.guide),
    )
    return fallback_out


# ============================================================================
# 子进程 worker：真正 import torch / torchcrepe 并跑音高提取的地方
# ============================================================================


def _emit(event: dict[str, Any]) -> None:
    deps.emit(event)


class _Heartbeat:
    """提取音高期间持续上报**已用秒数**的心跳。

    `torchcrepe.predict()` 是一次前向、没有任何回调，所以这一段没有真进度可报。
    两种做法里选了不撒谎的那种：进度值原地不动，只让消息带上已用时间——
    整曲要跑十几到几十秒，一个完全静止的界面会被读成"卡死了"；
    而按估计时长匀速推进的假百分比，一旦估错就是明目张胆的谎话。
    """

    def __init__(self, progress: float, prefix: str, interval_s: float = 2.0) -> None:
        self._progress = progress
        self._prefix = prefix
        self._interval = interval_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="kvm-guide-hb")

    def _run(self) -> None:
        started = time.monotonic()
        while not self._stop.wait(self._interval):
            elapsed = time.monotonic() - started
            _emit(
                {
                    "event": "progress",
                    "progress": self._progress,
                    "message": f"{self._prefix}（已用 {elapsed:.0f}s）",
                }
            )

    def __enter__(self) -> _Heartbeat:
        _emit({"event": "progress", "progress": self._progress, "message": self._prefix})
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)


def _worker_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="引导声合成子进程")
    parser.add_argument("--vocals", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--gain", type=float, required=True)
    parser.add_argument("--timbre", required=True)
    parser.add_argument("--max-harmonics", type=int, required=True)
    parser.add_argument("--voicing-drop-db", type=float, required=True)
    parser.add_argument("--legato-gap-ms", type=int, required=True)
    args = parser.parse_args(argv)

    _emit({"event": "progress", "progress": 0.0, "message": "正在检查依赖…"})
    try:
        deps.ensure_dependencies(
            GUIDE_REQUIREMENTS,
            _DEPENDENCY_HINT,
            on_missing=lambda names: _emit(
                {
                    "event": "progress",
                    "progress": 0.02,
                    "message": f"缺少引导声依赖（{names}），正在自动安装到应用私有环境…",
                }
            ),
        )
    except RuntimeError as exc:
        _emit({"event": "error", "message": str(exc)})
        return 1

    # 第三方库（librosa/numba/torch）的 logging 必须走 stderr，
    # 否则会混进 stdout 上的 JSON-lines 协议。
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

    try:
        import numpy as np
        import soundfile as sf
        from kvm.pipeline.guide_melody import (
            GuideConfig,
            extract_notes,
            pick_device,
            synth_guide,
        )

        cfg = GuideConfig(
            gain=args.gain,
            timbre=args.timbre,
            max_harmonics=args.max_harmonics,
            voicing_drop_db=args.voicing_drop_db,
            legato_gap_s=args.legato_gap_ms / 1000.0,
        )
        vocals = Path(args.vocals)

        info = sf.info(str(vocals))
        # 引导声必须与整首歌等长：工程时长可能还没探测出来（为 0），
        # 也可能比人声轨短一点，取两者的大者才不会把末句削掉。
        duration_s = max(args.duration, float(info.duration))

        _emit({"event": "progress", "progress": 0.05, "message": "正在读取人声轨…"})
        device = pick_device(cfg.device)
        with _Heartbeat(0.15, f"正在提取音高（CREPE-{cfg.crepe_model}，{device}）"):
            notes = extract_notes(vocals, cfg)

        _emit({"event": "progress", "progress": 0.8, "message": f"合成 {len(notes)} 个音符…"})
        audio = synth_guide(notes, duration_s, sr=int(info.samplerate), config=cfg)

        _emit({"event": "progress", "progress": 0.95, "message": "正在写入音轨…"})
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        # 16-bit PCM（soundfile 对 WAV 的默认 subtype）：float32 会让一条 5 分钟的
        # 单声道音轨从 26MB 涨到 52MB，而这条轨在预览里要整份解码进内存。
        sf.write(str(out), np.asarray(audio), int(info.samplerate))
        _emit({"event": "done", "notes": len(notes), "path": str(out)})
    except Exception as exc:  # 子进程的职责就是把任意后端异常转成一行 JSON
        _emit({"event": "error", "message": f"引导声合成失败：{type(exc).__name__}: {exc}"})
        return 1

    return 0


def main() -> int:
    argv = sys.argv[1:]
    if "--worker" not in argv:
        print(
            "此模块通常由 kvm.jobs 的工作线程以 --worker 模式拉起子进程调用。\n"
            "直接运行请加 --worker（另需 --vocals/--out/--duration 等参数）。",
            file=sys.stderr,
        )
        return 2
    return _worker_main([a for a in argv if a != "--worker"])


if __name__ == "__main__":
    raise SystemExit(main())
