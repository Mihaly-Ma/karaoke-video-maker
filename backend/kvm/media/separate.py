"""人声分离（audio-separator）。

真正调用 audio-separator / torch 的部分**必须跑在独立子进程里**（CLAUDE.md
§5.13：torch 的 MPS 后端不 fork-safe，且这类调用不能放进 FastAPI 的 async
handler 或线程池线程直接执行——阻塞会让后端假死、无法取消，段错误/OOM 会
拖垮整个后端进程）。本文件因此身兼两职：

- 作为库被 `kvm.jobs` 的工作线程调用（`run_separate()`）：只负责编排——
  缓存命中判断、拉起子进程、解析其 JSON-lines 进度输出、htdemucs 4-stem
  合成伴奏、回写工程。
- 作为子进程入口被自己拉起（`python -m kvm.media.separate --worker ...`）：
  真正 import audio_separator/torch 并跑分离，逐行往 stdout 打 JSON 进度；
  发生异常也落成一行 JSON，不让父进程去解析裸 traceback。

## 依赖自动化（CLAUDE.md §2.6）

`audio-separator` 不会自动带上 `onnxruntime`（pyproject.toml 的 `separate`
extra 里显式列了两者）。子进程启动时先探测这两个依赖，缺失时给出可执行的
中文提示（`uv sync --extra separate`），而不是抛裸 ImportError。

## 缓存（CLAUDE.md §5.13）

按 `(audio_sha256, model_id, backend_version)` 缓存分离结果：命中且产物文件
仍在，直接跳过重新计算。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

from kvm.api.schemas import ProjectDTO, SeparateRequest
from kvm.api.store import ProjectStore
from kvm.jobs import JobCancelled, JobHandle, run_cancelable

# 注意：`experiments.ffmpeg_locate` 与 `kvm.media.download` 故意不在模块顶层
# import——本文件同时也是 `python -m kvm.media.separate --worker` 的子进程
# 入口，子进程的 cwd/sys.path 只保证能找到 `kvm` 包（见 `_backend_dir()`），
# 不保证能找到仓库根目录下的 `experiments` 包。worker 分支（`_worker_main`）
# 完全不需要这两个依赖，因此把它们放进 `run_separate()` 里局部 import，
# 避免子进程加载本模块时因为顶层 import 就崩掉。

# 档位名 → audio-separator 的 model_filename（CLAUDE.md §5.4 的三档）。
# 未命中别名时把 `req.model` 当作字面 model_filename 直接传给 Separator，
# 给高级用户留口子。
MODEL_ALIASES: dict[str, str] = {
    "htdemucs": "htdemucs.yaml",  # 快速档：首次导入立刻出个能听的伴奏
    "fast": "htdemucs.yaml",
    "standard": "mel_band_roformer_kim_ft_unwa.ckpt",  # 标准档（CLAUDE.md 推荐默认）
    "best": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",  # 最佳档，最慢
}

_DEPENDENCY_HINT = (
    "请运行 `uv sync --extra separate`（或 `uv add audio-separator onnxruntime`）"
    "后重启后端。audio-separator 不会自动带上 onnxruntime，必须显式安装。"
)


def _resolve_model_filename(model: str) -> str:
    return MODEL_ALIASES.get(model, model)


def _model_cache_dir() -> Path:
    """模型权重缓存目录。**不用 audio-separator 默认的 `/tmp`**（CLAUDE.md
    §5.14：macOS 会被系统定期清理、Windows 语义完全不对），显式指到应用私有
    缓存目录，与工程媒体目录共享同一个应用数据根。
    """
    from kvm.media.download import app_data_root

    return app_data_root() / "models" / "audio-separator"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _backend_version() -> str:
    try:
        from importlib.metadata import version

        return version("audio-separator")
    except Exception:  # noqa: BLE001 —— 取不到版本号不该阻断分离，只影响缓存键精确度
        return "unknown"


def _cache_manifest_path(sep_dir: Path) -> Path:
    return sep_dir / "cache_manifest.json"


def _cache_key(audio_sha256: str, model_filename: str, backend_version: str) -> str:
    return f"{audio_sha256}:{model_filename}:{backend_version}"


def _load_cache_entry(sep_dir: Path, key: str) -> dict[str, str] | None:
    manifest_path = _cache_manifest_path(sep_dir)
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    entry = manifest.get(key)
    if not entry:
        return None
    if not all(Path(p).is_file() for p in entry.values()):
        return None  # 命中键但产物文件已经不在了（被手动清理过），不算命中
    return entry


def _save_cache_entry(sep_dir: Path, key: str, entry: dict[str, str]) -> None:
    manifest_path = _cache_manifest_path(sep_dir)
    manifest: dict[str, dict[str, str]] = {}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}
    manifest[key] = entry
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def _backend_dir() -> Path:
    """`backend/` 目录（`kvm` 包的父目录）。子进程用 `cwd=` 指向这里，
    这样 `python -m kvm.media.separate` 才能找到 `kvm` 包——不依赖调用方
    有没有把 `backend/` 加进 PYTHONPATH（这一点目前仓库里还没有统一约定）。
    """
    return Path(__file__).resolve().parent.parent.parent


def _write_back(store: ProjectStore, project_id: str, paths: dict[str, str]) -> None:
    def _mutate(p: ProjectDTO) -> None:
        for field in ("vocals_path", "instrumental_path", "drums_path"):
            if field in paths:
                setattr(p, field, paths[field])

    store.mutate(project_id, _mutate, label="人声分离")


def _finalize_outputs(
    handle: JobHandle, ffmpeg_bin: str, stems: dict[str, str], run_output_dir: Path
) -> dict[str, str]:
    """把子进程产出的声部文件映射成 `ProjectDTO` 的路径字段。

    2-stem 模型（Roformer 等）直接给 Vocals/Instrumental；htdemucs 这类
    4-stem 模型只给 Vocals/Drums/Bass/Other，需要自己把 Bass+Drums+Other
    混成伴奏——CLAUDE.md §11 明确要求 `amix` 用 `normalize=0`，否则响度会被
    "平均"变轻，与人声轨对不上。
    """
    out: dict[str, str] = {}
    if "Vocals" in stems:
        out["vocals_path"] = stems["Vocals"]
    if "Drums" in stems:
        out["drums_path"] = stems["Drums"]
    if "Instrumental" in stems:
        out["instrumental_path"] = stems["Instrumental"]
    elif all(k in stems for k in ("Drums", "Bass", "Other")):
        mixed = run_output_dir / "instrumental.wav"
        cmd = [
            ffmpeg_bin, "-y",
            "-i", stems["Bass"], "-i", stems["Drums"], "-i", stems["Other"],
            "-filter_complex", "[0:a][1:a][2:a]amix=inputs=3:duration=longest:normalize=0[out]",
            "-map", "[out]", str(mixed),
        ]
        run_cancelable(handle, cmd)
        out["instrumental_path"] = str(mixed)

    if not out:
        msg = f"分离子进程输出的文件类型无法识别：{sorted(stems)}"
        raise RuntimeError(msg)
    return out


def run_separate(handle: JobHandle, store: ProjectStore, req: SeparateRequest) -> dict[str, Any]:
    """分离编排主流程，运行在 `kvm.jobs.JobManager` 的工作线程里。"""
    from kvm.media.download import _rmtree_ignore_errors, project_media_dir

    try:
        project = store.get(req.project_id)
    except KeyError as exc:
        raise RuntimeError(str(exc)) from exc

    if not project.audio_path:
        msg = "工程还没有可用音频，请先下载或导入媒体后再分离"
        raise RuntimeError(msg)
    audio_path = Path(project.audio_path)
    if not audio_path.is_file():
        msg = f"工程记录的音频文件不存在（可能已被移动/清理）：{audio_path}"
        raise RuntimeError(msg)

    model_filename = _resolve_model_filename(req.model)
    handle.report(0.02, "正在核对分离缓存…")

    audio_sha256 = _sha256_file(audio_path)
    backend_version = _backend_version()
    key = _cache_key(audio_sha256, model_filename, backend_version)

    sep_dir = project_media_dir(project.id) / "sep"
    sep_dir.mkdir(parents=True, exist_ok=True)

    cached = _load_cache_entry(sep_dir, key)
    if cached is not None:
        handle.report(0.9, "命中分离缓存，跳过重新计算")
        _write_back(store, project.id, cached)
        handle.report(1.0, "完成（缓存命中）")
        return {"project_id": project.id, "model": model_filename, "cached": True, **cached}

    handle.check_cancelled()
    model_dir = _model_cache_dir()
    model_dir.mkdir(parents=True, exist_ok=True)
    run_output_dir = sep_dir / audio_sha256[:12]
    run_output_dir.mkdir(parents=True, exist_ok=True)
    handle.add_cleanup(lambda: _rmtree_ignore_errors(run_output_dir))

    handle.report(0.05, f"启动分离子进程（模型 {model_filename}，首次运行可能需要下载模型权重）…")

    cmd = [
        sys.executable, "-m", "kvm.media.separate", "--worker",
        "--audio", str(audio_path),
        "--model", model_filename,
        "--model-dir", str(model_dir),
        "--output-dir", str(run_output_dir),
    ]

    produced_files: dict[str, str] = {}
    last_error: str | None = None

    def _on_line(line: str) -> None:
        nonlocal last_error
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return  # 子进程/第三方库偶发的非 JSON 输出，忽略而不是崩掉整条流水线
        kind = event.get("event")
        if kind == "progress":
            # 子进程自己上报 0~1 的相对进度，映射到父任务的 [0.1, 0.9] 区间，
            # 给缓存检查/写工程留出可见的头尾
            handle.report(0.1 + 0.8 * float(event.get("progress", 0.0)), str(event.get("message", "")))
        elif kind == "error":
            last_error = str(event.get("message", "分离子进程报告了未知错误"))
        elif kind == "done":
            produced_files.update(event.get("files", {}))

    try:
        run_cancelable(handle, cmd, on_line=_on_line, cwd=str(_backend_dir()))
    except JobCancelled:
        raise
    except RuntimeError as exc:
        # 子进程按协议以非零码退出时 `run_cancelable` 自己也会抛 RuntimeError
        # （它不知道 JSON-lines 协议的语义）。如果我们已经从 "error" 事件里
        # 拿到了结构化的中文错误信息，优先用它，而不是把裸 stdout 尾巴糊给用户。
        if last_error:
            raise RuntimeError(last_error) from exc
        raise

    if last_error:
        raise RuntimeError(last_error)
    if not produced_files:
        msg = "分离子进程正常退出但没有产出任何文件，可能是 audio-separator 的输出行为发生了变化，请检查日志"
        raise RuntimeError(msg)

    handle.check_cancelled()
    handle.report(0.92, "正在合成伴奏轨…")

    from experiments.ffmpeg_locate import find_ffmpeg_with_libass

    ffmpeg_bin = find_ffmpeg_with_libass()
    final_paths = _finalize_outputs(handle, ffmpeg_bin, produced_files, run_output_dir)

    _save_cache_entry(sep_dir, key, final_paths)
    _write_back(store, project.id, final_paths)

    handle.report(1.0, "完成")
    return {"project_id": project.id, "model": model_filename, "cached": False, **final_paths}


# ============================================================================
# 子进程 worker：真正 import audio_separator/torch 并跑分离的地方
# ============================================================================


def _emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _stem_key_from_filename(filename: str) -> str | None:
    """从 audio-separator 的输出文件名里抠出声部名。

    命名约定形如 `<输入文件名>_(Vocals)_<model>.<ext>`（本机在
    `workspace/sep_full/` 下已实测验证过这个格式）。
    """
    match = re.search(r"\(([A-Za-z]+)\)", filename)
    return match.group(1) if match else None


def _worker_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="audio-separator 分离子进程")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)

    _emit({"event": "progress", "progress": 0.0, "message": "正在检查依赖…"})

    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        _emit({"event": "error", "message": f"缺少 onnxruntime。{_DEPENDENCY_HINT}"})
        return 1
    try:
        from audio_separator.separator import Separator
    except ImportError:
        _emit({"event": "error", "message": f"缺少 audio-separator。{_DEPENDENCY_HINT}"})
        return 1

    # audio-separator 内部用标准 logging 输出，必须转到 stderr，
    # 不能污染 stdout 上的 JSON-lines 协议。
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        _emit({"event": "progress", "progress": 0.1, "message": "正在加载模型…"})
        separator = Separator(
            model_file_dir=args.model_dir,
            output_dir=str(output_dir),
            log_level=logging.WARNING,
        )
        separator.load_model(model_filename=args.model)
        _emit({"event": "progress", "progress": 0.4, "message": "模型加载完成，开始分离…"})
        out_files = separator.separate(args.audio)
        _emit({"event": "progress", "progress": 0.95, "message": "分离完成，正在整理产物…"})
    except Exception as exc:  # noqa: BLE001 —— 子进程的职责就是把任意后端异常转成一行 JSON
        _emit({"event": "error", "message": f"分离失败：{type(exc).__name__}: {exc}"})
        return 1

    files: dict[str, str] = {}
    for name in out_files:
        path = Path(name)
        if not path.is_absolute():
            path = output_dir / path
        stem_key = _stem_key_from_filename(path.name)
        if stem_key:
            files[stem_key] = str(path)

    _emit({"event": "done", "files": files})
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if "--worker" not in argv:
        print(
            "此模块通常由 kvm.jobs 的工作线程以 --worker 模式拉起子进程调用。\n"
            "直接运行请加 --worker（另需 --audio/--model/--model-dir/--output-dir）。",
            file=sys.stderr,
        )
        return 2
    return _worker_main([a for a in argv if a != "--worker"])


if __name__ == "__main__":
    raise SystemExit(main())
