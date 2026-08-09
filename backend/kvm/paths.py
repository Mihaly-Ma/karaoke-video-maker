"""应用私有目录的唯一真相来源（CLAUDE.md §2.6「安装」一段）。

§2.6 规定：自动获取来的东西**一律装进应用私有目录**，绝不污染用户系统、
绝不要求 sudo，卸载即删目录。既然是"一个目录"，它的位置就只能有一处定义。

此前这套路径散在三个模块里各算各的（`kvm.api.store.default_root`、
`kvm.media.download.app_data_root`、`kvm.media.providers.default_private_deps_dir`），
`KVM_DATA_DIR` 的语义要靠读三处代码才拼得出来。本模块把它们收成一处，
那三个函数改为薄委托——本仓已经吃过"同一规则两份实现漂移"的亏，
不要再让目录规则重蹈覆辙。

**本模块必须保持 stdlib-only。** `kvm.doctor` 在依赖尚未安装完的环境里也要能
跑（自检的意义正在于此），它 import 本模块；一旦这里引入 pydantic 之类的
第三方依赖，"依赖没装好"就会变成"自检自己起不来"，最需要它的时候正好没有。
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_DATA_DIR = "KVM_DATA_DIR"
"""覆盖**工程目录**的环境变量。

历史语义：它指向的是 `projects/` 本身，而不是应用数据根——应用数据根取它的
父目录。测试靠这个语义把工程与媒体一起隔离进 tmp_path，改动会破坏它们。
"""


def projects_dir() -> Path:
    """工程 JSON 的存放目录。

    放在用户数据目录而非仓库内——工程是用户资产，不该随代码走。
    """
    env = os.environ.get(ENV_DATA_DIR)
    if env:
        return Path(env)
    return Path.home() / ".karaoke-video-maker" / "projects"


def app_data_root() -> Path:
    """应用数据根目录：工程、媒体、模型权重、自动获取的依赖都在它下面。"""
    return projects_dir().parent


def private_deps_dir() -> Path:
    """自动获取的 Python 依赖装在哪（yt-dlp 的私有升级路径用它）。

    实验脚本原本落在仓库内的 `.kvm/`，那个位置在打好包的应用里根本不存在。
    """
    return app_data_root() / "deps"


def private_bin_dir() -> Path:
    """自动获取的**外部可执行文件**装在哪（ffmpeg 静态构建等）。

    §2.6 的解析顺序把这里排在第一位：应用自己取来的那份是版本已知的
    （§5.12 要求两端 libass 同源），比系统上碰巧存在的那个可信。

    目前"获取"阶段尚未实现（不自动下载并执行外部二进制），所以这个目录
    通常是空的；解析层照样先看它，将来补上下载就不必再改解析顺序。
    """
    return app_data_root() / "bin"


def font_cache_dir() -> Path:
    """预览字体子集产物的缓存目录。

    产物是**可再生的派生物**：删掉只是下次要重裁几秒，不是用户资产。
    所以它可以被清理，而 `projects/` 不行——两者放在同一层，语义却完全不同，
    清理逻辑必须只认这个目录（见 `kvm.render.font_cache`）。
    """
    return app_data_root() / "font-cache"


def models_dir() -> Path:
    """模型权重缓存根目录。

    **绝不能用 audio-separator 默认的 `/tmp/audio-separator-models/`**
    （CLAUDE.md §5.14）：macOS 会被系统定期清理，Windows 上这个语义完全不对。
    """
    return app_data_root() / "models"
