"""P0-2：能否直接用 libass 本身做文本度量，实现注音定位的闭环？（多字体验证）

## 为什么这个问题是阻断性的

注音（振り仮名）在 ASS 里没有原生支持，必须把每个注音展开成独立的 Dialogue 行，
用 `\\pos` 精确定位到对应汉字的正上方。**定位靠的是文本度量** ——
必须知道"这一行里第 3 个字符占据 x ∈ [a, b)"。

之前的调研全在纠结"用 `uharfbuzz` 能否**近似** libass 的排版结果"。
但近似就意味着误差，而注音错位会直接摧毁日式卡拉OK 的观感。

本实验验证一条被忽略的确定性路径：**让 libass 自己渲染，然后从像素反推度量**。
这样得到的坐标**定义上就与最终渲染一致**，不存在近似误差。

## 必须兼容任意字体

用户样式可自定义字体，度量方案不能只在某一个字体上成立。
本方法不假设任何字体度量模型（不读 hmtx/kern 表、不做 shaping 推演），
只问渲染器"你实际画到哪了"，因此对任意字体、任意字号、任意 ScaleX/Spacing 天然成立。
下面用多个字体 + 日英混排文本实测证明这一点，并检查方法是否具备区分力。

## 方法

把同一行文本的所有前缀（`明`、`明日`、`明日ま`…）各放一个 Dialogue，
用 `\\an7\\pos(0, i*行距)` 左上对齐堆叠，**一次渲染**全部量完。
逐行统计非透明像素的最大 x，差分即得每个字符的 x 区间。

自洽判据：前缀宽度必须单调不减。若非单调，说明存在跨字符 shaping/连字，
前缀差分法失效，须改用 libass 的 `ASS_Image` 链表（ctypes 直接读 `dst_x`）。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from experiments.ffmpeg_locate import find_ffmpeg_with_libass

FONT_SIZE = 72
LINE_H = 110
WIDTH = 1600
MARGIN_TOP = 10

# 覆盖不同字形风格：无衬线黑体 / 系统默认 / 明朝体 / 圆体 / 西文字体
FONTS = [
    "Noto Sans CJK JP",
    "Hiragino Sans",
    "Hiragino Mincho ProN",
    "YuGothic",
    "Arial",
]

CASES = {
    "纯日语": ("明日また会う時", {"明日": "あした", "会": "あ", "時": "とき"}),
    "日英混排": ("Hello 世界 ABC", {"世界": "せかい"}),
}

HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
LayoutResX: {w}
LayoutResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: M,{font},{size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_ass(prefixes: list[str], height: int, font: str) -> str:
    """每个前缀一行，左上角对齐堆叠。描边/阴影设为 0 以免污染包围盒。"""
    out = [HEADER.format(w=WIDTH, h=height, font=font, size=FONT_SIZE)]
    for i, pre in enumerate(prefixes):
        y = MARGIN_TOP + i * LINE_H
        out.append(
            f"Dialogue: 0,0:00:00.00,0:00:10.00,M,,0,0,0,,"
            f"{{\\an7\\pos(0,{y})\\bord0\\shad0}}{pre}\n"
        )
    return "".join(out)


def render_gray(ffmpeg: str, ass_path: Path, height: int) -> bytes:
    escaped = str(ass_path).replace("\\", "/").replace(":", r"\:")
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c=black:s={WIDTH}x{height}:d=1:r=1",
        "-vf",
        f"ass={escaped}",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=180)
    if proc.returncode != 0:
        msg = f"ffmpeg 渲染失败：{proc.stderr.decode(errors='replace')[:600]}"
        raise RuntimeError(msg)
    return proc.stdout


def band_max_x(frame: bytes, height: int, y0: int, y1: int, thresh: int = 40) -> int:
    """在 y ∈ [y0,y1) 横带内返回亮度超阈值的最大 x；无则 -1。"""
    best = -1
    for y in range(max(0, y0), min(height, y1)):
        row = y * WIDTH
        for x in range(WIDTH - 1, best, -1):
            if frame[row + x] >= thresh:
                best = x
                break
    return best


def measure(ffmpeg: str, text: str, font: str) -> list[int] | None:
    """返回每个前缀的右边界像素 x；渲染不出内容时返回 None。"""
    chars = list(text)
    prefixes = ["".join(chars[: i + 1]) for i in range(len(chars))]
    height = MARGIN_TOP * 2 + LINE_H * len(prefixes)
    with tempfile.TemporaryDirectory() as td:
        ass_path = Path(td) / "m.ass"
        ass_path.write_text(build_ass(prefixes, height, font), encoding="utf-8")
        frame = render_gray(ffmpeg, ass_path, height)
    if len(frame) < WIDTH * height:
        return None
    widths = []
    for i in range(len(prefixes)):
        y0 = MARGIN_TOP + i * LINE_H
        widths.append(band_max_x(frame, height, y0, y0 + LINE_H))
    return widths


def ruby_positions(
    text: str, spans: list[tuple[str, int, int]], ruby: dict[str, str]
) -> list[tuple[str, str, int, int, int]]:
    """算出每个需注音汉字块的基字区间与注音中心 x。"""
    out = []
    idx = 0
    while idx < len(text):
        matched = next((s for s in ruby if text.startswith(s, idx)), None)
        if matched:
            n = len(matched)
            x0, x1 = spans[idx][1], spans[idx + n - 1][2]
            out.append((matched, ruby[matched], x0, x1, (x0 + x1) // 2))
            idx += n
        else:
            idx += 1
    return out


def main() -> int:
    ffmpeg = find_ffmpeg_with_libass()
    print(f"ffmpeg : {ffmpeg}")
    print(f"字号   : {FONT_SIZE}")
    print()

    all_ok = True
    fingerprints: dict[str, dict[str, tuple[int, ...]]] = {}

    for case_name, (text, ruby) in CASES.items():
        print("=" * 68)
        print(f"用例：{case_name}  文本：{text}")
        print("=" * 68)
        fingerprints[case_name] = {}

        for font in FONTS:
            widths = measure(ffmpeg, text, font)
            if widths is None or any(w < 0 for w in widths):
                print(f"\n[{font}] ⚠️ 有前缀未渲染出像素（字体缺字或名称无效），跳过")
                all_ok = False
                continue

            chars = list(text)
            spans: list[tuple[str, int, int]] = []
            prev = 0
            for ch, w in zip(chars, widths):
                spans.append((ch, prev, w))
                prev = w

            monotonic = all(b >= a for a, b in zip(widths, widths[1:]))
            fingerprints[case_name][font] = tuple(widths)

            detail = "  ".join(f"{ch}[{a},{b})" for ch, a, b in spans if ch != " ")
            print(f"\n[{font}] 总宽 {widths[-1]}px  单调={monotonic}")
            print(f"  {detail}")

            if not monotonic:
                print("  ❌ 前缀宽度非单调 —— 存在跨字符 shaping，前缀差分法在此字体上失效")
                all_ok = False
                continue

            for surface, rt, x0, x1, cx in ruby_positions(text, spans, ruby):
                print(f"  注音 {surface}({rt}) 基字 x∈[{x0},{x1}) → \\pos 中心 x={cx}")

        print()

    print("=" * 68)
    print("字体区分力检查（不同字体应产生不同度量；相同说明发生了 fallback）")
    print("=" * 68)
    for case_name, per_font in fingerprints.items():
        seen: dict[tuple[int, ...], list[str]] = {}
        for font, fp in per_font.items():
            seen.setdefault(fp, []).append(font)
        print(f"\n{case_name}：{len(per_font)} 个字体 → {len(seen)} 组不同度量")
        for fp, fonts in seen.items():
            if len(fonts) > 1:
                print(f"  ⚠️ 度量完全相同（疑似 fallback 到同一字体）：{', '.join(fonts)}")
            else:
                print(f"  ✅ {fonts[0]:<22} 总宽 {fp[-1]}px")

    print()
    if all_ok:
        print("结论：✅ 用 libass 渲染反推度量的方法在全部受测字体上成立")
        print("      → 注音定位无需 uharfbuzz 近似；方法不依赖字体度量模型，")
        print("        对任意自定义字体天然兼容")
        return 0
    print("结论：⚠️ 部分字体上未通过，详见上方标记")
    return 3


if __name__ == "__main__":
    sys.exit(main())
