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

## 产物必须自称调用方要的族名

libass 给内存字体建索引时**只认 name 表里 Windows 平台（platformID=3）的
nameID 1（Family）**；nameID 16（Typographic Family）、nameID 4（Full name）、
nameID 6（PostScript 名）以及 Mac 平台（platformID=1）的记录一概匹配不上 ——
四者都单独构造过"只有这一条等于请求族名"的字体，全部渲不出字
（chromium + WebKit 双引擎实测，见 `frontend/scripts/verify-font-name.mjs` 的 A 组用例）。

而 macOS 的日文字体普遍把字重写进 nameID 1 —— ヒラギノ丸ゴ ProN 的
(3,0x409) nameID1 是 `Hiragino Maru Gothic ProN W4`，真族名 `Hiragino Maru Gothic ProN`
只出现在 nameID 16 里。于是"接口对外通报的族名"在子集产物里一条都匹配不上，
而 JASSUB 用 `ASS_FONTPROVIDER_NONE`、匹配不上没有任何回退：libass 每帧返回 0 张图，
**不报错**。ffmpeg 侧走系统 fontconfig 自动探测，同一个工程烧录完全正常，
所以这类问题只在预览侧出现、看成片发现不了。

因此 `subset_font(..., family_name=...)` 会把请求的族名改写进产物的 name 表：
**调用方请求什么族名，字体就自称什么族名**，不再指望系统字体的命名习惯
（CLAUDE.md §5.12"给打包字体使用唯一的 family name 以降低误匹配"）。

## 依赖

需要 `fonttools`（含 woff2 支持时可直接产出 woff2）。属于 §2.6 的自动获取范畴：
调用方发现缺失时应给出可执行的中文提示，而不是抛裸异常。
"""

from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - 仅供类型标注，运行期不导入
    from fontTools.ttLib import TTFont

SUBSET_VERSION = 3
"""子集产物的生成逻辑版本。**改动 `subset_font` 的产物内容时必须 +1。**

调用方（`kvm.api.routes.fonts`）把它算进磁盘缓存键，否则老用户的缓存目录里
会永远躺着按旧逻辑生成的坏字体——那正是族名改写要修的东西。

v3 的这一次 +1 并没有改变产物内容，改变的是**产物的保证**：`_assert_family_name`
从这版起在保存之前拦下族名对不上的产物。已经躺在磁盘上的旧产物没有经过这道检查，
而这类坏文件的症状恰恰是"预览空白且刷新页面也修不好"——因为坏的是缓存本身，
每次请求都稳定命中同一份。加版本号是唯一能把它们从用户磁盘上赶走的手段。
**"内容没变就不用 +1" 在这里是错的**：判断依据是"旧产物还能不能信"，不是字节是否相同。
"""

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


def _rewrite_family_name(font: TTFont, family: str) -> None:
    """把 `family` 写成产物**唯一**的族名。

    三件事，缺一不可：

    - 全部 nameID 1 记录改成 `family` —— 这是 libass 唯一真正拿来匹配的那条；
    - 全部 nameID 4（Full name）跟着改，让"按全名引用"也指向同一个族
      （实测 libass 不看 nameID 4，所以这条只是保持 name 表自洽，不是修复项）；
    - 删掉 nameID 16/17（Typographic Family/Subfamily）与 21/22（WWS）——
      它们的存在意义就是"与 nameID 1 不同"，留着会让 FreeType 与其它消费方
      看到与 nameID 1 冲突的族名，而冲突正是本 bug 的来源。

    nameID 2（Subfamily）统一写成 `Regular`：接口对一个 family 只产出**一个**字面
    （`routes/fonts.py` 的 `_aggregate` 已挑好最接近常规字重的代表），产物里既然
    只有一个字面，就不该自称 "W4"/"W8" 这类子族名，否则 libass 又要去解析字重后缀。
    ASS 的 Bold 由 libass 合成粗体处理，与这里无关。

    **不动 nameID 6（PostScript 名）**：PS 名有"不含空格、纯 ASCII"的格式约束，
    按族名硬凑容易造出非法值；它只是一条额外别名，与族名不一致不影响匹配。
    """
    name = font["name"]
    for record in list(name.names):
        if record.nameID in (1, 4):
            name.setName(family, record.nameID, record.platformID, record.platEncID, record.langID)
        elif record.nameID == 2:
            name.setName(
                "Regular", record.nameID, record.platformID, record.platEncID, record.langID
            )
    for name_id in (16, 17, 21, 22):
        name.removeNames(nameID=name_id)


class FontFamilyMismatchError(RuntimeError):
    """子集产物的族名与请求的族名对不上。

    **这个错误必须响亮，不能降级。**预览侧 JASSUB 走 `ASS_FONTPROVIDER_NONE`，
    libass 唯一的匹配依据就是 ASS 里的 `Fontname` 与内嵌字体 name 表里的族名；
    对不上时它**既不报错也不回退，只是每帧返回 0 张图**——用户看到的是一块空白，
    而控制台干干净净。这正是"只有某几个字体能用"那类报告的形状，
    并且**刷新页面也修不好**，因为坏的是磁盘上的缓存产物。

    实测佐证（`frontend/scripts/diag-font-render.mjs` 的 `samefont` 对照组）：
    故意让每个族名都拿到同一份字体字节后，四个字体的着墨格数直接归零、
    字形指纹撞成一片——与"渲染正常"在像素总量上**看不出区别**的那种失败，
    只有指纹才分得出来。所以宁可这里 500，也不要送出一份注定画不出字的产物。
    """


def _family_names(font: TTFont) -> set[str]:
    """产物里所有会被字体匹配器当成"族名"的字符串。

    同时看 nameID 1 与 16：FreeType 合成 `family_name` 时优先取 16（若存在），
    而 libass 两者都会碰。`_rewrite_family_name` 会删掉 16，这里再核一遍，
    确保没有漏网的记录与 nameID 1 打架。
    """
    out: set[str] = set()
    for record in font["name"].names:
        if record.nameID in (1, 16):
            try:
                out.add(str(record.toUnicode()))
            except UnicodeDecodeError:  # pragma: no cover - 坏记录直接忽略
                continue
    return out


def _assert_family_name(font: TTFont, family: str, src: Path) -> None:
    """改名之后立刻自检：产物的族名必须**唯一**且等于请求的族名。

    放在保存之前，坏产物就永远落不了盘——否则它会进缓存，之后每次请求都命中
    同一份坏文件，表现成"这个字体永久用不了"。
    """
    names = _family_names(font)
    if names != {family}:
        msg = (
            f"字体子集产物的族名与请求的对不上：请求「{family}」，"
            f"产物里是 {sorted(names) or '（一条 nameID 1 都没有）'}；源文件 {src}。"
            "带着这样的族名，libass 会匹配不上而每帧返回 0 张图（画面空白且不报错）。"
        )
        raise FontFamilyMismatchError(msg)


def subset_font(
    src: Path,
    dest: Path,
    *,
    charset: set[str] | None = None,
    family_index: int = 0,
    flavor: str | None = None,
    family_name: str | None = None,
) -> tuple[int, int]:
    """把 `src` 裁成只含 `charset` 的字体写到 `dest`。

    返回 (原始字节数, 产出字节数)。`src` 为 TTC 时按 `family_index` 取其中一个族。

    `family_name` 非空时把产物的族名改写成它（见 `_rewrite_family_name` 与模块文档）。
    给浏览器预览用时**必须传**，否则 libass 按调用方请求的族名找不到这份字体，
    整块字幕静默消失。

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

    if family_name:
        _rewrite_family_name(font, family_name)
        _assert_family_name(font, family_name, src)

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
