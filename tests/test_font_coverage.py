"""字形覆盖预检接口（`POST /api/fonts/coverage`）的回归测试。

这个接口此前是**死代码**——后端实现完整、前端 `checkFontCoverage` 也写好了，
但界面上一处都没调用，于是 CLAUDE.md §2.6 / §6.3 要求的"缺字必须在渲染前拦截"
从来没有生效过：用户一路做到导出，成片里才发现某个生僻字变成豆腐块。
接进界面的同时补上这组测试，守住接口的两条语义。

**两条渲染链路的字体来源不同，所以缺字有两种，不能只报一种：**

- 导出走 ffmpeg + 系统 fontconfig，用的是系统**原字体** → 判据是它的 cmap；
- 预览走 JASSUB（`ASS_FONTPROVIDER_NONE`），吃的是 `/fonts/subset` 产出的
  **子集字体** → 判据是 cmap 与 `default_charset()` 的交集。

后者的字符集（ASCII + 假名 + JIS X 0208 第一/第二水准）远小于系统字体，
「鷗」「𠮷」「α」这类字会出现"预览空白、成片正常"的**反向**分叉。
只报 `missing` 会在这种情况下给出一个假的全绿，所以 `preview_missing` 必须独立成一份。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402

pytest.importorskip("fontTools", reason="需要 fonttools（uv sync --extra fonts）")
pytest.importorskip("fastapi", reason="需要 fastapi（uv sync --extra api）")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from fontTools.fontBuilder import FontBuilder  # noqa: E402
from fontTools.pens.ttGlyphPen import TTGlyphPen  # noqa: E402
from kvm.api.routes import fonts as fonts_routes  # noqa: E402

FAMILY = "Kvm Coverage Test"

# 三类字符各取一个代表，它们必须落进三个不同的结论里：
#   あ  子集有、字体也有            → 两处都没问题
#   鷗  字体有、子集没有（非 JIS X 0208）→ 只有预览缺
#   Ω   字体压根没有                 → 预览与成片都缺
IN_BOTH = "あ"
FONT_ONLY = "鷗"
NOWHERE = "Ω"


def _make_font(path: Path, codepoints: list[int]) -> None:
    """造一个只含指定码位的最小 TTF。

    不拿系统字体当夹具：那样结论会跟着本机装了什么字体漂移，
    而这里要守的不变式与具体字体无关。
    """
    glyph_order = [".notdef", *[f"c{cp:04X}" for cp in codepoints]]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({cp: f"c{cp:04X}" for cp in codepoints})

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
            "familyName": FAMILY,
            "styleName": "Regular",
            "uniqueFontIdentifier": f"{FAMILY};test",
            "fullName": FAMILY,
            "psName": "KvmCoverageTest-Regular",
            "version": "1.0",
        }
    )
    fb.setupOS2()
    fb.setupPost()
    fb.save(str(path))


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """挂一个只含字体路由的应用，并把系统字体扫描替换成上面这枚假字体。

    绕开真实扫描是刻意的：真扫描要 40 秒，且结果取决于本机装了什么。
    """
    src = tmp_path / "coverage.ttf"
    _make_font(src, [ord(IN_BOTH), ord(FONT_ONLY)])

    fake = fonts_routes.FontInfo(family=FAMILY, path=str(src), index=0, is_cjk=True)
    monkeypatch.setattr(fonts_routes, "available_fonts", lambda: [fake])
    monkeypatch.setattr(
        fonts_routes,
        "_status_snapshot",
        lambda: fonts_routes.FontScanStatus(
            state="ready",
            message="测试夹具",
            family_count=1,
            scanned_files=1,
            total_files=1,
            elapsed_s=0.0,
            from_cache=True,
        ),
    )

    app = FastAPI()
    app.include_router(fonts_routes.router)
    return TestClient(app)


def _check(client: TestClient, text: str) -> dict:
    resp = client.post("/api/fonts/coverage", json={"family": FAMILY, "text": text})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_full_coverage_reports_nothing_missing(client: TestClient) -> None:
    body = _check(client, IN_BOTH * 3)
    assert body["missing"] == []
    assert body["preview_missing"] == []
    # 去重后只剩一个字符——请求方送整首歌词时不该按出现次数重复计数
    assert body["total_checked"] == 1


def test_missing_glyph_is_reported(client: TestClient) -> None:
    """字体没有的字形：预览与成片都会缺，进 `missing`。"""
    body = _check(client, IN_BOTH + NOWHERE)
    assert body["missing"] == [NOWHERE]
    assert body["preview_missing"] == []


def test_preview_only_gap_is_reported_separately(client: TestClient) -> None:
    """字体有、预览子集没有的字形必须单独成一份。

    合并进 `missing` 会误导用户去换字体（换了也没用，成片本来就是好的）；
    完全不报则是假的全绿——预览里那个字是空的，而 WYSIWYG 正是靠预览兑现的。
    """
    body = _check(client, IN_BOTH + FONT_ONLY)
    assert body["missing"] == []
    assert body["preview_missing"] == [FONT_ONLY]


def test_both_kinds_are_disjoint(client: TestClient) -> None:
    """同一个字符不能同时出现在两份清单里——两份清单的并集才是"有问题的字"。"""
    body = _check(client, IN_BOTH + FONT_ONLY + NOWHERE)
    assert body["missing"] == [NOWHERE]
    assert body["preview_missing"] == [FONT_ONLY]
    assert set(body["missing"]).isdisjoint(body["preview_missing"])
    assert body["total_checked"] == 3


def test_whitespace_is_not_counted(client: TestClient) -> None:
    """空白不算缺字：缺一个空格不影响观感，全角空格算进来只会制造噪声。"""
    body = _check(client, f"{IN_BOTH} 　\n\t")
    assert body["missing"] == []
    assert body["preview_missing"] == []
    assert body["total_checked"] == 1


def test_unknown_family_is_404(client: TestClient) -> None:
    """扫描已完成时找不到字体才是 404；扫描中返回 503（`_require_font` 的分支）。"""
    resp = client.post("/api/fonts/coverage", json={"family": "No Such Font", "text": "あ"})
    assert resp.status_code == 404


def test_params_go_in_the_body_not_the_query(client: TestClient) -> None:
    """请求体契约的守卫。

    参数曾经声明成 query。整首歌的字符集 percent-encode 后每个汉字 9 字节，
    几百个不重复字符就逼近 uvicorn 的 16 KB 请求行上限，超限时连接被掐断、
    连可读的 4xx 都没有。改成请求体后要防止有人"顺手"改回去。
    """
    resp = client.post(f"/api/fonts/coverage?family={FAMILY}&text={IN_BOTH}")
    assert resp.status_code == 422
