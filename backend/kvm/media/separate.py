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
extra 里显式列了两者）。子进程启动时先探测这两个依赖，**缺失时自动装进当前
解释器所在的应用私有虚拟环境**（不 sudo、不碰系统 Python），安装过程逐行
转成进度事件回报给 UI。只有在"当前解释器不是虚拟环境"或安装真的失败时才
退回中文手工提示——绝不静默失败（§2.6 明确要求用户不必为跑起这个工具去手动
安装任何东西）。

## 缓存（CLAUDE.md §5.13）

按 `(audio_sha256, model_id, backend_version)` 缓存分离结果：命中且产物文件
仍在，直接跳过重新计算。
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.util
import json
import logging
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from kvm.api.schemas import ProjectDTO, SeparateModelTier, SeparateRequest
from kvm.api.store import ProjectStore
from kvm.jobs import JobCancelled, JobHandle, run_cancelable

# 注意：`experiments.ffmpeg_locate` 与 `kvm.media.download` 故意不在模块顶层
# import——本文件同时也是 `python -m kvm.media.separate --worker` 的子进程
# 入口，子进程的 cwd/sys.path 只保证能找到 `kvm` 包（见 `_backend_dir()`），
# 不保证能找到仓库根目录下的 `experiments` 包。worker 分支（`_worker_main`）
# 完全不需要这两个依赖，因此把它们放进 `run_separate()` 里局部 import，
# 避免子进程加载本模块时因为顶层 import 就崩掉。

# 暴露给用户的三档（CLAUDE.md §5.4）。**这里是唯一的真相来源**：
# `GET /api/media/separate/models` 直接返回它，前端只认 `id`，不碰模型文件名——
# 此前前端传的是"去掉扩展名的模型文件名"，与后端按档位名建的别名表对不上，
# 导致"标准"和"最佳"两档必然报 `Model file ... not found in supported model files`。
MODEL_TIERS: tuple[SeparateModelTier, ...] = (
    SeparateModelTier(
        id="fast",
        label="快速",
        model_filename="htdemucs.yaml",
        hint="84MB，最快，先出个能听的伴奏立刻开始调轴；4 声部，还会顺带产出鼓声轨",
    ),
    SeparateModelTier(
        id="standard",
        label="标准",
        model_filename="mel_band_roformer_kim_ft_unwa.ckpt",
        hint="原生 2 声部，质量接近最佳档，本机实测约比最佳档快 2.4 倍",
        recommended=True,
    ),
    SeparateModelTier(
        id="best",
        label="最佳",
        model_filename="model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        hint="原生 2 声部，质量最高，最慢（639MB 权重）",
    ),
)

# 档位 id → audio-separator 的 model_filename。额外收下 `htdemucs` 这个写法：
# CLAUDE.md §5.4 用它指代快速档，历史调用也这么传。
# 其余未命中的字符串一律当字面 model_filename 透传给子进程，由子进程在
# audio-separator 的受支持列表里做容错匹配（见 `_resolve_supported_model`）。
MODEL_ALIASES: dict[str, str] = {tier.id: tier.model_filename for tier in MODEL_TIERS}
MODEL_ALIASES["htdemucs"] = "htdemucs.yaml"

# 分离依赖：(import 名, pip 需求串)。与 pyproject.toml 的 `separate` extra 保持一致。
_SEPARATE_REQUIREMENTS: tuple[tuple[str, str], ...] = (
    ("onnxruntime", "onnxruntime>=1.20"),
    ("audio_separator", "audio-separator>=0.44"),
)

_DEPENDENCY_HINT = (
    "请运行 `uv sync --extra separate`（或 `uv add audio-separator onnxruntime`）"
    "后重启后端。audio-separator 不会自动带上 onnxruntime，必须显式安装。"
)


def _tier_summary() -> str:
    """可用档位的一句话摘要，用于把错误信息说清楚而不是抛裸 ValueError。"""
    return "、".join(f"{tier.id}（{tier.label}）" for tier in MODEL_TIERS)


def _resolve_model_filename(model: str) -> str:
    return MODEL_ALIASES.get(model, model)


def _model_cache_dir() -> Path:
    """模型权重缓存目录。**不用 audio-separator 默认的 `/tmp`**（CLAUDE.md
    §5.14：macOS 会被系统定期清理、Windows 语义完全不对），显式指到应用私有
    缓存目录，与工程媒体目录共享同一个应用数据根。

    路径规则在 `kvm.paths` 单点定义（自检要报告同一个目录下有没有权重，
    两处各算各的迟早会指到不同地方）。
    """
    from kvm import paths

    return paths.models_dir() / "audio-separator"


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
    """登记分离出的 stem 路径。**走 `update_derived`，不占撤销格。**

    stem 是后台作业的派生产物，不是用户的一次编辑意图（CLAUDE.md §8「后台产物
    不进撤销栈」）。分离要跑几分钟，完成时刻与用户手上的编辑毫无关系——若压进
    撤销栈，用户按 Cmd+Z 撤掉的会是"分离已完成"这条登记。

    同样重要的是 `update_derived` 就地只改这三个字段：`mutate` 那套"深拷贝
    draft → 整体替换"会把分离期间用户在编辑器里做的改动整个吞掉。
    """

    def _apply(p: ProjectDTO) -> None:
        for field in ("vocals_path", "instrumental_path", "drums_path"):
            if field in paths:
                setattr(p, field, paths[field])

    store.update_derived(project_id, _apply, label="登记分离出的声部轨")


def _finalize_outputs(
    handle: JobHandle, ffmpeg_bin: str, stems: dict[str, str], run_output_dir: Path
) -> dict[str, str]:
    """把子进程产出的声部文件映射成 `ProjectDTO` 的路径字段。

    传进来的 `stems` 键已由 `_stem_key_from_filename` 归一化过大小写。三种形态：

    | 产出形态 | 代表模型 | 伴奏怎么来 |
    |---|---|---|
    | Vocals + Instrumental | BS-Roformer（最佳档） | 直接用 Instrumental |
    | Vocals + Drums + Bass + Other | htdemucs（快速档） | Bass+Drums+Other 混成伴奏 |
    | Vocals + Other | mel_band_roformer_kim_ft_unwa（标准档） | Other 本身就是完整伴奏 |

    第三种是实测发现的：该模型把非人声那一轨命名为 `other` 而不是
    `instrumental`，但它是 2 声部模型，没有 Drums/Bass 可混——所以判据是
    "有没有 Drums/Bass"，不能只看键名叫不叫 Other。

    合成伴奏时 CLAUDE.md §11 明确要求 `amix` 用 `normalize=0`，否则响度会被
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
    elif "Other" in stems:
        # 2 声部模型把伴奏轨命名成了 other（标准档实测如此）：没有 Drums/Bass
        # 可混，这一轨就是完整伴奏本身。
        out["instrumental_path"] = stems["Other"]

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

    from kvm.media.ffmpeg import find_ffmpeg_with_libass

    ffmpeg_bin = find_ffmpeg_with_libass()
    final_paths = _finalize_outputs(handle, ffmpeg_bin, produced_files, run_output_dir)

    _save_cache_entry(sep_dir, key, final_paths)
    _write_back(store, project.id, final_paths)

    handle.report(1.0, "完成")
    return {"project_id": project.id, "model": model_filename, "cached": False, **final_paths}


# ============================================================================
# 子进程 worker：真正 import audio_separator/torch 并跑分离的地方
# ============================================================================


class ModelResolutionError(RuntimeError):
    """模型标识落不到任何受支持的模型文件上。

    与其它异常分开处理：它携带的已经是给用户看的中文说明（含可用档位），
    可以原样透出，不需要再包一层 "分离失败：XxxError" 的前缀。
    """


def _emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


# ---- 依赖自动获取（CLAUDE.md §2.6 的"获取 / 安装"两段） ----

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _installer_command(specs: list[str]) -> list[str]:
    """挑一个可用的安装器。

    优先 `uv`：本项目本来就用它管依赖，而且 uv 建的虚拟环境默认不带 pip，
    直接 `python -m pip` 多半是找不到的。两个都没有就抛错让用户手工装，
    不去猜别的安装方式。
    """
    uv_bin = shutil.which("uv")
    if uv_bin:
        return [uv_bin, "pip", "install", "--python", sys.executable, *specs]
    if importlib.util.find_spec("pip") is not None:
        return [sys.executable, "-m", "pip", "install", *specs]
    msg = f"缺少分离依赖，且环境里既没有 uv 也没有 pip，无法自动安装。{_DEPENDENCY_HINT}"
    raise RuntimeError(msg)


def _run_installer(specs: list[str]) -> None:
    """跑安装命令，把它的输出逐行转成进度事件（几百 MB 的下载必须有反馈）。

    输出要先剥掉 ANSI 转义序列：uv 即便输出被重定向到管道也照样上色，
    原样透传到前端就是一串 `\\u001b[2m` 乱码。
    """
    cmd = _installer_command(specs)
    # 命令由 `_installer_command` 的白名单分支构造，不含用户输入
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    tail: list[str] = []
    if proc.stdout is not None:
        with proc.stdout as stream:
            for raw in stream:
                line = _ANSI_ESCAPE_RE.sub("", raw).strip()
                if not line:
                    continue
                tail.append(line)
                del tail[:-20]  # 只留尾部若干行用于报错，不无限增长
                _emit({"event": "progress", "progress": 0.04, "message": f"安装依赖：{line}"})
    code = proc.wait()
    if code != 0:
        detail = " / ".join(tail[-5:]) or "安装器没有输出可用信息"
        msg = f"自动安装分离依赖失败（退出码 {code}）：{detail}。{_DEPENDENCY_HINT}"
        raise RuntimeError(msg)


def _ensure_dependencies() -> None:
    """确保 onnxruntime / audio-separator 可用，缺失就自动装（CLAUDE.md §2.6）。

    装到 `sys.executable` 所在的虚拟环境里——那就是应用私有目录，不需要 sudo，
    也不会污染用户的系统 Python。当前解释器**不是**虚拟环境时直接放弃自动安装：
    宁可给一条明确的手工命令，也不去改别人的系统环境（§2.6 的"安装"一段）。
    任何失败都抛 `RuntimeError`，由调用方转成一行 JSON 错误事件，绝不静默失败。
    """
    missing = [
        (module, spec)
        for module, spec in _SEPARATE_REQUIREMENTS
        if importlib.util.find_spec(module) is None
    ]
    if not missing:
        return

    names = "、".join(module for module, _ in missing)
    if sys.prefix == sys.base_prefix:
        msg = (
            f"缺少分离依赖（{names}），而当前 Python 不是虚拟环境，"
            f"自动安装会污染系统环境，已放弃。{_DEPENDENCY_HINT}"
        )
        raise RuntimeError(msg)

    _emit(
        {
            "event": "progress",
            "progress": 0.02,
            "message": f"缺少分离依赖（{names}），正在自动安装到应用私有环境，首次可能需要下载数百 MB…",
        }
    )
    _run_installer([spec for _, spec in missing])

    importlib.invalidate_caches()  # 新装的包要让 import 系统重新扫一遍路径才可见
    still_missing = [m for m, _ in missing if importlib.util.find_spec(m) is None]
    if still_missing:
        msg = f"自动安装已执行完毕，但依然找不到 {'、'.join(still_missing)}。{_DEPENDENCY_HINT}"
        raise RuntimeError(msg)
    _emit({"event": "progress", "progress": 0.08, "message": "分离依赖安装完成"})


# ---- 模型标识容错解析 ----

# 补扩展名时的尝试顺序。`.ckpt` 在前、`.yaml` 在后：Roformer/MDXC 系列是
# `.ckpt`，Demucs v4 才用 `.yaml` 当标识，两者不会同名冲突。
_MODEL_EXTENSIONS: tuple[str, ...] = (".ckpt", ".yaml", ".onnx", ".th", ".pth")


def _supported_model_filenames(separator: Any) -> list[str]:
    """展平 `list_supported_model_files()` 的 `{架构: {友好名: {...}}}` 结构，取出全部文件名。

    `separator` 标注成 `Any`：它的类型来自可选依赖 audio-separator，本模块顶层
    不能 import（父进程加载本模块时不该拉起 torch）。
    """
    filenames: list[str] = []
    for models in separator.list_supported_model_files().values():
        if not isinstance(models, dict):
            continue
        for info in models.values():
            if isinstance(info, dict):
                name = info.get("filename")
                if isinstance(name, str):
                    filenames.append(name)
            elif isinstance(info, str):  # 旧版本 audio-separator 直接给文件名字符串
                filenames.append(info)
    return filenames


def _resolve_supported_model(requested: str, supported: list[str]) -> str:
    """把一个模型标识落到真实存在的 `model_filename` 上。

    顺序：精确命中 → 忽略大小写命中 → 补扩展名 → 唯一前缀匹配。全都不中就抛
    `ModelResolutionError`，信息里列出可用档位——用户该看到的是"有哪几档可选"，
    而不是 audio-separator 抛的裸 `ValueError: Model file ... not found`。
    """
    if requested in supported:
        return requested

    by_lower = {name.lower(): name for name in supported}
    key = requested.lower()
    if key in by_lower:
        return by_lower[key]
    for ext in _MODEL_EXTENSIONS:
        hit = by_lower.get(key + ext)
        if hit is not None:
            return hit

    candidates = sorted(name for low, name in by_lower.items() if low.startswith(key))
    if len(candidates) == 1:
        return candidates[0]

    detail = (
        f"（前缀匹配到多个候选：{'、'.join(candidates[:5])}，请写完整文件名）"
        if candidates
        else ""
    )
    msg = (
        f"无法识别的分离模型标识：{requested}{detail}。"
        f"请改用档位名：{_tier_summary()}；"
        f"也可以直接填 audio-separator 的完整模型文件名（当前共 {len(supported)} 个可选）。"
    )
    raise ModelResolutionError(msg)


def _resolve_model_for_worker(separator: Any, requested: str) -> str:
    """档位模型直接放行；其余标识才去拉受支持列表核对（列表首次使用需要联网）。"""
    if requested in {tier.model_filename for tier in MODEL_TIERS}:
        return requested
    try:
        supported = _supported_model_filenames(separator)
    except Exception as exc:  # 拉列表可能因离线/文件损坏以各种方式失败，都归成同一条中文说明
        msg = (
            f"无法核对模型标识 {requested}：拉取 audio-separator 的受支持模型列表失败"
            f"（{type(exc).__name__}: {exc}）。请改用档位名：{_tier_summary()}。"
        )
        raise ModelResolutionError(msg) from exc
    return _resolve_supported_model(requested, supported)


# 声部名归一化表。**各模型的大小写与用词并不统一**（本机实测：htdemucs 给
# `(Vocals)/(Drums)/(Bass)/(Other)`，BS-Roformer 给 `(Vocals)/(Instrumental)`，
# 而 mel_band_roformer_kim_ft_unwa 给的是小写的 `(vocals)/(other)`）。
# 不归一化的话 `_finalize_outputs` 一个键都认不出来，会直接报"输出文件类型无法识别"。
_STEM_ALIASES: dict[str, str] = {
    "vocals": "Vocals",
    "instrumental": "Instrumental",
    "drums": "Drums",
    "bass": "Bass",
    "other": "Other",
}


def _stem_key_from_filename(filename: str) -> str | None:
    """从 audio-separator 的输出文件名里抠出声部名，并归一化大小写。

    命名约定形如 `<输入文件名>_(Vocals)_<model>.<ext>`（本机在
    `workspace/sep_full/` 与 `workspace/sep_verify/` 下均已实测验证过这个格式）。
    """
    match = re.search(r"\(([A-Za-z_]+)\)", filename)
    if match is None:
        return None
    raw = match.group(1)
    return _STEM_ALIASES.get(raw.lower(), raw.capitalize())


def _worker_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="audio-separator 分离子进程")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)

    _emit({"event": "progress", "progress": 0.0, "message": "正在检查依赖…"})

    try:
        _ensure_dependencies()
    except RuntimeError as exc:
        _emit({"event": "error", "message": str(exc)})
        return 1

    try:
        from audio_separator.separator import Separator
    except ImportError as exc:
        _emit({"event": "error", "message": f"导入 audio-separator 失败：{exc}。{_DEPENDENCY_HINT}"})
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
        model_filename = _resolve_model_for_worker(separator, args.model)
        separator.load_model(model_filename=model_filename)
        _emit({"event": "progress", "progress": 0.4, "message": "模型加载完成，开始分离…"})
        out_files = separator.separate(args.audio)
        _emit({"event": "progress", "progress": 0.95, "message": "分离完成，正在整理产物…"})
    except ModelResolutionError as exc:
        _emit({"event": "error", "message": str(exc)})  # 已是中文说明，原样透出
        return 1
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
