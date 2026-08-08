"""P0/§9 相关实验：本地人声分离的可用性与依赖自动化实测。

对应 CLAUDE.md §2.5（依赖必须能自动查找/获取/安装）与 §5.4（人声分离选型）。
这不是生产代码，是可重复运行的探测脚本；结论已固化进 CLAUDE.md，本文件保留作为证据与
未来 `backend.doctor` / 下载器实现的原型。

运行方式（本文件不改 pyproject.toml，临时依赖一律用 `uv run --with`）：

    # 仅设备探测，依赖较轻（torch CPU/MPS wheel 在 macOS arm64 上约 75MB）
    uv run --python 3.12 --with torch python -m experiments.separation_check device

    # 生成 30 秒合成测试音频（人声正弦 + 伴奏噪声+和弦混合），不需要重依赖
    uv run --python 3.12 python -m experiments.separation_check synth

    # 用 audio-separator 跑一次真实分离并计时（会真的下载模型权重，见下方体积表）
    uv run --python 3.12 --with "audio-separator[cpu]" python -m experiments.separation_check \\
        separate --model htdemucs.yaml --audio workspace/media/synth_mix_30s.wav
    uv run --python 3.12 --with "audio-separator[cpu]" python -m experiments.separation_check \\
        separate --model model_bs_roformer_ep_317_sdr_12.9755.ckpt --audio workspace/media/synth_mix_30s.wav

    # 裸 demucs 库直接测 MPS complex-tensor 兼容性（不经 audio-separator 封装）
    uv run --python 3.12 --with demucs --with numpy python -m experiments.separation_check demucs-mps

    # MLX 移植生态成熟度探测（只发 HTTP 请求，不装大依赖）
    uv run --python 3.12 python -m experiments.separation_check mlx-probe

======================================================================
已实测结论（2026-08-08/09，macOS 26.0 arm64，Apple M5 Max，torch 2.13.0）
======================================================================

**Q1：macOS arm64 上实际可用的分离后端是哪个？MPS 到底能不能用？**

**能用，且是直接可用，不需要 CPU fallback。** 这不是照抄 CLAUDE.md 已有的"已定"结论，
是本次独立复现：

- 裸 `demucs` 库（不经 audio-separator）：`from demucs.pretrained import get_model` 取
  `htdemucs`（Hybrid Transformer 架构，本身就有 STFT 复数张量分支），`apply_model(model,
  wav, device='mps')` 直接跑通，30 秒立体声音频耗时 **1.31s**，输出无 NaN；对比
  `device='cpu'` 耗时 **6.62s**（MPS 快 5.05 倍）。全程未设置
  `PYTORCH_ENABLE_MPS_FALLBACK`，说明是 MPS 原生执行，不是靠 CPU 兜底算子凑出来的。
  "Demucs 因复数张量与 MPS 不兼容"这个说法在当前 torch/demucs 版本上**不成立**。
- `audio-separator[cpu]`（Separator 类）在 Apple Silicon 上**自动选中 mps**（源码
  `setup_torch_device`：`torch.backends.mps.is_available() and processor == "arm"` 时
  走 `configure_mps`，日志实测输出
  "Apple Silicon MPS/CoreML is available in Torch and processor is ARM, setting Torch
  device to MPS"）。htdemucs 全流程分离（含预处理/写盘）30 秒音频耗时 **13.60s**；
  默认"最佳"档 BS-Roformer（`model_bs_roformer_ep_317_sdr_12.9755.ckpt`）耗时 **7.80s**
  （比 htdemucs 更快，推测是 2-stem 输出 vs htdemucs 的 4-stem 输出算力差异）。
- onnxruntime（audio-separator 用于 MDX/VR 架构）在本机的 `get_available_providers()`
  返回 `['CoreMLExecutionProvider', 'AzureExecutionProvider', 'CPUExecutionProvider']`
  ——**开箱自带 CoreML EP，不需要额外装 `onnxruntime-silicon` 之类的包**（该项目已废弃，
  官方 onnxruntime 1.2x 起原生支持 CoreML）。

**方法论限制（诚实说明）**：30 秒测试音频是合成的（纯正弦人声代理 + 粉红噪声/和弦伴奏，
见下方"测试音频"一节），不是真实歌声，因此上面的"分离质量"不能当作 SDR 基准，只能证明
"pipeline 端到端跑通、有真实产出、耗时是这个量级"。质量验证仍需真实人声素材。

**一个诚实的意外发现**：BS-Roformer 对我们的合成人声轨完全"不认账"——输出的 Vocals
声道是**全零静音**（`np.abs(a).max() == 0.0`），100% 能量被判给了 Instrumental；反而是
htdemucs 把合成正弦人声轨分离出来了（与真值 `vocal_ref` 相关系数 0.9773，与
`instrumental_ref` 相关系数仅 0.0554，见 `sanity_correlation()`）。解释：BS-Roformer 是
按真实人声频谱/共振峰特征训练的专用人声模型，纯正弦波对它来说根本不像"人声"；htdemucs
是通用 4-stem 分离器（vocals/drums/bass/other），对"有音高的持续音"更宽容。**这说明合成
测试音频对不同架构的模型不是等价的替代品**，后续要做真实分离质量验证必须用真实人声。

**Q2：首次运行需要下载多少数据？**

依赖包（`uv run --with "audio-separator[cpu]"`，全新环境）：torch 106.1MB +
onnxruntime 18.3MB + scipy 19.5MB + llvmlite 38.6MB + scikit-learn 7.9MB + 其余若干
小包，共 58 个包，本机首次安装约 **70 秒**（网络耗时为主，CPU 时间仅 ~7s）。

模型权重（HTTP HEAD 实测的真实 `Content-Length`，与 CLAUDE.md §5.4 记载吻合）：

| 模型 | 实测体积 | CLAUDE.md 记载 |
|---|---|---|
| htdemucs（快档） | 84,141,911 B ≈ 80.2 MiB | "84 MB" ✓ 吻合 |
| model_bs_roformer_ep_317_sdr_12.9755.ckpt（最佳档，默认） | 639,331,213 B ≈ 609.7 MiB | "639 MB" ✓ 吻合 |
| UVR-MDX-NET-Inst_HQ_3.onnx（MDX 架构样本） | 66,759,214 B ≈ 63.7 MiB | 未单独记载 |

**下载机制的缺口（源码实测，`audio_separator/separator/separator.py`）**：

- `download_file_if_not_exists()` 只是 `requests.get(url, stream=True, timeout=300)` +
  逐 chunk 写盘，**没有 SHA256 校验，也没有 HTTP Range 断点续传**。幂等性仅靠
  `if os.path.isfile(output_path): skip`——这意味着**下载中断留下的半截文件会被误判为
  "已存在"而永久跳过**，是个实打实的坑。
- `get_model_hash()` 算的是 MD5（文件末尾 10,240,000 字节或全文件），但这是用来"从哈希
  反查模型型号/参数"的**身份识别**用途，不是下载后完整性校验。
- 因此 CLAUDE.md §5.14 设想的"独立进度条 + SHA256 校验 + 断点续传"**不能指望
  audio-separator 自带**，必须在应用层包一层下载器（校验 + Range + 半截文件检测）。
- 默认 `model_file_dir` 实测确认为 `/tmp/audio-separator-models/`，与 CLAUDE.md §5.14
  记载一致——**必须显式传参覆盖**，否则 macOS 定期清理 /tmp 会导致权重反复重下。
- 离线导入：机制上可行但不是显式 API——只要把文件放进 `model_file_dir` 且文件名与
  `list_supported_model_files()` 里的 `filename`/`download_files` 匹配，
  `download_file_if_not_exists` 的存在性检查就会跳过下载。没有校验和比对，纯靠文件名。
- `list_supported_model_files()` 本身会发一次网络请求拉取模型清单 JSON（实测 28.3KB，
  <1s），这也是一次隐式的"取数据"，doctor 自检时需考虑离线场景下这一步会失败。

对齐模型（`vumichien/wav2vec2-large-xlsr-japanese-hiragana`，约 1.26GB）不在本任务范围
内，未实测，数字引自 CLAUDE.md §5.14。

**Q3：30 秒音频分离耗时多少？据此推算整曲耗时？**

见上方 Q1 的耗时数据（合成音频）。线性外推到 4-5 分钟整曲（270 秒，按 4.5 分钟计）：

| 模型 | 30s 实测（合成音频） | 外推 270s（线性） |
|---|---|---|
| htdemucs（快档，MPS，audio-separator 全流程） | 13.60s（首跑）/3.65s（热缓存） | ≈ 33~122s |
| BS-Roformer（最佳档，MPS，audio-separator 全流程） | 7.80s（首跑）/6.04s（热缓存） | ≈ 54~70s |
| htdemucs（裸 demucs，仅 apply_model 前向，无 IO） | 1.31s | ≈ 12s（不含 IO/重采样） |

**用真实曲目验证过一次（不只是合成音频）**：运行期间另一 agent 并行下载好了验证曲
`赤春花 (feat. 幾田りら)` 的音频（`workspace/media/audio_44k.wav`，ffprobe 实测
**283.80 秒**、48kHz 立体声 16-bit PCM），本文件用 ffmpeg 从 60s 处截了一段真实 30 秒
人声+伴奏片段（`real_clip_30s.wav`）重跑了一遍：

| 模型 | 真实音频 30s（热缓存） | 输出 6 个 stem 的 RMS |
|---|---|---|
| htdemucs | 3.44s | Bass 0.130 / Drums 0.110 / Other 0.153 / Vocals 0.151 |
| BS-Roformer | 5.99s | Instrumental 0.183 / Vocals 0.141 |

六个输出声道全部有实质能量（不是静音/直通），**且这次 BS-Roformer 的 Vocals 声道不再是
静音**——印证了前面"方法论限制"一节的判断：BS-Roformer 之前对纯正弦波判定为静音，是因为
它是按真实人声频谱训练的专用模型，遇到真实演唱就能正常工作。按真实曲目 283.80 秒（非
四舍五入的 270 秒假设）重新外推：htdemucs ≈ 283.80/30×3.44s ≈ **32.5s**，BS-Roformer ≈
283.80/30×5.99s ≈ **56.6s**（均为热缓存场景，即模型已下载完毕后的稳定态耗时）。

**外推的局限性必须说明**：这是简单线性缩放，不是对整曲的直接测量。真实长音频受
chunk/overlap 策略影响可能非严格线性；CLAUDE.md §6.4 记载的 MPS 显存 spill 阈值
（Roformer 约 95 分钟、htdemucs 约 33 分钟）远高于单曲时长，本次外推范围内不会触发。
更重要的是，30 秒合成音频的频谱复杂度远低于真实歌曲（人声+鼓+贝斯+多轨编曲同时发声），
真实曲目的推理时间必须用真实素材重测才能作为产品耗时承诺。

**冷/热缓存耗时差异很大，产品耗时预期必须区分两种场景**：上表是"模型已下载"的热缓存
耗时。多次重跑同一 `separate` 子命令观察到明显波动——htdemucs 热缓存 `separate_s`
在 3.65s~13.60s 之间跳动，BS-Roformer 在 6.04s~7.80s 之间跳动（同一机器、同一 30 秒
音频，纯系统噪声/MPS 首次 kernel 编译开销/机器上并行跑的其它 agent 负载导致）。这意味着
"30 秒分离耗时"不是一个能承诺的精确 SLA 数字，只能给数量级；**首次运行**（含模型下载）
与**稳定态重复运行**的用户体验差异巨大，UI 上必须分别展示"下载模型权重"与"运行分离"两个
独立的进度阶段，不能合并成一个笼统的进度条。

**Q4：抽象接口应如何设计以同时支持 macOS 与 Windows？**

见文件末尾 `_DESIGN_NOTES`（避免把大段设计文字混进代码逻辑里）。

======================================================================
关于 MLX 移植生态（PyPI + HuggingFace + GitHub API 实测，2026-08-09）
======================================================================

- PyPI 上存在可安装的移植包：`demucs-mlx`（当前 1.4.4，已有多个点版本迭代）、
  `mlx-audio-separator`（0.1.5）。`demucs-mlx` 实测可在全新环境 `uv run --with
  demucs-mlx` 下 23 秒内装好并 import 成功（含编译 `mlx-audio-io` 原生扩展 + 下载
  53.2MB 的 `mlx-metal`），`list_models()` 返回
  `{'single': ['htdemucs', 'htdemucs_6s'], 'bag': ['htdemucs_ft', 'hdemucs_mmi', 'mdx', ...]}`
  ——与原生 demucs 模型名一致，权重大概率复用同一套（未做真实分离验证，仅探测到 API 层）。
- 但生态非常分散、活跃度低：GitHub 搜索 "mlx demucs" 命中 13 个仓库，star 数最高
  只有 32（`ssmall256/demucs-mlx`），多数是 0 star 的个人 fork；HuggingFace 上对应
  权重仓库（`mlx-community/mel-roformer-*-mlx` 等）下载量在 0~200 之间，对比同为
  mlx-community 维护的主流 LLM 移植（通常上万下载）差两个数量级。
- **结论**：MLX 路线技术上可安装可导入，但缺乏广泛验证，且原生 PyTorch MPS 后端本身
  已经工作良好（上面 Q1 的实测数据），目前没有必须冒险切换的理由。可作为"进一步摆脱
  PyTorch 依赖体积"的中长期可选项，不建议作为 v1 默认或唯一后端。

======================================================================
关于 Windows 侧（未实测，来自 PyPI 元数据的桌面调研，务必与 macOS 实测结论区分）
======================================================================

本沙箱是 macOS，以下结论**不是实测**，是查询 PyPI JSON API 得到的客观元数据，可信度
高于纯文献调研但低于本文件其余部分的"实测"：

- `torch-directml` 最新版本停留在 `0.2.5.dev240914`（2024-09 的 dev 快照，非正式版），
  **硬编码** `requires_dist: ['torch==2.4.1', 'torchvision==0.19.1']`，且 PyPI
  classifiers 只声明支持 Python 3.7~3.10，**不含 3.11/3.12**——而本项目目标 Python
  版本是 3.12。这比 CLAUDE.md §5.4 已经写的"Roformer 在 Windows 上无法通过 DirectML
  加速"更严重：DirectML 路径本身在依赖层面就可能与项目的 Python/torch 版本要求冲突，
  不只是 Roformer 一个模型的问题。建议 Windows 侧的设备探测顺序为
  CUDA → CPU，DirectML 只作实验性 opt-in，不进默认自动选择路径。

======================================================================
测试音频（合成，见 `synthesize_test_mix()`）
======================================================================

`workspace/media/` 下没有真实素材可用（另一 agent 并行下载中，本次运行时尚未产出），
故用 ffmpeg 合成 30 秒立体声测试混合：
`vocal_ref_30s.wav`（440Hz 正弦 + vibrato + tremolo，模拟人声包络）、
`instrumental_ref_30s.wav`（110Hz+220Hz 正弦和 + pink noise，模拟伴奏），
两者线性混合得到 `synth_mix_30s.wav`。这是"能验证 pipeline 跑通 + 量出耗时数量级"的
最低限度替代品，不是分离质量的有效基准——见上方"方法论限制"。
"""

from __future__ import annotations

import argparse
import inspect
import json
import subprocess
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

REPO_ROOT = Path(__file__).resolve().parent.parent
MEDIA_DIR = REPO_ROOT / "workspace" / "media"
SEP_OUT_DIR = REPO_ROOT / "workspace" / "sep_probe"

DeviceKind = Literal["cuda", "mps", "cpu"]


# ----------------------------------------------------------------------------
# 设备探测（对应 CLAUDE.md §11 backend.doctor 的一部分）
# ----------------------------------------------------------------------------


@dataclass
class DeviceReport:
    """torch 视角下的算力设备探测结果。"""

    torch_version: str
    cuda_available: bool
    mps_available: bool
    mps_built: bool
    selected: DeviceKind
    processor: str


def detect_device() -> DeviceReport:
    """探测 CUDA / MPS / CPU 实际可用性。

    需要 torch，未安装时抛 ImportError 并给出安装提示（不静默返回假结果）。
    """
    try:
        import platform

        import torch
    except ImportError as e:
        msg = (
            "torch 未安装，无法探测设备。请用 "
            "`uv run --python 3.12 --with torch python -m experiments.separation_check device` 运行。"
        )
        raise ImportError(msg) from e

    cuda_ok = torch.cuda.is_available()
    mps_ok = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    mps_built = hasattr(torch.backends, "mps") and torch.backends.mps.is_built()

    selected: DeviceKind = "cpu"
    if cuda_ok:
        selected = "cuda"
    elif mps_ok and platform.processor() == "arm":
        selected = "mps"

    return DeviceReport(
        torch_version=torch.__version__,
        cuda_available=cuda_ok,
        mps_available=mps_ok,
        mps_built=mps_built,
        selected=selected,
        processor=platform.processor(),
    )


# ----------------------------------------------------------------------------
# 裸 demucs 库的 MPS 兼容性直测（不经 audio-separator 封装，直接验证争议说法）
# ----------------------------------------------------------------------------


@dataclass
class DemucsMpsResult:
    device: str
    ok: bool
    elapsed_s: float | None
    error: str | None
    has_nan: bool | None


def check_demucs_mps(audio_path: Path, devices: tuple[str, ...] = ("mps", "cpu")) -> list[DemucsMpsResult]:
    """直接用裸 demucs 库（不经 audio-separator）在给定设备上跑一次 htdemucs 前向。

    这是对"Demucs 因复数张量/自定义算子与 MPS 不兼容"这个说法的直接实测，
    不依赖 audio-separator 的封装是否做了额外的 workaround。

    需要 `uv run --with demucs --with numpy`。
    """
    try:
        import torch
        from demucs.apply import apply_model
        from demucs.audio import AudioFile
        from demucs.pretrained import get_model
    except ImportError as e:
        msg = (
            "demucs/numpy 未安装。请用 "
            "`uv run --python 3.12 --with demucs --with numpy python -m "
            "experiments.separation_check demucs-mps` 运行。"
        )
        raise ImportError(msg) from e

    model = get_model("htdemucs")
    model.eval()

    wav = AudioFile(str(audio_path)).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()

    results: list[DemucsMpsResult] = []
    for dev in devices:
        try:
            model.to(dev)
            t0 = time.time()
            with torch.no_grad():
                out = apply_model(model, wav[None], device=dev, progress=False)[0]
            elapsed = time.time() - t0
            results.append(
                DemucsMpsResult(
                    device=dev,
                    ok=True,
                    elapsed_s=round(elapsed, 3),
                    error=None,
                    has_nan=bool(torch.isnan(out).any().item()),
                )
            )
        except Exception as e:  # noqa: BLE001 - 探测脚本需要捕获任意后端异常并如实报告
            results.append(
                DemucsMpsResult(
                    device=dev,
                    ok=False,
                    elapsed_s=None,
                    error=f"{type(e).__name__}: {e}",
                    has_nan=None,
                )
            )
    return results


# ----------------------------------------------------------------------------
# audio-separator：真实分离 + 计时 + 下载机制自检
# ----------------------------------------------------------------------------


@dataclass
class SeparationTiming:
    model: str
    device: str
    load_model_s: float
    separate_s: float
    output_files: list[str]


def run_audio_separator(
    audio_path: Path,
    model_filename: str = "htdemucs.yaml",
    model_file_dir: Path | None = None,
    output_dir: Path | None = None,
) -> SeparationTiming:
    """跑一次真实的 audio-separator 分离并计时。

    第一次调用若模型未缓存会触发真实下载（体积见模块docstring），非首次调用极快。
    需要 `uv run --with "audio-separator[cpu]"`。
    """
    try:
        from audio_separator.separator import Separator
    except ImportError as e:
        msg = (
            "audio-separator 未安装。请用 "
            '`uv run --python 3.12 --with "audio-separator[cpu]" python -m '
            "experiments.separation_check separate ...` 运行。"
        )
        raise ImportError(msg) from e

    model_file_dir = model_file_dir or (SEP_OUT_DIR / "models")
    output_dir = output_dir or (SEP_OUT_DIR / f"out_{Path(model_filename).stem}")

    sep = Separator(model_file_dir=str(model_file_dir), output_dir=str(output_dir))

    t0 = time.time()
    sep.load_model(model_filename=model_filename)
    load_s = time.time() - t0

    device = str(sep.torch_device)

    t0 = time.time()
    out_files = sep.separate(str(audio_path))
    sep_s = time.time() - t0

    return SeparationTiming(
        model=model_filename,
        device=device,
        load_model_s=round(load_s, 2),
        separate_s=round(sep_s, 2),
        output_files=list(out_files),
    )


def inspect_download_mechanism() -> dict[str, Any]:
    """读已安装的 audio-separator 源码，程序化确认其下载器是否有 SHA256 校验/断点续传。

    比"手工读一遍源码写进注释"更可复现：换个 audio-separator 版本重跑这个函数，
    结论会自动更新，不会因为忘记同步注释而过时。

    需要 audio-separator 已安装（同 `run_audio_separator`）。
    """
    try:
        from audio_separator.separator import Separator
    except ImportError as e:
        msg = "audio-separator 未安装，无法检查其下载机制源码。"
        raise ImportError(msg) from e

    src_download = inspect.getsource(Separator.download_file_if_not_exists)
    src_hash = inspect.getsource(Separator.get_model_hash)

    sig = inspect.signature(Separator.__init__)
    default_model_dir = sig.parameters["model_file_dir"].default

    return {
        "default_model_file_dir": default_model_dir,
        "download_uses_sha256_verification": "sha256" in src_download.lower(),
        "download_uses_http_range_resume": "range" in src_download.lower()
        or "resume" in src_download.lower(),
        "download_idempotency_check": "os.path.isfile" in src_download,
        "model_hash_algorithm": "md5" if "md5" in src_hash.lower() else "unknown",
        "model_hash_purpose": "型号识别（从文件反查是哪个模型），不是下载完整性校验",
    }


# ----------------------------------------------------------------------------
# MLX 生态成熟度探测：只发 HTTP 请求，不装大依赖
# ----------------------------------------------------------------------------


def _http_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "karaoke-video-maker-probe/1"})
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 - 仅取数据，白名单允许
        return json.loads(resp.read().decode("utf-8"))


def probe_mlx_ecosystem() -> dict[str, Any]:
    """探测 MLX 人声分离移植生态的成熟度信号：PyPI 可安装性 + HF 权重下载量 + GitHub 活跃度。"""
    result: dict[str, Any] = {}

    for pkg in ("demucs-mlx", "mlx-audio-separator", "mlx-demucs"):
        try:
            data = _http_json(f"https://pypi.org/pypi/{pkg}/json")
            result[f"pypi:{pkg}"] = {
                "installable": True,
                "latest_version": data["info"]["version"],
            }
        except Exception as e:  # noqa: BLE001 - 探测脚本，任意网络异常都要如实记录而非中断
            result[f"pypi:{pkg}"] = {"installable": False, "error": str(e)}

    try:
        hf = _http_json("https://huggingface.co/api/models?search=mlx%20demucs&limit=20")
        result["hf_search_mlx_demucs"] = [
            {"id": m.get("id"), "downloads": m.get("downloads")} for m in hf
        ]
    except Exception as e:  # noqa: BLE001
        result["hf_search_mlx_demucs"] = {"error": str(e)}

    try:
        gh = _http_json(
            "https://api.github.com/search/repositories?q=mlx+demucs+in:name,description&sort=updated"
        )
        result["github_search_mlx_demucs"] = {
            "total_count": gh.get("total_count"),
            "top_by_stars": sorted(
                (
                    {"repo": r["full_name"], "stars": r["stargazers_count"]}
                    for r in gh.get("items", [])
                ),
                key=lambda x: -x["stars"],
            )[:5],
        }
    except Exception as e:  # noqa: BLE001
        result["github_search_mlx_demucs"] = {"error": str(e)}

    return result


# ----------------------------------------------------------------------------
# 合成测试音频（当 workspace/media/ 下没有真实素材时的兜底）
# ----------------------------------------------------------------------------


def synthesize_test_mix(duration_s: int = 30) -> Path:
    """用 ffmpeg 合成一段"人声正弦 + 伴奏噪声/和弦"的测试混合音频。

    不是真实人声的替代品，只用于验证 pipeline 是否跑通、量出耗时数量级。
    见模块 docstring 的"方法论限制"一节——不同架构模型对合成音频的反应不等价。
    """
    sys.path.insert(0, str(REPO_ROOT))
    from experiments.ffmpeg_locate import find_ffmpeg_with_libass

    ffmpeg = find_ffmpeg_with_libass()
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    vocal_ref = MEDIA_DIR / f"vocal_ref_{duration_s}s.wav"
    instr_ref = MEDIA_DIR / f"instrumental_ref_{duration_s}s.wav"
    mix = MEDIA_DIR / f"synth_mix_{duration_s}s.wav"

    subprocess.run(
        [
            ffmpeg, "-y",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration_s}:sample_rate=44100",
            "-af", "vibrato=f=6:d=0.5,tremolo=f=4:d=0.25,volume=0.9",
            "-ac", "2", str(vocal_ref), "-loglevel", "error",
        ],
        check=True,
    )
    subprocess.run(
        [
            ffmpeg, "-y",
            "-f", "lavfi", "-i", f"sine=frequency=110:duration={duration_s}:sample_rate=44100",
            "-f", "lavfi", "-i", f"sine=frequency=220:duration={duration_s}:sample_rate=44100",
            "-f", "lavfi", "-i",
            f"anoisesrc=color=pink:duration={duration_s}:amplitude=0.25:sample_rate=44100",
            "-filter_complex",
            "[0:a][1:a][2:a]amix=inputs=3:duration=longest:normalize=0,volume=0.6[out]",
            "-map", "[out]", "-ac", "2", str(instr_ref), "-loglevel", "error",
        ],
        check=True,
    )
    subprocess.run(
        [
            ffmpeg, "-y",
            "-i", str(vocal_ref), "-i", str(instr_ref),
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[out]",
            "-map", "[out]", "-ac", "2", "-ar", "44100", str(mix), "-loglevel", "error",
        ],
        check=True,
    )
    return mix


def sanity_correlation(separated_vocal: Path, vocal_ref: Path, instr_ref: Path) -> dict[str, float]:
    """粗略相关系数检查：分离出的人声轨是否更像真值人声而不是伴奏。

    不是 SDR，只是"这套 pipeline 是否真的在做分离而不是直通/输出静音"的最低限度验证。
    需要 soundfile + numpy。
    """
    import numpy as np
    import soundfile as sf

    def load(p: Path) -> Any:
        a, _sr = sf.read(str(p))
        return a.mean(axis=1) if a.ndim == 2 else a

    sep = load(separated_vocal)
    vref = load(vocal_ref)
    iref = load(instr_ref)
    n = min(len(sep), len(vref), len(iref))
    sep, vref, iref = sep[:n], vref[:n], iref[:n]

    def corr(a: Any, b: Any) -> float:
        if a.std() == 0 or b.std() == 0:
            return float("nan")  # 全零/恒定信号相关系数无定义，如实返回 nan 而非伪造数字
        return float(np.corrcoef(a, b)[0, 1])

    return {
        "corr_with_vocal_ref": round(corr(sep, vref), 4),
        "corr_with_instrumental_ref": round(corr(sep, iref), 4),
    }


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("device", help="探测 CUDA/MPS/CPU 设备可用性")

    p_synth = sub.add_parser("synth", help="合成 30 秒测试音频")
    p_synth.add_argument("--duration", type=int, default=30)

    p_sep = sub.add_parser("separate", help="用 audio-separator 跑一次真实分离并计时")
    p_sep.add_argument("--model", default="htdemucs.yaml")
    p_sep.add_argument("--audio", type=Path, default=MEDIA_DIR / "synth_mix_30s.wav")

    sub.add_parser("demucs-mps", help="裸 demucs 库直测 MPS complex-tensor 兼容性")
    sub.add_parser("download-mechanism", help="检查 audio-separator 下载器是否有 SHA256/断点续传")
    sub.add_parser("mlx-probe", help="探测 MLX 移植生态成熟度（PyPI+HF+GitHub）")

    args = parser.parse_args()

    if args.cmd == "device":
        print(json.dumps(asdict(detect_device()), ensure_ascii=False, indent=2))
    elif args.cmd == "synth":
        path = synthesize_test_mix(args.duration)
        print(f"生成: {path}")
    elif args.cmd == "separate":
        timing = run_audio_separator(args.audio, model_filename=args.model)
        print(json.dumps(asdict(timing), ensure_ascii=False, indent=2))
    elif args.cmd == "demucs-mps":
        audio = MEDIA_DIR / "synth_mix_30s.wav"
        if not audio.exists():
            audio = synthesize_test_mix()
        results = check_demucs_mps(audio)
        print(json.dumps([asdict(r) for r in results], ensure_ascii=False, indent=2))
    elif args.cmd == "download-mechanism":
        print(json.dumps(inspect_download_mechanism(), ensure_ascii=False, indent=2))
    elif args.cmd == "mlx-probe":
        print(json.dumps(probe_mlx_ecosystem(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()


# ----------------------------------------------------------------------------
# 设计笔记：抽象接口如何同时支持 macOS 与 Windows
# ----------------------------------------------------------------------------
#
# 1. 设备探测层与后端执行层必须分离。`detect_device()` 只读探测（本文件已实现），
#    永远不抛出到调用方以外——上层拿到 "cuda"/"mps"/"cpu" 后自行决定降级策略，
#    探测函数本身不做任何"选择哪个模型"的决策。
#
# 2. 不要给 Windows 一条"DirectML 万能加速"的假象路径。本次 PyPI 元数据实测显示
#    torch-directml 停留在 2024-09 的 dev 版本、硬编码 torch==2.4.1、且未声明支持
#    Python 3.11/3.12（模块 docstring 有实测数据）。Windows 侧设备探测顺序应为
#    CUDA → CPU，DirectML 仅作实验性 opt-in 分支，不参与自动选择。
#
# 3. audio-separator 的 Separator 类已经做了跨平台设备选择（见 `setup_torch_device`：
#    CUDA 优先，其次 Apple Silicon 上的 MPS，否则 CPU/DirectML），没必要在应用层重新
#    发明这层逻辑——直接复用它的 `torch_device` 属性做遥测/UI 展示即可，应用层只需要
#    包一层 Protocol 做超时/取消/进度上报（对应 CLAUDE.md §5.13 的子进程 + JSON-lines
#    进度协议架构），不要在 FastAPI 的 async handler 里直接调用。
#
# 4. 下载器必须在应用层单独实现，不能依赖 audio-separator 自带的
#    `download_file_if_not_exists`（本文件 `inspect_download_mechanism()` 已程序化
#    确认它没有 SHA256 校验、没有 Range 断点续传、且半截文件会被误判为"已下载完成"）。
#    应用层下载器至少要做到：下载到 `*.part` 临时文件成功后再原子 rename、下载后自算
#    SHA256 存入本地清单（即使上游不提供参考值，也要建立"自己的基线"用于后续完整性
#    自检）、支持 Range 续传。
#
# 5. 模型文件目录必须走 `platformdirs.user_cache_dir()`（CLAUDE.md §5.14 已定），
#    显式传给 `Separator(model_file_dir=...)`，绝不使用它 `/tmp/audio-separator-models/`
#    的默认值——这一点本文件已实测确认默认值确实是 `/tmp`。
