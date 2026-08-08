# -*- coding: utf-8 -*-
"""按真实换行切开 LyricContent（不能用 XML 解析器：属性值里的换行会被规范化成空格）"""
import html
import pathlib
import re

d = pathlib.Path(__file__).parent
for name in ("lyric", "roma", "trans"):
    t = (d / ("%s_decrypted.xml" % name)).read_text(encoding="utf-8")
    m = re.search(r'LyricContent="(.*)"\s*/>', t, re.S)
    if not m:
        print("### %s 不是 XML，直接当纯文本" % name)
        content = t
    else:
        content = html.unescape(m.group(1))
    lines = content.split("\n")
    print("\n########## %s : %d 字符, %d 行" % (name, len(content), len(lines)))
    for i, ln in enumerate(lines[:14]):
        print("  %2d | %s" % (i, ln[:200]))
    (d / ("%s_content.txt" % name)).write_text(content, encoding="utf-8")
