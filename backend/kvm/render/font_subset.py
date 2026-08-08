"""字体子集化：为浏览器预览产出体积可接受的 CJK 字体。

## 为什么必须做这件事

JASSUB 用 `ASS_FONTPROVIDER_NONE` —— 浏览器里**拿不到系统字体**，字形必须显式喂进去，
而它自带的 `default.woff2` 只有 145KB、不含 CJK，日语歌词会整片渲染成豆腐块。

但系统里的 `NotoSansCJK.ttc` 有 **117MB**，直接丢给浏览器不可接受。
所以要把它裁成"够用的最小集合"。

## 裁到多小

默认保留：ASCII、日文假名、常用标点、以及 JIS X 0208 第一/第二水准覆盖的汉字。
这一集合足以覆盖绝大多数日语歌词，体积通常落在几 MB。

更激进的做法是**按当前工程的歌词文本裁**（只留实际出现的字符），
能压到几十 KB，代价是换歌就要重裁。`subset_for_text()` 提供这条路径，
供将来接入"把字体 UUEncode 进 ASS `[Fonts]` 段"时使用 —— 那样预览与导出
用的是**同一份字节**，从根上消除两端字体分叉（CLAUDE.md §5.12）。

## 依赖

需要 `fonttools`（含 woff2 支持时可直接产出 woff2）。属于 §2.6 的自动获取范畴：
调用方发现缺失时应给出可执行的中文提示，而不是抛裸异常。
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

# 常见的系统字体位置。TTC 是字体集合，需要按 family 挑出其中一个。
_FONT_CANDIDATES = [
    Path.home() / "Library/Fonts/NotoSansCJK.ttc",
    Path("/System/Library/Fonts/Hiragino Sans GB.ttc"),
    Path("/Library/Fonts/NotoSansCJK.ttc"),
    Path("C:/Windows/Fonts/YuGothM.ttc"),
]


def find_system_cjk_font() -> Path | None:
    """找一个可用的系统 CJK 字体源文件。"""
    for p in _FONT_CANDIDATES:
        if p.is_file():
            return p
    return None


def _kana_and_punct() -> set[str]:
    """假名、长音符、常用日文标点与全角符号。"""
    chars: set[str] = set()
    # 平假名 / 片假名（含半角片假名的全角等价）
    for cp in range(0x3041, 0x30FF + 1):
        chars.add(chr(cp))
    # CJK 标点、全角 ASCII、常用符号
    for cp in range(0x3000, 0x303F + 1):
        chars.add(chr(cp))
    for cp in range(0xFF01, 0xFF60 + 1):
        chars.add(chr(cp))
    chars.update("　※〜ー―‐–—…‥「」『』【】〈〉《》〔〕♪♫●○◆■□▲△")
    return chars


def _jis_level1_2_kanji() -> set[str]:
    """JIS X 0208 第一/第二水准覆盖的汉字。

    直接按 CJK 统一表意文字基本区遍历并用 `unicodedata` 过滤出可编码为
    shift_jis 的字符 —— 比内嵌一张几千字的表更不容易出错，且无需外部数据。
    """
    out: set[str] = set()
    for cp in range(0x4E00, 0x9FFF + 1):
        ch = chr(cp)
        try:
            ch.encode("shift_jis")
        except UnicodeEncodeError:
            continue
        out.add(ch)
    # 叠字与常见异体
    out.update("々〆ヶヵ")
    return out


def default_charset() -> set[str]:
    """默认子集字符集：足以覆盖绝大多数日语歌词。"""
    chars: set[str] = set()
    for cp in range(0x20, 0x7F):
        chars.add(chr(cp))
    chars |= _kana_and_punct()
    chars |= _jis_level1_2_kanji()
    return chars


def subset_font(
    src: Path,
    dest: Path,
    *,
    charset: set[str] | None = None,
    family_index: int = 0,
    flavor: str | None = None,
) -> tuple[int, int]:
    """把 `src` 裁成只含 `charset` 的字体写到 `dest`。

    返回 (原始字节数, 产出字节数)。`src` 为 TTC 时按 `family_index` 取其中一个族。

    **`flavor` 默认必须是 None（即产出 TTF/OTF），不要图省事改成 woff2。**
    JASSUB 是把字体字节直接喂给 libass 的，而 **libass 只认 TTF/OTF/TTC**；
    woff2 是浏览器专用的 brotli 压缩容器，libass 读不了 ——
    结果是字体"加载成功"却一个字都渲染不出来，且不报错，极难排查。
    woff2 只在用 CSS `@font-face` 给 DOM 用时才有意义，本项目的字体是给渲染器的。
    """
    try:
        from fontTools import subset as ft_subset
        from fontTools.ttLib import TTCollection, TTFont
    except ImportError as exc:  # pragma: no cover - 取决于运行环境
        msg = (
            "缺少 fonttools，无法生成预览字体。"
            "请安装后重试：uv run --with fonttools --with brotli ..."
        )
        raise RuntimeError(msg) from exc

    chars = charset or default_charset()

    if src.suffix.lower() == ".ttc":
        coll = TTCollection(str(src))
        if not coll.fonts:
            msg = f"字体集合为空：{src}"
            raise RuntimeError(msg)
        font = coll.fonts[min(family_index, len(coll.fonts) - 1)]
    else:
        font = TTFont(str(src))

    options = ft_subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    # 保留竖排相关表会显著增大体积，而本项目明确不做纵書き（CLAUDE.md non-goals）
    options.drop_tables += ["vmtx", "vhea", "VORG"]

    subsetter = ft_subset.Subsetter(options=options)
    subsetter.populate(text="".join(sorted(chars)))
    subsetter.subset(font)

    dest.parent.mkdir(parents=True, exist_ok=True)
    if flavor:
        font.flavor = flavor
    font.save(str(dest))
    return (src.stat().st_size, dest.stat().st_size)


def subset_for_text(src: Path, dest: Path, text: str, **kwargs) -> tuple[int, int]:
    """只保留 `text` 中实际出现的字符。

    体积最小，适合"把字体嵌进 ASS `[Fonts]` 段"的路线 ——
    那样预览与导出用同一份字节，两端不可能分叉。
    """
    chars = {ch for ch in unicodedata.normalize("NFC", text) if ch.strip()}
    # 兜底加上 ASCII 与假名，避免界面上的数字、罗马字缺字
    for cp in range(0x20, 0x7F):
        chars.add(chr(cp))
    chars |= _kana_and_punct()
    return subset_font(src, dest, charset=chars, **kwargs)
