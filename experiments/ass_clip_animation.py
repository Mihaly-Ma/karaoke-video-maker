"""P0-1：libass 是否支持 `\\t` 内的矩形 `\\clip` 动画？

## 为什么这个问题是阻断性的

日式 nicokara 的标志性观感是**填充与描边同步翻色**。ASS 的 `\\kf` 只扫填充色，
描边不跟着变。要让描边也翻，业界做法是"双层 + 渐进 clip"：
底层画未唱色（含描边），顶层画已唱色（含描边）并用一个**随时间向右扩张的矩形 clip**
把它逐渐露出来。

这套方案成立的前提是 **libass 支持 `\\t(t1,t2,\\clip(x1,y1,x2,y2))` 让 clip 矩形做动画**。
ASS 规范说 `\\t` 只能动画矩形版 `\\clip`（不能动画矢量版），而水平扫光恰好只需要矩形版，
所以答案很可能是"支持"—— 但**没人实际跑过**，而它决定整个视觉方案。

## 判定方法（量化，不靠肉眼）

渲染一行文本两层：底层填充纯蓝，顶层填充纯红 + clip 动画。
逐帧统计"红色像素的最大 x 坐标"：

- 若该值随时间**单调增长** → clip 动画生效，双层方案可用
- 若始终为 0（红色不出现）或始终等于文本右边界（红色全出现）→ 动画未生效，
  `\\t` 把 clip 当成了静态值

输出 raw RGB24 直接用标准库解析，不引入 numpy/Pillow 依赖。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from experiments.ffmpeg_locate import find_ffmpeg_with_libass, libass_version

WIDTH = 1280
HEIGHT = 360
DURATION_S = 5
FPS = 10

# ASS 颜色是 &HAABBGGRR（BGR 序），与直觉的 RGB 相反 —— 这里刻意用纯色以便像素判定
BLUE_FILL = r"&H00FF0000&"  # RGB(0,0,255)
RED_FILL = r"&H000000FF&"  # RGB(255,0,0)
GREEN_OUTLINE = r"&H0000FF00&"  # RGB(0,255,0)
YELLOW_OUTLINE = r"&H0000FFFF&"  # RGB(255,255,0)

TEXT = "ABCDEFGHIJKLMNOPQR"

ASS_TEMPLATE = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
LayoutResX: {WIDTH}
LayoutResY: {HEIGHT}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Base,Arial,72,{BLUE_FILL},{BLUE_FILL},{GREEN_OUTLINE},&H00000000&,0,0,0,0,100,100,0,0,1,5,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:0{DURATION_S}.00,Base,,0,0,0,,{{\\1c{BLUE_FILL}\\3c{GREEN_OUTLINE}}}{TEXT}
Dialogue: 1,0:00:00.00,0:00:0{DURATION_S}.00,Base,,0,0,0,,{{\\1c{RED_FILL}\\3c{YELLOW_OUTLINE}\\clip(0,0,0,{HEIGHT})\\t(0,{DURATION_S * 1000},\\clip(0,0,{WIDTH},{HEIGHT}))}}{TEXT}
"""


def render_frames(ffmpeg: str, ass_path: Path) -> bytes:
    """把带 ASS 的黑底视频渲染成 raw RGB24 字节流。"""
    escaped = str(ass_path).replace("\\", "/").replace(":", r"\:")
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"color=c=black:s={WIDTH}x{HEIGHT}:d={DURATION_S}:r={FPS}",
        "-vf", f"ass={escaped}",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=120)
    if proc.returncode != 0:
        msg = f"ffmpeg 渲染失败：{proc.stderr.decode(errors='replace')[:800]}"
        raise RuntimeError(msg)
    return proc.stdout


def max_x_of_color(frame: bytes, target: tuple[int, int, int], tol: int = 60) -> int:
    """返回该帧中最接近 target 颜色的像素的最大 x；不存在返回 -1。

    用容差匹配而非精确相等 —— libass 会做抗锯齿，边缘像素是混合色。
    """
    tr, tg, tb = target
    best = -1
    for y in range(HEIGHT):
        row = y * WIDTH * 3
        for x in range(WIDTH - 1, best, -1):
            i = row + x * 3
            if (
                abs(frame[i] - tr) <= tol
                and abs(frame[i + 1] - tg) <= tol
                and abs(frame[i + 2] - tb) <= tol
            ):
                best = x
                break
    return best


def main() -> int:
    ffmpeg = find_ffmpeg_with_libass()
    print(f"ffmpeg : {ffmpeg}")
    print(f"libass : {libass_version(ffmpeg)}")
    print()

    with tempfile.TemporaryDirectory() as td:
        ass_path = Path(td) / "clip_anim.ass"
        ass_path.write_text(ASS_TEMPLATE, encoding="utf-8")

        raw = render_frames(ffmpeg, ass_path)

    frame_size = WIDTH * HEIGHT * 3
    n_frames = len(raw) // frame_size
    if n_frames == 0:
        print("渲染未产出任何帧")
        return 1

    print(f"渲染 {n_frames} 帧，逐帧统计已唱色(红)的最大 x：")
    print()
    xs: list[int] = []
    for n in range(n_frames):
        frame = raw[n * frame_size : (n + 1) * frame_size]
        x = max_x_of_color(frame, (255, 0, 0))
        xs.append(x)
        t = n / FPS
        bar = "█" * (max(x, 0) * 40 // WIDTH)
        print(f"  t={t:4.1f}s  max_x={x:5d}  {bar}")

    print()
    valid = [x for x in xs if x >= 0]
    if not valid:
        print("结论：❌ 红色顶层完全没出现 —— clip 把整层裁掉了，方案不可用")
        return 2

    grew = xs[-1] - valid[0]
    strictly_increasing = all(b >= a for a, b in zip(xs, xs[1:]))

    print(f"首次出现 x={valid[0]}，末帧 x={xs[-1]}，增长 {grew}px，单调不减={strictly_increasing}")
    print()
    if grew > WIDTH * 0.3 and strictly_increasing:
        print("结论：✅ libass 支持 \\t 内的矩形 \\clip 动画")
        print("      → 双层 + 渐进 clip 的描边同步翻色方案可用，nicokara 观感有解")
        return 0
    print("结论：❌ clip 未随时间推进 —— \\t 把 clip 当静态值处理")
    print("      → 必须退化为逐音节静态 clip 事件，事件数暴涨；或改用其他方案")
    return 3


if __name__ == "__main__":
    sys.exit(main())
