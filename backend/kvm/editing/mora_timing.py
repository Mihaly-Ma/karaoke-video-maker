"""注音逐拍打轴：保存真实拍时间，正文字符时间由拍边界映射得到。"""

from collections.abc import Sequence
from itertools import pairwise

from kvm.api.schemas import LineDTO, MoraTimingSpanDTO, ProjectDTO, SetMoraTimingItem
from kvm.editing.ops import EditError, EditOutcome, _mark_timing_manual
from kvm.models.karaoke import is_kana_text, to_katakana


def token_bounds(line: LineDTO, start: int, end: int) -> tuple[int, int]:
    offsets = [0]
    for token in line.tokens:
        offsets.append(offsets[-1] + len(token.text))
    if start not in offsets or end not in offsets or not 0 <= start < end:
        raise EditError("注音区间需对应完整的歌词字")
    return offsets.index(start), offsets.index(end)


def reading_at(line: LineDTO, start: int, end: int) -> str:
    surface = "".join(t.text for t in line.tokens)[start:end]
    span = next((r for r in line.ruby if r.start == start and r.end == end), None)
    return span.text if span else surface


def effective_mora_timings(line: LineDTO) -> list[tuple[MoraTimingSpanDTO, int, int, int]]:
    """均匀平移沿用拍轴；正文、读音或内部时间变化后不使用过期拍轴。"""
    out: list[tuple[MoraTimingSpanDTO, int, int, int]] = []
    for span in line.mora_timings:
        try:
            lo, hi = token_bounds(line, span.start, span.end)
        except EditError:
            continue
        tokens = line.tokens[lo:hi]
        if (
            "".join(t.text for t in tokens) != span.surface
            or to_katakana(reading_at(line, span.start, span.end)) != to_katakana(span.reading)
            or [t.tid for t in tokens] != span.token_ids
            or [t.dur_ms for t in tokens] != span.token_durations
            or len(tokens) != len(span.token_starts)
        ):
            continue
        deltas = {t.start_ms - old for t, old in zip(tokens, span.token_starts, strict=True)}
        if len(deltas) == 1:
            out.append((span, lo, hi, deltas.pop()))
    return out


def set_mora_timings(project: ProjectDTO, items: Sequence[SetMoraTimingItem]) -> EditOutcome:
    plans: list[tuple[LineDTO, SetMoraTimingItem, int, int, list[int]]] = []
    occupied: set[tuple[str, int]] = set()
    for item in items:
        line = next(
            (
                candidate
                for candidate in project.lines
                if candidate.id == item.line_id and not candidate.is_metadata
            ),
            None,
        )
        if line is None:
            raise EditError("歌词行不存在")
        lo, hi = token_bounds(line, item.start, item.end)
        if "".join(t.text for t in line.tokens[lo:hi]) != item.surface:
            raise EditError("歌词已变化，请重新打开注音打轴")
        reading = reading_at(line, item.start, item.end)
        if (
            to_katakana(reading) != to_katakana(item.reading)
            or not is_kana_text(item.reading)
            or "".join(t.text for t in item.times) != item.reading
        ):
            raise EditError("注音已变化或尚未补全，请重新打轴")
        for a, b in pairwise(item.times):
            if a.start_ms + a.dur_ms > b.start_ms:
                raise EditError("注音拍时间不能倒挂或重叠")
        for index in range(lo, hi):
            if (line.id, index) in occupied:
                raise EditError("注音打轴区间重复")
            occupied.add((line.id, index))
        chars = item.end - item.start
        count = len(item.times)
        positions = [0]
        for token in line.tokens[lo:hi]:
            positions.append(positions[-1] + len(token.text))
        boundaries: list[int] = []
        for pos in positions:
            q = pos * count / chars
            index = min(int(q), count - 1)
            beat = item.times[index]
            boundaries.append(round(beat.start_ms + (q - index) * beat.dur_ms))
        if any(b - a < 10 for a, b in pairwise(boundaries)):
            raise EditError("这段注音时间太短，无法映射到歌词字")
        plans.append((line, item, lo, hi, boundaries))
    for line, item, lo, hi, boundaries in plans:
        for offset, token in enumerate(line.tokens[lo:hi]):
            token.start_ms = boundaries[offset]
            token.dur_ms = boundaries[offset + 1] - boundaries[offset]
            token.timing_granularity = "mora"
            _mark_timing_manual(token)
        line.mora_timings = [
            s for s in line.mora_timings if s.end <= item.start or s.start >= item.end
        ]
        line.mora_timings.append(
            MoraTimingSpanDTO(
                start=item.start,
                end=item.end,
                surface=item.surface,
                reading=item.reading,
                times=item.times,
                token_ids=[t.tid for t in line.tokens[lo:hi]],
                token_starts=[t.start_ms for t in line.tokens[lo:hi]],
                token_durations=[t.dur_ms for t in line.tokens[lo:hi]],
            )
        )
    return EditOutcome()
