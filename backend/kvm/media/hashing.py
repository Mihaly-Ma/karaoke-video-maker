"""内容寻址缓存键的共用小工具。

CLAUDE.md §5.13 规定重计算作业的缓存键必须是"输入哈希"（内容寻址：文件换了
内容但文件名/路径不变也必须使缓存失效），但哈希本身不是免费的——对波形峰值
这种反正要把整份音频解码一遍的场景，多算一次 sha256 只是解码耗时的零头；
但对纯粹的媒体探测（ffprobe 本身只要几十毫秒）来说，为了拿到一个哈希去读
一遍上百 MB 的文件反而比正经工作贵得多。

`cached_sha256()` 提供一条旁路：用 `(mtime_ns, size)` 判断文件"看起来没变"，
没变就直接用上次算出的哈希，跳过整份重读；一旦文件被替换（哪怕文件名和路径
都不变），下一次 `stat()` 就会不一致，照样会被重新哈希——`sha256_file()` 才是
权威真源，这里只是缓存它的结果，不弱化正确性保证。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

_CHUNK_SIZE = 1024 * 1024


def sha256_file(path: Path, chunk_size: int = _CHUNK_SIZE) -> str:
    """整份读取文件算 sha256。大文件用分块读取，不整份读进内存。"""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cached_sha256(path: Path, index_path: Path) -> str:
    """带 `(mtime_ns, size)` 旁路的哈希查询。

    `index_path` 是一个按路径索引的小 JSON 文件，调用方负责给不同用途分配
    不同的索引文件（不同用途的"文件没变"判据没有必要共享同一份索引）。
    """
    try:
        stat = path.stat()
    except OSError:
        # 文件读不到：调用方紧接着访问文件本体时会遇到同样的错误并给出中文提示，
        # 这里直接退化到无旁路的哈希（其内部同样会因 open() 失败而抛出）。
        return sha256_file(path)

    index: dict[str, dict[str, int | str]] = {}
    if index_path.is_file():
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            index = {}

    key = str(path)
    entry = index.get(key)
    if (
        isinstance(entry, dict)
        and entry.get("mtime_ns") == stat.st_mtime_ns
        and entry.get("size") == stat.st_size
        and isinstance(entry.get("sha256"), str)
    ):
        return str(entry["sha256"])

    digest = sha256_file(path)
    index[key] = {"mtime_ns": stat.st_mtime_ns, "size": stat.st_size, "sha256": digest}
    index_path.parent.mkdir(parents=True, exist_ok=True)
    # 原子写：索引文件本身也可能被并发请求读写，先写临时文件再替换避免读到半截 JSON。
    tmp = index_path.with_suffix(f"{index_path.suffix}.part")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(index_path)
    return digest
