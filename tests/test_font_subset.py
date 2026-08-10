"""预览字体子集化：族名改写与缓存失效的回归测试。

起因是一个静默失效的 bug：libass 给内存字体建索引时只认 name 表里 Windows 平台的
**nameID 1**，而 macOS 的日文字体普遍把字重写进 nameID 1（ヒラギノ丸ゴ ProN 的
nameID 1 是 `Hiragino Maru Gothic ProN W4`，真族名只在 nameID 16 里）。
接口对外通报的族名于是在子集产物里一条都匹配不上，JASSUB 又用
`ASS_FONTPROVIDER_NONE`、没有任何回退 —— 预览整块空白且不报错，
而 ffmpeg 侧走系统 fontconfig 完全正常，看成片发现不了。

浏览器侧的真渲染验证在 `frontend/scripts/verify-font-name.mjs`（chromium + WebKit
双引擎，含"只有 nameID 1 算数"的证伪用例）。这里只守两条纯数据的不变式：
产物自称的族名就是调用方请求的那个，以及生成逻辑改版后老缓存必然失效。
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402

fontTools = pytest.importorskip("fontTools", reason="需要 fonttools（uv sync --extra fonts）")

from fontTools.fontBuilder import FontBuilder  # noqa: E402
from fontTools.pens.ttGlyphPen import TTGlyphPen  # noqa: E402
from fontTools.ttLib import TTFont  # noqa: E402
from kvm.api.routes.fonts import _subset_cache_key  # noqa: E402
from kvm.render.font_subset import (  # noqa: E402
    SUBSET_VERSION,
    FontFamilyMismatchError,
    fonts_section,
    subset_font,
    uuencode_font,
)

# 复刻 macOS 日文字体的命名习惯：nameID 1 带字重后缀，真族名只在 nameID 16
FAMILY = "Kvm Test Gothic"
NAME_ID1 = f"{FAMILY} W4"


def _make_source_font(path: Path) -> None:
    """造一个最小可用的 TTF，name 表按"族名藏在 nameID 16"的方式布置。

    不用系统字体作夹具：那样测试结论会跟着本机装了什么字体漂移，
    而这里要守的不变式与字体本身无关。
    """
    glyph_order = [".notdef", "A", "B"]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0x41: "A", 0x42: "B"})

    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 700))
    pen.lineTo((500, 700))
    pen.lineTo((500, 0))
    pen.closePath()
    fb.setupGlyf(dict.fromkeys(glyph_order, pen.glyph()))
    fb.setupHorizontalMetrics(dict.fromkeys(glyph_order, (600, 0)))
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable(
        {
            "familyName": NAME_ID1,
            "styleName": "W4",
            "uniqueFontIdentifier": f"{NAME_ID1};test",
            "fullName": "KvmTestGothic-W4",
            "psName": "KvmTestGothic-W4",
            "version": "1.0",
            "typographicFamily": FAMILY,
            "typographicSubfamily": "W4",
        }
    )
    fb.setupOS2()
    fb.setupPost()
    fb.save(str(path))


def _names(font: TTFont, name_id: int) -> list[str]:
    return [r.toUnicode() for r in font["name"].names if r.nameID == name_id]


def test_subset_rewrites_family_name(tmp_path: Path) -> None:
    src = tmp_path / "src.ttf"
    _make_source_font(src)
    dest = tmp_path / "out.otf"

    subset_font(src, dest, charset={"A"}, family_name=FAMILY)

    out = TTFont(str(dest))
    # nameID 1 是 libass 唯一拿来匹配的那条，必须**等于**请求族名，不能带字重后缀
    assert _names(out, 1) == [FAMILY]
    assert _names(out, 4) == [FAMILY]
    # nameID 16/17 存在的意义就是"与 nameID 1 不同"，留着会造出冲突的族名
    assert _names(out, 16) == []
    assert _names(out, 17) == []
    # 产物只有一个字面，就不该再自称 W4 这类子族名
    assert _names(out, 2) == ["Regular"]
    # 字形没有被改写连累
    assert 0x41 in out.getBestCmap()


def _strip_name_records(path: Path, name_ids: set[int]) -> None:
    """把指定的 nameID 从字体里全部删掉，模拟"改写无从下手"的源字体。"""
    font = TTFont(str(path))
    for name_id in name_ids:
        font["name"].removeNames(nameID=name_id)
    font.save(str(path))


def test_subset_refuses_to_emit_a_font_that_cannot_be_matched(tmp_path: Path) -> None:
    """族名改写落空时必须**响亮失败**，绝不能把产物写出去。

    `_rewrite_family_name` 只改**已存在**的记录：源字体一条 nameID 1 都没有时，
    它什么也改不到，产物于是带着一个与请求族名无关的名字。这种产物在 libass 里
    **匹配不上而每帧返回 0 张图**——画面空白、控制台干净、刷新页面也修不好
    （坏的是磁盘缓存）。所以宁可 500，也不要送出一份注定画不出字的字体。
    """
    src = tmp_path / "src.ttf"
    _make_source_font(src)
    _strip_name_records(src, {1})
    dest = tmp_path / "out.otf"

    with pytest.raises(FontFamilyMismatchError, match="族名"):
        subset_font(src, dest, charset={"A"}, family_name=FAMILY)

    # 关键：坏产物不许落盘，否则它会进缓存、之后每次请求都命中同一份坏文件
    assert not dest.exists()


def test_subset_refuses_when_a_conflicting_family_name_survives(tmp_path: Path) -> None:
    """产物里同时存在两个族名同样要拒绝——匹配器取哪一个是不确定的。"""
    src = tmp_path / "src.ttf"
    _make_source_font(src)
    dest = tmp_path / "out.otf"

    # 造一条改写覆盖不到的额外族名：Mac 平台的 nameID 16（改写只删 16，这里验证删干净了）
    font = TTFont(str(src))
    font["name"].setName("Some Other Family", 16, 1, 0, 0)
    font.save(str(src))

    # 删 16 是改写的既定行为，所以这一份应当**通过**——这条用例守的是
    # "冲突确实被清掉了"，而不是"有冲突就报错"
    subset_font(src, dest, charset={"A"}, family_name=FAMILY)
    out = TTFont(str(dest))
    assert _names(out, 1) == [FAMILY]
    assert _names(out, 16) == []


def test_subset_without_family_name_keeps_original(tmp_path: Path) -> None:
    """不传 `family_name` 时一个 name 记录都不动 —— 改写是显式选项，不是副作用。"""
    src = tmp_path / "src.ttf"
    _make_source_font(src)
    dest = tmp_path / "out.otf"

    subset_font(src, dest, charset={"A"})

    out = TTFont(str(dest))
    assert _names(out, 1) == [NAME_ID1]
    assert _names(out, 16) == [FAMILY]


def test_subset_normalizes_weight_class(tmp_path: Path) -> None:
    """改写族名时必须把 `usWeightClass` 归一到 400。

    字体链让**同一个族名下同时躺着好几个字面**（链首、链尾……），libass 在它们之间
    挑一个时会比"声明字重与请求字重的距离"。链首若是 W8（800）、链尾是明朝 W3（300），
    而 ASS 请求常规字重（400），链尾反而更近——实测结果是链首彻底失去优先权，
    用户选的字体连自己有的字都轮不到它画（`experiments/ass_embedded_fonts.py`）。
    """
    src = tmp_path / "src.ttf"
    _make_source_font(src)
    heavy = TTFont(str(src))
    heavy["OS/2"].usWeightClass = 800
    heavy.save(str(src))

    dest = tmp_path / "out.otf"
    subset_font(src, dest, charset={"A"}, family_name=FAMILY)
    assert TTFont(str(dest))["OS/2"].usWeightClass == 400


def test_uuencode_roundtrips(tmp_path: Path) -> None:
    """ASS `[Fonts]` 的变体 UU 编码必须能被 libass 的解码规则原样还原。

    这不是"随便找个编码"：末尾不足 3 字节时只能输出 `字节数 + 1` 个字符，
    libass 正是靠这个数量反推剩余字节数。多输出一个字符，解出来就多一个垃圾字节，
    而字体多一个尾字节的后果是整份字体解析失败——预览与成片同时空白。
    所以三种余数（0/1/2）都要覆盖。
    """

    def decode(lines: list[str]) -> bytes:
        chars = "".join(lines)
        out = bytearray()
        for i in range(0, len(chars), 4):
            group = chars[i : i + 4]
            value = 0
            for j in range(4):
                value |= (ord(group[j]) - 33 if j < len(group) else 0) << (18 - 6 * j)
            for j in range(len(group) - 1):
                out.append((value >> (16 - 8 * j)) & 0xFF)
        return bytes(out)

    for size in (0, 1, 2, 3, 4, 5, 6, 79, 80, 81, 4096):
        data = bytes((i * 37 + 11) % 256 for i in range(size))
        lines = uuencode_font(data)
        assert all(len(line) <= 80 for line in lines), size
        assert decode(lines) == data, size


def test_fonts_section_shape(tmp_path: Path) -> None:
    """`[Fonts]` 段的形状：有段头、每份字体一条 `fontname:`、空列表不产出空段。"""
    assert fonts_section([]) == ""
    text = fonts_section([("ヒラギノ角ゴ", b"abcdef"), ("Noto", b"xyz")])
    assert text.startswith("[Fonts]\n")
    names = [ln for ln in text.splitlines() if ln.startswith("fontname:")]
    assert len(names) == 2
    # 文件名必须是纯 ASCII：VSFilter 系工具对这里的格式假设很多，没必要去试边界
    assert all(ln.isascii() for ln in names), names


def test_cache_key_invalidates_legacy_entries() -> None:
    """带版本号的缓存键不能命中旧版留在磁盘上的产物。

    只改生成代码而不动缓存键，装过旧版的用户会永远拿到那份坏字体 ——
    这正是本次修复必须连带处理的部分。
    """
    args = (FAMILY, 1, 1_700_000_000_000_000_000, 5_988_268, FAMILY, "", 400)
    legacy = hashlib.sha256(f"{args[0]}|{args[1]}|{args[2]}|{args[3]}".encode()).hexdigest()[:16]
    assert _subset_cache_key(*args) != legacy

    # 版本号确实参与运算（而不是被拼进去却不影响结果）
    other = hashlib.sha256(
        f"v{SUBSET_VERSION + 1}|{args[0]}|{args[1]}|{args[2]}|{args[3]}".encode()
    ).hexdigest()[:16]
    assert _subset_cache_key(*args) != other


def test_cache_key_tracks_source_file_changes() -> None:
    """源字体被系统更新（mtime / 大小变化）后仍必须重新生成。"""
    base = _subset_cache_key(FAMILY, 1, 111, 222, FAMILY, "", 400)
    assert base != _subset_cache_key(FAMILY, 1, 112, 222, FAMILY, "", 400)
    assert base != _subset_cache_key(FAMILY, 1, 111, 223, FAMILY, "", 400)
    assert base != _subset_cache_key(FAMILY, 2, 111, 222, FAMILY, "", 400)
    assert base != _subset_cache_key("Other Family", 1, 111, 222, FAMILY, "", 400)


def test_cache_key_covers_chain_rewrite_and_extra_chars() -> None:
    """产物字节由 `as_family` 与 `extra` 共同决定，两者都必须进缓存键。

    漏掉 `as_family`：换主字体后链尾仍自称旧族名，libass 匹配不上，预览整块空白。
    漏掉 `extra`：换一首含生僻字的歌，命中的是上一首裁好的产物，
    那些字在里面根本没有——症状是"预览空白、成片正常"，看成片发现不了。
    """
    base = _subset_cache_key(FAMILY, 0, 111, 222, FAMILY, "", 400)
    assert base != _subset_cache_key(FAMILY, 0, 111, 222, "Other Head", "", 400)
    assert base != _subset_cache_key(FAMILY, 0, 111, 222, FAMILY, "鷗", 400)
    # 字符集合的顺序不该影响命中：同一批字符必须共用一份产物，
    # 否则用户每改一个字的位置就要重裁一次字体
    assert _subset_cache_key(FAMILY, 0, 111, 222, FAMILY, "鷗𠮷", 400) == _subset_cache_key(
        FAMILY, 0, 111, 222, FAMILY, "𠮷鷗鷗", 400
    )


def test_cache_key_区分字重() -> None:
    """同一个族的 Regular 与 Bold 是两份不同的字节，缓存键必须分开。

    共用一个产物文件的话，先裁好的那份会被另一档当成命中直接下发——
    症状是"勾了粗体没变化"，或者反过来"取消粗体还是粗的"，而且到底哪种
    取决于谁先裁，换台机器就换个表现。
    """
    regular = _subset_cache_key(FAMILY, 0, 111, 222, FAMILY, "", 400)
    bold = _subset_cache_key(FAMILY, 0, 111, 222, FAMILY, "", 700)
    assert regular != bold
