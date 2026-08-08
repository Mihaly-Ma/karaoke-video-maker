"""节拍检测：让开唱引导点踩在音乐的拍子上。

引导点用固定间隔（如 550ms）只是"三个会消失的点"，与音乐无关；
按实际节拍熄灭才是真正的打拍子，演唱者能跟着进。

优先用**分离出的 drums stem** 做检测——鼓点是节拍最强的证据，
比在完整混音上分析准得多，而我们在去人声阶段本来就会产出这条轨，属于免费信号。

依赖 librosa。检测失败时返回 None，调用方回退到固定间隔，
**不因为节拍检测失败就不显示引导点**（§2.5：失败要降级，不能终止）。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class BeatGrid:
    """节拍网格。"""

    bpm: float
    beats_ms: list[int]
    """每个拍点的时间（毫秒），升序。"""

    def beat_period_ms(self) -> int:
        return int(round(60000.0 / self.bpm)) if self.bpm > 0 else 0

    def beats_before(self, t_ms: int, n: int) -> list[int]:
        """返回 `t_ms` 之前最近的 n 个拍点，升序。不足 n 个则有多少给多少。"""
        prior = [b for b in self.beats_ms if b < t_ms]
        return prior[-n:] if prior else []


def detect_beats(audio_path: Path, *, drums_path: Path | None = None) -> BeatGrid | None:
    """检测节拍。优先用 drums stem，失败则退回完整混音。"""
    src = drums_path if (drums_path and drums_path.exists()) else audio_path
    if not src.exists():
        return None
    try:
        import librosa
        import numpy as np
    except ImportError:
        return None

    try:
        # 22.05k 单声道足够做节拍分析，且比全采样率快得多
        y, sr = librosa.load(str(src), sr=22050, mono=True)
        tempo, frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
        times = librosa.frames_to_time(frames, sr=sr)
        if times is None or len(times) < 4:
            return None
        bpm = float(np.atleast_1d(tempo)[0])
        return BeatGrid(bpm=bpm, beats_ms=[int(round(t * 1000)) for t in times])
    except Exception:
        # 节拍检测是增强项，任何失败都不应阻断出片
        return None
