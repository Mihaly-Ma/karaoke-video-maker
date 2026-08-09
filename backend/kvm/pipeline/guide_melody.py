"""引导声（ガイドメロディ）：给 OFF VOCAL 版本合成音高引导音。

卡拉OK 的引导音帮演唱者找准音高与进入时机。**它不是"把人声调小混回去"**——
残留的原唱会和演唱者自己的声音打架，而且咬字含混反而更难跟。
正确做法是**只保留音高信息，用纯电子音重新合成**。

流程全部本地：

    vocals stem → pYIN 提取基频 → 帧级切音符 → 半音量化 → 合并/桥接 → 合成 → 混入伴奏

## 为什么要"量化 + 桥接"而不是照搬实测基频

第一版直接拿实测 f0 的中位数当音符频率、并在每个清音帧断开，听感有两个问题，
都不是音量或音色能救的：

1. **像人在哼**。人唱歌本就微微跑调（本曲实测帧级音高偏离半音格中位 10.8 音分、
   p90 40.8 音分），照着这些"歪"频率合成，就把人的音准感一起继承了。
   引导音的职责恰恰相反：它要给出**标准音高**让人去靠。所以必须量化到半音格。
2. **一顿一顿**。pYIN 的清音判定在辅音、换气、气声上很不稳，一个持续长音会被切碎；
   碎片再被"短于 min_note_s 就丢弃"的规则删掉，就留下一串空洞。
   实测本曲全曲 272 段内部清音间隙里，72% 短于 120ms、83% 短于 200ms
   ——这些根本不是休止，是辅音。真正的休止在 p90 以上（276ms 起）才出现。

对应的三步处理：量化到半音 → 合并量化后同高的相邻音符（顺带吃掉颤音碎片）→
把短于阈值的清音间隙桥接成 legato（延长前一个音符），只有真正的休止才断开。

## 音色

固定谐波配比的带限合成波（默认方波：奇次谐波 1/n），而不是正弦加一点三次谐波
——后者的频谱恰好近似一个哼唱的元音，这正是"太像人声"的另一半原因。
谐波数按音高截断（不超过奈奎斯特），否则高音区会折返成刺耳的混叠噪声。

乐句内部用**连续相位**合成：把整个乐句的逐样本频率积分成相位，换音时只换频率、
不重起振荡器，因此没有相位跳变、也就不需要为每个音符做衰减重起。
音符边界只留几毫秒斜坡防 click（顺带让换音听得出来），淡入淡出只做在乐句首尾。
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

# 各音色的谐波配比：`{谐波次数: 相对幅度}`。全部是固定配比的合成波形，
# 与"基波 + 弱三次谐波"那种近似人声元音的频谱刻意拉开距离。
_TIMBRE_WEIGHTS: dict[str, dict[int, float]] = {
    # 纯正弦：最干净，但在密集编曲里容易被埋掉，只作为可选项保留
    "sine": {1: 1.0},
    # 三角波：奇次谐波 1/n²，比方波柔和，仍是明确的电子音
    "triangle": {n: (-1.0) ** ((n - 1) // 2) / n**2 for n in range(1, 64, 2)},
    # 方波：奇次谐波 1/n，中空的音头，穿透力最好，最接近卡拉OK 引导音的听感
    "square": {n: 1.0 / n for n in range(1, 64, 2)},
    # 锯齿波：全谐波 1/n，最亮也最"厚"，容易抢原曲，只作为可选项
    "saw": {n: 1.0 / n for n in range(1, 64)},
}

TIMBRES: tuple[str, ...] = tuple(_TIMBRE_WEIGHTS)


@dataclass(frozen=True)
class GuideNote:
    """一个引导音符。"""

    start_s: float
    end_s: float
    freq_hz: float

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    @property
    def midi(self) -> float:
        """连续 MIDI 音号。量化后应当是整数。"""
        return 69.0 + 12.0 * float(np.log2(self.freq_hz / 440.0))


@dataclass(frozen=True)
class GuideConfig:
    """引导声的全部可调参数。

    默认值的由来见模块文档：与时间有关的三个阈值（`max_gap_s` / `legato_gap_s` /
    `min_note_s`）都取自赤春花全曲 vocals stem 的实测间隙分布，不是拍脑袋。
    """

    # —— 基频提取 ——
    sr_analysis: int = 22050
    """pYIN 的分析采样率。22050 足够覆盖人声基频，比 44100 快一倍。"""

    fmin: float = 65.0
    fmax: float = 1200.0

    # —— 帧级切音符 ——
    cents_tolerance: float = 80.0
    """音高波动在此范围内算"同一个音"，这样颤音不会被切成一串碎音符。"""

    max_gap_s: float = 0.12
    """短于此的清音间隙**不断开当前音符**（辅音/换气，人其实还在唱同一个音）。

    实测本曲 72% 的内部间隙短于 120ms；按 136 BPM 算 120ms 还不到一个十六分音符，
    不可能是休止。
    """

    # —— 音符后处理 ——
    quantize: bool = True
    """把音符频率吸附到最近的半音（MIDI 整数）。关掉即回到"照搬实测 f0"的旧行为。"""

    min_note_s: float = 0.12
    """短于此的音符会被**并入音高最接近的邻居**，而不是丢弃（丢弃会留下空洞）。

    按 136 BPM（本曲实测）算，120ms 约等于一个十六分音符——比这更短的"音符"基本
    都是起音滑音或经过音的碎片。实测把阈值从 80ms 提到 120ms，句首那串
    `A#3(93) B3(139) A3(139) → G4` 的滑音碎片会正确并成一个 `B3(372)`。
    """

    legato_gap_s: float = 0.20
    """短于此的音符间隙做 legato 桥接：延长前一个音符到下一个音符起点。

    同时也是"同音高相邻音符可以合并"的最大间隔。按 136 BPM，200ms 约等于一个
    八分音符——比这更短的空档在听感上不成其为休止。实测覆盖 83% 的内部间隙，
    余下的 17%（p90 = 276ms 起）保留为真正的休止。
    """

    # —— 合成 ——
    timbre: str = "square"
    max_harmonics: int = 16
    """谐波数上限。真正的截断点取它与奈奎斯特限制中更严的那个（防混叠）。"""

    gain: float = 0.11
    """混入伴奏时的幅度（RMS 口径）。默认值刻意留在伴奏之下，只做引导不抢主体。

    比旧版的 0.16 小，是因为谐波表现在按**单位 RMS** 归一化：同样的数值，
    方波比"正弦 + 0.22 三次谐波"要响 3.6 dB。0.11 实测在赤春花伴奏上约低 5 dB，
    与旧版实际听到的相对响度一致。
    """

    fade_s: float = 0.015
    """乐句首尾的淡入淡出。只在乐句边界出现，乐句内部不做。"""

    note_ramp_s: float = 0.004
    """乐句内部换音处的极短斜坡。防 click 用，顺带让换音听得出来，不是音乐性的包络。"""

    def __post_init__(self) -> None:
        if self.timbre not in _TIMBRE_WEIGHTS:
            msg = f"未知音色 {self.timbre!r}，可选：{', '.join(TIMBRES)}"
            raise ValueError(msg)
        if self.max_harmonics < 1:
            msg = "max_harmonics 至少为 1"
            raise ValueError(msg)


# ---------------------------------------------------------------------------
# 音符序列处理（纯函数，不碰音频，便于单测）
# ---------------------------------------------------------------------------


def quantize_notes(notes: Sequence[GuideNote]) -> list[GuideNote]:
    """把每个音符的频率吸附到最近的半音。

    这是"听起来不像人哼"的关键一步：踩在 MIDI 音高格上，音准感立刻变成电子音源。
    """
    out: list[GuideNote] = []
    for n in notes:
        if n.freq_hz <= 0:
            continue
        midi = round(69.0 + 12.0 * float(np.log2(n.freq_hz / 440.0)))
        out.append(replace(n, freq_hz=440.0 * 2.0 ** ((midi - 69) / 12.0)))
    return out


def merge_same_pitch(notes: Sequence[GuideNote], max_gap_s: float) -> list[GuideNote]:
    """合并音高相同、且间隔不超过 `max_gap_s` 的相邻音符。

    量化之后，颤音与滑音造成的碎音符会落到同一个半音上，这一步把它们并回一个长音——
    连贯性的收益主要来自这里，而不是来自合成端。
    """
    out: list[GuideNote] = []
    for n in notes:
        same = bool(out) and abs(out[-1].freq_hz - n.freq_hz) < 1e-6
        if same and n.start_s - out[-1].end_s <= max_gap_s:
            out[-1] = replace(out[-1], end_s=max(out[-1].end_s, n.end_s))
        else:
            out.append(n)
    return out


def absorb_short_notes(
    notes: Sequence[GuideNote], min_note_s: float, max_gap_s: float
) -> list[GuideNote]:
    """把过短的音符并入邻居，而不是丢弃。

    旧实现直接 `continue` 掉短音符，结果是在乐句中间留下空洞——这正是"不连贯"的
    直接来源之一。并入的对象取**音高更接近**的那一侧邻居（并入后由它接管这段时间），
    只有两侧都够不着（间隔超过 `max_gap_s`）时才真的丢掉。
    """
    items = list(notes)
    changed = True
    while changed and items:
        changed = False
        for i, n in enumerate(items):
            if n.duration_s >= min_note_s:
                continue
            prev = items[i - 1] if i > 0 else None
            nxt = items[i + 1] if i + 1 < len(items) else None
            if prev is not None and n.start_s - prev.end_s > max_gap_s:
                prev = None
            if nxt is not None and nxt.start_s - n.end_s > max_gap_s:
                nxt = None

            target: str | None = None
            if prev is not None and nxt is not None:
                d_prev = abs(prev.midi - n.midi)
                d_next = abs(nxt.midi - n.midi)
                target = "prev" if d_prev <= d_next else "next"
            elif prev is not None:
                target = "prev"
            elif nxt is not None:
                target = "next"

            # target is None 时两侧都够不着，这个短音符多半是 pYIN 在噪声上的误触发，
            # 没有邻居可以接管它的时间，只能丢弃
            if target == "prev" and prev is not None:
                items[i - 1] = replace(prev, end_s=max(prev.end_s, n.end_s))
            elif target == "next" and nxt is not None:
                items[i + 1] = replace(nxt, start_s=min(nxt.start_s, n.start_s))
            del items[i]
            changed = True
            break
    return items


def bridge_gaps(notes: Sequence[GuideNote], legato_gap_s: float) -> list[GuideNote]:
    """桥接短间隙：延长前一个音符到下一个音符的起点。

    只处理短于 `legato_gap_s` 的空档（辅音、换气）；真正的休止保持断开，
    否则引导音会在该停的地方拖着不放，反而误导演唱者。
    """
    out = list(notes)
    for i in range(len(out) - 1):
        gap = out[i + 1].start_s - out[i].end_s
        if 0.0 < gap <= legato_gap_s:
            out[i] = replace(out[i], end_s=out[i + 1].start_s)
    return out


def group_phrases(notes: Sequence[GuideNote], tol_s: float = 1e-6) -> list[list[GuideNote]]:
    """把首尾相接的音符归成乐句。淡入淡出只做在乐句边界，内部不做。"""
    phrases: list[list[GuideNote]] = []
    for n in notes:
        if phrases and abs(n.start_s - phrases[-1][-1].end_s) <= tol_s:
            phrases[-1].append(n)
        else:
            phrases.append([n])
    return phrases


def frames_to_notes(
    times: Sequence[float] | np.ndarray,
    f0: Sequence[float] | np.ndarray,
    voiced: Sequence[bool] | np.ndarray,
    config: GuideConfig,
) -> list[GuideNote]:
    """帧级基频 → 音符序列。与音频解码分离，便于用合成数据做单测。

    切分规则：清音间隙短于 `max_gap_s` 且间隙两侧音高接近时**不断开**；
    音高偏离超过 `cents_tolerance` 时断开。音符频率取该段实测 f0 的中位数
    ——起音的滑音与收尾的走调不该拉偏整个音符。
    """
    t_arr = np.asarray(times, dtype=np.float64)
    f_arr = np.asarray(f0, dtype=np.float64)
    v_arr = np.asarray(voiced, dtype=bool)
    if t_arr.size == 0:
        return []
    hop = float(t_arr[1] - t_arr[0]) if t_arr.size > 1 else 0.0

    raw: list[GuideNote] = []
    start: float | None = None
    freqs: list[float] = []
    last_voiced_end = 0.0

    def flush(end_t: float) -> None:
        if start is None or not freqs:
            return
        raw.append(GuideNote(start_s=start, end_s=end_t, freq_hz=float(np.median(freqs))))

    for t, f, v in zip(t_arr, f_arr, v_arr, strict=False):
        t = float(t)
        if not (bool(v) and np.isfinite(f) and f > 0.0):
            continue
        f = float(f)
        if start is None:
            start, freqs = t, [f]
            last_voiced_end = t + hop
            continue

        ref = float(np.median(freqs))
        cents = abs(1200.0 * float(np.log2(f / ref))) if ref > 0 else 0.0
        gap = t - last_voiced_end
        # 间隙够短且音高没跑掉 → 认定人还在唱同一个音，把间隙一并吞进这个音符
        if gap <= config.max_gap_s and cents <= config.cents_tolerance:
            freqs.append(f)
        else:
            flush(last_voiced_end)
            start, freqs = t, [f]
        last_voiced_end = t + hop

    if start is not None:
        flush(last_voiced_end)

    notes: list[GuideNote] = raw
    if config.quantize:
        notes = quantize_notes(notes)
    notes = merge_same_pitch(notes, config.legato_gap_s)
    notes = absorb_short_notes(notes, config.min_note_s, config.legato_gap_s)
    # 吸收短音符可能让两个同高音符变成相邻，再合并一次才不会留下多余的换音斜坡
    notes = merge_same_pitch(notes, config.legato_gap_s)
    return bridge_gaps(notes, config.legato_gap_s)


def extract_notes(vocals_path: Path, config: GuideConfig | None = None) -> list[GuideNote]:
    """从人声轨提取音符序列。"""
    import librosa

    cfg = config or GuideConfig()
    y, _ = librosa.load(str(vocals_path), sr=cfg.sr_analysis, mono=True)
    f0, voiced, _ = librosa.pyin(y, fmin=cfg.fmin, fmax=cfg.fmax, sr=cfg.sr_analysis)
    times = librosa.times_like(f0, sr=cfg.sr_analysis)
    return frames_to_notes(times, f0, voiced, cfg)


# ---------------------------------------------------------------------------
# 合成
# ---------------------------------------------------------------------------


def harmonic_weights(
    timbre: str, top_freq_hz: float, sr: int, max_harmonics: int
) -> list[tuple[int, float]]:
    """给出该音色在此音高下可安全使用的谐波表，已做 RMS 归一化。

    **带限是硬要求**：超过奈奎斯特的谐波会折返成不成谐的混叠噪声，在高音区听起来
    像一层刺耳的金属噪音。截断点取 0.95×奈奎斯特留一点余量。

    归一化到单位 RMS 而不是单位峰值，是为了让 `gain` 在不同音色间表示同一个响度——
    否则换个音色就得重调音量。
    """
    nyquist = 0.95 * sr / 2.0
    limit = int(nyquist // top_freq_hz) if top_freq_hz > 0 else max_harmonics
    limit = max(1, min(limit, max_harmonics))
    weights = [(n, w) for n, w in _TIMBRE_WEIGHTS[timbre].items() if n <= limit]
    if not weights:  # 基波都超奈奎斯特时的兜底，正常音域不会走到
        weights = [(1, 1.0)]
    rms = float(np.sqrt(sum(w * w for _, w in weights) / 2.0))
    return [(n, w / rms) for n, w in weights]


def _phrase_envelope(
    notes: Sequence[GuideNote], offsets: Sequence[int], total: int, sr: int, cfg: GuideConfig
) -> np.ndarray:
    """乐句包络：首尾淡入淡出 + 内部换音处的极短斜坡。"""
    env = np.ones(total, dtype=np.float64)

    ramp = max(0, int(cfg.note_ramp_s * sr))
    if ramp:
        for k in range(1, len(notes)):
            b = offsets[k]
            # 斜坡不能长过相邻音符本身，否则短音符会被削成一个尖峰
            span = min(ramp, (offsets[k] - offsets[k - 1]) // 2, (offsets[k + 1] - b) // 2)
            if span <= 0:
                continue
            # 降到 0 再升回来：两端都必须真正取到 0，否则斜坡本身又成了一个跳变
            env[b - span : b] *= np.linspace(1.0, 0.0, span)
            env[b : b + span] *= np.linspace(0.0, 1.0, span)

    fade = min(int(cfg.fade_s * sr), total // 2)
    if fade > 0:
        env[:fade] *= np.linspace(0.0, 1.0, fade)
        env[total - fade :] *= np.linspace(1.0, 0.0, fade)
    return env


def _render_phrase(notes: Sequence[GuideNote], sr: int, cfg: GuideConfig) -> tuple[int, np.ndarray]:
    """渲染一个乐句，返回（起始样本下标，波形）。

    整句用**连续相位**：把逐样本频率积分成相位，换音时相位不跳变，
    因此音符之间不需要衰减到零再重起——这是"连贯"在合成端的落点。
    谐波表按全句最高音统一取，句内谐波集合恒定，波形处处连续。
    """
    i0 = round(notes[0].start_s * sr)
    offsets = [round(n.start_s * sr) - i0 for n in notes]
    offsets.append(round(notes[-1].end_s * sr) - i0)
    total = offsets[-1]
    if total <= 0:
        return i0, np.zeros(0, dtype=np.float64)

    freq = np.zeros(total, dtype=np.float64)
    for k, n in enumerate(notes):
        freq[offsets[k] : offsets[k + 1]] = n.freq_hz

    phase = 2.0 * np.pi * np.cumsum(freq) / sr
    top = max(n.freq_hz for n in notes)
    wave = np.zeros(total, dtype=np.float64)
    for order, weight in harmonic_weights(cfg.timbre, top, sr, cfg.max_harmonics):
        wave += weight * np.sin(order * phase)

    return i0, wave * _phrase_envelope(notes, offsets, total, sr, cfg)


def synth_guide(
    notes: Iterable[GuideNote],
    duration_s: float,
    *,
    sr: int = 44100,
    config: GuideConfig | None = None,
) -> np.ndarray:
    """把音符序列合成为一条引导音轨（单声道 float32）。"""
    cfg = config or GuideConfig()
    out = np.zeros(int(duration_s * sr) + 1, dtype=np.float64)
    for phrase in group_phrases([n for n in notes if n.freq_hz > 0 and n.duration_s > 0]):
        i0, wave = _render_phrase(phrase, sr, cfg)
        if wave.size == 0:
            continue
        i0 = max(0, i0)
        i1 = min(len(out), i0 + wave.size)
        if i1 > i0:
            out[i0:i1] += cfg.gain * wave[: i1 - i0]

    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1.0:
        out /= peak
    return out.astype(np.float32)


def build_guide_track(
    vocals_path: Path,
    out_path: Path,
    duration_s: float,
    *,
    sr: int = 44100,
    gain: float | None = None,
    config: GuideConfig | None = None,
) -> int:
    """端到端产出引导声轨文件，返回音符数量。

    `gain` 单独留一个入口是为了兼容既有调用方；给出时覆盖 `config.gain`。
    """
    import soundfile as sf

    cfg = config or GuideConfig()
    if gain is not None:
        cfg = replace(cfg, gain=gain)

    notes = extract_notes(vocals_path, cfg)
    audio = synth_guide(notes, duration_s, sr=sr, config=cfg)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), audio, sr)
    return len(notes)
