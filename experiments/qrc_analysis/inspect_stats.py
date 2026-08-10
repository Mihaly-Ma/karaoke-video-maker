# -*- coding: utf-8 -*-
"""对解析结果做补充统计"""

import json
import pathlib

d = pathlib.Path(__file__).parent
j = json.loads((d / "qrc_parsed.json").read_text(encoding="utf-8"))
lines = j["lines"]
print("总行数", len(lines))
multi = [
    (t["text"], t["start_ms"], t["dur_ms"])
    for ln in lines
    for t in ln["tokens"]
    if len(t["text"]) != 1
]
print("非单字符块:", multi)

first_vocal = 774
credits = [ln for ln in lines if ln["start_ms"] < first_vocal]
print("首句人声前的行(制作名单候选)数 =", len(credits))
for ln in credits:
    print("   ", ln["start_ms"], ln["text"])

body = [ln for ln in lines if ln["start_ms"] >= first_vocal]
print("正文行数 =", len(body))
toks = [t for ln in body for t in ln["tokens"]]
print("正文逐字块数 =", len(toks))
print(
    "正文块时长(ms) 中位/最小/最大 =",
    sorted(t["dur_ms"] for t in toks)[len(toks) // 2],
    min(t["dur_ms"] for t in toks),
    max(t["dur_ms"] for t in toks),
)
print("末行结束 =", body[-1]["start_ms"] + body[-1]["dur_ms"], "ms （曲长 260s）")

# 逐字块 vs 假名读音的 mora 数
kana = json.loads((d / "kana_entries.json").read_text(encoding="utf-8"))
timed = [e for e in kana if e["mora_timings"]]
print("\n带逐拍时间的 kana 条目样例:")
for e in timed[:8]:
    print("   ", e["reading"], e["mora_timings"])

# 罗马音轨粒度对照
roma = (d / "roma_content.txt").read_text(encoding="utf-8").split("\n")
print("\nroma 第 10 行:", roma[10][:200])
print("lyric 第 11 行:", lines[10]["text"][:60] if len(lines) > 10 else "")
print("\n正文前 3 行完整:")
for ln in body[:3]:
    print(
        "  [%d,%d]%s"
        % (
            ln["start_ms"],
            ln["dur_ms"],
            "".join("%s(%d,%d)" % (t["text"], t["start_ms"], t["dur_ms"]) for t in ln["tokens"]),
        )
    )
