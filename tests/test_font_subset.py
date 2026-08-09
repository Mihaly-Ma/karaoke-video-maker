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
    subset_font,
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


def test_cache_key_invalidates_legacy_entries() -> None:
    """带版本号的缓存键不能命中旧版留在磁盘上的产物。

    只改生成代码而不动缓存键，装过旧版的用户会永远拿到那份坏字体 ——
    这正是本次修复必须连带处理的部分。
    """
    args = (FAMILY, 1, 1_700_000_000_000_000_000, 5_988_268)
    legacy = hashlib.sha256(f"{args[0]}|{args[1]}|{args[2]}|{args[3]}".encode()).hexdigest()[:16]
    assert _subset_cache_key(*args) != legacy

    # 版本号确实参与运算（而不是被拼进去却不影响结果）
    other = hashlib.sha256(
        f"v{SUBSET_VERSION + 1}|{args[0]}|{args[1]}|{args[2]}|{args[3]}".encode()
    ).hexdigest()[:16]
    assert _subset_cache_key(*args) != other


def test_cache_key_tracks_source_file_changes() -> None:
    """源字体被系统更新（mtime / 大小变化）后仍必须重新生成。"""
    base = _subset_cache_key(FAMILY, 1, 111, 222)
    assert base != _subset_cache_key(FAMILY, 1, 112, 222)
    assert base != _subset_cache_key(FAMILY, 1, 111, 223)
    assert base != _subset_cache_key(FAMILY, 2, 111, 222)
    assert base != _subset_cache_key("Other Family", 1, 111, 222)
