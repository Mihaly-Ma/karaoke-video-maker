"""字体服务：让预览能用上任意系统字体。

## 为什么需要它

样式面板允许用户自选字体，但 JASSUB 用 `ASS_FONTPROVIDER_NONE` ——
**浏览器里拿不到系统字体**，字形必须由我们显式喂进去。

如果只预置一个 Noto Sans CJK JP，用户一换成明朝体，预览会 fallback 到 Noto、
导出却用真字体，**所见即所得当场失效**，而且这种偏差往往到成片才被发现。
预打包多套字体也不现实：每套子集化后约 4 MB，还覆盖不全用户机器上的字体。

所以按需来：列出系统字体 → 用户选中 → 后端子集化并缓存 → 前端加载同一份字节。
预览与导出因此用的是**同一个字体源**。

缓存键包含字体文件的 mtime 与大小，字体被替换后会自动重新生成。

## 冷扫描 40 余秒的处理：后台预热 + 可查询进度

本机实测冷扫描 **43.6 秒**（862 个 family / 902 个字体文件，含读取各语言别名），
二次启动命中磁盘缓存只要 **52ms**。但首次安装、或系统字体增删改之后仍然要等这
40 余秒，期间如果同步阻塞在接口里，用户看到的就是"界面卡死"——这正是
CLAUDE.md §2.5 所说的"自动环节失败时要降级、不能终止"的反面。

所以扫描一律**后台线程预热**（应用启动时由 `kvm.api.app` 的 lifespan 触发，
任何字体接口被调用时也会兜底触发），并且：

- `GET /api/fonts/status` 随时可查状态（进行中 / 完成 / 失败、已解析文件数、
  已发现字体族数），前端据此显示"正在扫描系统字体…"；
- 扫描期间 `GET /api/fonts/` 与 `/presets` **返回已扫到的部分结果**，
  既不阻塞也不报错，字体列表会随扫描推进逐渐变长；
- `/subset` 与 `/coverage` 需要具体某个 family，扫描期间若还没扫到它，
  返回 503 + 中文进度说明（而不是 404"系统中找不到字体"——那是假话）。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import platform
import subprocess
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import NamedTuple

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from kvm import paths
from kvm.models.karaoke import normalize_font_chain
from kvm.render import font_cache
from kvm.render.font_subset import SUBSET_VERSION, charset_digest, default_charset, subset_font
from pydantic import BaseModel

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fonts", tags=["fonts"])


def _cache_dir() -> Path:
    """缓存目录。路径规则的单一真源在 `kvm.paths`，这里只负责按需建目录。"""
    d = paths.font_cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _subset_cache_key(
    family: str, index: int, mtime_ns: int, size: int, as_family: str, extra: str
) -> str:
    """子集产物的磁盘缓存键。

    带上源文件的 mtime 与大小，字体被系统更新后会自动重新生成；还要带上
    `SUBSET_VERSION` —— 生成逻辑一改，老用户缓存目录里那份按旧逻辑产出的字体
    不会自己过期，会一直被当成命中直接下发。族名改写这个 bug 就踩在这上面：
    只改生成代码而不动缓存键，装过旧版的人永远拿不到修好的字体。

    `as_family`（产物对外自称的族名）与 `extra`（本曲额外字符）都会改变产物字节，
    所以两者都必须进键。代价是**换主字体会让整条链的产物全部失效重裁**——
    链上每个字体都要改名成新的链首。这是族名统一那条机制的必然开销
    （见 `subset_font` 与 `experiments/ass_embedded_fonts.py`），
    靠 `POST /coverage` 的预热把它挪到用户还在挑字体的时候完成。
    """
    payload = (
        f"v{SUBSET_VERSION}|{family}|{index}|{mtime_ns}|{size}"
        f"|as={as_family}|extra={charset_digest(extra)}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _scan_cache_file() -> Path:
    """磁盘缓存文件：跨进程重启复用扫描结果，避免每次冷启动都重新解析几百个字体。"""
    return _cache_dir() / "font-scan-cache.json"


class FontInfo(BaseModel):
    family: str
    path: str
    index: int = 0
    """TTC 字体集合内的族下标；非集合为 0。"""

    alt_names: list[str] = []
    """同一个字体在 name 表里的其它语言写法（已去掉与 `family` 重复的那条）。

    **搜索必须认这些名字**：日文字体普遍中英双名——ヒラギノ角ゴシック 的
    `family` 是英文的 `Hiragino Kaku Gothic ProN`，用户却多半会打「ヒラギノ」
    或「ひらぎの」。只按 `family` 搜的话，界面上看得见的名字反而搜不到，
    用户会以为本机没装这个字体。

    取的是 nameID 1（Family）与 16（Typographic Family）的**全部**平台/语言记录。
    也带上 16 是因为 macOS 日文字体的真族名常常只出现在那里
    （ヒラギノ丸ゴ ProN 的 nameID 1 是带字重后缀的 `... W4`）。
    """

    is_cjk: bool = False
    """是否覆盖日文字形。不覆盖的字体拿来排日语歌词只会渲染成豆腐块。"""

    weights: list[str] = []
    """该 family 下观测到的全部字重（子族名，如 W3/W6/W8/Regular/Bold），已排序去重。
    `path`/`index` 只是其中一个代表字重（优先取最接近常规字重 usWeightClass=400 的那个），
    前端可据此判断 Bold 样式命中的是本机真实粗体，还是需要合成粗体。"""


_FONT_DIRS_BY_OS = {
    "Darwin": ["/System/Library/Fonts", "/Library/Fonts", "~/Library/Fonts"],
    "Windows": ["C:/Windows/Fonts"],
    "Linux": ["/usr/share/fonts", "/usr/local/share/fonts", "~/.local/share/fonts"],
}


def _candidate_font_files(dirs: list[str]) -> list[Path]:
    """按扩展名列出候选字体文件，不打开解析——用于快速算签名。"""
    out: list[Path] = []
    for d in dirs:
        base = Path(d).expanduser()
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.suffix.lower() in (".ttf", ".otf", ".ttc", ".otc"):
                out.append(p)
    return out


SCAN_CACHE_VERSION = 2
"""扫描结果**记录格式**的版本。**给 `FontInfo` 加字段时必须 +1。**

它算进磁盘缓存签名里。不加的话，老缓存会照常命中，新字段一律取默认值——
`alt_names` 这次就是：用户机器上躺着 v1 的缓存，升级后搜索框永远搜不到日文名，
而且**看起来一切正常**（列表照常、扫描照常"已就绪"），没有任何东西提示要重扫。
判据与 `SUBSET_VERSION` 一样：不是"内容变没变"，而是"旧记录还够不够用"。
"""


def _scan_signature(files: list[Path]) -> str:
    """基于候选字体文件的路径 / mtime / 大小算一个签名，判断磁盘缓存是否过期。

    只 `stat`、不打开解析 name 表，比完整扫描快几个数量级（本机 902 个候选文件
    实测 stat 一遍约 5ms，而解析 name 表要 7~8 秒），字体被替换 / 增删后签名
    自然变化，缓存自动失效重新生成。
    """
    parts: list[str] = [f"scan-v{SCAN_CACHE_VERSION}"]
    for p in sorted(files):
        try:
            st = p.stat()
        except OSError:
            continue
        parts.append(f"{p}|{st.st_mtime_ns}|{st.st_size}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def _load_disk_cache(signature: str) -> list[FontInfo] | None:
    cache_file = _scan_cache_file()
    if not cache_file.is_file():
        return None
    try:
        payload = json.loads(cache_file.read_text(encoding="utf-8"))
        if payload.get("signature") != signature:
            return None
        return [FontInfo(**item) for item in payload["fonts"]]
    except (OSError, ValueError, KeyError, TypeError):
        # 缓存文件损坏或格式不兼容时退回重新扫描，不能让坏缓存把接口打挂
        return None


def _save_disk_cache(signature: str, fonts: list[FontInfo]) -> None:
    cache_file = _scan_cache_file()
    try:
        payload = {"signature": signature, "fonts": [f.model_dump() for f in fonts]}
        cache_file.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        pass  # 写缓存失败不影响本次扫描结果，下次再重试


class _Face(NamedTuple):
    """扫描过程中记下的一个字面。聚合成 `FontInfo` 之前的中间形态。"""

    weight: int
    subfamily: str
    path: str
    index: int
    is_cjk: bool
    alt_names: tuple[str, ...]


def _regular_weight_rank(item: _Face) -> tuple[int, int]:
    """越接近常规字重（usWeightClass=400）越优先，"Regular" 一类标签在等距时优先。"""
    is_regular_label = item.subfamily.strip().lower() in ("regular", "roman", "normal", "book")
    return (abs(item.weight - 400), 0 if is_regular_label else 1)


def _alt_family_names(face: object, family: str) -> tuple[str, ...]:
    """字体 name 表里除 `family` 之外的族名写法，供搜索匹配。

    同时收 nameID 1 与 16 的**全部**平台/语言记录：日文字体的日文名往往只在
    Mac 平台（platformID=1）或日语 langID 的记录里，只读 `getDebugName` 拿到的
    是英文那条。带字重后缀的写法（`... W4`）一并留着——用户照着字体册打字时
    很可能连字重一起打。
    """
    out: list[str] = []
    try:
        records = face["name"].names  # type: ignore[index]
    except Exception:
        return ()
    for record in records:
        if record.nameID not in (1, 16):
            continue
        try:
            text = str(record.toUnicode()).strip()
        except Exception:
            continue
        if text and text != family and text not in out:
            out.append(text)
    return tuple(out)


def _aggregate(candidates: dict[str, list[_Face]]) -> list[FontInfo]:
    """把 `family -> 各字重面` 的中间结果聚合成对外的字体列表。

    ASS 的 `Fontname` 用的是 family 名，字重由 Bold 标志控制——日文字体的字重
    普遍不叫 "Regular"（如 ヒラギノ丸ゴ ProN 是 "W4"、ヒラギノ明朝 ProN 是
    "W3"/"W6"），过滤 subfamily 只会把这些 family 整个判成"本机不可用"。
    所以这里**按 family 聚合、不按 subfamily 过滤**：同一 family 下的多个字重
    只返回一条记录，`weights` 记下观测到的全部字重，`path`/`index` 取其中最接近
    常规字重的一个作代表。
    """
    out: dict[str, FontInfo] = {}
    for family, items in candidates.items():
        rep = min(items, key=_regular_weight_rank)
        # 别名取全部字面的并集：同一 family 下不同字重的 name 表内容可能不一样
        # （日文名只写在其中一个字重上是常见情况），只看代表字面会漏掉。
        alt: list[str] = []
        for item in items:
            for name in item.alt_names:
                if name not in alt:
                    alt.append(name)
        out[family] = FontInfo(
            family=family,
            path=rep.path,
            index=rep.index,
            alt_names=alt,
            is_cjk=any(item.is_cjk for item in items),
            weights=sorted({item.subfamily for item in items}),
        )
    return sorted(out.values(), key=lambda x: (not x.is_cjk, x.family))


# ---------------------------------------------------------------------------
# 后台扫描：状态与进度（见模块文档"冷扫描 41 秒的处理"）
# ---------------------------------------------------------------------------

_PUBLISH_EVERY = 100
"""每解析多少个字体文件对外发布一次部分结果。取 100 是因为聚合本身可忽略不计
（几百条记录），而更密的发布只会增加锁竞争，更疏则扫描期间的列表迟迟不长。"""

_state_lock = threading.RLock()
_scan_thread: threading.Thread | None = None
_scan_state = "idle"
"""`idle` / `scanning` / `ready` / `failed`。"""

_scan_error: str | None = None
_scan_started_at: float | None = None
_scan_elapsed_s = 0.0
_scan_total_files = 0
_scan_done_files = 0
_scan_from_cache = False
_fonts: list[FontInfo] = []
"""`ready` 时是完整结果，`scanning` 时是已扫到的部分快照。"""


def _publish(fonts: list[FontInfo], *, done: int | None = None) -> None:
    global _fonts, _scan_done_files
    with _state_lock:
        _fonts = fonts
        if done is not None:
            _scan_done_files = done


def _finish(fonts: list[FontInfo], *, from_cache: bool, error: str | None = None) -> None:
    global _fonts, _scan_state, _scan_error, _scan_from_cache, _scan_elapsed_s
    with _state_lock:
        _fonts = fonts
        _scan_state = "failed" if error else "ready"
        _scan_error = error
        _scan_from_cache = from_cache
        _scan_elapsed_s = time.monotonic() - (_scan_started_at or time.monotonic())


def _run_scan() -> None:
    """后台线程的扫描主体。任何异常都收进 `_scan_error`，绝不让线程静默死掉——
    自动环节的错误必须可见（CLAUDE.md §2.5）。
    """
    global _scan_total_files
    try:
        # 顺手清掉旧版本的子集产物。**只删旧版本**（`stale_only`）：那些永远不会
        # 再被命中，删它没有竞态；当前版本的产物可能正在被 FileResponse 下发，
        # Windows 上删一个打开着的文件会直接报错，所以留给生成之后那一步去管。
        # 挂在这个已有的后台线程里，不额外起线程、也不拖慢 lifespan。
        try:
            font_cache.prune_font_cache(_cache_dir(), stale_only=True)
        except OSError as exc:  # pragma: no cover - 清理失败不该连累字体扫描
            _log.warning("字体缓存清理未完成：%s", exc)

        dirs = _FONT_DIRS_BY_OS.get(platform.system(), [])
        files = _candidate_font_files(dirs)
        with _state_lock:
            _scan_total_files = len(files)

        signature = _scan_signature(files)
        cached = _load_disk_cache(signature)
        if cached is not None:
            _publish(cached, done=len(files))
            _finish(cached, from_cache=True)
            return

        try:
            from fontTools.ttLib import TTCollection, TTFont
        except ImportError:
            _finish(
                [],
                from_cache=False,
                error="未安装 fontTools，无法扫描系统字体，请运行 `uv sync --extra fonts`",
            )
            return

        candidates: dict[str, list[_Face]] = {}

        for n, p in enumerate(files, start=1):
            try:
                if p.suffix.lower() in (".ttc", ".otc"):
                    coll = TTCollection(str(p))
                    faces = list(enumerate(coll.fonts))
                else:
                    faces = [(0, TTFont(str(p), fontNumber=0, lazy=True))]
            except Exception:
                # 损坏或加密的字体不应让整个列表打不开
                continue
            finally:
                if n % _PUBLISH_EVERY == 0:
                    _publish(_aggregate(candidates), done=n)

            for idx, f in faces:
                try:
                    family = f["name"].getDebugName(1) or ""
                    # 以 "." 开头的是 macOS 内部专用字体（如
                    # ".Hiragino Kaku Gothic Interface"），不面向用户，直接跳过
                    if not family or family.startswith("."):
                        continue
                    sub = f["name"].getDebugName(2) or "Regular"
                    cmap = f.getBestCmap()
                    # 用几个常见日文字形判定 CJK 覆盖，比读 OS/2 的码页位更可靠
                    is_cjk = all(ord(c) in cmap for c in "日本語あア")
                    try:
                        weight = int(f["OS/2"].usWeightClass)
                    except Exception:
                        weight = 400
                    alt = _alt_family_names(f, family)
                except Exception:
                    continue
                candidates.setdefault(family, []).append(
                    _Face(weight, sub, str(p), idx, is_cjk, alt)
                )

        result = _aggregate(candidates)
        _publish(result, done=len(files))
        _save_disk_cache(signature, result)
        _finish(result, from_cache=False)
    except Exception as exc:  # 后台线程顶层兜底，见函数文档字符串
        _finish(_fonts, from_cache=False, error=f"{type(exc).__name__}: {exc}")


def ensure_scan_started() -> None:
    """确保后台扫描已经启动（幂等）。

    由 `kvm.api.app` 的 lifespan 在启动时调用做预热；每个字体接口也会调一次
    兜底——否则以别的方式起后端（测试、脚本）时字体接口会永远空着。
    上次扫描失败的话允许再试一次。
    """
    global _scan_thread, _scan_state, _scan_started_at, _scan_done_files
    with _state_lock:
        if _scan_state in ("scanning", "ready"):
            return
        _scan_state = "scanning"
        _scan_started_at = time.monotonic()
        _scan_done_files = 0
        _scan_thread = threading.Thread(target=_run_scan, name="kvm-font-scan", daemon=True)
        _scan_thread.start()


def available_fonts() -> list[FontInfo]:
    """当前可用的字体列表：扫描完成时是全量，扫描中是已扫到的部分快照。

    **不阻塞等待扫描完成**——41 秒的等待对用户就是卡死。
    """
    ensure_scan_started()
    with _state_lock:
        return list(_fonts)


class FontScanStatus(BaseModel):
    state: str
    """`idle` / `scanning` / `ready` / `failed`。"""

    message: str
    """给用户看的中文状态说明，前端可直接显示。"""

    family_count: int
    scanned_files: int
    total_files: int
    elapsed_s: float
    from_cache: bool
    """本次结果是否直接来自磁盘缓存（是则说明没有真的重扫，耗时可忽略）。"""

    error: str | None = None


def _status_snapshot() -> FontScanStatus:
    with _state_lock:
        state = _scan_state
        count = len(_fonts)
        done, total = _scan_done_files, _scan_total_files
        elapsed = (
            _scan_elapsed_s
            if state in ("ready", "failed")
            else (time.monotonic() - _scan_started_at if _scan_started_at else 0.0)
        )
        from_cache, error = _scan_from_cache, _scan_error

    if state == "scanning":
        message = (
            f"正在扫描系统字体…（已解析 {done}/{total} 个字体文件，"
            f"已发现 {count} 个字体族）。首次扫描约需 40 秒，之后走磁盘缓存只要几毫秒。"
        )
    elif state == "ready":
        source = "磁盘缓存" if from_cache else f"实际扫描，耗时 {elapsed:.1f} 秒"
        message = f"系统字体已就绪，共 {count} 个字体族（{source}）。"
    elif state == "failed":
        message = f"系统字体扫描失败：{error}"
    else:
        message = "尚未开始扫描系统字体。"

    return FontScanStatus(
        state=state,
        message=message,
        family_count=count,
        scanned_files=done,
        total_files=total,
        elapsed_s=round(elapsed, 3),
        from_cache=from_cache,
        error=error,
    )


@router.get("/status", response_model=FontScanStatus)
def scan_status() -> FontScanStatus:
    """查询系统字体扫描状态，供前端显示"正在扫描系统字体…"而不是干等。

    调用它本身也会触发扫描（幂等），所以前端可以直接轮询这个接口开场。
    """
    ensure_scan_started()
    return _status_snapshot()


def _require_font(family: str) -> FontInfo:
    """按族名取字体；取不到时区分"扫描还没轮到它"与"本机确实没有"。

    扫描期间返回 404「系统中找不到字体」是假话，会让用户以为要去装字体。
    """
    match = next((f for f in available_fonts() if f.family == family), None)
    if match is not None:
        return match
    status = _status_snapshot()
    if status.state == "ready":
        raise HTTPException(status_code=404, detail=f"系统中找不到字体：{family}")
    raise HTTPException(
        status_code=503,
        detail=f"{status.message}尚未扫描到字体「{family}」，请稍候重试。",
        headers={"Retry-After": "2"},
    )


@router.get("/", response_model=list[FontInfo])
def list_fonts(cjk_only: bool = Query(default=False)) -> list[FontInfo]:
    """列出系统可用字体。`cjk_only=true` 时只返回覆盖日文的。

    扫描尚未完成时返回**已扫到的部分**而不是阻塞——列表会随扫描推进变长，
    完成与否请查 `GET /api/fonts/status`。
    """
    fonts = available_fonts()
    if cjk_only:
        fonts = [f for f in fonts if f.is_cjk]
    return fonts


_subset_lock = threading.Lock()
_subset_jobs: dict[Path, Future[None]] = {}
"""正在后台裁剪的产物路径 → 作业。同一份产物只裁一次，重复请求共用同一个作业。"""

_subset_errors: dict[Path, str] = {}
"""裁剪失败的原因。**必须留着**：否则前端会一直收到 503 重试到超时，
而真正的原因（比如族名对不上）没有任何人看得到——那正是 §2.5 说的
"自动环节的错误必须可见"。"""

SUBSET_WORKERS = 2
"""同时进行的裁剪作业数上限。

**必须有上限。**一条链有几个字体，前端就会并发发起几个请求（`loadFonts` 用的是
`Promise.all`），一人一条线程地裁下去，五个字体就是五份 fontTools 同时在跑，
每份都把整个字体读进内存（源字体动辄几十 MB），还把 API 线程挤没了——
用户那边表现成"连字体列表都刷不出来"。

**这个上限买的是资源封顶，不是速度。**本机实测冷裁剪整条链的墙钟时间：
单字体 **4.4s**、两字体 **12.0s**、三字体 **19.4s**——基本是线性叠加，
并没有并行收益。原因是裁剪是纯 Python 的 CPU 活，被 GIL 串起来了。
把数字调大不会更快，只会更占内存。

**真正解决排队的是预热**（`POST /coverage` 触发 `preheat_chain`）：用户在字体
列表里挑的那几秒到几十秒，正好把这段裁剪跑完，切到预览时已是缓存命中（**0.0s**）。
真要压缩这段时间，方向是换成子进程池（§5.13 的作业架构本就如此），
不是加线程——但那要先有值得付出的理由，目前预热已经把它盖住了。
"""

_subset_pool = ThreadPoolExecutor(max_workers=SUBSET_WORKERS, thread_name_prefix="kvm-font-subset")


def _subset_failure(dest: Path) -> str | None:
    with _subset_lock:
        return _subset_errors.pop(dest, None)


def _run_subset_job(match: FontInfo, src: Path, dest: Path, as_family: str, extra: str) -> None:
    """后台裁剪一份子集。

    **写临时文件再 rename**，不直接写 `dest`：`get_subset` 判断"有没有裁好"
    靠的就是 `dest.exists()`，直接写的话，文件一创建就会被认为已就绪，
    而此时里面还只有半截字节——下发出去就是一份坏字体，libass 画不出任何东西
    且不报错。rename 在同一文件系统内是原子的，要么没有、要么完整。

    临时文件名带上产物键（`dest.name`），不能是固定后缀：两个作业若共用同一个
    临时名，先完成的那个会被后完成的覆盖掉半截。
    """
    tmp = dest.with_name(dest.name + ".part")
    try:
        subset_font(
            src,
            tmp,
            charset=set(default_charset()) | set(extra),
            family_index=match.index,
            flavor=None,
            family_name=as_family,
        )
        tmp.replace(dest)
        # 刚裁完，正是做容量清理的时机（用户本来就在等下一次轮询）。
        # `protect` 保住刚生成的这份，否则会出现"裁完就被自己删掉、下次再裁"的抖动
        font_cache.prune_font_cache(_cache_dir(), protect=dest)
    except Exception as exc:  # 作业里任何异常都要留痕，不能静默死掉
        _log.warning("字体子集化失败：%s（%s）", match.family, exc)
        with _subset_lock:
            _subset_errors[dest] = str(exc)
        tmp.unlink(missing_ok=True)
    finally:
        with _subset_lock:
            _subset_jobs.pop(dest, None)


def _ensure_subset_job(match: FontInfo, src: Path, dest: Path, as_family: str, extra: str) -> None:
    """确保该产物正在（或已排队等待）后台裁剪。重复请求不该重复开工。"""
    with _subset_lock:
        job = _subset_jobs.get(dest)
        if job is not None and not job.done():
            return
        _subset_jobs[dest] = _subset_pool.submit(
            _run_subset_job, match, src, dest, as_family, extra
        )


def _subset_target(family: str, as_family: str, extra: str) -> tuple[FontInfo, Path, Path]:
    """解析出 `(字体记录, 源文件, 产物路径)`。找不到字体时抛 HTTPException。"""
    match = _require_font(family)
    src = Path(match.path)
    try:
        st = src.stat()
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"字体文件不可读：{src}") from exc
    key = _subset_cache_key(
        match.family, match.index, st.st_mtime_ns, st.st_size, as_family, extra
    )
    return match, src, _cache_dir() / font_cache.artifact_name(key)


def _normalize_extra(extra: str) -> str:
    """本曲额外字符：排序去重、丢掉空白与已在默认集合里的字符。

    排序去重让缓存键与字符出现顺序无关；剔掉默认集合里的字符则让绝大多数歌
    的 `extra` 直接变成空串——同一个字体的产物于是能在工程之间共用，
    而不是每首歌各裁一份。
    """
    base = default_charset()
    return "".join(sorted({c for c in extra if c.strip() and c not in base}))


@router.get("/subset")
def get_subset(
    family: str = Query(...),
    as_family: str = Query(default="", alias="as"),
    extra: str = Query(default=""),
) -> FileResponse:
    """按族名产出可供 JASSUB 使用的子集字体。

    产出必须是 **OTF/TTF**：JASSUB 把字节直接喂给 libass，而 libass 不认 woff2 ——
    用 woff2 会表现为"加载成功但一个字都渲染不出来"且不报错。

    ## 产物自称什么族名，由 `as` 决定

    默认（`as` 为空）自称 `family` 本身。**字体链场景下调用方必须显式传 `as`
    并填链首的族名**：libass 不会在族名互不相同的已加载字体之间做缺字回退
    （`experiments/ass_embedded_fonts.py` 的 distinct 组实测：内嵌一份带该字形、
    族名不同的字体，ffmpeg 侧照样去用系统字体）。让整条链共用一个族名，
    它们就成了同一个族的多个字面，libass 在其中挑一个带该字形的——
    这是字体匹配的基本功能，不是回退启发式，两端行为一致。

    不改写族名也不行：系统字体的 nameID 1 常带字重后缀（ヒラギノ丸ゴ ProN 是
    `Hiragino Maru Gothic ProN W4`），libass 按 nameID 1 匹配，对不上就整块空白
    且不报错。详见 `kvm.render.font_subset` 的模块文档。

    ## `extra` 补的是本曲用到、但默认集合裁不到的字

    默认集合是 ASCII + 假名 + JIS X 0208 第一/第二水准，「鷗」「𠮷」「①」「㍿」
    都在集合外。不补的话这些字**预览空白、成片正常**——与缺字相反的一种分叉，
    只看预览发现不了原因，只看成片根本发现不了。

    扫描尚未覆盖到该字体时返回 503 + 中文进度说明（见 `_require_font`）。

    ## 冷生成不阻塞请求（实测 9.4–10.9 秒）

    本机实测：冷生成一份子集要 **9.4 秒（Noto Sans CJK JP）到 10.9 秒
    （ヒラギノ明朝 ProN）**，而命中缓存只要 **12–17 毫秒**，差了约 700 倍。

    这一段以前是**同步**做的，于是整整十秒里请求就那么挂着。后果不是"慢一点"：
    用户在样式面板点一个没裁过的字体，预览是空白的；他多半会以为这个字体坏了，
    再点下一个——而每点一次都会重建一次字幕层、发起一次新的十秒请求，
    上一次的还在占着线程池。**表现出来就是"只有某几个字体能用"**，
    而"能用"的恰好是缓存里已经有的那几个。

    所以改成：**后台裁，请求立刻返回 503 + `Retry-After`**。
    前端 `lib/jassub.ts` 的 `fetchFontData` 本来就认这个协议（最长等 60 秒），
    不需要新增任何前端机制；用户看到的是"字体准备中"，而不是一块空白。
    """
    clean_extra = _normalize_extra(extra)
    match, src, dest = _subset_target(family, as_family or family, clean_extra)

    if not dest.exists():
        _ensure_subset_job(match, src, dest, as_family or family, clean_extra)
        failure = _subset_failure(dest)
        if failure is not None:
            raise HTTPException(status_code=500, detail=f"字体子集化失败：{failure}")
        raise HTTPException(
            status_code=503,
            detail=f"正在为「{family}」裁剪预览字体（首次约 10 秒），请稍候。",
            headers={"Retry-After": "2"},
        )

    return FileResponse(
        dest,
        media_type="font/otf",
        headers={
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


def preheat_chain(chain: list[str], extra: str) -> None:
    """把整条链的子集产物排进后台裁剪队列。**不等结果、不抛异常。**

    这是"多字体冷裁剪"唯一像样的解法：真正的等待发生在用户切到预览的那一刻，
    而选字体与看预览之间总有几秒到几十秒的间隙——预检（`POST /coverage`）
    正好在用户还在字体列表里挑的时候被调用，把这段间隙用上，链再长也不必排队等。

    失败不上报：预热本来就是尽力而为，真正需要这份产物时 `/subset` 会重新触发
    并把错误如实告诉调用方（§2.5：降级，不终止）。
    """
    head = chain[0] if chain else ""
    if not head:
        return
    clean_extra = _normalize_extra(extra)
    for family in chain:
        try:
            match, src, dest = _subset_target(family, head, clean_extra)
        except HTTPException:
            continue  # 还没扫到 / 文件不可读：等真正要用时再报
        if not dest.exists():
            _ensure_subset_job(match, src, dest, head, clean_extra)


def chain_font_bytes(chain: list[str], extra: str, *, timeout_s: float = 180.0) -> list[tuple[str, bytes]]:
    """取整条链的子集字节，供导出时嵌进 ASS 的 `[Fonts]` 段。

    与预览侧 `GET /subset` 走**同一套缓存键、同一份产物文件**，所以两端拿到的
    是逐字节相同的字体——§5.12 要的"两端同源"落在这里，而不是靠两边各自
    再做一次相同的裁剪（那样只要有一处参数漂移就会分叉，且分叉不可见）。

    这里**可以同步等**：导出本来就是几分钟量级的作业，多等十几秒无所谓，
    而预览侧一秒都不能阻塞。等不到就跳过该字体——宁可这一个字用系统回退，
    也不要整场导出失败（§2.5）。
    """
    head = chain[0] if chain else ""
    if not head:
        return []
    clean_extra = _normalize_extra(extra)
    out: list[tuple[str, bytes]] = []
    deadline = time.monotonic() + timeout_s
    for family in chain:
        try:
            match, src, dest = _subset_target(family, head, clean_extra)
        except HTTPException as exc:
            _log.warning("导出内嵌字体：跳过「%s」（%s）", family, exc.detail)
            continue
        if not dest.exists():
            _ensure_subset_job(match, src, dest, head, clean_extra)
            with _subset_lock:
                job = _subset_jobs.get(dest)
            if job is not None:
                with contextlib.suppress(Exception):
                    job.result(timeout=max(1.0, deadline - time.monotonic()))
        if dest.exists():
            out.append((family, dest.read_bytes()))
        else:
            _log.warning("导出内嵌字体：「%s」未能在限时内裁好，本次跳过", family)
    return out


class PresetInfo(BaseModel):
    key: str
    label: str
    note: str
    resolved: str | None = None
    """本机实际选中的字体族。为 None 表示该档在本机不可用（除非 `pending=True`）。"""

    candidates: list[str] = []

    pending: bool = False
    """该档尚未命中候选，但系统字体还在后台扫描中，结果可能变化。

    界面此时应显示"正在扫描系统字体…"，**不能显示"该档不可用"**——
    那是把"还没查完"说成了"查过了没有"，用户会误以为要自己去装字体。
    """


@router.get("/presets", response_model=list[PresetInfo])
def list_presets() -> list[PresetInfo]:
    """卡拉OK 常用字体档位（粗黑体 / 黑体 / 圆体 / 明朝）。

    每档给出本机实际能用的字体。某档一个候选都没命中时 `resolved=None`，
    界面应显示为不可用并说明原因——**绝不能悄悄换成别的字体**：
    用户选了明朝体却渲染出黑体，比"该档不可用"更糟。

    扫描未完成时按**已扫到的部分**解析，未命中的档位带 `pending=True`。
    """
    from kvm.render.font_presets import resolve_presets

    families = [f.family for f in available_fonts()]
    scanning = _status_snapshot().state != "ready"
    presets = [PresetInfo(**item) for item in resolve_presets(families)]
    for preset in presets:
        preset.pending = scanning and preset.resolved is None
    return presets


class FontShare(BaseModel):
    """链上一个字体实际承担了哪些字形。"""

    family: str
    count: int
    chars: str
    """该字体承担的字形。按链序判定：前面的字体有，就轮不到后面的。

    只列**它是第一个能提供该字形**的那些字。这样各条 `chars` 互不重叠，
    加起来正好是"查过的字符 − 全链都缺的字符"。
    """


class FontCoverage(BaseModel):
    family: str
    """链首族名。老调用方（导出面板）只认这一个字段，保留它。"""

    families: list[str] = []
    """本次检查的整条链。"""

    missing: list[str]
    """**整条链都没有**的字形：预览与成片都会缺。

    语义随字体链变了：以前问的是"这一个字体够不够"，现在问的是"这条链够不够"。
    链尾补上的字不再算缺字——那正是加链尾的目的。
    """

    preview_missing: list[str]
    """链里有、但预览无论如何都拿不到的字形：**只有预览缺，成片是好的**。

    这一项**现在恒为空**，因为子集会按本曲字符集加裁（`GET /subset` 的 `extra`）：
    凡是链里有的字，预览的子集里就有。字段保留是为了两件事：接口兼容
    （导出面板读它），以及把这条差异记在契约里——它曾经非空，
    症状是"预览空白、成片正常"，与缺字相反的分叉，只看成片根本发现不了。

    要知道哪些字是靠加裁才补上的，看 `extra_chars`，那是**提示**不是**缺陷**。
    """

    extra_chars: str = ""
    """本曲用到、但落在默认子集（ASCII + 假名 + JIS X 0208 一/二水准）之外的字。

    预览要靠 `GET /subset?extra=` 把它们补进子集才画得出来。**不是问题清单**——
    非空只说明这首歌用到了生僻字，一切正常。放在这里是为了排查：
    真出现"预览空白成片正常"时，第一件事就是看这些字有没有被送进 `extra`。
    """

    shares: list[FontShare] = []
    """逐字体的承担情况，链序排列。回答的是"每个字实际由哪个字体画"。"""

    total_checked: int


class FontCoverageRequest(BaseModel):
    """`POST /fonts/coverage` 的请求体。

    **参数走请求体而不是 query**：调用方要查的是整首歌的字符集，
    percent-encoding 后每个汉字占 9 字节，几百个不重复字符就逼近 uvicorn
    对请求行 + 头部的 16 KB 上限——超限时表现为连接被掐断，不是可读的 4xx。
    调用方仍应先去重（只送不重复字符），两层保险各自独立。
    """

    family: str = ""
    """**兼容入口**：只查一个字体时用它。给了 `families` 就以后者为准。"""

    families: list[str] = []
    """要检查的整条字体链，按优先级排列。"""

    text: str

    def chain(self) -> list[str]:
        return normalize_font_chain(self.families or ([self.family] if self.family else []))


_preview_charset: frozenset[str] | None = None


def _subset_charset() -> frozenset[str]:
    """预览子集字体保留的字符集（缓存一份）。

    `default_charset()` 要遍历两万多个码位试 shift_jis 编码，
    每次请求重算纯属浪费；它在进程生命周期内不会变。
    """
    global _preview_charset
    if _preview_charset is None:
        from kvm.render.font_subset import default_charset

        _preview_charset = frozenset(default_charset())
    return _preview_charset


def _font_cmap(match: FontInfo) -> dict[int, str]:
    try:
        from fontTools.ttLib import TTCollection, TTFont

        if Path(match.path).suffix.lower() in (".ttc", ".otc"):
            font = TTCollection(match.path).fonts[match.index]
        else:
            font = TTFont(match.path, lazy=True)
        return font.getBestCmap()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取字体失败：{exc}") from exc


@router.post("/coverage", response_model=FontCoverage)
def check_coverage(req: FontCoverageRequest) -> FontCoverage:
    """检查**整条字体链**能否覆盖给定文本的全部字形，以及每个字由谁承担。

    CLAUDE.md §2.6 / §6.3 要求**字体缺字必须在渲染前拦截** —— 预览与导出若因缺字
    fallback 到不同字体，WYSIWYG 就失效了，而这种问题通常到成片才暴露。

    链让问题从"这个字体够不够"变成两个问题，界面上要分开说：

    - **整条链够不够**（`missing`）：链尾都补不上的字，换字体或加字体才能解决；
    - **每个字由谁画**（`shares`）：链首没覆盖住多少字、是谁在兜底。
      这一条不是锦上添花——用户配了链却不知道链尾有没有真的被用到，
      等于配了个不知道有没有生效的东西。

    `preview_missing` 保留原义（链里有、预览子集裁掉了），正常情况下恒为空，
    见该字段的说明。

    扫描尚未覆盖到链里某个字体时返回 503 + 中文进度说明（见 `_require_font`）。

    顺带**预热整条链的子集产物**：这一刻用户还在字体列表里挑，离切到预览
    还有几秒到几十秒，正是把十秒级的裁剪塞进去的地方（见 `preheat_chain`）。
    """
    chain = req.chain()
    matches = [_require_font(family) for family in chain]

    # 空白字符不计：缺一个空格不影响观感，而全角空格之类算进来只会制造噪声
    checked = sorted({c for c in req.text if c.strip()})
    subset = _subset_charset()

    remaining = set(checked)
    covered: set[str] = set()
    shares: list[FontShare] = []
    for match in matches:
        cmap = _font_cmap(match)
        owned = sorted(c for c in remaining if ord(c) in cmap)
        remaining.difference_update(owned)
        covered.update(owned)
        shares.append(FontShare(family=match.family, count=len(owned), chars="".join(owned)))

    preheat_chain(chain, "".join(checked))

    return FontCoverage(
        family=chain[0] if chain else "",
        families=chain,
        missing=sorted(remaining),
        # 子集按 extra 加裁之后，"链里有而预览没有"这种字已经不存在了。
        # 保留字段与含义，见 `FontCoverage.preview_missing`。
        preview_missing=[],
        extra_chars="".join(sorted(c for c in covered if c not in subset)),
        shares=shares,
        total_checked=len(checked),
    )


def _probe_fontconfig() -> list[str]:  # pragma: no cover - 仅 Linux 路径
    """Linux 上用 fc-list 兜底，避免漏掉非标准目录里的字体。"""
    try:
        out = subprocess.run(
            ["fc-list", ":", "family"], capture_output=True, text=True, timeout=30
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted({line.split(",")[0].strip() for line in out.splitlines() if line.strip()})
