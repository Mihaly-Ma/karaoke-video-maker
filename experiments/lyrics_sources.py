#!/usr/bin/env python3
"""
P2-9/P2-10：歌词多源覆盖率实测与主源裁决
============================================

目的：对多个歌词源做**同曲对比**，用真实网络请求（不解密加密歌词——加密闭环由
另一 agent 负责，本脚本只验证"检索到/取到密文"，不重复造轮子，也不下载执行
任何第三方代码），裁决谁该做主源。

用法：
    uv run --python 3.12 --with requests experiments/lyrics_sources.py

产物：
    workspace/lyrics_sources_result.json   —— 结构化原始结果（每源每曲）
    stdout                                 —— 人类可读的汇总表 + 结论

各源实现说明（端点均来自 CLAUDE.md §5.2 已实测记录，本脚本独立复测）：
    - QQ音乐:  搜索用 smartbox_new.fcg（CLAUDE.md 已确认可用，DoSearchForQQMusicDesktop
               境外 IP 恒空要避免）；歌词用 musicu.fcg PlayLyricInfo，返回魔改 3DES 加密
               的 QRC 十六进制串——本脚本只记录密文长度/是否取到，**不解密**。
    - 酷狗:    mobiles.kugou.com 搜索 → krcs.kugou.com 取候选 → lyrics.kugou.com 下载，
               拿到 base64(krc1 头 + XOR 密文)，同样**不解密**，只验证 magic header。
    - 网易云:  music.163.com 搜索 + /api/song/lyric（lv/kv/tv/rv=1），返回明文 LRC，
               可直接判定粒度、是否有译文、是否有罗马音（rlyric 中日对照）。
    - LRCLIB:  lrclib.net /api/search，明文，可直接判定 synced/plain。
    - YouTube: yt-dlp 用 "ytsearch1:<曲名> <歌手> MV" 定位官方频道视频，
               --list-subs 区分"人工 ja 字幕"与"自动生成字幕"。
    - UtaTen:  /lyric/search?layout_search_text=...&layout_search_type=title 搜索，
               命中页面统计 <span class="rb">/<span class="rt"> 配对数（权威 furigana）。

免责声明：所有数字均来自本次实际运行的网络请求结果，若某端点当天限流/改版，
脚本会把该源标记为 error 并保留报错原文，不编造成功。
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
TIMEOUT = 12
SLEEP_BETWEEN_CALLS = 0.6  # 对各家 API 客气一点，别把自己 IP 打进黑名单

WORKSPACE = Path(__file__).resolve().parent.parent / "workspace"
WORKSPACE.mkdir(parents=True, exist_ok=True)
RESULT_PATH = WORKSPACE / "lyrics_sources_result.json"


# ---------------------------------------------------------------------------
# 曲目清单
# ---------------------------------------------------------------------------


@dataclass
class Track:
    key: str
    title: str  # 用于检索的曲名（不带括号后缀）
    title_full: str  # 完整曲名（含 feat. 等）
    artist: str  # 主检索用歌手名
    artist_full: str
    category: str  # verification / mainstream / indie / new_no_release
    note: str = ""
    known_duration_sec: float | None = (
        None  # 来自权威元数据源（如 VocaDB）的已知时长，无则留空靠多源互相印证
    )


TRACKS: list[Track] = [
    Track(
        key="akaharuka",
        title="赤春花",
        title_full="赤春花 (feat. 幾田りら)",
        artist="sumika",
        artist_full="sumika / 幾田りら",
        category="verification",
        note="主验证曲。2026-01-29 数字先行配信 / 2026-02-25 实体发售，MV 2026-07-23 才公开，"
        "所以歌词库入库早于 MV，不是真正的冷启动样本（见 CLAUDE.md §5.2）。",
    ),
    Track(
        key="lemon",
        title="Lemon",
        title_full="Lemon",
        artist="米津玄師",
        artist_full="米津玄師",
        category="mainstream",
        note="主流 J-POP 对照组 1：2018 年现象级大热单曲，理论覆盖率应接近满分。",
    ),
    Track(
        key="idol",
        title="アイドル",
        title_full="アイドル",
        artist="YOASOBI",
        artist_full="YOASOBI",
        category="mainstream",
        note="主流 J-POP 对照组 2：2023 年国民级大热单曲。",
    ),
    Track(
        key="samidare",
        title="五月雨",
        title_full="五月雨",
        artist="崎山蒼志",
        artist_full="崎山蒼志",
        category="indie",
        note="冷门/独立对照组 1：独立唱作人，niconico 出身，非主流商业推广曲目。",
    ),
    Track(
        key="sabishisa",
        title="さびしさ",
        title_full="さびしさ",
        artist="折坂悠太",
        artist_full="折坂悠太",
        category="indie",
        note="冷门/独立对照组 2：独立/另类音乐人，收录于专辑《平成》，非单曲主打。",
    ),
    Track(
        key="mermaid_2026",
        title="憂鬱なるマーメイド",
        title_full="憂鬱なるマーメイド",
        artist="リク",
        artist_full="リク@MUSIC CUBE feat. 知声",
        category="new_no_release",
        note="2026-07-31 投稿于 niconico(sm46609952) + YouTube 的 VOCALOID(VoiSona)同人原创曲，"
        "无任何商业单曲/数字配信发行，仅见于 niconico「水中ソング投稿祭」参加作。"
        "元数据来自 vocadb.net（歌曲 id=1014466），非本脚本编造。",
        known_duration_sec=207.0,
    ),
]


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def _get(url: str, **kwargs) -> requests.Response:
    kwargs.setdefault("timeout", TIMEOUT)
    kwargs.setdefault("headers", {})
    kwargs["headers"].setdefault("User-Agent", UA)
    return requests.get(url, **kwargs)


def _safe(fn, *args, **kwargs) -> dict[str, Any]:
    """包一层异常捕获，保证单个源失败不影响其它源，且如实记录报错原文。"""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 —— 实测脚本，故意宽捕获并如实记录
        return {"error": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------------------
# QQ 音乐
# ---------------------------------------------------------------------------


def qq_search(track: Track) -> dict[str, Any]:
    # smartbox_new.fcg 是"输入联想"接口，每类结果只返回极少数条（实测 count<=4），
    # 用"标题+歌手"组合查询会被截断进而漏检；改为只用标题查询，
    # 再在返回的候选里按歌手名做匹配，避免把"接口截断"误判成"未收录"。
    resp = _get(
        "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg",
        params={"key": track.title, "format": "json"},
        headers={"Referer": "https://y.qq.com/"},
    )
    data = resp.json()
    items = data.get("data", {}).get("song", {}).get("itemlist", [])
    if not items:
        return {"found": False, "raw_count": 0}
    match = next((i for i in items if track.artist in (i.get("singer") or "")), None)
    top = match or items[0]
    return {
        "found": match is not None,
        "found_but_artist_mismatch": match is None,
        "mid": top.get("mid"),
        "name": top.get("name"),
        "singer": top.get("singer"),
        "raw_count": len(items),
        "note": "smartbox_new.fcg 为联想框接口，返回条数很少；未匹配到歌手名时"
        "不代表该曲真的不在 QQ 音乐库中，只能说明没进入联想框前几条",
    }


def qq_fetch_lyric(mid: str) -> dict[str, Any]:
    payload = {
        "req_1": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": {
                "songMID": mid,
                "songID": 0,
                "crypt": 1,
                "ct": 11,
                "cv": 13020508,
                "qrc": 1,
                "roma": 1,
                "trans": 1,
            },
        }
    }
    resp = _get(
        "https://u.y.qq.com/cgi-bin/musicu.fcg",
        params={"data": json.dumps(payload, ensure_ascii=False)},
        headers={"Referer": "https://y.qq.com/"},
    )
    data = resp.json()
    inner = data.get("req_1", {}).get("data", {})
    lyric_hex = inner.get("lyric", "")
    trans_hex = inner.get("trans", "")
    roma_hex = inner.get("roma", "")
    return {
        "found_encrypted": bool(lyric_hex),
        "encrypted_lyric_hex_len": len(lyric_hex),
        "has_encrypted_trans": bool(trans_hex),
        "has_encrypted_roma": bool(roma_hex),
        "code": inner.get("code") if isinstance(inner, dict) else None,
        "note": "只验证密文是否取到，不解密（QRC 魔改 3DES 解密由另一 agent 负责，见 CLAUDE.md §5.2）",
    }


def probe_qq(track: Track) -> dict[str, Any]:
    search = _safe(qq_search, track)
    if search.get("error") or not search.get("found"):
        return {"search": search, "lyric": None}
    time.sleep(SLEEP_BETWEEN_CALLS)
    lyric = _safe(qq_fetch_lyric, search["mid"])
    return {"search": search, "lyric": lyric}


# ---------------------------------------------------------------------------
# 酷狗 KRC
# ---------------------------------------------------------------------------


def kugou_search(track: Track) -> dict[str, Any]:
    # 盲选第一条会踩坑：对冷门曲，酷狗搜索接口经常把不相关的同名/近似关键词歌曲排第一
    # （实测"憂鬱なるマーメイド"排到了完全无关的"親愛なるあの日々へ"）。
    # 因此改为拿多条候选，优先选歌手名匹配的；若已知参考时长，再在匹配集合里选时长最接近的。
    q = f"{track.title} {track.artist}"
    resp = _get(
        "https://mobiles.kugou.com/api/v3/search/song",
        params={"keyword": q, "page": 1, "pagesize": 10},
    )
    data = resp.json()
    info = data.get("data", {}).get("info", [])
    if not info:
        return {"found": False, "raw_count": 0}
    matched = [i for i in info if track.artist in (i.get("singername") or "")]
    # 歌手匹配的候选里，再优先挑标题完全等于目标曲名的（排除"From THE FIRST TAKE"
    # 这类现场/翻唱/短版本，它们歌手名相同但时长完全不对，若不过滤会静默选到错误版本）
    exact_title = [i for i in matched if (i.get("songname") or "") == track.title]
    pool = exact_title or matched or info
    if track.known_duration_sec is not None:
        pool = sorted(
            pool, key=lambda i: abs((i.get("duration") or 1e9) - track.known_duration_sec)
        )
    top = pool[0]
    return {
        "found": bool(matched),
        "found_but_artist_mismatch": not matched,
        "hash": top.get("hash"),
        "songname": top.get("songname"),
        "singername": top.get("singername"),
        "duration_sec": top.get("duration"),
        "raw_count": len(info),
    }


def kugou_fetch_krc(track: Track, hash_: str, duration_sec: float | None) -> dict[str, Any]:
    dur_ms = int((duration_sec or 0) * 1000)
    resp = _get(
        "http://krcs.kugou.com/search",
        params={
            "ver": 1,
            "man": "yes",
            "client": "mobi",
            "keyword": f"{track.artist} - {track.title}",
            "duration": dur_ms,
            "hash": hash_,
        },
    )
    data = resp.json()
    candidates = data.get("candidates", [])
    if not candidates:
        return {"found_candidate": False, "raw_candidates": 0}
    cand = candidates[0]
    time.sleep(SLEEP_BETWEEN_CALLS)
    dl = _get(
        "http://lyrics.kugou.com/download",
        params={
            "ver": 1,
            "client": "pc",
            "id": cand["id"],
            "accesskey": cand["accesskey"],
            "fmt": "krc",
            "charset": "utf8",
        },
    )
    dl_data = dl.json()
    content_b64 = dl_data.get("content", "")
    magic_ok = False
    decoded_len = 0
    if content_b64:
        try:
            raw = base64.b64decode(content_b64)
            decoded_len = len(raw)
            magic_ok = raw[:4] == b"krc1"
        except Exception:  # noqa: BLE001
            pass
    return {
        "found_candidate": True,
        "raw_candidates": len(candidates),
        "krctype": cand.get("krctype"),
        "product_from": cand.get("product_from"),
        "downloaded": bool(content_b64),
        "decoded_len_bytes": decoded_len,
        "magic_header_krc1": magic_ok,
        "note": "只验证密文是否取到 + krc1 magic header 是否正确，不做 XOR+zlib 解密"
        "（解密算法已在 CLAUDE.md §5.2 写明，但按任务指示交由另一 agent 实现，本脚本不重复造轮子）",
    }


def probe_kugou(track: Track) -> dict[str, Any]:
    search = _safe(kugou_search, track)
    if search.get("error") or not search.get("found"):
        return {"search": search, "lyric": None}
    time.sleep(SLEEP_BETWEEN_CALLS)
    lyric = _safe(kugou_fetch_krc, track, search["hash"], search.get("duration_sec"))
    return {"search": search, "lyric": lyric}


# ---------------------------------------------------------------------------
# 网易云
# ---------------------------------------------------------------------------


def netease_search(track: Track) -> dict[str, Any]:
    # 同 kugou：不要盲选第一条，按歌手名过滤，避免"同名曲但完全不同歌手"的误配
    # （实测"憂鬱なるマーメイド"曾误配到"森英治"的完全无关曲目）。
    q = f"{track.title} {track.artist}"
    resp = _get(
        "https://music.163.com/api/search/get",
        params={"s": q, "type": 1, "limit": 10},
        headers={"Referer": "https://music.163.com/"},
    )
    data = resp.json()
    songs = data.get("result", {}).get("songs", [])
    if not songs:
        return {"found": False, "raw_count": 0}
    matched = [
        s for s in songs if any(track.artist in (a.get("name") or "") for a in s.get("artists", []))
    ]
    pool = matched if matched else songs
    if track.known_duration_sec is not None:
        pool = sorted(
            pool,
            key=lambda s: abs((s.get("duration") or 0) / 1000 - track.known_duration_sec),
        )
    top = pool[0]
    return {
        "found": bool(matched),
        "found_but_artist_mismatch": not matched,
        "id": top.get("id"),
        "name": top.get("name"),
        "artists": [a.get("name") for a in top.get("artists", [])],
        "duration_sec": (top.get("duration") or 0) / 1000,
        "raw_count": len(songs),
    }


def netease_fetch_lyric(song_id: int) -> dict[str, Any]:
    resp = _get(
        "https://music.163.com/api/song/lyric",
        params={"id": song_id, "lv": 1, "kv": 1, "tv": 1, "rv": 1},
        headers={"Referer": "https://music.163.com/"},
    )
    data = resp.json()
    lrc = data.get("lrc", {}).get("lyric", "") or ""
    tlyric = data.get("tlyric", {}).get("lyric", "") or ""
    romalrc = data.get("romalrc", {}).get("lyric", "") or ""
    yrc = data.get("yrc", {}).get("lyric", "") or ""  # 匿名接口预期拿不到，如实记录
    line_count = len([ln for ln in lrc.splitlines() if re.match(r"^\[\d{2}:\d{2}", ln)])
    return {
        "found": bool(lrc),
        "granularity": "word(yrc)" if yrc else ("line(lrc)" if lrc else "none"),
        "has_translation": bool(tlyric),
        "has_romaji": bool(romalrc),
        "has_yrc_word_level": bool(yrc),
        "lrc_line_count": line_count,
    }


def probe_netease(track: Track) -> dict[str, Any]:
    search = _safe(netease_search, track)
    if search.get("error") or not search.get("found"):
        return {"search": search, "lyric": None}
    time.sleep(SLEEP_BETWEEN_CALLS)
    lyric = _safe(netease_fetch_lyric, search["id"])
    return {"search": search, "lyric": lyric}


# ---------------------------------------------------------------------------
# LRCLIB
# ---------------------------------------------------------------------------


def probe_lrclib(track: Track) -> dict[str, Any]:
    resp = _get(
        "https://lrclib.net/api/search",
        params={"track_name": track.title, "artist_name": track.artist},
    )
    items = resp.json()
    if not items:
        return {"search": {"found": False, "raw_count": 0}, "lyric": None}
    top = items[0]
    synced = top.get("syncedLyrics") or ""
    plain = top.get("plainLyrics") or ""
    line_count = len([ln for ln in synced.splitlines() if ln.strip()])
    return {
        "search": {
            "found": True,
            "id": top.get("id"),
            "track_name": top.get("trackName"),
            "artist_name": top.get("artistName"),
            "duration_sec": top.get("duration"),
            "raw_count": len(items),
        },
        "lyric": {
            "found": bool(synced or plain),
            "granularity": "line(synced)" if synced else ("plain" if plain else "none"),
            "synced_line_count": line_count,
            "has_plain_only_fallback": bool(plain) and not bool(synced),
        },
    }


# ---------------------------------------------------------------------------
# YouTube 官方 ja 字幕（用 yt-dlp 搜索 MV 并列出字幕轨）
# ---------------------------------------------------------------------------


def _yt_search_once(query: str) -> list[str] | None:
    proc = subprocess.run(
        [
            "yt-dlp",
            "--skip-download",
            "--no-warnings",
            "--print",
            "%(id)s\t%(title)s\t%(duration)s\t%(channel)s\t%(webpage_url)s",
            query,
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    line = proc.stdout.strip().splitlines()[-1]
    parts = line.split("\t")
    return parts if len(parts) >= 5 else None


def probe_youtube_ja(track: Track) -> dict[str, Any]:
    # "@" 会让 yt-dlp 把 ytsearch 查询解析坏（实测直接返回空、无报错），
    # 歌手名里含 "xxx@YYY" 这类 P 名格式时必须先替换掉。
    safe_artist = track.artist_full.replace("@", " ")
    # "MV" 后缀能帮主流曲目排掉翻唱/reaction 类结果，但对同人/冷门曲反而会让
    # YouTube 搜索过度收窄到 0 条（实测"憂鬱なるマーメイド"加了 MV 就搜不到）。
    # 策略：先带 MV 搜，空则退化成不带 MV 的查询重试一次。
    parts = _yt_search_once(f"ytsearch1:{track.title_full} {safe_artist} MV")
    used_mv_suffix = True
    if parts is None:
        parts = _yt_search_once(f"ytsearch1:{track.title_full} {safe_artist}")
        used_mv_suffix = False
    if parts is None:
        return {"found_video": False}
    vid, title, duration, channel, url = parts

    subs_proc = subprocess.run(
        ["yt-dlp", "--skip-download", "--no-warnings", "--list-subs", url],
        capture_output=True,
        text=True,
        timeout=60,
    )
    out = subs_proc.stdout
    # yt-dlp 依次打印 "Available automatic captions for <id>:" 和
    # "Available subtitles for <id>:" 两张表；人工字幕表在后一张。
    manual_section = out.split("Available subtitles for")
    has_manual_ja = False
    if len(manual_section) > 1:
        manual_table = manual_section[-1]
        has_manual_ja = bool(re.search(r"^ja\s", manual_table, re.MULTILINE))
    has_auto_ja = bool(re.search(r"^ja\s", out.split("Available subtitles for")[0], re.MULTILINE))

    return {
        "found_video": True,
        "video_id": vid,
        "title": title,
        "channel": channel,
        "duration_sec": float(duration) if duration not in ("NA", "") else None,
        "url": url,
        "used_mv_suffix": used_mv_suffix,
        "has_manual_ja_subtitle": has_manual_ja,
        "has_auto_ja_caption": has_auto_ja,
    }


# ---------------------------------------------------------------------------
# UtaTen（权威 furigana ruby）
# ---------------------------------------------------------------------------


def utaten_search(track: Track) -> dict[str, Any]:
    resp = _get(
        "https://utaten.com/lyric/search",
        params={"layout_search_text": track.title, "layout_search_type": "title"},
        allow_redirects=True,
    )
    html = resp.text
    rows = re.findall(r"<tr>.*?</tr>", html, re.S)
    candidates = []
    for row in rows:
        m_link = re.search(r'href="(/lyric/[^"]+)"', row)
        m_title = re.search(r'href="/lyric/[^"]+">\s*([^\n<]+)', row)
        m_artist = re.search(r'href="/artist/[^"]+">\s*([^\n<]+)', row)
        if not m_link:
            continue
        candidates.append(
            {
                "path": m_link.group(1),
                "title": (m_title.group(1).strip() if m_title else ""),
                "artist": (m_artist.group(1).strip() if m_artist else ""),
            }
        )
    # 严格只接受歌手名匹配的候选；不做"标题包含即可"的退化匹配——
    # 那样会把同名但完全不同歌手的曲目误判为命中（"五月雨"这种常见词标题尤其危险）。
    match = next((c for c in candidates if track.artist in c["artist"]), None)
    return {
        "found": match is not None,
        "raw_candidates": len(candidates),
        "matched": match,
        "all_candidates_preview": candidates[:5],
    }


def utaten_fetch_ruby(path: str) -> dict[str, Any]:
    resp = _get(f"https://utaten.com{path}")
    html = resp.text
    rb_count = len(re.findall(r'class="rb"', html))
    rt_count = len(re.findall(r'class="rt"', html))
    return {
        "found": rb_count > 0,
        "ruby_pairs": rb_count,
        "rb_rt_matched": rb_count == rt_count,
    }


def probe_utaten(track: Track) -> dict[str, Any]:
    search = _safe(utaten_search, track)
    if search.get("error") or not search.get("found"):
        return {"search": search, "lyric": None}
    time.sleep(SLEEP_BETWEEN_CALLS)
    lyric = _safe(utaten_fetch_ruby, search["matched"]["path"])
    return {"search": search, "lyric": lyric}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

SOURCES: dict[str, Any] = {
    "qq": probe_qq,
    "kugou": probe_kugou,
    "netease": probe_netease,
    "lrclib": probe_lrclib,
    "youtube_ja": probe_youtube_ja,
    "utaten": probe_utaten,
}


def run_all() -> dict[str, Any]:
    results: dict[str, Any] = {"tracks": {}}
    for track in TRACKS:
        print(
            f"\n=== {track.title_full} — {track.artist_full} [{track.category}] ===",
            file=sys.stderr,
        )
        track_result: dict[str, Any] = {"meta": track.__dict__, "sources": {}}
        for source_name, fn in SOURCES.items():
            print(f"  -> {source_name} ...", file=sys.stderr, end=" ", flush=True)
            t0 = time.time()
            r = _safe(fn, track)
            dt = time.time() - t0
            print(f"done ({dt:.1f}s)", file=sys.stderr)
            track_result["sources"][source_name] = r
            time.sleep(SLEEP_BETWEEN_CALLS)
        results["tracks"][track.key] = track_result
    return results


def summarize(results: dict[str, Any]) -> str:
    lines = []
    lines.append("=" * 100)
    lines.append("歌词多源覆盖率实测汇总")
    lines.append("=" * 100)

    def grain_of(source: str, r: dict[str, Any]) -> str:
        if r.get("error"):
            return f"ERROR:{r['error'][:40]}"
        if source == "qq":
            search = r.get("search") or {}
            lyric = r.get("lyric") or {}
            if not search.get("found"):
                return "未检索到"
            if lyric.get("error"):
                return f"检索到,取词ERROR:{lyric['error'][:30]}"
            if lyric.get("found_encrypted"):
                return "逐字(密文已取到,未解密)"
            return "检索到但无歌词"
        if source == "kugou":
            search = r.get("search") or {}
            lyric = r.get("lyric") or {}
            if not search.get("found"):
                return "未检索到"
            if lyric.get("error"):
                return f"检索到,取词ERROR:{lyric['error'][:30]}"
            if lyric.get("downloaded") and lyric.get("magic_header_krc1"):
                return "逐字(密文已取到,未解密)"
            if lyric.get("found_candidate"):
                return "检索到候选但下载失败"
            return "检索到但无候选歌词"
        if source == "netease":
            search = r.get("search") or {}
            lyric = r.get("lyric") or {}
            if not search.get("found"):
                return "未检索到"
            if lyric.get("error"):
                return f"检索到,取词ERROR:{lyric['error'][:30]}"
            return lyric.get("granularity", "未知")
        if source == "lrclib":
            search = r.get("search") or {}
            lyric = r.get("lyric") or {}
            if not search.get("found"):
                return "未检索到"
            return lyric.get("granularity", "未知") if lyric else "未知"
        if source == "youtube_ja":
            if not r.get("found_video"):
                return "未找到视频"
            if r.get("has_manual_ja_subtitle"):
                return "句级(人工ja字幕,已在MV轴上)"
            if r.get("has_auto_ja_caption"):
                return "无人工字幕(仅自动生成,不可信)"
            return "无ja字幕"
        if source == "utaten":
            search = r.get("search") or {}
            lyric = r.get("lyric") or {}
            if not search.get("found"):
                return "未检索到"
            if lyric and lyric.get("found"):
                return f"纯文本+权威ruby({lyric.get('ruby_pairs')}对)"
            return "检索到但无ruby"
        return "?"

    header = f"{'曲目':<28}{'分类':<10}"
    for s in SOURCES:
        header += f"{s:<28}"
    lines.append(header)
    lines.append("-" * 100)

    for track in TRACKS:
        tr = results["tracks"][track.key]
        row = f"{track.title_full:<28}{track.category:<10}"
        for source_name in SOURCES:
            g = grain_of(source_name, tr["sources"][source_name])
            row += f"{g:<28}"
        lines.append(row)

    return "\n".join(lines)


if __name__ == "__main__":
    results = run_all()
    RESULT_PATH.write_text(
        json.dumps(results, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    print(f"\n原始结果已写入 {RESULT_PATH}", file=sys.stderr)
    report = summarize(results)
    print(report)
