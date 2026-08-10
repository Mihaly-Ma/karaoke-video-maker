//! Tauri 外壳。
//!
//! 职责只有三件：开窗口、拉起 Python 后端子进程、退出时把它整组带走。
//! 业务逻辑一律在 Python 后端与前端里，**不要往这里搬**——外壳越薄，
//! 「浏览器里能跑 = 壳里也能跑」的假设越容易成立。
//!
//! ## 界面为什么由后端下发，而不是内嵌进 app 协议
//!
//! 实测（已构建的壳，macOS 27 / wry 0.55 / WKWebView）：页面跑在
//! `tauri://localhost` 上时 `isSecureContext` 与 `crossOriginIsolated` 都是 true，
//! 但**全局 `SharedArrayBuffer` 不存在**。而 JASSUB 的 wasm 是带 pthread 编译的
//! （glue 里写死 `new WebAssembly.Memory({ …, shared: true })`，且
//! `_emscripten_has_threading_support` 直接读这个全局），拿不到它**根本实例化不了**
//! ——不是"退回单线程"。同一份页面改从 `http://127.0.0.1:<port>` 下发则四项能力全绿。
//!
//! 所以：壳先显示 `boot/` 里的启动页（app 协议），环境就绪后启动页调唯一那条 IPC
//! 命令 `enter_app`，由**壳**把窗口导航到后端地址（页面自己跨源跳转不可靠，
//! 见 `enter_app` 的注释）。副作用是 `/api`、`/media` 与页面同源，
//! 真界面上 CORS 根本不参与。
//!
//! **不要用 `tauri dev` 去验证跨源隔离**：dev 模式下前端由 Tauri 自己的 dev server
//! 下发，那台服务器不发 COOP/COEP，`crossOriginIsolated` 恒为 false —— 会得到
//! 假阴性。要看真形态必须 `tauri build`（`--debug` 也行）。探针见 `src-tauri/probe/`。
//!
//! ## 后端为什么不用 `externalBin`
//!
//! 两条独立的理由，任一条都足够：
//!
//! 1. `externalBin`（sidecar）在 macOS 上会导致公证失败
//!    （`tauri-apps/tauri#11992`，仍 open、无 workaround）。本项目当前不做签名公证，
//!    但绕开它意味着**将来要做的时候不会被这条卡住**。
//! 2. 它要求每个条目是**单个文件**并带目标三元组后缀，而 PyInstaller 必须用
//!    `--onedir`（`--onefile` 在 PyTorch 体量下每次启动都要解压，体验崩坏，
//!    见 CLAUDE.md §5.15），产物是一整个目录，本来就塞不进这个模型。
//!
//! 改走 `bundle.resources`：整个 onedir 目录作为资源打包，运行时用
//! `path().resource_dir()` 解析，再用标准的 `std::process::Command` 拉起。

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, State, WebviewWindow};

/// 后端 stderr 的尾部若干行。
///
/// 后端起不来时，真正的原因就在这里；不收上来的话用户只会看到"卡住了"，
/// 而 traceback 躺在一个没人会去看的地方。
const STDERR_KEEP: usize = 60;

/// 被托管的后端进程。
///
/// `Child` 被 drop **不会**杀掉进程。而且本项目的后端还会自己派生 ffmpeg /
/// 分离作业等子进程，只 kill 直接子进程会留下孤儿继续占着端口与 CPU
/// （`scripts/dev.py` 已经吃过这个亏），所以按**进程组**整组终止。
#[derive(Default)]
struct Backend {
    child: Mutex<Option<Child>>,
    stderr: Arc<Mutex<Vec<String>>>,
}

/// 向内核要一个空闲端口。
///
/// **不要写死 8000**：用户机器上很可能已经有别的东西占着（开发期本仓自己就占着），
/// 更别说同时开两个实例。绑 0 号端口让内核挑、再立刻释放，存在极小的竞态窗口，
/// 但比"写死然后祈祷"可靠得多，也是各家桌面壳的通行做法。
///
/// 只绑 127.0.0.1：这是单机应用，把 API 暴露到局域网没有任何收益。
fn pick_free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .ok()
}

/// 解析打包进资源里的后端可执行文件。
///
/// 开发模式下资源目录里没有 PyInstaller 产物（那是 `tauri build` 才做的事），
/// 返回 None，由调用方走 `KVM_BACKEND_ORIGIN` 分支——开发时后端由
/// `scripts/dev.py` 拉起，壳不该抢它的活。
fn bundled_backend(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    // 注意：`bundle.resources` 里把 `../dist-backend/kvm-backend` 映射到 `backend/` 时，
    // Tauri 是把该目录的**内容**摊进 `Resources/backend/`，不是再套一层同名目录。
    // 写成 `backend/kvm-backend/kvm-backend` 会永远找不到，而症状是应用静悄悄
    // 停在启动页上——所以这条路径值得一句注释。
    let exe = if cfg!(windows) {
        "backend/kvm-backend.exe"
    } else {
        "backend/kvm-backend"
    };
    let path = dir.join(exe);
    path.exists().then_some(path)
}

/// 后端地址。启动页**拿不到**它的字符串，只能请求"进去"。
struct Origin(String);

/// 把一条事件推给启动页。
///
/// 用 `eval` 单向推送而不是 IPC：壳 → 页面这个方向不需要回执，
/// 少一条命令就少一片攻击面。
fn push_to_boot(window: &WebviewWindow, json: String) {
    let script = format!("globalThis.__kvmShellEvent && globalThis.__kvmShellEvent({json})");
    let _ = window.eval(&script);
}

/// 启动页准备好之后请求进入主界面。**这是全应用唯一一条 IPC 命令。**
///
/// 为什么不让启动页自己 `location.replace(后端地址)`：
///
/// - 页面自己跳是**跨源导航**（`tauri://localhost` → `http://127.0.0.1:<port>`），
///   实测时灵时不灵——同一份页面同一套配置，有的运行能跳、有的运行停在启动页上，
///   而症状是"应用卡在加载界面"，用户无从判断。导航交给壳，行为是确定的。
/// - 目标地址只存在于 Rust 这一侧，页面改不了它。就算启动页被注入了脚本，
///   它能做的也只是"请求进入我们自己选定的那个地址"，而不是把窗口导去任意 URL。
#[tauri::command]
fn enter_app(window: WebviewWindow, origin: State<'_, Origin>) -> Result<(), String> {
    let url = origin.0.parse().map_err(|e| format!("{e}"))?;
    window.navigate(url).map_err(|e| format!("{e}"))
}

fn spawn_backend(
    app: &tauri::AppHandle,
    exe: &PathBuf,
    port: u16,
    stderr_buf: Arc<Mutex<Vec<String>>>,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(exe);
    cmd.arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        // 后端拿 stdin 的 EOF 当"父进程没了"的信号。**这个管道必须一直握着**：
        // 下面刻意不 take() 走 `child.stdin`，让它随 Child 一起活到最后。
        // 外壳被 kill -9 或崩掉时轮不到我们做收尾，这条管道是唯一还起作用的机制。
        .stdin(Stdio::piped())
        .arg("--exit-on-stdin-eof")
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped());

    // 自成进程组，退出时整组带走（见 Backend 的文档注释）。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP，与 scripts/dev.py 的做法一致。**未在 Windows 上实测。**
        cmd.creation_flags(0x0000_0200);
    }

    let mut child = cmd.spawn()?;
    if let Some(err) = child.stderr.take() {
        let buf = stderr_buf;
        let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
                let mut guard = buf.lock().unwrap();
                guard.push(line);
                if guard.len() > STDERR_KEEP {
                    guard.remove(0);
                }
            }
            let _ = handle.emit("backend-stderr-closed", ());
        });
    }
    Ok(child)
}

/// 整组终止后端。先温和（SIGTERM / CTRL_BREAK），再强硬。
fn stop_backend(state: &Backend) {
    let taken = state.child.lock().unwrap().take();
    let Some(mut child) = taken else { return };
    let pid = child.id();

    #[cfg(unix)]
    unsafe {
        // 负 pid = 整个进程组。子进程用 process_group(0) 自成一组，
        // 组号就等于它的 pid。
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        // Windows 上没有等价于 SIGTERM 的进程组信号，taskkill /T 是最接近的。
        // **未在 Windows 上实测。**
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    // 给它一点时间自己收尾（uvicorn 要关连接、作业要删临时文件），
    // 超时再下狠手。3 秒是拍的：本地服务收尾本来就该是毫秒级的事。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            _ => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

pub fn run() {
    // 开发模式：后端已经由 scripts/dev.py 起在别处，壳只负责开窗口。
    let dev_origin = std::env::var("KVM_BACKEND_ORIGIN").ok();
    let port = pick_free_port();
    let origin = dev_origin
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", port.unwrap_or(0)));

    tauri::Builder::default()
        .manage(Backend::default())
        .manage(Origin(origin.clone()))
        .invoke_handler(tauri::generate_handler![enter_app])
        // 把后端地址注入启动页。用初始化脚本而不是 IPC：不需要 capability，
        // 也不用等页面先问一句。真界面加载后这个全局无人使用，无副作用。
        .setup(move |app| {
            // 主窗口**在这里建**，不在 tauri.conf.json 里声明：
            // 后端地址要通过 `initialization_script` 注入，而那只能在建窗口时给。
            //
            // 曾经写成"配置里声明窗口 + setup 里 `eval` 注入全局"——**那是错的**：
            // setup 跑在页面加载之前，注入的全局会被随后的文档加载冲掉，
            // 启动页拿不到地址，症状是窗口停在启动页、后端明明起来了却无人访问。
            // 启动页要跨源轮询后端，所以仍需要知道地址；但**进入主界面这个动作
            // 不由它做**，见 `enter_app` 的注释。
            let init = format!(
                "globalThis.__KVM_BOOT__ = {{ origin: {} }};",
                serde_json::to_string(&origin).unwrap_or_else(|_| "\"\"".into())
            );
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Karaoke Video Maker")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1100.0, 700.0)
            .initialization_script(&init)
            .build()?;

            if dev_origin.is_some() {
                return Ok(());
            }
            let Some(port) = port else {
                push_to_boot(
                    &window,
                    r#"{"kind":"backend-exited","detail":"没有可用的本机端口"}"#.into(),
                );
                return Ok(());
            };
            let Some(exe) = bundled_backend(&app.handle().clone()) else {
                push_to_boot(
                    &window,
                    serde_json::json!({
                        "kind": "backend-missing",
                        "detail": app.path().resource_dir().map(|p| p.display().to_string())
                            .unwrap_or_default(),
                    })
                    .to_string(),
                );
                return Ok(());
            };

            let state: State<'_, Backend> = app.state();
            let stderr_buf = state.stderr.clone();
            match spawn_backend(&app.handle().clone(), &exe, port, stderr_buf.clone()) {
                Ok(child) => {
                    *state.child.lock().unwrap() = Some(child);
                }
                Err(e) => {
                    push_to_boot(
                        &window,
                        serde_json::json!({
                            "kind": "backend-exited",
                            "detail": format!("无法启动后端进程：{e}"),
                            "stderr": format!("{}\n{e}", exe.display()),
                        })
                        .to_string(),
                    );
                    return Ok(());
                }
            }

            // 守望线程：后端如果在启动阶段就死了，把退出码与 stderr 尾部推给启动页。
            // 没有这一步，用户看到的就是一个永远转圈的进度条——最糟的失败方式。
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let state: State<'_, Backend> = handle.state();
                let mut guard = state.child.lock().unwrap();
                let Some(child) = guard.as_mut() else { return };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let tail = stderr_buf.lock().unwrap().join("\n");
                        drop(guard);
                        if let Some(w) = handle.get_webview_window("main") {
                            push_to_boot(
                                &w,
                                serde_json::json!({
                                    "kind": "backend-exited",
                                    "code": status.code(),
                                    "stderr": tail,
                                })
                                .to_string(),
                            );
                        }
                        return;
                    }
                    Ok(None) => {}
                    Err(_) => return,
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state: State<'_, Backend> = window.state();
                stop_backend(&state);
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 外壳启动失败")
        // 用 `build` + `run(闭包)` 而不是直接 `run()`：需要 `RunEvent::Exit`。
        // 只挂 `WindowEvent::Destroyed` 是不够的——macOS 上 Cmd+Q 走的是应用退出，
        // 不保证先把窗口 Destroy 掉，那条路径下后端就成了孤儿。
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state: State<'_, Backend> = handle.state();
                stop_backend(&state);
            }
        });
}
