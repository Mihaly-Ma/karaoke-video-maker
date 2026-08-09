"""字体子集缓存的清理。

起因是一次真实故障：缓存目录从来没有任何清理机制，`SUBSET_VERSION` 每 +1 就再堆
一层，一份子集 3–6 MB，本机长到 **106 MB / 26 个 .otf**，用户最后是自己动手 `rm`
才恢复的。CLAUDE.md §2.6 的原话是"用户不应该为了跑起这个工具去手动做任何事"。

这里守三条，其中第三条最重要：**删文件不可逆，宁可少删也不能多删。**
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.render import font_cache  # noqa: E402
from kvm.render.font_subset import SUBSET_VERSION  # noqa: E402


def _write(path: Path, size: int) -> Path:
    path.write_bytes(b"\0" * size)
    return path


def _artifact(cache: Path, version: int, key: str, size: int = 1024) -> Path:
    return _write(cache / f"v{version}-{key}.otf", size)


KEY_A = "0123456789abcdef"
KEY_B = "fedcba9876543210"
KEY_C = "aaaabbbbccccdddd"


def test_removes_previous_version_artifacts(tmp_path: Path) -> None:
    """旧版本产物永远不会再被命中（缓存键里就带版本号），删掉零成本。"""
    old = _artifact(tmp_path, SUBSET_VERSION - 1, KEY_A)
    older = _artifact(tmp_path, 1, KEY_B)
    current = _artifact(tmp_path, SUBSET_VERSION, KEY_C)

    report = font_cache.prune_font_cache(tmp_path)

    assert not old.exists()
    assert not older.exists()
    assert current.exists(), "当前版本是热数据，不该被版本清理碰到"
    assert report.removed_stale == 2
    assert report.removed_overflow == 0


def test_keeps_current_version_when_within_budget(tmp_path: Path) -> None:
    kept = [_artifact(tmp_path, SUBSET_VERSION, k, size=1024) for k in (KEY_A, KEY_B, KEY_C)]

    report = font_cache.prune_font_cache(tmp_path, max_bytes=1024 * 1024)

    assert all(p.exists() for p in kept)
    assert report.removed_files == 0
    assert report.kept_files == 3


def test_trims_oldest_when_over_budget(tmp_path: Path) -> None:
    """超预算时按 mtime 从旧到新删。写入即最后一次使用，所以这实际是 FIFO。"""
    old = _artifact(tmp_path, SUBSET_VERSION, KEY_A, size=600)
    mid = _artifact(tmp_path, SUBSET_VERSION, KEY_B, size=600)
    new = _artifact(tmp_path, SUBSET_VERSION, KEY_C, size=600)
    import os

    os.utime(old, (1000, 1000))
    os.utime(mid, (2000, 2000))
    os.utime(new, (3000, 3000))

    report = font_cache.prune_font_cache(tmp_path, max_bytes=1300)

    assert not old.exists(), "最旧的先删"
    assert mid.exists() and new.exists()
    assert report.removed_overflow == 1


def test_never_deletes_the_artifact_just_generated(tmp_path: Path) -> None:
    """`protect` 保住刚裁好的那份。

    否则会出现"裁完立刻被自己删掉、下次请求再裁一遍"的抖动——而清理正是挂在
    生成之后触发的，这个自噬循环会稳定发生，不是偶发。
    """
    import os

    fresh = _artifact(tmp_path, SUBSET_VERSION, KEY_A, size=600)
    other = _artifact(tmp_path, SUBSET_VERSION, KEY_B, size=600)
    os.utime(fresh, (1000, 1000))  # 刻意让它是最旧的，正常规则下会被先删
    os.utime(other, (3000, 3000))

    font_cache.prune_font_cache(tmp_path, max_bytes=700, protect=fresh)

    assert fresh.exists()
    assert not other.exists()


def test_stale_only_leaves_current_version_alone(tmp_path: Path) -> None:
    """启动时用这一档：只删旧版本，不碰可能正在被下发的当前版本产物。"""
    old = _artifact(tmp_path, SUBSET_VERSION - 1, KEY_A, size=10_000)
    current = _artifact(tmp_path, SUBSET_VERSION, KEY_B, size=10_000)

    report = font_cache.prune_font_cache(tmp_path, max_bytes=1, stale_only=True)

    assert not old.exists()
    assert current.exists(), "stale_only 下即使超预算也不许动当前版本"
    assert report.removed_overflow == 0


@pytest.mark.parametrize(
    "name",
    [
        "font-scan-cache.json",  # 同目录下的扫描缓存，不是子集产物
        "notes.txt",
        "v3-0123456789abcdef.ttf",  # 扩展名不对
        "v3-XYZ.otf",  # 键不是十六进制
        "vX-0123456789abcdef.otf",  # 版本不是数字
    ],
)
def test_never_touches_anything_it_did_not_create(tmp_path: Path, name: str) -> None:
    """**清理只认自己的命名规则。**删文件不可逆，判据宁可严到少删。

    这条用例把"目录里可能出现的别的东西"逐个钉住：只要有一个被误删，
    用户丢的就是不可再生的数据。
    """
    bystander = _write(tmp_path / name, 4096)
    # 同时放一个真的该删的，确认清理确实跑了、不是因为什么都没做才没删
    doomed = _artifact(tmp_path, SUBSET_VERSION - 1, KEY_A)

    font_cache.prune_font_cache(tmp_path, max_bytes=1)

    assert bystander.exists(), f"{name} 不是本工具的产物，绝不能删"
    assert not doomed.exists(), "清理本身没跑，这条用例就证明不了任何事"


def test_ignores_symlinks(tmp_path: Path) -> None:
    """顺着符号链接删出目录外，是最容易造成不可逆损失的路径。"""
    outside = _write(tmp_path.parent / "precious.otf", 4096)
    link = tmp_path / f"v{SUBSET_VERSION - 1}-{KEY_A}.otf"
    try:
        link.symlink_to(outside)
    except OSError:  # pragma: no cover - Windows 无权限时跳过
        pytest.skip("本平台不允许建符号链接")

    font_cache.prune_font_cache(tmp_path)

    assert outside.exists()
    assert link.exists(), "符号链接本身也不动——它不是我们生成的产物"


def test_removes_legacy_named_artifacts(tmp_path: Path) -> None:
    """加版本前缀**之前**的老命名也要能清掉。

    这条不是补丁：用户磁盘上堆着的 106 MB 全是 `<16 位十六进制>.otf` 这个形状，
    只认新命名的话，清理机制看起来做了、实际一份都删不掉——第一次接上去时
    正是这样，重启后目录纹丝不动。
    """
    legacy = _write(tmp_path / f"{KEY_A}.otf", 5000)
    scan_cache = _write(tmp_path / "font-scan-cache.json", 100)

    report = font_cache.prune_font_cache(tmp_path)

    assert not legacy.exists()
    assert scan_cache.exists(), "同目录的扫描缓存不是子集产物"
    assert report.removed_stale == 1


def test_stats_report_stale_count(tmp_path: Path) -> None:
    _artifact(tmp_path, SUBSET_VERSION, KEY_A, size=100)
    _artifact(tmp_path, SUBSET_VERSION - 1, KEY_B, size=200)

    count, total, stale = font_cache.cache_stats(tmp_path)

    assert (count, total, stale) == (2, 300, 1)


def test_missing_directory_is_not_an_error(tmp_path: Path) -> None:
    """首次运行时目录还不存在，清理不该炸——它跑在启动路径上。"""
    report = font_cache.prune_font_cache(tmp_path / "not-there")

    assert report.removed_files == 0
    assert report.kept_files == 0


def test_artifact_name_carries_the_version(tmp_path: Path) -> None:
    """版本写进**文件名**而不是只藏在哈希里——键是 sha256 前 16 位，
    从哈希本身看不出版本，也就无从按版本清理。"""
    name = font_cache.artifact_name(KEY_A)

    assert name == f"v{SUBSET_VERSION}-{KEY_A}.otf"
    assert font_cache._ARTIFACT_RE.match(name)
