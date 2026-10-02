import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from kvm.api.routes.editor import router
from kvm.api.routes.render import project_dto_to_domain
from kvm.api.schemas import (
    LineDTO,
    MoraTimeDTO,
    ProjectDTO,
    RubySpanDTO,
    SetMoraTimingItem,
    TokenDTO,
)
from kvm.api.store import ProjectStore
from kvm.editing import ops
from kvm.editing.mora_timing import effective_mora_timings, set_mora_timings


def fixture() -> tuple[ProjectDTO, SetMoraTimingItem]:
    line = LineDTO(
        id="L",
        tokens=[TokenDTO(text="桜", start_ms=1000, dur_ms=800)],
        ruby=[RubySpanDTO(start=0, end=1, text="さくら")],
    )
    item = SetMoraTimingItem(
        line_id="L",
        start=0,
        end=1,
        surface="桜",
        reading="さくら",
        times=[
            MoraTimeDTO(text="さ", start_ms=1000, dur_ms=100),
            MoraTimeDTO(text="く", start_ms=1100, dur_ms=500),
            MoraTimeDTO(text="ら", start_ms=1600, dur_ms=200),
        ],
    )
    return ProjectDTO(id="P", lines=[line]), item


def test_mora_times_survive_save_undo_and_uniform_shift(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    created = store.create("注音打轴")
    project, item = fixture()
    store.mutate(created.id, lambda draft: setattr(draft, "lines", project.lines))
    before = store.get(created.id).model_dump()
    depth = store.history_depth(created.id)[0]
    store.mutate(created.id, lambda draft: set_mora_timings(draft, [item]))
    result = store.get(created.id)
    assert result.lines[0].tokens[0].timing_granularity == "mora"
    assert result.lines[0].tokens[0].locked_timing
    assert [
        t.dur_ms for t in ProjectStore(tmp_path).get(created.id).lines[0].mora_timings[0].times
    ] == [100, 500, 200]
    assert store.history_depth(created.id)[0] == depth + 1
    assert store.undo(created.id).model_dump() == before
    store.redo(created.id)
    store.mutate(
        created.id, lambda draft: ops.shift(draft, scope="line", delta_ms=100, line_id="L")
    )
    effective = effective_mora_timings(store.get(created.id).lines[0])
    assert len(effective) == 1 and effective[0][3] == 100
    assert project_dto_to_domain(store.get(created.id)).lines[0].mora_timings[0].times == [
        (1100, 1200),
        (1200, 1700),
        (1700, 1900),
    ]


def test_changed_reading_or_internal_timing_invalidates_old_moras() -> None:
    project, item = fixture()
    set_mora_timings(project, [item])
    project.lines[0].ruby[0].text = "おう"
    assert not effective_mora_timings(project.lines[0])
    project.lines[0].ruby[0].text = "さくら"
    project.lines[0].tokens[0].dur_ms += 10
    assert not effective_mora_timings(project.lines[0])


def test_mora_validation_is_atomic() -> None:
    project, item = fixture()
    bad = item.model_copy(update={"surface": "梅"})
    before = project.model_dump()
    with pytest.raises(ops.EditError):
        set_mora_timings(project, [item, bad])
    assert project.model_dump() == before
    bad = item.model_copy(deep=True)
    bad.times[1].start_ms = 1000
    with pytest.raises(ops.EditError):
        set_mora_timings(project, [bad])
    assert project.model_dump() == before


def test_mora_api_validation(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(router)
    store = ProjectStore(tmp_path)
    app.state.store = store
    created = store.create("注音接口")
    project, item = fixture()
    store.mutate(created.id, lambda draft: setattr(draft, "lines", project.lines))
    with TestClient(app) as client:
        body = {"project_id": created.id, "items": [item.model_dump()]}
        assert client.post("/api/editor/mora-timings", json=body).status_code == 200
        depth = store.history_depth(created.id)[0]
        body["items"][0]["times"][0]["dur_ms"] = 0
        assert client.post("/api/editor/mora-timings", json=body).status_code == 422
        assert store.history_depth(created.id)[0] == depth


def test_render_body_and_ruby_follow_nonuniform_mora_times() -> None:
    from kvm.render.ass_builder import AssBuilder
    from test_ass_builder import _FakeMetrics

    project, item = fixture()
    set_mora_timings(project, [item])
    domain = project_dto_to_domain(project)
    ass = AssBuilder(domain, _FakeMetrics()).build()
    body = next(line for line in ass.splitlines() if line.startswith("Dialogue: 1,"))
    ruby = next(line for line in ass.splitlines() if line.startswith("Dialogue: 3,"))
    assert body.count("\\t(") == 3
    assert ruby.count("\\t(") == 3
    import re

    assert re.findall(r"\\t\((\d+),(\d+),", body) == re.findall(r"\\t\((\d+),(\d+),", ruby)
    values = [(int(a), int(b)) for a, b in re.findall(r"\\t\((\d+),(\d+),", body)]
    assert [b - a for a, b in values] == [100, 500, 200]
