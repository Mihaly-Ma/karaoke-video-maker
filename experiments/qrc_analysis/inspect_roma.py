# -*- coding: utf-8 -*-
"""罗马音轨粒度 + 零时长块统计"""

import json
import pathlib
import re

d = pathlib.Path(__file__).parent
lines = json.loads((d / "qrc_parsed.json").read_text(encoding="utf-8"))["lines"]
toks = [t for ln in lines for t in ln["tokens"]]
zero = [t for t in toks if t["dur_ms"] == 0]
print("零时长逐字块数 =", len(zero), "样例:", [(t["text"], t["start_ms"]) for t in zero[:6]])

roma = (d / "roma_content.txt").read_text(encoding="utf-8").split("\n")
tok_re = re.compile(r"(.*?)\((\d+),(\d+)\)", re.S)
line_re = re.compile(r"^\[(\d+),(\d+)\](.*)$")
rlines, rtok = 0, 0
gapful = 0
for ln in roma:
    m = line_re.match(ln)
    if not m:
        continue
    rlines += 1
    ts = [(a, int(b), int(c)) for a, b, c in tok_re.findall(m.group(3))]
    rtok += len(ts)
    for x, y in zip(ts, ts[1:]):
        if x[1] + x[2] != y[1]:
            gapful += 1
print("roma 行数 =", rlines, " roma 音节块数 =", rtok)
print("roma 相邻块「上一块 end != 下一块 start」次数 =", gapful, "（说明 roma 时间不密铺）")
print("lyric 逐字块数 =", len(toks))
