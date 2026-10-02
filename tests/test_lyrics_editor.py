"""批量改字、增删行与 Credit 设置的保存及撤销回归。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest
from fastapi.testclient import TestClient
from kvm.api.app import app
from kvm.api.schemas import LineDTO, RubySpanDTO, TokenDTO
from kvm.api.store import ProjectStore


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(app.state, "store", ProjectStore(tmp_path), raising=False)
    return TestClient(app)


def test_batch_edit_preserves_retained_line_and_undo_restores_deleted_line(
    client: TestClient,
) -> None:
    store = app.state.store
    p = store.create("测试", "测试歌手")
    lines = [
        LineDTO(
            id="kept",
            tokens=[
                TokenDTO(
                    text="春",
                    start_ms=1000,
                    dur_ms=500,
                    tid="spring",
                    timing_source="manual",
                    locked_timing=True,
                )
            ],
            ruby=[RubySpanDTO(start=0, end=1, text="はる", source="manual", locked=True)],
        ),
        LineDTO(id="deleted", tokens=[TokenDTO(text="夏", start_ms=3000, dur_ms=500)]),
    ]
    store.mutate(p.id, lambda draft: setattr(draft, "lines", lines))
    original = store.get(p.id).lines[0].model_dump()
    before = store.history_depth(p.id)[0]
    response = client.post(
        "/api/editor/lyrics",
        json={
            "project_id": p.id,
            "rows": [
                {"line_id": None, "text": "新行"},
                {"line_id": "kept", "text": "春"},
                {"line_id": None, "text": "新行"},
            ],
        },
    )
    assert response.status_code == 200
    saved = response.json()["lines"]
    assert saved[1] == original
    assert saved[0]["tokens"][0]["timing_source"] == "unset"
    assert saved[0]["tokens"][0]["dur_ms"] == 0
    assert saved[0]["tokens"][0]["tid"] != saved[2]["tokens"][0]["tid"]
    assert store.history_depth(p.id)[0] == before + 1
    assert ProjectStore(store._root).get(p.id).lines[1].model_dump() == original
    restored = client.post(f"/api/projects/{p.id}/undo").json()
    assert [line["id"] for line in restored["lines"]] == ["kept", "deleted"]
    assert client.post(f"/api/projects/{p.id}/redo").json()["lines"] == saved


def test_invalid_batch_is_atomic_and_delete_all_is_undoable(client: TestClient) -> None:
    store = app.state.store
    p = store.create()
    store.mutate(
        p.id,
        lambda draft: setattr(
            draft,
            "lines",
            [LineDTO(id="line", tokens=[TokenDTO(text="春", start_ms=1000, dur_ms=500)])],
        ),
    )
    before = store.get(p.id).model_dump()
    depth = store.history_depth(p.id)
    response = client.post(
        "/api/editor/lyrics",
        json={
            "project_id": p.id,
            "rows": [{"line_id": "line", "text": "夏"}, {"line_id": None, "text": "\n"}],
        },
    )
    assert response.status_code == 400
    assert store.get(p.id).model_dump() == before
    assert store.history_depth(p.id) == depth
    assert (
        client.post("/api/editor/lyrics", json={"project_id": p.id, "rows": []}).json()["lines"]
        == []
    )
    assert client.post(f"/api/projects/{p.id}/undo").json()["lines"] == before["lines"]


def test_credit_settings_persist_reset_and_undo(client: TestClient) -> None:
    p = app.state.store.create("曲名", "歌手")
    endpoint = f"/api/projects/{p.id}/style"
    changed = client.post(
        endpoint, json={"credits_enabled": False, "credits_text": "标题\n制作：甲"}
    )
    assert changed.status_code == 200
    assert changed.json()["style"]["credits_enabled"] is False
    assert client.get(f"/api/projects/{p.id}").json()["style"]["credits_text"] == "标题\n制作：甲"
    assert (
        client.post(endpoint, json={"credits_text": None}).json()["style"]["credits_text"] is None
    )
    assert (
        client.post(f"/api/projects/{p.id}/undo").json()["style"]["credits_text"]
        == "标题\n制作：甲"
    )


def test_unchanged_lyrics_do_not_add_an_undo_step(client: TestClient) -> None:
    store = app.state.store
    p = store.create()
    store.mutate(
        p.id,
        lambda draft: setattr(
            draft,
            "lines",
            [LineDTO(id="line", tokens=[TokenDTO(text="春", start_ms=1000, dur_ms=500)])],
        ),
    )
    depth = store.history_depth(p.id)
    response = client.post(
        "/api/editor/lyrics",
        json={"project_id": p.id, "rows": [{"line_id": "line", "text": " 春 "}]},
    )
    assert response.status_code == 200
    assert store.history_depth(p.id) == depth


def test_import_separates_credits_and_lyric_edits_do_not_change_them(client: TestClient) -> None:
    p = app.state.store.create("测试", "歌手")
    qrc = "[kana:1111はな]\n[0,500]词：甲乙(0,500)\n[8000,1000]花(8000,1000)"
    response = client.post(
        "/api/lyrics/import",
        json={
            "project_id": p.id,
            "kind": "qrc",
            "content": qrc,
        },
    )
    assert response.status_code == 200
    imported = response.json()
    assert ["".join(t["text"] for t in line["tokens"]) for line in imported["lines"]] == ["花"]
    assert len(imported["credits"]) == 1
    assert imported["lines"][0]["ruby"][0]["text"] == "はな"
    line_id = imported["lines"][0]["id"]
    edited = client.post(
        "/api/editor/lyrics",
        json={
            "project_id": p.id,
            "rows": [{"line_id": line_id, "text": "花よ"}],
        },
    ).json()
    assert edited["credits"] == imported["credits"]
    assert client.post(f"/api/projects/{p.id}/undo").json()["lines"] == imported["lines"]
    plain = client.post(
        "/api/lyrics/import",
        json={
            "project_id": p.id,
            "kind": "text",
            "content": "新しい歌詞",
            "replace": True,
        },
    ).json()
    assert plain["credits"] == imported["credits"]
    assert client.post(f"/api/projects/{p.id}/undo").json()["credits"] == imported["credits"]
    assert client.post(f"/api/projects/{p.id}/undo").json()["credits"] == []


def test_legacy_project_separates_credits_without_losing_records(tmp_path: Path) -> None:
    from kvm.api.schemas import ProjectDTO
    from kvm.lyrics.importer import parse_qrc

    qrc = "[0,500]词：甲(0,500)\n[8000,1000]花(8000,1000)"
    legacy = ProjectDTO(id="legacy").model_dump()
    lines = parse_qrc(qrc)
    legacy["lines"] = [line.model_dump() for line in lines]
    legacy.pop("credits")
    import json

    path = tmp_path / "legacy.kvm.json"
    path.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
    store = ProjectStore(tmp_path)
    loaded = store.get("legacy")
    assert [line.id for line in loaded.lines] == [lines[1].id]
    assert loaded.credits[0].model_dump() == lines[0].model_dump()
    assert ProjectDTO.model_validate_json(loaded.model_dump_json()).credits == loaded.credits
    store.mutate("legacy", lambda draft: setattr(draft.style, "credits_enabled", False))
    reopened = ProjectStore(tmp_path).get("legacy")
    assert reopened.credits == loaded.credits
    assert reopened.lines == loaded.lines


def test_misclassified_credit_can_be_restored_and_undone(client: TestClient) -> None:
    p = app.state.store.create()
    imported = client.post(
        "/api/lyrics/import",
        json={
            "project_id": p.id,
            "kind": "qrc",
            "content": "[0,500]词：甲(0,500)\n[8000,1000]花(8000,1000)",
        },
    ).json()
    credit = imported["credits"][0]
    restored = client.post(
        "/api/editor/metadata",
        json={
            "project_id": p.id,
            "line_id": credit["id"],
            "is_metadata": False,
        },
    )
    assert restored.status_code == 200
    assert restored.json()["credits"] == []
    line = restored.json()["lines"][0]
    assert line["tokens"] == credit["tokens"]
    assert line["ruby"] == credit["ruby"]
    assert line["locked"] is True
    assert line["is_metadata"] is False
    assert client.post(f"/api/projects/{p.id}/undo").json()["credits"] == [credit]
