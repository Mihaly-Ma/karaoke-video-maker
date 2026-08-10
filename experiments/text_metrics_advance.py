"""P0-2b：用尾随标记块量出真正的排版推进宽度（advance），修正墨迹法的偏差。

## 为什么需要这一步

P0-2（`text_metrics_libass`）用"前缀墨迹右边界差分"来量字符宽度，
在 5 个字体上都自洽，但它量到的不是排版格位，而是**墨迹**。

推导：设字符 i 的推进宽度为 A、右边距为 rsb_i，则
    ink_right_i = i*A + A - rsb_i
    差分 = ink_right_i - ink_right_{i-1} = A + (rsb_{i-1} - rsb_i)

差分里混进了相邻字符的右边距之差。实测印证了这一点：Noto Sans CJK JP 下
`明`=45、`日`=45、`ま`=52，而这三个都是全角字符，推进宽度本应完全相同。

注音必须居中于**基字格位**。用墨迹中心定位，在纯 CJK 下是一个近似恒定的左偏，
在日英混排下 side bearing 不恒定，偏移会肉眼可见。

## 方法

在每个前缀后追加一个标记字符 `█`（U+2588 FULL BLOCK，墨迹填满格位）：

    advance(prefix) = max_x(prefix + █) − ink_right(单独的 █)

标记块自身的墨迹右边界只测一次即可扣除。这样得到的是真正的排版推进量，
与字形的 side bearing 无关。

## 判据

纯 CJK 文本的每字符格位宽度必须**恒定**（全角等宽）。
若恒定 → advance 测量正确；若仍抖动 → 标记法也失效，须改用 ctypes 直读
libass 的 `ASS_Image` 链表。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from experiments.ffmpeg_locate import find_ffmpeg_with_libass

FONT_SIZE = 72
LINE_H = 110
WIDTH = 2000
MARGIN_TOP = 10
MARKER = "█"

FONTS = [
    "Noto Sans CJK JP",
    "Hiragino Sans",
    "Hiragino Mincho ProN",
    "YuGothic",
]

CASES = {
    "纯CJK等宽验证": "明日会時桜舞花",
    "日英混排": "Hello 世界 ABC",
    "注音例句": "明日また会う時",
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


def render_rows(ffmpeg: str, rows: list[str], font: str) -> tuple[bytes, int]:
    """把每个字符串渲染成一行，返回 (gray 帧, 高度)。"""
    height = MARGIN_TOP * 2 + LINE_H * len(rows)
    body = []
    for i, s in enumerate(rows):
        y = MARGIN_TOP + i * LINE_H
        body.append(
            f"Dialogue: 0,0:00:00.00,0:00:10.00,M,,0,0,0,,{{\\an7\\pos(0,{y})\\bord0\\shad0}}{s}\n"
        )
    ass = HEADER.format(w=WIDTH, h=height, font=font, size=FONT_SIZE) + "".join(body)

    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "m.ass"
        p.write_text(ass, encoding="utf-8")
        escaped = str(p).replace("\\", "/").replace(":", r"\:")
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
    return proc.stdout, height


def band_max_x(frame: bytes, height: int, y0: int, y1: int, thresh: int = 40) -> int:
    best = -1
    for y in range(max(0, y0), min(height, y1)):
        row = y * WIDTH
        for x in range(WIDTH - 1, best, -1):
            if frame[row + x] >= thresh:
                best = x
                break
    return best


def measure_advances(ffmpeg: str, text: str, font: str) -> list[int] | None:
    """返回每个前缀的排版推进宽度 advance。"""
    chars = list(text)
    # 第 0 行单独测标记块自身墨迹宽度，其余行是 prefix+标记块
    rows = [MARKER] + ["".join(chars[: i + 1]) + MARKER for i in range(len(chars))]
    frame, height = render_rows(ffmpeg, rows, font)
    if len(frame) < WIDTH * height:
        return None

    xs = []
    for i in range(len(rows)):
        y0 = MARGIN_TOP + i * LINE_H
        xs.append(band_max_x(frame, height, y0, y0 + LINE_H))
    if any(x < 0 for x in xs):
        return None

    marker_ink_right = xs[0]
    return [x - marker_ink_right for x in xs[1:]]


def main() -> int:
    ffmpeg = find_ffmpeg_with_libass()
    print(f"ffmpeg : {ffmpeg}")
    print(f"字号   : {FONT_SIZE}   标记块：{MARKER}")
    print()

    all_ok = True

    for case_name, text in CASES.items():
        print("=" * 70)
        print(f"用例：{case_name}   文本：{text}")
        print("=" * 70)

        for font in FONTS:
            adv = measure_advances(ffmpeg, text, font)
            if adv is None:
                print(f"\n[{font}] ⚠️ 渲染失败或字体缺字，跳过")
                all_ok = False
                continue

            chars = list(text)
            widths = [adv[0]] + [adv[i] - adv[i - 1] for i in range(1, len(adv))]
            detail = "  ".join(f"{ch}:{w}" for ch, w in zip(chars, widths) if ch != " ")
            print(f"\n[{font}] 总推进 {adv[-1]}px")
            print(f"  逐字 advance: {detail}")

            cjk_w = [w for ch, w in zip(chars, widths) if ord(ch) > 0x2E80]
            if cjk_w:
                lo, hi = min(cjk_w), max(cjk_w)
                uniform = (hi - lo) <= 1  # 允许 1px 取整误差
                flag = "✅ 恒定" if uniform else "❌ 抖动"
                print(f"  CJK 字符 advance: {lo}~{hi}px  {flag}")
                if not uniform:
                    all_ok = False
        print()

    print("=" * 70)
    if all_ok:
        print("结论：✅ 标记块法测出的 CJK advance 恒定 —— 量到的是真正的排版格位")
        print("      → 注音应按此格位边界定位，而非 P0-2 的墨迹边界")
        print("      → 度量闭环成立，且不依赖字体度量模型，兼容任意字体")
        return 0
    print("结论：❌ 仍有字体上 advance 不恒定，标记块法不可靠")
    print("      → 须改用 ctypes 直读 libass ASS_Image 链表的 dst_x")
    return 3


if __name__ == "__main__":
    sys.exit(main())
