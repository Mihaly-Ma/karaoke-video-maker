"""引导声（ガイドメロディ）：给 OFF VOCAL 版本合成音高引导音。

卡拉OK 的引导音帮演唱者找准音高与进入时机。**它不是"把人声调小混回去"**——
残留的原唱会和演唱者自己的声音打架，而且咬字含混反而更难跟。
正确做法是**只保留音高信息，用纯电子音重新合成**。

流程全部本地：

    vocals stem → pYIN 提取基频 → 按连续性切成音符 → 合成音色 → 混入伴奏

音色用正弦基波加少量三次谐波：纯正弦在密集编曲里会被埋掉，
而谐波太多又会显得刺耳、抢原曲。每个音符加淡入淡出包络，否则边界会爆音。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class GuideNote:
    """一个引导音符。"""

    start_s: float
    end_s: float
    freq_hz: float


def extract_notes(
    vocals_path: Path,
    *,
    sr: int = 22050,
    fmin: float = 65.0,
    fmax: float = 1200.0,
    min_note_s: float = 0.06,
    cents_tolerance: float = 80.0,
) -> list[GuideNote]:
    """从人声轨提取音符序列。

    `cents_tolerance` 控制何时算"同一个音"：音高波动在此范围内则并入当前音符，
    这样颤音不会被切成一串碎音符。默认 80 分（不到半音）。
    """
    import librosa
    import numpy as np

    y, _ = librosa.load(str(vocals_path), sr=sr, mono=True)
    f0, voiced, _ = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr)
    times = librosa.times_like(f0, sr=sr)

    notes: list[GuideNote] = []
    cur_start: float | None = None
    cur_freqs: list[float] = []

    def flush(end_t: float) -> None:
        if cur_start is None or not cur_freqs:
            return
        if end_t - cur_start < min_note_s:
            return
        # 用中位数而非均值：起音的滑音与结尾的走调不该拉偏整个音符
        notes.append(
            GuideNote(start_s=cur_start, end_s=end_t, freq_hz=float(np.median(cur_freqs)))
        )

    for t, f, v in zip(times, f0, voiced):
        ok = bool(v) and f is not None and np.isfinite(f) and f > 0
        if not ok:
            flush(float(t))
            cur_start, cur_freqs = None, []
            continue
        if cur_start is None:
            cur_start, cur_freqs = float(t), [float(f)]
            continue
        ref = float(np.median(cur_freqs))
        cents = abs(1200.0 * np.log2(float(f) / ref)) if ref > 0 else 0.0
        if cents > cents_tolerance:
            flush(float(t))
            cur_start, cur_freqs = float(t), [float(f)]
        else:
            cur_freqs.append(float(f))
    if cur_start is not None and len(times):
        flush(float(times[-1]))
    return notes


def synth_guide(
    notes: list[GuideNote],
    duration_s: float,
    *,
    sr: int = 44100,
    gain: float = 0.16,
    harmonic: float = 0.22,
    fade_s: float = 0.012,
):
    """把音符序列合成为一条引导音轨（numpy 单声道浮点数组）。"""
    import numpy as np

    out = np.zeros(int(duration_s * sr) + 1, dtype=np.float32)
    for n in notes:
        i0 = int(n.start_s * sr)
        i1 = min(len(out), int(n.end_s * sr))
        if i1 <= i0 or n.freq_hz <= 0:
            continue
        t = np.arange(i1 - i0, dtype=np.float32) / sr
        wave = np.sin(2 * np.pi * n.freq_hz * t)
        if harmonic > 0:
            wave += harmonic * np.sin(2 * np.pi * n.freq_hz * 3 * t)

        # 淡入淡出包络：不加会在音符边界产生咔哒声
        f = max(1, int(fade_s * sr))
        env = np.ones(len(wave), dtype=np.float32)
        f = min(f, len(wave) // 2)
        if f > 0:
            env[:f] = np.linspace(0.0, 1.0, f)
            env[-f:] = np.linspace(1.0, 0.0, f)
        out[i0:i1] += (wave * env * gain).astype(np.float32)

    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1.0:
        out /= peak
    return out


def build_guide_track(
    vocals_path: Path,
    out_path: Path,
    duration_s: float,
    *,
    sr: int = 44100,
    gain: float = 0.16,
) -> int:
    """端到端产出引导声轨文件，返回音符数量。"""
    import soundfile as sf

    notes = extract_notes(vocals_path)
    audio = synth_guide(notes, duration_s, sr=sr, gain=gain)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), audio, sr)
    return len(notes)
