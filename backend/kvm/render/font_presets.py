"""卡拉OK 常用字体预置。

## 选字依据

日式卡拉OK 的用字习惯有明确偏好，不是随便挑一个日文字体就行：

1. **粗ゴシック（粗黑体）—— 绝对主流。** 字幕要压在任意画面上仍清晰可读，
   笔画粗、结构方正的黑体最稳。市售カラオケ 与 nicokara 绝大多数用这一类。
2. **丸ゴシック（圆黑体）—— 次主流。** 可爱、柔和的曲风常用，nicokara 里很常见。
3. **明朝体 —— 少数。** 演歌、抒情曲偶尔使用，笔画细，需要更粗的描边配合。

## 为什么不把字体文件放进仓库

卡拉OK 最常用的那几个（ヒラギノ角ゴ、ヒラギノ丸ゴ、游ゴシック、メイリオ）
都是 **Apple / 微软的专有字体，不允许随应用分发**。
所以这里只维护一张"想要哪些字体"的清单，运行时从用户自己的系统提取并子集化 ——
用户机器上本来就有的字体，本地生成自用不涉及分发（CLAUDE.md §3 已定不分发二进制）。

开源字体（Noto 系列，OFL）作为保底：任何系统上都可能没有商业字体，
但只要装了 Noto 就有可用的日文字形。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class FontPreset:
    """一个预置字体档位。`families` 按优先级排列，取第一个系统里有的。"""

    key: str
    label: str
    note: str
    families: tuple[str, ...] = field(default_factory=tuple)


# 每档列出 macOS / Windows / 开源三条来源，取系统里最先命中的那个。
PRESETS: tuple[FontPreset, ...] = (
    FontPreset(
        key="gothic_bold",
        label="粗ゴシック（推荐）",
        # note 是界面上的选型依据，不是推荐语：说清它长什么样、适合什么场合，
        # 不写「绝对主流」「务必」这类口语判断
        note="笔画粗、结构方正，压在任意画面上都清晰可读。卡拉OK 最常用",
        families=(
            # 注意：ASS `Fontname` 匹配的是 family 名，"W6"/"W8" 是字重不是
            # family 的一部分——之前把两者拼在一起写成一个字符串，永远匹配不上。
            # "Hiragino Kaku Gothic StdN"/"...Std" 在本机只有 W8（黑体）这一个
            # 字重，天然适合"粗黑体"这一档；不与下面 gothic 档共用同一个 family，
            # 两档才不会解析出同一个代表字重。
            "Hiragino Kaku Gothic StdN",
            "Hiragino Kaku Gothic Std",
            "YuGothic",
            "Yu Gothic",
            "Meiryo",
            "Noto Sans CJK JP",
            "Noto Sans JP",
        ),
    ),
    FontPreset(
        key="gothic",
        label="ゴシック（标准黑体）",
        note="通用黑体，字重轻于粗ゴシック，适合字数多的长行",
        families=(
            "Hiragino Sans",
            "Hiragino Kaku Gothic ProN",
            "Yu Gothic",
            "MS Gothic",
            "Noto Sans CJK JP",
            "Noto Sans JP",
        ),
    ),
    FontPreset(
        key="maru_gothic",
        label="丸ゴシック（圆体）",
        note="笔画圆润，适合流行与偶像曲。ニコカラ 常见",
        families=(
            "Hiragino Maru Gothic ProN",
            "Hiragino Maru Gothic Pro",
            "M PLUS Rounded 1c",
            "Kosugi Maru",
            "Noto Sans JP",
        ),
    ),
    FontPreset(
        key="mincho",
        label="明朝体",
        note="笔画细，需要相应调粗描边。多用于演歌与抒情曲",
        families=(
            "Hiragino Mincho ProN",
            "YuMincho",
            "Yu Mincho",
            "MS Mincho",
            "Noto Serif CJK JP",
            "Noto Serif JP",
        ),
    ),
)


def resolve_presets(available: list[str]) -> list[dict]:
    """把预置清单与系统实际拥有的字体求交集。

    `available` 是系统字体族名列表（由 `routes/fonts.py` 扫描得到）。
    返回每档实际选中的字体；一个都没命中的档位标 `resolved=None`，
    界面上应显示为不可用并说明原因，而不是悄悄换成别的字体 ——
    用户选了明朝体却渲染出黑体，是比"该档不可用"更糟的体验。
    """
    have = {a.lower(): a for a in available}
    out: list[dict] = []
    for p in PRESETS:
        hit: str | None = None
        for fam in p.families:
            if fam.lower() in have:
                hit = have[fam.lower()]
                break
        out.append(
            {
                "key": p.key,
                "label": p.label,
                "note": p.note,
                "resolved": hit,
                "candidates": list(p.families),
            }
        )
    return out


def default_font_family(available: list[str]) -> str:
    """挑一个默认字体：优先粗黑体档，退而求其次用任何可用的日文字体。"""
    for item in resolve_presets(available):
        if item["resolved"]:
            return str(item["resolved"])
    return "Noto Sans CJK JP"


def preset_cache_path(root: Path, key: str) -> Path:
    return root / f"preset-{key}.otf"
