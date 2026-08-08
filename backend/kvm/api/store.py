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
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from kvm.api.schemas import ProjectDTO, ProjectSummary

_MAX_HISTORY = 200


def default_root() -> Path:
    """工程存放目录。

    放在用户数据目录而非仓库内——工程是用户资产，不该随代码走。
    """
    env = os.environ.get("KVM_DATA_DIR")
    if env:
        return Path(env)
    return Path.home() / ".karaoke-video-maker" / "projects"


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

    # ---- 生命周期 ----

    def create(self, title: str = "", artist: str = "") -> ProjectDTO:
        pid = uuid.uuid4().hex[:12]
        proj = ProjectDTO(id=pid, title=title, artist=artist)
        self._cache[pid] = _Entry(project=proj)
        self._persist(pid)
        return proj

    def get(self, project_id: str) -> ProjectDTO:
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
        self._cache.pop(project_id, None)
        self._path(project_id).unlink(missing_ok=True)

    # ---- 变更与历史 ----

    def mutate(self, project_id: str, mutator, *, label: str = "") -> ProjectDTO:
        """在一次事务里修改工程，自动压入撤销栈。

        `mutator` 接收工程副本并就地修改；抛异常时**不产生历史记录、不落盘**，
        避免把失败的半成品变更留在栈里。
        """
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

    def undo(self, project_id: str) -> ProjectDTO:
        entry = self._entry(project_id)
        if not entry.undo:
            return entry.project
        entry.redo.append(entry.project.model_dump_json())
        entry.project = ProjectDTO.model_validate_json(entry.undo.pop())
        self._persist(project_id)
        return entry.project

    def redo(self, project_id: str) -> ProjectDTO:
        entry = self._entry(project_id)
        if not entry.redo:
            return entry.project
        entry.undo.append(entry.project.model_dump_json())
        entry.project = ProjectDTO.model_validate_json(entry.redo.pop())
        self._persist(project_id)
        return entry.project

    def history_depth(self, project_id: str) -> tuple[int, int]:
        entry = self._entry(project_id)
        return len(entry.undo), len(entry.redo)

    # ---- 内部 ----

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
