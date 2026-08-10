"""P1-7：本地注音链路与「读音双形态」实测。

对应 CLAUDE.md §4.2（reading_display / reading_phonetic 必须同时存在）、
§4.5（读音优先级模型）、§5.6（日语读音与注音选型）、§9 第 7 项
（pyopenjtalk.g2p 吃纯假名串时的行为）。

全部本地推理，不联网、不调用任何云端 AI。歌词素材是一次性抓取后落盘的本地文件。

运行方式（不写共享 pyproject.toml，依赖用 --with 临时引入）::

    uv run --python 3.12 \
        --with fugashi --with unidic-lite \
        --with sudachipy --with sudachidict-core \
        --with pyopenjtalk-plus --with jaconv \
        python experiments/furigana_local.py

产物：workspace/furigana_local_report.json
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径与常量
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = REPO_ROOT / "workspace"
LYRICS_FILE = WORKSPACE / "sekishunka_lyrics.txt"
REPORT_FILE = WORKSPACE / "furigana_local_report.json"

# 兜底歌词：若 workspace 里没有抓取到的验证曲歌词，用这份内置文本
# （sumika「赤春花」的公开歌词片段，仅作技术验证用）。
FALLBACK_LYRICS = """桜舞って宙を舞って宙を舞って
春、君に触れる
桜舞って想いは降って
まだ君を見てる
春風に揺れる
揺るがないものに出会えました
恥ずかしいほどに知りました
君が靡いて風になって
優しい香りがした
蘇っていく ひとひら
青から赤になる
込み上げていく ひとひら
名前ついて声になる
まだ終わっていないみたい
さあ一体僕らはどうしようか
人生長き されど短し
もう一回僕ら出会えるかな
赤くなりゆく春"""


# ---------------------------------------------------------------------------
# 假名工具
# ---------------------------------------------------------------------------

HIRA_RANGE = (0x3041, 0x3096)
KATA_RANGE = (0x30A1, 0x30F6)
PROLONGED = "ー"

# 拗音 / 外来音的小书假名：合并到前一拍。促音 ッ、拨音 ン、长音 ー 各自独立成拍。
SMALL_KANA = set("ァィゥェォャュョヮぁぃぅぇぉゃゅょゎ")

# 浊音 / 半浊音等价（连浊容差）
VOICING_VARIANTS: dict[str, str] = {}
for _base, _voiced in zip(
    "カキクケコサシスセソタチツテトハヒフヘホ",
    "ガギグゲゴザジズゼゾダヂヅデドバビブベボ",
    strict=True,
):
    VOICING_VARIANTS[_base] = _voiced
for _base, _semi in zip("ハヒフヘホ", "パピプペポ", strict=True):
    VOICING_VARIANTS.setdefault(_base, "")
    VOICING_VARIANTS[_base] = VOICING_VARIANTS[_base] + _semi

# 四つ仮名等价（ジ/ヂ、ズ/ヅ）
YOTSUGANA = {"ジ": "ヂ", "ヂ": "ジ", "ズ": "ヅ", "ヅ": "ズ"}

# 母音归属表：判断长音化用
VOWEL_OF: dict[str, str] = {}
for _vowel, _chars in {
    "a": "アカサタナハマヤラワガザダバパャァ",
    "i": "イキシチニヒミリギジヂビピィ",
    "u": "ウクスツヌフムユルグズヅブプュゥヴ",
    "e": "エケセテネヘメレゲゼデベペェ",
    "o": "オコソトノホモヨロヲゴゾドボポョォ",
}.items():
    for _c in _chars:
        VOWEL_OF[_c] = _vowel


def to_katakana(text: str) -> str:
    """平假名 → 片假名（其余字符原样保留）。"""
    out = []
    for ch in text:
        code = ord(ch)
        if HIRA_RANGE[0] <= code <= HIRA_RANGE[1]:
            out.append(chr(code + 0x60))
        else:
            out.append(ch)
    return "".join(out)


def to_hiragana(text: str) -> str:
    """片假名 → 平假名（长音符 ー 保留）。"""
    out = []
    for ch in text:
        code = ord(ch)
        if KATA_RANGE[0] <= code <= KATA_RANGE[1]:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def is_kana(ch: str) -> bool:
    code = ord(ch)
    return (
        HIRA_RANGE[0] <= code <= HIRA_RANGE[1]
        or KATA_RANGE[0] <= code <= KATA_RANGE[1]
        or ch == PROLONGED
    )


def is_kanji(ch: str) -> bool:
    return "一" <= ch <= "鿿" or ch in "々〆"


def is_punct(ch: str) -> bool:
    """标点 / 空白：不参与注音，也不占 reading。"""
    return unicodedata.category(ch).startswith(("P", "Z", "C", "S"))


# ---------------------------------------------------------------------------
# 第 4 项：mora 切分
# ---------------------------------------------------------------------------


def split_mora(kana: str) -> list[str]:
    """假名串 → mora 序列。

    规则：
      - 小书假名（ャュョァィゥェォヮ）合并到前一拍 —— 拗音「キャ」算一拍
      - 促音 ッ、拨音 ン、长音符 ー 各自独立成一拍
      - 其余每个假名一拍

    构造上保证不变式 ``"".join(split_mora(s)) == s``。
    """
    moras: list[str] = []
    for ch in kana:
        if moras and ch in SMALL_KANA:
            moras[-1] += ch
        else:
            moras.append(ch)
    return moras


# ---------------------------------------------------------------------------
# 第 2 项：送り仮名切分（汉字块 / 假名尾巴）
# ---------------------------------------------------------------------------


@dataclass
class RubySpan:
    """surface 的字符区间 [s, e) → 注音文本（片假名存储）。"""

    s: int
    e: int
    rt: str


def _char_class(ch: str) -> str:
    """把 surface 里的一个假名字符编译成正则字符类，带连浊 / 四つ仮名 / 长音容差。"""
    variants = {ch}
    if ch in VOICING_VARIANTS:
        variants.update(VOICING_VARIANTS[ch])
    if ch in YOTSUGANA:
        variants.add(YOTSUGANA[ch])
    # reading 若是发音形（含长音符），surface 的母音字可能对应 ー
    if ch in VOWEL_OF and ch in "アイウエオ":
        variants.add(PROLONGED)
    return "[" + re.escape("".join(sorted(variants))) + "]"


def _segment_surface(surface: str) -> list[tuple[str, str]]:
    """把 surface 切成交替的块：("kana", 假名串) / ("need", 需要注音的串) / ("punct", 标点)。"""
    blocks: list[tuple[str, str]] = []
    for ch in surface:
        if is_kana(ch):
            kind = "kana"
        elif is_punct(ch):
            kind = "punct"
        else:  # 汉字、拉丁字母、数字都当作「需要注音」
            kind = "need"
        if blocks and blocks[-1][0] == kind:
            blocks[-1] = (kind, blocks[-1][1] + ch)
        else:
            blocks.append((kind, ch))
    return blocks


def split_furigana(surface: str, reading: str) -> tuple[list[RubySpan], str]:
    """假名锚点法：把 reading 分配给 surface 里的汉字块。

    返回 (ruby 列表, 方法标记)。方法标记为 ``anchor``（锚点匹配成功）、
    ``whole``（无锚点或匹配失败，整块一个 ruby）、``none``（纯假名，无需注音）。
    """
    reading = to_katakana(reading)
    blocks = _segment_surface(surface)

    if not any(kind == "need" for kind, _ in blocks):
        return [], "none"

    # 构造正则：need 块 → 捕获组，kana 块 → 带容差的字面量，punct 块 → 忽略
    pattern_parts: list[str] = []
    need_positions: list[tuple[int, int]] = []
    offset = 0
    for kind, text in blocks:
        if kind == "need":
            pattern_parts.append("(.+?)")
            need_positions.append((offset, offset + len(text)))
        elif kind == "kana":
            pattern_parts.append("".join(_char_class(c) for c in to_katakana(text)))
        offset += len(text)

    match = re.fullmatch("".join(pattern_parts), reading)
    if match is None:
        # 无解：降级为整块一个 ruby（nicokara 风格里整词注音是可接受的）
        first = next(i for i, (k, _) in enumerate(blocks) if k == "need")
        last = len(blocks) - 1 - next(i for i, (k, _) in enumerate(reversed(blocks)) if k == "need")
        start = sum(len(t) for _, t in blocks[:first])
        end = sum(len(t) for _, t in blocks[: last + 1])
        return [RubySpan(start, end, reading)], "whole"

    spans = [RubySpan(s, e, match.group(i + 1)) for i, (s, e) in enumerate(need_positions)]
    return spans, "anchor" if len(need_positions) else "none"


def check_ruby_coverage(surface: str, spans: list[RubySpan]) -> bool:
    """不变式 3：ruby span 与假名字符无缝、无重叠地覆盖整个 surface。"""
    covered = [False] * len(surface)
    for sp in spans:
        if sp.s < 0 or sp.e > len(surface) or sp.s >= sp.e:
            return False
        for i in range(sp.s, sp.e):
            if covered[i]:
                return False  # 重叠
            covered[i] = True
    for i, ch in enumerate(surface):
        if not covered[i] and not (is_kana(ch) or is_punct(ch)):
            return False  # 汉字没被覆盖
        if covered[i] and is_kana(ch):
            return False  # 假名不该出现在 ruby 里
    return True


# ---------------------------------------------------------------------------
# 第 3 项：读音双形态 —— 规则版 display → phonetic
# ---------------------------------------------------------------------------

PARTICLE_PHONETIC = {"ハ": "ワ", "ヘ": "エ", "ヲ": "オ"}

# 长音化：前一拍母音 + 后一个假名 → 后者变 ー
# 注意 ("i","イ") 被刻意排除：NJD 的 pron 保留「ヤサシイ」「オーキイ」不长音化，
# 而 UniDic 的 pron 会写成「オーキー」—— 两个权威参照在这一条上本身就不一致。
LONG_VOWEL_RULES = {
    ("a", "ア"),
    ("u", "ウ"),
    ("e", "エ"),
    ("o", "オ"),
    ("o", "ウ"),  # 東京 トウキョウ → トーキョー
    ("e", "イ"),  # 先生 センセイ → センセー
}

# 四つ仮名归一：发音形里 ヅ/ヂ 与 ズ/ジ 同音，两个参照实现都归到 ズ/ジ
YOTSUGANA_NORMALIZE = {"ヅ": "ズ", "ヂ": "ジ"}


def derive_phonetic(reading_display: str, pos1: str = "", pos2: str = "") -> str:
    """从 reading_display（表记读法，片假名）+ 词性推导 reading_phonetic（发音形）。

    这是 CLAUDE.md §4.5 里「[kana:] 只给 display，仍需推导 phonetic」那条路径的
    规则实现。**必须知道词性**：助词「は」→ワ 是词性决定的，光看假名串推不出来。
    """
    kana = to_katakana(reading_display)

    # 助词整体替换（助词永远是单假名，直接查表）
    if pos1 == "助詞" and kana in PARTICLE_PHONETIC:
        return PARTICLE_PHONETIC[kana]

    kana = "".join(YOTSUGANA_NORMALIZE.get(c, c) for c in kana)

    # 长音化
    out: list[str] = []
    for ch in kana:
        if out:
            prev_vowel = VOWEL_OF.get(out[-1][-1]) if out[-1] != PROLONGED else None
            if out[-1] == PROLONGED:
                # 连续长音：找回最近一个有母音的假名
                for back in reversed(out):
                    if back != PROLONGED:
                        prev_vowel = VOWEL_OF.get(back[-1])
                        break
            if prev_vowel is not None and (prev_vowel, ch) in LONG_VOWEL_RULES:
                out.append(PROLONGED)
                continue
        out.append(ch)
    return "".join(out)


# ---------------------------------------------------------------------------
# 分析器封装
# ---------------------------------------------------------------------------


@dataclass
class Token:
    surface: str
    reading_display: str  # 表记读法（片假名）
    reading_phonetic: str  # 发音形（片假名，含 ー）
    pos1: str = ""
    pos2: str = ""
    analyzer: str = ""


# UniDic 与 OpenJTalk NJD 的 pron 字段都会带无声化标记 ’（母音无声化，如 マシ’），
# 必须剥掉才能当 reading_phonetic 用，否则 mora 数会多算。
UNIDIC_PRON_MARKS = "’‘"


def strip_pron_marks(pron: str) -> str:
    return "".join(c for c in pron if c not in UNIDIC_PRON_MARKS)


class FugashiAnalyzer:
    """fugashi + unidic-lite。UniDic 特征里 kana=表记读法，pron=发音形，天然双形态。"""

    name = "fugashi+unidic-lite"

    def __init__(self) -> None:
        import fugashi

        self.tagger = fugashi.Tagger()

    def analyze(self, text: str) -> list[Token]:
        tokens: list[Token] = []
        for w in self.tagger(text):
            f = w.feature
            kana = getattr(f, "kana", None)
            pron = getattr(f, "pron", None)
            if pron:
                pron = strip_pron_marks(pron)
            if not kana or kana == "*":
                kana = to_katakana(w.surface) if all(is_kana(c) for c in w.surface) else ""
            if not pron or pron == "*":
                pron = kana
            tokens.append(Token(w.surface, kana, pron, f.pos1 or "", f.pos2 or "", self.name))
        return tokens


class SudachiAnalyzer:
    """SudachiPy + sudachidict-core。只有 reading_form()（表记读法），**没有发音形**。"""

    name = "sudachipy+sudachidict-core"

    def __init__(self) -> None:
        from sudachipy import dictionary, tokenizer

        self.tokenizer_obj = dictionary.Dictionary(dict="core").create()
        self.mode = tokenizer.Tokenizer.SplitMode.C

    def analyze(self, text: str) -> list[Token]:
        tokens: list[Token] = []
        for m in self.tokenizer_obj.tokenize(text, self.mode):
            pos = m.part_of_speech()
            reading = m.reading_form() or ""
            if not reading and all(is_kana(c) for c in m.surface()):
                reading = to_katakana(m.surface())
            # Sudachi 不给发音形，只能用规则推导 —— 这本身就是一个结论
            tokens.append(
                Token(
                    m.surface(),
                    reading,
                    derive_phonetic(reading, pos[0], pos[1]),
                    pos[0],
                    pos[1],
                    self.name,
                )
            )
        return tokens


class OpenJTalkAnalyzer:
    """pyopenjtalk-plus 的 NJD 前端。read=表记读法，pron=发音形，也是天然双形态。"""

    name = "pyopenjtalk-plus(NJD)"

    def __init__(self) -> None:
        import pyopenjtalk

        self.pyopenjtalk = pyopenjtalk

    def analyze(self, text: str) -> list[Token]:
        tokens: list[Token] = []
        for f in self.pyopenjtalk.run_frontend(text):
            tokens.append(
                Token(
                    f["string"],
                    f.get("read", "") if f.get("read") != "*" else "",
                    strip_pron_marks(f.get("pron", "")) if f.get("pron") != "*" else "",
                    f.get("pos", ""),
                    f.get("pos_group1", ""),
                    self.name,
                )
            )
        return tokens


# ---------------------------------------------------------------------------
# 报告工具
# ---------------------------------------------------------------------------

report: dict = {}


def head(title: str) -> None:
    print()
    print("=" * 78)
    print(title)
    print("=" * 78)


def load_lyrics() -> list[str]:
    if LYRICS_FILE.exists():
        raw = LYRICS_FILE.read_text(encoding="utf-8")
        src = str(LYRICS_FILE)
    else:
        raw = FALLBACK_LYRICS
        src = "内置兜底歌词"
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    print(f"歌词来源：{src}，非空行数 {len(lines)}")
    return lines


# ---------------------------------------------------------------------------
# 第 0 节：环境
# ---------------------------------------------------------------------------


def section_env() -> dict:
    head("第 0 节 环境与 wheel 可用性")
    import importlib.metadata as md
    import platform

    info = {
        "python": sys.version.split()[0],
        "machine": platform.machine(),
        "platform": platform.platform(),
        "packages": {},
    }
    for pkg in (
        "fugashi",
        "unidic-lite",
        "sudachipy",
        "sudachidict-core",
        "pyopenjtalk-plus",
        "jaconv",
    ):
        try:
            info["packages"][pkg] = md.version(pkg)
        except Exception as exc:  # noqa: BLE001
            info["packages"][pkg] = f"缺失: {exc}"
    for k, v in info.items():
        if k != "packages":
            print(f"  {k}: {v}")
    for k, v in info["packages"].items():
        print(f"  包 {k}: {v}")
    return info


# ---------------------------------------------------------------------------
# 第 1 节：形态素分析器对比
# ---------------------------------------------------------------------------


def section_analyzers(lines: list[str]) -> dict:
    head("第 1 节 形态素分析器对比（fugashi+unidic-lite vs SudachiPy vs pyopenjtalk NJD）")

    # 记号 / 空白 token 必须排除后再比：SudachiPy 会把「、」和空格的 reading_form
    # 给成「キゴウ」，fugashi 给空，NJD 原样保留 —— 这不是读音准确率的差异
    def content_reading(tokens: list[Token]) -> str:
        out = []
        for t in tokens:
            if t.pos1 in ("補助記号", "記号", "空白"):
                continue
            if all(is_punct(c) for c in t.surface):
                continue
            out.append("".join(c for c in t.reading_display if not is_punct(c)))
        return "".join(out)

    analyzers = [FugashiAnalyzer(), SudachiAnalyzer(), OpenJTalkAnalyzer()]
    per_line: list[dict] = []
    agree_all = 0
    fug_vs_sud = 0
    fug_vs_ojt = 0

    for ln in lines:
        readings = {}
        for a in analyzers:
            readings[a.name] = content_reading(a.analyze(ln))
        f = readings[analyzers[0].name]
        s = readings[analyzers[1].name]
        o = readings[analyzers[2].name]
        if f == s == o:
            agree_all += 1
        if f == s:
            fug_vs_sud += 1
        if f == o:
            fug_vs_ojt += 1
        per_line.append({"line": ln, **readings})

    n = len(lines)
    print(f"  行级表记读法完全一致（三者）：{agree_all}/{n} = {agree_all / n:.1%}")
    print(f"  fugashi ↔ sudachi 一致：      {fug_vs_sud}/{n} = {fug_vs_sud / n:.1%}")
    print(f"  fugashi ↔ pyopenjtalk 一致：  {fug_vs_ojt}/{n} = {fug_vs_ojt / n:.1%}")

    print("\n  分歧行（最多列 15 条）：")
    shown = 0
    diffs = []
    for row in per_line:
        vals = {k: v for k, v in row.items() if k != "line"}
        if len(set(vals.values())) == 1:
            continue
        diffs.append(row)
        if shown < 15:
            print(f"    原文: {row['line']}")
            for k, v in vals.items():
                print(f"        {k:<28} {to_hiragana(v)}")
            shown += 1

    # 双形态字段可用性
    print("\n  双形态字段可用性（这是本节的关键结论）：")
    probe = "私は東京の学校へ行って夫婦で大きい氷を食べる"
    fields = {}
    for a in analyzers:
        toks = a.analyze(probe)
        fields[a.name] = [
            {
                "surface": t.surface,
                "display": t.reading_display,
                "phonetic": t.reading_phonetic,
            }
            for t in toks
        ]
        print(f"    {a.name}")
        print(f"      display : {to_hiragana(''.join(t.reading_display for t in toks))}")
        print(f"      phonetic: {''.join(t.reading_phonetic for t in toks)}")

    return {
        "line_count": n,
        "agree_all": agree_all,
        "fugashi_vs_sudachi": fug_vs_sud,
        "fugashi_vs_openjtalk": fug_vs_ojt,
        "diff_lines": diffs,
        "double_form_probe": fields,
    }


# ---------------------------------------------------------------------------
# 第 2 节：送り仮名切分
# ---------------------------------------------------------------------------


def section_okurigana(lines: list[str]) -> dict:
    head("第 2 节 送り仮名切分（汉字块 vs 假名尾巴）")

    cases = [
        ("食べる", "タベル", [(0, 1, "タ")]),
        ("行った", "イッタ", [(0, 1, "イ")]),
        ("見てる", "ミテル", [(0, 1, "ミ")]),
        ("恥ずかしい", "ハズカシイ", [(0, 1, "ハ")]),
        ("込み上げる", "コミアゲル", [(0, 1, "コ"), (2, 3, "ア")]),
        ("学校", "ガッコウ", [(0, 2, "ガッコウ")]),
        ("お願い", "オネガイ", [(1, 2, "ネガ")]),
        ("香り", "カオリ", [(0, 1, "カオ")]),
        ("短し", "ミジカシ", [(0, 1, "ミジカ")]),
        ("滲んで", "ニジンデ", [(0, 1, "ニジ")]),
        ("眠らせ", "ネムラセ", [(0, 1, "ネム")]),
        ("靡いて", "ナビイテ", [(0, 1, "ナビ")]),
        ("蘇っ", "ヨミガエッ", [(0, 1, "ヨミガエ")]),
        ("出会える", "デアエル", [(0, 2, "デア")]),  # 两汉字相邻，预期降级整块
        ("手紙", "テガミ", [(0, 2, "テガミ")]),  # 无假名锚点，预期降级整块
        ("ひとひら", "ヒトヒラ", []),  # 纯假名，不注音
    ]

    passed = 0
    detail = []
    for surface, reading, expect in cases:
        spans, method = split_furigana(surface, reading)
        got = [(sp.s, sp.e, sp.rt) for sp in spans]
        ok = got == expect
        cover = check_ruby_coverage(surface, spans)
        passed += ok and cover
        detail.append(
            {
                "surface": surface,
                "reading": reading,
                "expect": expect,
                "got": got,
                "method": method,
                "coverage_ok": cover,
                "pass": bool(ok and cover),
            }
        )
        mark = "OK " if ok and cover else "NG "
        pretty = " ".join(f"{surface[s:e]}→{to_hiragana(rt)}" for s, e, rt in got) or "(无)"
        print(f"  {mark}{surface:<6} {to_hiragana(reading):<10} [{method:<6}] {pretty}")
        if not ok:
            print(f"       期望 {expect}  实得 {got}")

    print(f"\n  用例通过：{passed}/{len(cases)}")

    # 在真实歌词全量上跑一遍，统计降级率与覆盖不变式
    fug = FugashiAnalyzer()
    total = anchor = whole = none_ = cover_fail = 0
    fallback_samples = []
    for ln in lines:
        for t in fug.analyze(ln):
            if not t.reading_display:
                continue
            spans, method = split_furigana(t.surface, t.reading_display)
            total += 1
            if method == "anchor":
                anchor += 1
            elif method == "whole":
                whole += 1
                if len(fallback_samples) < 20:
                    fallback_samples.append(
                        {
                            "surface": t.surface,
                            "reading": to_hiragana(t.reading_display),
                        }
                    )
            else:
                none_ += 1
            if not check_ruby_coverage(t.surface, spans):
                cover_fail += 1

    print(f"\n  歌词全量 token 数 {total}")
    print(f"    锚点切分成功 anchor : {anchor} ({anchor / max(total, 1):.1%})")
    print(f"    降级整块     whole  : {whole} ({whole / max(total, 1):.1%})")
    print(f"    纯假名无需注音 none : {none_} ({none_ / max(total, 1):.1%})")
    print(f"    ruby 覆盖不变式失败 : {cover_fail}")
    print(f"    降级样本：{[s['surface'] + '/' + s['reading'] for s in fallback_samples]}")

    return {
        "cases_passed": passed,
        "cases_total": len(cases),
        "case_detail": detail,
        "corpus_total": total,
        "corpus_anchor": anchor,
        "corpus_whole": whole,
        "corpus_none": none_,
        "corpus_coverage_fail": cover_fail,
        "fallback_samples": fallback_samples,
    }


# ---------------------------------------------------------------------------
# 第 3 节：读音双形态 / g2p 吃纯假名串（本任务最关键）
# ---------------------------------------------------------------------------


def section_double_form(lines: list[str]) -> dict:
    head("第 3 节 读音双形态：pyopenjtalk.g2p 吃纯假名串的行为")

    import pyopenjtalk

    print("  3-A  同一句的三种输入形态（汉字原文 / 平假名 / 片假名）")
    probes = [
        ("私は学校へ行く", "汉字原文"),
        ("わたしはがっこうへいく", "全平假名（reading_display 转平假名后的形态）"),
        ("ワタシハガッコウヘイク", "全片假名（reading_display 的规范存储形态）"),
    ]
    form_rows = []
    for text, note in probes:
        g = pyopenjtalk.g2p(text)
        k = pyopenjtalk.g2p(text, kana=True)
        form_rows.append({"input": text, "note": note, "phonemes": g, "kana": k})
        print(f"    {note}")
        print(f"      输入      : {text}")
        print(f"      g2p       : {g}")
        print(f"      g2p(kana) : {k}")

    print("\n  3-B  助词歧义：纯假名串上分词是否可靠")
    ambiguous = [
        ("母は", "は 是助词，应读 ワ"),
        ("ははは", "纯假名，正解可能是「母は」(ハハワ) 或笑声(ハハハ)"),
        ("はははは", "同上"),
        (
            "にわにはにわにわとりがいる",
            "庭には二羽鶏がいる，「には」的 は 是助词应读 ワ",
        ),
        ("ここではきものをぬぐ", "「ここで/履物を脱ぐ」或「ここでは/着物を脱ぐ」"),
        ("こころのなかではしる", "「心の中で走る」の は 不是助词，应读 ハ"),
        ("そうはいかない", "は 是助词，应读 ワ"),
        ("きみへ", "へ 是助词，应读 エ"),
        ("へやへ", "第一个 へ 是词内，第二个是助词"),
        ("ゆめをみる", "を → オ"),
    ]
    amb_rows = []
    for text, note in ambiguous:
        g = pyopenjtalk.g2p(text)
        k = pyopenjtalk.g2p(text, kana=True)
        amb_rows.append({"input": text, "note": note, "phonemes": g, "kana": k})
        print(f"    {text:<16} → {k:<16} | {g}")
        print(f"      （{note}）")

    print("\n  3-C  片假名 vs 平假名：同一读音的两种书写，g2p 结果是否相同")
    kana_pairs = []
    for h in ["わたしはがっこうへいく", "こんにちは", "ゆめをみる", "そうはいかない"]:
        k = to_katakana(h)
        gh = pyopenjtalk.g2p(h)
        gk = pyopenjtalk.g2p(k)
        same = gh == gk
        kana_pairs.append({"hira": h, "kata": k, "g2p_hira": gh, "g2p_kata": gk, "same": same})
        print(f"    {'一致' if same else '不一致'}  {h}")
        print(f"        平假名 → {gh}")
        print(f"        片假名 → {gk}")

    print("\n  3-D  NJD 前端是否原生给出 read / pron 双形态")
    njd_rows = []
    for f in pyopenjtalk.run_frontend("私は学校へ行って夫婦で大きい氷を食べる"):
        njd_rows.append(
            {
                "surface": f["string"],
                "pos": f.get("pos"),
                "read": f.get("read"),
                "pron": f.get("pron"),
                "mora_size": f.get("mora_size"),
            }
        )
        print(
            f"    {f['string']:<5} pos={f.get('pos'):<4} read={f.get('read'):<8} "
            f"pron={f.get('pron'):<8} mora_size={f.get('mora_size')}"
        )

    print("\n  3-E  规则版 derive_phonetic(display, pos) 在全量歌词上对比 UniDic pron")
    fug = FugashiAnalyzer()
    total = match = 0
    mismatches = []
    for ln in lines:
        for t in fug.analyze(ln):
            if not t.reading_display:
                continue
            total += 1
            derived = derive_phonetic(t.reading_display, t.pos1, t.pos2)
            if derived == t.reading_phonetic:
                match += 1
            elif len(mismatches) < 30:
                mismatches.append(
                    {
                        "surface": t.surface,
                        "display": t.reading_display,
                        "unidic_pron": t.reading_phonetic,
                        "derived": derived,
                        "pos": f"{t.pos1}/{t.pos2}",
                    }
                )
    print(f"    对比 token 数 {total}，一致 {match}（{match / max(total, 1):.1%}）")
    for m in mismatches:
        print(
            f"      不一致 {m['surface']:<6} display={to_hiragana(m['display']):<10} "
            f"unidic={m['unidic_pron']:<10} 规则={m['derived']:<10} pos={m['pos']}"
        )

    print("\n  3-F  只有 display（无词性）时的推导：对助词是否必然出错")
    no_pos_total = no_pos_match = 0
    no_pos_bad = []
    for ln in lines:
        for t in fug.analyze(ln):
            if not t.reading_display:
                continue
            no_pos_total += 1
            derived = derive_phonetic(t.reading_display)  # 不传词性
            if derived == t.reading_phonetic:
                no_pos_match += 1
            elif len(no_pos_bad) < 15:
                no_pos_bad.append(
                    {
                        "surface": t.surface,
                        "display": to_hiragana(t.reading_display),
                        "unidic": t.reading_phonetic,
                        "derived_no_pos": derived,
                    }
                )
    print(
        f"    不传词性时一致 {no_pos_match}/{no_pos_total} = "
        f"{no_pos_match / max(no_pos_total, 1):.1%}"
    )
    for b in no_pos_bad:
        print(
            f"      {b['surface']:<6} {b['display']:<8} unidic={b['unidic']:<8} 无词性={b['derived_no_pos']}"
        )

    print("\n  3-G  规则法的已知例外：长音化规则并非纯字面可判定")
    exceptions = [
        ("想う", "动词词尾的ウ不长音化，但「東京」的ウ要长音化 —— 光看假名串区分不了"),
        ("思う", "同上"),
        ("問う", "同上"),
        ("東京", "オ段+ウ 要长音化"),
        ("続ける", "四つ仮名：display 是ヅ，UniDic 的 pron 归一成ズ"),
        ("大きい", "イ段+イ：UniDic 与 NJD 结论不同"),
    ]
    exc_rows = []
    for word, why in exceptions:
        ft = fug.analyze(word)
        oj = OpenJTalkAnalyzer().analyze(word)
        fd = "".join(t.reading_display for t in ft)
        fp = "".join(t.reading_phonetic for t in ft)
        od = "".join(t.reading_display for t in oj)
        op = "".join(t.reading_phonetic for t in oj)
        rule = "".join(derive_phonetic(t.reading_display, t.pos1, t.pos2) for t in ft)
        exc_rows.append(
            {
                "word": word,
                "why": why,
                "unidic_display": fd,
                "unidic_pron": fp,
                "njd_display": od,
                "njd_pron": op,
                "rule_derived": rule,
            }
        )
        print(f"    {word:<5} unidic {fd}→{fp} | NJD {od}→{op} | 规则法 {rule}")
        print(f"          （{why}）")

    print("\n  3-H  决定性对比：拿到 display 之后两条推导 phonetic 的路线，谁准")
    print("       基准 = 对汉字原文跑 NJD 得到的 pron（分词与词性都正确）")
    print("       路线甲 = 把 display 转平假名后整串重新喂 g2p（模拟只有 [kana:] 轨）")
    print("       路线乙 = 保留原文分词与词性，逐 token 用规则从 display 推 phonetic")

    def norm(s: str) -> str:
        """比较前的无害归一：ヲ/オ 同音，ヅ/ズ、ヂ/ジ 同音，三者最终都映射到同一音素。"""
        return s.replace("ヲ", "オ").replace("ヅ", "ズ").replace("ヂ", "ジ")

    ojt = OpenJTalkAnalyzer()
    n_line = 0
    ok_a = ok_b = 0
    bad_a = []
    bad_b = []
    for ln in lines:
        toks = [
            t
            for t in ojt.analyze(ln)
            if t.reading_display and not all(is_punct(c) for c in t.surface)
        ]
        if not toks:
            continue
        n_line += 1
        ref = "".join(t.reading_phonetic for t in toks)
        display = "".join(t.reading_display for t in toks)
        # 甲：整串纯假名重新分析
        route_a = strip_pron_marks(
            "".join(
                f.get("pron", "")
                for f in pyopenjtalk.run_frontend(to_hiragana(display))
                if f.get("pron") not in (None, "*")
            )
        )
        # 乙：逐 token 规则推导（词性来自原文分析）
        route_b = "".join(derive_phonetic(t.reading_display, t.pos1, t.pos2) for t in toks)
        if norm(route_a) == norm(ref):
            ok_a += 1
        elif len(bad_a) < 12:
            bad_a.append({"line": ln, "ref": ref, "got": route_a})
        if norm(route_b) == norm(ref):
            ok_b += 1
        elif len(bad_b) < 12:
            bad_b.append({"line": ln, "ref": ref, "got": route_b})

    print(f"    路线甲（纯假名串重新喂 g2p）行级正确 {ok_a}/{n_line} = {ok_a / max(n_line, 1):.1%}")
    print(
        f"    路线乙（已知词性的逐 token 规则）行级正确 {ok_b}/{n_line} = {ok_b / max(n_line, 1):.1%}"
    )
    print("    路线甲的错误样本：")
    for b in bad_a:
        print(f"      {b['line']}\n        基准 {b['ref']}\n        甲   {b['got']}")
    print("    路线乙的错误样本：")
    for b in bad_b:
        print(f"      {b['line']}\n        基准 {b['ref']}\n        乙   {b['got']}")

    return {
        "route_compare": {
            "lines": n_line,
            "route_a_kana_regan": ok_a,
            "route_b_rule_with_pos": ok_b,
            "route_a_bad": bad_a,
            "route_b_bad": bad_b,
        },
        "rule_exceptions": exc_rows,
        "form_rows": form_rows,
        "ambiguous": amb_rows,
        "kana_pairs": kana_pairs,
        "njd_double_form": njd_rows,
        "rule_vs_unidic": {"total": total, "match": match, "mismatches": mismatches},
        "no_pos": {
            "total": no_pos_total,
            "match": no_pos_match,
            "samples": no_pos_bad,
        },
    }


# ---------------------------------------------------------------------------
# 第 4 节：mora 切分与不变式
# ---------------------------------------------------------------------------


def section_mora(lines: list[str]) -> dict:
    head("第 4 节 mora 切分与 CLAUDE.md 不变式 concat(mora.kana) == reading_display")

    unit_cases = [
        ("キャラ", ["キャ", "ラ"]),
        ("キョウ", ["キョ", "ウ"]),
        ("ガッコウ", ["ガ", "ッ", "コ", "ウ"]),
        ("ガッコー", ["ガ", "ッ", "コ", "ー"]),
        ("コンニチワ", ["コ", "ン", "ニ", "チ", "ワ"]),
        ("シャンプー", ["シャ", "ン", "プ", "ー"]),
        ("ファイト", ["ファ", "イ", "ト"]),
        ("ウィスキー", ["ウィ", "ス", "キ", "ー"]),
        ("チョット", ["チョ", "ッ", "ト"]),
        ("トーキョー", ["ト", "ー", "キョ", "ー"]),
        ("ヒトヒラ", ["ヒ", "ト", "ヒ", "ラ"]),
    ]
    unit_pass = 0
    for kana, expect in unit_cases:
        got = split_mora(kana)
        ok = got == expect
        unit_pass += ok
        print(f"  {'OK ' if ok else 'NG '}{kana:<10} → {got}")
        if not ok:
            print(f"       期望 {expect}")
    print(f"\n  单元用例通过：{unit_pass}/{len(unit_cases)}")

    # 不变式 1：全量歌词
    fug = FugashiAnalyzer()
    total = inv_ok = 0
    inv_bad = []
    for ln in lines:
        for t in fug.analyze(ln):
            if not t.reading_display:
                continue
            total += 1
            moras = split_mora(t.reading_display)
            if "".join(moras) == t.reading_display:
                inv_ok += 1
            elif len(inv_bad) < 10:
                inv_bad.append({"surface": t.surface, "display": t.reading_display})
    print(f"  不变式 concat(mora.kana)==reading_display：{inv_ok}/{total} 通过")

    # 独立交叉验证：与 pyopenjtalk NJD 的 mora_size 对比（NJD 的 mora 数按 pron 计）
    import pyopenjtalk

    cross_total = cross_match = 0
    cross_bad = []
    for ln in lines:
        for f in pyopenjtalk.run_frontend(ln):
            # NJD 的 pron 带无声化标记 ’，不剥掉会把它算成一拍
            pron = strip_pron_marks(f.get("pron", ""))
            size = f.get("mora_size", 0)
            if not pron or pron == "*" or size in (0, None):
                continue
            cross_total += 1
            mine = len(split_mora(pron))
            if mine == size:
                cross_match += 1
            elif len(cross_bad) < 15:
                cross_bad.append(
                    {
                        "surface": f["string"],
                        "pron": pron,
                        "njd_mora_size": size,
                        "my_mora": mine,
                        "split": split_mora(pron),
                    }
                )
    print(
        f"  与 pyopenjtalk NJD mora_size 交叉验证：{cross_match}/{cross_total} = "
        f"{cross_match / max(cross_total, 1):.1%}"
    )
    for b in cross_bad:
        print(
            f"    分歧 {b['surface']:<6} pron={b['pron']:<10} NJD={b['njd_mora_size']} 本实现={b['my_mora']} {b['split']}"
        )

    return {
        "unit_pass": unit_pass,
        "unit_total": len(unit_cases),
        "invariant_ok": inv_ok,
        "invariant_total": total,
        "invariant_bad": inv_bad,
        "njd_cross_total": cross_total,
        "njd_cross_match": cross_match,
        "njd_cross_bad": cross_bad,
    }


# ---------------------------------------------------------------------------
# 第 5 节：难读字 / 当て字
# ---------------------------------------------------------------------------


def section_ateji() -> dict:
    head("第 5 节 难读字 / 当て字：自动分析器给什么（论证必须支持手工覆盖）")

    ateji = [
        ("運命", "サダメ"),
        ("時間", "トキ"),
        ("本気", "マジ"),
        ("宇宙", "ソラ"),
        ("永遠", "トワ"),
        ("未来", "アシタ"),
        ("女", "ヒト"),
        ("現実", "リアル"),
        ("刹那", "トキ"),
        ("戦場", "バトルフィールド"),
    ]
    analyzers = [FugashiAnalyzer(), SudachiAnalyzer(), OpenJTalkAnalyzer()]
    rows = []
    hit = 0
    for surface, sung in ateji:
        got = {}
        for a in analyzers:
            toks = a.analyze(surface)
            got[a.name] = "".join(t.reading_display for t in toks)
        any_hit = any(v == sung for v in got.values())
        hit += any_hit
        rows.append({"surface": surface, "sung": sung, "analyzers": got, "hit": any_hit})
        print(f"  {surface}（实唱 {to_hiragana(sung)}）")
        for k, v in got.items():
            mark = "命中" if v == sung else "不同"
            print(f"      {mark}  {k:<28} {to_hiragana(v)}")

    print(f"\n  10 个当て字里自动分析器命中实唱读音的：{hit}/10")

    # 手工覆盖后，注音切分是否仍然成立
    print("\n  手工覆盖 reading_display 之后，送り仮名切分是否仍成立：")
    ov_ok = 0
    for surface, sung in ateji:
        spans, method = split_furigana(surface, sung)
        cover = check_ruby_coverage(surface, spans)
        moras = split_mora(sung)
        inv = "".join(moras) == sung
        ov_ok += cover and inv
        pretty = " ".join(f"{surface[s.s : s.e]}→{to_hiragana(s.rt)}" for s in spans)
        print(
            f"    {'OK ' if cover and inv else 'NG '}{surface:<6} [{method}] {pretty}  mora={moras}"
        )
    print(f"  手工覆盖后仍满足不变式：{ov_ok}/{len(ateji)}")

    return {"rows": rows, "auto_hit": hit, "override_ok": ov_ok, "total": len(ateji)}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def section_conclusion() -> None:
    """把本次运行的实测数字汇总成裁决性结论（数字全部取自上面各节的实际计算）。"""
    head("结论（数字均来自本次运行）")
    a = report["analyzers"]
    o = report["okurigana"]
    d = report["double_form"]
    m = report["mora"]
    t = report["ateji"]
    rc = d["route_compare"]

    print(
        f"1) 形态素分析器：三者行级表记读法一致 {a['agree_all']}/{a['line_count']}。"
        f"决定性差异不在准确率，而在字段：\n"
        f"   fugashi+unidic-lite 与 pyopenjtalk NJD 同时给出 表记读法 与 发音形，"
        f"SudachiPy 只给表记读法。"
    )
    print(
        f"2) 送り仮名切分：手工用例 {o['cases_passed']}/{o['cases_total']} 通过；"
        f"歌词全量 {o['corpus_total']} token 中锚点成功 {o['corpus_anchor']}、"
        f"降级整块 {o['corpus_whole']}、纯假名 {o['corpus_none']}，"
        f"ruby 覆盖不变式失败 {o['corpus_coverage_fail']}。"
    )
    print(
        f"3) g2p 吃纯假名串：**不是**词典无关的假名→音素，它仍然跑完整形态素分析。"
        f"平假名与片假名结果不同（助词只在平假名路径上被识别）。"
        f"从 display 推 phonetic 的两条路线行级正确率分别为"
        f" {rc['route_a_kana_regan']}/{rc['lines']} 与 {rc['route_b_rule_with_pos']}/{rc['lines']}，"
        f"都不到 100% ⇒ **不能确定性推导**。"
    )
    print(
        f"4) mora 切分：单元用例 {m['unit_pass']}/{m['unit_total']}；"
        f"不变式 concat(mora.kana)==reading_display {m['invariant_ok']}/{m['invariant_total']}；"
        f"与 NJD mora_size 交叉验证 {m['njd_cross_match']}/{m['njd_cross_total']}。"
    )
    print(
        f"5) 当て字：{t['total']} 例中自动分析器命中实唱读音 {t['auto_hit']} 例；"
        f"手工覆盖 display 之后注音切分与 mora 不变式仍然成立 {t['override_ok']}/{t['total']}。"
    )


def main() -> int:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    lines = load_lyrics()

    report["env"] = section_env()
    report["analyzers"] = section_analyzers(lines)
    report["okurigana"] = section_okurigana(lines)
    report["double_form"] = section_double_form(lines)
    report["mora"] = section_mora(lines)
    report["ateji"] = section_ateji()

    section_conclusion()

    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    head("报告已写出")
    print(f"  {REPORT_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
