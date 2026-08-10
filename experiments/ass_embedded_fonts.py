"""实测：字体链在 ffmpeg 侧到底靠什么生效——内嵌字体真的能接管缺字回退吗。

## 为什么必须实测这一条

字体链（`KaraokeStyle.font_names`）的整个机制建立在一个假设上：
**把整条链的字节交给 libass，它就会在这条链内部做字形回退。**

预览侧这条假设成立得很干脆——JASSUB 用 `ASS_FONTPROVIDER_NONE`，手里只有我们喂进去的
那几份字体，除了它们无处可退。导出侧则相反：ffmpeg 用 `ASS_FONTPROVIDER_AUTODETECT`，
CoreText / DirectWrite / fontconfig **无法禁用**（`fontsdir` 只是追加搜索路径）。
于是同一个生僻字，预览由链里第二个字体画、成片却可能由系统里某个字体画——
两端分叉，而 §5.12 的 WYSIWYG 正是要杜绝这个。

所以到底怎样才能让内嵌字体接管回退，**决定了导出侧这套机制成不成立**，
不能靠读文档或猜 libass 的打分函数，必须在本机这套 ffmpeg 上量出来。

## 两种嵌法，量的就是它们的差别

| 策略 | 链里各字体的族名 | ASS 的 `Fontname` |
|---|---|---|
| `distinct`（想当然的做法） | 各自保留自己的族名 | 链首的族名 |
| `samefamily`（本项目采用） | **全部改写成同一个族名** | 那个族名 |

`distinct` 依赖"libass 会翻遍已加载字体找带这个字形的那个"；
`samefamily` 只依赖"同族多个字面里挑一个有该字形的"——后者是字体匹配的基本功能，
不是回退启发式。

## 怎么量才不会假通过

判据不能是"画出来了"——系统回退一样画得出来，画面上有字说明不了任何事。
本脚本用**换掉链尾**的办法：链首固定（只含「あ」、没有「鷗」），
链尾分别用明朝体与丸ゴ体各跑一次，两个探针字符各自单独渲一帧、单独取哈希
（分开渲是必须的：两个字排在一行时，前一个字的 advance 一变，后一个字的像素
就跟着位移，哈希差异会变得毫无意义）。

- 「鷗」两次**不同** → 画它的是内嵌链尾，这条策略成立；
- 「鷗」两次**相同** → 画它的是系统字体，链尾换了都不影响，策略不成立。

同时验「あ」：它在链首与链尾里都有，两次必须**相同**，
否则说明链首没有优先权，链的顺序是假的。

    uv run --python 3.12 python -m experiments.ass_embedded_fonts
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from kvm.render.font_subset import fonts_section, subset_font  # noqa: E402

# 三个风格差异极大的日文字体：极粗黑 / 明朝 / 圆体。
# 挑差异大的是为了让"画的是不是同一个面"在像素上无可辩驳。
_HEAD_SRC = ("/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc", 3)
_MINCHO_SRC = ("/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", 0)
_MARU_SRC = ("/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc", 1)

_COMMON = "あ"
"""链首与链尾都有的字。用来验"链首优先"——它必须不受换链尾影响。"""

_PROBE = "鷗"
"""只有链尾才有的探针字符。**必须落在 `default_charset()` 之外**
（不可编码为 shift_jis），这样它才代表"子集字体默认裁不到、只能靠链尾补上"的那一类字。"""

_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 400
PlayResY: 200
LayoutResX: 400
LayoutResY: 200
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: M,{font},140,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

"""

_EVENTS = """[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,M,,0,0,0,,{{\\pos(20,20)}}{text}
"""


def _make_subset(src: str, index: int, chars: str, family: str, dest: Path) -> Path:
    subset_font(Path(src), dest, charset=set(chars), family_index=index, family_name=family)
    return dest


def _render(tmp: Path, tag: str, font: str, text: str, embeds: list[tuple[str, Path]]) -> str:
    """渲一个字符一帧，返回像素哈希。"""
    ass = tmp / f"{tag}.ass"
    png = tmp / f"{tag}.png"
    ass.write_text(
        _HEADER.format(font=font)
        + fonts_section([(name, p.read_bytes()) for name, p in embeds])
        + _EVENTS.format(text=text),
        encoding="utf-8",
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=400x200:d=1",
            "-vf", f"ass={ass}:shaping=complex",
            "-frames:v", "1", str(png),
        ],
        check=True,
    )
    return hashlib.sha1(png.read_bytes()).hexdigest()[:12]


def _run_strategy(tmp: Path, name: str, head_family: str, tail_family: str) -> bool:
    """跑一种嵌法，返回它是否成立。"""
    head = _make_subset(*_HEAD_SRC, _COMMON, head_family, tmp / f"{name}-head.otf")
    mincho = _make_subset(
        *_MINCHO_SRC, _COMMON + _PROBE, tail_family, tmp / f"{name}-mincho.otf"
    )
    maru = _make_subset(*_MARU_SRC, _COMMON + _PROBE, tail_family, tmp / f"{name}-maru.otf")

    chains = {
        "mincho": [(head_family, head), (tail_family, mincho)],
        "maru": [(head_family, head), (tail_family, maru)],
    }
    print(f"\n=== 策略 {name}：链首族名「{head_family}」 链尾族名「{tail_family}」 ===")

    marks: dict[str, str] = {}
    for tail, embeds in chains.items():
        for label, ch in (("共有字", _COMMON), ("探针字", _PROBE)):
            key = f"{label}/{tail}"
            marks[key] = _render(tmp, f"{name}-{tail}-{label}", head_family, ch, embeds)
            print(f"   {key:14s}「{ch}」 {marks[key]}")

    probe_follows_tail = marks["探针字/mincho"] != marks["探针字/maru"]
    common_stays = marks["共有字/mincho"] == marks["共有字/maru"]
    if probe_follows_tail and common_stays:
        print("   ✅ 换链尾则「鷗」变、「あ」不变 → 内嵌链接管了回退，且链首优先")
    elif not probe_follows_tail:
        print("   ❌ 换链尾「鷗」纹丝不动 → 画它的是系统字体，这条策略在导出侧无效")
    else:
        print("   ❌ 「あ」也跟着变了 → 链首没有优先权，链的顺序是假的")
    return probe_follows_tail and common_stays


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="kvm-embed-"))
    print(f"\n########## `[Fonts]` 内嵌字体能否接管缺字「{_PROBE}」 ##########")
    distinct = _run_strategy(tmp, "distinct", "KVM Head", "KVM Tail")
    same = _run_strategy(tmp, "samefamily", "KVM Chain", "KVM Chain")
    # 本项目实际采用的形态：全链改写成**链首真实的族名**。
    # 这样 ASS 的 Fontname 仍然指向系统里真的存在的字体，没有内嵌字节的场合
    # （命令行出片）不会退化成"一个字都匹配不上"。
    # 用一个系统里确实装着、且**本身就有探针字**的族名，量的正是最难的一种情形：
    # 同族的系统原字体也在候选里，且它有这个字形。
    head_real = _run_strategy(tmp, "headfamily", "Hiragino Kaku Gothic StdN", "Hiragino Kaku Gothic StdN")

    print("\n=== 结论 ===")
    print(f"   各留各的族名（distinct）    ：{'成立' if distinct else '不成立'}")
    print(f"   全链统一合成族名（samefamily）：{'成立' if same else '不成立'}")
    print(f"   全链统一为链首真实族名        ：{'成立' if head_real else '不成立'}")
    print(f"\n   产物留在 {tmp}\n")
    return 0 if (same and head_real) else 1


if __name__ == "__main__":
    raise SystemExit(main())
