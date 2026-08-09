"""预览字体子集缓存的**清理**。

## 为什么必须有这个模块

字体子集产物一个 3–6 MB，而缓存键里带着 `SUBSET_VERSION`（`kvm.render.font_subset`）
——生成逻辑每改一版，老产物就在磁盘上再堆一层，**从来没有任何东西会删掉它们**。
本机实测目录已经长到 **106 MB / 26 个 .otf**，用户最后是自己动手 `rm` 才恢复的。
CLAUDE.md §2.6 的原话是"用户不应该为了跑起这个工具去手动做任何事"，
手动删缓存正是它要排除的那类事。

## 清理策略与理由

1. **先按版本删**：文件名带 `v{SUBSET_VERSION}-` 前缀，凡版本号小于当前的一律删。
   这是主要收益——版本升级带来的堆积是本项目的实际增长来源，而旧版产物
   **永远不会再被命中**（缓存键里就有版本号），删掉零成本。
2. **再按容量删**：当前版本的产物若仍超出预算，按 mtime 从旧到新删到预算以下。
   当前版本的产物是**热数据**（删了下次要重裁几秒），所以排在版本清理之后，
   而且只在真的超预算时才动。
3. **永不删非本工具产物**：只处理 `font_cache_dir()` 下、文件名严格匹配
   `v<数字>-<16 位十六进制>.otf`（或加版本前缀之前的老命名 `<16 位十六进制>.otf`）
   的文件，不递归、不跟随符号链接。目录里的 `font-scan-cache.json` 天然不在范围内。
   删文件不可逆，判据宁可严到"少删"，也不要宽到"多删一个用户的东西"。
   老命名那条**不是可选项**：用户磁盘上堆着的 106 MB 全是那个形状，
   只认新命名等于机制做了却一份都清不掉。

## 什么时候触发（这条很容易做错）

**不在用户等着渲染的时候做。** 两个触发点都刻意选在"用户本来就在等"的间隙之外：

- **启动时**（后台线程）：**只删旧版本产物**。旧版产物不可能正在被下发，
  删它没有竞态。
- **生成新产物之后**：此时刚花了几秒裁字体，多几毫秒 stat 无感；这一步做
  容量清理，且**保证保留刚生成的那份**。

代价是 O(文件数) 次 `stat`，不是 O(字节数)——整个清理不读文件内容，
106 MB 的目录也只是二十几次 stat + unlink。

**当前版本的产物在启动时不动**，还有一个 Windows 上的理由：`FileResponse`
正在下发的文件若被删掉，POSIX 下无所谓（fd 还在），Windows 上会直接报错。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from kvm import paths
from kvm.render.font_subset import SUBSET_VERSION

_log = logging.getLogger(__name__)

_ARTIFACT_RE = re.compile(r"^v(\d+)-[0-9a-f]{16}\.otf$")
"""本工具自己产出的子集文件名。**清理的判据之一**，别放宽。

版本号写进文件名而不是只藏在哈希里，正是为了让"这份属于哪一代"可以直接读出来
——键是 sha256 的前 16 位，从哈希本身看不出版本，也就没法按版本清理。
"""

_LEGACY_ARTIFACT_RE = re.compile(r"^[0-9a-f]{16}\.otf$")
"""**加版本前缀之前**的老命名（纯 16 位十六进制 + `.otf`）。

这条不是补丁，是清理机制能不能兑现的关键：用户磁盘上那 106 MB **全是这个形状**，
只认新命名的话，真正堆积的那一堆一份都删不掉——机制看起来做了，实际什么都没清。

判据依然很严：必须在**本工具自己的缓存目录**下、名字恰好是 16 位小写十六进制、
扩展名恰好是 `.otf`。同目录下的 `font-scan-cache.json` 天然不匹配。
新命名一律带 `v<数字>-` 前缀，所以这个形状**只可能是旧产物**，永远是过期的。
"""

DEFAULT_MAX_BYTES = 256 * 1024 * 1024
"""当前版本产物的容量预算。

一个子集 3–6 MB，fallback 链让单曲可能同时用到好几个字体，再乘上用户试过的
字体数——256 MB 大约是 40–80 份，足够覆盖正常使用，又不至于让缓存长成几个 GB。
"""


def artifact_name(key: str) -> str:
    """子集产物的文件名。版本前缀是清理逻辑的依据，不要改成别的形状。"""
    return f"v{SUBSET_VERSION}-{key}.otf"


@dataclass
class PruneReport:
    """一次清理的结果。数字要能直接讲给用户听，所以按"删了什么"分类。"""

    removed_stale: int = 0
    """删掉的旧版本产物个数。"""
    removed_overflow: int = 0
    """因超出容量预算而删掉的当前版本产物个数。"""
    freed_bytes: int = 0
    kept_files: int = 0
    kept_bytes: int = 0

    @property
    def removed_files(self) -> int:
        return self.removed_stale + self.removed_overflow


def _artifacts(cache_dir: Path) -> list[tuple[int, Path, int, float]]:
    """目录里属于本工具的产物：`(版本, 路径, 字节数, mtime)`。

    只看第一层，且跳过符号链接——顺着链接删出目录外是最容易造成不可逆损失的路径。
    """
    out: list[tuple[int, Path, int, float]] = []
    try:
        entries = list(cache_dir.iterdir())
    except OSError:
        return out
    for entry in entries:
        match = _ARTIFACT_RE.match(entry.name)
        legacy = match is None and _LEGACY_ARTIFACT_RE.match(entry.name) is not None
        if match is None and not legacy:
            continue
        try:
            if entry.is_symlink() or not entry.is_file():
                continue
            st = entry.stat()
        except OSError:
            continue
        # 老命名记成版本 0：它一定不等于当前版本，于是自然走"旧版本产物"那条清理路径
        version = int(match.group(1)) if match else 0
        out.append((version, entry, st.st_size, st.st_mtime))
    return out


def cache_stats(cache_dir: Path | None = None) -> tuple[int, int, int]:
    """`(产物个数, 总字节数, 旧版本产物个数)`。供自检展示，不做任何删除。"""
    target = cache_dir or paths.font_cache_dir()
    items = _artifacts(target)
    stale = sum(1 for version, _p, _s, _m in items if version != SUBSET_VERSION)
    return len(items), sum(size for _v, _p, size, _m in items), stale


def prune_font_cache(
    cache_dir: Path | None = None,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    stale_only: bool = False,
    protect: Path | None = None,
) -> PruneReport:
    """清理缓存目录，返回删了多少。

    `stale_only=True` 时只删旧版本产物（启动时用这一档，见模块文档）。
    `protect` 指向刚生成的那份产物，容量清理时**绝不删它**——否则会出现
    "刚裁好就被自己删掉、下次请求再裁一遍"的抖动。
    """
    target = cache_dir or paths.font_cache_dir()
    report = PruneReport()
    items = _artifacts(target)

    current: list[tuple[Path, int, float]] = []
    for version, path, size, mtime in items:
        if version != SUBSET_VERSION:
            try:
                path.unlink()
            except OSError as exc:  # pragma: no cover - 权限/占用，跳过即可
                _log.warning("字体缓存清理：删不掉 %s（%s）", path, exc)
                continue
            report.removed_stale += 1
            report.freed_bytes += size
        else:
            current.append((path, size, mtime))

    if not stale_only:
        total = sum(size for _p, size, _m in current)
        # 从旧到新删。写入即最后一次使用，atime 在很多挂载上是关掉的，
        # 所以这里就是 FIFO 而不是严格的 LRU——对"缓存"来说够用，别为此去开 atime
        for path, size, _mtime in sorted(current, key=lambda x: x[2]):
            if total <= max_bytes:
                break
            if protect is not None and path == protect:
                continue
            try:
                path.unlink()
            except OSError as exc:  # pragma: no cover
                _log.warning("字体缓存清理：删不掉 %s（%s）", path, exc)
                continue
            total -= size
            report.removed_overflow += 1
            report.freed_bytes += size

    kept = _artifacts(target)
    report.kept_files = len(kept)
    report.kept_bytes = sum(size for _v, _p, size, _m in kept)
    if report.removed_files:
        _log.info(
            "字体缓存清理：删除 %d 份（旧版本 %d / 超预算 %d），释放 %.1f MB，剩余 %d 份 %.1f MB",
            report.removed_files,
            report.removed_stale,
            report.removed_overflow,
            report.freed_bytes / 1024**2,
            report.kept_files,
            report.kept_bytes / 1024**2,
        )
    return report
