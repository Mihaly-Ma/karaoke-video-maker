#!/usr/bin/env python3
"""版本号的单一真源与漂移检查。

    python3 scripts/version.py                 # 检查：所有落点必须一致
    python3 scripts/version.py --set 0.2.0     # 一条命令改全部落点（含锁文件）
    python3 scripts/version.py --print         # 只打印当前版本，供脚本消费
    python3 scripts/version.py --expect 0.2.0  # 检查 + 断言等于给定值（CI 的 tag 守卫）

## 为什么真源是 `pyproject.toml`，而不是新建一个 `VERSION` 文件

版本号天然要出现在**每个包管理器各自的清单里**（Python / npm ×2 / Cargo / Tauri），
这一点没法消除——Cargo 不会去读别处的文件，npm 也不会。既然必然存在 N 份副本，
问题就只剩"谁是原件"。

新建一个 `VERSION` 文件会让副本变成 N+1 份，且那一份**没有任何工具会读**，
它唯一的作用就是被抄写。相反，`pyproject.toml` 里已经躺着这个项目的身份声明
（name / description / readme），uv 每次解析依赖都要读它——它不会烂掉，
也不需要额外解释"这个文件是干嘛的"。所以本脚本把它定为原件，其余一律是副本。

**真正起作用的不是这条约定，而是下面那张表加上 `--check`。** 脚本可以被绕过
（谁都能直接编辑 Cargo.toml），检查不会：它跑在 `pytest` 与 CI 的 check job 里，
任何一处对不上就红。

## 落点为什么要连锁文件一起改

`src-tauri/Cargo.lock` 里记着 `kvm-shell` 自己的版本，CI 跑的是
`cargo check --locked`——只改 Cargo.toml 不改 Cargo.lock，那一步直接失败。
`uv.lock` 与两个 `package-lock.json` 同理：它们都把本项目自身当成一个包记了一遍。

## "找不到"必须是错误，不能是跳过

每个落点都要求正则**恰好匹配一次**。匹配 0 次（有人重排了文件）或多次（模式太松）
一律报错，而不是当作"这个文件没有版本号"悄悄放过——后者会让检查在最需要它的时候
静默失效，正是这套机制要防的事。

## 换行符

Windows 的 GitHub runner 默认 `core.autocrlf=true`，检出来的文件是 CRLF。
读取一律走 Python 的通用换行（`\r\n` → `\n`），所以模式里只写 `\n`；
写回时显式 `newline="\n"`，免得在 Windows 上把整个文件换成 CRLF。
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# NSIS 与 WiX 都只能表达三段纯数字的版本号，带预发布后缀（0.2.0-rc1）的
# 打包会失败或被静默截断。与其等到打包那十几分钟之后才发现，不如在这里拦住。
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


class VersionSiteError(Exception):
    """某个落点读不出版本号（模式没匹配，或匹配了不止一处）。"""


@dataclass(frozen=True)
class Site:
    """版本号的一个落点。`pattern` 必须带一个名为 `v` 的分组，且恰好匹配一次。"""

    label: str
    path: str
    why: str
    pattern: re.Pattern[str]


# 真源排在第一位：`--check` 拿它当基准，`--print` 打印的也是它。
SITES: tuple[Site, ...] = (
    Site(
        label="pyproject.toml",
        path="pyproject.toml",
        why="真源：项目身份声明（uv 读它）",
        pattern=re.compile(r'(?m)^version = "(?P<v>[^"]+)"$'),
    ),
    Site(
        label="package.json",
        path="package.json",
        why="外壳构建入口（Tauri CLI 的宿主）",
        pattern=re.compile(r'(?m)^  "version": "(?P<v>[^"]+)",$'),
    ),
    Site(
        label="frontend/package.json",
        path="frontend/package.json",
        why="前端包",
        pattern=re.compile(r'(?m)^  "version": "(?P<v>[^"]+)",$'),
    ),
    Site(
        label="src-tauri/Cargo.toml",
        path="src-tauri/Cargo.toml",
        why="外壳 crate；tauri.conf.json 缺省时也回落到它",
        pattern=re.compile(r'(?m)^version = "(?P<v>[^"]+)"$'),
    ),
    Site(
        label="src-tauri/tauri.conf.json",
        path="src-tauri/tauri.conf.json",
        why="**安装包的内部版本号**（dmg/nsis 里显示的那个）",
        pattern=re.compile(r'(?m)^  "version": "(?P<v>[^"]+)",$'),
    ),
    Site(
        label="backend/kvm/api/app.py",
        path="backend/kvm/api/app.py",
        why="FastAPI 的 `version=`，出现在 /openapi.json 与 /docs 上",
        pattern=re.compile(r'(?m)^    version="(?P<v>[^"]+)",$'),
    ),
    # —— 以下是锁文件，它们把本项目自身也记了一份 ——
    Site(
        label="src-tauri/Cargo.lock",
        path="src-tauri/Cargo.lock",
        why="对不上时 CI 的 `cargo check --locked` 直接失败",
        pattern=re.compile(r'(?m)^name = "kvm-shell"\nversion = "(?P<v>[^"]+)"$'),
    ),
    Site(
        label="uv.lock",
        path="uv.lock",
        why="uv 把本项目当 virtual package 记了一遍",
        pattern=re.compile(r'(?m)^name = "karaoke-video-maker"\nversion = "(?P<v>[^"]+)"$'),
    ),
    Site(
        label="package-lock.json（根）",
        path="package-lock.json",
        why="npm 锁文件的顶层字段",
        pattern=re.compile(r'(?m)^  "version": "(?P<v>[^"]+)",$'),
    ),
    Site(
        label='package-lock.json（packages[""]）',
        path="package-lock.json",
        why="npm 锁文件里本项目自身那条",
        pattern=re.compile(
            r'(?m)^      "name": "karaoke-video-maker",\n      "version": "(?P<v>[^"]+)",$'
        ),
    ),
    Site(
        label="frontend/package-lock.json（根）",
        path="frontend/package-lock.json",
        why="npm 锁文件的顶层字段",
        pattern=re.compile(r'(?m)^  "version": "(?P<v>[^"]+)",$'),
    ),
    Site(
        label='frontend/package-lock.json（packages[""]）',
        path="frontend/package-lock.json",
        why="npm 锁文件里本项目自身那条",
        pattern=re.compile(
            r'(?m)^      "name": "karaoke-video-maker-frontend",\n'
            r'      "version": "(?P<v>[^"]+)",$'
        ),
    ),
)

CANONICAL = SITES[0]


def _display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    """按终端显示宽度补空格——落点名里有全角字符，`str.ljust` 会把这一列排歪。"""
    return text + " " * max(0, width - _display_width(text))


def _read_text(path: Path) -> str:
    # 通用换行：CRLF 检出（Windows CI）下模式里的 `\n` 照样能匹配。
    return path.read_text(encoding="utf-8")


def read_site(site: Site, root: Path = REPO_ROOT) -> str:
    """读出某个落点的版本号。模式不是恰好匹配一次就抛错，绝不静默跳过。"""
    path = root / site.path
    if not path.is_file():
        raise VersionSiteError(f"{site.label}：文件不存在（{path}）")
    matches = site.pattern.findall(_read_text(path))
    if len(matches) != 1:
        raise VersionSiteError(
            f"{site.label}：期望恰好匹配 1 处版本号，实际 {len(matches)} 处。"
            f"\n  文件被重排过或模式失效了，请修 scripts/version.py 里对应的 SITES 条目。"
            f"\n  模式：{site.pattern.pattern}"
        )
    return matches[0]


def collect(root: Path = REPO_ROOT) -> dict[str, str]:
    """读出全部落点。任何一处读不出就直接抛错。"""
    return {site.label: read_site(site, root) for site in SITES}


def disagreements(found: dict[str, str], expected: str) -> dict[str, str]:
    """挑出与期望值不符的落点。"""
    return {label: value for label, value in found.items() if value != expected}


def write_site(site: Site, new_version: str, root: Path = REPO_ROOT) -> str:
    """把某个落点改成新版本，返回它原来的值。"""
    path = root / site.path
    old = read_site(site, root)
    text = _read_text(path)

    def _sub(m: re.Match[str]) -> str:
        # 只替换 `v` 分组本身，模式里其余部分（缩进、键名、前一行）原样保留。
        start, end = m.span("v")
        return m.group(0)[: start - m.start()] + new_version + m.group(0)[end - m.start() :]

    updated, count = site.pattern.subn(_sub, text)
    if count != 1:  # pragma: no cover —— read_site 已经保证是 1
        raise VersionSiteError(f"{site.label}：替换时匹配到 {count} 处")
    # 显式 newline="\n"：不要在 Windows 上把整个文件改成 CRLF。
    path.write_text(updated, encoding="utf-8", newline="\n")
    return old


def set_version(new_version: str, root: Path = REPO_ROOT) -> list[tuple[str, str]]:
    """把全部落点改成新版本，返回 [(落点, 旧值)]。"""
    # 先整体读一遍再写：某个落点的模式失效时，不要留下改了一半的工作区。
    collect(root)
    return [(site.label, write_site(site, new_version, root)) for site in SITES]


def _cmd_check(expect: str | None, root: Path) -> int:
    try:
        found = collect(root)
    except VersionSiteError as exc:
        print(f"版本号检查失败：{exc}", file=sys.stderr)
        return 1

    # 真源是仓库自己的说法；`--expect` 是外部（tag）的说法。两者是两种不同的失败，
    # 分开判：落点内部先要自洽，然后才谈它和 tag 对不对得上。
    repo_version = found[CANONICAL.label]
    bad = disagreements(found, repo_version)

    width = max(_display_width(label) for label in found)
    for label, value in found.items():
        mark = "✗" if label in bad else "·"
        print(f"  {mark} {_pad(label, width)}  {value}")

    # 两个流分别缓冲，不刷一下的话报错会插到表格前面，读起来像是先说结论后列证据。
    sys.stdout.flush()

    if bad:
        print(
            f"\n版本号漂移了。真源 {CANONICAL.label} 是 {repo_version}，下列落点对不上：",
            file=sys.stderr,
        )
        for label, value in bad.items():
            print(f"  - {label}：{value}", file=sys.stderr)
        print(f"\n修法：python3 scripts/version.py --set {repo_version}", file=sys.stderr)
        return 1

    if expect is not None and expect != repo_version:
        print(
            f"\ntag 说 {expect}，但仓库里写的是 {repo_version}。"
            "\n打 tag 前必须先改版本号并提交，否则安装包文件名与它的内部版本会对不上。"
            f"\n修法：python3 scripts/version.py --set {expect} 后提交，再重新打 tag。",
            file=sys.stderr,
        )
        return 1

    print(f"版本号一致：{repo_version}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="版本号的单一真源与漂移检查",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="不给参数时等同于 --check。",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="检查所有落点是否一致（默认）")
    group.add_argument("--set", metavar="X.Y.Z", help="把所有落点改成该版本")
    group.add_argument("--print", action="store_true", dest="do_print", help="打印当前版本")
    parser.add_argument(
        "--expect",
        metavar="X.Y.Z",
        help="检查时额外断言版本号等于该值（CI 的 tag 守卫用）",
    )
    args = parser.parse_args(argv)

    if args.do_print:
        try:
            print(read_site(CANONICAL))
        except VersionSiteError as exc:
            print(exc, file=sys.stderr)
            return 1
        return 0

    if args.set:
        if not SEMVER.match(args.set):
            print(
                f"版本号 {args.set!r} 不是三段纯数字（NSIS/WiX 只认这种形状）",
                file=sys.stderr,
            )
            return 1
        try:
            changed = set_version(args.set)
        except VersionSiteError as exc:
            print(f"改版本失败：{exc}", file=sys.stderr)
            return 1
        width = max(_display_width(label) for label, _ in changed)
        for label, old in changed:
            print(f"  {_pad(label, width)}  {old} → {args.set}")
        # 两条锁文件的校验各自独立：`cargo check --locked` 与 `uv lock --check`
        # 都会因为锁里的自身版本对不上而失败，而 CI 上前者正是一个必过步骤。
        print(f"\n共 {len(changed)} 处已改为 {args.set}。提交前跑一次：")
        print("  cargo check --locked --manifest-path src-tauri/Cargo.toml")
        print("  uv lock --check")
        return 0

    if args.expect is not None and not SEMVER.match(args.expect):
        print(f"期望值 {args.expect!r} 不是三段纯数字版本号", file=sys.stderr)
        return 1
    return _cmd_check(args.expect, REPO_ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
