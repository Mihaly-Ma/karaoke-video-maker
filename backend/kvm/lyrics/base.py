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

## `search()` 阶段的诚实边界（重要，别再猜了）

`search()` 拿到的通常只是曲目元信息（歌手/时长/songmid 之类），**不含歌词正文**，
因此在这个阶段不可能真正知道该曲是否有假名注音、也不知道真实粒度——之前的实现
在这里"自信地"给 QQ 音乐的每条搜索结果都标 `granularity="word", has_ruby=True`，
等于把"这个 provider 理论上支持逐字+注音"当成了"这一条结果确实有"，
两者不是一回事：同一 provider 下不同曲目、乃至没有 QRC 只有 LRC 的曲目都存在。
这正是 CLAUDE.md §5.2 铁律要防的事——**粒度可以被提升，不能被伪造**。

因此：**`search()` 不确定就必须诚实给出"未知"**（`granularity="unknown"` /
`has_ruby=None`），不能替 `fetch()` 打包票。只有 provider 确实能从搜索接口本身
拿到可靠信息时（比如某个源本来就只提供行级歌词，那从"是这个源"就能确定
`granularity="line"`），才允许在 `search()` 阶段给出非 unknown 的确定值。

真实值要等 `fetch()` 解析出正文后才能确认（路由层的 `/preview`、`/apply`
用的就是 `fetch()` 的结果，那里的 `granularity`/`has_ruby` 永远是解析产物，
不是估计）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from kvm.api.schemas import LineDTO

Granularity = Literal["word", "line", "plain", "unknown"]
"""与 `schemas.LyricCandidate.granularity` 完全一致的取值集合，两处必须同步。

`unknown` 专用于 `search()` 阶段"确实不知道"的诚实状态，`fetch()`/`ParsedLyric`
产出的粒度是实际解析结果，不应该是 `unknown`。"""


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
    granularity: Granularity = "unknown"
    """search 阶段确实知道时才给确定值，不知道就是 `unknown`——
    不能拿"这个 provider 理论上支持什么粒度"冒充"这一条结果真的是什么粒度"。
    真实粒度以 fetch() 解析结果为准。"""
    has_ruby: bool | None = None
    """是否带假名注音轨。`None` = search 阶段无法确定（多数 provider 的搜索接口
    不含歌词正文，天然不知道）；`True`/`False` = 确实知道（provider 从搜索接口
    本身就能可靠判断，或者该源本来就不可能有注音）。真实值以 fetch() 为准。"""
    has_translation: bool = False
    note: str = ""


@dataclass(slots=True)
class ParsedLyric:
    """fetch() 后已归一化解析的歌词正文。

    这里的 `granularity`/`has_ruby` 是**实际解析结果**，不是估计——
    fetch() 已经拿到正文，没有"不知道"的余地，因此不使用 `unknown`/`None`。
    """

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
