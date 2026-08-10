"""配色方案：可读性不变式 + 方案库（保存 / 改名 / 删除）+ 逐声部施加。

## 为什么配色需要单元测试

配色看起来是"审美问题"，但卡拉OK 字幕压的是 **MV 画面**，不是纯色底——
"压在任意画面上仍读得清"是可判定的工程约束，不是口味。而配色表是一堆
十六进制串，改错一位肉眼很难发现（ASS 还是 BGR 序，与直觉相反）。

## 这里守着的那个已经犯过的错

配色方案一度带着 `dict[声部名 → PaletteDTO]`，内置方案按 `main` / `duet_a` /
`duet_b` / `chorus` 写死。**而声部名是用户自定义的**——编辑舞台可以新建任意名字的
声部、也可以就地改名（连 `main` 都能改）。真实工程里的声部叫「男」「女」「合」，
于是按名字取色必然落空、每个声部拿到同一组颜色，**不报错也不提示**。
所以本文件里有一条专门的回归：**任意声部名都要能正确取到色**
（`test_apply_accepts_any_user_defined_part_name`）。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from kvm.api.app import app as fastapi_app  # noqa: E402
from kvm.api.schemas import PaletteDTO  # noqa: E402
from kvm.editing import ops  # noqa: E402

# ---- 判据阈值 ----

MIN_CONTRAST = 4.5
"""填充 vs 描边的 WCAG 对比度下限。

取 4.5（WCAG AA 对正文的要求）而不是更低：字能从杂乱画面里跳出来全靠描边，
描边与填充亮度接近时整个字糊成一团，此时背景再乱就彻底读不出。
现有 12 套方案的实测值全部 ≥ 5.1，阈值不是贴着数据划的。
"""

MIN_STATE_DISTANCE = 90.0
"""未唱填充 vs 已唱填充的 RGB 欧氏距离下限（最大可能值 441）。

差得不够就看不出扫色走到哪个字了，走字字幕退化成静态字幕——
这是卡拉OK 字幕最本质的那条信息。
"""

MIN_VARIANT_DISTANCE = 60.0
"""同一家族内两个变体的**已唱**填充距离下限。

家族里的变体是给对唱的两位歌手准备的，已唱色必须分得开，否则分色白做。
"""

MIN_UNSUNG_DE = 25.0
"""未唱态的感知色差下限（CIELAB ΔE76），家族之间与家族内变体之间都卡这条。

25 大致是"扫一眼就说得出不一样"。上一版在这条上是 **0**：三个家族的底色同为纯白、
同一家族内各变体的未唱色**完全相同**——所以这条判据能把上一版判红，不是摆设。
"""

MIN_OUTLINE_CHROMA = 18.0
"""未唱描边的 CIELAB 色度下限。

声部身份压在描边色相上，那描边就必须**真的看得出色相**。上一版的「深褐」`#2A1400`
色度只有 16.4、L* 只有 8.9——暗到在描边宽度下与近黑分不出来，等于**假装有区别**。
假装有区别比没有区别更糟：用户按说明选了一套，结果和上一套长得一样，
会觉得整个功能不可信。
"""


def _srgb_to_linear(channel: int) -> float:
    value = channel / 255
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def _parse_ass(color: str) -> tuple[int, int, int]:
    """`&HAABBGGRR&` → `(r, g, b)`。**BGR 序**，与直觉相反，这正是要单独解析的原因。"""
    hexed = color.strip().upper().removeprefix("&H").removesuffix("&").rjust(8, "0")
    blue = int(hexed[2:4], 16)
    green = int(hexed[4:6], 16)
    red = int(hexed[6:8], 16)
    return red, green, blue


def _luminance(color: str) -> float:
    red, green, blue = _parse_ass(color)
    return (
        0.2126 * _srgb_to_linear(red)
        + 0.7152 * _srgb_to_linear(green)
        + 0.0722 * _srgb_to_linear(blue)
    )


def _contrast(a: str, b: str) -> float:
    lum_a, lum_b = _luminance(a), _luminance(b)
    high, low = max(lum_a, lum_b), min(lum_a, lum_b)
    return (high + 0.05) / (low + 0.05)


def _distance(a: str, b: str) -> float:
    ra, ga, ba = _parse_ass(a)
    rb, gb, bb = _parse_ass(b)
    return ((ra - rb) ** 2 + (ga - gb) ** 2 + (ba - bb) ** 2) ** 0.5


def _lab(color: str) -> tuple[float, float, float]:
    """sRGB → CIELAB（D65）。感知色差要在这个空间里量，RGB 欧氏距离在暗部会骗人。"""
    red, green, blue = (_srgb_to_linear(c) for c in _parse_ass(color))
    x = 0.4124 * red + 0.3576 * green + 0.1805 * blue
    y = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    z = 0.0193 * red + 0.1192 * green + 0.9505 * blue

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x / 0.95047), f(y), f(z / 1.08883)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def _delta_e(a: str, b: str) -> float:
    la, aa, ba = _lab(a)
    lb, ab, bb = _lab(b)
    return ((la - lb) ** 2 + (aa - ab) ** 2 + (ba - bb) ** 2) ** 0.5


def _chroma(color: str) -> float:
    _l, a, b = _lab(color)
    return (a * a + b * b) ** 0.5


def _family(name: str) -> str:
    """方案名形如「家族 · 变体」，家族名就是分隔符左边那截。"""
    return name.split("·")[0].strip()


def _by_family() -> dict[str, list]:
    out: dict[str, list] = {}
    for scheme in ops.builtin_palette_schemes():
        out.setdefault(_family(scheme.name), []).append(scheme)
    return out


def _is_swap(colors) -> bool:
    """已唱的填充/描边正好是未唱那两个色互换——对调机制在四个色上是可观察的，
    不需要给模型加一个"机制"字段。"""
    return colors.sung_fill == colors.unsung_outline and colors.sung_outline == colors.unsung_fill


BLACK = "&H00000000&"
WHITE = "&H00FFFFFF&"


# ---- 内置方案的不变式 ----


def test_rgb_helper_produces_bgr_order() -> None:
    """`_rgb` 必须做 RGB→BGR 的对调。写反了配色表整体红蓝互换，且不会报错。"""
    assert ops._rgb("#FF0000") == "&H000000FF&"
    assert ops._rgb("#0000FF") == "&H00FF0000&"
    assert ops._rgb("#102030") == "&H00302010&"


def test_rgb_helper_rejects_bad_input() -> None:
    with pytest.raises(ValueError, match="RRGGBB"):
        ops._rgb("#FFF")


def test_scheme_count_in_range() -> None:
    """方案数量：太少覆盖不了不同画面类型，太多用户挑不动。"""
    assert 8 <= len(ops.builtin_palette_schemes()) <= 12


def test_schemes_carry_no_voice_part() -> None:
    """**方案不得带声部维度。**

    这条是那个静默失效缺陷的直接回归：方案一旦按声部名索引，用户改名/新建声部后
    取色必然落空。方案只是一组四色，写给谁由界面决定。
    """
    for scheme in ops.builtin_palette_schemes():
        assert not hasattr(scheme, "palettes"), scheme.name
        assert scheme.colors.unsung_fill and scheme.colors.unsung_outline
        assert scheme.colors.sung_fill and scheme.colors.sung_outline


def test_every_scheme_has_a_description() -> None:
    for scheme in ops.builtin_palette_schemes():
        assert scheme.description.strip(), f"{scheme.name} 没有说明"
        assert scheme.builtin


def test_scheme_names_are_unique() -> None:
    names = [scheme.name for scheme in ops.builtin_palette_schemes()]
    assert len(names) == len(set(names))


def test_builtin_schemes_are_fresh_copies() -> None:
    """调用方改坏了不能污染下一次。"""
    ops.builtin_palette_schemes()[0].colors.sung_fill = "&H00000000&"

    assert ops.builtin_palette_schemes()[0].colors.sung_fill != "&H00000000&"


def test_fill_outline_contrast_is_readable() -> None:
    """未唱层与已唱层各自的填充/描边对比度都要够——描边是字从画面里跳出来的唯一手段。"""
    weak: list[str] = []
    for scheme in ops.builtin_palette_schemes():
        for layer, fill, outline in (
            ("未唱", scheme.colors.unsung_fill, scheme.colors.unsung_outline),
            ("已唱", scheme.colors.sung_fill, scheme.colors.sung_outline),
        ):
            ratio = _contrast(fill, outline)
            if ratio < MIN_CONTRAST:
                weak.append(f"{scheme.name}/{layer} 对比度 {ratio:.2f}")
    assert not weak, "；".join(weak)


def test_readable_on_any_backdrop() -> None:
    """**任意底判据**：纯黑与纯白两个极端上，填充与描边至少有一个能跳出来。

    卡拉OK 字幕压的是 MV 画面，底可能是任何亮度。判据写成"至少一个"而不是
    "填充必须"，是因为对调机制下已唱填充是深色、靠翻上来的白描边保护——
    按"填充必须"写会把一个本来完全可读的组合误杀。
    """
    weak: list[str] = []
    for scheme in ops.builtin_palette_schemes():
        for layer, fill, outline in (
            ("未唱", scheme.colors.unsung_fill, scheme.colors.unsung_outline),
            ("已唱", scheme.colors.sung_fill, scheme.colors.sung_outline),
        ):
            for backdrop, label in ((BLACK, "纯黑底"), (WHITE, "纯白底")):
                best = max(_contrast(fill, backdrop), _contrast(outline, backdrop))
                if best < MIN_CONTRAST:
                    weak.append(f"{scheme.name}/{layer} 在{label}上只有 {best:.2f}")
    assert not weak, "；".join(weak)


def test_sung_differs_from_unsung() -> None:
    """扫色要看得出走到哪——未唱与已唱的填充色必须差得开。"""
    weak: list[str] = []
    for scheme in ops.builtin_palette_schemes():
        dist = _distance(scheme.colors.unsung_fill, scheme.colors.sung_fill)
        if dist < MIN_STATE_DISTANCE:
            weak.append(f"{scheme.name} 距离 {dist:.0f}")
    assert not weak, "；".join(weak)


def test_every_family_has_at_least_two_variants() -> None:
    """对唱要能在**同一家族**里取到两套。只有一个变体的家族给不了这个。"""
    thin = {k: [s.name for s in v] for k, v in _by_family().items() if len(v) < 2}
    assert not thin, f"这些家族凑不出对唱的一对：{thin}"


def test_family_shares_its_base_fill() -> None:
    """同一家族共享未唱**填充**（底色）——它承载的是家族身份。

    注意只共享填充。描边刻意分声部，见 `test_unsung_distinguishes_parts`。
    """
    for family, schemes in _by_family().items():
        bases = {s.colors.unsung_fill for s in schemes}
        assert len(bases) == 1, f"{family} 的底色不统一：{bases}"


def test_unsung_distinguishes_parts() -> None:
    """**未唱态必须能区分声部**（本表最高优先级的一条）。

    对唱曲里演唱者需要在**轮到自己之前**就知道下一句归谁。整个产品为此花了大力气
    ——提前入场 2.0s、段落首行提前 4.2s、引导点踩着真实拍点倒数——如果未唱态两个
    声部长得一样，"这句是不是我的"要等扫色开始才知道，那时已经晚了。

    上一版在这条上恒为 0（同族共享全部未唱色），所以这条判据能把上一版判红。
    """
    weak: list[str] = []
    for family, schemes in _by_family().items():
        for i, a in enumerate(schemes):
            for b in schemes[i + 1 :]:
                gap = _delta_e(a.colors.unsung_outline, b.colors.unsung_outline)
                if gap < MIN_UNSUNG_DE:
                    weak.append(f"{family}：{a.name} vs {b.name} 未唱 ΔE {gap:.1f}")
    assert not weak, "；".join(weak)


def test_unsung_outline_actually_shows_a_hue() -> None:
    """声部身份压在描边色相上，那描边就必须真的看得出色相——不许假装。"""
    weak: list[str] = []
    for scheme in ops.builtin_palette_schemes():
        chroma = _chroma(scheme.colors.unsung_outline)
        if chroma < MIN_OUTLINE_CHROMA:
            weak.append(f"{scheme.name} 未唱描边色度 {chroma:.1f}")
    assert not weak, "；".join(weak)


def test_unsung_distinguishes_families() -> None:
    """家族之间的未唱态也要分得开——底色承载家族身份。

    上一版里「NicoKara」「高对比」「机型红白」三个家族的底色同为纯白、描边同为近黑，
    未唱态**完全一样**，列表看起来品种很多、用起来没差别。
    """
    families = {k: v[0].colors.unsung_fill for k, v in _by_family().items()}
    weak: list[str] = []
    names = list(families)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            gap = _delta_e(families[a], families[b])
            if gap < MIN_UNSUNG_DE:
                weak.append(f"{a} vs {b} 底色 ΔE {gap:.1f}")
    assert not weak, "；".join(weak)


def test_at_least_one_family_uses_the_swap_mechanism() -> None:
    """至少一个家族用**对调机制**：已唱的填充/描边正是未唱那两个色互换。

    对调让声部色在未唱态就占着描边（唱之前看得见），开唱瞬间整体反转（变化最显眼），
    而且两个状态的填充/描边对比度天然相同。上一版一条都没有，所以这条能把它判红。
    """
    swapped = [s.name for s in ops.builtin_palette_schemes() if _is_swap(s.colors)]
    assert len(swapped) >= 2, f"用对调机制的方案只有 {swapped}"
    # 机制要按家族统一：半个家族对调、半个不对调，用户没法预期点下去会发生什么
    for family, schemes in _by_family().items():
        flags = {_is_swap(s.colors) for s in schemes}
        assert len(flags) == 1, f"{family} 家族内机制不统一"


def test_swap_beats_shift_on_perceived_change() -> None:
    """对调的未唱↔已唱感知差应当明显大于只翻填充——这是选它作主导机制的依据。

    不是"应该更明显"，是量出来的：填充 ΔE + 描边 ΔE 合计，对调 153–193，
    只翻填充 75–128。
    """

    def total_change(colors) -> float:
        return _delta_e(colors.unsung_fill, colors.sung_fill) + _delta_e(
            colors.unsung_outline, colors.sung_outline
        )

    swap = [total_change(s.colors) for s in ops.builtin_palette_schemes() if _is_swap(s.colors)]
    shift = [
        total_change(s.colors) for s in ops.builtin_palette_schemes() if not _is_swap(s.colors)
    ]
    assert swap and shift, "两种机制都要有，才谈得上对比"
    assert min(swap) > max(shift), f"对调最小 {min(swap):.0f} 未超过只翻填充最大 {max(shift):.0f}"


def test_family_variants_are_distinguishable() -> None:
    """家族内变体的已唱色也要分得开，否则给两个声部各选一个也看不出区别。"""
    weak: list[str] = []
    for family, schemes in _by_family().items():
        for i, a in enumerate(schemes):
            for b in schemes[i + 1 :]:
                dist = _distance(a.colors.sung_fill, b.colors.sung_fill)
                if dist < MIN_VARIANT_DISTANCE:
                    weak.append(f"{family}：{a.name} vs {b.name} 距离 {dist:.0f}")
    assert not weak, "；".join(weak)


def test_schemes_cover_both_polarities() -> None:
    """必须同时存在「亮字压暗底」与「暗字压亮底」两类。

    白字在雪景 / 白背景 / 逆光这类亮画面上会整片消失，只给白字方案等于漏掉一整类画面。
    """
    polarity = {
        _luminance(scheme.colors.unsung_fill) > _luminance(scheme.colors.unsung_outline)
        for scheme in ops.builtin_palette_schemes()
    }
    assert polarity == {True, False}


# ---- 判据本身能不能判红（否则它证明不了任何事） ----


def test_criteria_reject_the_previous_table() -> None:
    """把**上一版真实用过的取值**钉在这里，逐条断言新判据确实拒绝它们。

    本项目反复吃过"判据在坏的一侧也通过"的亏。改判据时若不小心放松了，这里先红。
    """
    # 家族底色：NicoKara / 高对比 / 机型红白 三家同为纯白
    assert _delta_e("&H00FFFFFF&", "&H00FFFFFF&") < MIN_UNSUNG_DE

    # 家族内变体：同族共享全部未唱色，描边 ΔE 恒为 0
    assert _delta_e("&H00202020&", "&H00202020&") < MIN_UNSUNG_DE

    # 名义上的「深褐」#2A1400（ASS 是 BGR 序，写作 &H0000142A&）：色相看不出来
    assert _chroma("&H0000142A&") < MIN_OUTLINE_CHROMA
    # 名义上的「墨蓝」#16223C：色度勉强过线，但 L* 只有 13.5，暗到与近黑分不开
    assert _lab("&H003C2216&")[0] < 15

    # 上一版一条对调机制都没有
    class _Old:
        unsung_fill = "&H00FFFFFF&"
        unsung_outline = "&H00202020&"
        sung_fill = "&H00FF9010&"
        sung_outline = "&H00501800&"

    assert not _is_swap(_Old())


# ---- 方案库：保存 / 改名 / 删除 ----


def _colors(sung_fill: str = "&H0000FF00&") -> PaletteDTO:
    return PaletteDTO(name="", sung_fill=sung_fill)


def test_save_and_list_user_scheme(tmp_path: Path) -> None:
    path = tmp_path / "palettes.json"

    ops.save_palette_scheme("我的粉色", _colors(), description="自用", path=path)
    names = [s.name for s in ops.load_palette_schemes(path)]

    assert "我的粉色" in names
    assert names[: len(ops.builtin_palette_schemes())] == [
        s.name for s in ops.builtin_palette_schemes()
    ], "内置在前"


def test_user_scheme_survives_reload(tmp_path: Path) -> None:
    """配色调完刷新就丢，正是要补的缺口。"""
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("我的粉色", _colors(), path=path)

    loaded = next(s for s in ops.load_palette_schemes(path) if s.name == "我的粉色")

    assert loaded.colors.sung_fill == "&H0000FF00&"
    assert loaded.builtin is False


def test_save_overwrites_same_name(tmp_path: Path) -> None:
    """同名覆盖正是界面自动保存依赖的语义：反复微调只更新同一条，列表不会被淹没。"""
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("我的粉色", _colors(), path=path)

    ops.save_palette_scheme("我的粉色", _colors("&H00FF0000&"), path=path)

    hits = [s for s in ops.load_palette_schemes(path) if s.name == "我的粉色"]
    assert len(hits) == 1
    assert hits[0].colors.sung_fill == "&H00FF0000&"


def test_delete_user_scheme(tmp_path: Path) -> None:
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("我的粉色", _colors(), path=path)

    ops.delete_palette_scheme("我的粉色", path=path)

    assert "我的粉色" not in {s.name for s in ops.load_palette_schemes(path)}


def test_delete_builtin_rejected(tmp_path: Path) -> None:
    """内置删了就再也拿不回来。"""
    builtin = ops.builtin_palette_schemes()[0].name
    with pytest.raises(ops.EditError):
        ops.delete_palette_scheme(builtin, path=tmp_path / "palettes.json")


def test_delete_missing_raises_key_error(tmp_path: Path) -> None:
    with pytest.raises(KeyError):
        ops.delete_palette_scheme("不存在的", path=tmp_path / "palettes.json")


def test_save_rejects_builtin_name(tmp_path: Path) -> None:
    builtin = ops.builtin_palette_schemes()[0].name
    with pytest.raises(ops.EditError):
        ops.save_palette_scheme(builtin, _colors(), path=tmp_path / "palettes.json")


@pytest.mark.parametrize("bad_name", ["", "   ", "a/b"])
def test_save_rejects_unusable_name(bad_name: str, tmp_path: Path) -> None:
    """带斜杠的名字会让 DELETE 的路径段对不上，方案存进去就再也删不掉。"""
    with pytest.raises(ops.EditError):
        ops.save_palette_scheme(bad_name, _colors(), path=tmp_path / "palettes.json")


def test_corrupt_file_degrades_to_builtin(tmp_path: Path) -> None:
    """配色是锦上添花的功能，一个坏文件不该让整个样式面板打不开（§2.5 失败要降级）。"""
    path = tmp_path / "palettes.json"
    path.write_text("{ 半截 JSON", encoding="utf-8")

    schemes = ops.load_palette_schemes(path)

    assert [s.name for s in schemes] == [s.name for s in ops.builtin_palette_schemes()]


def test_write_leaves_no_partial_file(tmp_path: Path) -> None:
    """原子写：临时文件必须换名顶替，不能在目录里留下半截产物。"""
    path = tmp_path / "palettes.json"

    ops.save_palette_scheme("我的粉色", _colors(), path=path)

    assert path.exists()
    assert list(tmp_path.glob("*.tmp")) == []


def test_rename_keeps_colors_and_drops_old_name(tmp_path: Path) -> None:
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("旧名", _colors(), description="自用", path=path)

    renamed = ops.rename_palette_scheme("旧名", "新名", path=path)

    assert renamed.name == "新名"
    names = {s.name for s in ops.load_palette_schemes(path)}
    assert "新名" in names
    assert "旧名" not in names
    kept = next(s for s in ops.load_palette_schemes(path) if s.name == "新名")
    assert kept.colors.sung_fill == "&H0000FF00&"
    assert kept.description == "自用"


def test_rename_to_same_name_is_a_noop(tmp_path: Path) -> None:
    """改成自己原来的名字不该报"重名"——那是用户点了确定却没改字的常规操作。"""
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("原名", _colors(), path=path)

    ops.rename_palette_scheme("原名", "原名", path=path)

    assert "原名" in {s.name for s in ops.load_palette_schemes(path)}


def test_rename_rejects_collision_without_losing_either(tmp_path: Path) -> None:
    """撞名要拒绝，而且**两套配色都得还在**——静默合并等于删掉一套。"""
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("甲", _colors(), path=path)
    ops.save_palette_scheme("乙", _colors("&H00123456&"), path=path)

    with pytest.raises(ops.EditError, match="已存在同名"):
        ops.rename_palette_scheme("甲", "乙", path=path)

    names = {s.name for s in ops.load_palette_schemes(path)}
    assert {"甲", "乙"} <= names


def test_rename_rejects_builtin(tmp_path: Path) -> None:
    builtin = ops.builtin_palette_schemes()[0].name
    with pytest.raises(ops.EditError, match="内置"):
        ops.rename_palette_scheme(builtin, "我的", path=tmp_path / "palettes.json")


def test_rename_rejects_taking_a_builtin_name(tmp_path: Path) -> None:
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("我的", _colors(), path=path)
    builtin = ops.builtin_palette_schemes()[0].name
    with pytest.raises(ops.EditError, match="内置"):
        ops.rename_palette_scheme("我的", builtin, path=path)


def test_rename_missing_raises_key_error(tmp_path: Path) -> None:
    with pytest.raises(KeyError):
        ops.rename_palette_scheme("不存在的", "随便", path=tmp_path / "palettes.json")


def test_rename_writes_atomically(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """改名途中崩掉不能把配色弄丢：写盘只有一次，失败时旧文件原封不动。

    这是"不用 delete + save 拼"的理由本身，所以要有回归——delete+save 的实现
    在这个用例下会留下一份少了那套配色的文件。
    """
    path = tmp_path / "palettes.json"
    ops.save_palette_scheme("珍贵配色", _colors(), path=path)
    before = path.read_text(encoding="utf-8")

    def boom(*_args: object, **_kwargs: object) -> None:
        msg = "磁盘满了"
        raise OSError(msg)

    monkeypatch.setattr(ops, "_write_schemes", boom)
    with pytest.raises(OSError, match="磁盘满了"):
        ops.rename_palette_scheme("珍贵配色", "新名字", path=path)

    assert path.read_text(encoding="utf-8") == before
    assert "珍贵配色" in {s.name for s in ops.load_palette_schemes(path)}


# ---- HTTP：逐声部施加 + 方案库端点 ----


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """每个用例一套干净的数据目录。

    `KVM_DATA_DIR` 必须在进入 TestClient 的上下文**之前**设好：store 是在 lifespan
    里建的，而 `ops.default_schemes_path()` 又是 `default_root().parent`，
    所以工程与用户配色方案会一起落到 tmp 下，跑测试不会碰到开发机上真实的配色库。
    """
    monkeypatch.setenv("KVM_DATA_DIR", str(tmp_path / "projects"))
    with TestClient(fastapi_app) as test_client:
        yield test_client


def _new_project(client: TestClient) -> str:
    resp = client.post("/api/projects/", json={"title": "配色", "artist": ""})
    assert resp.status_code == 201
    return resp.json()["id"]


def test_apply_touches_only_the_selected_part(client: TestClient) -> None:
    """先选声部、再点方案——**只有那个声部该变**，这是本次改动的核心语义。"""
    first, second = ops.builtin_palette_schemes()[0], ops.builtin_palette_schemes()[1]
    pid = _new_project(client)
    client.post(f"/api/projects/{pid}/palettes", json={"scheme": first.name, "apply_to": "男"})

    resp = client.post(
        f"/api/projects/{pid}/palettes", json={"scheme": second.name, "apply_to": "女"}
    )

    assert resp.status_code == 200
    palettes = resp.json()["palettes"]
    assert palettes["女"]["sung_fill"] == second.colors.sung_fill
    # 别的声部不能被冲掉
    assert palettes["男"]["sung_fill"] == first.colors.sung_fill
    assert set(palettes) == {"男", "女"}


def test_apply_accepts_any_user_defined_part_name(client: TestClient) -> None:
    """**任意用户自定义的声部名都要能正确取到色。**

    这是那个静默失效缺陷的回归：方案曾经按 `main`/`duet_a`/… 索引，
    用户把声部改名成「合」之后取色全部落空，退回同一组颜色且毫无提示。
    现在方案就是一组四色，声部名不参与取色——所以下面这些名字必须都拿到
    **色板上那一组**颜色，一字不差。
    """
    scheme = ops.builtin_palette_schemes()[3]
    pid = _new_project(client)
    for part in ("合", "ハモリ", "narration", "main", "Ω 声部 #2"):
        resp = client.post(
            f"/api/projects/{pid}/palettes", json={"scheme": scheme.name, "apply_to": part}
        )
        assert resp.status_code == 200, part
        got = resp.json()["palettes"][part]
        assert got["unsung_fill"] == scheme.colors.unsung_fill, part
        assert got["unsung_outline"] == scheme.colors.unsung_outline, part
        assert got["sung_fill"] == scheme.colors.sung_fill, part
        assert got["sung_outline"] == scheme.colors.sung_outline, part
        assert got["name"] == part, part


def test_scheme_without_apply_to_is_rejected(client: TestClient) -> None:
    """方案不带声部，不说写给谁就是无意义的请求——静默忽略会表现成"点了没反应"。"""
    pid = _new_project(client)
    scheme = ops.builtin_palette_schemes()[0].name
    assert client.post(f"/api/projects/{pid}/palettes", json={"scheme": scheme}).status_code == 400
    assert client.post(f"/api/projects/{pid}/palettes", json={"apply_to": "男"}).status_code == 400


def test_apply_unknown_scheme_is_404(client: TestClient) -> None:
    pid = _new_project(client)
    resp = client.post(
        f"/api/projects/{pid}/palettes", json={"scheme": "没有这套", "apply_to": "男"}
    )
    assert resp.status_code == 404


def test_apply_enters_undo_stack(client: TestClient) -> None:
    """改配色是编辑操作，Cmd+Z 要能退回上一套。"""
    first, second = ops.builtin_palette_schemes()[0], ops.builtin_palette_schemes()[1]
    pid = _new_project(client)
    client.post(f"/api/projects/{pid}/palettes", json={"scheme": first.name, "apply_to": "男"})
    client.post(f"/api/projects/{pid}/palettes", json={"scheme": second.name, "apply_to": "男"})

    undone = client.post(f"/api/projects/{pid}/undo").json()

    assert undone["palettes"]["男"]["sung_fill"] == first.colors.sung_fill


def test_save_scheme_from_project_part(client: TestClient) -> None:
    """ "把我现在调的这套存下来"：取的是该声部**生效**的四色。"""
    pid = _new_project(client)
    client.post(
        f"/api/projects/{pid}/palettes",
        json={"palettes": {"女": PaletteDTO(name="女", sung_fill="&H00ABCDEF&").model_dump()}},
    )

    resp = client.post(
        "/api/palettes/schemes", json={"name": "我的女声", "project_id": pid, "part": "女"}
    )

    assert resp.status_code == 201
    assert resp.json()["colors"]["sung_fill"] == "&H00ABCDEF&"


def test_rename_endpoint(client: TestClient) -> None:
    client.post(
        "/api/palettes/schemes",
        json={"name": "自定义配色", "colors": PaletteDTO(name="").model_dump()},
    )

    resp = client.patch("/api/palettes/schemes/自定义配色", json={"new_name": "夜色版"})

    assert resp.status_code == 200
    assert resp.json()["name"] == "夜色版"
    listed = {s["name"] for s in client.get("/api/palettes/schemes").json()}
    assert "夜色版" in listed
    assert "自定义配色" not in listed


def test_rename_endpoint_rejects_builtin(client: TestClient) -> None:
    builtin = ops.builtin_palette_schemes()[0].name
    resp = client.patch(f"/api/palettes/schemes/{builtin}", json={"new_name": "我的"})
    assert resp.status_code == 400


def test_delete_endpoint_rejects_builtin(client: TestClient) -> None:
    builtin = ops.builtin_palette_schemes()[0].name
    assert client.delete(f"/api/palettes/schemes/{builtin}").status_code == 400


def test_rename_endpoint_404_for_missing(client: TestClient) -> None:
    resp = client.patch("/api/palettes/schemes/没有这套", json={"new_name": "我的"})
    assert resp.status_code == 404
