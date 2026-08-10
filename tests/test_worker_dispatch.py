"""冻结形态下的 worker 子进程分发（`kvm.media.deps` + `kvm.server`）。

起因是一个发布阻断项：分离与引导声都用 `[sys.executable, "-m", "kvm.media.X",
"--worker", …]` 拉子进程，这在源码环境里天天在跑，**打包后必然失败**——
`sys.executable` 变成 `kvm-backend`，PyInstaller 的引导器不认 `-m`，
整串参数掉进 `kvm.server` 的 argparse，子进程以
`error: the following arguments are required: --port` 秒退。
症状是人声分离与引导声在装好的应用里全都跑不起来。

**这一类 bug 单元测试看不见**（本文件里的用例只能守住形态与分发规则，
真正的证据是 `scripts/package.py --backend-only` 之后拿打包产物跑一次——
`smoke_test_workers()` 就是干这个的）。所以这里刻意把断言压在两件事上：

- 冻结与否，命令行形态**必须**分叉，且冻结那支不含 `-m`
- 分离与引导声**共用同一个构造器**，不会再各自演化出一套
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    # 本项目是 uv 的 virtual project，包不装进 site-packages，测试自带路径引导
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402
from kvm import paths, server  # noqa: E402
from kvm.api.schemas import GuideParamsDTO  # noqa: E402
from kvm.media import deps  # noqa: E402
from kvm.media.guide import _worker_command as guide_worker_command  # noqa: E402
from kvm.media.separate import _worker_command as separate_worker_command  # noqa: E402


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """把当前解释器伪装成 PyInstaller 打好的可执行文件。"""
    monkeypatch.setattr(sys, "frozen", True, raising=False)


# ---- 命令行形态 ----


def test_源码运行仍走_dash_m() -> None:
    """非冻结路径不改：它已经被大量使用与测试覆盖，没有理由跟着变。"""
    cmd = deps.worker_command("kvm.media.guide", ["--worker", "--vocals", "v.wav"])
    assert cmd == [sys.executable, "-m", "kvm.media.guide", "--worker", "--vocals", "v.wav"]


@pytest.mark.usefixtures("frozen")
def test_冻结形态绝不能出现_dash_m() -> None:
    """`-m` 是这次事故的根因：PyInstaller 的引导器不认它，参数会掉进服务端 argparse。"""
    cmd = deps.worker_command("kvm.media.guide", ["--worker", "--vocals", "v.wav"])
    assert "-m" not in cmd
    assert cmd == [
        sys.executable,
        deps.WORKER_FLAG,
        "kvm.media.guide",
        "--worker",
        "--vocals",
        "v.wav",
    ]


def test_未登记的模块不给构造() -> None:
    """白名单在构造侧也要拦一次：错拼的模块名要当场报错，而不是等子进程退出码 2。"""
    with pytest.raises(ValueError, match="未登记"):
        deps.worker_command("kvm.media.nope", [])


def test_两个_worker_共用同一个构造器(tmp_path: Path) -> None:
    """分离与引导声是同一个模式的两份实现，本仓吃过多次"两份实现漂移"的亏。"""
    guide = guide_worker_command(tmp_path / "v.wav", tmp_path / "o.wav", 1.0, GuideParamsDTO())
    sep = separate_worker_command(
        tmp_path / "a.wav", "htdemucs.yaml", tmp_path / "models", tmp_path / "out"
    )
    # 可执行文件与"模块名怎么交代过去"这两段必须一模一样，只有模块名与参数不同
    assert guide[:2] == [sys.executable, "-m"]
    assert sep[:2] == [sys.executable, "-m"]
    assert guide[2] == "kvm.media.guide"
    assert sep[2] == "kvm.media.separate"
    assert "--worker" in guide
    assert "--worker" in sep


@pytest.mark.usefixtures("frozen")
def test_两个_worker_在冻结形态下一起改形态(tmp_path: Path) -> None:
    """漏改一处就等于那个功能在装好的应用里不可用——必须一起验。"""
    guide = guide_worker_command(tmp_path / "v.wav", tmp_path / "o.wav", 1.0, GuideParamsDTO())
    sep = separate_worker_command(
        tmp_path / "a.wav", "htdemucs.yaml", tmp_path / "models", tmp_path / "out"
    )
    for cmd, module in ((guide, "kvm.media.guide"), (sep, "kvm.media.separate")):
        assert cmd[:3] == [sys.executable, deps.WORKER_FLAG, module]
        assert "-m" not in cmd


def test_登记表覆盖了全部_worker() -> None:
    """新增 worker 忘了登记，`worker_command()` 会直接 ValueError——这里先说清有哪几个。"""
    assert set(deps.WORKER_MODULES) == {"kvm.media.separate", "kvm.media.guide"}


# ---- 工作目录 ----


def test_源码运行的_cwd_是_backend目录() -> None:
    """`python -m kvm.media.X` 靠 cwd 进 sys.path 才找得到 `kvm` 包。"""
    cwd = Path(deps.worker_cwd())
    assert (cwd / "kvm" / "media" / "deps.py").is_file()
    assert cwd.name == "backend"


@pytest.mark.usefixtures("frozen")
def test_冻结形态的_cwd_是可写的应用数据根(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`backend/` 在打好的应用里根本不存在；退回 `_MEIPASS` 则可能是只读的
    （`/Applications` 下），某个库往 cwd 落个临时文件就会以无关的权限错误炸掉。"""
    monkeypatch.setenv(paths.ENV_DATA_DIR, str(tmp_path / "data" / "projects"))
    cwd = Path(deps.worker_cwd())
    assert cwd == tmp_path / "data"
    assert cwd.is_dir()


# ---- 分发层 ----


def test_不是_worker_调用就不接管() -> None:
    """服务端参数必须原样落到服务端的 argparse 上。"""
    assert deps.run_worker_module([]) is None
    assert deps.run_worker_module(["--host", "127.0.0.1", "--port", "8000"]) is None


def test_未登记的模块被拒绝且不碰_stdout(capsys: pytest.CaptureFixture[str]) -> None:
    """stdout 是 JSON-lines 进度协议的通道（§5.13），分发层往里写一个字都不行。"""
    code = deps.run_worker_module([deps.WORKER_FLAG, "kvm.does.not.exist"])
    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ""
    assert "未登记" in captured.err


def test_缺模块名也要说清可选项(capsys: pytest.CaptureFixture[str]) -> None:
    code = deps.run_worker_module([deps.WORKER_FLAG])
    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ""
    assert "kvm.media.guide" in captured.err


def test_参数原样交给目标模块(monkeypatch: pytest.MonkeyPatch) -> None:
    """等价于 `python -m <模块> <其余参数>`：模块看到的 `sys.argv` 要一模一样。"""
    seen: dict[str, Any] = {}

    def _fake_main() -> int:
        seen["argv"] = list(sys.argv)
        return 7

    import kvm.media.guide as guide_module

    monkeypatch.setattr(guide_module, "main", _fake_main)
    code = deps.run_worker_module(
        [deps.WORKER_FLAG, "kvm.media.guide", "--worker", "--vocals", "v.wav"]
    )
    assert code == 7
    assert seen["argv"] == ["kvm.media.guide", "--worker", "--vocals", "v.wav"]


def test_worker_模块少了_main_不静默成功(monkeypatch: pytest.MonkeyPatch) -> None:
    """返回 0 会让父进程报"子进程正常退出却没有产物"，把问题指向错的方向。"""
    import kvm.media.guide as guide_module

    monkeypatch.delattr(guide_module, "main")
    assert deps.run_worker_module([deps.WORKER_FLAG, "kvm.media.guide"]) == 2


# ---- 服务端入口的分发优先级 ----


def test_server_先分发_worker_再解析服务端参数(monkeypatch: pytest.MonkeyPatch) -> None:
    """分发必须**先于** argparse：worker 带的是目标模块自己的参数，
    交给服务端的 parser 只会报"缺 --port"——那正是这次事故的现场。"""
    called: dict[str, Any] = {}

    def _fake_main() -> int:
        called["argv"] = list(sys.argv)
        return 0

    import kvm.media.guide as guide_module

    monkeypatch.setattr(guide_module, "main", _fake_main)
    # 没有 --port，走服务端 parser 必然 SystemExit(2)
    assert server.main([deps.WORKER_FLAG, "kvm.media.guide", "--worker", "--out", "o.wav"]) == 0
    assert called["argv"][1:] == ["--worker", "--out", "o.wav"]


def test_server_先接住_multiprocessing_辅助进程(monkeypatch: pytest.MonkeyPatch) -> None:
    """与 worker 分发同一个病根：冻结后自我重入的一切都会掉进服务端 argparse。

    `multiprocessing.resource_tracker` 按 `<exe> -c "from …resource_tracker import main…"`
    拉起自己，冻结解释器不认 `-c`，于是在打好的包里会冒出两次
    "the following arguments are required: --port"——那行字还会顺着
    `run_cancelable`（stderr 并进 stdout）混进 JSON-lines 通道，看起来就像分发失败。
    PyInstaller 的运行时钩子把处理逻辑放进了 `multiprocessing.freeze_support`，
    **但它不会自己调用**，删掉这一行就等于把那个坑放回去。
    """
    import multiprocessing

    order: list[str] = []
    monkeypatch.setattr(multiprocessing, "freeze_support", lambda: order.append("freeze"))

    def _fake_run(app: object, **kwargs: Any) -> None:
        order.append("serve")

    import uvicorn

    monkeypatch.setattr(uvicorn, "run", _fake_run)
    server.main(["--port", "12345"])
    assert order == ["freeze", "serve"]


def test_server_不误伤正常启动参数(monkeypatch: pytest.MonkeyPatch) -> None:
    """分发层只认自己那个首参，别的一律放行给服务端。"""
    started: dict[str, Any] = {}

    def _fake_run(app: object, **kwargs: Any) -> None:
        started.update(kwargs)

    import uvicorn

    monkeypatch.setattr(uvicorn, "run", _fake_run)
    assert server.main(["--port", "12345"]) == 0
    assert started["port"] == 12345


# ---- 冻结形态下的依赖缺失 ----


@pytest.mark.usefixtures("frozen")
def test_冻结形态缺依赖要说人话(monkeypatch: pytest.MonkeyPatch) -> None:
    """PyInstaller 把 `sys.prefix` 与 `sys.base_prefix` 都指到 `_MEIPASS`，
    不特判就会报"当前 Python 不是虚拟环境"——那句话在装好的应用里完全是误导。
    也绝不能真去跑安装器：`uv pip install --python <应用本体>` 认不了。"""

    def _boom(*args: object, **kwargs: object) -> None:
        raise AssertionError("冻结形态下绝不该尝试自动安装")

    monkeypatch.setattr(deps, "run_installer", _boom)
    with pytest.raises(RuntimeError) as exc:
        deps.ensure_dependencies((("kvm_no_such_module_xyz", "nope>=1"),), "提示。")
    message = str(exc.value)
    assert "打包后的应用" in message
    assert "虚拟环境" not in message
