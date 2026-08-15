"""画布几何：非 16:9 的源上"字的比例不对"的三个来源，各自的回归保护。

三条来源互不相同、症状却一样，所以要分开验（`kvm.render.geometry` 模块文档
有对照表）：

1. **PlayRes ≠ 实际帧尺寸** —— 曾经下载路径根本不回写画面尺寸，工程停在默认
   1920×1080，libass 于是按 `帧高/1080` 缩字号、按 `帧宽/1920` 缩坐标，两个
   比例不等就把字挤变形。这一条由 `test_download_writes_display_size` 守。
2. **字号只锚高度** —— `layout_ref_height`。这里最重要的断言是
   **16:9 上它必须恒等于画面高度**：那是"既有成片逐像素不变"的全部依据，
   一旦它在 16:9 上偏了一个像素，所有已验证的默认值都要重新校准。
3. **非方形像素** —— `display_size` + 烧录时的 `scale,setsar=1`。

补边那一组另外守两件事：滤镜必须排在 `ass=` **之前**（否则字会跟着画面一起被
缩进黑边），以及尺寸与偏移**全部取偶**（`yuv420p` 下奇数会让 ffmpeg 当场拒绝，
而那是一条与"补边"完全无关的报错，排查时很误导）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.media.download import _video_geometry  # noqa: E402
from kvm.render.geometry import (  # noqa: E402
    display_size,
    layout_ref_height,
    parse_ratio,
    plan_canvas,
)

# ---- 版面锚点 ----


@pytest.mark.parametrize(
    ("width", "height"),
    [(1920, 1080), (3840, 2160), (1280, 720), (2560, 1440), (854, 480)],
)
def test_ref_height_is_identity_on_16_9(width: int, height: int) -> None:
    """16:9 上锚点 == 画面高度。

    **这是整个改动"对既有成片零影响"的唯一依据**：字号、描边、阴影、行距全部
    由它派生，它在 16:9 上但凡差一个像素，赤春花那份已验证的成片就变了。
    """
    assert layout_ref_height(width, height) == height


def test_ref_height_leaves_4_3_alone() -> None:
    """4:3 一行本来就放得下 23 个全角字，不该被压。

    这是"按容量封顶"与"取内接 16:9 框高度"的分水岭：后者会把 4:3 白白缩掉
    25%，字小了而问题（PlayRes 对不上）根本不在这儿。
    """
    assert layout_ref_height(1440, 1080) == 1080


def test_ref_height_caps_square_and_portrait() -> None:
    """1:1 与竖屏才真的放不下，此时按宽度封顶。

    1080 宽的画面上：ref=944 → 字号 70px，占画面高 6.5%，一行 20 个全角字。
    """
    assert layout_ref_height(1080, 1080) == 944
    assert layout_ref_height(1080, 1920) == 944


def test_ref_height_caps_at_height_on_ultrawide() -> None:
    """比 16:9 宽的画面仍以高度为准——宽出来的部分是余量，不该把字撑大。"""
    assert layout_ref_height(2560, 1080) == 1080
    assert layout_ref_height(3440, 1440) == 1440


def test_ref_height_degrades_on_missing_dims() -> None:
    """尺寸缺失时不抛异常（工程可能只有音轨），返回值仍是正数。"""
    assert layout_ref_height(0, 0) >= 1


# ---- 像素宽高比 ----


def test_parse_ratio_treats_0_1_as_unknown() -> None:
    """ffprobe 用 `0:1` 表示未知，与 `1:1` 完全不是一回事。

    当成数值去做除法会得到 ZeroDivisionError 或无穷大——探测一次失败就让整条
    导出链路炸掉，而根因看起来与画面尺寸毫无关系。
    """
    assert parse_ratio("0:1") is None
    assert parse_ratio("") is None
    assert parse_ratio(None) is None
    assert parse_ratio("1:1") == 1.0
    assert parse_ratio("4:3") == pytest.approx(4 / 3)


def test_display_size_widens_anamorphic_source() -> None:
    """1440×1080 + SAR 4:3 实际显示是 1920×1080（DVD/TV 转录的典型形态）。"""
    assert display_size(1440, 1080, "4:3") == (1920, 1080)


def test_display_size_grows_the_short_side() -> None:
    """SAR < 1 时抬高而不是削宽：补边不丢细节，缩边会。"""
    assert display_size(1920, 1080, "1:2") == (1920, 2160)


def test_display_size_is_noop_for_square_pixels() -> None:
    assert display_size(1920, 1080, "1:1") == (1920, 1080)
    assert display_size(1920, 1080, None) == (1920, 1080)


# ---- 画布计划 ----


def test_plan_canvas_noop_on_plain_16_9() -> None:
    """方形像素的 16:9 源不加任何滤镜——默认路径必须与改动前完全一致。"""
    plan = plan_canvas(3840, 2160)
    assert (plan.width, plan.height) == (3840, 2160)
    assert plan.filters == ()
    assert not plan.transforms


def test_plan_canvas_normalizes_anamorphic_even_without_padding() -> None:
    """非方形像素**不需要用户开关**就得归一：不归一的话成片交给播放器再拉一次，
    字跟着画面一起被横向拉伸，而画面看着是正常的，很容易误判成字体问题。
    """
    plan = plan_canvas(1440, 1080, sar="4:3")
    assert (plan.width, plan.height) == (1920, 1080)
    assert plan.filters == ("scale=1920:1080", "setsar=1")
    assert "非方形像素" in plan.note


def test_plan_canvas_pads_4_3_to_16_9() -> None:
    plan = plan_canvas(1440, 1080, pad_to_16_9=True)
    assert (plan.width, plan.height) == (1920, 1080)
    assert plan.filters[-1] == "pad=1920:1080:240:0:black"


def test_plan_canvas_pads_ultrawide_vertically() -> None:
    """比 16:9 宽的源补上下黑边，宽度不动。"""
    plan = plan_canvas(2560, 1080, pad_to_16_9=True)
    assert (plan.width, plan.height) == (2560, 1440)
    assert plan.filters[-1] == "pad=2560:1440:0:180:black"


def test_plan_canvas_skips_padding_on_mod16_height() -> None:
    """1920×1088 是 mod-16 对齐的常见尺寸，离 16:9 只差 0.74%。

    照直补出个 1935×1088 纯属添乱，所以容差必须盖住它。
    """
    plan = plan_canvas(1920, 1088, pad_to_16_9=True)
    assert (plan.width, plan.height) == (1920, 1088)
    assert plan.filters == ()


def test_plan_canvas_pads_portrait_within_the_side_cap() -> None:
    """竖屏补成 16:9 画面只占中间一条，这是画幅本身的结果，不是可以修掉的东西；
    能做的只是**别让画布无限膨胀**。1080×1920 补出 3414×1920 仍在上限内。
    """
    plan = plan_canvas(1080, 1920, pad_to_16_9=True)
    assert (plan.width, plan.height) == (3414, 1920)
    assert plan.filters[-1].startswith("pad=3414:1920:")


def test_plan_canvas_scales_down_when_pad_would_blow_past_the_cap() -> None:
    """4K 竖屏补 16:9 要 6826 宽——超过长边上限就整体缩小，画面同比缩、不裁切。"""
    plan = plan_canvas(2160, 3840, pad_to_16_9=True)
    assert (plan.width, plan.height) == (3840, 2160)
    assert plan.filters[0].startswith("scale=")
    assert plan.filters[-1].startswith("pad=3840:2160:")


@pytest.mark.parametrize(
    ("coded", "sar", "pad"),
    [
        ((1440, 1080), "4:3", False),
        ((1440, 1080), None, True),
        ((2560, 1080), None, True),
        ((1080, 1920), None, True),
        ((1440, 1080), "4:3", True),
    ],
)
def test_plan_canvas_emits_only_even_geometry(
    coded: tuple[int, int], sar: str | None, pad: bool
) -> None:
    """尺寸与偏移一律取偶。

    `yuv420p` 的色度平面按 2×2 取样，奇数边长或奇数 pad 偏移会让 ffmpeg 直接
    报错——而报出来的话与"补边"毫无关系，排查时会往编码参数上找。
    """
    plan = plan_canvas(coded[0], coded[1], sar=sar, pad_to_16_9=pad)
    assert plan.width % 2 == 0
    assert plan.height % 2 == 0
    for f in plan.filters:
        if f.startswith(("scale=", "pad=")):
            numbers = [int(p) for p in f.split("=", 1)[1].split(":") if p.isdigit()]
            assert all(n % 2 == 0 for n in numbers), f


def test_plan_canvas_orders_scale_before_pad() -> None:
    """缩放必须排在补边之前，否则缩放会把已经补好的黑边一起缩掉。

    取一个两件事都会发生的输入：1440×1080 + SAR 2:1 显示为 2880×1080（比 16:9
    宽），既要归方又要补上下黑边。
    """
    plan = plan_canvas(1440, 1080, sar="2:1", pad_to_16_9=True)
    kinds = [f.split("=", 1)[0] for f in plan.filters]
    assert "scale" in kinds
    assert "pad" in kinds
    assert kinds.index("scale") < kinds.index("pad")


# ---- 写回工程的尺寸 ----


def test_download_writes_display_size() -> None:
    """下载/导入回写工程的是**显示尺寸**，不是编码尺寸。

    这条守的是本次修复的第一来源：曾经下载路径压根不回写尺寸，工程停在默认
    1920×1080，非 16:9 的源上 PlayRes 与帧尺寸的比例不等，字当场变形。
    """
    geo = _video_geometry({"width": 1440, "height": 1080, "sample_aspect_ratio": "4:3"})
    assert (geo["video_width"], geo["video_height"]) == (1920, 1080)
    assert (geo["video_coded_width"], geo["video_coded_height"]) == (1440, 1080)


def test_download_geometry_survives_missing_stream() -> None:
    """只有音轨的容器不该让整次下载失败（§2.5 降级不终止）。"""
    geo = _video_geometry({})
    assert geo["video_width"] is None
    assert geo["video_height"] is None


# ---- 预览与导出必须按同一个画布排版 ----


def test_预览ass的playres跟随补边开关(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """勾了「补黑边到 16:9」，预览拿到的 ASS 必须换画布。

    守的是一条**接线**而不是一段算法：补边规则本身由上面那组 `plan_canvas` 测试
    覆盖，这里验的是"路由参数真的走到了 `_build_ass_text` 的画布上"。

    第一版把补边做成了纯导出选项，预览纹丝不动——用户只能靠导出成片来确认版面，
    而那正是这个工具要消灭的东西（CLAUDE.md §5.12 WYSIWYG）。这类"存在但没接上"
    的缺陷不会被任何算法测试发现，只有打在契约上的断言才拦得住（§2.6）。
    """
    monkeypatch.setenv("KVM_DATA_DIR", str(tmp_path / "projects"))
    from fastapi.testclient import TestClient
    from kvm.api.app import app

    with TestClient(app) as client:
        pid = client.post("/api/projects/", json={"title": "方画幅"}).json()["id"]

        def _square(p: object) -> None:
            p.video_width = 1080  # type: ignore[attr-defined]
            p.video_height = 1080  # type: ignore[attr-defined]

        app.state.store.mutate(pid, _square)

        def playres(pad: bool) -> tuple[int, int]:
            r = client.post("/api/render/ass", json={"project_id": pid, "pad_to_16_9": pad})
            assert r.status_code == 200, r.text
            ass = r.json()["ass"]
            x = int(re.search(r"PlayResX:\s*(\d+)", ass).group(1))  # type: ignore[union-attr]
            y = int(re.search(r"PlayResY:\s*(\d+)", ass).group(1))  # type: ignore[union-attr]
            return x, y

        assert playres(False) == (1080, 1080)
        assert playres(True) == (1920, 1080)
