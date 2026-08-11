"""画布几何：从"源视频的编码尺寸"推出"字幕该按多大的画布排版"。

## 为什么单独一个模块

版面的三个参数——ASS 的 `PlayRes`、字号的锚点、烧录时接在 `ass=` 之前的滤镜——
必须由同一份计算产出。它们一旦对不上，症状全是"字的比例不对"，而且各自的
表现还不一样，排查时很难看出是同一个原因：

| 对不上的是什么 | 症状 |
|---|---|
| `PlayRes` ≠ 实际帧尺寸 | libass 按 `帧高/PlayResY` 缩字号、按 `帧宽/PlayResX` 缩坐标。两个比例不等时**字号不变而坐标被压**，行会顶出画面或缩成一团 |
| 字号锚在高度上，画面不是 16:9 | 字号相对**宽度**变了：4:3 大 33%，竖屏大 3.16 倍。一行放不下就走 `\\fscx` 压扁（见 `ass_builder._layout`），那是字真的变形 |
| 源是非方形像素（SAR ≠ 1） | 成片按编码尺寸出，播放器再横向拉一次，字跟着一起被拉 |

所以这三件事在本模块里一次算完，调用方只拿结果。

## 两条口径

- **一律用方形像素的显示尺寸**（`display_size`）。工程里记的 `video_width /
  video_height`、ASS 的 `PlayRes`、前端 `<video>` 的 `videoWidth`（HTML 规范就是
  显示尺寸）三者从此说的是同一件事。
- **字号锚点取"画面内接的最大 16:9 框的高度"**（`layout_ref_height`）。
  16:9 时它恒等于画面高度，所以既有的默认值（CLAUDE.md §8.5 的 7.5% / 5.5% / 2.2%）
  与已验证的成片**逐像素不变**；比 16:9 窄的画面上它按宽度收敛，一行才放得下。
"""

from __future__ import annotations

from dataclasses import dataclass, field

REFERENCE_ASPECT = 16 / 9
"""版面基准画幅。§8.5 的全部数值都是在它上面校准的。"""

ASPECT_TOLERANCE = 0.015
"""判定"已经是 16:9"的相对容差。

1.5% 是照着 **1920×1088** 定的：那是 mod-16 对齐留下的常见尺寸，比 16:9 只差
0.74%，补边补出个 1935×1088 纯属添乱。4:3 差 25%、竖屏差 68%，离容差很远。
"""

DEFAULT_MAX_SIDE = 3840
"""补边后画布长边的上限。

竖屏源补成 16:9 要 3414×1920——画面只占中间一条，其余全是黑边，编码这么大一张
纯属浪费。超过上限就整体缩小（画面同比缩，不裁切），宁可小一点也不要出个
六百万像素的黑边。
"""


def _even(value: float) -> int:
    """取偶。`yuv420p` 的色度平面按 2×2 取样，奇数边长 ffmpeg 直接报错。"""
    return max(2, round(value / 2) * 2)


def parse_ratio(value: str | None) -> float | None:
    """解析 ffprobe 的 `"4:3"` / `"1:1"` 这类比值。

    `"0:1"` 是 ffprobe 表示"未知"的写法，与"1:1"完全不是一回事——当成 0 去做
    除法会得到 ZeroDivisionError 或无穷大，所以这里统一收敛成 `None`。
    """
    if not value:
        return None
    num, sep, den = value.partition(":")
    if not sep:
        try:
            parsed = float(value)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    try:
        numerator, denominator = float(num), float(den)
    except ValueError:
        return None
    if numerator <= 0 or denominator <= 0:
        return None
    return numerator / denominator


def display_size(coded_w: int, coded_h: int, sar: str | float | None = None) -> tuple[int, int]:
    """编码尺寸 + 像素宽高比 → **方形像素下的显示尺寸**。

    非方形像素（SAR ≠ 1）的源在本项目里是真实存在的：DVD / TV 转录的日本 MV 常见
    1440×1080 配 SAR 4:3，实际显示是 16:9。照编码尺寸排版就等于在一个 4:3 的画布上
    摆字，播放器再横向拉 1.333 倍——**字被拉扁，而画面看着是正常的**，
    所以很容易误判成"字体选错了"。

    放大较短的那一边而不是缩短较长的那一边：补边不丢细节，缩边会。
    """
    ratio = parse_ratio(sar) if isinstance(sar, str) or sar is None else float(sar)
    if ratio is None or ratio <= 0 or abs(ratio - 1.0) < 1e-6:
        return int(coded_w), int(coded_h)
    if ratio > 1.0:
        return _even(coded_w * ratio), _even(coded_h)
    return _even(coded_w), _even(coded_h / ratio)


def layout_ref_height(width: int, height: int) -> int:
    """版面锚点高度 = 画面内接的最大 16:9 框的高度 = `min(h, w × 9/16)`。

    字号同时决定两件事：**读起来多大**（相对画面高度）与**一行放得下几个字**
    （相对画面宽度）。16:9 上这两者被画幅绑死，所以"高度的 7.5%"一直够用；
    换个画幅它们就分家了，只锚高度必然有一侧失准。

    取两者的下界让宽的一侧不吃亏、窄的一侧不溢出：

    | 画幅 | ref | 相对现状 |
    |---|---|---|
    | 16:9 | `h` | **完全不变**（这是回归风险为零的原因） |
    | 4:3 1440×1080 | 810 | 字号 ×0.75，一行容量从 22 字回到 30 字 |
    | 21:9 2560×1080 | 1080 | 不变，宽出来的部分是余量 |
    | 9:16 1080×1920 | 608 | 字号 ×0.32，一行从 9 字回到 28 字 |

    竖屏那一档字会明显偏小（只有画面高的 2.4%），那是画幅本身的结果而非本函数
    的取舍——1080 宽的画面上想一行放十几个全角字，字就只能这么大。真要字大，
    该走的是补边（`plan_canvas(pad_to_16_9=True)`）而不是把字撑爆。
    """
    return max(1, min(int(height), round(width * 9 / 16)))


@dataclass(frozen=True)
class CanvasPlan:
    """一次烧录的画布决策。

    `width` / `height` 同时是 ASS 的 `PlayRes`/`LayoutRes` 与成片的实际帧尺寸——
    **这两者必须相等**，否则 libass 的字号缩放与坐标缩放会用上两个不同的比例
    （见模块文档的表格）。
    """

    width: int
    height: int
    filters: tuple[str, ...] = field(default_factory=tuple)
    """接在 `ass=` **之前**的 ffmpeg 滤镜，顺序即链序。

    必须在前：字幕要烧在最终画布上。放在 `ass=` 之后就成了"先烧字再缩放/补边"，
    字会跟着画面一起被缩进黑边里。
    """

    note: str = ""
    """给用户看的一句话说明。空串表示这次没做任何画布变换。"""

    @property
    def transforms(self) -> bool:
        """这次计划是否真的改动了画面（而不只是照原样出片）。"""
        return bool(self.filters)


def _pad_box(width: int, height: int, *, max_side: int) -> tuple[int, int, int, int] | None:
    """算补边后的画布与画面缩放尺寸；已经是 16:9 时返回 `None`。

    返回 `(canvas_w, canvas_h, src_w, src_h)`，居中偏移由调用方按差值取半。
    """
    aspect = width / height
    if abs(aspect / REFERENCE_ASPECT - 1.0) <= ASPECT_TOLERANCE:
        return None

    if aspect < REFERENCE_ASPECT:
        canvas_w, canvas_h = _even(height * REFERENCE_ASPECT), _even(height)
    else:
        canvas_w, canvas_h = _even(width), _even(width / REFERENCE_ASPECT)

    src_w, src_h = _even(width), _even(height)
    longest = max(canvas_w, canvas_h)
    if longest > max_side:
        factor = max_side / longest
        canvas_w, canvas_h = _even(canvas_w * factor), _even(canvas_h * factor)
        src_w, src_h = _even(width * factor), _even(height * factor)
        # 取偶之后画面可能反过来比画布大一两个像素，pad 会当场报错。
        src_w, src_h = min(src_w, canvas_w), min(src_h, canvas_h)
    return canvas_w, canvas_h, src_w, src_h


def plan_canvas(
    coded_w: int,
    coded_h: int,
    *,
    sar: str | float | None = None,
    pad_to_16_9: bool = False,
    max_side: int = DEFAULT_MAX_SIDE,
) -> CanvasPlan:
    """由源视频的编码尺寸算出这次烧录的画布与前置滤镜。

    两件事在这里合并处理，因为它们都改动帧尺寸、必须按同一条链算：
    像素归方（SAR ≠ 1 时）与补边到 16:9（用户显式要求时）。
    """
    disp_w, disp_h = display_size(coded_w, coded_h, sar)

    filters: list[str] = []
    notes: list[str] = []
    src_w, src_h = disp_w, disp_h
    canvas_w, canvas_h = disp_w, disp_h

    box = _pad_box(disp_w, disp_h, max_side=max_side) if pad_to_16_9 else None
    if box is not None:
        canvas_w, canvas_h, src_w, src_h = box

    if (src_w, src_h) != (int(coded_w), int(coded_h)):
        # setsar=1 不能省：只 scale 的话 SAR 会被原样带下去，播放器照旧拉一次。
        filters += [f"scale={src_w}:{src_h}", "setsar=1"]
    if (disp_w, disp_h) != (int(coded_w), int(coded_h)):
        notes.append(f"非方形像素已归一（{coded_w}×{coded_h} → {disp_w}×{disp_h}）")
    if box is not None:
        # 偏移也必须是偶数：`yuv420p` 下 pad 的 x/y 为奇数时 ffmpeg 直接拒绝
        # （色度平面按 2×2 取样，落点得对齐到取样格）。向下取偶，误差 ≤1px。
        x = ((canvas_w - src_w) // 2) & ~1
        y = ((canvas_h - src_h) // 2) & ~1
        filters.append(f"pad={canvas_w}:{canvas_h}:{x}:{y}:black")
        notes.append(f"已补边到 16:9（{canvas_w}×{canvas_h}）")
    elif pad_to_16_9:
        notes.append("画面已经是 16:9，无需补边")

    return CanvasPlan(
        width=canvas_w,
        height=canvas_h,
        filters=tuple(filters),
        note="；".join(notes),
    )
