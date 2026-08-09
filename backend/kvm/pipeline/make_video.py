"""端到端出片：QRC 工程 → ASS → 烧录成品。

用法见 CLAUDE.md §11。第一版走"QRC 现成逐字轴"路线，不跑强制对齐。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1].parent))

from kvm.media.ffmpeg import find_ffmpeg_with_libass
from kvm.models.karaoke import VoicePalette
from kvm.pipeline.guide_melody import TIMBRES, GuideConfig  # 只取配置与常量，不触发 librosa
from kvm.pipeline.qrc_import import load_project
from kvm.render.ass_builder import AssBuilder
from kvm.render.text_metrics import LibassMetrics


def _find_ffmpeg() -> str:
    """探测判据：以 ass 滤镜是否注册为准，而非版本号（见 `kvm.media.ffmpeg`）。"""
    return find_ffmpeg_with_libass()


def probe_video(ffmpeg: str, path: Path) -> dict:
    """探测分辨率与时长。ffprobe 与 ffmpeg 同目录。"""
    ffprobe = str(Path(ffmpeg).with_name("ffprobe"))
    cmd = [
        ffprobe, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate:format=duration,start_time",
        "-of", "json", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        msg = f"ffprobe 失败：{out.stderr[:400]}"
        raise RuntimeError(msg)
    d = json.loads(out.stdout)
    st = d.get("streams", [{}])[0]
    fmt = d.get("format", {})
    return {
        "width": int(st.get("width", 1920)),
        "height": int(st.get("height", 1080)),
        "fps": st.get("r_frame_rate", "0/1"),
        "duration": float(fmt.get("duration", 0.0)),
        "start_time": float(fmt.get("start_time", 0.0)),
    }


def burn(
    ffmpeg: str,
    video: Path,
    ass: Path,
    out: Path,
    *,
    audio: Path | None = None,
    start_s: float | None = None,
    duration_s: float | None = None,
    crf: int = 18,
) -> None:
    """把 ASS 烧进视频。

    字幕滤镜路径需转义（Windows 盘符的冒号、以及滤镜图的分隔符）。
    音轨可替换为分离出的伴奏以产出 OFF VOCAL 版本。
    """
    esc = str(ass).replace("\\", "/").replace(":", r"\:")
    cmd = [ffmpeg, "-hide_banner", "-y", "-i", str(video)]
    if audio is not None:
        cmd += ["-i", str(audio)]
    # `-ss` 必须放在输入之后（output seek）。放在 `-i` 之前是 input seek，
    # 会把时间戳重置为 0，而 ASS 的事件时间是绝对的 —— 字幕会整体错位到片头。
    # output seek 需要解码到起点，稍慢，但预览片段的字幕才是对的。
    if start_s is not None:
        cmd += ["-ss", f"{start_s}"]
    if duration_s is not None:
        cmd += ["-t", f"{duration_s}"]
    cmd += [
        "-vf", f"ass={esc}",
        "-c:v", "libx264", "-crf", str(crf), "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
    ]
    if audio is not None:
        cmd += ["-map", "0:v:0", "-map", "1:a:0"]
    else:
        cmd += ["-map", "0:v:0", "-map", "0:a:0"]
    cmd += [str(out)]

    proc = subprocess.run(cmd, capture_output=True, timeout=3600)
    if proc.returncode != 0:
        msg = f"烧录失败：{proc.stderr.decode(errors='replace')[-1500:]}"
        raise RuntimeError(msg)


def _extract_audio(ffmpeg: str, video: Path, out: Path) -> Path:
    """从视频抽出音轨。

    注意 ffmpeg 默认会**静默吃掉容器起始偏移**：若 start_time 非零，
    抽出的 wav 的 0 时刻等于容器的 start_time 时刻，整轨会短一截。
    本项目的素材实测 start_time=0，但换源时必须重新核算。
    """
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video), "-vn", "-c:a", "pcm_s16le", str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=1800)
    if proc.returncode != 0:
        msg = f"抽取音轨失败：{proc.stderr.decode(errors='replace')[-600:]}"
        raise RuntimeError(msg)
    return out


def _mix_audio(ffmpeg: str, base: Path, overlay: Path, out: Path) -> Path:
    """把引导声叠加到伴奏上。

    `amix` 必须带 `normalize=0`：默认会按输入数量做平均，
    伴奏音量会被直接砍半，听起来像是引导声"压过"了伴奏。
    """
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(base), "-i", str(overlay),
        "-filter_complex", "amix=inputs=2:normalize=0:duration=first",
        "-c:a", "pcm_s16le", str(out),
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=1800)
    if proc.returncode != 0:
        msg = f"混音失败：{proc.stderr.decode(errors='replace')[-600:]}"
        raise RuntimeError(msg)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="QRC → ASS → 成品视频")
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--parsed", type=Path, required=True, help="qrc_parsed.json")
    ap.add_argument("--kana", type=Path, required=True, help="kana_entries.json")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--ass-out", type=Path, default=None)
    ap.add_argument("--audio", type=Path, default=None, help="替换音轨（OFF VOCAL）")
    ap.add_argument(
        "--offset-ms", type=int, default=62,
        help="全局偏移。歌词源轴对准商业录音，MV 音轨与之有偏差；"
             "赤春花实测 Art→MV 为 +62ms",
    )
    ap.add_argument("--font", default="Noto Sans CJK JP")
    ap.add_argument("--font-size", type=int, default=0, help="0 表示按分辨率自动")
    ap.add_argument(
        "--drums", type=Path, default=None,
        help="鼓组 stem，用于节拍检测（引导点踩拍）。缺省则用 --audio 或视频音轨",
    )
    ap.add_argument(
        "--guide-vocals", type=Path, default=None,
        help="人声 stem。给出后会合成引导声（ガイドメロディ）并混入 --audio",
    )
    # 引导声参数全部走 CLI：合适的阈值与音色因曲速、唱法而异，写死常量等于逼人改代码
    guide_defaults = GuideConfig()
    ap.add_argument(
        "--guide-gain", type=float, default=guide_defaults.gain,
        help=f"引导声音量（RMS 口径，默认 {guide_defaults.gain}，约低于伴奏 5dB）",
    )
    ap.add_argument(
        "--guide-timbre", choices=TIMBRES, default=guide_defaults.timbre,
        help="引导声音色。square 穿透力最好、最接近卡拉OK 引导音；sine 最不抢原曲",
    )
    ap.add_argument(
        "--guide-max-harmonics", type=int, default=guide_defaults.max_harmonics,
        help="谐波数上限（实际还会按奈奎斯特再截断防混叠）。越大越亮",
    )
    ap.add_argument(
        "--guide-no-quantize", action="store_true",
        help="不把音高吸附到半音格。关掉量化会退回照搬实测 f0 的旧行为，听感偏人声",
    )
    ap.add_argument(
        "--guide-legato-ms", type=float, default=guide_defaults.legato_gap_s * 1000,
        help="短于此的音符间隙做 legato 桥接（辅音/换气），更长的才算真正的休止",
    )
    ap.add_argument(
        "--guide-min-note-ms", type=float, default=guide_defaults.min_note_s * 1000,
        help="短于此的音符并入音高最接近的邻居（滑音碎片），而不是丢弃",
    )
    ap.add_argument("--no-beat", action="store_true", help="跳过节拍检测")
    ap.add_argument("--start", type=float, default=None, help="截取起点秒（用于试渲染）")
    ap.add_argument("--duration", type=float, default=None, help="截取时长秒")
    ap.add_argument("--ass-only", action="store_true", help="只生成 ASS，不烧录")
    args = ap.parse_args()

    ffmpeg = _find_ffmpeg()
    info = probe_video(ffmpeg, args.video)
    print(f"ffmpeg   : {ffmpeg}")
    print(f"视频     : {info['width']}x{info['height']}  "
          f"{info['duration']:.3f}s  start_time={info['start_time']}")
    if abs(info["start_time"]) > 1e-6:
        print(f"⚠️ 容器起始 PTS 非零（{info['start_time']}s），ASS 绝对时间需核算")

    proj = load_project(
        args.parsed, args.kana,
        video_width=info["width"], video_height=info["height"],
        global_offset_ms=args.offset_ms,
    )
    st = proj.style
    st.font_name = args.font
    st.font_size = args.font_size or max(36, int(info["height"] * 0.075))
    # 描边/阴影按字号自适应：固定 3px 在 4K 下细到几乎看不见，
    # 而卡拉OK 字幕要压在任意画面上都清晰可读，粗描边是刚需
    st.bold = True
    st.outline = round(st.font_size * 0.055, 1)
    st.shadow = round(st.font_size * 0.022, 1)
    st.margin_h = int(info["width"] * 0.045)
    st.margin_v = int(info["height"] * 0.055)
    st.line_gap = int(st.font_size * 0.18)

    # nicokara 经典配色：未唱白底黑边，已唱亮蓝。ASS 是 &HAABBGGRR（BGR 序）
    proj.palettes = {
        "main": VoicePalette(
            name="main",
            unsung_fill="&H00FFFFFF&", unsung_outline="&H00202020&",
            sung_fill="&H00FF9010&", sung_outline="&H00501800&",
        )
    }

    body = [ln for ln in proj.lines if not ln.is_metadata and ln.tokens]
    meta_n = sum(1 for ln in proj.lines if ln.is_metadata)
    ruby_n = sum(len(ln.ruby) for ln in body)
    print(f"歌词     : {len(proj.lines)} 行（剥离制作名单 {meta_n} 行，正文 {len(body)} 行）")
    print(f"注音     : {ruby_n} 段")
    print(f"字号     : {proj.style.font_size}px   偏移 {args.offset_ms:+d}ms")

    if not args.no_beat:
        from kvm.pipeline.beat_detect import detect_beats

        beat_src = args.audio or args.video
        grid = detect_beats(beat_src, drums_path=args.drums)
        if grid is not None:
            proj.beat_grid = grid
            src_name = "drums stem" if args.drums else beat_src.name
            print(f"节拍     : {grid.bpm:.1f} BPM，{len(grid.beats_ms)} 拍（源：{src_name}）")
        else:
            print("节拍     : 检测失败，引导点回退固定间隔")

    metrics = LibassMetrics(ffmpeg)
    print("度量中…（向 libass 实际渲染反推 advance）")
    ass_text = AssBuilder(proj, metrics).build()

    ass_path = args.ass_out or args.out.with_suffix(".ass")
    ass_path.parent.mkdir(parents=True, exist_ok=True)
    ass_path.write_text(ass_text, encoding="utf-8")
    n_events = ass_text.count("Dialogue:")
    print(f"ASS      : {ass_path}  （{n_events} 个 Dialogue 事件）")

    if args.ass_only:
        return 0

    audio_track = args.audio
    if args.guide_vocals:
        from kvm.pipeline.guide_melody import build_guide_track

        guide_cfg = GuideConfig(
            quantize=not args.guide_no_quantize,
            min_note_s=args.guide_min_note_ms / 1000.0,
            legato_gap_s=args.guide_legato_ms / 1000.0,
            timbre=args.guide_timbre,
            max_harmonics=args.guide_max_harmonics,
            gain=args.guide_gain,
        )
        guide_path = args.out.with_name("guide_melody.wav")
        print("合成引导声…（pYIN 提取音高，耗时约为曲长的 1/7）")
        n_notes = build_guide_track(
            args.guide_vocals, guide_path, info["duration"], config=guide_cfg
        )
        q = "半音量化" if guide_cfg.quantize else "不量化"
        print(f"引导声   : {n_notes} 个音符  {guide_cfg.timbre}/{q} → {guide_path.name}")
        if audio_track is None:
            print("⚠️ 未指定 --audio，引导声将叠加在原始音轨上（通常应配合伴奏使用）")
            audio_track = _extract_audio(ffmpeg, args.video, args.out.with_name("src_audio.wav"))
        mixed = args.out.with_name("audio_with_guide.wav")
        _mix_audio(ffmpeg, audio_track, guide_path, mixed)
        audio_track = mixed

    args.out.parent.mkdir(parents=True, exist_ok=True)
    print("烧录中…")
    burn(
        ffmpeg, args.video, ass_path, args.out,
        audio=audio_track, start_s=args.start, duration_s=args.duration,
    )
    size_mb = args.out.stat().st_size / 1024 / 1024
    print(f"完成     : {args.out}  ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
