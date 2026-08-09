"""工程存储：持久化、撤销/重做、崩溃恢复。

CLAUDE.md §2.5 把这一层定为**第一优先级**：用户手工调 40 分钟的轴，
进程崩了就全没——在"高度自动化"的定位下只是遗憾，在"一站式"的定位下是致命伤。

## 为什么用快照而不是命令模式

工程 JSON 只有几十 KB，一次快照的成本远低于为每种编辑操作实现
do/undo 配对的复杂度与出错风险。命令模式真正的价值在于内存受限或需要
操作合并的场景，本项目两者都不成立。

## 自动保存

每次变更后写盘，但走"临时文件 + 原子 rename"：直接覆盖写在崩溃时
会留下半截文件，而半截的工程文件比没有文件更糟——用户会以为还在。

## 两条写入路径

`mutate()` 记录用户意图，进撤销栈；`update_derived()` 登记后台作业的派生产物，
不进撤销栈。判据是 CLAUDE.md §8 那一句：**这次变更是用户主动做的吗？**
"""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from kvm import paths
from kvm.api.schemas import ProjectDTO, ProjectSummary

_MAX_HISTORY = 200

BACKEND_ONLY_FIELDS: frozenset[str] = frozenset({"proxy_video_path", "exports"})
"""只有后台作业写得了、用户永远无法直接设定的字段，**整体排除在历史快照之外**。

撤销回到更早的快照时，这些字段保持当前值不被回卷。理由见 CLAUDE.md §8
「后台产物不进撤销栈」举的那个更糟的场景：代理生成完之后按 Cmd+Z，撤销栈里
那份更早的快照中 `proxy_video_path` 还是空的，照搬回去就把路径清了，
可代理文件明明还躺在磁盘上——界面显示"未生成"，而用户什么也没删。

**判据是"用户能不能主动设它"，不是"是不是自动产生的"。** `vocals_path` 等
stem 路径虽然通常由分离作业写入，但用户也能通过 `POST /api/media/import`
手工指定一份，那种情况下它确实是用户意图，必须留在历史里可撤销——所以它们
不在这个集合里，只是分离作业写回时改走 `update_derived()` 不占撤销格而已。
"""


def default_root() -> Path:
    """工程存放目录。

    实现在 `kvm.paths`——应用私有目录的规则只允许有一份（见该模块的模块文档）。
    这里保留函数是为了不改动既有调用点。
    """
    return paths.projects_dir()


@dataclass
class _Entry:
    project: ProjectDTO
    undo: list[str] = field(default_factory=list)
    redo: list[str] = field(default_factory=list)
    dirty: bool = False


class ProjectStore:
    """内存中的工程集合，带历史与落盘。"""

    def __init__(self, root: Path | None = None) -> None:
        self._root = root or default_root()
        self._root.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, _Entry] = {}
        self._lock = threading.RLock()
        """串行化所有会改到工程的操作。

        后台作业（分离、代理、烧录）跑在自己的工作线程里，完成时会调
        `update_derived()` 写回派生字段，而用户此刻很可能正在另一个请求线程里
        编辑同一个工程。`mutate()` 是"深拷贝 draft → 整体替换"，若在拷贝与
        替换之间插进一次派生写回，那次写回会被整体替换悄悄吃掉——文件已经生成，
        工程里却查不到路径。可重入锁把每次事务变成不可分割的一步。
        """

    # ---- 生命周期 ----

    def create(self, title: str = "", artist: str = "") -> ProjectDTO:
        pid = uuid.uuid4().hex[:12]
        proj = ProjectDTO(id=pid, title=title, artist=artist)
        with self._lock:
            self._cache[pid] = _Entry(project=proj)
            self._persist(pid)
        return proj

    def get(self, project_id: str) -> ProjectDTO:
        with self._lock:
            entry = self._cache.get(project_id)
            if entry is not None:
                return entry.project
            path = self._path(project_id)
            if not path.exists():
                msg = f"工程不存在：{project_id}"
                raise KeyError(msg)
            proj = ProjectDTO.model_validate_json(path.read_text(encoding="utf-8"))
            self._cache[project_id] = _Entry(project=proj)
            return proj

    def list_all(self) -> list[ProjectSummary]:
        out: list[ProjectSummary] = []
        for p in sorted(self._root.glob("*.kvm.json")):
            try:
                proj = ProjectDTO.model_validate_json(p.read_text(encoding="utf-8"))
            except Exception:
                # 损坏的工程文件不应让整个列表打不开
                continue
            out.append(
                ProjectSummary(
                    id=proj.id,
                    title=proj.title,
                    artist=proj.artist,
                    updated_at=p.stat().st_mtime,
                    duration_ms=proj.duration_ms,
                    line_count=len(proj.lines),
                )
            )
        out.sort(key=lambda s: s.updated_at, reverse=True)
        return out

    def delete(self, project_id: str) -> None:
        with self._lock:
            self._cache.pop(project_id, None)
            self._path(project_id).unlink(missing_ok=True)

    # ---- 变更与历史 ----

    def mutate(self, project_id: str, mutator, *, label: str = "") -> ProjectDTO:
        """在一次事务里修改工程，自动压入撤销栈。

        **这是"用户主动做的变更"专用的入口。** 后台作业产出的派生物走
        `update_derived()`（CLAUDE.md §8：撤销栈是用户意图的模型，
        不是全部状态变更的日志）。

        `mutator` 接收工程副本并就地修改；抛异常时**不产生历史记录、不落盘**，
        避免把失败的半成品变更留在栈里。
        """
        with self._lock:
            entry = self._entry(project_id)
            before = entry.project.model_dump_json()

            draft = entry.project.model_copy(deep=True)
            mutator(draft)

            entry.undo.append(before)
            if len(entry.undo) > _MAX_HISTORY:
                entry.undo.pop(0)
            entry.redo.clear()
            entry.project = draft
            entry.dirty = True
            self._persist(project_id)
            return draft

    def update_derived(
        self, project_id: str, mutator: Callable[[ProjectDTO], None], *, label: str = ""
    ) -> ProjectDTO:
        """写入后台作业产出的派生字段：照常原子落盘，但**不占撤销格**。

        用于代理视频路径、分离出的 stem 路径、导出产物登记这类东西。它们不是
        用户的编辑意图，压进撤销栈只会造成 CLAUDE.md §8 描述的那个场景：用户改完
        一处时间轴、后台代理刚好生成完，按 Cmd+Z 撤掉的却是"代理已就绪"这条登记。

        与 `mutate()` 的第二个区别是**就地改而不是整体替换**：后台作业跑几分钟，
        期间用户很可能一直在编辑同一个工程，`mutate()` 那套"深拷贝 draft →
        整体替换"会把拷贝之后发生的用户编辑一起吞掉。这里只让 mutator 碰它自己
        那几个派生字段，行/token/注音等用户数据一个字节都不动。

        因此对 `mutator` 有一条**调用方必须遵守的约束**：只能设置派生字段，
        不得改动用户数据。CLAUDE.md §8 要求的 `locked` 感知三方合并（自动重算
        结果与用户当前状态的合并）不在本方法的职责内——需要合并的作业（重跑
        对齐、重新注音）应当先算出合并结果，再通过 `mutate()` 作为一个撤销单元
        落下，而不是从这里绕过历史。
        """
        with self._lock:
            entry = self._entry(project_id)
            mutator(entry.project)
            entry.dirty = True
            self._persist(project_id)
            return entry.project

    def undo(self, project_id: str) -> ProjectDTO:
        with self._lock:
            entry = self._entry(project_id)
            if not entry.undo:
                return entry.project
            entry.redo.append(entry.project.model_dump_json())
            entry.project = self._restore(entry, entry.undo.pop())
            self._persist(project_id)
            return entry.project

    def redo(self, project_id: str) -> ProjectDTO:
        with self._lock:
            entry = self._entry(project_id)
            if not entry.redo:
                return entry.project
            entry.undo.append(entry.project.model_dump_json())
            entry.project = self._restore(entry, entry.redo.pop())
            self._persist(project_id)
            return entry.project

    def history_depth(self, project_id: str) -> tuple[int, int]:
        with self._lock:
            entry = self._entry(project_id)
            return len(entry.undo), len(entry.redo)

    # ---- 内部 ----

    def _restore(self, entry: _Entry, snapshot_json: str) -> ProjectDTO:
        """从历史快照复原工程，但保留 `BACKEND_ONLY_FIELDS` 的当前值。

        快照记录的是用户意图，而代理路径、导出登记这些是磁盘上的既成事实。
        把它们一起卷回去，就会出现"用户什么也没删，代理却显示未生成"——
        文件还在，工程却忘了它在哪。见 `BACKEND_ONLY_FIELDS` 的说明。
        """
        restored = ProjectDTO.model_validate_json(snapshot_json)
        for name in BACKEND_ONLY_FIELDS:
            setattr(restored, name, getattr(entry.project, name))
        return restored

    def _entry(self, project_id: str) -> _Entry:
        if project_id not in self._cache:
            self.get(project_id)
        return self._cache[project_id]

    def _path(self, project_id: str) -> Path:
        return self._root / f"{project_id}.kvm.json"

    def _persist(self, project_id: str) -> None:
        """原子写盘。

        先写临时文件再 rename —— 直接覆盖写若在中途崩溃会留下半截 JSON，
        而半截工程文件比没有文件更糟：用户以为工作还在，打开才发现全毁。
        """
        entry = self._cache[project_id]
        target = self._path(project_id)
        data = entry.project.model_dump_json(indent=2)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=self._root, delete=False, suffix=".tmp"
        ) as fh:
            fh.write(data)
            tmp = Path(fh.name)
        tmp.replace(target)
        entry.dirty = False

    def export_backup(self, project_id: str, dest: Path) -> Path:
        """导出工程副本，供用户自行备份。"""
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self._path(project_id), dest)
        return dest

    def touch(self, project_id: str) -> float:
        return time.time()
