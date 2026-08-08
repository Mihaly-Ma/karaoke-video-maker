"""文本度量：向 libass 本人问排版推进宽度（advance）。

注音必须居中于基字的 **advance 格位**，不是墨迹包围盒（CLAUDE.md §9 已实测结论）。
本模块不读字体的 hmtx/kern 表、不做 shaping 推演，而是让 libass 实际渲染一遍
再从像素反推——因此得到的坐标**定义上就与最终渲染一致**，且对任意字体天然兼容。

量法是"尾随标记块"：在每个前缀后追加一个 `█`（墨迹填满格位），
由它的墨迹右边界反推前缀的 advance：

    advance(prefix) = max_x(prefix + █) − ink_right(单独的 █)

直接量前缀墨迹右边界是错的——差分值会混入相邻字符的 side bearing，
实测同字体下全角字符会给出 45/52 这种本应相同却不同的结果。

为了让整首歌（数十行、上千个前缀）的度量在可接受时间内完成，
这里把所有前缀堆叠成多行**一次性渲染**，并用 numpy 做列投影，
而不是逐个前缀调用 ffmpeg。
"""

from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MARKER = "█"
_ROW_H = 110
_MARGIN = 10
_MAX_ROWS_PER_BATCH = 90
"""每批渲染的行数上限。行数×行高即图像高度，过高会撑大内存与 ffmpeg 开销。"""


@dataclass(frozen=True)
class FontSpec:
    """影响排版度量的字体参数。任一项变化都会让既有度量失效。"""

    name: str
    size: int
    bold: bool = False
    italic: bool = False
    spacing: float = 0.0
    scale_x: int = 100

    def cache_key(self) -> tuple:
        return (self.name, self.size, self.bold, self.italic, self.spacing, self.scale_x)


_HEADER = """[Script Info]
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
Style: M,{font},{size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,{bold},{italic},0,0,{scale_x},100,{spacing},0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _escape_ass_text(s: str) -> str:
    """转义 ASS 事件文本中的特殊字符。

    `{` 会开启 override block，`\\` 是转义引导符，都必须处理，
    否则歌词里出现这些字符会让整行渲染错乱。
    """
    return s.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


class LibassMetrics:
    """基于 libass 实际渲染的文本度量器。

    实例内缓存已测过的 (字体, 文本) → advance 序列，
    因为编辑器里同一行会被反复重新布局。
    """

    def __init__(self, ffmpeg: str, canvas_width: int = 3000) -> None:
        self._ffmpeg = ffmpeg
        self._w = canvas_width
        self._cache: dict[tuple, list[int]] = {}
        self._marker_ink: dict[tuple, int] = {}

    def advances(self, text: str, font: FontSpec) -> list[int]:
        """返回长度等于 len(text) 的列表，第 i 项是前 i+1 个字符的累计 advance。"""
        return self.advances_many([text], font)[0]

    def advances_many(self, texts: list[str], font: FontSpec) -> list[list[int]]:
        """批量度量多行文本，尽量合并成少数几次渲染。"""
        todo = [t for t in texts if t and (font.cache_key(), t) not in self._cache]
        if todo:
            self._measure_batch(todo, font)
        out: list[list[int]] = []
        for t in texts:
            if not t:
                out.append([])
            else:
                out.append(self._cache[(font.cache_key(), t)])
        return out

    # ---- 内部实现 ----

    def _marker_ink_right(self, font: FontSpec) -> int:
        key = font.cache_key()
        if key not in self._marker_ink:
            xs = self._render_and_measure([MARKER], font)
            self._marker_ink[key] = xs[0]
        return self._marker_ink[key]

    def _measure_batch(self, texts: list[str], font: FontSpec) -> None:
        base = self._marker_ink_right(font)

        rows: list[str] = []
        index: list[tuple[str, int]] = []
        for t in texts:
            for i in range(len(t)):
                rows.append(t[: i + 1] + MARKER)
                index.append((t, i))

        measured: list[int] = []
        for start in range(0, len(rows), _MAX_ROWS_PER_BATCH):
            chunk = rows[start : start + _MAX_ROWS_PER_BATCH]
            measured.extend(self._render_and_measure(chunk, font))

        acc: dict[str, list[int]] = {t: [0] * len(t) for t in texts}
        for (t, i), x in zip(index, measured):
            acc[t][i] = max(0, x - base)

        for t, adv in acc.items():
            # advance 必须单调不减；渲染噪声导致的微小回退在此夹紧，
            # 否则后续按区间取子串宽度会出现负值
            for i in range(1, len(adv)):
                if adv[i] < adv[i - 1]:
                    adv[i] = adv[i - 1]
            self._cache[(font.cache_key(), t)] = adv

    def _render_and_measure(self, rows: list[str], font: FontSpec) -> list[int]:
        """把每个字符串渲染成独立一行，返回各行墨迹的最大 x（无墨迹为 -1）。"""
        height = _MARGIN * 2 + _ROW_H * len(rows)
        body = []
        for i, s in enumerate(rows):
            y = _MARGIN + i * _ROW_H
            body.append(
                f"Dialogue: 0,0:00:00.00,0:00:10.00,M,,0,0,0,,"
                f"{{\\an7\\pos(0,{y})\\bord0\\shad0}}{_escape_ass_text(s)}\n"
            )
        ass = (
            _HEADER.format(
                w=self._w,
                h=height,
                font=font.name,
                size=font.size,
                bold=-1 if font.bold else 0,
                italic=-1 if font.italic else 0,
                spacing=font.spacing,
                scale_x=font.scale_x,
            )
            + "".join(body)
        )

        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "m.ass"
            p.write_text(ass, encoding="utf-8")
            raw = _run_ffmpeg_gray(self._ffmpeg, p, self._w, height)

        arr = np.frombuffer(raw, dtype=np.uint8)
        if arr.size < self._w * height:
            msg = f"渲染输出不完整：期望 {self._w * height} 字节，实得 {arr.size}"
            raise RuntimeError(msg)
        img = arr[: self._w * height].reshape(height, self._w)

        out: list[int] = []
        for i in range(len(rows)):
            y0 = _MARGIN + i * _ROW_H
            band = img[y0 : y0 + _ROW_H]
            cols = np.nonzero(band.max(axis=0) >= 40)[0]
            out.append(int(cols[-1]) if cols.size else -1)
        return out


def _run_ffmpeg_gray(ffmpeg: str, ass_path: Path, w: int, h: int) -> bytes:
    escaped = str(ass_path).replace("\\", "/").replace(":", r"\:")
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"color=c=black:s={w}x{h}:d=1:r=1",
        "-vf", f"ass={escaped}",
        "-frames:v", "1",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=300)
    if proc.returncode != 0:
        msg = f"ffmpeg 渲染失败：{proc.stderr.decode(errors='replace')[:600]}"
        raise RuntimeError(msg)
    return proc.stdout
