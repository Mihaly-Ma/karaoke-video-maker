"""人声分离的**模型标识约定**与**声部名归一化**回归测试。

这两处此前各埋了一个必现故障，三档里有两档从来没跑通过：

1. 前端传的是"去掉扩展名的模型文件名"（`mel_band_roformer_kim_ft_unwa` /
   `model_bs_roformer_ep_317_sdr_12.9755`），后端的别名表却按**档位名**建
   （`fast`/`standard`/`best`）。两边对不上 → 字符串被当字面 model_filename
   直传 audio-separator → 缺 `.ckpt` 后缀 → `ValueError: Model file ... not
   found in supported model files`。只有 `htdemucs` 恰好同时是别名键才能用。
2. 各模型输出的声部名大小写与用词并不统一（htdemucs 给 `(Vocals)`，
   BS-Roformer 给 `(Vocals)/(Instrumental)`，mel_band_roformer_kim_ft_unwa
   给的是小写 `(vocals)/(other)`）。不归一化的话，即便模型名修好了，标准档
   仍会在整理产物那步报"输出文件类型无法识别"。

本文件只测纯函数，不跑真模型（真机三档 30 秒实测另行记录）。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.media.separate import (  # noqa: E402
    MODEL_ALIASES,
    MODEL_TIERS,
    ModelResolutionError,
    _resolve_model_filename,
    _resolve_supported_model,
    _stem_key_from_filename,
    _supported_model_filenames,
)

# audio-separator 0.44.5 的 `list_supported_model_files()` 真实结构片段
# （`{架构: {友好名: {"filename": ..., ...}}}`），只留本项目用到的三个模型。
_SUPPORTED_SAMPLE: dict[str, dict[str, dict[str, object]]] = {
    "Demucs": {
        "Demucs v4: htdemucs": {"filename": "htdemucs.yaml", "download_files": []},
    },
    "MDXC": {
        "MDXC Model: Kim FT unwa": {
            "filename": "mel_band_roformer_kim_ft_unwa.ckpt",
            "download_files": [],
        },
        "Roformer Model: BS-Roformer-Viperx-1297": {
            "filename": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
            "download_files": [],
        },
    },
}


class _FakeSeparator:
    """只提供 `list_supported_model_files()` 的替身——真 Separator 会拉起 torch。"""

    def list_supported_model_files(self) -> dict[str, dict[str, dict[str, object]]]:
        return _SUPPORTED_SAMPLE


def _supported() -> list[str]:
    return _supported_model_filenames(_FakeSeparator())


# ---- 档位表本身的自洽性 ----


def test_三档齐全且各自有唯一的档位名() -> None:
    assert [tier.id for tier in MODEL_TIERS] == ["fast", "standard", "best"]


def test_恰好一个推荐档() -> None:
    # 前端拿"recommended 为真的那一项"当默认选中，多于一个就等于默认值不确定
    assert sum(1 for tier in MODEL_TIERS if tier.recommended) == 1


def test_每个档位的模型文件名都带扩展名且真实存在() -> None:
    supported = _supported()
    for tier in MODEL_TIERS:
        assert tier.model_filename in supported, tier.id


def test_档位名都能解析成模型文件名() -> None:
    for tier in MODEL_TIERS:
        assert _resolve_model_filename(tier.id) == tier.model_filename


def test_htdemucs_这个历史写法仍指向快速档() -> None:
    # `SeparateRequest.model` 的默认值与 CLAUDE.md §5.4 都用它指代快速档
    assert MODEL_ALIASES["htdemucs"] == "htdemucs.yaml"


# ---- 容错解析：这正是三档里两档跑不通的那个坑 ----


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        # 旧前端传的两个"去掉扩展名的文件名"——修复前必然报 ValueError
        ("mel_band_roformer_kim_ft_unwa", "mel_band_roformer_kim_ft_unwa.ckpt"),
        ("model_bs_roformer_ep_317_sdr_12.9755", "model_bs_roformer_ep_317_sdr_12.9755.ckpt"),
        ("htdemucs", "htdemucs.yaml"),
        # 完整文件名原样通过
        ("htdemucs.yaml", "htdemucs.yaml"),
        # 大小写不敏感
        ("HTDEMUCS.YAML", "htdemucs.yaml"),
        # 唯一前缀匹配
        ("mel_band_roformer_kim", "mel_band_roformer_kim_ft_unwa.ckpt"),
    ],
)
def test_容错解析能补全扩展名与前缀(requested: str, expected: str) -> None:
    assert _resolve_supported_model(requested, _supported()) == expected


def test_彻底不认识的标识报中文错误并列出可用档位() -> None:
    with pytest.raises(ModelResolutionError) as exc:
        _resolve_supported_model("完全不存在的模型", _supported())
    message = str(exc.value)
    for tier in MODEL_TIERS:
        assert tier.id in message
        assert tier.label in message


def test_前缀匹配到多个候选时不猜而是报错() -> None:
    with pytest.raises(ModelResolutionError) as exc:
        _resolve_supported_model("model", ["model_a.ckpt", "model_b.ckpt"])
    assert "model_a.ckpt" in str(exc.value)
    assert "model_b.ckpt" in str(exc.value)


# ---- 声部名归一化 ----


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("clip_(Vocals)_htdemucs.wav", "Vocals"),
        ("clip_(Instrumental)_model_bs_roformer.wav", "Instrumental"),
        # 标准档实测就是小写，且伴奏那一轨叫 other 而不是 instrumental
        ("clip_(vocals)_mel_band_roformer_kim_ft_unwa.wav", "Vocals"),
        ("clip_(other)_mel_band_roformer_kim_ft_unwa.wav", "Other"),
        ("clip_(Bass)_htdemucs.wav", "Bass"),
        ("clip_no_parens.wav", None),
    ],
)
def test_声部名归一化(filename: str, expected: str | None) -> None:
    assert _stem_key_from_filename(filename) == expected
