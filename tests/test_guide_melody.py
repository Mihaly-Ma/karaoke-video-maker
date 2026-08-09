"""引导声（ガイドメロディ）合成质量的回归测试。

用户对第一版的判词是"太带人声了、不够连贯"。这两条都不是音量问题，
而是三个可以用断言钉死的具体缺陷：

1. **音高照搬实测 f0**。人唱歌本就微微跑调（本曲实测帧级偏离半音格中位 10.8 音分），
   照着这些频率合成就把人的音准感一起继承了。→ 量化后必须**恰好**落在半音格上。
2. **短音符被丢弃**。旧实现对 `end - start < min_note_s` 直接 `return`，
   在乐句中间留下空洞。→ 短音符必须**并入邻居**，时间覆盖不能因此缩水。
3. **每个清音帧都断一次**。pYIN 的清音判定在辅音、换气上很不稳，
   一个持续长音会被切碎。→ 短间隙必须被桥接，只有真正的休止才断开。

外加一条合成端的硬约束：**带限防混叠**。高音区谐波超过奈奎斯特会折返成
不成谐的刺耳噪声，而这种问题在低音区试听时完全听不出来，只有断言能挡住。

本文件只测纯函数与合成（不跑 pYIN、不读音频），因此不需要 librosa。
"""

from __future__ import annotations

import itertools
import sys
from pathlib import Path

import numpy as np

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.pipeline.guide_melody import (  # noqa: E402
    TIMBRES,
    GuideConfig,
    GuideNote,
    absorb_short_notes,
    bridge_gaps,
    frames_to_notes,
    group_phrases,
    harmonic_weights,
    merge_same_pitch,
    quantize_notes,
    synth_guide,
)

A4 = 440.0
AS4 = 466.1637615180899  # A#4，比 A4 高一个半音
B4 = 493.8833012561241


def cents_off_grid(freq_hz: float) -> float:
    """离最近半音格的音分数。量化后应当恒为 0。"""
    midi = 69.0 + 12.0 * np.log2(freq_hz / 440.0)
    return abs(midi - round(midi)) * 100.0


def coverage_s(notes: list[GuideNote]) -> float:
    """音符覆盖的总时长（并集）。用来验证"并入邻居"没有丢时间。"""
    if not notes:
        return 0.0
    spans = sorted((n.start_s, n.end_s) for n in notes)
    total = 0.0
    cur_start, cur_end = spans[0]
    for s, e in spans[1:]:
        if s > cur_end:
            total += cur_end - cur_start
            cur_start, cur_end = s, e
        else:
            cur_end = max(cur_end, e)
    return total + cur_end - cur_start


def frames(pattern: list[tuple[float, int]], hop: float = 0.01):
    """把 `[(频率或 0 表示清音, 帧数), ...]` 展开成 pYIN 风格的三元组。"""
    f0: list[float] = []
    voiced: list[bool] = []
    for freq, count in pattern:
        f0 += [freq if freq > 0 else float("nan")] * count
        voiced += [freq > 0] * count
    times = np.arange(len(f0)) * hop
    return times, np.array(f0), np.array(voiced)


# ---------------------------------------------------------------------------
# 缺陷 1：音高必须量化到半音格
# ---------------------------------------------------------------------------


def test_quantize_lands_exactly_on_semitone_grid() -> None:
    # 分别偏高 40 音分与偏低 45 音分，都在"人正常跑调"的量级内
    sharp = A4 * 2 ** (40 / 1200)
    flat = A4 * 2 ** (-45 / 1200)
    out = quantize_notes([GuideNote(0.0, 1.0, sharp), GuideNote(1.0, 2.0, flat)])

    assert [cents_off_grid(n.freq_hz) for n in out] == pytest.approx([0.0, 0.0], abs=1e-9)
    # 两个都应吸附回 A4，而不是被推到相邻半音
    assert all(n.freq_hz == pytest.approx(A4) for n in out)


def test_quantize_preserves_time_and_order() -> None:
    src = [GuideNote(0.0, 0.5, 441.0), GuideNote(0.5, 1.2, 300.0)]
    out = quantize_notes(src)
    assert [(n.start_s, n.end_s) for n in out] == [(0.0, 0.5), (0.5, 1.2)]


def test_end_to_end_notes_are_all_on_grid() -> None:
    """整条链路（含合并与吸收）之后不能再有任何离格音符。"""
    times, f0, voiced = frames(
        [(A4 * 2 ** (0.3 / 12), 30), (0.0, 3), (B4 * 2 ** (-0.4 / 12), 40)]
    )
    notes = frames_to_notes(times, f0, voiced, GuideConfig())
    assert notes
    assert max(cents_off_grid(n.freq_hz) for n in notes) == pytest.approx(0.0, abs=1e-9)


def test_quantize_can_be_disabled() -> None:
    """关掉量化必须真的退回照搬实测 f0，否则这个开关是假的。"""
    off = A4 * 2 ** (40 / 1200)
    times, f0, voiced = frames([(off, 40)])
    notes = frames_to_notes(times, f0, voiced, GuideConfig(quantize=False))
    assert len(notes) == 1
    assert notes[0].freq_hz == pytest.approx(off)


# ---------------------------------------------------------------------------
# 缺陷 2：短音符并入邻居，不能丢弃
# ---------------------------------------------------------------------------


def test_short_note_is_absorbed_not_dropped() -> None:
    """旧实现在这里直接丢弃，留下 60ms 空洞——这是"不连贯"的直接来源。"""
    src = [
        GuideNote(0.0, 0.50, A4),
        GuideNote(0.50, 0.56, AS4),  # 60ms，短于 min_note_s
        GuideNote(0.56, 1.10, B4),
    ]
    out = absorb_short_notes(src, min_note_s=0.12, max_gap_s=0.20)

    assert len(out) == 2
    assert coverage_s(out) == pytest.approx(coverage_s(src))
    # A#4 到两侧都是一个半音，平手时并入前一个（`d_prev <= d_next`）
    assert out[0].end_s == pytest.approx(0.56)


def test_short_note_goes_to_the_closer_pitch() -> None:
    """并入方向由音高远近决定：并错方向会让旋律线出现一个突兀的台阶。"""
    src = [
        GuideNote(0.0, 0.50, A4),
        GuideNote(0.50, 0.55, B4 * 2),  # 与后一个同高，与前一个差一个八度多
        GuideNote(0.55, 1.10, B4 * 2),
    ]
    out = absorb_short_notes(src, min_note_s=0.12, max_gap_s=0.20)
    assert len(out) == 2
    assert out[1].start_s == pytest.approx(0.50)
    assert out[0].end_s == pytest.approx(0.50)


def test_isolated_short_note_is_dropped() -> None:
    """两侧都够不着时才丢：孤立的 30ms 多半是 pYIN 在噪声上的误触发。"""
    src = [GuideNote(0.0, 0.5, A4), GuideNote(5.0, 5.03, B4)]
    out = absorb_short_notes(src, min_note_s=0.12, max_gap_s=0.20)
    assert len(out) == 1
    assert out[0].start_s == pytest.approx(0.0)


def test_absorb_cascades_until_all_notes_are_long_enough() -> None:
    """连续几个碎片要一路吸收干净，不能只处理第一个。"""
    src = [
        GuideNote(0.0, 0.60, A4),
        GuideNote(0.60, 0.65, AS4),
        GuideNote(0.65, 0.70, B4),
        GuideNote(0.70, 0.74, AS4),
    ]
    out = absorb_short_notes(src, min_note_s=0.12, max_gap_s=0.20)
    assert all(n.duration_s >= 0.12 for n in out)
    assert coverage_s(out) == pytest.approx(coverage_s(src))


# ---------------------------------------------------------------------------
# 缺陷 3：短间隙桥接，真休止保留
# ---------------------------------------------------------------------------


def test_bridge_closes_short_gap_only() -> None:
    src = [
        GuideNote(0.0, 0.50, A4),
        GuideNote(0.62, 1.00, B4),  # 120ms 间隙：辅音/换气
        GuideNote(1.80, 2.40, A4),  # 800ms 间隙：真正的休止
    ]
    out = bridge_gaps(src, legato_gap_s=0.20)
    assert out[0].end_s == pytest.approx(0.62)
    assert out[1].end_s == pytest.approx(1.00)


def test_consonant_gap_does_not_split_a_held_note() -> None:
    """一帧清音（辅音）不该把一个持续长音切成两截。"""
    times, f0, voiced = frames([(A4, 40), (0.0, 3), (A4, 40)])
    notes = frames_to_notes(times, f0, voiced, GuideConfig())
    assert len(notes) == 1
    assert notes[0].start_s == pytest.approx(0.0)
    assert notes[0].end_s == pytest.approx(0.83, abs=0.02)


def test_real_rest_still_splits() -> None:
    """真正的休止（远长于阈值）必须断开，否则引导音会在该停的地方拖着不放。"""
    times, f0, voiced = frames([(A4, 40), (0.0, 100), (A4, 40)])
    notes = frames_to_notes(times, f0, voiced, GuideConfig())
    assert len(notes) == 2
    assert notes[1].start_s - notes[0].end_s > 0.5


def test_same_pitch_neighbours_are_merged() -> None:
    """量化后同高的碎片必须合并——连贯性的收益主要来自这一步。"""
    src = [GuideNote(0.0, 0.4, A4), GuideNote(0.45, 0.9, A4)]
    out = merge_same_pitch(src, max_gap_s=0.20)
    assert len(out) == 1
    assert (out[0].start_s, out[0].end_s) == pytest.approx((0.0, 0.9))

    far = [GuideNote(0.0, 0.4, A4), GuideNote(1.4, 1.9, A4)]
    assert len(merge_same_pitch(far, max_gap_s=0.20)) == 2


def test_pipeline_leaves_no_adjacent_same_pitch_notes() -> None:
    """跑完整条链路后不应残留"同高且相接"的相邻音符，否则会多出无谓的换音斜坡。"""
    times, f0, voiced = frames(
        [(A4, 20), (0.0, 2), (A4 * 2 ** (0.2 / 12), 20), (0.0, 2), (A4, 25)]
    )
    notes = frames_to_notes(times, f0, voiced, GuideConfig())
    for a, b in itertools.pairwise(notes):
        assert not (abs(a.freq_hz - b.freq_hz) < 1e-6 and b.start_s - a.end_s < 1e-6)


def test_pipeline_improves_duty_cycle_over_naive_segmentation() -> None:
    """带若干辅音断点的一段演唱，处理后发声占空比必须接近满覆盖。"""
    pattern: list[tuple[float, int]] = []
    for _ in range(6):
        pattern += [(A4, 25), (0.0, 4)]  # 250ms 唱 + 40ms 辅音
    times, f0, voiced = frames(pattern)
    notes = frames_to_notes(times, f0, voiced, GuideConfig())
    span = float(times[-1]) + 0.01
    assert coverage_s(notes) / span > 0.95


def test_group_phrases_splits_on_real_rests_only() -> None:
    notes = [
        GuideNote(0.0, 0.5, A4),
        GuideNote(0.5, 1.0, B4),
        GuideNote(2.0, 2.5, A4),
    ]
    phrases = group_phrases(notes)
    assert [len(p) for p in phrases] == [2, 1]


# ---------------------------------------------------------------------------
# 合成端：带限防混叠、音色、包络
# ---------------------------------------------------------------------------


def test_harmonics_never_exceed_nyquist() -> None:
    """高音区谐波折返会产生刺耳的金属噪声，而这在低音区试听时完全听不出来。"""
    sr = 8000
    for freq in (200.0, 800.0, 1500.0, 3500.0):
        for timbre in TIMBRES:
            ws = harmonic_weights(timbre, freq, sr, max_harmonics=64)
            assert ws, f"{timbre}@{freq} 没有可用谐波"
            assert max(order for order, _ in ws) * freq < sr / 2


def test_max_harmonics_is_respected() -> None:
    ws = harmonic_weights("saw", 100.0, 44100, max_harmonics=5)
    assert [order for order, _ in ws] == [1, 2, 3, 4, 5]


def test_square_uses_only_odd_harmonics() -> None:
    ws = harmonic_weights("square", 200.0, 44100, max_harmonics=16)
    assert all(order % 2 == 1 for order, _ in ws)
    assert len(ws) > 1, "方波必须真的带谐波，否则和正弦没区别"


def test_timbres_are_rms_normalised() -> None:
    """归一化到单位 RMS，`gain` 才能在不同音色间表示同一个响度。"""
    for timbre in TIMBRES:
        ws = harmonic_weights(timbre, 220.0, 44100, max_harmonics=16)
        assert sum(w * w for _, w in ws) / 2.0 == pytest.approx(1.0)


def test_brighter_timbre_has_higher_spectral_centroid() -> None:
    """佐证"更电子"：方波的频谱质心必须显著高于正弦。"""
    notes = [GuideNote(0.0, 1.0, 220.0)]
    centroids: dict[str, float] = {}
    for timbre in ("sine", "triangle", "square", "saw"):
        y = synth_guide(notes, 1.0, sr=44100, config=GuideConfig(timbre=timbre))
        # 必须加窗：矩形截断的旁瓣泄漏会把纯正弦的质心抬到 800Hz 以上，
        # 掩盖掉音色之间的真实差别
        seg = y[2000:34768].astype(np.float64) * np.hanning(32768)
        spec = np.abs(np.fft.rfft(seg))
        freqs = np.fft.rfftfreq(seg.size, 1 / 44100)
        centroids[timbre] = float((spec * freqs).sum() / spec.sum())
    assert centroids["sine"] < centroids["triangle"] < centroids["square"] < centroids["saw"]
    assert centroids["square"] > 3 * centroids["sine"]


def test_no_aliasing_partials_in_rendered_high_note() -> None:
    """直接在频谱上验收：不该出现落在非整数倍频率上的强峰。"""
    sr = 44100
    freq = 1000.0
    y = synth_guide([GuideNote(0.0, 1.0, freq)], 1.0, sr=sr, config=GuideConfig(timbre="saw"))
    seg = y[4410 : 4410 + 32768].astype(np.float64)
    spec = np.abs(np.fft.rfft(seg * np.hanning(seg.size)))
    freqs = np.fft.rfftfreq(seg.size, 1 / sr)
    loud = freqs[spec > spec.max() * 10 ** (-45 / 20)]
    for f in loud[loud > 20]:
        ratio = f / freq
        assert abs(ratio - round(ratio)) < 0.08, f"{f:.1f}Hz 不是 {freq}Hz 的整数倍谐波"


def test_phrase_boundaries_are_silent_but_interior_is_continuous() -> None:
    """乐句首尾淡入淡出；乐句内部换音只留极短斜坡，不做衰减重起。"""
    sr = 44100
    notes = [GuideNote(0.0, 0.5, A4), GuideNote(0.5, 1.0, B4)]
    y = synth_guide(notes, 1.2, sr=sr, config=GuideConfig())
    peak = float(np.abs(y).max())

    assert abs(y[0]) < 1e-6 and abs(y[int(1.0 * sr) - 1]) < 0.02 * peak
    # 换音处：斜坡宽度以内应几乎静音，但斜坡之外（20ms 开外）必须已经回到满幅
    b = int(0.5 * sr)
    assert abs(y[b]) < 0.05 * peak
    assert np.abs(y[b + int(0.02 * sr) : b + int(0.05 * sr)]).max() > 0.5 * peak


def test_interior_note_change_has_no_phase_jump() -> None:
    """连续相位是"连贯"在合成端的落点：关掉斜坡后换音处也不该出现台阶。

    若换音时重起振荡器，边界的单样本跳变会远大于波形自身的最大斜率。
    """
    sr = 44100
    cfg = GuideConfig(timbre="sine", note_ramp_s=0.0, fade_s=0.0)
    y = synth_guide([GuideNote(0.0, 0.5, A4), GuideNote(0.5, 1.0, B4)], 1.0, sr=sr, config=cfg)
    d = np.abs(np.diff(y.astype(np.float64)))
    b = int(0.5 * sr)
    assert d[b - 1] <= d.max()
    assert d[b - 1] < 3 * float(np.median(d[d > 0]))


def test_synth_output_shape_and_headroom() -> None:
    sr = 22050
    y = synth_guide([GuideNote(0.0, 1.0, A4)], 2.0, sr=sr, config=GuideConfig())
    assert y.dtype == np.float32
    assert y.size == int(2.0 * sr) + 1
    assert float(np.abs(y).max()) <= 1.0
    assert float(np.abs(y[int(1.1 * sr) :]).max()) == 0.0  # 音符之后必须是静音


def test_notes_outside_the_track_do_not_crash() -> None:
    y = synth_guide([GuideNote(0.0, 5.0, A4)], 1.0, sr=8000, config=GuideConfig())
    assert y.size == 8001
    assert float(np.abs(y).max()) > 0.0


def test_empty_input_yields_silence() -> None:
    assert not frames_to_notes([], [], [], GuideConfig())
    assert float(np.abs(synth_guide([], 1.0, sr=8000)).max()) == 0.0


def test_unknown_timbre_is_rejected_at_config_time() -> None:
    """打错音色名要立刻报错，而不是等到合成完才发现声音不对。"""
    with pytest.raises(ValueError, match="未知音色"):
        GuideConfig(timbre="pulse")
