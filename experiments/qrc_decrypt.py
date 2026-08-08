# -*- coding: utf-8 -*-
"""P0-3 实验：QQ音乐 QRC 逐字歌词链路端到端裁决。

目标：独立验证「搜索 → 拉取 → 解密 → 解析」四步是否真的闭环，
并给出赤春花 (feat. 幾田りら) 的实际粒度 / 假名轨 / Cookie 依赖结论。

四个步骤：
  1. 搜索        smartbox_new.fcg / search_for_qq_cp / musicu.fcg 三路取 songmid
  2. 拉取歌词    POST musicu.fcg  module=music.musichallSong.PlayLyricInfo
                 （另外对照 fcg_query_lyric_new.fcg，验证它只给行级 LRC）
  3. 解密        魔改（含笔误 S-box 的）三重 DES-ECB + zlib inflate
  4. 解析        QRC XML → LyricContent → 逐字时间轴 + [kana:] 假名轨

关于 DES 实现的说明（合规声明）：
  本文件的 DES 是**本项目自己用 Python 写的**。腾讯 QRC 用的不是标准 DES —— 它内嵌的
  是 B-Con/crypto-algorithms 那份 C 语言 des.c，其 S-box 有两处笔误，且字节序在 32 位字
  内是反的。这些常量属于事实性数据（不受版权保护），我们阅读 MIT 许可的
  WXRIW/QQMusicDecoder（C#）核对了表值后，用 Python 重新实现全部逻辑。
  **没有下载、导入或执行任何第三方代码。**

运行：
  uv run --python 3.12 --with requests --with pycryptodome python -m experiments.qrc_decrypt
  （pycryptodome 只用于「标准 3DES 必然失败」的对照实验，缺失时自动跳过）
"""

from __future__ import annotations

import argparse
import html
import json
import pathlib
import re
import sys
import zlib
from collections import Counter

import requests

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

QRC_KEY = b"!@#)(*$%123ZXC!@!@#)(NHL"  # 24 字节 = 三重 DES 的三段子密钥

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# fcg_query_lyric_new.fcg 少了这个 Referer 会返回 retcode=-1310
PLAYER_REFERER = "https://y.qq.com/portal/player.html"

DEFAULT_QUERY = "赤春花 sumika"

OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "workspace" / "qrc"


# ---------------------------------------------------------------------------
# 第 3 步的核心：魔改 DES
# ---------------------------------------------------------------------------

ENCRYPT = 1
DECRYPT = 0

# 标准 DES 的 8 张 S-box，但其中两处是腾讯沿用的笔误值：
#   SBOX2[23] = 15（标准是 14）
#   SBOX4[53] = 10（标准是 1）
# 这两处就是「pycryptodome / cryptography 的标准 DES3 解出垃圾」的全部原因。
SBOX = (
    (14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
     0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
     4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
     15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13),
    (15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
     3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,   # <- 索引 23：笔误 15
     0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
     13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9),
    (10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
     13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
     13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
     1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12),
    (7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
     13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
     10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
     3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14),  # <- 索引 53：笔误 10
    (2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
     14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
     4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
     11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3),
    (12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
     10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
     9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
     4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13),
    (4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
     13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
     1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
     6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12),
    (13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
     1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
     7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
     2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11),
)

# 标准 DES 的 PC-1（拆成 C / D 两半）与 PC-2，均已改为 0 起始下标
KEY_PERM_C = (56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17,
              9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35)
KEY_PERM_D = (62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
              13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3)
KEY_COMPRESSION = (13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9,
                   22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
                   40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47,
                   43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31)
KEY_RND_SHIFT = (1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1)

# 初始置换 IP，拆成左右两半（0 起始）
IP_L = (57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
        61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7)
IP_R = (56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
        60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6)

# 轮函数末尾的 P 置换：(取 state 的第 b 位, 放到输出第 c 位)，b/c 均以 MSB 为 0
P_PERM = ((15, 0), (6, 1), (19, 2), (20, 3), (28, 4), (11, 5), (27, 6), (16, 7),
          (0, 8), (14, 9), (22, 10), (25, 11), (4, 12), (17, 13), (30, 14), (9, 15),
          (1, 16), (7, 17), (23, 18), (13, 19), (31, 20), (26, 21), (2, 22), (8, 23),
          (18, 24), (12, 25), (29, 26), (5, 27), (21, 28), (10, 29), (3, 30), (24, 31))

# InvIP：输出字节写入顺序 —— 注意这里是 32 位字内字节逆序（DES 本身没有这一步，
# 是这份 C 实现的 BITNUM 宏带来的固有字节序特性，必须原样复刻）
_INVIP_BYTE_ORDER = (3, 2, 1, 0, 7, 6, 5, 4)


def _bitnum(buf: bytes, b: int, c: int) -> int:
    """取 buf 的第 b 位（MSB 优先），左移到第 c 位。

    字节下标是 (b // 32) * 4 + 3 - (b % 32) // 8，即每 4 字节一组内部逆序，
    等价于先把 8 字节块按 [3,2,1,0,7,6,5,4] 重排再按标准位序取。
    """
    idx = (b // 32) * 4 + 3 - (b % 32) // 8
    return ((buf[idx] >> (7 - (b % 8))) & 1) << c


def _bit_r(a: int, b: int, c: int) -> int:
    """取 32 位整数 a 的第 b 位（MSB 为 0），左移到第 c 位。"""
    return ((a >> (31 - b)) & 1) << c


def _bit_l(a: int, b: int, c: int) -> int:
    """取 32 位整数 a 的第 b 位（MSB 为 0），放到「MSB 起第 c 位」。"""
    return ((a << b) & 0x80000000) >> c


def _sboxbit(a: int) -> int:
    """把 6 位输入重排成行主序扁平 S-box 的下标。"""
    return (a & 0x20) | ((a & 0x1F) >> 1) | ((a & 0x01) << 4)


def des_key_schedule(key8: bytes, mode: int) -> list[list[int]]:
    """生成 16 轮子密钥，每轮 6 字节。mode=DECRYPT 时轮序倒排。"""
    schedule = [[0] * 6 for _ in range(16)]
    c = d = 0
    for i in range(28):
        c |= _bitnum(key8, KEY_PERM_C[i], 31 - i)
        d |= _bitnum(key8, KEY_PERM_D[i], 31 - i)

    for i in range(16):
        s = KEY_RND_SHIFT[i]
        # C/D 各 28 位，左对齐存放在 32 位整数的高位（bit31..bit4）
        c = ((c << s) | (c >> (28 - s))) & 0xFFFFFFF0
        d = ((d << s) | (d >> (28 - s))) & 0xFFFFFFF0

        to_gen = (15 - i) if mode == DECRYPT else i
        rk = schedule[to_gen]
        for j in range(24):
            rk[j >> 3] |= _bit_r(c, KEY_COMPRESSION[j], 7 - (j & 7))
        for j in range(24, 48):
            # 注意这里减的是 27 而不是 28 —— 这是原 C 实现的固有偏移，
            # 导致 PC-2 的最后一位恒取到被 0xFFFFFFF0 抹掉的 0。照抄。
            rk[j >> 3] |= _bit_r(d, KEY_COMPRESSION[j] - 27, 7 - (j & 7))
    return schedule


def _ip(block: bytes) -> tuple[int, int]:
    left = right = 0
    for k in range(32):
        left |= _bitnum(block, IP_L[k], 31 - k)
        right |= _bitnum(block, IP_R[k], 31 - k)
    return left, right


def _inv_ip(s0: int, s1: int) -> bytes:
    out = bytearray(8)
    for k in range(8):
        base = 7 - k
        v = 0
        for t in range(4):
            v |= _bit_r(s1, base + 8 * t, 7 - 2 * t)
            v |= _bit_r(s0, base + 8 * t, 6 - 2 * t)
        out[_INVIP_BYTE_ORDER[k]] = v
    return bytes(out)


def _f(state: int, key6: list[int]) -> int:
    """DES 轮函数：扩展置换 E → 与子密钥异或 → 8 张 S-box → P 置换。"""
    t1 = (_bit_l(state, 31, 0) | ((state & 0xF0000000) >> 1) | _bit_l(state, 4, 5)
          | _bit_l(state, 3, 6) | ((state & 0x0F000000) >> 3) | _bit_l(state, 8, 11)
          | _bit_l(state, 7, 12) | ((state & 0x00F00000) >> 5) | _bit_l(state, 12, 17)
          | _bit_l(state, 11, 18) | ((state & 0x000F0000) >> 7) | _bit_l(state, 16, 23))
    t2 = (_bit_l(state, 15, 0) | ((state & 0x0000F000) << 15) | _bit_l(state, 20, 5)
          | _bit_l(state, 19, 6) | ((state & 0x00000F00) << 13) | _bit_l(state, 24, 11)
          | _bit_l(state, 23, 12) | ((state & 0x000000F0) << 11) | _bit_l(state, 28, 17)
          | _bit_l(state, 27, 18) | ((state & 0x0000000F) << 9) | _bit_l(state, 0, 23))
    t1 &= 0xFFFFFFFF
    t2 &= 0xFFFFFFFF

    b0 = ((t1 >> 24) & 0xFF) ^ key6[0]
    b1 = ((t1 >> 16) & 0xFF) ^ key6[1]
    b2 = ((t1 >> 8) & 0xFF) ^ key6[2]
    b3 = ((t2 >> 24) & 0xFF) ^ key6[3]
    b4 = ((t2 >> 16) & 0xFF) ^ key6[4]
    b5 = ((t2 >> 8) & 0xFF) ^ key6[5]

    state = ((SBOX[0][_sboxbit(b0 >> 2)] << 28)
             | (SBOX[1][_sboxbit(((b0 & 0x03) << 4) | (b1 >> 4))] << 24)
             | (SBOX[2][_sboxbit(((b1 & 0x0F) << 2) | (b2 >> 6))] << 20)
             | (SBOX[3][_sboxbit(b2 & 0x3F)] << 16)
             | (SBOX[4][_sboxbit(b3 >> 2)] << 12)
             | (SBOX[5][_sboxbit(((b3 & 0x03) << 4) | (b4 >> 4))] << 8)
             | (SBOX[6][_sboxbit(((b4 & 0x0F) << 2) | (b5 >> 6))] << 4)
             | SBOX[7][_sboxbit(b5 & 0x3F)])

    out = 0
    for b, c in P_PERM:
        out |= _bit_l(state, b, c)
    return out & 0xFFFFFFFF


def des_crypt_block(block: bytes, schedule: list[list[int]]) -> bytes:
    s0, s1 = _ip(block)
    for idx in range(15):
        t = s1
        s1 = _f(s1, schedule[idx]) ^ s0
        s0 = t
    s0 = _f(s1, schedule[15]) ^ s0
    return _inv_ip(s0, s1)


def triple_des_setup(key24: bytes, mode: int) -> list[list[list[int]]]:
    """三重 DES 的子密钥组装。解密时序为 D(k3) → E(k2) → D(k1)。"""
    sch: list[list[list[int]]] = [None, None, None]  # type: ignore[list-item]
    if mode == ENCRYPT:
        sch[0] = des_key_schedule(key24[0:8], ENCRYPT)
        sch[1] = des_key_schedule(key24[8:16], DECRYPT)
        sch[2] = des_key_schedule(key24[16:24], ENCRYPT)
    else:
        sch[2] = des_key_schedule(key24[0:8], DECRYPT)
        sch[1] = des_key_schedule(key24[8:16], ENCRYPT)
        sch[0] = des_key_schedule(key24[16:24], DECRYPT)
    return sch


def triple_des_ecb(data: bytes, key24: bytes, mode: int) -> bytes:
    if len(data) % 8:
        raise ValueError("密文长度 %d 不是 8 的倍数" % len(data))
    sch = triple_des_setup(key24, mode)
    out = bytearray()
    for i in range(0, len(data), 8):
        blk = des_crypt_block(data[i:i + 8], sch[0])
        blk = des_crypt_block(blk, sch[1])
        blk = des_crypt_block(blk, sch[2])
        out.extend(blk)
    return bytes(out)


def qrc_decrypt(encrypted_hex: str) -> bytes:
    """QRC 密文（hex 字符串）→ 魔改 3DES-ECB 解密 → zlib inflate → 明文字节。"""
    raw = bytes.fromhex(encrypted_hex.strip())
    plain = triple_des_ecb(raw, QRC_KEY, DECRYPT)
    return zlib.decompress(plain)


# ---------------------------------------------------------------------------
# 第 1 / 2 步：网络访问
# ---------------------------------------------------------------------------

def new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    return s


def search_smartbox(s: requests.Session, query: str) -> list[dict]:
    r = s.get("https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg",
              params={"key": query, "format": "json", "g_tk": 5381, "utf8": 1,
                      "loginUin": 0, "hostUin": 0, "inCharset": "utf8",
                      "outCharset": "utf-8", "platform": "yqq"},
              headers={"Referer": PLAYER_REFERER}, timeout=20)
    r.raise_for_status()
    items = r.json().get("data", {}).get("song", {}).get("itemlist", [])
    return [{"songmid": it["mid"], "songid": int(it["id"]), "name": it["name"],
             "singer": it.get("singer", ""), "interval": None} for it in items]


def search_soso(s: requests.Session, query: str) -> list[dict]:
    r = s.get("https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
              params={"g_tk": 5381, "format": "json", "inCharset": "utf-8",
                      "outCharset": "utf-8", "notice": 0, "platform": "yqq.json",
                      "needNewCode": 0, "w": query, "p": 1, "n": 20, "t": 0,
                      "aggr": 1, "cr": 1, "lossless": 0, "flag_qc": 0},
              headers={"Referer": PLAYER_REFERER}, timeout=20)
    r.raise_for_status()
    out = []
    for it in r.json().get("data", {}).get("song", {}).get("list", []):
        out.append({"songmid": it["songmid"], "songid": int(it["songid"]),
                    "name": it["songname"],
                    "singer": "/".join(x["name"] for x in it.get("singer", [])),
                    "interval": it.get("interval"),
                    "album": it.get("albumname", "")})
    return out


def fetch_play_lyric(s: requests.Session, songmid: str, songid: int) -> dict:
    """POST musicu.fcg 取 QRC/roma/trans（均为 hex 密文）。"""
    body = {
        "comm": {"ct": 19, "cv": 1859, "uin": "0"},
        "req": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": {"songMID": songmid, "songID": songid,
                      "crypt": 1, "qrc": 1, "roma": 1, "trans": 1,
                      "lrc_t": 0, "qrc_t": 0, "roma_t": 0, "trans_t": 0,
                      "interval": 0, "type": 0, "format": "json",
                      "ct": 19, "cv": 1859},
        },
    }
    r = s.post("https://u.y.qq.com/cgi-bin/musicu.fcg",
               data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
               headers={"Referer": "https://y.qq.com/"}, timeout=20)
    r.raise_for_status()
    return r.json()["req"]["data"]


def fetch_query_lyric_new(s: requests.Session, songmid: str,
                          with_referer: bool) -> dict:
    """对照实验：fcg_query_lyric_new.fcg —— 缺 Referer 返回 -1310，且只给行级 LRC。"""
    h = {"Referer": PLAYER_REFERER} if with_referer else {}
    r = s.get("https://i.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
              params={"songmid": songmid, "g_tk": 5381, "format": "json",
                      "nobase64": 1, "loginUin": 0, "hostUin": 0,
                      "inCharset": "utf8", "outCharset": "utf-8",
                      "platform": "yqq", "needNewCode": 0},
              headers=h, timeout=20)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# 第 4 步：解析
# ---------------------------------------------------------------------------

_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
_TOKEN_RE = re.compile(r"(.*?)\((\d+),(\d+)\)", re.S)
_CONTENT_RE = re.compile(r'LyricContent="(.*)"\s*/>', re.S)
# CJK 统一表意文字（含扩展 A、兼容区），用于 [kana:] 的「基字符」定义
_KANJI_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


def extract_lyric_content(xml_text: str) -> str:
    """从 QRC XML 里取出 LyricContent 属性。

    **绝对不能用 XML 解析器。** LyricContent 里的行分隔符是字面换行符（0x0A），
    而 XML 规范要求属性值规范化时把换行替换成空格 —— ElementTree / lxml 都会照做，
    结果整篇歌词被压成一行，行结构彻底丢失。必须用正则取原文再手工反转义。
    """
    if "LyricContent=" not in xml_text:
        return xml_text  # trans 轨不是 XML，本身就是纯文本 LRC
    m = _CONTENT_RE.search(xml_text)
    if not m:
        raise ValueError("XML 中找不到 LyricContent 属性")
    return html.unescape(m.group(1))


def parse_qrc_content(content: str) -> tuple[dict, list[dict]]:
    """把 QRC 正文拆成 (元数据标签, 逐字行列表)。

    行格式：[起始ms,时长ms]字块(起始ms,时长ms)字块(起始ms,时长ms)...
    注意第二个数是 duration 不是 end。
    """
    meta: dict[str, str] = {}
    lines: list[dict] = []
    for raw in content.splitlines():
        raw = raw.rstrip("\r")
        if not raw.strip():
            continue
        m = _LINE_RE.match(raw)
        if not m:
            tag = re.match(r"^\[([a-zA-Z_]+):(.*)\]$", raw.strip(), re.S)
            if tag:
                meta[tag.group(1)] = tag.group(2)
            continue
        start, dur, body = int(m.group(1)), int(m.group(2)), m.group(3)
        tokens = []
        for tm in _TOKEN_RE.finditer(body):
            tokens.append({"text": tm.group(1),
                           "start_ms": int(tm.group(2)),
                           "dur_ms": int(tm.group(3))})
        lines.append({"start_ms": start, "dur_ms": dur,
                      "text": "".join(t["text"] for t in tokens),
                      "tokens": tokens})
    return meta, lines


def parse_kana_track(kana: str) -> list[dict]:
    """解析 [kana:] 轨。

    格式是无锚点的流：<一位数字N><读音>，N = 该条目覆盖的连续「基字符（汉字）」数。
    **N 必须按单个数字读**：正文里出现的 `111111` 是 6 个 N=1 的条目（前 5 个读音为空），
    用 `\\d+` 贪婪匹配会读成 N=111111，是 CLAUDE.md 里那个「整体错位」坑的成因之一。

    QRC（而非 LRC）里的读音还可能自带逐拍时间：`さ(774,242)く(1016,183)ら(1199,240)`。
    """
    out: list[dict] = []
    i, n_ = 0, len(kana)
    while i < n_:
        if not kana[i].isdigit():
            # 流被污染，停止解析（消费端应整行丢弃注音而不是错位显示）
            break
        cover = int(kana[i])
        i += 1
        reading, timings = [], []
        while i < n_:
            ch = kana[i]
            if ch == "(":
                j = kana.find(")", i)
                if j < 0:
                    break
                t, d = kana[i + 1:j].split(",")
                timings.append((int(t), int(d)))
                i = j + 1
            elif ch.isdigit():
                break
            else:
                reading.append(ch)
                i += 1
        out.append({"cover": cover, "reading": "".join(reading),
                    "mora_timings": timings})
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def hr(title: str) -> None:
    print("\n" + "=" * 78)
    print("== " + title)
    print("=" * 78)


def self_test_des() -> None:
    """自检：确认我们的实现确实**不是**标准 3DES（对照 pycryptodome）。"""
    hr("步骤 0 / 自检：魔改 DES vs 标准 3DES")
    sample = bytes(range(8))
    mine = triple_des_ecb(sample, QRC_KEY, DECRYPT)
    print(f"  自研魔改 3DES-ECB 解一块: {mine.hex()}")
    try:
        from Crypto.Cipher import DES3  # type: ignore
    except Exception as e:  # noqa: BLE001
        print(f"  （未安装 pycryptodome，跳过标准 3DES 对照）{e}")
        return
    for name, key in (("原序 K1K2K3", QRC_KEY),
                      ("逆序 K3K2K1", QRC_KEY[16:] + QRC_KEY[8:16] + QRC_KEY[:8])):
        std = DES3.new(key, DES3.MODE_ECB).decrypt(sample)
        print(f"  标准 3DES-ECB({name}) 解一块: {std.hex()}   与自研相同={std == mine}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default=DEFAULT_QUERY)
    ap.add_argument("--songmid", default=None, help="跳过搜索，直接指定 songmid")
    ap.add_argument("--songid", type=int, default=None)
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    s = new_session()

    self_test_des()

    # ---- 步骤 1：搜索 ----------------------------------------------------
    hr("步骤 1 / 搜索 songmid（全程不带任何 Cookie）")
    if args.songmid:
        songmid, songid = args.songmid, args.songid or 0
        print(f"  用户指定 songmid={songmid} songid={songid}")
    else:
        sb = search_smartbox(s, args.query)
        print("  smartbox_new.fcg 命中 %d 条" % len(sb))
        for it in sb[:5]:
            print("    - {} | {} | mid={} id={}".format(it["name"], it["singer"], it["songmid"], it["songid"]))
        so = search_soso(s, args.query)
        print("  search_for_qq_cp 命中 %d 条" % len(so))
        if args.query == DEFAULT_QUERY:
            # 验证曲专用：2025 年 FM802 版「赤春花」署名 Studio April / 247s，
            # 必须用「歌手含 sumika」+「时长≈260s」双条件把它排掉（CLAUDE.md §6.1 版本混淆坑）
            print("  → 验证曲双条件过滤：歌手含 sumika 且 时长≈260s")
            cands = [x for x in so if "sumika" in x["singer"].lower()
                     and abs((x["interval"] or 0) - 260) <= 3]
        else:
            cands = so
        for it in cands[:5]:
            print("    - {} | {} | {}s | 专辑={} | mid={}".format(it["name"], it["singer"], it["interval"], it.get("album"), it["songmid"]))
        if not cands:
            print("  !! 双条件过滤后为空，退回 smartbox 首条")
            cands = sb
        songmid, songid = cands[0]["songmid"], cands[0]["songid"]
        print(f"  => 选定 songmid={songmid} songid={songid}")

    # ---- 步骤 2：拉取 ----------------------------------------------------
    hr("步骤 2 / 拉取歌词")
    for flag in (False, True):
        j = fetch_query_lyric_new(s, songmid, flag)
        lyr = j.get("lyric", "")
        print("  fcg_query_lyric_new.fcg  Referer=%-5s retcode=%s lyric长度=%d"
              % (flag, j.get("retcode"), len(lyr)))
        if flag and lyr:
            (OUT_DIR / "fcg_query_lyric_new.lrc").write_text(lyr, encoding="utf-8")
            print("       前 3 行: {}".format(" | ".join(lyr.splitlines()[:3])))
            print("       是否含逐字括号 (ms,ms): {}".format(bool(re.search(r"\(\d+,\d+\)", lyr))))
            print("       是否含 [kana:]: %s" % ("[kana:" in lyr))

    data = fetch_play_lyric(s, songmid, songid)
    (OUT_DIR / "playlyricinfo_raw.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("  musicu.fcg PlayLyricInfo: qrc={} crypt={} startTs={}".format(data.get("qrc"), data.get("crypt"), data.get("startTs")))
    for k in ("lyric", "trans", "roma"):
        v = data.get(k) or ""
        print("    %-6s hex长度=%-6d → 密文 %d 字节, 前 40 hex=%s"
              % (k, len(v), len(v) // 2, v[:40]))
        if v:
            (OUT_DIR / (f"{k}.hex")).write_text(v, encoding="ascii")

    if not data.get("lyric"):
        print("  !! lyric 字段为空，链路在第 2 步断掉")
        return 2

    # ---- 步骤 3：解密 ----------------------------------------------------
    hr("步骤 3 / 解密（魔改 3DES-ECB + zlib）")
    results: dict[str, str] = {}
    for k in ("lyric", "trans", "roma"):
        v = data.get(k) or ""
        if not v:
            continue
        try:
            plain = qrc_decrypt(v)
        except Exception as e:  # noqa: BLE001
            print("  %-6s 解密失败: %r" % (k, e))
            continue
        text = plain.decode("utf-8", errors="replace")
        results[k] = text
        (OUT_DIR / (f"{k}_decrypted.xml")).write_text(text, encoding="utf-8")
        print("  %-6s 解密成功: 明文 %d 字节 / %d 字符" % (k, len(plain), len(text)))
        print("         前 200 字符 >>> {}".format(text[:200].replace("\n", "\\n")))

    if "lyric" not in results:
        print("  !! 主歌词解密失败，链路在第 3 步断掉")
        return 3

    # ---- 步骤 4：解析 ----------------------------------------------------
    hr("步骤 4 / 解析 QRC")
    content = extract_lyric_content(results["lyric"])
    (OUT_DIR / "lyric_content.qrc").write_text(content, encoding="utf-8")
    meta, lines = parse_qrc_content(content)
    print("  LyricContent 长度=%d 字符，元数据标签=%s" % (len(content), list(meta)))
    print("  逐字行数=%d" % len(lines))
    tok_total = sum(len(x["tokens"]) for x in lines)
    print("  逐字块总数=%d，平均每行 %.1f 块" % (tok_total, tok_total / max(len(lines), 1)))

    cnt = Counter(len(t["text"]) for x in lines for t in x["tokens"])
    print(f"  块字符数分布（块长度: 出现次数）: {dict(sorted(cnt.items()))}")
    single = cnt.get(1, 0)
    print("  单字符块占比 = %.1f%%" % (100.0 * single / max(tok_total, 1)))

    print("\n  前 6 行原样：")
    for ln in lines[:6]:
        toks = "".join("%s(%d,%d)" % (t["text"], t["start_ms"], t["dur_ms"])
                       for t in ln["tokens"])
        print("    [%d,%d]%s" % (ln["start_ms"], ln["dur_ms"], toks[:120]))

    # 时间轴一致性抽查：第二个数是 duration 而非 end
    bad = 0
    for ln in lines:
        for a, b in zip(ln["tokens"], ln["tokens"][1:]):
            if a["start_ms"] + a["dur_ms"] > b["start_ms"] + 1:
                bad += 1
    print("\n  相邻块 start+dur > 下一块 start 的次数 = %d（若接近 0 则第二个数确为 duration）"
          % bad)

    # kana 轨
    hr("步骤 4b / [kana:] 假名轨")
    kana = meta.get("kana", "")
    if not kana:
        print("  未找到 [kana:] 轨")
    else:
        entries = parse_kana_track(kana)
        cover = sum(e["cover"] for e in entries)
        nonempty = [e for e in entries if e["reading"]]
        timed = [e for e in entries if e["mora_timings"]]
        body_text = "".join(ln["text"] for ln in lines)
        kanji_total = len(_KANJI_RE.findall(body_text))
        print("  [kana:] 原始长度=%d 字符，条目数=%d" % (len(kana), len(entries)))
        print("  覆盖基字符数合计=%d，正文汉字总数=%d，校验和 %s"
              % (cover, kanji_total, "通过" if cover == kanji_total else "不通过"))
        print("  带读音条目=%d（%.1f%%），空读音占位条目=%d"
              % (len(nonempty), 100.0 * len(nonempty) / max(len(entries), 1),
                 len(entries) - len(nonempty)))
        print("  **带逐拍时间的条目=%d（占带读音条目的 %.1f%%）**"
              % (len(timed), 100.0 * len(timed) / max(len(nonempty), 1)))
        print("  cover 值分布: {}".format(dict(sorted(Counter(e["cover"] for e in entries).items()))))
        print("  前 12 条带读音的: %s"
              % [(e["cover"], e["reading"], e["mora_timings"]) for e in nonempty[:12]])

        # 校验：kana 逐拍时间之和是否等于对应汉字块的时长
        kanji_blocks = [t for ln in lines for t in ln["tokens"]
                        if _KANJI_RE.fullmatch(t["text"])]
        ok = mismatch = ki = 0
        for e in entries:
            if e["mora_timings"] and e["cover"] == 1 and ki < len(kanji_blocks):
                blk = kanji_blocks[ki]
                s = sum(d for _, d in e["mora_timings"])
                t0 = e["mora_timings"][0][0]
                if t0 == blk["start_ms"] and s == blk["dur_ms"]:
                    ok += 1
                else:
                    mismatch += 1
                    if mismatch <= 3:
                        print("    !! 对不上: 汉字块 %s(%d,%d) vs kana %s 拍和=%d 起=%d"
                              % (blk["text"], blk["start_ms"], blk["dur_ms"],
                                 e["reading"], s, t0))
            ki += e["cover"]
        print("  逐拍时间与汉字块时间「起点相等且时长求和相等」: 吻合 %d / 不吻合 %d"
              % (ok, mismatch))
        (OUT_DIR / "kana_entries.json").write_text(
            json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")

    # 把解析结果落盘，便于下游复用
    (OUT_DIR / "qrc_parsed.json").write_text(
        json.dumps({"meta": {k: v for k, v in meta.items() if k != "kana"},
                    "lines": lines}, ensure_ascii=False, indent=1),
        encoding="utf-8")

    hr("完成")
    print(f"  产物目录: {OUT_DIR}")
    for p in sorted(OUT_DIR.iterdir()):
        print("    %-32s %8d B" % (p.name, p.stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
