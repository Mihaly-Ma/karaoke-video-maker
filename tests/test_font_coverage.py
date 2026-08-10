"""字形覆盖预检接口（`POST /api/fonts/coverage`）的回归测试。

这个接口此前是**死代码**——后端实现完整、前端 `checkFontCoverage` 也写好了，
但界面上一处都没调用，于是 CLAUDE.md §2.6 / §6.3 要求的"缺字必须在渲染前拦截"
从来没有生效过：用户一路做到导出，成片里才发现某个生僻字变成豆腐块。
接进界面的同时补上这组测试，守住接口的两条语义。

字体从单个族名变成**有序候选链**之后，这个接口回答的问题也跟着变了：

- `missing` 问的是"**整条链**够不够"——链尾补上的字不再算缺字，那正是加链尾的目的；
- `shares` 问的是"**每个字实际由哪个字体承担**"。用户配了链却看不出链尾有没有
  被用到，等于配了个不知道有没有生效的东西。

`preview_missing`（字体有、预览子集裁掉了）现在**恒为空**：子集会按本曲字符集
加裁（`/subset` 的 `extra`），凡是链里有的字预览就有。字段与语义仍然留着，
因为它曾经非空，症状是"预览空白、成片正常"——与缺字相反的分叉，看成片发现不了。
哪些字是靠加裁补上的改由 `extra_chars` 报告，那是提示不是缺陷。
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
FALLBACK_FAMILY = "Kvm Coverage Fallback"

# 三类字符各取一个代表，它们必须落进三个不同的结论里：
#   あ  链首有、默认子集也有          → 完全没问题
#   鷗  链首有、默认子集没有（非 JIS X 0208）→ 靠 `extra` 加裁补上，进 extra_chars
#   Ω   链首没有                    → 要么由链尾承担，要么进 missing
IN_BOTH = "あ"
FONT_ONLY = "鷗"
NOWHERE = "Ω"


def _make_font(path: Path, codepoints: list[int], family: str = FAMILY) -> None:
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
            "familyName": family,
            "styleName": "Regular",
            "uniqueFontIdentifier": f"{family};test",
            "fullName": family,
            "psName": "KvmCoverageTest-Regular",
            "version": "1.0",
        }
    )
    fb.setupOS2()
    fb.setupPost()
    fb.save(str(path))


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """挂一个只含字体路由的应用，并把系统字体扫描替换成两枚假字体（链首 + 链尾）。

    绕开真实扫描是刻意的：真扫描要 40 秒，且结果取决于本机装了什么。

    `KVM_DATA_DIR` 指向 tmp：`/coverage` 会顺带预热整条链的子集产物
    （见 `preheat_chain`），不隔离的话测试会往用户真正的字体缓存目录里写东西。
    """
    monkeypatch.setenv("KVM_DATA_DIR", str(tmp_path / "projects"))

    src = tmp_path / "coverage.ttf"
    _make_font(src, [ord(IN_BOTH), ord(FONT_ONLY)])
    tail = tmp_path / "fallback.ttf"
    _make_font(tail, [ord(IN_BOTH), ord(NOWHERE)], family=FALLBACK_FAMILY)

    fake = fonts_routes.FontInfo(family=FAMILY, path=str(src), index=0, is_cjk=True)
    fake_tail = fonts_routes.FontInfo(
        family=FALLBACK_FAMILY, path=str(tail), index=0, is_cjk=True
    )
    monkeypatch.setattr(fonts_routes, "available_fonts", lambda: [fake, fake_tail])
    monkeypatch.setattr(
        fonts_routes,
        "_status_snapshot",
        lambda: fonts_routes.FontScanStatus(
            state="ready",
            message="测试夹具",
            family_count=2,
            scanned_files=2,
            total_files=2,
            elapsed_s=0.0,
            from_cache=True,
        ),
    )

    app = FastAPI()
    app.include_router(fonts_routes.router)
    return TestClient(app)


def _check(client: TestClient, text: str, families: list[str] | None = None) -> dict:
    payload: dict = {"text": text}
    if families is None:
        payload["family"] = FAMILY
    else:
        payload["families"] = families
    resp = client.post("/api/fonts/coverage", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_full_coverage_reports_nothing_missing(client: TestClient) -> None:
    body = _check(client, IN_BOTH * 3)
    assert body["missing"] == []
    assert body["preview_missing"] == []
    # 去重后只剩一个字符——请求方送整首歌词时不该按出现次数重复计数
    assert body["total_checked"] == 1


def test_missing_glyph_is_reported(client: TestClient) -> None:
    """整条链都没有的字形：预览与成片都会缺，进 `missing`。"""
    body = _check(client, IN_BOTH + NOWHERE)
    assert body["missing"] == [NOWHERE]
    assert body["preview_missing"] == []


def test_rare_char_needs_extra_but_is_not_a_defect(client: TestClient) -> None:
    """默认子集之外的字进 `extra_chars`，**不进** `preview_missing`。

    以前它算"只有预览缺"，因为子集固定按 JIS X 0208 裁。现在子集会按本曲字符集
    加裁，这个字预览一样画得出来——继续报成缺陷就是假警报，而假警报的代价是
    用户学会忽略这一栏，真出问题时也看不见。
    """
    body = _check(client, IN_BOTH + FONT_ONLY)
    assert body["missing"] == []
    assert body["preview_missing"] == []
    assert body["extra_chars"] == FONT_ONLY


def test_chain_tail_covers_what_the_head_lacks(client: TestClient) -> None:
    """链尾补上的字**不算缺字**——那正是配置链尾的目的。"""
    solo = _check(client, IN_BOTH + NOWHERE, families=[FAMILY])
    assert solo["missing"] == [NOWHERE]

    chained = _check(client, IN_BOTH + NOWHERE, families=[FAMILY, FALLBACK_FAMILY])
    assert chained["missing"] == []
    assert chained["families"] == [FAMILY, FALLBACK_FAMILY]


def test_shares_attribute_each_char_to_one_font(client: TestClient) -> None:
    """每个字只能记在**第一个**能提供它的字体名下。

    否则"链首承担了多少字"会被链尾重复计数，用户看不出链首其实已经覆盖了绝大部分，
    也就判断不了链尾到底有没有必要。
    """
    body = _check(client, IN_BOTH + FONT_ONLY + NOWHERE, families=[FAMILY, FALLBACK_FAMILY])
    shares = {s["family"]: s["chars"] for s in body["shares"]}
    # IN_BOTH 两个字体都有，必须归链首
    assert shares[FAMILY] == "".join(sorted(IN_BOTH + FONT_ONLY))
    assert shares[FALLBACK_FAMILY] == NOWHERE
    assert [s["family"] for s in body["shares"]] == [FAMILY, FALLBACK_FAMILY]
    joined = "".join(s["chars"] for s in body["shares"])
    assert sorted(joined) == sorted(IN_BOTH + FONT_ONLY + NOWHERE)


def test_legacy_single_family_request_still_works(client: TestClient) -> None:
    """老调用方只发 `family`，必须照常工作并回填 `families`。"""
    body = _check(client, IN_BOTH)
    assert body["family"] == FAMILY
    assert body["families"] == [FAMILY]


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
