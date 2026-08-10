"""把解密解析后的 QRC 导入为 KaraokeProject。

输入是 `experiments/qrc_decrypt.py` 的产物：

- `qrc_parsed.json`：逐字时间轴（meta + lines[].tokens[]）
- `kana_entries.json`：`[kana:]` 轨，**按正文汉字出现顺序排列的流式序列**

## kana 轨的对齐陷阱

`kana_entries` 没有位置锚点，只能按顺序消费，每条的 `cover` 表示它覆盖几个汉字
（熟字訓如「今日」→きょう 会 cover=2）。

关键细节：**这个序列包含 credits 行里的汉字**（实测赤春花 183 条中有 5 条空读音，
正是「编/曲/制/作/人」）。因此必须**先对全部行做对齐，再剥离 credits**——
顺序反了会让整首歌的注音整体错位。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from kvm.models.karaoke import (
    KaraokeProject,
    Line,
    ReadingSource,
    RubySpan,
    TimingSource,
    Token,
)

_CREDIT_RE = re.compile(r"^(词|曲|编曲|制作人|作词|作曲|监制|混音|母带)[:：]")


def _is_kanji(ch: str) -> bool:
    """判定是否为需要注音的汉字。

    包含 CJK 统一表意文字与扩展 A，以及叠字符号「々」。
    平假名/片假名/ASCII 不需要注音，标注了反而是冗余。
    """
    return "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿" or ch == "々"


def _is_metadata_line(text: str, start_ms: int, first_vocal_ms: int) -> bool:
    """识别被歌词源塞进正文的制作名单行。

    双条件：时间早于首句人声 **且** 文本形如 `词：xxx` 或含 ` - ` 的标题行。
    单用时间会误伤真正的前奏歌词，单用文本会误伤含冒号的歌词。
    """
    if start_ms >= first_vocal_ms:
        return False
    if _CREDIT_RE.match(text):
        return True
    return " - " in text


def load_project(
    parsed_path: Path,
    kana_path: Path,
    *,
    video_width: int = 1920,
    video_height: int = 1080,
    global_offset_ms: int = 0,
    paragraph_gap_ms: int = 3500,
) -> KaraokeProject:
    parsed = json.loads(parsed_path.read_text(encoding="utf-8"))
    kana = json.loads(kana_path.read_text(encoding="utf-8"))
    meta = parsed.get("meta", {})

    raw_lines = parsed.get("lines", [])

    # 先构建全部行（含 credits），保持与 kana 序列一致的汉字顺序
    lines: list[Line] = []
    for rl in raw_lines:
        tokens = [
            Token(
                text=t["text"],
                start_ms=int(t["start_ms"]),
                dur_ms=int(t["dur_ms"]),
                timing_source=TimingSource.PROVIDER,
            )
            for t in rl.get("tokens", [])
        ]
        lines.append(Line(tokens=tokens))

    # 首句人声时间：取第一条不像 credits 的行，用于回判 metadata
    first_vocal = 0
    for ln in lines:
        txt = ln.text
        if not _CREDIT_RE.match(txt) and " - " not in txt:
            first_vocal = ln.start_ms
            break

    for ln in lines:
        ln.is_metadata = _is_metadata_line(ln.text, ln.start_ms, first_vocal)

    _attach_ruby(lines, kana)

    # 槽位：正文行上下交替，让观众能预读下一句。
    # 间奏之后重新从上行开始 —— 这是卡拉OK 的通行习惯，否则新段落
    # 可能突然从下行冒出来，视觉上接不上。阈值与引导点保持一致，
    # 这样"出现引导点的地方"就是"从上行重新开始的地方"。
    slot = 0
    prev_end: int | None = None
    for ln in lines:
        if ln.is_metadata or not ln.tokens:
            continue
        if prev_end is not None and ln.start_ms - prev_end >= paragraph_gap_ms:
            slot = 0
        ln.slot = slot % 2
        slot += 1
        prev_end = ln.end_ms

    return KaraokeProject(
        title=meta.get("ti", ""),
        artist=meta.get("ar", ""),
        lines=lines,
        video_width=video_width,
        video_height=video_height,
        global_offset_ms=global_offset_ms,
    )


def _attach_ruby(lines: list[Line], kana: list[dict]) -> None:
    """按顺序把 kana 条目挂到各行的汉字区间上。

    一条 kana 可能 cover 多个汉字（熟字訓），且这些汉字**理论上可能跨行**——
    实际不会，但这里仍按"同行内连续汉字"处理，跨行则丢弃该条并继续，
    以免一次异常让后续全部错位。
    """
    # 展平：所有行的汉字位置 (line_idx, char_idx)
    positions: list[tuple[int, int]] = []
    for li, ln in enumerate(lines):
        for ci, ch in enumerate(ln.text):
            if _is_kanji(ch):
                positions.append((li, ci))

    pi = 0
    for entry in kana:
        cover = int(entry.get("cover", 1) or 1)
        reading = (entry.get("reading") or "").strip()
        if pi >= len(positions):
            break
        group = positions[pi : pi + cover]
        pi += cover
        if not reading or len(group) < cover:
            continue
        # 只在同一行内连续时才生成 ruby
        li = group[0][0]
        if any(g[0] != li for g in group):
            continue
        c_start = group[0][1]
        c_end = group[-1][1] + 1
        if c_end - c_start != cover:
            # 汉字之间夹了假名，说明这条 cover 语义与实际排布不符，跳过更安全
            continue
        lines[li].ruby.append(
            RubySpan(
                start=c_start,
                end=c_end,
                text=reading,
                source=ReadingSource.PROVIDER_KANA,
            )
        )
