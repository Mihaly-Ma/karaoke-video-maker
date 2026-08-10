"""引导声作业（`kvm.media.guide`）的编排层测试。

**不在这里跑 CREPE**：音高提取要十几到几十秒、要 torch，属于真机实测的范围
（见交付报告里的实跑记录与调参对照数据）。这一层值得钉死的是**判断**，
而且每一条判断错了都会表现成"看起来正常，其实不对"：

- 参数没映射进 `GuideConfig` → 用户拖了半天滑块，产出的还是默认参数那条音轨；
- 缓存清单合并旧条目 → 换回上一组参数被判成命中，拿到的其实是最后一次生成的那份
  （代理视频那边实测踩过，症状是"改了参数却没变化"）；
- 参数走 `update_derived` → 撤销撤不掉自己刚拖的滑块；
  产物路径走 `mutate` → 按一次 Cmd+Z 把"引导声已就绪"撤没了（CLAUDE.md §8）；
- 导出不复用素材页的产物 → 用户试听认可的和最终烧进成片的不是同一条音轨。
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm.api.schemas import GuideParamsDTO, ProjectDTO  # noqa: E402
from kvm.api.store import BACKEND_ONLY_FIELDS, ProjectStore  # noqa: E402
from kvm.media.guide import (  # noqa: E402
    GUIDE_VERSION,
    _load_cache_entry,
    _save_cache_entry,
    _worker_command,
    cache_key,
    params_key,
    project_signature,
    resolve_for_export,
    signature,
    to_config,
)


@pytest.fixture
def store(tmp_path: Path) -> ProjectStore:
    return ProjectStore(root=tmp_path / "projects")


def _vocals(tmp_path: Path, data: bytes = b"vocals") -> Path:
    path = tmp_path / "vocals.wav"
    path.write_bytes(data)
    return path


# ---- 参数映射 ----


def test_五个参数全部映射进配置() -> None:
    """漏掉任何一个，那个滑块就是个装饰品——拖了没反应，而且不报错。"""
    cfg = to_config(
        GuideParamsDTO(
            gain=0.25,
            timbre="triangle",
            max_harmonics=8,
            voicing_drop_db=-30.0,
            legato_gap_ms=120,
        )
    )
    assert cfg.gain == 0.25
    assert cfg.timbre == "triangle"
    assert cfg.max_harmonics == 8
    assert cfg.voicing_drop_db == -30.0
    assert cfg.legato_gap_s == pytest.approx(0.12)


def test_没暴露的参数保持契约默认值() -> None:
    """CLAUDE.md §8.9 的那些实测阈值不该因为界面加了个面板就漂掉。"""
    from kvm.pipeline.guide_melody import GuideConfig

    default = GuideConfig()
    cfg = to_config(GuideParamsDTO())
    assert cfg.pitch_median_frames == default.pitch_median_frames
    assert cfg.cents_tolerance == default.cents_tolerance
    assert cfg.min_note_s == default.min_note_s
    assert cfg.crepe_model == default.crepe_model
    assert cfg.quantize is True


def test_默认参数与合成层默认值一致() -> None:
    """两处各写一份默认值必然漂移，而漂移的表现是"界面显示 0.11、实际按 0.16 合成"。"""
    from kvm.pipeline.guide_melody import GuideConfig

    default = GuideConfig()
    params = GuideParamsDTO()
    assert params.gain == default.gain
    assert params.timbre == default.timbre
    assert params.max_harmonics == default.max_harmonics
    assert params.voicing_drop_db == default.voicing_drop_db
    assert params.legato_gap_ms == round(default.legato_gap_s * 1000)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("gain", 5.0),          # 上界 0.4
        ("gain", 0.0),          # 下界 0.02
        ("max_harmonics", 0),   # 至少 1
        ("max_harmonics", 999),
        ("voicing_drop_db", 0.0),   # 上界 −12
        ("voicing_drop_db", -80.0),
        ("legato_gap_ms", -1),
        ("legato_gap_ms", 5000),
    ],
)
def test_越界参数被拒绝(field: str, value: object) -> None:
    """取值域写在契约上而不是只写在滑块的 min/max 里：API 直调也得挡住。"""
    with pytest.raises(ValueError):  # noqa: PT011 —— pydantic 抛的是 ValidationError（ValueError 子类）
        GuideParamsDTO(**{field: value})


def test_未知音色被拒绝() -> None:
    with pytest.raises(ValueError):  # noqa: PT011
        GuideParamsDTO(timbre="noise")


# ---- 缓存键与指纹 ----


def test_缓存键随每个参数变化() -> None:
    base = GuideParamsDTO()
    key = cache_key("sha-a", base)
    assert key == cache_key("sha-a", GuideParamsDTO())
    assert key != cache_key("sha-b", base)  # 换了人声轨
    for field, value in (
        ("gain", 0.2),
        ("timbre", "sine"),
        ("max_harmonics", 4),
        ("voicing_drop_db", -30.0),
        ("legato_gap_ms", 100),
    ):
        assert key != cache_key("sha-a", base.model_copy(update={field: value})), field


def test_参数键与实现版本一起进缓存键() -> None:
    """改了合成算法要能让旧产物整体失效，否则用户看到的是上一版的音轨。"""
    assert cache_key("sha", GuideParamsDTO()).endswith(f":{GUIDE_VERSION}")
    assert params_key(GuideParamsDTO()) in cache_key("sha", GuideParamsDTO())


def test_指纹随参数与人声轨变化(tmp_path: Path) -> None:
    voc = _vocals(tmp_path)
    base = signature(voc, GuideParamsDTO())
    assert base == signature(voc, GuideParamsDTO())
    assert base != signature(voc, GuideParamsDTO(gain=0.2))

    voc.write_bytes(b"vocals-but-longer")  # 重新分离过：体积变了
    assert base != signature(voc, GuideParamsDTO())


def test_没有人声轨时指纹为空(tmp_path: Path) -> None:
    """空指纹让 `stale` 不会在"压根还不能生成"的工程上误报。"""
    assert project_signature(ProjectDTO(id="p")) == ""


# ---- 缓存清单 ----


def test_清单整体覆盖不与旧条目合并(tmp_path: Path) -> None:
    """一个工程只保留一份 `guide.wav`，所以清单里最多只能有一条有效记录。

    合并旧条目的后果是实测踩过的：先用 A 组参数生成、再用 B 组覆盖同一个文件、
    再切回 A —— 旧键还在，被判成命中，拿到的其实是 B 那份。
    症状是"改了参数却没变化"，而且怎么点重新生成都不变。
    """
    guide = tmp_path / "guide.wav"
    guide.write_bytes(b"x")
    key_a = cache_key("sha", GuideParamsDTO())
    key_b = cache_key("sha", GuideParamsDTO(gain=0.3))

    _save_cache_entry(tmp_path, key_a, str(guide))
    _save_cache_entry(tmp_path, key_b, str(guide))

    assert _load_cache_entry(tmp_path, key_b) == str(guide)
    assert _load_cache_entry(tmp_path, key_a) is None


def test_产物不在了就不算命中(tmp_path: Path) -> None:
    guide = tmp_path / "guide.wav"
    guide.write_bytes(b"x")
    key = cache_key("sha", GuideParamsDTO())
    _save_cache_entry(tmp_path, key, str(guide))
    guide.unlink()
    assert _load_cache_entry(tmp_path, key) is None


def test_清单损坏时当作未命中而不是崩掉(tmp_path: Path) -> None:
    (tmp_path / "guide_manifest.json").write_text("{ 不是 JSON", encoding="utf-8")
    assert _load_cache_entry(tmp_path, cache_key("sha", GuideParamsDTO())) is None


# ---- 子进程命令 ----


def test_worker_命令带齐五个参数(tmp_path: Path) -> None:
    """少传一个，子进程就会用那个字段的默认值——静默地、按错的参数合成。"""
    cmd = _worker_command(
        tmp_path / "v.wav",
        tmp_path / "out.wav",
        260.0,
        GuideParamsDTO(gain=0.2, timbre="saw", max_harmonics=4, voicing_drop_db=-30, legato_gap_ms=80),
    )
    assert "--worker" in cmd
    assert cmd[cmd.index("--gain") + 1] == "0.2"
    assert cmd[cmd.index("--timbre") + 1] == "saw"
    assert cmd[cmd.index("--max-harmonics") + 1] == "4"
    assert cmd[cmd.index("--voicing-drop-db") + 1] == "-30.0"
    assert cmd[cmd.index("--legato-gap-ms") + 1] == "80"
    assert cmd[cmd.index("--duration") + 1] == "260.000"


def test_worker_跑在独立子进程里(tmp_path: Path) -> None:
    """CREPE 是 torch 推理，绝不能在后端进程里跑（CLAUDE.md §5.13：MPS 不 fork-safe，
    几十秒的阻塞会让后端假死且无法取消）。"""
    cmd = _worker_command(tmp_path / "v.wav", tmp_path / "o.wav", 1.0, GuideParamsDTO())
    assert cmd[0] == sys.executable
    assert cmd[1:3] == ["-m", "kvm.media.guide"]


# ---- 撤销栈的两侧（CLAUDE.md §8） ----


def test_产物字段不进历史快照() -> None:
    """撤销回到更早的快照时路径被清空 = 界面显示"未生成"，可文件明明还在。"""
    assert "guide_audio_path" in BACKEND_ONLY_FIELDS
    assert "guide_signature" in BACKEND_ONLY_FIELDS


def test_参数留在历史里可撤销() -> None:
    """参数是用户拖滑块表达的意图，撤销理应回到上一组参数。"""
    assert "guide" not in BACKEND_ONLY_FIELDS


def test_撤销回到旧参数但保留产物(store: ProjectStore, tmp_path: Path) -> None:
    created = store.create()
    guide = tmp_path / "guide.wav"
    guide.write_bytes(b"x")

    store.mutate(created.id, lambda d: setattr(d, "guide", GuideParamsDTO(gain=0.3)))

    def _register(p: ProjectDTO) -> None:
        p.guide_audio_path = str(guide)
        p.guide_signature = "sig-new"

    store.update_derived(created.id, _register)

    restored = store.undo(created.id)
    assert restored.guide.gain == 0.11          # 参数回到上一组
    assert restored.guide_audio_path == str(guide)  # 产物没被撤没
    assert restored.guide_signature == "sig-new"


def test_登记产物不占撤销格(store: ProjectStore, tmp_path: Path) -> None:
    created = store.create()
    before = store.history_depth(created.id)
    guide = tmp_path / "guide.wav"
    guide.write_bytes(b"x")
    store.update_derived(created.id, lambda p: setattr(p, "guide_audio_path", str(guide)))
    assert store.history_depth(created.id) == before


# ---- 导出侧复用 ----


def test_导出复用素材页的产物(tmp_path: Path) -> None:
    """用户试听并认可的就是这一份，导出必须用它——否则"听到的"与"导出的"是两条轨。"""
    voc = _vocals(tmp_path)
    guide = tmp_path / "guide.wav"
    guide.write_bytes(b"guide")
    params = GuideParamsDTO()
    project = ProjectDTO(
        id="p",
        vocals_path=str(voc),
        guide=params,
        guide_audio_path=str(guide),
        guide_signature=signature(voc, params),
    )

    fallback = tmp_path / "fallback.wav"
    assert resolve_for_export(project, fallback, 260.0) == guide
    assert not fallback.exists()  # 没有白跑一次 CREPE


def test_参数改过就不复用旧产物(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """指纹对不上意味着这份音轨是别的参数产出的，拿它出片等于无视用户的调整。"""
    voc = _vocals(tmp_path)
    guide = tmp_path / "guide.wav"
    guide.write_bytes(b"guide")
    project = ProjectDTO(
        id="p",
        vocals_path=str(voc),
        guide=GuideParamsDTO(gain=0.3),
        guide_audio_path=str(guide),
        guide_signature=signature(voc, GuideParamsDTO()),  # 旧参数的指纹
    )

    built: dict[str, object] = {}

    def _fake_build(vocals: Path, out: Path, duration: float, config: object = None) -> int:
        built["vocals"] = vocals
        built["out"] = out
        built["gain"] = getattr(config, "gain", None)
        return 0

    monkeypatch.setattr("kvm.pipeline.guide_melody.build_guide_track", _fake_build)

    fallback = tmp_path / "fallback.wav"
    assert resolve_for_export(project, fallback, 260.0) == fallback
    # 回退合成必须用**工程当前那组参数**，不是默认值
    assert built["gain"] == 0.3


def test_产物文件消失就地重建(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """路径还在但文件被清掉了——判据是文件是否存在，不是字段有没有值。"""
    voc = _vocals(tmp_path)
    params = GuideParamsDTO()
    project = ProjectDTO(
        id="p",
        vocals_path=str(voc),
        guide=params,
        guide_audio_path=str(tmp_path / "gone.wav"),
        guide_signature=signature(voc, params),
    )
    monkeypatch.setattr(
        "kvm.pipeline.guide_melody.build_guide_track",
        lambda *a, **k: 0,
    )
    fallback = tmp_path / "fallback.wav"
    assert resolve_for_export(project, fallback, 260.0) == fallback


def test_没有人声轨时导出报中文原因(tmp_path: Path) -> None:
    project = ProjectDTO(id="p")
    with pytest.raises(RuntimeError, match="人声轨"):
        resolve_for_export(project, tmp_path / "x.wav", 260.0)
