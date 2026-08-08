"""歌词 provider 的抽象接口。

CLAUDE.md §5.2（已定）：

```
LyricProvider.search(query) -> [TrackMatch]
LyricProvider.fetch(match)  -> LyricCandidate
LyricResolver.rank(candidates, target) -> 排序
```

provider **只负责"取回并归一化"，不负责选择**——把候选摆出来让用户挑，
不自动替他选。候选必须暴露 `granularity`（逐字/句级/纯文本）与 `has_ruby`
（是否自带假名读音轨），这两项决定用户还要不要手工打轴/注音。

`search()` 阶段还没有下载正文，`granularity`/`has_ruby` 只能是 provider
按自身已知能力给出的**保守估计**；真实值要等 `fetch()` 解析出正文后才能
确认（路由层的 `/preview`、`/apply` 用的就是 `fetch()` 的结果）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from kvm.api.schemas import LineDTO

Granularity = Literal["word", "line", "plain"]
"""与 `schemas.LyricCandidate.granularity` 完全一致的取值集合，两处必须同步。"""


class LyricProviderError(RuntimeError):
    """provider 搜索/拉取失败的统一异常，`str(exc)` 即可直接展示给用户的中文原因。

    CLAUDE.md §2.5：自动环节失败不能让流程卡死，只能把错误暴露出来，
    由用户决定重试或改走手工导入——**不能吞掉异常静默返回空结果**，
    那样会让用户误以为"这首歌真的查不到"。
    """


@dataclass(slots=True)
class TrackMatch:
    """一条搜索命中：曲目元信息，尚未取歌词正文。"""

    provider: str
    song_id: str
    title: str
    artist: str
    album: str = ""
    duration_ms: int = 0
    granularity: Granularity = "line"
    """search 阶段的保守估计，真实粒度以 fetch() 解析结果为准。"""
    has_ruby: bool = False
    has_translation: bool = False
    note: str = ""


@dataclass(slots=True)
class ParsedLyric:
    """fetch() 后已归一化解析的歌词正文。"""

    lines: list[LineDTO] = field(default_factory=list)
    granularity: Granularity = "line"
    has_ruby: bool = False
    has_translation: bool = False
    raw_excerpt: str = ""


class LyricProvider(ABC):
    """歌词源的统一接口。一个 provider 对应一个外部歌词服务。"""

    name: str

    @abstractmethod
    def search(self, query: str, *, duration_hint_ms: int | None = None) -> list[TrackMatch]:
        """按查询词搜索候选曲目。

        真正查不到时返回空列表（这是正常结果，不是错误）；网络请求失败、
        响应格式异常等**故障**必须抛 `LyricProviderError`，不能静默返回空列表——
        两者对用户的含义完全不同（"这歌没有"vs"这次没搜成，可以重试"）。
        """

    @abstractmethod
    def fetch(self, song_id: str) -> ParsedLyric:
        """按 `search()` 给出的 `song_id` 取回并解析歌词正文。失败抛 `LyricProviderError`。"""
