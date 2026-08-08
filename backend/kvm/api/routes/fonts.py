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
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from kvm.api.store import default_root
from kvm.render.font_subset import subset_font

router = APIRouter(prefix="/api/fonts", tags=["fonts"])


def _cache_dir() -> Path:
    d = default_root().parent / "font-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


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


@lru_cache(maxsize=1)
def _scan_fonts() -> list[FontInfo]:
    """扫描系统字体，按 family 聚合。

    ASS 的 `Fontname` 用的是 family 名，字重由 Bold 标志控制——日文字体的字重
    普遍不叫 "Regular"（如 ヒラギノ丸ゴ ProN 是 "W4"、ヒラギノ明朝 ProN 是
    "W3"/"W6"），过滤 subfamily 只会把这些 family 整个判成"本机不可用"。
    所以这里**按 family 聚合、不按 subfamily 过滤**：同一 family 下的多个字重
    只返回一条记录，`weights` 记下观测到的全部字重，`path`/`index` 取其中最接近
    常规字重的一个作代表。

    结果先缓存在进程内（`lru_cache`），冷启动时再看磁盘缓存（按字体文件的
    mtime/大小签名校验）——打开每个字体文件读 name 表在几百个文件时并不便宜。
    """
    dirs = _FONT_DIRS_BY_OS.get(platform.system(), [])
    files = _candidate_font_files(dirs)
    signature = _scan_signature(files)

    cached = _load_disk_cache(signature)
    if cached is not None:
        return cached

    try:
        from fontTools.ttLib import TTCollection, TTFont
    except ImportError:
        return []

    # family -> [(usWeightClass, subfamily, path, index, is_cjk), ...]
    candidates: dict[str, list[tuple[int, str, str, int, bool]]] = {}

    for p in files:
        try:
            if p.suffix.lower() in (".ttc", ".otc"):
                coll = TTCollection(str(p))
                faces = list(enumerate(coll.fonts))
            else:
                faces = [(0, TTFont(str(p), fontNumber=0, lazy=True))]
        except Exception:
            # 损坏或加密的字体不应让整个列表打不开
            continue

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

    result = sorted(out.values(), key=lambda x: (not x.is_cjk, x.family))
    _save_disk_cache(signature, result)
    return result


@router.get("/", response_model=list[FontInfo])
def list_fonts(cjk_only: bool = Query(default=False)) -> list[FontInfo]:
    """列出系统可用字体。`cjk_only=true` 时只返回覆盖日文的。"""
    fonts = _scan_fonts()
    if cjk_only:
        fonts = [f for f in fonts if f.is_cjk]
    return fonts


@router.get("/subset")
def get_subset(family: str = Query(...)) -> FileResponse:
    """按族名产出可供 JASSUB 使用的子集字体。

    产出必须是 **OTF/TTF**：JASSUB 把字节直接喂给 libass，而 libass 不认 woff2 ——
    用 woff2 会表现为"加载成功但一个字都渲染不出来"且不报错。
    """
    match = next((f for f in _scan_fonts() if f.family == family), None)
    if match is None:
        raise HTTPException(status_code=404, detail=f"系统中找不到字体：{family}")

    src = Path(match.path)
    try:
        st = src.stat()
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"字体文件不可读：{src}") from exc

    # 缓存键带上 mtime 与大小，字体被系统更新后会自动重新生成
    key = hashlib.sha256(
        f"{match.family}|{match.index}|{st.st_mtime_ns}|{st.st_size}".encode()
    ).hexdigest()[:16]
    dest = _cache_dir() / f"{key}.otf"

    if not dest.exists():
        try:
            subset_font(src, dest, family_index=match.index, flavor=None)
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
    """本机实际选中的字体族。为 None 表示该档在本机不可用。"""

    candidates: list[str] = []


@router.get("/presets", response_model=list[PresetInfo])
def list_presets() -> list[PresetInfo]:
    """卡拉OK 常用字体档位（粗黑体 / 黑体 / 圆体 / 明朝）。

    每档给出本机实际能用的字体。某档一个候选都没命中时 `resolved=None`，
    界面应显示为不可用并说明原因——**绝不能悄悄换成别的字体**：
    用户选了明朝体却渲染出黑体，比"该档不可用"更糟。
    """
    from kvm.render.font_presets import resolve_presets

    families = [f.family for f in _scan_fonts()]
    return [PresetInfo(**item) for item in resolve_presets(families)]


class FontCoverage(BaseModel):
    family: str
    missing: list[str]
    total_checked: int


@router.post("/coverage", response_model=FontCoverage)
def check_coverage(family: str = Query(...), text: str = Query(...)) -> FontCoverage:
    """检查字体能否覆盖给定文本的全部字形。

    CLAUDE.md 要求**字体缺字必须在渲染前拦截** —— 预览与导出若因缺字
    fallback 到不同字体，WYSIWYG 就失效了，而这种问题通常到成片才暴露。
    """
    match = next((f for f in _scan_fonts() if f.family == family), None)
    if match is None:
        raise HTTPException(status_code=404, detail=f"系统中找不到字体：{family}")

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
