"""自动获取外部依赖：CLAUDE.md §2.6 三段式里的**「获取」**那一段。

「查找」在 `kvm.media.ffmpeg` / `kvm.doctor`，「安装」的目录规则在 `kvm.paths`，
本模块只补中间那一段：**缺什么就下载什么，装进应用私有目录**。

    python -m kvm.bootstrap                 # 看缺什么
    python -m kvm.bootstrap --fetch ffmpeg  # 真的去下
    python -m kvm.bootstrap --import-from ~/Downloads/ffmpeg81arm.zip

## 三条不可让步的安全规则

1. **下载源写死在代码里**，不从网上取清单再照着下——那等于把"下什么"的
   决定权交给远端。
2. **SHA256 也写死在代码里**，校验不过一律拒绝使用并报错。哈希对不上有两种
   可能（上游换了文件 / 传输被动了手脚），两种都不该让程序继续用它。
3. **只解压、不执行任何随下载附带的脚本**。归档里只取我们指名的那几个文件，
   其余一律忽略；解压前逐条检查成员路径，挡掉 `../` 与绝对路径（zip slip）。

## 为什么必须自己带 ffmpeg

macOS 上 `brew install ffmpeg`（最常见的安装路径）装出来的**不含 libass**，
`ass` 滤镜直接不存在，烧字幕全线不可用（§2.4）。所以判据从来不是"有没有
ffmpeg"，而是**「`ass` 滤镜注册没注册」**——下载装完之后仍然要跑一次能力探测
才算成功，这条判据直接复用 `kvm.media.ffmpeg.has_libass`，不另写一份。

## 进度与断点续传

大文件（ffmpeg 约 27–110 MB，分离权重 84–640 MB，对齐模型 1.26 GB）必须有
可见进度，否则弱网下用户会以为程序卡死（§5.14）。中断后用 HTTP Range 从
`.part` 文件续传；服务器不支持 Range 就从头下，**不会**把半截文件当成完整的用。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import stat
import sys
import tarfile
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

from kvm import paths

# 下载超时：连接 30s、单次读取 120s。整体不设上限——1.26 GB 的权重在慢网上
# 本来就要跑很久，设个总时长上限只会在快下完时功亏一篑。
_CONNECT_TIMEOUT = 30.0
_CHUNK = 1 << 20


# ---------------------------------------------------------------------------
# 下载源清单（写死 + 哈希写死）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Artifact:
    """一个可下载的构件。

    `members` 是「归档内路径 → 落地文件名」。**只取列出的成员**，
    归档里其它东西一概不解压——这既是安全边界，也避免把
    `__MACOSX/` 之类的垃圾摊进私有目录。
    """

    key: str
    url: str
    sha256: str
    size: int
    """预期字节数。先比大小能在算哈希前就挡掉明显不对的下载，省一次全文件读。"""
    members: dict[str, str]
    executable: bool = False
    note: str = ""


@dataclass(frozen=True)
class Component:
    """一个"能力"：由若干构件组成，装完要能通过 `verify`。"""

    key: str
    title: str
    artifacts: tuple[Artifact, ...]
    why: str
    """缺了会怎样——报错时要说清楚用户在失去什么。"""


def _platform_key() -> str:
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Darwin" and machine in {"arm64", "aarch64"}:
        return "macos-arm64"
    if system == "Windows" and machine in {"amd64", "x86_64"}:
        return "windows-x64"
    return f"{system.lower()}-{machine}"


# ffmpeg 静态构建。两个平台的来源不同，各自的理由写在下面。
#
# macOS arm64：ffmpeg.martin-riedl.de 的静态构建。
#
#   **已从 osxexperts.net 换过来**，换掉的是两个具体缺陷，不是口味问题：
#
#   - osxexperts **不发布校验和**。于是"SHA256 写死在代码里"这条安全规则退化成
#     "锁住我们某一次下载到的字节"——它挡得住之后的篡改，却证明不了第一次下对了。
#     真正的校验必须有一个**独立于我们这次下载**的期望值。
#   - osxexperts 的 URL 只带主版本号（`ffmpeg81arm.zip`），上游发补丁版时会
#     **原地替换**同一个文件。失败方向是安全的（校验失败并明确报错，不会用），
#     但用户看到的是"某天突然装不上了"，而我们这边毫无察觉。
#
#   martin-riedl 两条都不成立：
#
#   - URL 按 `<构建时间戳>_<git 描述>` 定版，新构建走新路径、**旧路径不被改写**。
#     实测该站保留 171 个历史版本，2025-02 的构建今天仍可下载——所以钉死的
#     这条链接不会因为上游出新版而失效。
#   - 每个归档旁边有官方 `.sha256`。下面写死的哈希是**与它比对过**的，
#     不是我们自算的孤证（2026-08-10 实测：官方值 = 我们下载后 shasum 的值）。
#
#   实测（2026-08-10，本机 Apple Silicon）：configure 含 `--enable-libass
#   --enable-libfreetype --enable-fontconfig --enable-libharfbuzz`，
#   `ass` 与 `subtitles` 滤镜**均已注册**（本项目的判据，§2.6）；
#   `otool -L` 除系统框架外零动态依赖，拷到别的机器可直接跑。
#
#   **ffmpeg 与 ffprobe 必须取自同一个构建目录**：ffprobe 报的时长/起始偏移
#   直接进时间轴计算，两个不同构建之间的差异会变成对不上的轴
#   （见 kvm.media.ffmpeg.ffprobe_for）。
#
# Windows x64：gyan.dev 的 essentials 构建，取自其 GitHub 镜像
#   `GyanD/codexffmpeg` 的**版本 tag**（不是 `latest`）。GitHub release 资产
#   在 tag 下不会被改写，所以哈希可以长期固定。essentials 已含
#   `libass libfreetype libfribidi libharfbuzz`（官方构建说明），够本项目用；
#   full 构建 266 MB 属实浪费。**未在 Windows 上实测**：哈希是在 macOS 上
#   下载同一份 zip 算出来的，能力探测要等真机上跑 `kvm.doctor` 才算数。
#   **这条不跟着 macOS 换源**：GitHub release 资产在 tag 下不会被改写，
#   osxexperts 那两个毛病（无官方校验和、URL 原地替换）它本来就没有。
#   而且 martin-riedl **只出 macOS 与 Linux，没有 Windows 构建**（2026-08-10 实测），
#   想统一也统一不了。
_FFMPEG: dict[str, tuple[Artifact, ...]] = {
    "macos-arm64": (
        Artifact(
            key="ffmpeg",
            url=(
                "https://ffmpeg.martin-riedl.de/download/macos/arm64/"
                "1785661721_N-125892-g406c5a37aa/ffmpeg.zip"
            ),
            sha256="2d96af0e28b81d5215d8b9a6dec4e751b5b97408205ccfae5760084fa107d936",
            size=28503173,
            members={"ffmpeg": "ffmpeg"},
            executable=True,
            note="ffmpeg N-125892-g406c5a37aa 静态构建（含 libass）",
        ),
        Artifact(
            key="ffprobe",
            url=(
                "https://ffmpeg.martin-riedl.de/download/macos/arm64/"
                "1785661721_N-125892-g406c5a37aa/ffprobe.zip"
            ),
            sha256="0e60dca1df67bffc0b232d54e9833de3508787af6822aec60233dd4f2687645e",
            size=28417691,
            members={"ffprobe": "ffprobe"},
            executable=True,
            note="ffprobe，与 ffmpeg 取自同一次构建",
        ),
    ),
    "windows-x64": (
        Artifact(
            key="ffmpeg",
            url=(
                "https://github.com/GyanD/codexffmpeg/releases/download/"
                "8.1.2/ffmpeg-8.1.2-essentials_build.zip"
            ),
            sha256="db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec",
            size=109728040,
            members={
                "ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe": "ffmpeg.exe",
                "ffmpeg-8.1.2-essentials_build/bin/ffprobe.exe": "ffprobe.exe",
            },
            executable=True,
            note="ffmpeg 8.1.2 essentials（含 libass）；未在 Windows 上实测",
        ),
    ),
}


_MANUAL_INSTALL: dict[str, str] = {
    "macos-arm64": "brew tap homebrew-ffmpeg/ffmpeg && brew install ffmpeg-full",
    "windows-x64": "winget install --id Gyan.FFmpeg.Essentials",
}
"""自动获取之外的手工出路：按平台给一条可直接复制粘贴的命令（§2.6）。

**摆出来不等于推荐它。** 这条路装进用户系统（本项目的原则是装进应用私有目录、
卸载即删目录），macOS 上还有两道坎：Homebrew 主线 `ffmpeg` formula **不带
libass**，装了也用不了；`ffmpeg-full` 在第三方 tap 里，常常要从源码编译很久。
它存在只是为了兜住"下载失败 / 离线 / 用户不接受第三方构建"这三种情况——
§2.6 要求这几种情况都得有出路，而不是只剩一句"请安装 X"。
"""


def components() -> list[Component]:
    """当前平台可自动获取的组件清单。"""
    arts = _FFMPEG.get(_platform_key(), ())
    out = [
        Component(
            key="ffmpeg",
            title="ffmpeg（带 libass）",
            artifacts=arts,
            why="没有它就无法预览取帧、生成代理视频、烧录字幕、导出成片——整条出片链路不可用",
        )
    ]
    return out


# ---------------------------------------------------------------------------
# 进度事件
# ---------------------------------------------------------------------------


@dataclass
class Progress:
    """一次获取动作的可观测状态。前端按 `stage` 翻译文案，不直接显示中文。"""

    component: str
    stage: str
    """`downloading` / `verifying` / `extracting` / `probing` / `done` / `failed`"""
    downloaded: int = 0
    total: int = 0
    detail: str = ""
    error_code: str = ""
    """失败原因的**稳定标识**（§8.8：后端不再吐给人看的中文散文）。"""
    error_args: dict[str, str] = field(default_factory=dict)


ProgressCb = Callable[[Progress], None]


class BootstrapError(RuntimeError):
    """带错误码的失败。文案由前端按 `code` 翻译，`detail_args` 提供占位符。

    **占位符字典绝不能叫 `args`。** `BaseException.args` 是内建属性，赋值时会被
    强制转成元组——赋一个 dict 进去只剩下**键**，值（期望/实际哈希这类唯一有用的
    信息）当场丢光，而且 `str(exc)` 会变成 `"('url', 'expected', 'actual')"`。
    实测后果是双重的：命令行打出这串元组而不是原因；HTTP 层拿元组去填
    `dict[str, str]` 字段，`/api/bootstrap/status` 直接 500——于是**恰好在有错误的
    时候**启动页的轮询取不到状态，只能永远转圈，而这正是这一页反复要求杜绝的失败方式。
    """

    def __init__(self, code: str, message: str, **args: str) -> None:
        super().__init__(message)
        self.code = code
        self.detail_args = {k: str(v) for k, v in args.items()}


# ---------------------------------------------------------------------------
# 下载 / 校验 / 解压
# ---------------------------------------------------------------------------


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def download(art: Artifact, dest_dir: Path, on_progress: ProgressCb | None = None) -> Path:
    """把构件下到 `dest_dir`，返回归档文件路径。已存在且哈希正确就直接复用。

    断点续传：未完成的内容留在 `<name>.part`，重跑时带 `Range` 从断点继续。
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    final = dest_dir / art.url.rsplit("/", 1)[-1]
    part = final.with_suffix(final.suffix + ".part")

    if final.is_file() and _sha256(final) == art.sha256:
        return final

    have = part.stat().st_size if part.is_file() else 0
    if have > art.size:
        # 断点比预期还大 = 上游换了文件或本地被写坏，续传毫无意义
        part.unlink()
        have = 0

    req = urllib.request.Request(art.url, headers={"User-Agent": "karaoke-video-maker"})
    if have:
        req.add_header("Range", f"bytes={have}-")

    try:
        with urllib.request.urlopen(req, timeout=_CONNECT_TIMEOUT) as resp:
            # 服务器忽略了 Range（返回 200 而不是 206）就必须从头写，
            # 否则会把新的完整内容追加在旧的半截后面，得到一个哈希永远对不上的文件。
            resume = resp.status == 206 and have > 0
            mode = "ab" if resume else "wb"
            if not resume:
                have = 0
            total = art.size
            with part.open(mode) as fh:
                while True:
                    chunk = resp.read(_CHUNK)
                    if not chunk:
                        break
                    fh.write(chunk)
                    have += len(chunk)
                    if on_progress:
                        on_progress(Progress(art.key, "downloading", downloaded=have, total=total))
    except urllib.error.URLError as exc:
        raise BootstrapError(
            "bootstrap.download_failed",
            f"下载失败：{art.url}（{exc}）",
            url=art.url,
            reason=str(exc),
        ) from exc

    if on_progress:
        on_progress(Progress(art.key, "verifying", downloaded=have, total=art.size))

    actual_size = part.stat().st_size
    if actual_size != art.size:
        part.unlink(missing_ok=True)
        raise BootstrapError(
            "bootstrap.size_mismatch",
            f"下载到的文件大小不对：期望 {art.size} 字节，实际 {actual_size}",
            url=art.url,
            expected=str(art.size),
            actual=str(actual_size),
        )
    actual = _sha256(part)
    if actual != art.sha256:
        part.unlink(missing_ok=True)
        raise BootstrapError(
            "bootstrap.hash_mismatch",
            f"SHA256 校验失败：{art.url}\n期望 {art.sha256}\n实际 {actual}",
            url=art.url,
            expected=art.sha256,
            actual=actual,
        )
    part.replace(final)
    return final


def _reject_unsafe_paths(names: Iterator[str]) -> None:
    """挡掉 zip slip。

    我们本来就只按名字取指定成员，理论上不会解压到目录外；但归档里出现
    `../` 或绝对路径本身就说明这个包不对劲，**直接拒绝整个归档**比逐个过滤更安全。
    """
    for name in names:
        norm = name.replace("\\", "/")
        if norm.startswith("/") or ".." in Path(norm).parts:
            raise BootstrapError(
                "bootstrap.unsafe_archive",
                f"归档里有可疑路径，已拒绝：{name}",
                member=name,
            )


def extract(art: Artifact, archive: Path, target_dir: Path) -> list[Path]:
    """只把 `art.members` 里指名的成员解到 `target_dir`，返回落地路径。"""
    target_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    def _write(name: str, data: bytes) -> None:
        out = target_dir / art.members[name]
        tmp = out.with_suffix(out.suffix + ".tmp")
        tmp.write_bytes(data)
        if art.executable:
            tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        # 原子替换：换 ffmpeg 的过程中被中断，不能留下一个半截的可执行文件
        tmp.replace(out)
        written.append(out)

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            _reject_unsafe_paths(iter(zf.namelist()))
            names = set(zf.namelist())
            for member in art.members:
                if member not in names:
                    raise BootstrapError(
                        "bootstrap.member_missing",
                        f"归档里没有预期的文件：{member}",
                        member=member,
                        url=art.url,
                    )
                _write(member, zf.read(member))
    else:
        with tarfile.open(archive) as tf:
            _reject_unsafe_paths(m.name for m in tf.getmembers())
            for member in art.members:
                fh = tf.extractfile(member)
                if fh is None:
                    raise BootstrapError(
                        "bootstrap.member_missing",
                        f"归档里没有预期的文件：{member}",
                        member=member,
                        url=art.url,
                    )
                with fh:
                    _write(member, fh.read())
    return written


# ---------------------------------------------------------------------------
# 组件级：获取 + 能力验证
# ---------------------------------------------------------------------------


_capability_cache: dict[tuple[str, int, int], bool] = {}
"""能力探测结果缓存，键是 (路径, 大小, mtime)。

**必须缓存。** 探测要真的跑一次 `ffmpeg -h filter=ass`，而 `status()` 会被启动页
每 400ms 轮询一次——实测一次首启就 fork 了 70 次子进程，纯属浪费，而且它与
正在解压同一个目录的后台线程抢资源，把 51 MB 的解压拖成了肉眼可见的卡顿。

键里带上大小与 mtime，所以"刚装好一份新的"会自动失效，不需要谁记得手工清缓存。
"""


def ffmpeg_ready() -> bool:
    """**这台机器上**有没有一个真的能烧字幕的 ffmpeg。

    判据是 `ass` 滤镜注册没注册，不是文件在不在（§2.6）。

    **不要只看应用私有目录。** §2.6 的三段式是"查找 → 获取 → 安装"，
    获取只补查找补不上的那部分；用户系统里已经有一份合格的 ffmpeg 时还去下一份，
    既浪费带宽也和解析层的优先级打架。所以这里直接问 `probe_ffmpeg()`——
    它就是解析层本身（私有目录 → 显式配置 → PATH 探测），与 `kvm.doctor` 同一份实现。
    """
    from kvm.media.ffmpeg import probe_ffmpeg

    exe = paths.private_bin_dir() / ("ffmpeg.exe" if sys.platform.startswith("win") else "ffmpeg")
    try:
        st = exe.stat()
        key = (str(exe), st.st_size, int(st.st_mtime))
    except OSError:
        key = (str(exe), -1, -1)
    cached = _capability_cache.get(key)
    if cached is None:
        cached = probe_ffmpeg().ok
        _capability_cache[key] = cached
    return cached


def fetch_component(key: str, on_progress: ProgressCb | None = None) -> None:
    """下载并安装一个组件，装完做能力验证。失败一律抛 `BootstrapError`。"""
    comp = next((c for c in components() if c.key == key), None)
    if comp is None:
        raise BootstrapError("bootstrap.unknown_component", f"没有这个组件：{key}", component=key)
    if not comp.artifacts:
        raise BootstrapError(
            "bootstrap.unsupported_platform",
            f"当前平台（{_platform_key()}）没有可自动获取的 {comp.title}",
            component=key,
            platform=_platform_key(),
        )

    cache = paths.app_data_root() / "downloads"
    for art in comp.artifacts:
        archive = download(art, cache, on_progress)
        if on_progress:
            on_progress(Progress(art.key, "extracting", detail=art.note))
        extract(art, archive, paths.private_bin_dir())

    if on_progress:
        on_progress(Progress(key, "probing"))
    if key == "ffmpeg" and not ffmpeg_ready():
        raise BootstrapError(
            "bootstrap.capability_check_failed",
            "下载的 ffmpeg 装好了，但它的 ass 滤镜不可用——这份构建不带 libass，不能用来烧字幕",
            component=key,
        )
    if on_progress:
        on_progress(Progress(key, "done"))


def import_offline(archive: Path) -> str:
    """离线导入：用户自己下好的归档，走同一套校验与解压。

    §5.14 要求支持离线导入。**它不是"绕过校验"的后门**——哈希仍然要对得上
    清单里的某一条，只是省掉下载。内网/断网环境把文件拷进来即可。
    """
    if not archive.is_file():
        raise BootstrapError(
            "bootstrap.file_not_found", f"文件不存在：{archive}", path=str(archive)
        )
    digest = _sha256(archive)
    for comp in components():
        for art in comp.artifacts:
            if art.sha256 == digest:
                extract(art, archive, paths.private_bin_dir())
                return art.key
    raise BootstrapError(
        "bootstrap.unknown_archive",
        f"这个文件的 SHA256（{digest}）不在已知清单里，拒绝导入",
        path=str(archive),
        sha256=digest,
    )


def status() -> dict[str, object]:
    """当前各组件的就绪情况，供启动页轮询。

    **`artifacts` 是"知情下载"的数据面**：下载前要把从哪儿下、多大、SHA256 是多少
    摆给用户看（§2.6 把"获取"定义为显式动作）。这毕竟是第三方构建的二进制，
    把信任点藏在代码里、界面上只显示一条进度条，等于要用户闭着眼睛信任我们。
    清单本来就写死在代码里，如实报出来不增加任何风险。
    """
    return {
        "platform": _platform_key(),
        "manual_install": _MANUAL_INSTALL.get(_platform_key(), ""),
        "components": [
            {
                "key": c.key,
                "ready": ffmpeg_ready() if c.key == "ffmpeg" else False,
                "available": bool(c.artifacts),
                "bytes": sum(a.size for a in c.artifacts),
                "artifacts": [
                    {"key": a.key, "url": a.url, "bytes": a.size, "sha256": a.sha256}
                    for a in c.artifacts
                ],
            }
            for c in components()
        ],
    }


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def _human(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m kvm.bootstrap", description="自动获取外部依赖")
    p.add_argument("--fetch", metavar="COMPONENT", help="下载并安装（当前支持：ffmpeg）")
    p.add_argument("--import-from", metavar="ARCHIVE", help="离线导入一个已下好的归档")
    p.add_argument("--json", action="store_true", help="以 JSON 输出状态")
    args = p.parse_args(argv)

    try:
        if args.import_from:
            key = import_offline(Path(args.import_from).expanduser())
            print(f"已导入：{key}")
            return 0
        if args.fetch:
            # 下载前先报出源与校验和：命令行这一侧同样适用"知情下载"，
            # 用户看到的不该只是一条百分比。
            for comp in components():
                if comp.key == args.fetch:
                    for art in comp.artifacts:
                        print(f"  {art.url}")
                        print(f"    {_human(art.size)}  sha256 {art.sha256}")
            last = [""]

            def show(pr: Progress) -> None:
                if pr.stage == "downloading" and pr.total:
                    pct = pr.downloaded * 100 // pr.total
                    line = f"  {pr.component} {pct:3d}%  {_human(pr.downloaded)}/{_human(pr.total)}"
                else:
                    line = f"  {pr.component} {pr.stage} {pr.detail}".rstrip()
                if line != last[0]:
                    print(line, end="\r" if pr.stage == "downloading" else "\n", flush=True)
                    last[0] = line

            fetch_component(args.fetch, show)
            print(f"\n{args.fetch} 已就绪：{paths.private_bin_dir()}")
            return 0
    except BootstrapError as exc:
        print(f"\n失败（{exc.code}）：{exc}", file=sys.stderr)
        return 1

    st = status()
    if args.json:
        print(json.dumps(st, ensure_ascii=False, indent=2))
        return 0
    print(f"平台：{st['platform']}")
    for c in st["components"]:  # type: ignore[union-attr]
        mark = (
            "已就绪" if c["ready"] else ("可自动获取" if c["available"] else "本平台不支持自动获取")
        )
        print(f"  {c['key']}: {mark}（{_human(int(c['bytes']))}）")
        for a in c["artifacts"]:  # type: ignore[index]
            print(f"    {a['url']}")
            print(f"      {_human(int(a['bytes']))}  sha256 {a['sha256']}")
    if st["manual_install"]:
        print(f"手工安装（装入系统，需自行卸载）：\n  {st['manual_install']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
