"""后台派生产物的写回路径与导出产物登记。

对应 CLAUDE.md §8「后台产物不进撤销栈」：撤销栈是**用户意图**的模型，
不是全部状态变更的日志。这一层的 bug 有个共同的形状——症状与原因隔了几分钟，
现场根本对不上：

- 代理生成完压了一格撤销 → 用户按 Cmd+Z 撤掉的是"代理已就绪"，不是他刚才改的轴；
- 派生写回走"深拷贝 draft → 整体替换" → 分离跑的那几分钟里用户做的编辑凭空消失；
- 撤销回到代理生成之前的快照 → 路径被清空，可文件明明还在磁盘上；
- 工程不记导出产物 → 刷新一次页面，导出步骤退回"未完成"。

这些都不会在跑一遍出片流程时暴露，只在真实编辑节奏下才咬人，因此必须有测试钉死。
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.api.routes.render import (  # noqa: E402
    list_exports,
    project_dto_to_domain,
    record_export,
)
from kvm.api.schemas import (  # noqa: E402
    ExportArtifactDTO,
    LineDTO,
    ProjectDTO,
    TokenDTO,
)
from kvm.api.store import BACKEND_ONLY_FIELDS, ProjectStore  # noqa: E402
from kvm.models.karaoke import ExportArtifact  # noqa: E402

# ---- 夹具 ----


@pytest.fixture
def store(tmp_path: Path) -> ProjectStore:
    """每个用例一个独立的工程根目录，避免共用 `~/.karaoke-video-maker`。"""
    return ProjectStore(root=tmp_path / "projects")


def _line(line_id: str, text: str, start_ms: int) -> LineDTO:
    return LineDTO(id=line_id, tokens=[TokenDTO(text=text, start_ms=start_ms, dur_ms=500)])


def _artifact(path: Path, **overrides: object) -> ExportArtifactDTO:
    base: dict[str, object] = {
        "id": "job0001",
        "path": str(path),
        "created_at": 1_770_000_000.0,
        "size_bytes": 1234,
        "duration_ms": 260_000,
    }
    base.update(overrides)
    return ExportArtifactDTO(**base)  # type: ignore[arg-type]


# ---- 撤销栈：派生写回不占格 ----


def test_派生写回不增加撤销栈深度(store: ProjectStore) -> None:
    """这是本次修复的核心回归：代理/stem 写回后，撤销栈深度必须一格不变。

    此前它走 `store.mutate`，于是"代理已就绪"这条登记与用户的编辑抢同一个撤销栈。
    """
    created = store.create(title="赤春花")
    store.mutate(created.id, lambda d: d.lines.append(_line("L1", "桜", 1000)))
    store.mutate(created.id, lambda d: d.lines.append(_line("L2", "春", 2000)))
    before = store.history_depth(created.id)

    store.update_derived(created.id, lambda d: d.__setattr__("proxy_video_path", "/tmp/proxy.mp4"))
    store.update_derived(created.id, lambda d: d.__setattr__("vocals_path", "/tmp/vocals.wav"))

    assert store.history_depth(created.id) == before
    assert store.get(created.id).proxy_video_path == "/tmp/proxy.mp4"


def test_派生写回不清空重做栈(store: ProjectStore) -> None:
    """撤销之后正好来一次后台写回，用户的"重做"不该因此消失。

    `mutate` 会清空 redo（新分支覆盖旧未来，这是对的），但后台作业压根不是
    用户操作，不构成新分支。
    """
    created = store.create()
    store.mutate(created.id, lambda d: d.lines.append(_line("L1", "桜", 1000)))
    store.undo(created.id)
    assert store.history_depth(created.id) == (0, 1)

    store.update_derived(created.id, lambda d: d.__setattr__("proxy_video_path", "/tmp/p.mp4"))

    assert store.history_depth(created.id) == (0, 1)
    assert store.redo(created.id).lines[0].id == "L1"


def test_派生写回只碰派生字段_不覆盖用户数据(store: ProjectStore) -> None:
    """分离/代理跑几分钟，期间用户一直在编辑。写回不得整体覆盖工程状态。"""
    created = store.create()
    store.mutate(created.id, lambda d: d.lines.append(_line("L1", "桜", 1000)))
    store.mutate(created.id, lambda d: d.style.__setattr__("font_size", 96))

    store.update_derived(created.id, lambda d: d.__setattr__("instrumental_path", "/tmp/inst.wav"))

    project = store.get(created.id)
    assert project.instrumental_path == "/tmp/inst.wav"
    assert [ln.id for ln in project.lines] == ["L1"]
    assert project.style.font_size == 96


def test_派生写回与并发编辑不互相丢失(store: ProjectStore) -> None:
    """真正的并发形态：后台线程写回派生字段，同时请求线程连续编辑同一工程。

    `mutate` 是"深拷贝 draft → 整体替换"，若没有串行化，落在拷贝与替换之间的
    那次派生写回会被整体替换悄悄吃掉——文件已经生成，工程里却查不到路径。
    """
    created = store.create()
    rounds = 200
    done = threading.Event()

    def edit() -> None:
        for i in range(rounds):
            store.mutate(created.id, lambda d, i=i: d.lines.append(_line(f"L{i}", "桜", i * 100)))
        done.set()

    def write_back() -> None:
        n = 0
        while not done.is_set() or n < 20:
            store.update_derived(
                created.id, lambda d, n=n: d.__setattr__("proxy_video_path", f"/tmp/p{n}.mp4")
            )
            n += 1
            if n >= 200:
                break

    editor = threading.Thread(target=edit)
    worker = threading.Thread(target=write_back)
    editor.start()
    worker.start()
    editor.join()
    worker.join()

    project = store.get(created.id)
    assert project.proxy_video_path is not None, "派生写回被并发的 mutate 整体覆盖吞掉了"
    assert len(project.lines) == rounds
    assert store.history_depth(created.id)[0] == rounds


def test_派生写回会原子落盘(store: ProjectStore, tmp_path: Path) -> None:
    """崩溃恢复的前提：写回必须真的进磁盘，而不是只改内存缓存。"""
    created = store.create()
    store.update_derived(created.id, lambda d: d.__setattr__("proxy_video_path", "/tmp/p.mp4"))

    reopened = ProjectStore(root=tmp_path / "projects")
    assert reopened.get(created.id).proxy_video_path == "/tmp/p.mp4"


def test_派生写回到不存在的工程报_KeyError(store: ProjectStore) -> None:
    """作业跑到一半工程被删掉是真实场景，调用方要能识别并降级，不能静默成功。"""
    with pytest.raises(KeyError):
        store.update_derived("nope", lambda d: d.__setattr__("proxy_video_path", "/tmp/p.mp4"))


# ---- 撤销回卷不得清空后台产物 ----


def test_撤销不清空代理路径(store: ProjectStore) -> None:
    """用户改完轴、代理刚好生成完，此时 Cmd+Z：撤掉的必须是那次编辑，
    而代理路径要留着——文件还在磁盘上，工程不该"忘了它在哪"。
    """
    created = store.create()
    store.mutate(created.id, lambda d: d.lines.append(_line("L1", "桜", 1000)))
    store.update_derived(created.id, lambda d: d.__setattr__("proxy_video_path", "/tmp/p.mp4"))

    after_undo = store.undo(created.id)

    assert after_undo.lines == []
    assert after_undo.proxy_video_path == "/tmp/p.mp4"
    assert store.redo(created.id).proxy_video_path == "/tmp/p.mp4"


def test_撤销不清空导出记录(store: ProjectStore, tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"x")
    created = store.create()
    record_export(store, created.id, _artifact(out))
    store.mutate(created.id, lambda d: d.lines.append(_line("L1", "桜", 1000)))

    after_undo = store.undo(created.id)

    assert after_undo.lines == []
    assert [item.path for item in after_undo.exports] == [str(out)]


def test_stem_路径仍然可撤销(store: ProjectStore) -> None:
    """stem 路径**不在** `BACKEND_ONLY_FIELDS` 里，这是有意的。

    用户也能通过 `POST /api/media/import` 手工指定一份人声轨，那种情况下它是
    用户意图，必须留在历史里能撤销。判据是"用户能不能主动设它"，
    不是"是不是自动产生的"。
    """
    assert "vocals_path" not in BACKEND_ONLY_FIELDS
    # 名单钉死：往里加字段等于宣布"用户永远设不了它"，那是个需要论证的决定，
    # 不该顺手改。引导声那一组正好摆出了判据的两侧——产物路径与指纹在名单里
    # （用户设不了），而参数 `guide` 不在（用户拖滑块就是在设它）。
    assert set(BACKEND_ONLY_FIELDS) == {
        "proxy_video_path",
        "exports",
        "guide_audio_path",
        "guide_signature",
    }
    assert "guide" not in BACKEND_ONLY_FIELDS

    created = store.create()
    store.mutate(created.id, lambda d: d.__setattr__("vocals_path", "/tmp/manual_vocals.wav"))

    assert store.undo(created.id).vocals_path is None


# ---- 导出产物 ----


def test_老工程缺_exports_字段可正常读取(store: ProjectStore, tmp_path: Path) -> None:
    """向后兼容：本字段之前的工程 JSON 里没有 `exports`，必须照常打开。"""
    root = tmp_path / "projects"
    root.mkdir(parents=True, exist_ok=True)
    (root / "old12345678.kvm.json").write_text(
        '{"id": "old12345678", "title": "旧工程", "lines": []}', encoding="utf-8"
    )

    project = store.get("old12345678")

    assert project.title == "旧工程"
    assert project.exports == []


def test_导出登记不占撤销格(store: ProjectStore, tmp_path: Path) -> None:
    out = tmp_path / "out.mp4"
    out.write_bytes(b"x" * 10)
    created = store.create()
    store.mutate(created.id, lambda d: d.lines.append(_line("L1", "桜", 1000)))
    before = store.history_depth(created.id)

    record_export(store, created.id, _artifact(out))

    assert store.history_depth(created.id) == before
    assert store.get(created.id).exports[0].size_bytes == 1234


def test_同一路径重复导出只留一条记录(store: ProjectStore, tmp_path: Path) -> None:
    """否则列表里会出现两条指向同一份成片、只有一条说得对的记录。"""
    out = tmp_path / "out.mp4"
    out.write_bytes(b"x")
    created = store.create()
    record_export(store, created.id, _artifact(out, id="job0001", size_bytes=1))
    record_export(store, created.id, _artifact(out, id="job0002", size_bytes=2))

    exports = store.get(created.id).exports
    assert [item.id for item in exports] == ["job0002"]
    assert exports[0].size_bytes == 2


def test_列出导出产物_最新在前(store: ProjectStore, tmp_path: Path) -> None:
    first = tmp_path / "a.mp4"
    second = tmp_path / "b.mp4"
    first.write_bytes(b"a")
    second.write_bytes(b"b")
    created = store.create()
    record_export(store, created.id, _artifact(first, id="job0001"))
    record_export(store, created.id, _artifact(second, id="job0002"))

    assert [item.id for item in list_exports(store, created.id)] == ["job0002", "job0001"]


def test_文件被删的产物不出现在列表里并被剔除(store: ProjectStore, tmp_path: Path) -> None:
    """用户随手把成片删了/挪走了，界面不该还留着一个点开必然报错的入口。"""
    kept = tmp_path / "kept.mp4"
    gone = tmp_path / "gone.mp4"
    kept.write_bytes(b"a")
    gone.write_bytes(b"b")
    created = store.create()
    record_export(store, created.id, _artifact(kept, id="job0001"))
    record_export(store, created.id, _artifact(gone, id="job0002"))
    gone.unlink()

    listed = list_exports(store, created.id)

    assert [item.id for item in listed] == ["job0001"]
    # 剔除要落进工程，否则每次查询都要重新 stat 一遍已经不存在的文件
    assert [item.id for item in store.get(created.id).exports] == ["job0001"]


def test_剔除失效产物同样不占撤销格(store: ProjectStore, tmp_path: Path) -> None:
    gone = tmp_path / "gone.mp4"
    gone.write_bytes(b"b")
    created = store.create()
    record_export(store, created.id, _artifact(gone))
    store.mutate(created.id, lambda d: d.lines.append(_line("L1", "桜", 1000)))
    before = store.history_depth(created.id)
    gone.unlink()

    list_exports(store, created.id)

    assert store.history_depth(created.id) == before


@pytest.mark.parametrize(
    ("use_instrumental", "with_guide", "is_excerpt", "expected"),
    [
        (False, False, False, "ON VOCAL"),
        (True, False, False, "OFF VOCAL"),
        (True, True, False, "OFF VOCAL + 引导声"),
        (False, True, True, "ON VOCAL + 引导声 + 片段"),
    ],
)
def test_变体名由布尔位派生(
    tmp_path: Path,
    use_instrumental: bool,
    with_guide: bool,
    is_excerpt: bool,
    expected: str,
) -> None:
    """三个正交布尔位是真源，文案是派生量——存文案会与布尔位漂移。"""
    artifact = _artifact(
        tmp_path / "x.mp4",
        use_instrumental=use_instrumental,
        with_guide=with_guide,
        is_excerpt=is_excerpt,
    )

    assert artifact.variant_label == expected
    # 计算字段必须出现在序列化结果里，否则前端拿不到（OpenAPI 也不会声明它）
    assert artifact.model_dump()["variant_label"] == expected


def test_导出记录能被工程序列化并读回(store: ProjectStore, tmp_path: Path) -> None:
    """记录要真的落进 project.json——它存在的全部意义就是"刷新页面还在"。"""
    out = tmp_path / "out.mp4"
    out.write_bytes(b"x")
    created = store.create()
    record_export(store, created.id, _artifact(out, use_instrumental=True, with_guide=True))

    reopened = ProjectStore(root=tmp_path / "projects").get(created.id)

    assert len(reopened.exports) == 1
    assert reopened.exports[0].variant_label == "OFF VOCAL + 引导声"
    assert reopened.exports[0].duration_ms == 260_000


def test_导出记录能转进领域模型(tmp_path: Path) -> None:
    """`variant_label` 出现在 `model_dump()` 里，而领域层是 dataclass——
    直接 `**dump` 展开会因多出这个关键字参数而 TypeError。

    转换那一处已经 `exclude` 掉它，这里钉住行为免得回归（症状是**导出之后**
    整个预览接口 500，与导出功能本身看起来毫无关系）。
    """
    dumped = _artifact(tmp_path / "x.mp4").model_dump()
    with pytest.raises(TypeError, match="variant_label"):
        ExportArtifact(**dumped)

    dto = ProjectDTO(id="p", exports=[_artifact(tmp_path / "x.mp4", use_instrumental=True)])

    domain = project_dto_to_domain(dto)

    assert len(domain.exports) == 1
    assert domain.exports[0].use_instrumental is True


def test_ProjectDTO_默认没有导出记录() -> None:
    assert ProjectDTO(id="x").exports == []
