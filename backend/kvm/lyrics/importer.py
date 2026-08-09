"""歌词导入解析：纯文本 / LRC / 已解密的 QRC XML → `LineDTO` 列表。

CLAUDE.md §2.5：手工导入不是"搜索失败后的惩罚性回退"，要能随时主动使用，
冷门曲、同人曲在任何歌词库都可能查不到。三种格式的粒度依次递增：

- `text`：无时间轴，一行一个 Token，时间置 0，**不伪造时间**，等用户手工打轴。
- `lrc`：`[mm:ss.xx]` 行级时间轴，一行一个 Token。
- `qrc`：逐字轴 + `[kana:]` 假名轨。解析规则与 `experiments/qrc_decrypt.py`
  已实测验证过的实现一致（本模块与 `kvm.lyrics.qq` 共用这份解析逻辑：
  provider 拉取解密后的正文与用户手工粘贴的正文格式完全相同）。

## 已知的坑（CLAUDE.md 记载，这里必须照办）

1. `LyricContent` **不能用 XML 解析器取**——其行分隔符是字面 0x0A，XML 属性值
   规范化会把它替换成空格，整篇歌词被压成一行。必须用正则取原文再 `html.unescape`。
2. `[kana:]` 的覆盖数 N 必须按**单个数字**解析，`\\d+` 贪婪匹配会把连续多个
   空读音占位条目（如 `111111`）误读成一个 N=111111 的条目。
3. kana 序列**包含 credits 行（词/曲/编曲……）的汉字**，必须先对全部行做完
   位置展开、按顺序消费完 kana 序列，再判定哪些行是 credits——顺序反了会让
   整首歌的注音整体错位。
"""

from __future__ import annotations

import hashlib
import html
import re
import unicodedata
import uuid
from collections import Counter
from collections.abc import Sequence

from kvm.api.schemas import LineDTO, RubySpanDTO, TokenDTO
from kvm.lyrics.base import Granularity

_CONTENT_RE = re.compile(r'LyricContent="(.*)"\s*/>', re.S)
_QRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
_QRC_TOKEN_RE = re.compile(r"(.*?)\((\d+),(\d+)\)", re.S)
_QRC_TAG_RE = re.compile(r"^\[([a-zA-Z_]+):(.*)\]$", re.S)
_CREDIT_RE = re.compile(r"^(词|曲|编曲|制作人|作词|作曲|监制|混音|母带)[:：]")
_LRC_TAG_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
# CJK 统一表意文字（含扩展 A）与叠字符号「々」，用于判定需要注音的"基字符"。
_KANJI_RE = re.compile(r"[㐀-䶿一-鿿々]")

_PARAGRAPH_GAP_MS = 3500
"""判定为间奏的最小空档，与 `pipeline.qrc_import` 保持一致。"""


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def line_text(line: LineDTO) -> str:
    """行的完整书写文本，由各 Token 拼接而成（`LineDTO` 是 DTO，没有此计算属性）。"""
    return "".join(t.text for t in line.tokens)


def _normalize_for_tid(text: str) -> str:
    """tid 用的行文本归一化：NFKC 折叠全角/半角差异后去掉全部空白。

    目的是让"同一句歌词"在不同歌词源、不同空白排布下算出同一个 hash。
    不做大小写折叠——罗马字歌词里大小写是书写本身的一部分。
    """
    return "".join(unicodedata.normalize("NFKC", text).split())


def _line_digest(line: LineDTO) -> str:
    """行文本的内容 hash，tid 的第一维。"""
    return hashlib.blake2s(
        _normalize_for_tid(line_text(line)).encode("utf-8"), digest_size=6
    ).hexdigest()


def _assign_tids(lines: list[LineDTO]) -> None:
    """为每个 token 生成内容寻址身份键 `tid`。

    CLAUDE.md §4.4：**绝对不要用「第几行第几个 token」做主键**——重新分行或
    重新对齐之后必然漂移，用户锁定的时间与注音会整体错位。主键取内容寻址
    四元组，拼成一个不可再解析的字符串（surface 里可能出现任何字符，tid 只作
    整体比较，不承诺能拆回各维）：

    1. 归一化行文本的 hash
    2. **该行文本在全曲的第几次出现**
    3. surface
    4. 该 surface 在本行的第 n 次出现

    第 2 维是对 §4.4 三元组的必要补强：三元组只保证**行内唯一**，副歌重复行
    （赤春花实测「桜舞って宙を舞って宙を舞って」出现 4 次）会算出完全相同的
    一组 tid，重绑时无从判断该落到哪一行——而 tid 的全部用途就是"重新分行后
    重新绑定手工修改"，绑错行比绑不上更糟。加上这一维后 tid 全局唯一。

    tid 只在**导入这一刻**生成一次。此后拆行/合并只是搬运既有 token
    （`editing.ops` 用 `model_copy` 复制，不重算 tid），tid 因此保持不变，
    重绑才有依据——这条性质不能因为多了一维而破坏，所以出现次数按**导入时的
    原始行序**计数，不随后续编辑重算。
    """
    _assign_tids_from(lines, {})


def _assign_tids_from(lines: list[LineDTO], seed: dict[str, int]) -> None:
    """`_assign_tids` 的实现，行出现序号可以从既有计数接着往下排。

    `seed` 给出各 digest 已经被用掉的出现序号个数，供追加导入避号（见 `rebase_tids`）。
    """
    line_seen: Counter[str] = Counter(seed)
    for line in lines:
        digest = _line_digest(line)
        line_occurrence = line_seen[digest]
        line_seen[digest] += 1
        seen: Counter[str] = Counter()
        for tok in line.tokens:
            tok.tid = f"{digest}.{line_occurrence}#{tok.text}#{seen[tok.text]}"
            seen[tok.text] += 1


def tid_line_key(tid: str) -> str:
    """取 tid 的行维部分 `digest.occurrence`。空串表示这个 token 还没有 tid。

    tid 整体是**不可再解析**的（surface 里可能出现任何字符，包括 `#`），
    但第一个 `#` 之前的这一段是确定的，追加避号与行级归组都只需要它。
    """
    return tid.split("#", 1)[0] if tid else ""


def rebase_tids(existing: Sequence[LineDTO], added: list[LineDTO]) -> None:
    """追加导入时给新行重排 tid 的行出现序号，避开既有行已经占用的号。

    tid 每次导入都从 0 开始数行出现序号，所以把同一份内容追加两次会算出**两组
    完全相同的 tid**——而 tid 的全部用途就是重绑用户的手工修改，重号意味着重绑
    会绑到错误的那一行去（比绑不上更糟，见 `_assign_tids`）。追加是一次拼接，
    新行的号必须接着既有行往下排。
    """
    used: dict[str, int] = {}
    for line in existing:
        for tok in line.tokens:
            key = tid_line_key(tok.tid)
            digest, _, occurrence = key.partition(".")
            if not occurrence.isdigit():
                continue
            used[digest] = max(used.get(digest, 0), int(occurrence) + 1)
    _assign_tids_from(added, used)


def _assign_slots(lines: list[LineDTO], paragraph_gap_ms: int = _PARAGRAPH_GAP_MS) -> None:
    """上下槽位交替；间奏（空档 ≥ paragraph_gap_ms）后重新从上行开始。

    纯文本导入全部行时间都是 0，gap 恒为 0（< 阈值），不会触发重置，
    仍然逐行 0/1 交替——对没有时间信息的场景刚好退化成朴素交替，不需要特判。
    """
    slot = 0
    prev_end: int | None = None
    for ln in lines:
        if ln.is_metadata or not ln.tokens:
            continue
        start_ms = ln.tokens[0].start_ms
        end_ms = ln.tokens[-1].start_ms + ln.tokens[-1].dur_ms
        if prev_end is not None and start_ms - prev_end >= paragraph_gap_ms:
            slot = 0
        ln.slot = slot % 2
        slot += 1
        prev_end = end_ms


def raw_excerpt(lines: list[LineDTO], limit: int = 200) -> str:
    """取前几行拼成摘要，供 `/preview` 里给用户一个"内容对不对"的直观参照。"""
    texts = [line_text(ln) for ln in lines if not ln.is_metadata and ln.tokens]
    excerpt = " / ".join(texts[:4])
    return excerpt[:limit]


def infer_granularity(lines: list[LineDTO]) -> Granularity:
    """从已解析的行反推粒度：平均每行多于一个 Token 视为逐字（word），否则为行级（line）。"""
    real = [ln for ln in lines if ln.tokens and not ln.is_metadata]
    if not real:
        return "line"
    avg_tokens = sum(len(ln.tokens) for ln in real) / len(real)
    return "word" if avg_tokens > 1.5 else "line"


def has_ruby(lines: list[LineDTO]) -> bool:
    return any(ln.ruby for ln in lines)


# ---------------------------------------------------------------------------
# text：纯文本，一行一句，无时间轴
# ---------------------------------------------------------------------------


def parse_text(content: str) -> list[LineDTO]:
    """纯文本导入：一行一句，整行装进单个 Token，时间置 0。

    **不伪造时间**——等用户 tap-to-time 手工打轴，或后续跑强制对齐。

    `timing_source` 标 `unset` 而不是 `manual`：`unset` 的语义是**从未定过时**，
    `manual` 的语义是**用户确实调过**。把待打轴的占位标成 manual 会让人（和
    自动重算逻辑）误以为这个 0 是用户认可的时间，前端也就没法把"尚未打轴"
    显眼地标出来。`locked_timing=False`，允许强制对齐自由填入真实时间。

    `timing_granularity` 标 `line`：这个 token 装的是整行，将来无论手工打轴还是
    行级对齐，它能达到的权威粒度也就是行级——留着默认的 `provider_char`
    等于谎称有逐字权威（CLAUDE.md §4.2 禁止把插值出来的粒度标成 provider）。
    """
    lines: list[LineDTO] = []
    for raw in content.splitlines():
        text = raw.rstrip("\r").strip()
        if not text:
            continue
        lines.append(
            LineDTO(
                id=_new_id(),
                tokens=[
                    TokenDTO(
                        text=text,
                        start_ms=0,
                        dur_ms=0,
                        timing_source="unset",
                        locked_timing=False,
                        timing_granularity="line",
                    )
                ],
            )
        )
    if not lines:
        msg = "导入内容为空：没有解析出任何非空行"
        raise ValueError(msg)
    _assign_tids(lines)
    _assign_slots(lines)
    return lines


# ---------------------------------------------------------------------------
# lrc：[mm:ss.xx] 行级时间轴
# ---------------------------------------------------------------------------


def _lrc_ms(minute: str, second: str, frac: str | None) -> int:
    frac = frac or "0"
    frac_ms = int(frac[:3]) * (10 ** (3 - min(len(frac), 3)))
    return int(minute) * 60_000 + int(second) * 1_000 + frac_ms


def parse_lrc(content: str) -> list[LineDTO]:
    """LRC 导入：`[mm:ss.xx]` 行级时间轴，一行一个 Token。

    一行可能带多个时间戳（副歌重复标记复用同一句歌词），按时间戳拆成多条
    `Line`。不含时间戳的行（`[ti:]`/`[ar:]` 等元数据标签、纯文本行）跳过。
    最后一行没有下一条时间戳可推导时长，`dur_ms` 置 0——**不伪造时间**。

    时间确实来自歌词源，所以 `timing_source` 标 `provider`；但 LRC 只有行级
    时间戳，`timing_granularity` 必须标 `line` 而不是默认的 `provider_char`：
    行内每个字的时间还得靠插值或对齐补，谎称逐字权威会让后续环节
    误把插值结果当锚点用（CLAUDE.md §4.2）。
    """
    entries: list[tuple[int, str]] = []
    for raw in content.splitlines():
        text_line = raw.rstrip("\r")
        if not text_line.strip():
            continue
        tags = list(_LRC_TAG_RE.finditer(text_line))
        if not tags:
            continue
        text = text_line[tags[-1].end() :].strip()
        if not text:
            continue
        entries.extend((_lrc_ms(m.group(1), m.group(2), m.group(3)), text) for m in tags)

    if not entries:
        msg = "未解析出任何 [mm:ss.xx] 时间轴行，请确认内容是 LRC 格式"
        raise ValueError(msg)

    entries.sort(key=lambda e: e[0])
    lines: list[LineDTO] = []
    for i, (start_ms, text) in enumerate(entries):
        dur_ms = max(0, entries[i + 1][0] - start_ms) if i + 1 < len(entries) else 0
        lines.append(
            LineDTO(
                id=_new_id(),
                tokens=[
                    TokenDTO(
                        text=text,
                        start_ms=start_ms,
                        dur_ms=dur_ms,
                        timing_source="provider",
                        locked_timing=False,
                        timing_granularity="line",
                    )
                ],
            )
        )
    _assign_tids(lines)
    _assign_slots(lines)
    return lines


# ---------------------------------------------------------------------------
# qrc：已解密的 QRC XML，逐字轴 + [kana:]
# ---------------------------------------------------------------------------


def extract_lyric_content(xml_text: str) -> str:
    """从 QRC XML 中取出 `LyricContent` 属性原文（见模块文档"已知的坑" 1）。"""
    if "LyricContent=" not in xml_text:
        # 不是外层 XML 包装，视为用户直接粘贴了 LyricContent 内部正文。
        return xml_text
    m = _CONTENT_RE.search(xml_text)
    if not m:
        msg = "QRC XML 中找不到 LyricContent 属性"
        raise ValueError(msg)
    return html.unescape(m.group(1))


def _parse_qrc_lines(content: str) -> tuple[dict[str, str], list[dict]]:
    """QRC 正文 → (元数据标签, 逐字行列表)。

    行格式：`[起始ms,时长ms]字(起始ms,时长ms)字(起始ms,时长ms)...`，
    注意括号里第二个数是 duration 而非 end（已实测确认）。
    """
    meta: dict[str, str] = {}
    lines: list[dict] = []
    for raw in content.splitlines():
        text_line = raw.rstrip("\r")
        if not text_line.strip():
            continue
        m = _QRC_LINE_RE.match(text_line)
        if not m:
            tag = _QRC_TAG_RE.match(text_line.strip())
            if tag:
                meta[tag.group(1)] = tag.group(2)
            continue
        start, dur, body = int(m.group(1)), int(m.group(2)), m.group(3)
        tokens = [
            {"text": tm.group(1), "start_ms": int(tm.group(2)), "dur_ms": int(tm.group(3))}
            for tm in _QRC_TOKEN_RE.finditer(body)
        ]
        lines.append({"start_ms": start, "dur_ms": dur, "tokens": tokens})
    return meta, lines


def parse_kana_track(kana: str) -> list[dict]:
    """解析 `[kana:]` 轨（见模块文档"已知的坑" 2）。

    格式是无锚点的流：`<单个数字N><读音>(可选的逐拍时间)`，N 表示该条目
    覆盖的连续"基字符（汉字）"数，熟字訓（如「今日」→きょう）N=2。
    """
    out: list[dict] = []
    i, n = 0, len(kana)
    while i < n:
        if not kana[i].isdigit():
            # 流被污染，整段丢弃而不是错位——消费端应整行丢弃注音而非错误显示。
            break
        cover = int(kana[i])
        i += 1
        reading: list[str] = []
        while i < n:
            ch = kana[i]
            if ch == "(":
                j = kana.find(")", i)
                if j < 0:
                    break
                i = j + 1
            elif ch.isdigit():
                break
            else:
                reading.append(ch)
                i += 1
        out.append({"cover": cover, "reading": "".join(reading)})
    return out


def _is_kanji(ch: str) -> bool:
    return bool(_KANJI_RE.match(ch))


def _is_metadata_line(text: str, start_ms: int, first_vocal_ms: int) -> bool:
    """识别被歌词源塞进正文的制作名单行（词/曲/编曲/制作人……）。

    双条件：时间早于首句人声 **且** 文本形如 `词：xxx` 或含 ` - ` 的标题行。
    单用时间会误伤真正的前奏歌词，单用文本会误伤含冒号的歌词。与
    `pipeline.qrc_import._is_metadata_line` 逻辑一致。
    """
    if start_ms >= first_vocal_ms:
        return False
    if _CREDIT_RE.match(text):
        return True
    return " - " in text


def _attach_ruby(lines: list[LineDTO], kana_entries: list[dict]) -> None:
    """按顺序把 kana 条目挂到各行的汉字区间上（见模块文档"已知的坑" 3）。

    先展平全部行（含 credits）的汉字位置，再按顺序消费 kana 序列——
    调用方必须保证传入的 `lines` 尚未剔除 credits 行，否则位置对不上，
    整首歌注音会整体错位。
    """
    positions: list[tuple[int, int]] = []
    for li, ln in enumerate(lines):
        text = line_text(ln)
        for ci, ch in enumerate(text):
            if _is_kanji(ch):
                positions.append((li, ci))

    pi = 0
    for entry in kana_entries:
        cover = int(entry.get("cover", 1) or 1)
        reading = (entry.get("reading") or "").strip()
        if pi >= len(positions):
            break
        group = positions[pi : pi + cover]
        pi += cover
        if not reading or len(group) < cover:
            continue
        li = group[0][0]
        if any(g[0] != li for g in group):
            continue
        c_start = group[0][1]
        c_end = group[-1][1] + 1
        if c_end - c_start != cover:
            # 汉字之间夹了假名，说明这条 cover 语义与实际排布不符，跳过更安全。
            continue
        lines[li].ruby.append(RubySpanDTO(start=c_start, end=c_end, text=reading))


def parse_qrc(content: str) -> list[LineDTO]:
    """已解密的 QRC XML → `LineDTO` 列表：逐字轴 + `[kana:]` 注音。

    `content` 既可以是完整的 `<QrcInfos>...<Lyric_1 LyricContent="...">`
    外层 XML（provider 拉取解密后的原样文本），也可以是用户只粘贴了
    `LyricContent` 内部正文——两种都能处理。
    """
    lyric_content = extract_lyric_content(content)
    meta, raw_lines = _parse_qrc_lines(lyric_content)
    if not raw_lines:
        msg = "QRC 内容解析出 0 行，请确认是已解密的 QRC 正文"
        raise ValueError(msg)
    kana_entries = parse_kana_track(meta.get("kana", ""))

    lines: list[LineDTO] = []
    for rl in raw_lines:
        tokens = [
            TokenDTO(
                text=t["text"],
                start_ms=t["start_ms"],
                dur_ms=t["dur_ms"],
                timing_source="provider",
                locked_timing=False,
            )
            for t in rl["tokens"]
        ]
        lines.append(LineDTO(id=_new_id(), tokens=tokens))

    # 首句人声时间：取第一条不像 credits 的行，用于回判 is_metadata。
    first_vocal = 0
    for ln in lines:
        text = line_text(ln)
        if not _CREDIT_RE.match(text) and " - " not in text:
            first_vocal = ln.tokens[0].start_ms if ln.tokens else 0
            break

    for ln in lines:
        text = line_text(ln)
        start_ms = ln.tokens[0].start_ms if ln.tokens else 0
        ln.is_metadata = _is_metadata_line(text, start_ms, first_vocal)

    _attach_ruby(lines, kana_entries)
    _assign_tids(lines)
    _assign_slots(lines)
    return lines


# ---------------------------------------------------------------------------
# 分派
# ---------------------------------------------------------------------------


def parse_import(kind: str, content: str) -> list[LineDTO]:
    """按 `LyricImportRequest.kind` 分派到对应解析器。"""
    if kind == "text":
        return parse_text(content)
    if kind == "lrc":
        return parse_lrc(content)
    if kind == "qrc":
        return parse_qrc(content)
    msg = f"不支持的导入格式：{kind}"
    raise ValueError(msg)
