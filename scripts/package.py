#!/usr/bin/env python3
"""出安装包：前端构建 → PyInstaller 打后端 → Tauri 出壳。

    python3 scripts/package.py                # 全套
    python3 scripts/package.py --backend-only # 只打后端（调 PyInstaller 配置时用）
    python3 scripts/package.py --portable     # 出免安装 zip 而不是安装器（GPU 版必用）
    python3 scripts/package.py --lean         # 不打包 torch 等重依赖（见下）
    python3 scripts/package.py --skip-frontend

## 为什么是 `--onedir` 而不是 `--onefile`

`--onefile` 每次启动都要把整包解压到临时目录。本项目的依赖里有 PyTorch
（单 torch 就 500 MB），解压耗时以十秒计——**每次开应用都等一次**，
体验直接崩坏（CLAUDE.md §5.15）。`--onedir` 只在安装时解一次。

## 重依赖进不进包（`--lean`）

默认**进**。理由是一站式（§2.3）：装完就该能用，不该让用户再自己装 torch。
代价是安装包很大，而 Windows 的 NSIS/WiX 有 **2 GB 单安装包硬上限**
（`tauri-apps/tauri#7372`）——本脚本最后会把各部分体积打印出来，就是为了
让这条限制是可度量的而不是靠猜。

`--lean` 把 torch / audio-separator / librosa / numba / onnxruntime 排除在外，
产物小一个数量级。**但它目前不是可交付形态**：冻结后的解释器没有 pip，
`kvm.media.deps` 那套"缺依赖就自动装"在打包环境里走不通（`sys.executable`
是打好的可执行文件，`uv pip install --python` 认不了；`ensure_dependencies()`
在冻结形态下就直接这么说，不再走那条自动安装的路）。所以 `--lean` 只用来
量体积、做对照，不要拿它出正式包——除非先验证"往 `private_deps_dir` 装 wheel
再加进 sys.path"这条路可行。

## CUDA 版 torch 不进**安装包**（已定），但可以进免安装包

PyPI 的 Windows `torch` wheel 本来就是 CPU-only；CUDA 版单个 wheel 就 2.58 GB，
**装进 NSIS 安装包必然撞穿 2 GB 上限**。v0.2.0 那次 tag 就是这么红的：CI 的
windows-x64-cuda 变体把 torch 换成 CUDA 轮子之后仍然走默认出包路径，makensis 报
`error mmapping file (2064879402, 33554432) is out of range`——那个 offset 正是
1.92 GB，而这句话本身看不出与体积有关。**当时这条口径只写在本 docstring 里，
没有写进代码，于是拦不住 ci.yml 里的一条 matrix。**

所以：NSIS 安装包一律带 CPU 版；GPU 版走 `--portable`，不出安装器，把外壳 exe 与
onedir 直接写进一个 zip（zip64 无 2 GB 限制），用户解压即用。这也是同类项目
（ComfyUI 一族）的通行形态——带 CUDA 运行时的 Windows 产物基本没人做成安装包。
NSIS 侧确实有绕过 2 GB 的分支（nsisbi）与插件（CABSetup），但 Tauri 的打包器会
自己下载并校验它那份 NSIS，换编译器等于绕开整个 bundler，代价远大于收益；
换 WiX/MSI 也不是出路，tauri#7372 明确两者都失败。

**免安装形态的代价**：没有安装器就没人负责 WebView2 Runtime。Win11 与打过近年
更新的 Win10 自带，老机器上要用户自己装一次——这条写在包里的「使用说明.txt」。

## 分卷：同一堵墙的第二次

v0.2.1 出包全过，却红在**上传**：GitHub Release 的单个 asset 上限也是 2 GiB
（`HTTP 422: size must be less than 2147483648`），而免安装 zip 是 2.1 GB。
两个 2 GB 是巧合而非同源——一个是 makensis 的整数溢出，一个是 GitHub 的上传策略。

换更狠的压缩救不了这件事：solid LZMA2 实测比 0.53，换算下来约 1.9-2.0 GB，
过线但余量近乎为零，torch 下次一涨就是原地重演。**Release 的总大小与文件数不限**，
所以出路是分卷——`build_portable_zip()` 按写出的实际字节滚动切，每卷都是自成一体
的普通 zip（不是 `.7z.001` 那种分卷，用户不需要第三方工具）。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
DIST_BACKEND = REPO_ROOT / "dist-backend"
BUILD_BACKEND = REPO_ROOT / "build-backend"
DIST_PORTABLE = REPO_ROOT / "dist-portable"

# 免安装包里的顶层目录名与 exe 名，跟 tauri.conf.json 的 productName 保持一致——
# 用户看到的东西不该因为走了哪条打包路径而不同。
PRODUCT_NAME = "Karaoke Video Maker"

IS_WINDOWS = sys.platform.startswith("win")

# 整包收（子模块 + 数据 + 元数据）。共同点是**静态分析看不见它们真正加载了什么**。
#
# - uvicorn / kvm：大量运行时 import（协议实现、事件循环、logging 配置），
#   不 collect 会在启动时报 ModuleNotFoundError。
# - audio_separator：两条都踩了。架构类走
#   `importlib.import_module(f"audio_separator.separator.architectures.{name}")`
#   动态加载，静态分析一个都看不到；模型清单走
#   `resources.open_text("audio_separator", "models.json")`，而它落在 `load_model()`
#   的必经路径上（load_model → download_model_files → list_supported_model_files）。
#   少任何一样，人声分离在打包后的应用里**直接不可用**——而且是跑到那一步才炸。
COLLECT_ALL = ["uvicorn", "kvm", "audio_separator"]

# 只收数据文件的包：代码静态分析找得到，但数据文件按 `__file__` /
# `importlib.resources` 就地取。PyInstaller 只把 `.py` 收进 PYZ，这些数据默认一个
# 都不带，症状是**打包照样能出、装完跑到那一步才报文件不存在**。
#
# 判据是"运行时会不会去读它"，不是"包里有没有数据文件"：site-packages 里绝大多数
# 非 `.py` 文件是测试夹具、C 头文件、Cython 模板，进包纯属浪费体积。
#
# - torchcrepe：`load.py` 按 `os.path.dirname(__file__)/assets/{capacity}.pth` 找权重。
#   漏了它，引导声一生成就报权重缺失。`full.pth` 89 MB，`tiny.pth` 2 MB——tiny 是
#   `make_video.py --guide-crepe-model tiny` 给纯 CPU 机器留的退路，代价只有 2 MB，
#   一起带。
# - yt_dlp：`extractor/youtube/jsc/_builtin/vendor/*.js` 是 YouTube JS 挑战的求解脚本，
#   用 `importlib.resources` 读。缺了它 `load_script()` 返回 None、不抛异常，只是少
#   一条降级路径——但一共 14 KB，而 §5.1 早就写明 YouTube 这条链路会反复失效，
#   没有理由主动少带一条退路。
COLLECT_DATA = ["torchcrepe", "yt_dlp"]

# `--lean` 排除的模块。注意排除的是**顶层包名**，PyInstaller 会连带跳过其子模块。
HEAVY_MODULES = [
    "torch",
    "torchaudio",
    "torchcrepe",
    "audio_separator",
    "librosa",
    "numba",
    "llvmlite",
    "onnxruntime",
    "scipy",
    "matplotlib",
]

# 任何情况下都不该进包的东西：测试框架、打包器自己、开发工具。
ALWAYS_EXCLUDE = ["pytest", "ruff", "pyright", "PyInstaller", "tkinter", "IPython"]


def log(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def run(cmd: list[str], cwd: Path) -> None:
    print(f"    $ ({cwd.name}) {' '.join(cmd)}", flush=True)
    code = subprocess.call(cmd, cwd=str(cwd))
    if code != 0:
        raise SystemExit(f"命令失败（退出码 {code}）：{' '.join(cmd)}")


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def human(n: int) -> str:
    return f"{n / 1024 / 1024:.0f} MB" if n < 1 << 30 else f"{n / 1024 / 1024 / 1024:.2f} GB"


def build_frontend() -> None:
    log("构建前端")
    npm = "npm.cmd" if IS_WINDOWS else "npm"
    run([npm, "run", "build"], FRONTEND_DIR)
    index = FRONTEND_DIR / "dist" / "index.html"
    if not index.is_file():
        raise SystemExit(f"前端构建产物不存在：{index}")


def build_backend(lean: bool) -> Path:
    log("打包后端（PyInstaller --onedir）")
    dist_index = FRONTEND_DIR / "dist"
    if not (dist_index / "index.html").is_file():
        raise SystemExit("前端产物缺失——后端要把它作为界面下发，先跑 npm run build")

    # PyInstaller 的 --add-data 分隔符跟平台走：Windows 用 ;，其余用 :
    sep = ";" if IS_WINDOWS else ":"
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "kvm-backend",
        # 控制台版：后端的 stdout/stderr 要能被外壳收上来做诊断（§2.6：
        # 失败要说清楚）。窗口化版本在 Windows 上拿不到这两条流。
        "--console",
        "--distpath",
        str(DIST_BACKEND),
        "--workpath",
        str(BUILD_BACKEND),
        "--specpath",
        str(BUILD_BACKEND),
        "--paths",
        str(BACKEND_DIR),
        "--add-data",
        f"{dist_index}{sep}webui",
    ]
    # 许可证与第三方声明必须随安装包一起走：MIT 要求"副本及实质性部分"都带上声明，
    # 而安装包正是一份副本；jassub（MIT）与 Liberation Sans（OFL）同理。
    # 目标写 `.` 即 onedir 的 `_internal/` 根（`--add-data dist:webui` 落在
    # `_internal/webui` 可以互证）。缺文件直接失败——静默出一个没有许可证的包，
    # 要等别人来提 issue 才发现。
    for doc in ("LICENSE", "THIRD-PARTY-NOTICES.md"):
        src = REPO_ROOT / doc
        if not src.is_file():
            raise SystemExit(f"许可证文件缺失，安装包不能这样出：{src}")
        cmd += ["--add-data", f"{src}{sep}."]
    # `--lean` 排除掉的包不能再去 collect：既白白撑大产物，也让同一个包同时出现在
    # 「收进来」和「排除掉」两张单子上，PyInstaller 的取舍不必去猜。
    excluded = ALWAYS_EXCLUDE + (HEAVY_MODULES if lean else [])
    for mod in COLLECT_ALL:
        if mod not in excluded:
            cmd += ["--collect-all", mod]
    for mod in COLLECT_DATA:
        if mod not in excluded:
            cmd += ["--collect-data", mod]
    for mod in excluded:
        cmd += ["--exclude-module", mod]
    cmd.append(str(BACKEND_DIR / "kvm" / "server.py"))

    run(cmd, REPO_ROOT)
    out = DIST_BACKEND / "kvm-backend"
    exe = out / ("kvm-backend.exe" if IS_WINDOWS else "kvm-backend")
    if not exe.is_file():
        raise SystemExit(f"PyInstaller 没有产出可执行文件：{exe}")
    return out


def smoke_test_backend(bundle: Path) -> None:
    """打完就地跑一次：起得来、/api/health 通、界面首页发得出来。

    不做这一步的话，"安装包能出"与"装完能用"之间是空的——
    PyInstaller 漏收一个运行时 import，要等用户装完打开才暴露。
    """
    import socket
    import urllib.request

    log("冒烟测试打好的后端")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    exe = bundle / ("kvm-backend.exe" if IS_WINDOWS else "kvm-backend")
    proc = subprocess.Popen(
        [str(exe), "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        # 编码显式给：中文 Windows 的 locale 是 cp936，解不了后端日志里的非 GBK
        # 字节；冒烟测试因为一个字节而失败，会被误读成"打出来的包起不来"。
        encoding="utf-8",
        errors="replace",
    )
    try:
        deadline = time.monotonic() + 60
        last = ""
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise SystemExit(f"后端启动即退出（{proc.returncode}）：\n{out}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
                    if r.status == 200:
                        break
            except OSError as e:
                last = str(e)
            time.sleep(0.3)
        else:
            raise SystemExit(f"后端 60 秒内没有响应：{last}")

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as r:
            body = r.read(512)
            coep = r.headers.get("Cross-Origin-Embedder-Policy")
        if b"<html" not in body.lower() and b"<!doctype" not in body.lower():
            raise SystemExit("首页不是 HTML——前端产物没有被正确打进包里")
        if coep != "require-corp":
            # 缺这个头 = 页面拿不到跨源隔离 = JASSUB 起不来 = 没有字幕预览。
            # 这在成品上是灾难性的，必须在打包阶段就拦住。
            raise SystemExit(f"首页缺少跨源隔离响应头（COEP={coep!r}）")
        log("冒烟测试通过：健康检查、界面下发、跨源隔离头都正常")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def smoke_test_workers(bundle: Path) -> None:
    """打完就地验一次：worker 子进程在**冻结形态下**真的拉得起来。

    这一条是被一个发布阻断项换来的：`sys.executable -m kvm.media.guide` 在源码
    环境里天天在跑，打包后却必然失败——`sys.executable` 变成 `kvm-backend`，
    PyInstaller 的引导器不认 `-m`，参数掉进服务端的 argparse，子进程以
    "the following arguments are required: --port" 秒退。**人声分离与引导声
    在装好的应用里全都跑不起来，而所有单元测试与源码运行一切正常。**

    所以判据必须是"参数到没到 worker 自己的 parser 手里"，而不是"进程起没起来"：
    断言 stderr 里出现的是 worker 的必填参数（`--vocals` / `--audio`），
    且**不出现 `--port`**——后者一旦出现就说明又掉回服务端 parser 了。

    顺带守住 stdout：它是 JSON-lines 进度协议的通道（§5.13），分发层往里写一个字
    都会让父进程的解析出问题，所以这里要求它必须是空的。
    """
    log("冒烟测试 worker 子进程分发（冻结形态下 `-m` 不可用）")
    exe = bundle / ("kvm-backend.exe" if IS_WINDOWS else "kvm-backend")
    checks = [
        ("kvm.media.guide", "--vocals"),
        ("kvm.media.separate", "--audio"),
    ]
    for module, required_arg in checks:
        proc = subprocess.run(
            [str(exe), "--worker-module", module, "--worker"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
        if required_arg not in proc.stderr:
            raise SystemExit(
                f"worker 分发没有把参数交给 {module}：\n"
                f"  stdout={proc.stdout!r}\n  stderr={proc.stderr!r}"
            )
        if "--port" in proc.stderr:
            raise SystemExit(f"{module} 的参数又掉回服务端 parser 了：\n{proc.stderr}")
        if proc.stdout.strip():
            raise SystemExit(f"{module} 分发路径污染了 stdout（JSON-lines 通道）：{proc.stdout!r}")
        print(f"    {module:<22} 参数已抵达 worker（{required_arg}）", flush=True)

    bogus = subprocess.run(
        [str(exe), "--worker-module", "kvm.does.not.exist"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    if bogus.returncode == 0:
        raise SystemExit("未登记的 worker 模块居然成功退出了，分发层的白名单没生效")
    log("worker 分发冒烟测试通过")


def build_shell(portable: bool = False) -> None:
    log("构建 Tauri 外壳" + ("（免安装形态，不出安装器）" if portable else ""))
    npx = "npx.cmd" if IS_WINDOWS else "npx"
    cmd = [npx, "tauri", "build", "--config", "src-tauri/tauri.bundle.conf.json"]
    if portable:
        # NSIS 是**唯一**受 2 GB 限制的环节，绕开它这条路才成立。
        # 代价是资源不再由打包器摊到 exe 旁边，改由 build_portable_zip() 自己摆。
        cmd.append("--no-bundle")
    run(cmd, REPO_ROOT)


# 免安装包里的说明。写在包**里面**而不是只写在 release notes 里：
# 用户下完 zip 解压之后手边只有这个文件夹，那时候他不会回去翻网页。
_PORTABLE_README = """Karaoke Video Maker（GPU 版 · 免安装）

用法
  把整个「Karaoke Video Maker」文件夹解压到任意位置，双击
  「Karaoke Video Maker.exe」。不需要管理员权限，不写注册表，
  删掉文件夹就等于卸载。

  别直接在压缩软件的预览窗口里双击运行——那只是把 exe 单独解压到临时
  目录，后端在它旁边找不到自己的文件，应用会停在启动页上。

如果下载到的是「1of2 / 2of2」这样的多个 zip
  **每一个都要下，并且解压到同一个位置**，让它们合并成同一个
  「Karaoke Video Maker」文件夹（资源管理器会问要不要合并，选是）。
  它们是普通 zip，不是分卷压缩包，不需要 7-Zip 之类的工具，但少解压一个
  就会缺文件——最典型的症状是应用停在启动页、日志里报某个 .dll 找不到。

  之所以拆开，是 GitHub 的单个发布文件不能超过 2 GiB，而 CUDA 版
  PyTorch 的运行时本身就比这个大。

需要 WebView2 Runtime
  这是免安装形态唯一的额外要求：没有安装器，就没人替你装它。
  Windows 11、以及打过近年更新的 Windows 10 都自带，通常无需理会。
  如果双击之后**窗口根本开不出来**，装一次即可：
  https://developer.microsoft.com/microsoft-edge/webview2/

  症状区分：停在加载页说明窗口已经开出来了、是后端没起来，那是另一回事，
  界面上会直接给出原因。

为什么 GPU 版没有安装包
  CUDA 版 PyTorch 光运行时就 2.5 GB 以上，而 Windows 安装器（NSIS / WiX）
  有 2 GB 硬上限，做不出来。需要安装包请用 CPU 版。
"""


# GitHub Release **单个 asset** 的上限：2 GiB。超了 uploads.github.com 直接回
# `HTTP 422: size must be less than 2147483648`，而这一步发生在整条链路的最后
# 一秒——包已经出完、Rust 也编译完了。**Release 总大小与 asset 数量都不限**，
# 官方明确支持一个 release 挂多个文件，所以出路是分卷而不是压得更狠。
#
# 这个数字和 NSIS 那个 2 GB 上限是巧合，不是同一件事：一个是 makensis 的有符号
# 整数溢出，一个是 GitHub 的上传策略。**别把两个常量合并成一个**——它们各自会变，
# 合了之后哪天动一个就会静默改掉另一个的判据。
_RELEASE_ASSET_LIMIT = 2 * 1024**3

# 每卷的目标大小。取 1.5 GB 而不是贴着 1.9 GB：余量要肉眼可见（本项目已经因为
# "只剩 375 MB"被咬过一次）。多一卷的代价只是用户多点一次下载，而贴边的代价是
# 某次 torch 升版之后整条发布链路在最后一秒红掉。
_PORTABLE_PART_TARGET = 1500 * 1024**2


def build_portable_zip(bundle: Path) -> list[Path]:
    """把外壳 exe 与后端 onedir 直接写进 zip；超过每卷目标就换下一卷。

    **不先摊一份目录再压**：GPU 版 onedir 就 3 GB 上下，runner 上 CUDA venv
    （约 3.5 GB）+ onedir + Rust target 已经十几 GB，多一份完整拷贝很可能把盘
    撑爆——而磁盘满的报错通常出现在某个无关的步骤里（ci.yml 里那步「磁盘余量」
    就是为这个加的）。zipfile 逐条写入，峰值只多出一卷的大小。

    ## 为什么是"多个独立 zip"而不是分卷压缩包

    每一卷都是**自成一体的普通 zip**，资源管理器双击就能开；用户把几卷都解压到
    同一个位置、合并成同一个文件夹即可。7z/zip 的分卷（`.7z.001`）压缩率更高，
    但要第三方工具才合得起来——而这是个免安装形态，它存在的理由就是少一道安装
    门槛，再加一道解压门槛等于白做。

    ## 为什么按**实际写出的字节**切，而不是按内容规则切

    "把 `_internal/torch/lib` 单独拿出来"这类规则今天成立，明天 torch 换个目录
    就悄悄失效，而失效的表现是某一卷又超限——正是这次故障的重演。按输出大小滚动
    切分不依赖任何上游布局：torch 再涨，只是多出一卷。

    代价是单个文件不能跨卷，所以有兜底：任何单文件本身超上限就直接失败。当前最大
    的 DLL 在 1 GB 量级，离得还远，但这条判据要写出来，不能靠"应该不会"。

    目录布局必须与 NSIS 装出来的一致，否则壳找不到后端：`lib.rs` 的
    `bundled_backend()` 解析的是 `resource_dir()/backend/kvm-backend.exe`，
    而 Windows 上 `resource_dir()` 就是 exe 所在目录。注意 `backend/` 下放的是
    onedir 的**内容**而不是那个目录本身——多套一层的症状是应用静悄悄停在启动页
    上，`lib.rs` 里已经为同一个坑写过一次注释了，别在这边再踩一遍。

    `ZipFile.write()` 内部走 `ZipInfo.from_file()`，权限位随之保留；Windows 上
    无所谓，但在 macOS 本地跑 `--portable` 做布局验证时 exe 位不会丢。
    """
    exe_name = "kvm-shell.exe" if IS_WINDOWS else "kvm-shell"
    shell_exe = REPO_ROOT / "src-tauri" / "target" / "release" / exe_name
    if not shell_exe.is_file():
        raise SystemExit(f"外壳可执行文件不存在（--no-bundle 也该产出它）：{shell_exe}")
    for doc in ("LICENSE", "THIRD-PARTY-NOTICES.md"):
        if not (REPO_ROOT / doc).is_file():
            raise SystemExit(f"许可证文件缺失，免安装包不能这样出：{REPO_ROOT / doc}")

    DIST_PORTABLE.mkdir(parents=True, exist_ok=True)
    for stale in DIST_PORTABLE.glob("*.zip"):
        # 上次可能分了更多卷，残留的旧卷会被 CI 的收拢步骤一并捡走，
        # 于是发布里混进一个属于上个版本的分卷——比缺一卷更难查。
        stale.unlink()

    log(
        f"写免安装 zip（zip64，每卷约 {human(_PORTABLE_PART_TARGET)}；"
        f"onedir {human(dir_size(bundle))}，要压几分钟）"
    )

    parts: list[Path] = []
    zf: zipfile.ZipFile | None = None
    written = 0

    def rotate() -> None:
        """开新一卷。说明文件每卷都放一份——只解压到第二卷的人也得看得到怎么用。"""
        nonlocal zf, written
        if zf is not None:
            zf.close()
        path = DIST_PORTABLE / f"portable-part{len(parts) + 1}.zip"
        parts.append(path)
        zf = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, allowZip64=True)
        zf.writestr(f"{PRODUCT_NAME}/使用说明.txt", _PORTABLE_README)
        written = 0

    def put(src: Path, arc: str) -> None:
        nonlocal written
        if src.stat().st_size >= _RELEASE_ASSET_LIMIT:
            raise SystemExit(
                f"单个文件就超过 {human(_RELEASE_ASSET_LIMIT)}，分卷救不了：{src}\n"
                "    分卷是按文件切的，一个文件不能跨卷。"
            )
        if written >= _PORTABLE_PART_TARGET:
            rotate()
        assert zf is not None
        zf.write(src, arc)
        written += zf.infolist()[-1].compress_size

    rotate()
    # 外壳与许可证放第一卷开头：第一卷是用户最可能先解压的那个。
    # 许可证跟安装包那份走同一条规矩——免安装包也是一份副本，MIT 要求带声明。
    put(shell_exe, f"{PRODUCT_NAME}/{PRODUCT_NAME}{shell_exe.suffix}")
    for doc in ("LICENSE", "THIRD-PARTY-NOTICES.md"):
        put(REPO_ROOT / doc, f"{PRODUCT_NAME}/{doc}")
    for src in sorted(bundle.rglob("*")):
        if src.is_file():
            put(src, f"{PRODUCT_NAME}/backend/{src.relative_to(bundle).as_posix()}")
    if zf is not None:
        zf.close()

    # 定稿名字：单卷不带序号，多卷带 `-1of2`。总数要等切完才知道，所以先写
    # partN 再改名——同目录 rename，不产生额外拷贝。
    total = len(parts)
    final: list[Path] = []
    for i, path in enumerate(parts, start=1):
        target = path.with_name("portable.zip" if total == 1 else f"portable-{i}of{total}.zip")
        target.unlink(missing_ok=True)
        path.rename(target)
        final.append(target)

    for path in final:
        size = path.stat().st_size
        if size >= _RELEASE_ASSET_LIMIT:
            # 正常不该越界（切分按压缩后字节滚动算）；留这道闸门是因为越界的后果
            # 要到整条链路的最后一秒才以 HTTP 422 的形式出现。
            raise SystemExit(
                f"[失败] {path.name} 有 {human(size)}，超过 GitHub Release 单文件上限"
                f" {human(_RELEASE_ASSET_LIMIT)}。把 _PORTABLE_PART_TARGET 调小再出一次。"
            )
    return final


# NSIS 与 WiX 都在**安装包超过 2 GB** 时失败（tauri-apps/tauri#7372，至今 open），
# 报的是 `error mmapping file is out of range` —— 一句看不出与体积有关的话。
_INSTALLER_HARD_LIMIT = 2 * 1024**3
# 到 85% 就开始喊。GPU 版实测压完 1.63 GB（solid LZMA2），离上限只剩 375 MB，
# torch 升一次版就可能吃掉——余量必须是**可见**的，而不是等某天打包突然红了。
_INSTALLER_WARN_AT = int(_INSTALLER_HARD_LIMIT * 0.85)

# onedir → 安装包的压缩比，实测得来：GPU 版 onedir 3.1 GB 压出 1.63 GB
# （solid LZMA2），约 0.53。这里取 0.55 往悲观一侧靠——预检的作用是**在花掉
# 那十几分钟之前**就把话说清楚，宁可偶尔多拦一次让人用 `--force-installer`
# 覆盖，也好过跑完 Rust 编译再收一句看不出与体积有关的 mmap 报错。
_ONEDIR_COMPRESSION_RATIO = 0.55


def preflight_installer_limit(bundle: Path, force: bool) -> None:
    """出壳**之前**按 onedir 体积估一次安装包大小。

    `_check_installer_limit()` 是事后核对，而它跑在 `build_shell()` 之后——
    NSIS 撞穿上限时是自己先炸的，事后闸门永远等不到开口的机会。v0.2.0 那次
    正是如此：本该被这道闸门以一句人话拦住的事，最后以一句
    `error mmapping file is out of range` 出现，中间还白烧了七分钟 Rust 编译。
    **判据要放在花钱之前，这是这道函数存在的全部理由——别再把它挪回下游。**

    估算必然不准，所以留了 `--force-installer` 让人能覆盖；但**默认拦住**：
    拦错了只浪费一次重跑，放过了浪费的是整条发布链路。
    """
    size = dir_size(bundle)
    est = int(size * _ONEDIR_COMPRESSION_RATIO)
    log(f"预检：onedir {human(size)}，估算安装包约 {human(est)}（硬上限 2 GB）")
    if est <= _INSTALLER_WARN_AT:
        return
    msg = (
        f"onedir 有 {human(size)}，估算压出来约 {human(est)}，"
        "已进入 NSIS/WiX 2 GB 硬上限的危险区。\n"
        "    最可能的原因是装了 CUDA 版 torch（单个 wheel 就 2.58 GB）。\n"
        "    GPU 版请改用 `--portable` 出免安装 zip，它不受这条限制；\n"
        "    确认要继续出安装器的话加 `--force-installer`。"
    )
    if est > _INSTALLER_HARD_LIMIT and not force:
        raise SystemExit(f"[失败] {msg}")
    log(f"⚠ {msg}")


def _check_installer_limit(items: list[tuple[str, int]]) -> None:
    """Windows 安装包体积的硬闸门。

    只管 `.exe`/`.msi`：dmg 没有这个限制。超限直接失败而不是打印一句提醒——
    这个数字一旦越界，产物就是坏的，让它悄悄过去只会把问题推到用户机器上。
    """
    for name, size in items:
        if not name.endswith((".exe", ".msi")):
            continue
        if size > _INSTALLER_HARD_LIMIT:
            over = (size - _INSTALLER_HARD_LIMIT) / 1024**2
            msg = (
                f"{name} 有 {human(size)}，超过 NSIS/WiX 的 2 GB 硬上限 {over:.0f} MB。\n"
                "    这不是能忽略的警告：Tauri 的打包器会以一句与体积无关的\n"
                "    `error mmapping file is out of range` 失败（tauri#7372）。\n"
                "    要么减体积（CUDA 版 torch 的 DLL 是大头），要么换成不受此限的安装器。"
            )
            raise SystemExit(f"[失败] {msg}")
        if size > _INSTALLER_WARN_AT:
            left = (_INSTALLER_HARD_LIMIT - size) / 1024**2
            log(f"⚠ {name} 距 2 GB 上限只剩 {left:.0f} MB，再加东西就要撞穿了")


def report() -> None:
    log("产物体积")
    if DIST_BACKEND.is_dir():
        print(f"    后端 onedir      {human(dir_size(DIST_BACKEND))}")
    bundle_root = REPO_ROOT / "src-tauri" / "target" / "release" / "bundle"
    installers: list[tuple[str, int]] = []
    if bundle_root.is_dir():
        for item in sorted(bundle_root.rglob("*")):
            if item.suffix in {".dmg", ".exe", ".msi", ".AppImage", ".deb"} and item.is_file():
                size = item.stat().st_size
                print(f"    {item.name:<40} {human(size)}")
                installers.append((item.name, size))
            elif item.suffix == ".app" and item.is_dir():
                print(f"    {item.name:<40} {human(dir_size(item))}")
    _check_installer_limit(installers)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python3 scripts/package.py", description="出安装包")
    p.add_argument("--backend-only", action="store_true")
    p.add_argument("--skip-frontend", action="store_true")
    p.add_argument("--skip-smoke", action="store_true", help="跳过打包后的冒烟测试")
    p.add_argument("--lean", action="store_true", help="排除 torch 等重依赖（只用于量体积）")
    p.add_argument(
        "--portable",
        action="store_true",
        help="出免安装 zip 而不是安装器（GPU 版必用，见模块 docstring）",
    )
    p.add_argument(
        "--force-installer",
        action="store_true",
        help="体积预检不乐观时仍然出安装器",
    )
    args = p.parse_args(argv)

    if args.portable and args.force_installer:
        raise SystemExit("--portable 与 --force-installer 是两条路，不要同时给")

    if shutil.which("npm") is None:
        raise SystemExit("找不到 npm，前端与外壳都构建不了")

    started = time.monotonic()
    if not args.skip_frontend:
        build_frontend()
    bundle = build_backend(args.lean)
    if not args.skip_smoke:
        smoke_test_backend(bundle)
        smoke_test_workers(bundle)
    if not args.backend_only:
        if args.portable:
            build_shell(portable=True)
            for archive in build_portable_zip(bundle):
                log(f"免安装包 {archive.name}  {human(archive.stat().st_size)}")
        else:
            # 这一步必须在 build_shell() **之前**：NSIS 撞穿 2 GB 时自己先炸，
            # report() 里那道事后闸门根本轮不到执行（见 preflight 的注释）。
            preflight_installer_limit(bundle, args.force_installer)
            build_shell()
    report()
    log(f"完成，用时 {time.monotonic() - started:.0f}s")
    if args.lean:
        log("注意：--lean 产物缺少分离/引导声/对齐所需的依赖，不是可交付形态")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    raise SystemExit(main())
