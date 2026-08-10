#!/usr/bin/env python3
"""从 `src-tauri/icons/source.png` 生成整套应用图标。

    python3 scripts/make_icons.py            # 清洗 + 派生副本 + 调 `npx tauri icon` 生成全套
    python3 scripts/make_icons.py --clean-only   # 只做清洗与派生副本，不调 node 工具链

## 为什么需要这一步，而不是直接把原图喂给 `tauri icon`

原图是设计稿，有两处**必须在打包前处理掉**的问题：

1. **右下角带「豆包AI生成」水印**。不去掉，它会出现在 Dock、任务栏、安装包
   和关于窗口里。
2. **原图没有 alpha 通道**（`8-bit/color RGB`）。图里那圈灰白格子是被压平的
   *假*透明背景，不是真透明。直接生成图标的话，圆角之外会露出一圈格子。

所以流程是：量出图标本体 → 裁掉本体之外的一切（水印随之消失）→ 按本体形状
生成真 alpha → 补边缘颜色 → 居中放进方形画布 → 交给 `tauri icon`。

## 蒙版为什么用"填洞"而不是画个圆角矩形

图标本体是**超椭圆（squircle）**而不是标准圆角矩形：实测顶端内缩 313px，
而按圆角半径反推应为 340px。拿 `ImageDraw.rounded_rectangle` 去套，半径取大了
会啃掉四角、取小了会在腰部留下一圈背景残渣——两头都不讨好。

改为：把"近黑外框"这一圈闭合环取出来，用 `binary_fill_holes` 填满内部，
得到的就是**本体的精确轮廓**，与设计稿的曲线一致，不需要猜任何参数。

## 边缘颜色外扩（不做会有白边）

alpha=0 的像素在缩放时仍会参与加权平均。原图本体之外是白色背景，
不处理的话缩到 128px 时四周会渗出一圈白色镶边。所以在设 alpha 之前，
先用最近邻把本体的颜色向外扩几十像素，让透明区域的 RGB 与边缘同色。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

REPO_ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = REPO_ROOT / "src-tauri" / "icons"
SOURCE = ICONS_DIR / "source.png"
CLEANED = ICONS_DIR / "source-cleaned.png"

# 本体在方形画布里占的比例。macOS 的图标模板本身留白约 10%，
# Windows 则习惯满幅；取 0.86 是两边都不难看的折中。
BODY_RATIO = 0.86
CANVAS = 1024

# 同一张图标要出现在应用图标集之外的三个地方，而它们的**交付机制互不相同**，
# 没法共用一份文件：README 走仓库相对路径（GitHub 上按路径取图）、前端走 Vite 的
# `public/`（构建时原样拷进 dist）、启动页走 Tauri 的 app 协议（`frontendDist` 指向
# `src-tauri/boot/`）。所以只能各放一份，但**生成器只有一个**——换图标时重跑本脚本
# 即可，不必记得手工同步三处。
#
# 尺寸按各自的显示尺寸给两倍余量即可，不必都用 1024：这几份是要进仓库和安装包的。
DERIVED = (
    (REPO_ROOT / "docs" / "images" / "logo.png", 256),
    (REPO_ROOT / "frontend" / "public" / "icon.png", 256),
    (REPO_ROOT / "src-tauri" / "boot" / "icon.png", 128),
)


def build_silhouette(rgb: np.ndarray) -> np.ndarray:
    """返回图标本体的布尔轮廓。"""
    lum = rgb.mean(axis=2)
    # 只认"实心近黑"的外框：阈值放宽会把浅色投影一起圈进来，
    # 填洞之后轮廓就会比本体胖一圈，缩放后边缘发灰。
    ring = lum < 120
    filled = ndimage.binary_fill_holes(ring)
    assert filled is not None
    # 只保留最大连通块：设计稿上可能有孤立的深色噪点（以及将来换图时的水印）
    labels, count = ndimage.label(filled)
    if count > 1:
        sizes = ndimage.sum(filled, labels, range(1, count + 1))
        filled = labels == (int(np.argmax(sizes)) + 1)
    return np.asarray(filled, dtype=bool)


def bleed_edges(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """把本体边缘的颜色向透明区域外扩，避免缩放时渗出白边。"""
    # distance_transform_edt 对"背景=0"的点给出最近的前景点索引，
    # 正好可以拿来做最近邻填充。
    _, (iy, ix) = ndimage.distance_transform_edt(~mask, return_indices=True)
    return rgb[iy, ix]


def clean(source: Path, out: Path) -> tuple[int, int, int]:
    img = Image.open(source).convert("RGB")
    rgb = np.asarray(img)

    mask = build_silhouette(rgb)
    ys, xs = np.nonzero(mask)
    left, right, top, bottom = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    body_w, body_h = right - left + 1, bottom - top + 1

    filled_rgb = bleed_edges(rgb, mask)
    rgba = np.dstack([filled_rgb, (mask * 255).astype(np.uint8)])
    body = Image.fromarray(rgba, "RGBA").crop((left, top, right + 1, bottom + 1))

    # 先按本体长边定画布，再等比缩到 CANVAS——一步到位缩放比"先缩再拼"少一次重采样
    side = round(max(body_w, body_h) / BODY_RATIO)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(body, ((side - body_w) // 2, (side - body_h) // 2))
    canvas.resize((CANVAS, CANVAS), Image.LANCZOS).save(out)
    return body_w, body_h, side


def write_derived(cleaned: Path) -> list[tuple[Path, int]]:
    """把清洗后的图标缩到各投放点需要的尺寸并写出。"""
    src = Image.open(cleaned)
    written: list[tuple[Path, int]] = []
    for dest, size in DERIVED:
        dest.parent.mkdir(parents=True, exist_ok=True)
        src.resize((size, size), Image.LANCZOS).save(dest)
        written.append((dest, size))
    return written


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="从设计稿生成整套应用图标")
    p.add_argument("--clean-only", action="store_true", help="只产出清洗后的 PNG")
    args = p.parse_args(argv)

    if not SOURCE.is_file():
        print(f"找不到设计稿：{SOURCE}", file=sys.stderr)
        return 1

    body_w, body_h, side = clean(SOURCE, CLEANED)
    print(f"本体 {body_w}×{body_h}，方形画布 {side}，已写出 {CLEANED.relative_to(REPO_ROOT)}")

    # 派生副本不依赖 `npx tauri icon`，所以放在提前返回之前：
    # 只想刷新 README/界面用图时不必装 node 工具链。
    for dest, size in write_derived(CLEANED):
        print(f"  派生 {dest.relative_to(REPO_ROOT)}  {size}×{size}")

    if args.clean_only:
        return 0

    # `tauri icon` 会顺带生成 android/ios 的图标目录，本项目不做移动端，跑完删掉
    cmd = ["npx", "tauri", "icon", str(CLEANED), "-o", str(ICONS_DIR)]
    print("$ " + " ".join(cmd))
    code = subprocess.call(cmd, cwd=str(REPO_ROOT))
    if code != 0:
        return code
    for extra in ("android", "ios"):
        target = ICONS_DIR / extra
        if target.is_dir():
            for child in sorted(target.rglob("*"), reverse=True):
                child.rmdir() if child.is_dir() else child.unlink()
            target.rmdir()
    print("图标已生成到 src-tauri/icons/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
