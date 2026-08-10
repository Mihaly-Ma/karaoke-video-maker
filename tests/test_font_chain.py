"""字体链的数据层：老工程兼容、归一化规则、以及样式接口的两个入口。

## 为什么这组测试必须存在

字体从单个族名（`font_name: str`）改成有序候选链（`font_names: list[str]`），
**磁盘上已经躺着的工程 JSON 里只有旧键**。工程是用户资产，读不出来不会报错——
只会静默退回默认字体，用户看到的是"打开工程后字体莫名其妙变了"，
而这类事发生在几个月后升级时，现场早就对不上了。

第二类风险是**同一条规则两份实现**：领域层（`KaraokeStyle`）与传输层（`StyleDTO`）
都要把链整理成规范形态，各写一份的话，同一份工程经不同路径读出来会不一样。
所以规则只有 `normalize_font_chain` 一处，这里连带钉死"两条路径结论相同"。

第三类是样式接口的两个入口：老前端与诊断脚本发的是 `font_name`（只想换主字体），
新界面发的是 `font_names`（整条链）。把前者当成"链只剩一个字体"，
会静默清掉用户配好的兜底字体。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402

pytest.importorskip("fastapi", reason="需要 fastapi（uv sync --extra api）")

from kvm.api.schemas import ProjectDTO, StyleDTO  # noqa: E402
from kvm.api.store import ProjectStore  # noqa: E402
from kvm.models.karaoke import (  # noqa: E402
    DEFAULT_FONT_CHAIN,
    KaraokeStyle,
    normalize_font_chain,
)

LEGACY_FONT = "Hiragino Mincho ProN"


# ---- 老工程兼容 ----


def test_legacy_style_dto_upgrades_font_name_to_a_chain() -> None:
    """老工程 JSON 里只有 `font_name`，读出来必须是一条单元素链。"""
    style = StyleDTO(**{"font_name": LEGACY_FONT, "font_size": 96})
    assert style.font_names == [LEGACY_FONT]
    assert style.font_name == LEGACY_FONT
    assert style.font_size == 96


def test_legacy_project_json_on_disk_still_opens(tmp_path: Path) -> None:
    """真正的回归场景：磁盘上一份旧版工程文件，原样读进来。

    这条不能用构造函数代替——`ProjectStore` 是从 JSON 反序列化的，
    而"打不开旧工程"正是发生在这条路径上。
    """
    root = tmp_path / "projects"
    root.mkdir(parents=True)
    legacy = {
        "id": "legacy0001",
        "title": "旧工程",
        "artist": "テスト",
        "style": {"font_name": LEGACY_FONT, "font_size": 72, "bold": True},
        "lines": [],
    }
    (root / "legacy0001.kvm.json").write_text(json.dumps(legacy), encoding="utf-8")

    project = ProjectStore(root=root).get("legacy0001")
    assert project.style.font_names == [LEGACY_FONT]
    assert project.style.font_name == LEGACY_FONT
    assert project.style.font_size == 72


def test_legacy_domain_style_accepts_font_name_keyword() -> None:
    """领域层同样要认老键——`project_dto_to_domain` 是 `**model_dump()` 展开的，
    而 DTO 为兼容一直镜像着 `font_name`。
    """
    assert KaraokeStyle(font_name=LEGACY_FONT).font_names == [LEGACY_FONT]
    assert KaraokeStyle(font_name=LEGACY_FONT).primary_font == LEGACY_FONT


# ---- 归一化规则只有一份 ----


@pytest.mark.parametrize(
    ("names", "legacy", "expected"),
    [
        ([], None, list(DEFAULT_FONT_CHAIN)),
        ([], "X", ["X"]),
        (["A", "B"], None, ["A", "B"]),
        # 链非空时它说了算：两者同时出现是常态，规则含糊会让"打开工程少一个字体"
        # 随时序偶然发生一次，而且极难复现
        (["A", "B"], "Z", ["A", "B"]),
        (["A", "A", "B"], None, ["A", "B"]),
        (["  A  ", "", "  "], None, ["A"]),
    ],
)
def test_normalize_rules(names: list[str], legacy: str | None, expected: list[str]) -> None:
    assert normalize_font_chain(names, legacy) == expected


def test_domain_and_dto_agree(tmp_path: Path) -> None:
    """同一份输入经两条路径读出来必须一样，否则规则事实上有两份。"""
    for names, legacy in (([], None), ([], "X"), (["A", "A", "B"], "Z"), (["", " "], "Y")):
        payload = {"font_names": names, "font_name": legacy} if legacy else {"font_names": names}
        assert StyleDTO(**payload).font_names == KaraokeStyle(**payload).font_names


def test_chain_is_never_empty() -> None:
    """空链等于没有字体：libass 会退到自带的 Liberation Sans，
    日文整片渲成豆腐块，而且不报错。
    """
    assert StyleDTO(font_names=[]).font_names == list(DEFAULT_FONT_CHAIN)
    assert KaraokeStyle(font_names=[]).font_names == list(DEFAULT_FONT_CHAIN)
    assert StyleDTO(font_names=["", "   "]).font_names == list(DEFAULT_FONT_CHAIN)


def test_font_name_is_derived_not_stored() -> None:
    """`font_name` 是派生量。存两份迟早漏同步一次，
    而漏掉的那次表现为"改了字体但某个面板没跟着变"。
    """
    style = StyleDTO(font_names=["A", "B"])
    style.font_names = ["C", "B"]
    assert style.font_name == "C"
    assert style.model_dump()["font_name"] == "C"


# ---- 样式接口的两个入口 ----


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from kvm.api.routes import projects as projects_routes

    app = FastAPI()
    app.include_router(projects_routes.router)
    return app, TestClient(app)


def test_style_patch_font_name_replaces_only_the_head(tmp_path: Path) -> None:
    """只发 `font_name` 时**只换链首、保留链尾**。

    老前端与诊断脚本发的都是这个键。把它当成"链只剩一个字体"，
    用户配好的兜底字体就在他每次点一下字体预置时被静默清掉。
    """
    app, client = _client()
    app.state.store = ProjectStore(root=tmp_path / "projects")

    pid = client.post("/api/projects/", json={"title": "t"}).json()["id"]
    client.post(f"/api/projects/{pid}/style", json={"font_names": ["A", "B"]})

    body = client.post(f"/api/projects/{pid}/style", json={"font_name": "C"}).json()
    assert body["style"]["font_names"] == ["C", "A", "B"]

    # 换成链里已有的字体时只是把它提到链首，不该冒出重复项
    body = client.post(f"/api/projects/{pid}/style", json={"font_name": "B"}).json()
    assert body["style"]["font_names"] == ["B", "C", "A"]


def test_style_patch_font_names_replaces_the_whole_chain(tmp_path: Path) -> None:
    app, client = _client()
    app.state.store = ProjectStore(root=tmp_path / "projects")

    pid = client.post("/api/projects/", json={"title": "t"}).json()["id"]
    client.post(f"/api/projects/{pid}/style", json={"font_names": ["A", "B", "C"]})
    body = client.post(f"/api/projects/{pid}/style", json={"font_names": ["D"]}).json()
    assert body["style"]["font_names"] == ["D"]
    assert body["style"]["font_name"] == "D"


def test_style_patch_normalizes_before_persisting(tmp_path: Path) -> None:
    """直接 `setattr` 会绕过 DTO 校验器（pydantic 默认不校验赋值），
    空链与重复项就这么进了工程文件。路由必须自己归一化。
    """
    app, client = _client()
    app.state.store = ProjectStore(root=tmp_path / "projects")

    pid = client.post("/api/projects/", json={"title": "t"}).json()["id"]
    body = client.post(
        f"/api/projects/{pid}/style", json={"font_names": ["A", "A", " ", "B"]}
    ).json()
    assert body["style"]["font_names"] == ["A", "B"]

    body = client.post(f"/api/projects/{pid}/style", json={"font_names": []}).json()
    assert body["style"]["font_names"] == list(DEFAULT_FONT_CHAIN)


def test_style_patch_leaves_other_fields_alone(tmp_path: Path) -> None:
    """局部更新的既有语义不能被字体这两个键破坏。"""
    app, client = _client()
    app.state.store = ProjectStore(root=tmp_path / "projects")

    pid = client.post("/api/projects/", json={"title": "t"}).json()["id"]
    client.post(f"/api/projects/{pid}/style", json={"font_size": 120, "bold": True})
    body = client.post(f"/api/projects/{pid}/style", json={"font_names": ["A"]}).json()
    assert body["style"]["font_size"] == 120
    assert body["style"]["bold"] is True


def test_project_dto_round_trip_keeps_the_chain() -> None:
    """DTO → JSON → DTO 不许把链压回单个字体。"""
    dto = ProjectDTO(id="x", style=StyleDTO(font_names=["A", "B"]))
    again = ProjectDTO(**json.loads(dto.model_dump_json()))
    assert again.style.font_names == ["A", "B"]
