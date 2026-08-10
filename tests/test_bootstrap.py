"""自动获取外部依赖（`kvm.bootstrap`）的单元测试。

这个模块会**从网上取二进制并装进用户机器**，所以它的失败模式比功能本身更值得测：
校验不过、归档里塞了越界路径、服务器忽略 Range —— 每一条都必须以"拒绝使用 +
明确报错"收场，绝不能出现"下了个半截文件然后当成好的用"。

所有用例都跑在本地起的 stdlib HTTP 服务器上，**不联外网**，CI 上可以照跑。
"""

from __future__ import annotations

import hashlib
import http.server
import socket
import sys
import threading
import zipfile
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from kvm import bootstrap as bs  # noqa: E402

# ---------------------------------------------------------------------------
# 本地服务器
# ---------------------------------------------------------------------------


class _Server:
    """按路径返回预置字节的最小服务器，可切换"支不支持 Range"。"""

    def __init__(self, payload: bytes, *, honor_range: bool = True) -> None:
        self.payload = payload
        self.honor_range = honor_range
        self.requests: list[str | None] = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                pass

            def do_GET(self) -> None:
                rng = self.headers.get("Range")
                outer.requests.append(rng)
                if rng and outer.honor_range:
                    start = int(rng.removeprefix("bytes=").split("-")[0])
                    body = outer.payload[start:]
                    self.send_response(206)
                    self.send_header(
                        "Content-Range",
                        f"bytes {start}-{len(outer.payload) - 1}/{len(outer.payload)}",
                    )
                else:
                    body = outer.payload
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/file.zip"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _artifact(url: str, payload: bytes, *, members: dict[str, str]) -> bs.Artifact:
    return bs.Artifact(
        key="test",
        url=url,
        sha256=hashlib.sha256(payload).hexdigest(),
        size=len(payload),
        members=members,
        executable=True,
    )


# ---------------------------------------------------------------------------
# 清单本身的硬性质
# ---------------------------------------------------------------------------


def test_manifest_pins_https_and_full_sha256() -> None:
    """清单是安全边界：URL 必须是 https，哈希必须是完整的 64 位十六进制。

    截断的哈希或 http 链接会让"写死校验和"这条规则形同虚设。
    """
    for arts in bs._FFMPEG.values():
        for art in arts:
            assert art.url.startswith("https://"), art.url
            assert len(art.sha256) == 64, art.url
            assert set(art.sha256) <= set("0123456789abcdef"), art.url
            assert art.size > 0
            assert art.members


def test_status_exposes_source_and_hash_per_file() -> None:
    """知情下载（§2.6）的数据面：状态里必须带 URL / 体积 / SHA256。

    启动页要在开始下载前把这三样摆给用户看。**这条守的是"接口存在"与
    "接口有内容"的差别**——本仓吃过一次亏：端点与前端函数都写好了、注释还
    引用着规约，却没有任何调用点。少了任何一项，面板上就只剩一个空行。
    """
    manifest = {a.key: a for c in bs.components() for a in c.artifacts}
    seen: set[str] = set()
    for comp in bs.status()["components"]:  # type: ignore[union-attr]
        for a in comp["artifacts"]:  # type: ignore[index]
            src = manifest[a["key"]]
            assert a["url"] == src.url
            assert a["sha256"] == src.sha256
            assert a["bytes"] == src.size
            seen.add(a["key"])
    assert seen == set(manifest)


# ---------------------------------------------------------------------------
# 下载：校验失败必须拒绝，且不留半截文件
# ---------------------------------------------------------------------------


def test_hash_mismatch_rejects_and_removes_partial(tmp_path: Path) -> None:
    payload = b"x" * 4096
    srv = _Server(payload)
    try:
        art = bs.Artifact(
            key="test",
            url=srv.url,
            sha256="0" * 64,  # 故意写错
            size=len(payload),
            members={"a": "a"},
        )
        with pytest.raises(bs.BootstrapError) as ei:
            bs.download(art, tmp_path)
        assert ei.value.code == "bootstrap.hash_mismatch"
        # 校验不过的内容必须删掉：留着的话下次会被当成断点续传的起点，
        # 于是永远拼不出正确的文件，而用户只看到反复失败。
        assert not list(tmp_path.glob("*.part"))
        assert not (tmp_path / "file.zip").exists()
    finally:
        srv.close()


def test_error_keeps_message_and_placeholders() -> None:
    """占位符不能存进 `args`——那是 `BaseException` 的内建属性。

    赋 dict 给它会被强制转成元组，**只剩键、值全丢**，同时 `str(exc)` 变成
    `"('url', 'expected', 'actual')"`。实测这条 bug 会让 `/api/bootstrap/status`
    在**有错误时**校验失败返 500，于是启动页轮询不到状态、永远转圈——
    偏偏只在出错时才发作，通过路径上一切正常。
    """
    exc = bs.BootstrapError(
        "bootstrap.hash_mismatch", "SHA256 校验失败", url="u", expected="a", actual="b"
    )
    assert str(exc) == "SHA256 校验失败"
    assert exc.detail_args == {"url": "u", "expected": "a", "actual": "b"}


def test_status_endpoint_survives_an_error() -> None:
    """有错误在身时状态接口仍须是 200 —— 这是启动页唯一的信息来源。"""
    from fastapi.testclient import TestClient
    from kvm.api.app import app
    from kvm.api.routes import bootstrap as route

    route._state.error = bs.BootstrapError(
        "bootstrap.hash_mismatch", "SHA256 校验失败", url="u", expected="a", actual="b"
    )
    try:
        with TestClient(app) as client:
            r = client.get("/api/bootstrap/status")
            assert r.status_code == 200
            err = r.json()["error"]
            assert err["code"] == "bootstrap.hash_mismatch"
            assert err["args"]["expected"] == "a"
            assert err["message"] == "SHA256 校验失败"
    finally:
        route._state.error = None


def test_size_mismatch_rejects(tmp_path: Path) -> None:
    payload = b"y" * 100
    srv = _Server(payload)
    try:
        art = bs.Artifact(
            key="test",
            url=srv.url,
            sha256=hashlib.sha256(payload).hexdigest(),
            size=999999,
            members={"a": "a"},
        )
        with pytest.raises(bs.BootstrapError) as ei:
            bs.download(art, tmp_path)
        assert ei.value.code == "bootstrap.size_mismatch"
    finally:
        srv.close()


def test_resume_uses_range(tmp_path: Path) -> None:
    payload = bytes(range(256)) * 64
    srv = _Server(payload)
    try:
        art = _artifact(srv.url, payload, members={"a": "a"})
        part = tmp_path / "file.zip.part"
        part.write_bytes(payload[:1000])
        got = bs.download(art, tmp_path)
        assert got.read_bytes() == payload
        assert srv.requests == ["bytes=1000-"]
    finally:
        srv.close()


def test_server_ignoring_range_restarts_from_zero(tmp_path: Path) -> None:
    """服务器忽略 Range（返回 200）时必须**覆盖重写**，不能追加。

    追加会得到"旧半截 + 新全量"的文件，哈希永远对不上；而症状是每次重试都
    失败且体积越来越大，非常难查。
    """
    payload = b"z" * 5000
    srv = _Server(payload, honor_range=False)
    try:
        art = _artifact(srv.url, payload, members={"a": "a"})
        (tmp_path / "file.zip.part").write_bytes(b"garbage" * 100)
        got = bs.download(art, tmp_path)
        assert got.read_bytes() == payload
    finally:
        srv.close()


def test_existing_valid_file_is_reused(tmp_path: Path) -> None:
    payload = b"w" * 321
    srv = _Server(payload)
    try:
        art = _artifact(srv.url, payload, members={"a": "a"})
        (tmp_path / "file.zip").write_bytes(payload)
        bs.download(art, tmp_path)
        assert srv.requests == []  # 一次网络请求都不该发
    finally:
        srv.close()


# ---------------------------------------------------------------------------
# 解压：只取指名成员、挡住越界路径
# ---------------------------------------------------------------------------


def test_fetch_component_hash_mismatch_installs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """校验不过时，**私有目录里不能出现任何东西**。

    `download()` 层已经单独测过"拒绝 + 删半截文件"，这条测的是上一层：
    组件级流程绝不能在校验失败后继续走到解压。一旦漏了，用户机器上会多出
    一个来路不明的可执行文件，而解析层第一优先就是去私有目录取 ffmpeg。
    """
    monkeypatch.setenv("KVM_DATA_DIR", str(tmp_path / "projects"))
    payload = _zip_bytes({"ffmpeg": b"not really ffmpeg"})
    srv = _Server(payload)
    try:
        bad = bs.Artifact(
            key="ffmpeg",
            url=srv.url,
            sha256="1" * 64,  # 与实际内容不符
            size=len(payload),
            members={"ffmpeg": "ffmpeg"},
            executable=True,
        )
        monkeypatch.setattr(bs, "_FFMPEG", {bs._platform_key(): (bad,)})
        with pytest.raises(bs.BootstrapError) as ei:
            bs.fetch_component("ffmpeg")
        assert ei.value.code == "bootstrap.hash_mismatch"
        bin_dir = tmp_path / "bin"
        assert not bin_dir.exists() or not list(bin_dir.iterdir())
    finally:
        srv.close()


def test_extract_only_named_members(tmp_path: Path) -> None:
    data = _zip_bytes({"bin/tool": b"#!/bin/sh\n", "junk/other": b"nope"})
    archive = tmp_path / "a.zip"
    archive.write_bytes(data)
    art = _artifact("https://x/a.zip", data, members={"bin/tool": "tool"})
    out = tmp_path / "dest"
    written = bs.extract(art, archive, out)
    assert [p.name for p in written] == ["tool"]
    assert not (out / "junk").exists()
    assert not (out / "other").exists()


@pytest.mark.skipif(
    sys.platform.startswith("win"),
    reason="Windows 没有 POSIX 可执行位，chmod 只认只读标志；那边靠扩展名决定能否执行",
)
def test_extract_sets_executable_bit(tmp_path: Path) -> None:
    data = _zip_bytes({"tool": b"binary"})
    archive = tmp_path / "a.zip"
    archive.write_bytes(data)
    art = _artifact("https://x/a.zip", data, members={"tool": "tool"})
    written = bs.extract(art, archive, tmp_path / "dest")
    assert written[0].stat().st_mode & 0o111, (
        "解出来的可执行文件必须可执行，否则拉起时报 Permission denied"
    )


def test_extract_rejects_zip_slip(tmp_path: Path) -> None:
    data = _zip_bytes({"../escape": b"bad", "tool": b"ok"})
    archive = tmp_path / "a.zip"
    archive.write_bytes(data)
    art = _artifact("https://x/a.zip", data, members={"tool": "tool"})
    with pytest.raises(bs.BootstrapError) as ei:
        bs.extract(art, archive, tmp_path / "dest")
    assert ei.value.code == "bootstrap.unsafe_archive"


def test_extract_missing_member_is_an_error(tmp_path: Path) -> None:
    data = _zip_bytes({"something-else": b"x"})
    archive = tmp_path / "a.zip"
    archive.write_bytes(data)
    art = _artifact("https://x/a.zip", data, members={"bin/tool": "tool"})
    with pytest.raises(bs.BootstrapError) as ei:
        bs.extract(art, archive, tmp_path / "dest")
    assert ei.value.code == "bootstrap.member_missing"


# ---------------------------------------------------------------------------
# 离线导入
# ---------------------------------------------------------------------------


def test_offline_import_rejects_unknown_archive(tmp_path: Path) -> None:
    """离线导入不是绕过校验的后门：哈希不在清单里就拒绝。"""
    f = tmp_path / "mystery.zip"
    f.write_bytes(_zip_bytes({"ffmpeg": b"whatever"}))
    with pytest.raises(bs.BootstrapError) as ei:
        bs.import_offline(f)
    assert ei.value.code == "bootstrap.unknown_archive"


def test_offline_import_missing_file(tmp_path: Path) -> None:
    with pytest.raises(bs.BootstrapError) as ei:
        bs.import_offline(tmp_path / "nope.zip")
    assert ei.value.code == "bootstrap.file_not_found"


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------


def test_status_reports_platform_and_components() -> None:
    st = bs.status()
    assert isinstance(st["platform"], str)
    keys = {c["key"] for c in st["components"]}  # type: ignore[union-attr,index]
    assert "ffmpeg" in keys


# ---------------------------------------------------------------------------
# HTTP 接口
# ---------------------------------------------------------------------------


def test_status_endpoint_shape() -> None:
    """启动页靠这个接口决定"还要不要等"，字段少一个它就会一直转圈。"""
    from fastapi.testclient import TestClient
    from kvm.api.app import app

    with TestClient(app) as client:
        r = client.get("/api/bootstrap/status")
        assert r.status_code == 200
        body = r.json()
        assert {"platform", "components", "running", "install_dir"} <= set(body)
        assert body["running"] is None
        # 知情下载要用的三样必须一路传到 HTTP 层：少一个，面板就少一行。
        assert "manual_install" in body
        for comp in body["components"]:
            for art in comp["artifacts"]:
                assert art["url"].startswith("https://")
                assert len(art["sha256"]) == 64
                assert art["bytes"] > 0


def test_offline_import_endpoint_reports_error_code(tmp_path: Path) -> None:
    """失败必须给**错误码**，不是给前端一句中文散文（§8.8）。"""
    from fastapi.testclient import TestClient
    from kvm.api.app import app

    bogus = tmp_path / "x.zip"
    bogus.write_bytes(_zip_bytes({"ffmpeg": b"nope"}))
    with TestClient(app) as client:
        r = client.post("/api/bootstrap/import", json={"path": str(bogus)})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "bootstrap.unknown_archive"
