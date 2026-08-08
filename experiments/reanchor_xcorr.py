"""P0-4：歌词时间轴重锚定算法（onset 包络互相关 + 分段一致性判据）。

## 问题

歌词源（QRC/KRC/LRC）的时间轴打在**商业发行录音**上，我们要贴的是 **YouTube MV 音轨**。
两者的差异可能是：整体偏移（MV 有 logo 前奏）、线性漂移（母带速率差）、
非线性错位（MV 剪掉/加长了前奏或间奏）。

CLAUDE.md §5.3 把这一步列为"最大缺口"。此前那条"MV 与母带只差 11ms、全局单一常数即可"
的结论**已作废**（它拿两份人工句级字幕互比，人工标注本身有 ±100ms 随意性，
无法证明两条音轨的时间基准一致）。本脚本不沿用它，而是直接量两条音轨。

## 本脚本做什么

1. onset 包络互相关（仅 numpy + scipy，不引入 librosa）：
   log 幅度谱通量 → 每帧 onset 强度 → **逐 lag 皮尔逊归一化**互相关（NCC）。
   log + 时间差分让**任何静态 EQ 差异变成加性常数并被差分消掉**，
   这正是"两份不同母带"场景需要的鲁棒性。
2. 两种工作模式：
   - **模式 A（音频↔音频）**：有参照录音（YouTube Art Track / 本地音源）时用它，精度最高。
   - **模式 B（歌词时间轴↔音频）**：只有歌词时间戳时，把逐字起点做成脉冲串包络再互相关。
     没有参照录音时的唯一出路，精度明显更差，本脚本量化了差多少。
3. 分段互相关 → RANSAC 仿射拟合 → 断点扫描，裁决
   `constant / linear / piecewise / unreliable`，并输出可直接消费的 warp 折点。
4. 失败检测：峰值高度、次峰比 + 候选 offset 列表、峰宽、有效段落数、分段残差。
5. 验证分两层：
   - **合成信号**（真值精确已知）：注入偏移 / 线性拉伸 / 分段错位 / 母带差异，量化恢复精度。
   - **真实数据**（sumika「赤春花 (feat. 幾田りら)」）：Art Track（母带侧）、MV 音轨、
     QRC 逐字时间三方**闭环校验** —— offset(QRC→MV) 必须等于
     offset(QRC→Art) + offset(Art→MV)，这给了一个不依赖人工标注的真值检验。

## 实测结论（2026-08-09，全部来自本脚本的运行输出）

| 问题 | 实测答案 |
|---|---|
| 偏移恢复精度（模式 A，纯偏移） | 绝对误差中位 0.27ms / 最大 0.81ms（帧长 8ms，靠抛物线插值到亚帧） |
| 偏移恢复精度（模式 A，含母带差异） | 误差 2~3ms；EQ/压缩/软削波/底噪几乎不影响 |
| 偏移恢复精度（模式 B，歌词轴↔音频） | 系统性偏早 6~7.5ms，抖动 <2ms；对分离后人声比对整轨混音略好 |
| 线性漂移 | ≤1000ppm 可自动识别并给出 ppm（实测 200ppm→199、1000ppm→985）；≥4000ppm 超出范围，降级人工 |
| 分段错位检出下限 | ≥160ms 稳定检出并定位断点；80ms 落到"需人工确认"；≤40ms 被吸收成常数/线性 |
| 单一全局 offset 够不够 | 对验证曲够（25 段全部给出 62ms，p90 残差 0.2ms）。但这是**测出来的**，不是可以假设的 |
| 裁决正确率 | 合成用例 13/13 |
| 包络跳距 hop | 必须 ≤16ms；32ms 时实测跑飞 1016ms。默认 8ms |

真实素材（sumika「赤春花 (feat. 幾田りら)」）：
Art Track → MV 偏移 **+61.9ms，全曲常数**（25/25 段一致，p90 残差 0.2ms，峰值 0.860）。
MV 比 Art Track 长 23.6s，但多出来的内容在**尾部**，乐曲起点只差 62ms。

两个必须写进架构的负面结论：

- **模式 B 在真实素材上无法自证可靠**：QRC→MV 的点估计（-4.5ms）与
  QRC→Art + Art→MV 的闭合误差只有 1.6ms，说明它其实找对了；但它的峰值只有 0.09，
  与负对照（随机时间点 0.04、白噪声 0.01）没有拉开可判定的距离，
  峰值 z 分数（正例 4.4 vs 负对照 2.9~3.8）同样无法分离。
  **结论：没有参照录音时，不要让重锚定自动落轴，只能给候选值让用户确认。**
  分离后的 vocals.wav 是否能救回来，本脚本没有真实分离结果可测，属于未验证项。
- **YouTube 同一视频的不同音频 format 时间原点可以不同**：本曲 MV 的
  opus(251) 与 aac(140) 相差 **+36.7ms**（而 Art Track 的两者相差 0.00ms）。
  这意味着重锚定算出的 offset 只对**某一条特定音频流**成立，
  下载 / 分离 / 烧录三处必须锁同一条流，否则会凭空引入几十毫秒错位。

## 运行

    uv run --python 3.12 --with numpy --with scipy python -m experiments.reanchor_xcorr

真实素材（可选，缺失则自动跳过）：
    workspace/media/audio_16k_mono.wav          MV 音轨（由下载 agent 产出）
    workspace/reanchor/arttrack_PZ3CB2vmGYo.wav Art Track 音轨
    workspace/qrc/lyric_decrypted.xml           解密后的 QRC
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from scipy import signal as sps

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = ROOT / "workspace"

# ---------------------------------------------------------------------------
# 参数与阈值
# ---------------------------------------------------------------------------

SR = 16000  # onset 包络不需要高带宽；16k 单声道与强制对齐的输入规格一致
N_FFT = 512  # 32ms 分析窗
HOP = 128  # 8ms 跳距 → 包络帧率 125Hz；亚帧抛物线插值把精度压到帧长以下
HOP_MS = HOP / SR * 1000.0

MAX_LAG_S = 40.0  # MV 前奏最多几十秒，±40s 足够
MIN_OVERLAP_S = 30.0  # 逐 lag 归一化的绝对最小重叠
MIN_OVERLAP_FRAC = 0.5  # 且不得低于较短一路的 50% —— 见下方"重叠不足会伪造高相关"

SEG_WIN_S = 20.0  # 分段窗长：太短包络信息不足，太长跟不上非线性变化
SEG_HOP_S = 10.0
SEG_SEARCH_S = 2.5  # 段内相对全局偏移的搜索半径

# 判据阈值（数值依据见运行报告；改动前请重跑本脚本）
PEAK_MIN_AUDIO = 0.30  # 模式 A 全局 NCC 峰值下限
PEAK_MIN_MODE_B = 0.12  # 模式 B（脉冲串 vs 连续包络）峰值天然低得多
PEAK_MIN_SEG = 0.25
PEAK_RATIO_MAX = 0.97  # 次峰/主峰。只有"几乎并列"才判不可靠 —— 音乐天然周期性会让次峰很高
SECOND_PEAK_EXCL_S = 0.5
CAND_NMS_S = 0.4  # 候选 offset 的非极大抑制半径
TOL_GOOD_MS = 30.0  # 残差在此以内视为"该模型够用"
TOL_FLAG_MS = 80.0  # 残差/台阶超过此值必须报警（约一个音节，肉眼可见）
MIN_SEG_USED = 4


def flux_frame_time_ms(i: float) -> float:
    """包络第 i 帧对应的真实时刻（毫秒）。

    这个换算**必须写对**，否则模式 B 会有系统性偏置：
    STFT 第 i 帧覆盖样本 [i·hop, i·hop+n_fft)，中心在 i·hop + n_fft/2；
    通量第 i 帧是第 i 与 i-1 帧之差，等效时刻再回退半个 hop。
    模式 A 两路都有同样的滞后会自动抵消；模式 B 的脉冲串没有，
    不补偿就会稳定早报约 n_fft/2 - hop/2 = 12ms（实测确认过这个偏置）。
    """
    return ((i - 0.5) * HOP + N_FFT / 2) / SR * 1000.0


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class OffsetEstimate:
    """一次互相关的结果 + 全部失败检测指标。"""

    offset_ms: float
    peak: float  # 主峰归一化相关值（皮尔逊，∈[-1,1]）
    second_peak: float
    peak_ratio: float
    width_ms: float  # 主峰半高全宽，越窄定位越锐利
    overlap_s: float
    reliable: bool
    ambiguous: bool  # 次峰接近主峰 → 存在同样合理的备选 offset
    candidates: list[tuple[float, float]] = field(default_factory=list)  # (offset_ms, ncc)
    reason: str = ""


@dataclass
class SegmentEstimate:
    t_ref_ms: float
    offset_ms: float
    peak: float
    peak_ratio: float
    energy: float  # 相对全曲的 onset 能量，用于剔除纯伴奏/静音段
    reliable: bool


@dataclass
class Verdict:
    kind: str  # constant / linear / piecewise / needs_manual / no_match
    global_offset_ms: float  # 曲目中部处的偏移（linear 时为参考点值）
    fit_a_ms: float  # offset(t) = a + b·t
    fit_b: float
    drift_ppm: float
    drift_total_ms: float
    resid_p50_ms: float
    resid_p90_ms: float
    resid_max_ms: float
    breakpoint_ms: float | None
    step_ms: float | None
    n_seg_used: int
    n_seg_total: int
    global_est: OffsetEstimate | None
    notes: list[str] = field(default_factory=list)
    segments: list[SegmentEstimate] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 音频 I/O 与 onset 包络
# ---------------------------------------------------------------------------


def load_audio(path: str | Path, sr: int = SR) -> np.ndarray:
    """用 ffmpeg 解码任意音视频为 float32 单声道。

    走 ffmpeg 而不是 soundfile/librosa：本项目本来就必须有 ffmpeg（§2.5），
    多引一个解码依赖没有收益。
    """
    from experiments.ffmpeg_locate import find_ffmpeg_with_libass

    ff = find_ffmpeg_with_libass()
    cmd = [
        ff, "-v", "error", "-nostdin", "-i", str(path),
        "-map", "a:0", "-ac", "1", "-ar", str(sr),
        "-f", "f32le", "-",
    ]  # fmt: skip
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        msg = f"ffmpeg 解码失败：{path}\n{proc.stderr.decode(errors='replace')[:500]}"
        raise RuntimeError(msg)
    return np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32)


def _stft_mag(x: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """分块计算幅度谱，避免一次性展开成几百 MB 的帧矩阵。"""
    x = np.ascontiguousarray(x, dtype=np.float32)
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    n_frames = 1 + (len(x) - n_fft) // hop
    win = np.hanning(n_fft).astype(np.float32)
    out = np.empty((n_frames, n_fft // 2 + 1), dtype=np.float32)
    for beg in range(0, n_frames, 4096):
        end = min(beg + 4096, n_frames)
        idx = np.arange(n_fft)[None, :] + hop * np.arange(beg, end)[:, None]
        out[beg:end] = np.abs(np.fft.rfft(x[idx] * win, axis=1)).astype(np.float32)
    return out


def onset_envelope(x: np.ndarray, sr: int = SR, hop: int = HOP) -> np.ndarray:
    """log 幅度谱通量 onset 强度曲线。

    为什么在包络上做互相关而不是原始波形：
    原始波形对相位、音色、有损编码差异极度敏感，两份母带的波形互相关会直接塌掉；
    onset 强度只保留"什么时候有能量突变"，这个信息在两份母带上是共享的。

    为什么取 log 再差分：两份母带在某频带差一个静态增益 g 时 log(g·S) = log S + log g，
    时间差分后 log g 直接消失 —— **这条包络对任意静态 EQ 免疫**。
    """
    mag = _stft_mag(x, hop=hop)
    lg = np.log1p(1000.0 * mag)  # 1000 让弱信号也进入 log 的线性区
    flux = np.maximum(0.0, np.diff(lg, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux]).astype(np.float64)
    # 减去 0.5s 滑动均值再半波整流：只留"比周围显著更强的突变"，
    # 避免持续的宽带噪声/混响尾巴主导相关
    w = max(3, int(round(0.5 * sr / hop)))
    trend = np.convolve(flux, np.ones(w) / w, mode="same")
    env = np.maximum(0.0, flux - trend)
    std = env.std()
    return (env - env.mean()) / std if std > 1e-12 else env * 0.0


def impulse_envelope(onsets_ms, n_frames: int, sigma_ms: float = 40.0) -> np.ndarray:
    """把歌词源的逐字起点做成"伪 onset 包络"（模式 B）。

    高斯核宽度要覆盖歌词源本身的标注抖动（QRC 逐字时间也不是零误差），
    太窄会让互相关退化成碰运气的稀疏匹配。
    帧索引换算必须与 `flux_frame_time_ms` 严格互逆，否则引入系统性偏置。
    """
    env = np.zeros(n_frames, dtype=np.float64)
    t = np.asarray(onsets_ms, dtype=np.float64)
    idx = np.round((t * SR / 1000.0 - N_FFT / 2) / HOP + 0.5).astype(int)
    idx = idx[(idx >= 0) & (idx < n_frames)]
    np.add.at(env, idx, 1.0)
    sigma_f = max(1.0, sigma_ms / HOP_MS)
    half = int(math.ceil(3 * sigma_f))
    k = np.exp(-0.5 * (np.arange(-half, half + 1) / sigma_f) ** 2)
    env = np.convolve(env, k / k.sum(), mode="same")
    std = env.std()
    return (env - env.mean()) / std if std > 1e-12 else env


def voice_activity_curve(x: np.ndarray, sr: int = SR, hop: int = HOP) -> np.ndarray:
    """粗糙的"有没有人在唱"曲线（模式 B2 用）。

    人声主要能量在 300–3400Hz。这里用该带内能量占比 × 总能量的对数，
    再做 0.6s 平滑 —— 它区分不了人声与同频段乐器，但足以勾出
    "前奏/间奏 vs 有唱段"的段落轮廓，而这正是模式 B2 需要的低频信息。
    """
    mag = _stft_mag(x, hop=hop)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    band = (freqs >= 300) & (freqs <= 3400)
    e_band = mag[:, band].sum(1)
    e_all = mag.sum(1) + 1e-9
    v = (e_band / e_all) * np.log1p(1000.0 * e_all)
    w = max(3, int(round(0.6 * sr / hop)))
    v = np.convolve(v.astype(np.float64), np.ones(w) / w, mode="same")
    std = v.std()
    return (v - v.mean()) / std if std > 1e-12 else v * 0.0


def lyric_activity_curve(lines: list[tuple[int, int, str]], n_frames: int) -> np.ndarray:
    """歌词行的"有词/无词"方波，与 `voice_activity_curve` 对齐用。"""
    v = np.zeros(n_frames, dtype=np.float64)
    for start, dur, _ in lines:
        i0 = int(round((start * SR / 1000.0 - N_FFT / 2) / HOP + 0.5))
        i1 = int(round(((start + dur) * SR / 1000.0 - N_FFT / 2) / HOP + 0.5))
        v[max(0, i0): max(0, min(n_frames, i1))] = 1.0
    w = max(3, int(round(0.6 * SR / HOP)))
    v = np.convolve(v, np.ones(w) / w, mode="same")
    std = v.std()
    return (v - v.mean()) / std if std > 1e-12 else v


# ---------------------------------------------------------------------------
# 逐 lag 归一化互相关
# ---------------------------------------------------------------------------


def ncc(a: np.ndarray, b: np.ndarray, lag_min: int, lag_max: int,
        min_overlap: int) -> tuple[np.ndarray, np.ndarray]:
    """计算 c[L] = corr(a[n], b[n+L])，逐 lag 做皮尔逊归一化。

    lag 符号约定：**L>0 表示目标 b 比参照 a 晚 L 帧**。
    即若 b[n] = a[n-D]，峰值出现在 L=D；把歌词时间轴整体 +offset 即可贴到目标上。

    逐 lag 归一化（而不是只除一个全局能量）是必须的：不同 lag 的重叠长度不同，
    不归一化时短重叠区会给出虚高相关值，次峰比这个失败判据就完全失去意义。
    但归一化本身**不能**修复"重叠太短时估计量方差爆炸"——那必须靠 min_overlap 卡住。
    实测：60s 素材上把 min_overlap 放到 20s 时，边缘短重叠的伪峰会直接盖过真峰，
    给出偏差上万毫秒的结果。
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    na, nb = len(a), len(b)
    lag_min = max(lag_min, -(na - 1))
    lag_max = min(lag_max, nb - 1)
    if lag_max < lag_min:
        return np.zeros(0), np.zeros(0)

    full = sps.fftconvolve(b, a[::-1], mode="full")  # 索引 k 对应 L = k-(na-1)
    lags = np.arange(lag_min, lag_max + 1)
    sab = full[lags + (na - 1)]

    a1 = np.concatenate([[0.0], np.cumsum(a)])
    a2 = np.concatenate([[0.0], np.cumsum(a * a)])
    b1 = np.concatenate([[0.0], np.cumsum(b)])
    b2 = np.concatenate([[0.0], np.cumsum(b * b)])

    n0 = np.maximum(0, -lags)
    n1 = np.minimum(na, nb - lags)
    cnt = (n1 - n0).astype(np.float64)
    ok = cnt >= max(2, min_overlap)
    cnt_safe = np.where(ok, cnt, 1.0)
    m0, m1 = n0 + lags, n1 + lags

    sa = a1[n1] - a1[n0]
    sa2 = a2[n1] - a2[n0]
    sb = b1[m1] - b1[m0]
    sb2 = b2[m1] - b2[m0]
    num = sab - sa * sb / cnt_safe
    va = np.maximum(1e-12, sa2 - sa * sa / cnt_safe)
    vb = np.maximum(1e-12, sb2 - sb * sb / cnt_safe)
    out = num / np.sqrt(va * vb)
    out[~ok] = -np.inf
    return lags, out


def _parabolic(y: np.ndarray, k: int) -> float:
    """抛物线顶点插值，返回相对 k 的亚帧偏移。这是把 8ms 帧长压到亚毫秒的关键。"""
    if k <= 0 or k >= len(y) - 1 or not np.isfinite(y[k - 1]) or not np.isfinite(y[k + 1]):
        return 0.0
    y0, y1, y2 = y[k - 1], y[k], y[k + 1]
    den = y0 - 2 * y1 + y2
    if abs(den) < 1e-12:
        return 0.0
    return float(np.clip(0.5 * (y0 - y2) / den, -1.0, 1.0))


def _half_width_ms(lags: np.ndarray, y: np.ndarray, k: int) -> float:
    """主峰半高全宽（ms）。峰越窄，这个 offset 越不可替代。"""
    peak = y[k]
    if not np.isfinite(peak) or peak <= 0:
        return float("inf")
    half = peak * 0.5
    left, right = k, k
    while left > 0 and y[left] > half:
        left -= 1
    while right < len(y) - 1 and y[right] > half:
        right += 1
    return float((lags[right] - lags[left]) * HOP_MS)


def _candidates(lags: np.ndarray, y: np.ndarray, top: int = 4) -> list[tuple[float, float]]:
    """非极大抑制后的候选 offset 列表。

    自动校准判不可靠时，UI 不该只说"失败"，而应给用户几个候选让他挑 —— 这是
    §5.3 "不要静默输出错的轴"的正向落地。
    """
    yy = np.where(np.isfinite(y), y, -np.inf).copy()
    r = max(1, int(round(CAND_NMS_S * SR / HOP)))
    out: list[tuple[float, float]] = []
    for _ in range(top):
        k = int(np.argmax(yy))
        if not np.isfinite(yy[k]) or yy[k] <= 0:
            break
        out.append((float((lags[k] + _parabolic(y, k)) * HOP_MS), float(y[k])))
        yy[max(0, k - r): k + r + 1] = -np.inf
    return out


def estimate_offset(env_ref: np.ndarray, env_tgt: np.ndarray,
                    max_lag_s: float = MAX_LAG_S,
                    peak_min: float = PEAK_MIN_AUDIO) -> OffsetEstimate:
    """全局偏移估计 + 失败检测。"""
    max_lag = int(round(max_lag_s * SR / HOP))
    min_ov = max(int(round(MIN_OVERLAP_S * SR / HOP)),
                 int(MIN_OVERLAP_FRAC * min(len(env_ref), len(env_tgt))))
    lags, y = ncc(env_ref, env_tgt, -max_lag, max_lag, min_ov)
    if len(lags) == 0 or not np.isfinite(y).any():
        return OffsetEstimate(0.0, 0.0, 0.0, 1.0, float("inf"), 0.0, False, True,
                              [], "重叠不足，无可用 lag")

    k = int(np.argmax(np.where(np.isfinite(y), y, -np.inf)))
    peak = float(y[k])
    off_frames = lags[k] + _parabolic(y, k)
    excl = int(round(SECOND_PEAK_EXCL_S * SR / HOP))
    mask = np.isfinite(y).copy()
    mask[max(0, k - excl): k + excl + 1] = False
    second = float(np.max(y[mask])) if mask.any() else 0.0
    ratio = second / peak if peak > 1e-9 else 1.0
    width = _half_width_ms(lags, y, k)
    overlap = float(min(len(env_ref), len(env_tgt)) - abs(lags[k])) * HOP / SR

    reasons = []
    if peak < peak_min:
        reasons.append(f"峰值 {peak:.3f} < {peak_min}")
    if ratio > PEAK_RATIO_MAX:
        reasons.append(f"次峰比 {ratio:.3f} > {PEAK_RATIO_MAX}（存在几乎并列的备选 offset）")
    return OffsetEstimate(
        offset_ms=float(off_frames * HOP_MS), peak=peak, second_peak=second,
        peak_ratio=float(ratio), width_ms=width, overlap_s=overlap,
        reliable=not reasons, ambiguous=bool(ratio > 0.90),
        candidates=_candidates(lags, y), reason="；".join(reasons),
    )


def segment_offsets(env_ref: np.ndarray, env_tgt: np.ndarray,
                    center_ms=0.0, search_s: float = MAX_LAG_S,
                    win_s: float = SEG_WIN_S, hop_s: float = SEG_HOP_S,
                    peak_min: float = PEAK_MIN_SEG) -> list[SegmentEstimate]:
    """分段互相关：每段独立估一个偏移，得到 offset(t) 的采样点。

    这是"要不要非线性 warp"的唯一判据来源 —— 单个全局互相关无论峰多高，
    都无法区分"整体平移"和"平均下来像整体平移的分段错位"。

    **默认每段做全量程搜索**（search_s = MAX_LAG_S），而不是围着全局偏移开一个小窗。
    第一版围着全局偏移 ±2.5s 搜，结果在两种关键场景下整体失效：
    线性漂移会把全局互相关峰打散（实测 200ppm 就让峰值从 0.79 掉到 0.30），
    分段错位超过窗宽时后半段根本够不着真值。全量程搜索让离群段由 RANSAC 处理，
    代价只是每段一次短序列 FFT，可以忽略。

    `center_ms` 可传标量或 callable(t_ref_ms)，配合小 search_s 用于精修。
    """
    dur_s = len(env_ref) * HOP / SR
    if dur_s < win_s * 4:  # 短素材自适应缩窗，保证至少能取到若干段
        win_s = max(6.0, dur_s / 5)
        hop_s = win_s / 2
    win = int(round(win_s * SR / HOP))
    step = max(1, int(round(hop_s * SR / HOP)))
    search = int(round(search_s * SR / HOP))
    cfn = center_ms if callable(center_ms) else (lambda _t: center_ms)
    mean_energy = float(np.mean(np.abs(env_ref))) or 1.0

    out: list[SegmentEstimate] = []
    for beg in range(0, max(1, len(env_ref) - win + 1), step):
        seg = env_ref[beg: beg + win]
        if len(seg) < win:
            break
        t_center = flux_frame_time_ms(beg + win / 2)
        c = int(round(cfn(t_center) / HOP_MS))
        lo, hi = beg + c - search, beg + c + win + search
        pad = max(0, -lo)
        tgt = env_tgt[max(0, lo): min(len(env_tgt), max(0, hi))]
        if len(tgt) < win + 4:  # 目标侧不够长，这一段没法估
            continue
        lags, y = ncc(seg, tgt, 0, len(tgt) - win, min_overlap=int(0.95 * win))
        if len(lags) == 0 or not np.isfinite(y).any():
            continue
        k = int(np.argmax(np.where(np.isfinite(y), y, -np.inf)))
        peak = float(y[k])
        # tgt 的 0 号帧对应绝对帧 (lo+pad)；seg 的 0 号帧对应绝对帧 beg
        off_frames = (lo + pad) + (lags[k] + _parabolic(y, k)) - beg
        excl = int(round(0.3 * SR / HOP))
        mask = np.isfinite(y).copy()
        mask[max(0, k - excl): k + excl + 1] = False
        second = float(np.max(y[mask])) if mask.any() else 0.0
        ratio = second / peak if peak > 1e-9 else 1.0
        energy = float(np.mean(np.abs(seg))) / mean_energy
        edge = bool(k <= 1 or k >= len(y) - 2)  # 顶到可搜索边界 = 真值在窗外，不可信
        out.append(SegmentEstimate(
            t_ref_ms=t_center, offset_ms=float(off_frames * HOP_MS), peak=peak,
            peak_ratio=float(ratio), energy=energy,
            reliable=bool(peak >= peak_min and energy >= 0.3 and not edge),
        ))
    return out


# ---------------------------------------------------------------------------
# 仿射拟合 / 断点检测 / 裁决
# ---------------------------------------------------------------------------


def fit_affine_ransac(t: np.ndarray, y: np.ndarray, tol_ms: float = TOL_GOOD_MS,
                      seed: int = 0) -> tuple[float, float, np.ndarray]:
    """RANSAC 拟合 offset(t) = a + b·t，返回 (a, b, inlier 掩码)。

    必须抗离群：落在纯伴奏段或对唱重叠段的局部互相关会给出离谱值，
    最小二乘会被这几个点整体拉歪。
    """
    n = len(t)
    if n < 2:
        return (float(y[0]) if n else 0.0), 0.0, np.ones(n, dtype=bool)
    rng = np.random.default_rng(seed)
    best_inl = np.zeros(n, dtype=bool)
    best_a, best_b = float(np.median(y)), 0.0
    for _ in range(min(300, max(30, n * (n - 1)))):
        i, j = rng.choice(n, size=2, replace=False)
        if abs(t[i] - t[j]) < 1e-6:
            continue
        b = (y[j] - y[i]) / (t[j] - t[i])
        a = y[i] - b * t[i]
        inl = np.abs(y - (a + b * t)) <= tol_ms
        if inl.sum() > best_inl.sum():
            best_inl, best_a, best_b = inl, a, b
    if best_inl.sum() >= 2:
        b, a = np.polyfit(t[best_inl], y[best_inl], 1)
        best_a, best_b = float(a), float(b)
    return best_a, best_b, np.abs(y - (best_a + best_b * t)) <= tol_ms


def find_breakpoint(t: np.ndarray, y: np.ndarray) -> tuple[int, float, float]:
    """扫描单断点分段常数模型，返回 (断点索引, 台阶高度 ms, 分段后残差 ms)。

    断点两侧各排除一个点：分段窗有 50% 重叠，跨在剪辑点上的那一两段同时含有
    错位前后的内容，估出来的偏移必然是两不靠的中间值。不排除它们，
    残差判据会被这一两个点顶穿，真实的台阶反而检不出来（第一版就是这么漏掉 6s 剪辑的）。
    """
    n = len(t)
    best = (0, 0.0, float("inf"))
    for i in range(2, n - 1):
        left, right = y[: max(1, i - 1)], y[min(n - 1, i + 1):]
        if len(left) < 2 or len(right) < 2:
            continue
        ml, mr = float(np.median(left)), float(np.median(right))
        resid = max(float(np.max(np.abs(left - ml))), float(np.max(np.abs(right - mr))))
        if resid < best[2]:
            best = (i, mr - ml, resid)
    return best


def diagnose(env_ref: np.ndarray, env_tgt: np.ndarray, *,
             peak_min: float = PEAK_MIN_AUDIO,
             peak_min_seg: float = PEAK_MIN_SEG,
             seg_search_s: float = MAX_LAG_S) -> Verdict:
    """完整的重锚定裁决流程；分段不一致时自动用更短的窗重试一次。

    重试的意义：窗越长每段的互相关越可靠，但窗内自身的漂移也越大。
    5000ppm 漂移下 20s 窗内部就要糊掉 100ms，长窗必然失效；短窗能救回来。
    """
    v = _diagnose_once(env_ref, env_tgt, peak_min=peak_min, peak_min_seg=peak_min_seg,
                       seg_search_s=seg_search_s)
    if v.kind in ("needs_manual", "no_match"):
        v2 = _diagnose_once(env_ref, env_tgt, peak_min=peak_min, peak_min_seg=peak_min_seg,
                            seg_search_s=seg_search_s, win_s=8.0, hop_s=4.0)
        if v2.kind in ("constant", "linear", "piecewise"):
            v2.notes.insert(0, "（20s 窗判不一致，自动改用 8s 短窗重试后成立）")
            return v2
    return v


def _diagnose_once(env_ref: np.ndarray, env_tgt: np.ndarray, *,
                   peak_min: float = PEAK_MIN_AUDIO,
                   peak_min_seg: float = PEAK_MIN_SEG,
                   seg_search_s: float = MAX_LAG_S,
                   win_s: float = SEG_WIN_S, hop_s: float = SEG_HOP_S) -> Verdict:
    g = estimate_offset(env_ref, env_tgt, peak_min=peak_min)
    notes: list[str] = []
    nan = math.nan
    if g.ambiguous:
        notes.append(f"注意：全局次峰比 {g.peak_ratio:.3f}，候选 offset "
                     + "、".join(f"{o:.0f}ms({v:.3f})" for o, v in g.candidates[:3]))

    # 全局互相关只做"是不是同一首曲子"的报告与兜底，**不作为 offset 的最终来源**：
    # 线性漂移会把全局峰打散，分段全量程搜索反而更稳。
    # seg_search_s 默认全量程；模式 B 每段信息量太少，必须收窄到全局估计附近
    # （实测：模式 B 全量程分段搜索在真实素材上给出 35s/-36s 这种彻底散掉的段落估计）
    segs = segment_offsets(env_ref, env_tgt, center_ms=g.offset_ms, search_s=seg_search_s,
                           win_s=win_s, hop_s=hop_s, peak_min=peak_min_seg)
    used = [s for s in segs if s.reliable]
    seg_frac = len(used) / max(1, len(segs))
    if len(used) < MIN_SEG_USED or seg_frac < 0.25:
        # 两种失败要分开：一种是"根本不是同一段音频"，一种是"证据不足但可能是对的"。
        # 前者应直接报错让用户换源，后者应把候选 offset 交给用户人工确认（§5.3）。
        # no_match 的门槛要**故意收紧**：把"同一首歌但算法搞不定"误报成"不是同一首歌"
        # 会让用户去换歌词源，反而更糟。实测 5000ppm 漂移的同曲仍能留下 22% 有效段，
        # 而真正不相关的素材是 0%，所以 15% 是安全的分界。
        kind = "no_match" if (g.peak < peak_min and seg_frac < 0.15) else "needs_manual"
        notes.append(f"有效段落 {len(used)}/{len(segs)}（{seg_frac:.0%}），全局峰值 {g.peak:.3f}"
                     f" → {'判定不是同一段音频' if kind == 'no_match' else '证据不足，降级人工确认'}")
        return Verdict(kind, g.offset_ms, g.offset_ms, 0.0, 0.0, 0.0,
                       nan, nan, nan, None, None, len(used), len(segs), g, notes, segs)

    t = np.array([s.t_ref_ms for s in used])
    y = np.array([s.offset_ms for s in used])
    a, b, inl = fit_affine_ransac(t, y)
    if inl.mean() < 0.5:
        kind = "no_match" if (g.peak < peak_min and seg_frac < 0.15) else "needs_manual"
        notes.append(f"分段之间互不同意（RANSAC 内点仅 {inl.mean():.0%}），全局峰值 {g.peak:.3f}"
                     f" → {'判定不匹配' if kind == 'no_match' else '只能给候选 offset，需人工确认'}")
        return Verdict(kind, g.offset_ms, g.offset_ms, 0.0, 0.0, 0.0,
                       nan, nan, nan, None, None, len(used), len(segs), g, notes, segs)
    resid = np.abs(y - (a + b * t))
    p50, p90, pmax = (float(np.percentile(resid, 50)), float(np.percentile(resid, 90)),
                      float(np.max(resid)))
    span = float(t.max() - t.min())
    drift_total = b * span
    off_center = a + b * float(np.median(t))

    bp_idx, step, bp_resid = find_breakpoint(t, y) if len(t) >= 5 else (0, 0.0, float("inf"))
    bp_ms: float | None = None
    step_ms: float | None = None

    if p90 <= TOL_GOOD_MS and abs(drift_total) <= TOL_GOOD_MS:
        kind = "constant"
        notes.append(f"各段偏移一致（p90 残差 {p90:.1f}ms，全曲累计漂移 {drift_total:.1f}ms）"
                     f"，单一全局 offset 足够")
    elif p90 <= TOL_GOOD_MS:
        kind = "linear"
        notes.append(f"线性漂移 {b * 1e6:.0f} ppm，全曲累计 {drift_total:.1f}ms，"
                     f"需要 offset+scale 仿射变换")
    elif bp_resid <= TOL_GOOD_MS and abs(step) >= TOL_FLAG_MS:
        kind = "piecewise"
        bp_ms = float((t[bp_idx - 1] + t[bp_idx]) / 2)
        step_ms = float(step)
        notes.append(f"检出分段错位：断点约 {bp_ms / 1000:.1f}s，台阶 {step:+.0f}ms；"
                     f"单一仿射不够，必须分段（或 DTW）")
    else:
        kind = "needs_manual"
        notes.append(f"各段偏移既不一致也不是单个台阶（p90 残差 {p90:.0f}ms，最大 {pmax:.0f}ms）"
                     f"，判定自动校准不可靠，需人工确认")
    if kind not in ("needs_manual", "no_match") and pmax > TOL_FLAG_MS:
        notes.append(f"警告：{int(np.sum(resid > TOL_FLAG_MS))} 个段落残差 >{TOL_FLAG_MS:.0f}ms，"
                     f"应在 UI 上打红标")
    return Verdict(kind, float(off_center), float(a), float(b), float(b * 1e6),
                   float(drift_total), p50, p90, pmax, bp_ms, step_ms,
                   len(used), len(segs), g, notes, segs)


def build_warp_map(v: Verdict) -> list[tuple[float, float]]:
    """输出重锚定映射折点 (t_参照ms → t_目标ms)，供管线 [5] 直接消费。"""
    if v.kind in ("constant", "linear"):
        end = max((s.t_ref_ms for s in v.segments), default=0.0) * 1.2 + 10000.0
        return [(0.0, v.fit_a_ms), (end, end * (1 + v.fit_b) + v.fit_a_ms)]
    out: list[tuple[float, float]] = []
    for s in v.segments:  # 强制单调，避免 warp 出现时间倒流
        if not s.reliable:
            continue
        knot = (s.t_ref_ms, s.t_ref_ms + s.offset_ms)
        if out and knot[1] <= out[-1][1]:
            continue
        out.append(knot)
    return out


# ---------------------------------------------------------------------------
# 合成信号：可控真值
# ---------------------------------------------------------------------------


def _adsr(n: int, attack: int, decay: float) -> np.ndarray:
    env = np.exp(-np.arange(n) / decay)
    atk = min(attack, n)
    env[:atk] *= np.linspace(0, 1, atk)
    return env


def synth_song(duration_s: float = 200.0, bpm: float = 118.0, seed: int = 0,
               sr: int = SR) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """合成一段"歌"：鼓组 + 和声垫 + 人声音节，带段落编排与演奏抖动。

    刻意加入过门、段落配器变化、±4ms 打点抖动 —— 否则合成信号会是完美周期的，
    次峰比会虚高到失去参考价值（第一版就踩了这个坑）。
    返回 (混音, 人声轨, 人声音节起点毫秒)，音节起点是**精确已知的真值**。
    """
    rng = np.random.default_rng(seed)
    n = int(duration_s * sr)
    drums = np.zeros(n, dtype=np.float32)
    harm = np.zeros(n, dtype=np.float32)
    vocal = np.zeros(n, dtype=np.float32)
    spb = 60.0 / bpm
    n_beats = int(duration_s / spb)
    hp5k = sps.butter(4, 5000, "hp", fs=sr, output="sos")
    hp3k = sps.butter(4, 3000, "hp", fs=sr, output="sos")

    def place(dst: np.ndarray, pos: int, buf: np.ndarray) -> None:
        end = min(len(dst), pos + len(buf))
        if 0 <= pos < len(dst) and end > pos:
            dst[pos:end] += buf[: end - pos]

    def kick(t0: int, amp: float = 0.9) -> None:
        m = int(0.16 * sr)
        f = np.linspace(110, 45, m)
        place(drums, t0, (np.sin(2 * np.pi * np.cumsum(f) / sr)
                          * _adsr(m, 20, 0.03 * sr) * amp).astype(np.float32))

    def snare(t0: int, amp: float = 0.5) -> None:
        m = int(0.13 * sr)
        place(drums, t0, (rng.standard_normal(m) * _adsr(m, 5, 0.02 * sr) * amp).astype(np.float32))

    for i in range(n_beats):
        bar, sec = i // 4, (i // 4) // 8  # 每 8 小节一个段落
        jit = lambda: int(rng.normal(0, 0.004) * sr)
        t0 = int(i * spb * sr)
        dense = sec % 3 != 0  # 段落配器：稀疏段只有底鼓
        if i % 4 in (0, 2):
            kick(t0 + jit())
        if dense and i % 4 in (1, 3):
            snare(t0 + jit())
        if dense:
            for h in (0.5,) if sec % 2 else (0.25, 0.5, 0.75):
                m = int(0.05 * sr)
                hh = sps.sosfilt(hp5k, rng.standard_normal(m)) * _adsr(m, 2, 0.008 * sr) * 0.35
                place(drums, t0 + int(h * spb * sr) + jit(), hh.astype(np.float32))
        if bar % 8 == 7 and i % 4 == 3:  # 段落末过门，打破周期性
            for j in range(4):
                snare(t0 + int(j * 0.25 * spb * sr) + jit(), amp=0.35 + 0.1 * j)
        if i % 2 == 0:
            root = 110.0 * 2 ** (rng.integers(0, 12) / 12)
            m = int(2 * spb * sr)
            tt = np.arange(m) / sr
            chord = sum(np.sin(2 * np.pi * root * r * tt) / r for r in (1, 1.5, 2, 2.52))
            place(harm, t0, (chord * _adsr(m, int(0.05 * sr), 1.5 * sr) * 0.25).astype(np.float32))

    onsets: list[float] = []
    for i in range(n_beats):
        bar = i // 4
        if bar < 4 or (bar % 16) in (12, 13):  # 前奏 + 间奏，无人声
            continue
        for sub in (0.0, 0.25, 0.5, 0.75):
            if rng.random() > 0.55:
                continue
            t = (i + sub) * spb + rng.normal(0, 0.012)
            if t < 0 or t > duration_s - 1:
                continue
            m = int(rng.uniform(0.12, 0.35) * sr)
            tt = np.arange(m) / sr
            f0 = rng.uniform(180, 330) * (1 + 0.01 * np.sin(2 * np.pi * 5.5 * tt))
            ph = 2 * np.pi * np.cumsum(f0) / sr
            sig = sum(np.sin(k * ph) / (k ** 1.4) for k in (1, 2, 3, 4, 5))
            sig += 0.15 * sps.sosfilt(hp3k, rng.standard_normal(m)) * np.exp(-tt / 0.02)
            place(vocal, int(t * sr), (sig * _adsr(m, int(0.008 * sr), 0.12 * sr) * 0.45).astype(np.float32))
            onsets.append(t * 1000.0)

    mix = drums + harm + vocal
    mix /= max(1e-9, np.abs(mix).max()) / 0.9
    vocal /= max(1e-9, np.abs(vocal).max()) / 0.9
    return mix.astype(np.float32), vocal.astype(np.float32), np.array(sorted(onsets))


def remaster(x: np.ndarray, sr: int = SR, seed: int = 1) -> np.ndarray:
    """模拟"另一份母带"：不同 EQ + 压缩 + 软削波 + 底噪。算法必须对这些免疫。"""
    rng = np.random.default_rng(seed)
    low = sps.sosfilt(sps.butter(2, 180, "lp", fs=sr, output="sos"), x)
    high = sps.sosfilt(sps.butter(2, 4500, "hp", fs=sr, output="sos"), x)
    y = x + 0.8 * low - 0.5 * high  # 低频抬 ~5dB、高频削 ~3dB
    env = np.abs(sps.sosfilt(sps.butter(1, 20, "lp", fs=sr, output="sos"), np.abs(y))) + 1e-6
    thr = 0.125
    y = y * np.where(env > thr, (thr / env) ** 0.75, 1.0)  # 4:1 包络压缩
    y = np.tanh(1.6 * y) / 1.6
    y = y + rng.standard_normal(len(y)) * 0.002  # ≈ -54dBFS 底噪
    return (y / max(1e-9, np.abs(y).max()) * 0.85).astype(np.float32)


def shift(x: np.ndarray, ms: float, sr: int = SR) -> np.ndarray:
    """整体平移：正数 = 头部补静音（目标比参照晚）；负数 = 砍掉开头。"""
    n = int(round(ms / 1000.0 * sr))
    if n >= 0:
        return np.concatenate([np.zeros(n, dtype=np.float32), x])
    return x[-n:].copy()


def rate_change(x: np.ndarray, factor: float) -> np.ndarray:
    """线性时基拉伸（磁带变速式，音高同步变化），输出时长 = 输入 × factor。"""
    return sps.resample_poly(x, int(round(factor * 10000)), 10000).astype(np.float32)


def splice(x: np.ndarray, at_s: float, insert_s: float, sr: int = SR) -> np.ndarray:
    """在 at_s 处插入额外内容（正）或剪掉一段（负），制造非线性错位。"""
    p = int(at_s * sr)
    if insert_s >= 0:
        m = int(insert_s * sr)
        src = x[p: p + m] * 0.6  # 插入"另一段间奏"，比纯静音更像真实剪辑
        if len(src) < m:
            src = np.pad(src, (0, m - len(src)))
        return np.concatenate([x[:p], src.astype(np.float32), x[p:]])
    m = int(-insert_s * sr)
    return np.concatenate([x[:p], x[p + m:]])


# ---------------------------------------------------------------------------
# QRC 解析（只取逐字起点，够重锚定用）
# ---------------------------------------------------------------------------

_META_RE = re.compile(r"^(词|曲|编曲|制作人|作詞|作曲|編曲|.*\s-\s.*)")


def parse_qrc_word_onsets(path: Path) -> tuple[np.ndarray, list[tuple[int, int, str]]]:
    """从解密后的 QRC XML 里取出逐字起点（毫秒）与行信息。

    注意 CLAUDE.md §6.1 的两个坑：`(t,d)` 的第二个数是 **duration 不是 end**；
    正文开头几行是带正常时间戳的制作名单，必须剥离，否则会把片头文字当人声锚点。
    """
    txt = path.read_text(encoding="utf-8")
    m = re.search(r'LyricContent="(.*)"', txt, re.DOTALL)
    if not m:
        msg = f"{path} 里找不到 LyricContent"
        raise ValueError(msg)
    content = html.unescape(m.group(1))
    onsets: list[float] = []
    lines: list[tuple[int, int, str]] = []
    for raw in content.split("\n"):
        lm = re.match(r"^\[(\d+),(\d+)\](.*)$", raw)
        if not lm:
            continue
        start, dur, body = int(lm.group(1)), int(lm.group(2)), lm.group(3)
        text = re.sub(r"\(\d+,\d+\)", "", body)
        if _META_RE.match(text.strip()):
            continue
        toks = [(int(a), int(b)) for a, b in re.findall(r"\((\d+),(\d+)\)", body)]
        onsets.extend(float(a) for a, b in toks if b > 0)  # 时长 0 的是分隔占位，不是发音
        lines.append((start, dur, text))
    return np.array(sorted(onsets)), lines


# ---------------------------------------------------------------------------
# 验证用例
# ---------------------------------------------------------------------------


def _fmt(v, unit: str = "") -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "-"
    return f"{v:.1f}{unit}"


def run_synthetic(duration_s: float = 200.0) -> dict:
    print("=" * 104)
    print("第一部分：合成信号验证（真值精确已知）")
    print("=" * 104)
    t0 = time.time()
    mix, vocal, onsets = synth_song(duration_s=duration_s, seed=7)
    env_ref = onset_envelope(mix)
    print(f"合成 {len(mix) / SR:.1f}s，人声音节 {len(onsets)} 个；"
          f"onset 包络 {len(env_ref)} 帧 @ {HOP_MS:.1f}ms（{SR / HOP:.0f}Hz），"
          f"耗时 {time.time() - t0:.1f}s\n")

    res: dict = {}

    # --- 组1：纯偏移，精度上限 ---
    print("-" * 104)
    print("[组1] 纯偏移注入（目标 = 参照 + 偏移，无其他劣化）—— 精度上限")
    print(f"{'注入(ms)':>12}{'恢复(ms)':>12}{'误差(ms)':>11}{'峰值':>8}{'次峰比':>8}"
          f"{'峰宽(ms)':>10}{'重叠(s)':>9}  判定")
    g1 = []
    for inj in (-8500.0, -3457.0, -1000.0, -137.0, 0.0, 137.0, 501.0, 2003.0, 8500.0, 20000.0):
        est = estimate_offset(env_ref, onset_envelope(shift(mix, inj)))
        err = est.offset_ms - inj
        g1.append({"injected_ms": inj, "recovered_ms": est.offset_ms, "error_ms": err,
                   "peak": est.peak, "peak_ratio": est.peak_ratio, "width_ms": est.width_ms})
        print(f"{inj:>12.1f}{est.offset_ms:>12.2f}{err:>+11.2f}{est.peak:>8.3f}"
              f"{est.peak_ratio:>8.3f}{est.width_ms:>10.1f}{est.overlap_s:>9.1f}  "
              f"{'可用' if est.reliable else '不可靠'}")
    e = [abs(r["error_ms"]) for r in g1]
    print(f"→ 纯偏移绝对误差：中位 {np.median(e):.2f}ms，最大 {max(e):.2f}ms"
          f"（帧长 {HOP_MS:.1f}ms，抛物线插值把精度压到亚帧）")
    res["offset_only"] = g1

    # --- 组2：场景裁决 ---
    print()
    print("-" * 104)
    print("[组2] 场景裁决（含另一份母带的 EQ/压缩/底噪劣化）")
    cases: list[dict] = []

    def add(name: str, tgt: np.ndarray, truth_off: float, truth_ppm: float,
            expect: str, extra: str = "") -> Verdict:
        v = diagnose(env_ref, onset_envelope(tgt))
        cases.append({"name": name, "expect": expect, "verdict": v.kind,
                      "truth_offset_ms": truth_off, "got_offset_ms": v.global_offset_ms,
                      "truth_drift_ppm": truth_ppm, "got_drift_ppm": v.drift_ppm,
                      "resid_p50_ms": v.resid_p50_ms, "resid_p90_ms": v.resid_p90_ms,
                      "resid_max_ms": v.resid_max_ms, "breakpoint_ms": v.breakpoint_ms,
                      "step_ms": v.step_ms,
                      "peak": v.global_est.peak if v.global_est else 0.0,
                      "peak_ratio": v.global_est.peak_ratio if v.global_est else 1.0,
                      "n_seg": f"{v.n_seg_used}/{v.n_seg_total}", "extra": extra,
                      "notes": v.notes})
        return v

    add("纯偏移 +1200ms", shift(mix, 1200.0), 1200.0, 0.0, "constant")
    add("偏移 +1200ms + 另一份母带", shift(remaster(mix), 1200.0), 1200.0, 0.0, "constant")
    add("偏移 -2500ms + 另一份母带", shift(remaster(mix, seed=3), -2500.0), -2500.0, 0.0, "constant")
    add("偏移 +18000ms（长片头）+ 母带差异", shift(remaster(mix), 18000.0), 18000.0, 0.0, "constant")
    for factor, tag in ((1.0002, "200ppm"), (1.001, "1000ppm"), (1.005, "5000ppm")):
        total = (factor - 1) * duration_s * 1000
        expect = "linear" if abs(total) > TOL_GOOD_MS else "constant"
        if factor >= 1.004:  # 0.4% 以上的速率差超出本方法的自动处理范围，只能降级人工
            expect = "needs_manual"
        add(f"线性拉伸 {tag} + 偏移 800ms", shift(rate_change(remaster(mix), factor), 800.0),
            800.0, (factor - 1) * 1e6, expect, extra=f"真值漂移累计 {total:+.0f}ms")
    for at_s, ins_s in ((110.0, 6.0), (95.0, -4.0), (120.0, 0.35)):
        add(f"分段错位：{at_s:.0f}s 处 {ins_s:+.2f}s", shift(splice(remaster(mix), at_s, ins_s), 700.0),
            700.0, 0.0, "piecewise", extra=f"真值断点 {at_s:.0f}s，台阶 {ins_s * 1000:+.0f}ms")
    other, _, _ = synth_song(duration_s=duration_s, bpm=132.0, seed=99)
    add("负对照：不相关的另一首曲子", other, math.nan, math.nan, "no_match")
    add("负对照：目标只有 12s（重叠不足）", mix[: 12 * SR], math.nan, math.nan, "no_match")
    add("负对照：目标是白噪声", (np.random.default_rng(5).standard_normal(len(mix)) * 0.3).astype(np.float32),
        math.nan, math.nan, "no_match")

    hdr = (f"{'用例':<40}{'期望':<14}{'裁决':<14}{'offset':>10}{'真值':>10}{'ppm':>8}"
           f"{'p50残差':>9}{'p90残差':>9}{'峰值':>7}{'次峰比':>7}{'有效段':>8}")
    print(hdr)
    print("-" * 104)
    n_pass = 0
    for c in cases:
        ok = c["verdict"] == c["expect"]
        n_pass += ok
        print(f"{c['name']:<40}{c['expect']:<14}{c['verdict']:<14}"
              f"{c['got_offset_ms']:>10.1f}{_fmt(c['truth_offset_ms']):>10}"
              f"{c['got_drift_ppm']:>8.0f}{_fmt(c['resid_p50_ms']):>9}{_fmt(c['resid_p90_ms']):>9}"
              f"{c['peak']:>7.3f}{c['peak_ratio']:>7.3f}{c['n_seg']:>8}  {'OK' if ok else '判错'}")
    print(f"\n裁决正确率：{n_pass}/{len(cases)}")
    for c in cases:
        if c["extra"] or c["breakpoint_ms"] is not None:
            bp = f"，检出断点 {c['breakpoint_ms'] / 1000:.1f}s" if c["breakpoint_ms"] else ""
            st = f"，台阶 {c['step_ms']:+.0f}ms" if c["step_ms"] is not None else ""
            print(f"  · {c['name']}：{c['extra']}{bp}{st}")
    res["cases"] = cases
    res["pass"], res["total"] = n_pass, len(cases)

    # --- 组3：分段错位检出阈值扫描 ---
    print()
    print("-" * 104)
    print("[组3] 分段错位检出阈值扫描（在 110s 处插入不同长度，看多小的台阶还能检出）")
    print(f"{'注入台阶(ms)':>14}{'裁决':>15}{'检出台阶(ms)':>14}{'断点(s)':>10}"
          f"{'p90残差':>10}{'max残差':>10}")
    sweep = []
    for ins_ms in (10, 20, 40, 80, 160, 320, 1000, 3000):
        tgt = shift(splice(remaster(mix), 110.0, ins_ms / 1000.0), 700.0)
        v = diagnose(env_ref, onset_envelope(tgt))
        sweep.append({"injected_step_ms": ins_ms, "verdict": v.kind, "step_ms": v.step_ms,
                      "breakpoint_ms": v.breakpoint_ms, "resid_p90_ms": v.resid_p90_ms,
                      "resid_max_ms": v.resid_max_ms})
        print(f"{ins_ms:>14d}{v.kind:>15}{_fmt(v.step_ms):>14}"
              f"{_fmt(v.breakpoint_ms / 1000 if v.breakpoint_ms else None):>10}"
              f"{_fmt(v.resid_p90_ms):>10}{_fmt(v.resid_max_ms):>10}")
    res["step_sweep"] = sweep

    # --- 组4：模式 B ---
    print()
    print("-" * 104)
    print("[组4] 模式 B：歌词逐字起点脉冲串 ↔ 音频 onset 包络（无参照录音时的唯一出路）")
    print(f"{'注入(ms)':>12}{'目标轨':>12}{'恢复(ms)':>12}{'误差(ms)':>11}{'峰值':>8}{'次峰比':>8}  判定")
    mode_b = []
    for inj in (-1500.0, 137.0, 1200.0, 4000.0, 18000.0):
        for tag, base in (("整轨混音", mix), ("分离后人声", vocal)):
            env_t = onset_envelope(shift(remaster(base, seed=5), inj))
            env_l = impulse_envelope(onsets, len(env_t))
            est = estimate_offset(env_l, env_t, peak_min=PEAK_MIN_MODE_B)
            err = est.offset_ms - inj
            mode_b.append({"injected_ms": inj, "track": tag, "recovered_ms": est.offset_ms,
                           "error_ms": err, "peak": est.peak, "peak_ratio": est.peak_ratio,
                           "reliable": est.reliable})
            print(f"{inj:>12.1f}{tag:>12}{est.offset_ms:>12.1f}{err:>+11.1f}"
                  f"{est.peak:>8.3f}{est.peak_ratio:>8.3f}  {'可用' if est.reliable else '不可靠'}")
    for tag in ("整轨混音", "分离后人声"):
        e = [abs(r["error_ms"]) for r in mode_b if r["track"] == tag]
        p = [r["peak"] for r in mode_b if r["track"] == tag]
        print(f"→ {tag}：绝对误差 中位 {np.median(e):.1f}ms / 最大 {max(e):.1f}ms，"
              f"峰值中位 {np.median(p):.3f}")
    res["mode_b"] = mode_b

    # --- 组5：hop 对精度与成本的影响 ---
    print()
    print("-" * 104)
    print("[组5] 包络跳距 hop 对精度/成本的影响（注入 137ms + 母带差异）")
    print(f"{'hop(ms)':>10}{'恢复(ms)':>12}{'误差(ms)':>11}{'包络帧数':>10}{'耗时(s)':>9}")
    hop_res = []
    tgt = shift(remaster(mix), 137.0)
    for hop in (512, 256, 128, 64, 32):
        t1 = time.time()
        er, et = onset_envelope(mix, hop=hop), onset_envelope(tgt, hop=hop)
        max_lag = int(round(MAX_LAG_S * SR / hop))
        min_ov = max(int(MIN_OVERLAP_S * SR / hop), int(MIN_OVERLAP_FRAC * min(len(er), len(et))))
        lags, y = ncc(er, et, -max_lag, max_lag, min_ov)
        k = int(np.argmax(np.where(np.isfinite(y), y, -np.inf)))
        off = (lags[k] + _parabolic(y, k)) * hop / SR * 1000.0
        dt = time.time() - t1
        hop_res.append({"hop": hop, "hop_ms": hop / SR * 1000, "recovered_ms": off,
                        "error_ms": off - 137.0, "frames": len(er), "sec": dt})
        print(f"{hop / SR * 1000:>10.1f}{off:>12.2f}{off - 137.0:>+11.2f}{len(er):>10d}{dt:>9.2f}")
    res["hop_sweep"] = hop_res
    return res


def run_real() -> dict:
    """真实素材验证：sumika「赤春花 (feat. 幾田りら)」。

    三方闭环：offset(QRC→MV) 应当 = offset(QRC→Art) + offset(Art→MV)。
    这个恒等式给了一个**不依赖任何人工标注**的真值检验 ——
    三条测量各自独立，闭合误差就是整套方法的实测精度。
    """
    mv_path = WORKSPACE / "media" / "audio_16k_mono.wav"
    art_path = WORKSPACE / "reanchor" / "arttrack_PZ3CB2vmGYo.wav"
    qrc_path = WORKSPACE / "qrc" / "lyric_decrypted.xml"

    print("=" * 104)
    print("第二部分：真实素材验证 —— sumika「赤春花 (feat. 幾田りら)」")
    print("=" * 104)
    missing = [str(p.relative_to(ROOT)) for p in (mv_path, art_path, qrc_path) if not p.exists()]
    if missing:
        print(f"跳过：缺少素材 {missing}")
        return {"skipped": missing}

    mv = load_audio(mv_path)
    art = load_audio(art_path)
    onsets, lines = parse_qrc_word_onsets(qrc_path)
    print(f"MV 音轨    : {len(mv) / SR:.2f}s  ({mv_path.name})")
    print(f"Art Track  : {len(art) / SR:.2f}s  ({art_path.name})  —— 视为母带侧参照")
    print(f"QRC        : {len(lines)} 行有效歌词，{len(onsets)} 个逐字起点，"
          f"跨度 {onsets.min() / 1000:.2f}s ~ {onsets.max() / 1000:.2f}s")
    print(f"时长差     : MV − Art = {(len(mv) - len(art)) / SR:+.2f}s\n")

    env_mv, env_art = onset_envelope(mv), onset_envelope(art)
    out: dict = {"mv_dur_s": len(mv) / SR, "art_dur_s": len(art) / SR,
                 "qrc_words": len(onsets), "qrc_lines": len(lines)}

    print("-" * 104)
    print("[实测 A] Art Track → MV（模式 A，音频↔音频）")
    v_am = diagnose(env_art, env_mv)
    _print_verdict(v_am)
    out["art_to_mv"] = asdict(v_am)
    knots = build_warp_map(v_am)
    print(f"  warp 折点数: {len(knots)}（前 3 个：{[(round(a), round(b)) for a, b in knots[:3]]}）")

    print()
    print("-" * 104)
    print("[实测 B] QRC 时间轴 → Art Track（模式 B 的自检：QRC 本就打在母带上，应≈0）")
    env_l_art = impulse_envelope(onsets, len(env_art))
    v_qa = diagnose(env_l_art, env_art, peak_min=PEAK_MIN_MODE_B, peak_min_seg=0.10,
                    seg_search_s=2.0)
    _print_verdict(v_qa)
    out["qrc_to_art"] = asdict(v_qa)

    print()
    print("-" * 104)
    print("[实测 C] QRC 时间轴 → MV 音轨（模式 B，生产链路真正要做的事）")
    env_l_mv = impulse_envelope(onsets, len(env_mv))
    v_qm = diagnose(env_l_mv, env_mv, peak_min=PEAK_MIN_MODE_B, peak_min_seg=0.10,
                    seg_search_s=2.0)
    _print_verdict(v_qm)
    out["qrc_to_mv"] = asdict(v_qm)

    print()
    print("-" * 104)
    print("[实测 D] 模式 B2：歌词行「有词/无词」方波 ↔ 音频人声活动曲线（粗锚点兜底）")
    for tag, wav in (("Art Track", art), ("MV", mv)):
        vac = voice_activity_curve(wav)
        lac = lyric_activity_curve(lines, len(vac))
        est = estimate_offset(lac, vac, peak_min=0.10)
        print(f"  QRC → {tag:<10}: offset {est.offset_ms:+9.1f}ms   峰值 {est.peak:.3f}   "
              f"次峰比 {est.peak_ratio:.3f}   峰宽 {est.width_ms:.0f}ms   "
              f"{'可用' if est.reliable else '不可靠'}")
        out[f"mode_b2_{tag}"] = asdict(est)

    closure = v_qm.global_offset_ms - (v_qa.global_offset_ms + v_am.global_offset_ms)
    print()
    print("-" * 104)
    print("[闭环校验] offset(QRC→MV) − [offset(QRC→Art) + offset(Art→MV)]")
    print(f"  {v_qm.global_offset_ms:.1f} − ({v_qa.global_offset_ms:.1f} + "
          f"{v_am.global_offset_ms:.1f}) = {closure:+.1f} ms")
    print(f"  → 闭合误差 {abs(closure):.1f}ms。三条测量彼此独立，闭合误差即整套方法在"
          f"真实素材上的实测一致性。")
    out["closure_error_ms"] = float(closure)

    # 用 A 的结果把 QRC 时间轴映射到 MV，看首句落点是否合理
    off = v_am.global_offset_ms + v_qa.global_offset_ms
    print(f"  → 推荐重锚定：把 QRC 全部时间 {off:+.0f}ms 后贴到 MV；"
          f"首个发音字 {onsets.min():.0f}ms → MV {onsets.min() + off:.0f}ms "
          f"（{(onsets.min() + off) / 1000:.2f}s）")
    out["recommended_offset_ms"] = float(off)

    print()
    print("-" * 104)
    print("[实测 E] 失败判据候选评估：峰值 z 分数能不能替代峰值高度？（结论：不能，已否决）")
    rng = np.random.default_rng(0)
    probes = [
        ("模式A 正例 Art→MV", env_art, env_mv),
        ("模式B 正例 QRC→MV", impulse_envelope(onsets, len(env_mv)), env_mv),
        ("负对照 随机时间点→MV",
         impulse_envelope(np.sort(rng.uniform(0, float(onsets.max()), len(onsets))), len(env_mv)),
         env_mv),
        ("负对照 QRC→白噪声", impulse_envelope(onsets, len(env_mv)),
         onset_envelope(rng.standard_normal(len(mv)).astype(np.float32) * 0.3)),
    ]
    zs = {}
    for name, a, b in probes:
        ml = int(MAX_LAG_S * SR / HOP)
        mo = max(int(MIN_OVERLAP_S * SR / HOP), int(MIN_OVERLAP_FRAC * min(len(a), len(b))))
        lags, y = ncc(a, b, -ml, ml, mo)
        f = np.isfinite(y)
        yy, lg = y[f], lags[f]
        k = int(np.argmax(yy))
        bg = yy[np.abs(lg - lg[k]) > int(SR / HOP)]
        z = float((yy[k] - np.median(bg)) / bg.std())
        zs[name] = {"peak": float(yy[k]), "z": z, "offset_ms": float(lg[k] * HOP_MS)}
        print(f"  {name:<24}: 峰值 {yy[k]:.3f}   z {z:5.1f}   offset {lg[k] * HOP_MS:+9.1f}ms")
    print("  → 正例 z 与负对照 z 重叠（音乐的自相似让 lag 背景分布重尾），z 不可用；"
          "峰值高度仍是模式 A 唯一有效的匹配判据。")
    out["z_stat_probe"] = zs

    out.update(run_codec_timebase_probe())
    return out


def run_codec_timebase_probe() -> dict:
    """时间基准探针：同一个 YouTube 视频的不同音频 format 是否给出同一个时间原点。

    CLAUDE.md §6.2 把"时间基准问题"列为未调研且会咬人的一项。
    这里直接量：把同一视频的 opus(251) 与 aac(140) 两条流各自解码后互相关。
    若结果不是 0，说明**重锚定算出的 offset 只对某一条特定音频流成立**，
    换个 format 下载就会整体偏 —— 那么下载/分离/烧录三处必须锁同一条流。
    """
    d = WORKSPACE / "reanchor"
    pairs = {
        "MV: opus(251) → aac(140)": (d / "mv_opus.webm", d / "mv_aac.m4a"),
        "Art: opus(251) → aac(140)": (d / "art_opus.webm", d / "art_aac.m4a"),
        "MV: opus(251) → 合并出的 mkv": (d / "mv_opus.webm", WORKSPACE / "media" / "audio_16k_mono.wav"),
    }
    avail = {k: v for k, v in pairs.items() if v[0].exists() and v[1].exists()}
    if not avail:
        return {"codec_probe": "跳过：缺少 opus/aac 双份下载"}
    print()
    print("-" * 104)
    print("[实测 F] 时间基准探针：同一视频的不同音频 format 是否同原点")
    res = {}
    for name, (p, q) in avail.items():
        est = estimate_offset(onset_envelope(load_audio(p)), onset_envelope(load_audio(q)))
        print(f"  {name:<34}: offset {est.offset_ms:+8.2f}ms   峰值 {est.peak:.3f}")
        res[name] = {"offset_ms": est.offset_ms, "peak": est.peak}
    return {"codec_probe": res}


def _print_verdict(v: Verdict) -> None:
    g = v.global_est
    print(f"  裁决        : {v.kind}")
    print(f"  全局 offset : {v.global_offset_ms:+.1f} ms  （拟合 a={v.fit_a_ms:+.1f}ms, "
          f"b={v.drift_ppm:.0f}ppm，全曲累计 {v.drift_total_ms:+.1f}ms）")
    if g:
        print(f"  峰值/次峰比 : {g.peak:.3f} / {g.peak_ratio:.3f}   峰宽 {g.width_ms:.1f}ms   "
              f"重叠 {g.overlap_s:.1f}s")
        print("  候选 offset : " + "、".join(f"{o:+.0f}ms({c:.3f})" for o, c in g.candidates))
    print(f"  分段残差    : p50 {_fmt(v.resid_p50_ms)} / p90 {_fmt(v.resid_p90_ms)} / "
          f"max {_fmt(v.resid_max_ms)} ms   有效段 {v.n_seg_used}/{v.n_seg_total}")
    if v.segments:
        s = [x for x in v.segments if x.reliable]
        if s:
            print("  分段 offset : " + " ".join(f"{x.offset_ms:.0f}" for x in s[:14])
                  + (" ..." if len(s) > 14 else ""))
    for n in v.notes:
        print(f"  · {n}")


def main() -> int:
    ap = argparse.ArgumentParser(description="P0-4 重锚定算法验证")
    ap.add_argument("--ref", help="参照音频（歌词时间轴所对应的录音）")
    ap.add_argument("--tgt", help="目标音频（YouTube MV 音轨）")
    ap.add_argument("--duration", type=float, default=200.0, help="合成信号时长（秒）")
    ap.add_argument("--skip-synthetic", action="store_true")
    ap.add_argument("--skip-real", action="store_true")
    args = ap.parse_args()

    report: dict = {"config": {k: v for k, v in globals().items()
                               if k.isupper() and isinstance(v, (int, float, str))}}
    t0 = time.time()
    if args.ref and args.tgt:
        print(f"自定义素材：{args.ref} → {args.tgt}")
        v = diagnose(onset_envelope(load_audio(args.ref)), onset_envelope(load_audio(args.tgt)))
        _print_verdict(v)
        report["custom"] = asdict(v)
    else:
        if not args.skip_synthetic:
            report["synthetic"] = run_synthetic(args.duration)
        print()
        if not args.skip_real:
            report["real"] = run_real()

    WORKSPACE.mkdir(exist_ok=True)
    out = WORKSPACE / "reanchor" / "reanchor_xcorr_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"\n总耗时 {time.time() - t0:.1f}s，报告写入 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
