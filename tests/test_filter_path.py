"""ffmpeg 滤镜图里的路径转义。

## 为什么这组测试必须存在

滤镜串要过**两层**解析：filtergraph 层拆 `,` 与 `[]`，filter option 层按 `:`
拆键值对。Windows 绝对路径的 `C:` 正好撞上后者，而失败方式极具欺骗性——
报的不是"找不到文件"，而是**下一个选项收到了路径的后半截**：

    Unable to parse "original_size" option value "/Users/..." as image size

看起来与路径毫无关系，实际是 `ass=C:/Users/x.ass` 被切成了 `f=C` 和
`original_size=/Users/x.ass`。症状是字幕预览与字体度量整条链路 500，
而 ffmpeg 自检是通过的。

**转义形式是实测出来的，不是推导的**：`C\\:/x` 与 `C\\\\:/x` 两种写法在真机上
都失败，只有单引号包裹成立。所以这里既钉死输出形状，也**真的调一次 ffmpeg**——
形状对而 ffmpeg 不认，等于没修。

## 这组测试同时是 macOS 的保险

修复动机来自 Windows，但改动落在**两个平台共用**的那一行上：macOS 路径没有
冒号，转义前后的区别只是多了一对单引号。那对引号在 mac 的 ffmpeg 上是否同样
被正确剥离，Windows 机器上验证不了。因此真实渲染用例不做平台限定——在 mac 上
跑到它，就是在验证这件事；不成立的话这里会红，而不是等用户发现预览坏了。

顺带覆盖含空格的目录：单引号包裹对它也是必需的，而临时目录默认不含空格，
不显式构造就永远测不到。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.media.ffmpeg import escape_filter_path  # noqa: E402

# ---- 输出形状 ----


def test_windows盘符的冒号被转义且整体带引号() -> None:
    assert escape_filter_path(r"C:\work\lyrics.ass") == r"'C\:/work/lyrics.ass'"


def test_posix路径不含冒号但同样带引号() -> None:
    """macOS/Linux 上的形状：只多一对引号，路径本身原样。"""
    assert escape_filter_path("/Users/mihaly/工程/lyrics.ass") == "'/Users/mihaly/工程/lyrics.ass'"


def test_反斜杠一律转成正斜杠() -> None:
    """滤镜图里 `\\` 是转义引导符，留着它会把后面的字符吃掉。"""
    assert "\\" not in escape_filter_path(r"D:\a\b\c.ass").replace(r"\:", "")


def test_含空格的路径不被拆开() -> None:
    out = escape_filter_path("/tmp/my project/lyrics.ass")
    assert out.startswith("'") and out.endswith("'")
    assert "my project" in out


# ---- 真实渲染（两个平台都要跑到） ----


@pytest.fixture(scope="module")
def ffmpeg_bin() -> str:
    from kvm.media.ffmpeg import find_ffmpeg_with_libass

    try:
        return find_ffmpeg_with_libass()
    except RuntimeError as exc:  # 没有带 libass 的 ffmpeg 就没什么可验的
        pytest.skip(f"需要带 libass 的 ffmpeg：{exc}")


_MINIMAL_ASS = """[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 100

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Alignment, MarginL, MarginR, MarginV, Encoding
Style: D,Arial,40,&H00FFFFFF,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,0:00:00.00,0:00:01.00,D,TEST
"""


def _render_gray(ffmpeg: str, ass_path: Path) -> bytes:
    import subprocess

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x100:d=1:r=1",
        "-vf",
        f"ass={escape_filter_path(ass_path)}",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=300)
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace")[:500]
        pytest.fail(f"ffmpeg 不接受这个转义后的路径：{detail}")
    return proc.stdout


def test_转义后的路径ffmpeg真的认(tmp_path: Path, ffmpeg_bin: str) -> None:
    """光有形状不算数：ffmpeg 收下并真的画出了字。"""
    ass = tmp_path / "m.ass"
    ass.write_text(_MINIMAL_ASS, encoding="utf-8")

    raw = _render_gray(ffmpeg_bin, ass)

    assert len(raw) == 640 * 100, f"输出尺寸不对：{len(raw)}"
    # 断言"画出了字"而不只是"没报错"：滤镜被静默忽略时会得到一张纯黑图，
    # 那种情况下 returncode 同样是 0。
    assert sum(1 for b in raw if b > 40) > 50, "渲染结果几乎全黑，字幕没有真正生效"


def test_目录含空格时依然渲染成功(tmp_path: Path, ffmpeg_bin: str) -> None:
    d = tmp_path / "my project"
    d.mkdir()
    ass = d / "m.ass"
    ass.write_text(_MINIMAL_ASS, encoding="utf-8")

    raw = _render_gray(ffmpeg_bin, ass)

    assert sum(1 for b in raw if b > 40) > 50
