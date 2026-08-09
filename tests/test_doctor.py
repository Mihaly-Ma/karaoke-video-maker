"""环境自检（`kvm.doctor`）与 ffmpeg 解析层的测试。

这里的重点**不是"全绿时报告全绿"**——那种测试等于没测。本项目已经吃过一次亏：
有个验证脚本只建一个 JASSUB 实例，结构上根本抓不到"第二个 worker 起不来"的
bug，于是它一直是绿的，而 Safari 上压根没有字幕。

所以下面每一条都在问同一个问题：**环境坏掉时，自检真的会报错吗？**

- 装了 ffmpeg 但不带 libass（macOS 上 `brew install ffmpeg` 的默认结果）→ 必须失败
- 滤镜**描述**里出现 "ass" 字样 → 不能被误判成可用（判据是滤镜名那一列）
- `KVM_FFMPEG` 指了个坏的 → 必须失败，**不许静默换用别的 ffmpeg**
- 自检模块自身在依赖缺失的环境里 → 必须还能跑起来（否则最需要它时正好没有）
"""

from __future__ import annotations

import socket
import subprocess
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm import doctor  # noqa: E402
from kvm.media import ffmpeg as ffmpeg_mod  # noqa: E402

pytestmark = pytest.mark.skipif(
    sys.platform.startswith("win"), reason="用 /bin/sh 脚本做 ffmpeg 替身，Windows 上不适用"
)

# ---- 夹具：假 ffmpeg ----

# 不带 libass 的 ffmpeg。**滤镜描述里故意出现 "ass"**：判据必须是滤镜名那一列，
# 而不是"输出里有没有 ass 这三个字母"——后者会把这台机器误判成可用，
# 然后一路跑到烧录才失败。
_SHIM_WITHOUT_ASS = """#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-filters" ]; then
    echo "Filters:"
    echo " ... lowpass           A->A       Apply a low-pass filter."
    echo " ... subtitles         V->V       Render text subtitles (ass/srt) onto input video."
    exit 0
  fi
  if [ "$a" = "-version" ]; then echo "ffmpeg version 0.0-fake-no-libass"; exit 0; fi
done
exit 0
"""

_SHIM_WITH_ASS = """#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-filters" ]; then
    echo "Filters:"
    echo " ... ass               V->V       Render ASS subtitles onto input video using libass."
    echo " ... scale             V->V       Scale the input video size."
    exit 0
  fi
  if [ "$a" = "-version" ]; then echo "ffmpeg version 0.0-fake-with-libass"; exit 0; fi
done
exit 0
"""


def _shim(directory: Path, body: str, name: str = "ffmpeg") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)
    return path


# ---- 能力判据 ----


def test_不带libass的ffmpeg被判为不可用(tmp_path: Path) -> None:
    assert ffmpeg_mod.has_libass(str(_shim(tmp_path, _SHIM_WITHOUT_ASS))) is False


def test_带libass的ffmpeg被判为可用(tmp_path: Path) -> None:
    assert ffmpeg_mod.has_libass(str(_shim(tmp_path, _SHIM_WITH_ASS))) is True


def test_滤镜描述里的ass不算数(tmp_path: Path) -> None:
    """`subtitles` 那行的描述里有 "ass"，若判据写成子串匹配就会误判为可用。"""
    out = subprocess.run(
        [str(_shim(tmp_path, _SHIM_WITHOUT_ASS)), "-hide_banner", "-filters"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "ass" in out, "夹具本身要含 ass 字样，否则这条测试没在测它想测的东西"
    assert ffmpeg_mod.has_libass(str(tmp_path / "ffmpeg")) is False


def test_不存在的路径不会崩(tmp_path: Path) -> None:
    assert ffmpeg_mod.has_libass(str(tmp_path / "根本没有这个文件")) is False


# ---- 解析顺序（CLAUDE.md §2.6） ----


def test_环境变量指向坏ffmpeg时必须失败而不是回退(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**这是本文件最重要的一条。**

    用户显式指定的 ffmpeg 不合格时，若悄悄换用系统里另一个"碰巧能用"的，
    预览与导出就可能落到不同的 libass 上——而这类分叉要到成片里才暴露
    （§5.12）。所以必须失败，且理由要说清是哪个环境变量。
    """
    bad = _shim(tmp_path / "bad", _SHIM_WITHOUT_ASS)
    good_dir = tmp_path / "good"
    _shim(good_dir, _SHIM_WITH_ASS)

    monkeypatch.setenv(ffmpeg_mod.ENV_FFMPEG, str(bad))
    monkeypatch.setattr(ffmpeg_mod, "CANDIDATES", [str(good_dir / "ffmpeg")])
    monkeypatch.setattr(ffmpeg_mod.paths, "private_bin_dir", lambda: tmp_path / "空的私有目录")

    probe = ffmpeg_mod.probe_ffmpeg()
    assert probe.ok is False
    assert probe.override_rejected is not None
    assert ffmpeg_mod.ENV_FFMPEG in probe.override_rejected

    with pytest.raises(RuntimeError, match=ffmpeg_mod.ENV_FFMPEG):
        ffmpeg_mod.find_ffmpeg_with_libass()


def test_环境变量指向好ffmpeg时被采纳(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    good = _shim(tmp_path / "good", _SHIM_WITH_ASS)
    monkeypatch.setenv(ffmpeg_mod.ENV_FFMPEG, str(good))
    monkeypatch.setattr(ffmpeg_mod, "CANDIDATES", [])
    monkeypatch.setattr(ffmpeg_mod.paths, "private_bin_dir", lambda: tmp_path / "空的私有目录")

    probe = ffmpeg_mod.probe_ffmpeg()
    assert probe.path == str(good)
    assert probe.origin.startswith(ffmpeg_mod.ENV_FFMPEG)


def test_应用私有目录优先于系统探测(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """§2.6 的解析顺序：私有目录排第一，因为它的版本已知（§5.12 两端同源）。"""
    private_dir = tmp_path / "private"
    private = _shim(private_dir, _SHIM_WITH_ASS)
    system_dir = tmp_path / "system"
    _shim(system_dir, _SHIM_WITH_ASS)

    monkeypatch.delenv(ffmpeg_mod.ENV_FFMPEG, raising=False)
    monkeypatch.setattr(ffmpeg_mod.paths, "private_bin_dir", lambda: private_dir)
    monkeypatch.setattr(ffmpeg_mod, "CANDIDATES", [str(system_dir / "ffmpeg")])

    probe = ffmpeg_mod.probe_ffmpeg()
    assert probe.path == str(private)
    assert probe.origin == "应用私有目录"


def test_全都不带libass时报失败并给出安装命令(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """模拟"只装了 Homebrew 主线 ffmpeg"这台最常见的机器。"""
    bad_dir = tmp_path / "bad"
    _shim(bad_dir, _SHIM_WITHOUT_ASS)
    monkeypatch.delenv(ffmpeg_mod.ENV_FFMPEG, raising=False)
    monkeypatch.setattr(ffmpeg_mod.paths, "private_bin_dir", lambda: tmp_path / "空的")
    monkeypatch.setattr(ffmpeg_mod, "CANDIDATES", [str(bad_dir / "ffmpeg")])

    results = doctor.check_ffmpeg()
    ffmpeg_check = next(c for c in results if c.key == "ffmpeg")
    assert ffmpeg_check.status == "fail"
    assert ffmpeg_check.blocking is True
    assert ffmpeg_check.fix, "失败必须附一条可直接复制粘贴的命令，而不是一句'请安装 X'"

    report = doctor.Report(checks=results)
    assert report.ok is False, "ffmpeg 是启动的硬前提，不通过就不该放行"


# ---- 报告聚合语义 ----


def test_阻断项失败会拦住启动() -> None:
    report = doctor.Report(
        checks=[
            doctor.CheckResult("a", "甲", "ok", "没问题"),
            doctor.CheckResult("b", "乙", "fail", "坏了", fix="修它", blocking=True),
        ]
    )
    assert report.ok is False
    assert [c.key for c in report.blocking_failures] == ["b"]


def test_非阻断项失败不拦启动() -> None:
    """§2.5：失败要降级，不能终止。缺分离依赖只是少一块功能，不该拦住整个应用。"""
    report = doctor.Report(
        checks=[
            doctor.CheckResult("a", "甲", "ok", "没问题"),
            doctor.CheckResult("b", "乙", "warn", "少了点东西", affects="分离不可用"),
            doctor.CheckResult("c", "丙", "fail", "也坏了", blocking=False),
        ]
    )
    assert report.ok is True
    assert len(report.failures) == 1
    assert report.blocking_failures == []


def test_报告里失败项必须带处理办法() -> None:
    report = doctor.Report(
        checks=[doctor.CheckResult("x", "某项", "fail", "炸了", fix="来一发这个命令", blocking=True)],
        generated_at="现在",
    )
    text = doctor.render_report(report)
    assert "来一发这个命令" in text
    assert "硬前提" in text


def test_通过项不打印处理办法() -> None:
    """通过的项目不该在报告里塞一堆"处理："，否则报告没法一眼扫。"""
    report = doctor.Report(
        checks=[doctor.CheckResult("x", "某项", "ok", "好着呢", fix="不该出现")],
        generated_at="现在",
    )
    assert "不该出现" not in doctor.render_report(report)


def test_中日文标题按显示宽度对齐() -> None:
    """中文是双宽字符，用字符数补空格会让报告整体错位。"""
    assert doctor._pad("平台", 10) == "平台" + " " * 6
    assert doctor._pad("uv", 10) == "uv" + " " * 8


# ---- 端口 ----


def test_被占用的端口会被检出() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        port = holder.getsockname()[1]

        result = doctor.check_port(port, label="backend")
        assert result.status == "fail"
        assert result.blocking is True


def test_空闲端口判为可用() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    assert doctor.check_port(port, label="backend").status == "ok"


@pytest.mark.skipif(not socket.has_ipv6, reason="本机没有 IPv6")
def test_只占用IPv6回环的端口也要被检出() -> None:
    """**实测踩过的坑**：Vite 只监听 IPv6 回环（`lsof` 显示 `[::1]:5173`）。

    只查 127.0.0.1 会把"还开着一个旧 Vite"报成端口可用，然后 `--strictPort`
    才炸，用户看到的是 Vite 的报错而不是自检的提示——正是自检该拦下来的那类
    问题却从它眼皮底下溜过去了。
    """
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as holder:
        holder.bind(("::1", 0))
        holder.listen(1)
        port = holder.getsockname()[1]

        result = doctor.check_port(port, label="frontend")
        assert result.status == "fail", "只占 IPv6 回环也必须判为被占用"
        assert "::1" in result.detail


# ---- Python 依赖分组 ----


def test_缺api依赖属于阻断项而缺分离依赖只是警告(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor, "_module_present", lambda name: False)
    by_key = {c.key: c for c in doctor.check_python_extras()}

    assert by_key["extra_api"].status == "fail"
    assert by_key["extra_api"].blocking is True

    assert by_key["extra_separate"].status == "warn"
    assert by_key["extra_separate"].blocking is False
    assert by_key["extra_separate"].affects, "非阻断项必须说清用户在放弃什么功能"
    assert by_key["extra_separate"].fix == "uv sync --extra separate"


def test_extra表与pyproject的extra名一一对应() -> None:
    """自检的分组名写错，用户照着 `uv sync --extra <名字>` 敲会直接报错。"""
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    for extra in doctor._EXTRA_MODULES:
        assert f"\n{extra} = [" in pyproject, f"pyproject.toml 里没有名为 {extra} 的 extra"


def test_每个extra都登记了阻断性与影响说明() -> None:
    assert set(doctor._EXTRA_MODULES) == set(doctor._EXTRA_META)


# ---- 自检模块本身必须在"依赖没装好"的环境里能跑 ----


def test_导入自检模块不会拉起第三方依赖() -> None:
    """自检要在依赖缺失时给出报告，所以它自己不能依赖那些依赖。

    这条守的是一个很容易在重构中破掉的约束：某天顺手在 doctor 里
    `from kvm.api.schemas import ...`，自检就会在最该工作的环境里
    以 ImportError 收场——而那时用户看到的只是一个 traceback。
    """
    code = (
        f"import sys; sys.path.insert(0, {str(_BACKEND)!r});"
        "import kvm.doctor;"
        "leaked = [m for m in ('pydantic','fastapi','torch','numpy','librosa') if m in sys.modules];"
        "print(','.join(leaked))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True, timeout=120
    )
    assert out.stdout.strip() == "", f"import kvm.doctor 顺带拉起了第三方包：{out.stdout.strip()}"


def test_档位表取自separate模块而不是抄一份() -> None:
    """模型档位只有一个真相来源。抄一份迟早和 separate.py 漂移。"""
    tiers = doctor._tier_filenames()
    if tiers is None:
        pytest.skip("当前环境读不到档位表（缺可选依赖），这本身是允许的降级路径")
    from kvm.media.separate import MODEL_TIERS

    assert tiers == [(t.id, t.model_filename) for t in MODEL_TIERS]


def test_找得到仓库根() -> None:
    root = doctor.find_repo_root()
    assert root is not None
    assert (root / "pyproject.toml").is_file()
