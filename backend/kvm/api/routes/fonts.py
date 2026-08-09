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

## 冷扫描 41 秒的处理：后台预热 + 可查询进度

本机实测冷扫描 **40.9 秒**（862 个 family / 900 余个字体文件），二次启动命中
磁盘缓存只要 8ms。但首次安装、或系统字体增删改之后仍然要等这 41 秒，期间
如果同步阻塞在接口里，用户看到的就是"界面卡死"——这正是 CLAUDE.md §2.5
所说的"自动环节失败时要降级、不能终止"的反面。

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

import hashlib
import json
import platform
import subprocess
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from kvm.api.store import default_root
from kvm.render.font_subset import SUBSET_VERSION, subset_font

router = APIRouter(prefix="/api/fonts", tags=["fonts"])


def _cache_dir() -> Path:
    d = default_root().parent / "font-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _subset_cache_key(family: str, index: int, mtime_ns: int, size: int) -> str:
    """子集产物的磁盘缓存键。

    带上源文件的 mtime 与大小，字体被系统更新后会自动重新生成；还要带上
    `SUBSET_VERSION` —— 生成逻辑一改，老用户缓存目录里那份按旧逻辑产出的字体
    不会自己过期，会一直被当成命中直接下发。族名改写这个 bug 就踩在这上面：
    只改生成代码而不动缓存键，装过旧版的人永远拿不到修好的字体。
    """
    payload = f"v{SUBSET_VERSION}|{family}|{index}|{mtime_ns}|{size}"
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _scan_cache_file() -> Path:
    """磁盘缓存文件：跨进程重启复用扫描结果，避免每次冷启动都重新解析几百个字体。"""
    return _cache_dir() / "font-scan-cache.json"


class FontInfo(BaseModel):
    family: str
    path: str
    index: int = 0
    """TTC 字体集合内的族下标；非集合为 0。"""

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


def _scan_signature(files: list[Path]) -> str:
    """基于候选字体文件的路径 / mtime / 大小算一个签名，判断磁盘缓存是否过期。

    只 `stat`、不打开解析 name 表，比完整扫描快几个数量级（本机 902 个候选文件
    实测 stat 一遍约 5ms，而解析 name 表要 7~8 秒），字体被替换 / 增删后签名
    自然变化，缓存自动失效重新生成。
    """
    parts: list[str] = []
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


def _regular_weight_rank(item: tuple[int, str, str, int, bool]) -> tuple[int, int]:
    """越接近常规字重（usWeightClass=400）越优先，"Regular" 一类标签在等距时优先。"""
    weight, sub, _path, _idx, _is_cjk = item
    is_regular_label = sub.strip().lower() in ("regular", "roman", "normal", "book")
    return (abs(weight - 400), 0 if is_regular_label else 1)


def _aggregate(candidates: dict[str, list[tuple[int, str, str, int, bool]]]) -> list[FontInfo]:
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
        out[family] = FontInfo(
            family=family,
            path=rep[2],
            index=rep[3],
            is_cjk=any(item[4] for item in items),
            weights=sorted({item[1] for item in items}),
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
            _finish([], from_cache=False, error="未安装 fontTools，无法扫描系统字体，请运行 `uv sync --extra fonts`")
            return

        # family -> [(usWeightClass, subfamily, path, index, is_cjk), ...]
        candidates: dict[str, list[tuple[int, str, str, int, bool]]] = {}

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
                except Exception:
                    continue
                candidates.setdefault(family, []).append((weight, sub, str(p), idx, is_cjk))

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
        elapsed = _scan_elapsed_s if state in ("ready", "failed") else (
            time.monotonic() - _scan_started_at if _scan_started_at else 0.0
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


@router.get("/subset")
def get_subset(family: str = Query(...)) -> FileResponse:
    """按族名产出可供 JASSUB 使用的子集字体。

    产出必须是 **OTF/TTF**：JASSUB 把字节直接喂给 libass，而 libass 不认 woff2 ——
    用 woff2 会表现为"加载成功但一个字都渲染不出来"且不报错。

    产物的族名被改写成**这里请求的 `family`**（`subset_font(family_name=...)`）：
    libass 只按 name 表的 nameID 1 匹配，而系统字体的 nameID 1 常带字重后缀
    （ヒラギノ丸ゴ ProN 是 `Hiragino Maru Gothic ProN W4`），不改写就匹配不上，
    预览会整块空白且不报错。详见 `kvm.render.font_subset` 的模块文档。

    扫描尚未覆盖到该字体时返回 503 + 中文进度说明（见 `_require_font`）。
    """
    match = _require_font(family)

    src = Path(match.path)
    try:
        st = src.stat()
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"字体文件不可读：{src}") from exc

    key = _subset_cache_key(match.family, match.index, st.st_mtime_ns, st.st_size)
    dest = _cache_dir() / f"{key}.otf"

    if not dest.exists():
        try:
            subset_font(src, dest, family_index=match.index, flavor=None, family_name=match.family)
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"字体子集化失败：{exc}"
            ) from exc

    return FileResponse(
        dest,
        media_type="font/otf",
        headers={
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


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


class FontCoverage(BaseModel):
    family: str
    missing: list[str]
    total_checked: int


@router.post("/coverage", response_model=FontCoverage)
def check_coverage(family: str = Query(...), text: str = Query(...)) -> FontCoverage:
    """检查字体能否覆盖给定文本的全部字形。

    CLAUDE.md 要求**字体缺字必须在渲染前拦截** —— 预览与导出若因缺字
    fallback 到不同字体，WYSIWYG 就失效了，而这种问题通常到成片才暴露。

    扫描尚未覆盖到该字体时返回 503 + 中文进度说明（见 `_require_font`）。
    """
    match = _require_font(family)

    try:
        from fontTools.ttLib import TTCollection, TTFont

        if Path(match.path).suffix.lower() in (".ttc", ".otc"):
            font = TTCollection(match.path).fonts[match.index]
        else:
            font = TTFont(match.path, lazy=True)
        cmap = font.getBestCmap()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取字体失败：{exc}") from exc

    checked = {c for c in text if c.strip()}
    missing = sorted(c for c in checked if ord(c) not in cmap)
    return FontCoverage(family=family, missing=missing, total_checked=len(checked))


def _probe_fontconfig() -> list[str]:  # pragma: no cover - 仅 Linux 路径
    """Linux 上用 fc-list 兜底，避免漏掉非标准目录里的字体。"""
    try:
        out = subprocess.run(
            ["fc-list", ":", "family"], capture_output=True, text=True, timeout=30
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted({line.split(",")[0].strip() for line in out.splitlines() if line.strip()})
