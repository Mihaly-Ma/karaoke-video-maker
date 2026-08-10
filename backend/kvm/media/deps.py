"""子进程 worker 的两件公共基础设施：JSON-lines 事件输出 + 依赖自动获取。

分离（`kvm.media.separate`）与引导声（`kvm.media.guide`）都是"父进程编排、
子进程算"的同一形态（CLAUDE.md §5.13），也都面对同一条依赖纪律（§2.6：
用户不该为了跑起这个工具去手动装任何东西）。这两段逻辑此前只存在于分离模块里，
第二个 worker 出现时若各写一份，两份必然漂移——尤其是"当前解释器不是虚拟环境
就放弃自动安装"这类安全判断，漂了就等于悄悄改了行为。

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
from typing import Any


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
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
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
        (module, spec)
        for module, spec in requirements
        if importlib.util.find_spec(module) is None
    ]
    if not missing:
        return

    names = "、".join(module for module, _ in missing)
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
