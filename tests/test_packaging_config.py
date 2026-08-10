"""打包时必须显式收集的第三方数据（`scripts/package.py`）。

起因是一个真实的发布阻断项：**`torchcrepe` 的 `.py` 进了包、89 MB 的权重一个没进**。
PyInstaller 只把源码收进 PYZ，凡是按 `__file__` / `importlib.resources` 就地找数据
文件的包，都要在 `COLLECT_ALL` / `COLLECT_DATA` 里点名——漏掉不会让打包失败，
而是让**装完的应用跑到那一步才报文件不存在**，正是最贵的那种发现时机。

这里的用例分两半，缺一不可：

- **配置侧**：那几个包必须还在收集单子上（有人"清理无用配置"时会红）。
- **上游侧**：断言它们的数据文件**当下确实还按 `__file__` 相邻摆着**。只测配置是不够的
  ——上游哪天改成运行时下载权重，配置照样"正确"，而包里的东西已经没用了。

同理，`--lean` 下不允许同一个包既被收集又被排除：那种自相矛盾的命令行要靠读
PyInstaller 的取舍规则才能预测，不如从源头上不产生。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    # 本项目不做 editable install，脚本目录不是包，测试自带路径引导（同 test_version.py）
    sys.path.insert(0, str(_SCRIPTS))

import package as pkg  # noqa: E402


def _installed(name: str) -> bool:
    """包是否装在当前环境里。`--minimal` 装法下这些 extras 可能都不在。"""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def test_torchcrepe_is_collected() -> None:
    """引导声的音高模型权重必须随包走（§8.9：CREPE 是引导声的必经路径）。"""
    assert "torchcrepe" in pkg.COLLECT_DATA or "torchcrepe" in pkg.COLLECT_ALL


def test_audio_separator_is_collected_whole() -> None:
    """人声分离要的不只是数据文件，还有动态 import 的架构类，所以必须整包收。"""
    assert "audio_separator" in pkg.COLLECT_ALL


def test_ytdlp_is_collected() -> None:
    assert "yt_dlp" in pkg.COLLECT_DATA or "yt_dlp" in pkg.COLLECT_ALL


@pytest.mark.skipif(not _installed("torchcrepe"), reason="未装 torchcrepe")
def test_torchcrepe_weights_sit_next_to_the_module() -> None:
    """torchcrepe 仍按 `os.path.dirname(__file__)/assets/{capacity}.pth` 取权重。

    这条一旦不成立（上游改成运行时下载），`--collect-data torchcrepe` 就成了
    收一堆没人读的字节，得换成 §5.14 那套显式下载。
    """
    import torchcrepe

    assets = Path(torchcrepe.__file__).parent / "assets"
    # full 是 `GuideConfig.crepe_model` 的默认值；tiny 是 `--guide-crepe-model tiny`
    # 给纯 CPU 机器留的退路，只多 2 MB，两个都得在。
    for capacity in ("full", "tiny"):
        assert (assets / f"{capacity}.pth").is_file(), f"torchcrepe 权重 {capacity} 不在原处"


@pytest.mark.skipif(not _installed("audio_separator"), reason="未装 audio-separator")
def test_audio_separator_model_list_is_package_data() -> None:
    """`load_model()` 必经的模型清单仍是随包的数据文件，不是运行时下载的。"""
    import audio_separator

    root = Path(audio_separator.__file__).parent
    assert (root / "models.json").is_file()
    assert (root / "models-scores.json").is_file()


@pytest.mark.skipif(not _installed("yt_dlp"), reason="未装 yt-dlp")
def test_ytdlp_solver_scripts_are_package_data() -> None:
    """YouTube JS 挑战的求解脚本仍随包走（§5.1：这条链路会反复失效，退路要留着）。"""
    import yt_dlp

    vendor = Path(yt_dlp.__file__).parent / "extractor/youtube/jsc/_builtin/vendor"
    assert list(vendor.glob("*.js")), "yt-dlp 的 vendored 求解脚本不在原处"


def test_always_excluded_is_never_collected() -> None:
    """默认打包（非 `--lean`）下，不许出现"既收集又排除"的自相矛盾命令行。

    这一条不带过滤，测的就是两张单子本身：`ALWAYS_EXCLUDE` 永远生效，
    往收集单子里加包时撞上它必须当场红，而不是留给 PyInstaller 去仲裁。
    """
    assert not (set(pkg.COLLECT_ALL + pkg.COLLECT_DATA) & set(pkg.ALWAYS_EXCLUDE))


def test_lean_really_drops_the_heavy_collected_packages() -> None:
    """`--lean` 的意义是甩掉重依赖，所以被它排除的包同时也得停止收集。

    `build_backend()` 靠"在 `excluded` 里就跳过"实现这件事；这里守的是前提——
    重依赖必须真的列在 `HEAVY_MODULES` 里，否则那段过滤对它们不起作用。
    """
    heavy = set(pkg.HEAVY_MODULES)
    for name in ("torchcrepe", "audio_separator"):
        assert name in heavy, f"{name} 被收集但不在 HEAVY_MODULES 里，--lean 甩不掉它"
