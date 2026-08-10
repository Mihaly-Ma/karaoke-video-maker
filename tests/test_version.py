"""版本号漂移检查（`scripts/version.py`）。

版本号散在 12 处：6 份声明（pyproject / 两个 package.json / Cargo.toml /
tauri.conf.json / FastAPI 的 `version=`）+ 6 处锁文件里的自身条目。
手改一处漏掉其余，症状是**安装包文件名写着 v0.2.0、而应用内部版本还是 0.1.0**
——这种错到用户装完打开才暴露。

`scripts/version.py --set` 能一把改全，但脚本可以被绕过（谁都能直接编辑 Cargo.toml），
**检查不会**：本文件跑在默认 pytest 门禁里，CI 的 check job 也单独跑一遍同一份逻辑。

下面的用例分两半：

- 真仓库上的**通过路径**（12 处必须相等）
- 合成场景下的**失败路径**：改坏一处要能被抓到并指名道姓；某个文件被重排、
  模式匹配不上时要**报错而不是跳过**——静默跳过会让检查在最需要它的时候失效。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = _REPO_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    # 本项目不做 editable install，脚本目录不是包，测试自带路径引导（同 test_doctor.py）
    sys.path.insert(0, str(_SCRIPTS))

import version as ver  # noqa: E402

# 合成仓库统一钉在这个版本上，与真仓库当前是多少无关。
# **不要改成"沿用真仓库的版本"**：真仓库一旦漂移，下面几个失败路径用例会跟着
# 从起点就是坏的，于是它们红的原因和它们要测的东西没关系——那种红最难读。
_FAKE_VERSION = "1.2.3"


def _fake_repo(tmp_path: Path) -> Path:
    """把真仓库里的 12 个落点复制到 tmp_path 并统一版本，供失败路径用例改坏。"""
    for site in ver.SITES:
        dst = tmp_path / site.path
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            shutil.copy2(_REPO_ROOT / site.path, dst)
    ver.set_version(_FAKE_VERSION, tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# 真仓库：通过路径
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("site", ver.SITES, ids=lambda s: s.path)
def test_每个落点都能恰好读出一个版本号(site: ver.Site) -> None:
    # 匹配 0 次（文件被重排）或多次（模式太松）都会抛 VersionSiteError
    assert ver.SEMVER.match(ver.read_site(site))


def test_十二个落点全部相等() -> None:
    found = ver.collect()
    canonical = found[ver.CANONICAL.label]
    assert ver.disagreements(found, canonical) == {}


def test_命令行检查在真仓库上通过() -> None:
    assert ver.main(["--check"]) == 0


def test_tag守卫接受与仓库一致的版本() -> None:
    assert ver.main(["--check", "--expect", ver.read_site(ver.CANONICAL)]) == 0


def test_tag守卫拒绝对不上的版本() -> None:
    # 模拟"忘了改版本号就打了 v9.9.9"：必须红，否则产物名与内部版本会分叉
    assert ver.main(["--check", "--expect", "9.9.9"]) == 1


# ---------------------------------------------------------------------------
# 合成场景：失败路径
# ---------------------------------------------------------------------------


def test_改坏一处就会被抓到并指名道姓(tmp_path: Path) -> None:
    root = _fake_repo(tmp_path)
    victim = next(s for s in ver.SITES if s.path == "src-tauri/Cargo.lock")
    ver.write_site(victim, "9.9.9", root)

    found = ver.collect(root)
    bad = ver.disagreements(found, found[ver.CANONICAL.label])
    assert list(bad) == [victim.label]
    assert bad[victim.label] == "9.9.9"


def test_文件被重排导致模式失配时报错而不是跳过(tmp_path: Path) -> None:
    root = _fake_repo(tmp_path)
    site = next(s for s in ver.SITES if s.path == "src-tauri/Cargo.toml")
    (root / site.path).write_text('[package]\nname = "kvm-shell"\n', encoding="utf-8")

    with pytest.raises(ver.VersionSiteError, match="恰好匹配 1 处"):
        ver.read_site(site, root)


def test_落点文件缺失时报错(tmp_path: Path) -> None:
    root = _fake_repo(tmp_path)
    site = ver.CANONICAL
    (root / site.path).unlink()

    with pytest.raises(ver.VersionSiteError, match="文件不存在"):
        ver.read_site(site, root)


def test_改版本是幂等的且只动版本号那一行(tmp_path: Path) -> None:
    root = _fake_repo(tmp_path)
    before = {s.path: (root / s.path).read_bytes() for s in ver.SITES}

    ver.set_version("9.8.7", root)
    assert set(ver.collect(root).values()) == {"9.8.7"}

    ver.set_version(_FAKE_VERSION, root)
    for path, original in before.items():
        # 来回改一遍必须逐字节还原——否则每次发版都会在锁文件里留下无关噪声
        assert (root / path).read_bytes() == original


def test_预发布后缀不被接受() -> None:
    # NSIS/WiX 只能表达三段纯数字；0.2.0-rc1 要么打包失败要么被静默截断
    assert ver.SEMVER.match("0.2.0")
    assert not ver.SEMVER.match("0.2.0-rc1")
    assert not ver.SEMVER.match("v0.2.0")
