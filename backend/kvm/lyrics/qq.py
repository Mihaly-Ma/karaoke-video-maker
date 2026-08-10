"""QQ 音乐歌词 provider（逐字 QRC + `[kana:]` 假名轨）。

CLAUDE.md §5.2：QQ音乐 QRC 是**第一版主源**，"已实测端到端闭环，全程零 Cookie"。
本模块是 `experiments/qrc_decrypt.py`（P0-3 实验，已用真实网络验证过完整
搜索→拉取→解密→解析闭环）抽取出的生产实现。

## 关于 DES 实现的合规声明

腾讯 QRC 用的不是标准 3DES——内嵌的是 B-Con/crypto-algorithms 那份 C 语言
des.c，其 S-box 有两处笔误，且字节序在 32 位字内是反的。这些常量属于事实性
数据（不受版权保护），我们阅读 MIT 许可的 WXRIW/QQMusicDecoder（C#）核对了
表值后，用 Python 重新实现全部逻辑。**没有下载、导入或执行任何第三方代码**，
解密算法本身照抄自 `experiments/qrc_decrypt.py`（已实测跑通），未重新发明。

## 与 `kvm.lyrics.importer` 的分工

解密后的 QRC 正文与用户手工粘贴的"已解密 QRC XML"格式完全相同，因此
`fetch()` 拿到明文后直接复用 `importer.parse_qrc()`，不重复实现一遍解析。
"""

from __future__ import annotations

import json
import zlib

import requests

from kvm.lyrics.base import LyricProvider, LyricProviderError, ParsedLyric, TrackMatch
from kvm.lyrics.importer import (
    has_ruby,
    infer_granularity,
    line_text,
    parse_lrc,
    parse_qrc,
    raw_excerpt,
)

# ---------------------------------------------------------------------------
# 魔改（含笔误 S-box 的）三重 DES-ECB
# ---------------------------------------------------------------------------

QRC_KEY = b"!@#)(*$%123ZXC!@!@#)(NHL"  # 24 字节 = 三重 DES 的三段子密钥

ENCRYPT = 1
DECRYPT = 0

# 标准 DES 的 8 张 S-box，但其中两处是腾讯沿用的笔误值：
#   SBOX2[23] = 15（标准是 14）
#   SBOX4[53] = 10（标准是 1）
# 这两处就是"pycryptodome / cryptography 的标准 DES3 解出垃圾"的全部原因。
SBOX = (
    (
        14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
        0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
        4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
        15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
    ),
    (
        15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
        3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,  # 索引 23：笔误 15
        0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
        13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
    ),
    (
        10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
        13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
        13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
        1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
    ),
    (
        7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
        13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
        10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
        3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,  # 索引 53：笔误 10
    ),
    (
        2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
        14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
        4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
        11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
    ),
    (
        12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
        10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
        9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
        4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
    ),
    (
        4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
        13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
        1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
        6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
    ),
    (
        13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
        1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
        7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
        2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
    ),
)

# 标准 DES 的 PC-1（拆成 C / D 两半）与 PC-2，均已改为 0 起始下标
KEY_PERM_C = (
    56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17,
    9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
)
KEY_PERM_D = (
    62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
    13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3,
)
KEY_COMPRESSION = (
    13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9,
    22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
    40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47,
    43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
)
KEY_RND_SHIFT = (1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1)

# 初始置换 IP，拆成左右两半（0 起始）
IP_L = (
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
)
IP_R = (
    56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
    60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
)

# 轮函数末尾的 P 置换：(取 state 的第 b 位, 放到输出第 c 位)，b/c 均以 MSB 为 0
P_PERM = (
    (15, 0), (6, 1), (19, 2), (20, 3), (28, 4), (11, 5), (27, 6), (16, 7),
    (0, 8), (14, 9), (22, 10), (25, 11), (4, 12), (17, 13), (30, 14), (9, 15),
    (1, 16), (7, 17), (23, 18), (13, 19), (31, 20), (26, 21), (2, 22), (8, 23),
    (18, 24), (12, 25), (29, 26), (5, 27), (21, 28), (10, 29), (3, 30), (24, 31),
)

# InvIP：输出字节写入顺序——注意这里是 32 位字内字节逆序（DES 本身没有这一步，
# 是这份 C 实现的 BITNUM 宏带来的固有字节序特性，必须原样复刻）
_INVIP_BYTE_ORDER = (3, 2, 1, 0, 7, 6, 5, 4)


def _bitnum(buf: bytes, b: int, c: int) -> int:
    """取 buf 的第 b 位（MSB 优先），左移到第 c 位。"""
    idx = (b // 32) * 4 + 3 - (b % 32) // 8
    return ((buf[idx] >> (7 - (b % 8))) & 1) << c


def _bit_r(a: int, b: int, c: int) -> int:
    """取 32 位整数 a 的第 b 位（MSB 为 0），左移到第 c 位。"""
    return ((a >> (31 - b)) & 1) << c


def _bit_l(a: int, b: int, c: int) -> int:
    """取 32 位整数 a 的第 b 位（MSB 为 0），放到"MSB 起第 c 位"。"""
    return ((a << b) & 0x80000000) >> c


def _sboxbit(a: int) -> int:
    """把 6 位输入重排成行主序扁平 S-box 的下标。"""
    return (a & 0x20) | ((a & 0x1F) >> 1) | ((a & 0x01) << 4)


def _des_key_schedule(key8: bytes, mode: int) -> list[list[int]]:
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
            # 注意这里减的是 27 而不是 28——这是原 C 实现的固有偏移，
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
    t1 = (
        _bit_l(state, 31, 0) | ((state & 0xF0000000) >> 1) | _bit_l(state, 4, 5)
        | _bit_l(state, 3, 6) | ((state & 0x0F000000) >> 3) | _bit_l(state, 8, 11)
        | _bit_l(state, 7, 12) | ((state & 0x00F00000) >> 5) | _bit_l(state, 12, 17)
        | _bit_l(state, 11, 18) | ((state & 0x000F0000) >> 7) | _bit_l(state, 16, 23)
    )
    t2 = (
        _bit_l(state, 15, 0) | ((state & 0x0000F000) << 15) | _bit_l(state, 20, 5)
        | _bit_l(state, 19, 6) | ((state & 0x00000F00) << 13) | _bit_l(state, 24, 11)
        | _bit_l(state, 23, 12) | ((state & 0x000000F0) << 11) | _bit_l(state, 28, 17)
        | _bit_l(state, 27, 18) | ((state & 0x0000000F) << 9) | _bit_l(state, 0, 23)
    )
    t1 &= 0xFFFFFFFF
    t2 &= 0xFFFFFFFF

    b0 = ((t1 >> 24) & 0xFF) ^ key6[0]
    b1 = ((t1 >> 16) & 0xFF) ^ key6[1]
    b2 = ((t1 >> 8) & 0xFF) ^ key6[2]
    b3 = ((t2 >> 24) & 0xFF) ^ key6[3]
    b4 = ((t2 >> 16) & 0xFF) ^ key6[4]
    b5 = ((t2 >> 8) & 0xFF) ^ key6[5]

    state = (
        (SBOX[0][_sboxbit(b0 >> 2)] << 28)
        | (SBOX[1][_sboxbit(((b0 & 0x03) << 4) | (b1 >> 4))] << 24)
        | (SBOX[2][_sboxbit(((b1 & 0x0F) << 2) | (b2 >> 6))] << 20)
        | (SBOX[3][_sboxbit(b2 & 0x3F)] << 16)
        | (SBOX[4][_sboxbit(b3 >> 2)] << 12)
        | (SBOX[5][_sboxbit(((b3 & 0x03) << 4) | (b4 >> 4))] << 8)
        | (SBOX[6][_sboxbit(((b4 & 0x0F) << 2) | (b5 >> 6))] << 4)
        | SBOX[7][_sboxbit(b5 & 0x3F)]
    )

    out = 0
    for b, c in P_PERM:
        out |= _bit_l(state, b, c)
    return out & 0xFFFFFFFF


def _des_crypt_block(block: bytes, schedule: list[list[int]]) -> bytes:
    s0, s1 = _ip(block)
    for idx in range(15):
        t = s1
        s1 = _f(s1, schedule[idx]) ^ s0
        s0 = t
    s0 = _f(s1, schedule[15]) ^ s0
    return _inv_ip(s0, s1)


def _triple_des_setup(key24: bytes, mode: int) -> list[list[list[int]]]:
    """三重 DES 的子密钥组装。解密时序为 D(k3) → E(k2) → D(k1)。"""
    if mode == ENCRYPT:
        return [
            _des_key_schedule(key24[0:8], ENCRYPT),
            _des_key_schedule(key24[8:16], DECRYPT),
            _des_key_schedule(key24[16:24], ENCRYPT),
        ]
    return [
        _des_key_schedule(key24[16:24], DECRYPT),
        _des_key_schedule(key24[8:16], ENCRYPT),
        _des_key_schedule(key24[0:8], DECRYPT),
    ]


def _triple_des_ecb(data: bytes, key24: bytes, mode: int) -> bytes:
    if len(data) % 8:
        msg = f"密文长度 {len(data)} 不是 8 的倍数"
        raise ValueError(msg)
    sch = _triple_des_setup(key24, mode)
    out = bytearray()
    for i in range(0, len(data), 8):
        blk = _des_crypt_block(data[i : i + 8], sch[0])
        blk = _des_crypt_block(blk, sch[1])
        blk = _des_crypt_block(blk, sch[2])
        out.extend(blk)
    return bytes(out)


def qrc_decrypt(encrypted_hex: str) -> bytes:
    """QRC 密文（hex 字符串）→ 魔改 3DES-ECB 解密 → zlib inflate → 明文字节。"""
    raw = bytes.fromhex(encrypted_hex.strip())
    plain = _triple_des_ecb(raw, QRC_KEY, DECRYPT)
    return zlib.decompress(plain)


# ---------------------------------------------------------------------------
# 网络访问
# ---------------------------------------------------------------------------

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
_PLAYER_REFERER = "https://y.qq.com/portal/player.html"
_TIMEOUT = 20


def _new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": _UA})
    return s


def search_smartbox(session: requests.Session, query: str) -> list[dict]:
    r = session.get(
        "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg",
        params={
            "key": query, "format": "json", "g_tk": 5381, "utf8": 1,
            "loginUin": 0, "hostUin": 0, "inCharset": "utf8",
            "outCharset": "utf-8", "platform": "yqq",
        },
        headers={"Referer": _PLAYER_REFERER},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    items = r.json()["data"]["song"]["itemlist"]
    return [
        {
            "songmid": it["mid"], "name": it["name"],
            "singer": it.get("singer", ""), "interval": None, "album": "",
        }
        for it in items
    ]


def search_soso(session: requests.Session, query: str) -> list[dict]:
    r = session.get(
        "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
        params={
            "g_tk": 5381, "format": "json", "inCharset": "utf-8",
            "outCharset": "utf-8", "notice": 0, "platform": "yqq.json",
            "needNewCode": 0, "w": query, "p": 1, "n": 20, "t": 0,
            "aggr": 1, "cr": 1, "lossless": 0, "flag_qc": 0,
        },
        headers={"Referer": _PLAYER_REFERER},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    out = []
    for it in r.json()["data"]["song"]["list"]:
        out.append(
            {
                "songmid": it["songmid"],
                "name": it["songname"],
                "singer": "/".join(x["name"] for x in it.get("singer", [])),
                "interval": it.get("interval"),
                "album": it.get("albumname", ""),
            }
        )
    return out


def fetch_play_lyric(session: requests.Session, songmid: str) -> dict:
    """POST musicu.fcg 取 QRC/roma/trans（均为 hex 密文）。

    `songID` 传 0 即可——已实测只用 `songMID` 就能取到完整歌词，
    候选列表（`TrackMatch.song_id`）因此只需携带 songmid 一个标识符。
    """
    body = {
        "comm": {"ct": 19, "cv": 1859, "uin": "0"},
        "req": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": {
                "songMID": songmid, "songID": 0,
                "crypt": 1, "qrc": 1, "roma": 1, "trans": 1,
                "lrc_t": 0, "qrc_t": 0, "roma_t": 0, "trans_t": 0,
                "interval": 0, "type": 0, "format": "json",
                "ct": 19, "cv": 1859,
            },
        },
    }
    r = session.post(
        "https://u.y.qq.com/cgi-bin/musicu.fcg",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Referer": "https://y.qq.com/"},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()["req"]["data"]


# ---------------------------------------------------------------------------
# provider
# ---------------------------------------------------------------------------

_NETWORK_ERRORS = (requests.RequestException, KeyError, ValueError)
"""搜索/拉取阶段要拦截的异常：网络故障、JSON 解析失败（ValueError 的子类）、
响应缺字段（KeyError）。范围收紧到"确实可能发生"的类型，不用裸 except。"""


def _to_match(hit: dict) -> TrackMatch:
    """QQ 音乐的搜索接口（smartbox / soso）只给曲目元信息，不含歌词正文。

    实测同一批搜索结果里，即便都来自 QQ 音乐，也存在只有行级 LRC、
    甚至完全没有歌词的曲目——"QQ 音乐 QRC 是逐字+带注音的主源"是对这个
    provider **整体能力**的描述，不是对**每一条搜索结果**的保证。之前这里
    无条件给每条结果标 `granularity="word", has_ruby=True`，前端因此会显示
    一个不可信的"含注音"徽章，取回后经常发现 `has_ruby=False`。
    诚实的答案是 unknown/None，真实值等 `fetch()` 解析正文后才知道。
    """
    interval = hit.get("interval")
    return TrackMatch(
        provider="qq",
        song_id=hit["songmid"],
        title=hit.get("name", ""),
        artist=hit.get("singer", ""),
        album=hit.get("album", ""),
        duration_ms=int(interval) * 1000 if interval else 0,
        granularity="unknown",
        has_ruby=None,
        note="QQ音乐：粒度与是否含注音需拉取歌词正文后才能确认，见 /preview",
    )


def _decrypt_has_translation(session_data: dict) -> bool:
    """判定 trans 轨是否含真实译文（而不是空壳或纯占位符/版权声明）。

    trans 解密后是**纯文本 LRC**（不是 XML），复用 `importer.parse_lrc`
    做时间轴解析，再过滤掉 `//` 占位行与版权声明行。任何一步失败都降级为
    False——译文是锦上添花的信息，不应因为它解密失败而拖垮整条歌词。
    """
    trans_hex = session_data.get("trans") or ""
    if not trans_hex:
        return False
    try:
        trans_text = qrc_decrypt(trans_hex).decode("utf-8", errors="replace")
        trans_lines = parse_lrc(trans_text)
    except (ValueError, zlib.error):
        return False
    return any(
        (t := line_text(ln)) not in ("", "//") and "著作权" not in t for ln in trans_lines
    )


class QqMusicProvider(LyricProvider):
    """QQ 音乐歌词源：`smartbox_new.fcg` / `search_for_qq_cp` 搜索 + `musicu.fcg` 拉取。"""

    name = "qq"

    def search(self, query: str, *, duration_hint_ms: int | None = None) -> list[TrackMatch]:
        del duration_hint_ms  # QQ 搜索接口不支持按时长过滤，排序留给路由层的 resolver
        session = _new_session()
        hits: list[dict] = []
        errors: list[str] = []
        succeeded = False
        for search_fn in (search_soso, search_smartbox):
            try:
                hits.extend(search_fn(session, query))
                succeeded = True
            except _NETWORK_ERRORS as exc:
                errors.append(str(exc))
        if not succeeded:
            msg = "QQ音乐搜索失败：" + "；".join(errors)
            raise LyricProviderError(msg)

        seen: dict[str, dict] = {}
        for hit in hits:
            seen.setdefault(hit["songmid"], hit)
        return [_to_match(hit) for hit in seen.values()]

    def fetch(self, song_id: str) -> ParsedLyric:
        session = _new_session()
        try:
            data = fetch_play_lyric(session, song_id)
        except _NETWORK_ERRORS as exc:
            msg = f"QQ音乐拉取歌词失败：{exc}"
            raise LyricProviderError(msg) from exc

        lyric_hex = data.get("lyric") or ""
        if not lyric_hex:
            msg = "QQ音乐未返回歌词内容；可手工导入歌词"
            raise LyricProviderError(msg)

        try:
            plain = qrc_decrypt(lyric_hex)
        except (ValueError, zlib.error) as exc:
            msg = f"QQ音乐歌词解密失败：{exc}"
            raise LyricProviderError(msg) from exc

        text = plain.decode("utf-8", errors="replace")
        try:
            lines = parse_qrc(text)
        except ValueError as exc:
            msg = f"QQ音乐歌词解析失败：{exc}"
            raise LyricProviderError(msg) from exc

        return ParsedLyric(
            lines=lines,
            granularity=infer_granularity(lines),
            has_ruby=has_ruby(lines),
            has_translation=_decrypt_has_translation(data),
            raw_excerpt=raw_excerpt(lines),
        )
