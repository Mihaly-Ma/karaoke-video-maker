"""worker 子进程的公共契约：怎么把它拉起来、它起来之后怎么说话、缺依赖怎么办。

分离（`kvm.media.separate`）与引导声（`kvm.media.guide`）都是"父进程编排、
子进程算"的同一形态（CLAUDE.md §5.13），也都面对同一条依赖纪律（§2.6：
用户不该为了跑起这个工具去手动装任何东西）。这些逻辑此前只存在于分离模块里，
第二个 worker 出现时若各写一份，两份必然漂移——尤其是"当前解释器不是虚拟环境
就放弃自动安装"这类安全判断，漂了就等于悄悄改了行为。本仓已经吃过多次
"同一规则两份实现漂移"的亏，所以三件事都收在这里：

| 谁用 | 是什么 |
|---|---|
| 父进程 | `worker_command()` / `worker_cwd()`——**怎么拉起 worker**（形态随冻结与否而变） |
| 冻结形态的入口 | `run_worker_module()`——`kvm.server` 把 worker 调用转交给目标模块 |
| 子进程 | `emit()`（JSON-lines 进度协议）+ `ensure_dependencies()`（依赖自动获取） |

**本模块被子进程加载**，因此只依赖标准库：worker 的 sys.path 只保证找得到
`kvm` 包，而依赖能不能 import 恰恰是它要回答的问题。
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 拉起 worker（父进程侧）
# ---------------------------------------------------------------------------

WORKER_FLAG = "--worker-module"
"""冻结形态下的 worker 分发首参。

取一个**服务端 argparse 里不存在的**长选项名是刻意的：这样"没走分发层"的调用
不会被误当成正常参数吃掉，而是当场报错。
"""

WORKER_MODULES: tuple[str, ...] = ("kvm.media.separate", "kvm.media.guide")
"""允许被分发的 worker 模块白名单。**新增 worker 必须登记在这里**。

写成白名单而不是"什么模块都能跑"，一是给错拼的模块名一个说得清的错误，
二是让"本仓一共有哪几个 worker"有一处可查的答案。
"""


def worker_command(module: str, args: list[str]) -> list[str]:
    """构造拉起 worker 子进程的命令行。

    ## 冻结形态下 `sys.executable -m <模块>` 不可用（实测，v0.1.0 发布前的阻断项）

    这是那种**开发时永远碰不到、装完才炸**的坑，务必别改回去：
    PyInstaller 打出来的 `sys.executable` 是 `kvm-backend` 自己，它的引导器
    **不认 `-m`**——`-m kvm.media.guide --worker …` 会被原样交给
    `kvm.server` 的 argparse，子进程于是以
    `error: the following arguments are required: --port` 秒退。
    症状是人声分离与引导声在**装好的应用里全都跑不起来**，而源码运行一切正常。

    所以冻结时改走本模块的分发协议（`kvm-backend --worker-module <模块> …`，
    由 `run_worker_module()` 在 `kvm.server` 的入口处接住）；非冻结时维持原样，
    那条路径已经被大量使用与测试覆盖，没有理由跟着改。
    """
    if module not in WORKER_MODULES:
        msg = f"未登记的 worker 模块：{module}。可用：{'、'.join(WORKER_MODULES)}"
        raise ValueError(msg)
    if getattr(sys, "frozen", False):
        return [sys.executable, WORKER_FLAG, module, *args]
    return [sys.executable, "-m", module, *args]


def worker_cwd() -> str:
    """worker 子进程的工作目录。

    两种形态下这个目录承担的职责完全不同，所以不能只写一份路径计算：

    - **源码运行**：必须是 `backend/`。`python -m kvm.media.X` 靠 cwd 进 sys.path
      才找得到 `kvm` 包——不依赖调用方有没有设 `PYTHONPATH`。
    - **冻结形态**：`backend/` 根本不存在，而 `kvm` 在 PYZ 里，import 不需要任何
      路径帮助，cwd 于是与"能不能 import"彻底脱钩。此时改指**应用数据根**：
      它由 `kvm.paths` 单点定义（§2.6）、必定可写、位置稳定。
      **不要退回"继承父进程 cwd"或"用 `sys._MEIPASS`"**：前者在打好的应用里是
      外壳给什么就是什么（可能是 `/`），后者在 `/Applications` 下是只读的——
      一旦某个第三方库往 cwd 落个临时文件，就会以一条与本功能毫无关系的
      权限错误炸掉，而这类故障只在装好的应用里出现。
    """
    if getattr(sys, "frozen", False):
        from kvm import paths

        root = paths.app_data_root()
        root.mkdir(parents=True, exist_ok=True)
        return str(root)
    # backend/ = kvm 包的父目录
    return str(Path(__file__).resolve().parent.parent.parent)


def run_worker_module(argv: list[str]) -> int | None:
    """冻结形态的 worker 分发：把 `--worker-module <模块> …` 转交给目标模块。

    返回退出码；`argv` 不是 worker 调用时返回 `None`，调用方照常走服务端逻辑。

    行为等价于 `python -m <模块> <其余参数>`：把 `sys.argv` 重写成目标模块自己
    看到的样子，再调它的 `main()`。这样两条路径（源码 `-m` / 冻结分发）共用
    同一个模块入口，worker 那边不需要为"被谁拉起来"分情况。

    **绝不能往 stdout 写任何东西**（连一行启动日志都不行）：stdout 是 JSON-lines
    进度协议的通道，父进程 `kvm.jobs.run_cancelable` 按行解析，混进非 JSON 内容
    轻则被丢弃、重则把错误信息淹掉。诊断一律走 stderr。
    """
    if not argv or argv[0] != WORKER_FLAG:
        return None

    available = "、".join(WORKER_MODULES)
    if len(argv) < 2:
        print(f"{WORKER_FLAG} 需要一个模块名。可用：{available}", file=sys.stderr)
        return 2
    module = argv[1]
    if module not in WORKER_MODULES:
        print(f"未登记的 worker 模块：{module}。可用：{available}", file=sys.stderr)
        return 2

    mod = importlib.import_module(module)
    entry = getattr(mod, "main", None)
    if not callable(entry):
        # 只可能在有人改坏了 worker 模块时发生，但静默返回 0 会让父进程
        # 报"子进程正常退出却没有产物"，把问题指向错误的方向。
        print(f"worker 模块 {module} 没有可调用的 main()", file=sys.stderr)
        return 2
    sys.argv = [module, *argv[2:]]
    return int(entry())


# ---------------------------------------------------------------------------
# 子进程侧：进度协议与依赖获取
# ---------------------------------------------------------------------------


def emit(event: dict[str, Any]) -> None:
    """往 stdout 打一行 JSON 事件（父进程按行解析，见 `kvm.jobs.run_cancelable`）。

    第三方库的 logging 必须转到 stderr，否则会混进这条协议里——各 worker 自己
    在启动时 `logging.basicConfig(stream=sys.stderr, ...)`。
    """
    print(json.dumps(event, ensure_ascii=False), flush=True)


_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def installer_command(specs: list[str], hint: str) -> list[str]:
    """挑一个可用的安装器。

    优先 `uv`：本项目本来就用它管依赖，而且 uv 建的虚拟环境默认不带 pip，
    直接 `python -m pip` 多半是找不到的。两个都没有就抛错让用户手工装，
    不去猜别的安装方式。
    """
    uv_bin = shutil.which("uv")
    if uv_bin:
        return [uv_bin, "pip", "install", "--python", sys.executable, *specs]
    if importlib.util.find_spec("pip") is not None:
        return [sys.executable, "-m", "pip", "install", *specs]
    msg = f"缺少依赖，且环境里既没有 uv 也没有 pip，无法自动安装。{hint}"
    raise RuntimeError(msg)


def run_installer(specs: list[str], hint: str, *, progress: float = 0.04) -> None:
    """跑安装命令，把它的输出逐行转成进度事件（几百 MB 的下载必须有反馈）。

    输出要先剥掉 ANSI 转义序列：uv 即便输出被重定向到管道也照样上色，
    原样透传到前端就是一串 `\\u001b[2m` 乱码。
    """
    cmd = installer_command(specs, hint)
    # 命令由 `installer_command` 的白名单分支构造，不含用户输入
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        # 编码显式给：uv 的输出不是 GBK，中文 Windows 上读取线程会解码失败。
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    tail: list[str] = []
    if proc.stdout is not None:
        with proc.stdout as stream:
            for raw in stream:
                line = _ANSI_ESCAPE_RE.sub("", raw).strip()
                if not line:
                    continue
                tail.append(line)
                del tail[:-20]  # 只留尾部若干行用于报错，不无限增长
                emit({"event": "progress", "progress": progress, "message": f"安装依赖：{line}"})
    code = proc.wait()
    if code != 0:
        detail = " / ".join(tail[-5:]) or "安装器没有输出可用信息"
        msg = f"自动安装依赖失败（退出码 {code}）：{detail}。{hint}"
        raise RuntimeError(msg)


def ensure_dependencies(
    requirements: tuple[tuple[str, str], ...],
    hint: str,
    *,
    on_missing: Callable[[str], None] | None = None,
) -> None:
    """确保 `requirements`（`(import 名, pip 需求串)` 列表）可用，缺失就自动装。

    装到 `sys.executable` 所在的虚拟环境里——那就是应用私有目录，不需要 sudo，
    也不会污染用户的系统 Python。当前解释器**不是**虚拟环境时直接放弃自动安装：
    宁可给一条明确的手工命令，也不去改别人的系统环境（CLAUDE.md §2.6 的"安装"一段）。
    任何失败都抛 `RuntimeError`，由调用方转成一行 JSON 错误事件，绝不静默失败。
    """
    missing = [
        (module, spec) for module, spec in requirements if importlib.util.find_spec(module) is None
    ]
    if not missing:
        return

    names = "、".join(module for module, _ in missing)
    if getattr(sys, "frozen", False):
        # 冻结形态下**没有任何自动安装的路子**，必须先于下面那条虚拟环境判断说清楚：
        # PyInstaller 把 `sys.prefix` 与 `sys.base_prefix` 都指到 `_MEIPASS`，
        # 于是下面那条会命中并报"当前 Python 不是虚拟环境"——那句话在装好的应用里
        # 完全是误导（用户根本没有"环境"可言）。真实原因是 `sys.executable` 是
        # 打好的可执行文件而不是解释器：`uv pip install --python <它>` 认不了，
        # 冻结解释器里也没有 pip（CLAUDE.md §5.15 的 `--lean` 一段记的就是这条）。
        msg = (
            f"缺少依赖（{names}）。这是打包后的应用，依赖必须在打包时就进包，"
            f"运行时无法自动安装（sys.executable 是应用本体而非 Python 解释器）。"
            f"请用带完整依赖的安装包，或在源码环境里运行。{hint}"
        )
        raise RuntimeError(msg)
    if sys.prefix == sys.base_prefix:
        msg = (
            f"缺少依赖（{names}），而当前 Python 不是虚拟环境，"
            f"自动安装会污染系统环境，已放弃。{hint}"
        )
        raise RuntimeError(msg)

    if on_missing is not None:
        on_missing(names)
    run_installer([spec for _, spec in missing], hint)

    importlib.invalidate_caches()  # 新装的包要让 import 系统重新扫一遍路径才可见
    still_missing = [m for m, _ in missing if importlib.util.find_spec(m) is None]
    if still_missing:
        msg = f"自动安装已执行完毕，但依然找不到 {'、'.join(still_missing)}。{hint}"
        raise RuntimeError(msg)
