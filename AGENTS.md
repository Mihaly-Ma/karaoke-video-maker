# AGENTS.md

## 项目概况

Karaoke Video Maker 是一站式日式卡拉 OK 视频制作工具，工作流为素材、歌词、编辑、样式、导出。
支持 macOS Apple Silicon 和 Windows x64，提供 Windows CPU 安装版与 CUDA 免安装版。

- 后端：Python 3.12、FastAPI、Pydantic，uv 管理依赖。
- 前端：React 18、TypeScript、Vite、Zustand，npm 管理依赖。
- 桌面：Tauri 2、Rust，PyInstaller 打包 Python 后端。
- 媒体：FFmpeg/libass、yt-dlp，以及本地音频处理模型。
- CI：GitHub Actions，配置位于 `.github/workflows/ci.yml`。

## 沟通与执行

所有交流使用中文，提交信息描述实际变更。优先遵循用户当前明确要求，已有授权可直接执行。

1. 明确目标、验收条件、涉及文件和函数，制定变更计划。
2. 检查工作区、分支和远程状态，区分本次任务与其他改动，保留已有工作。
3. 定位具体修改点，按最小范围实现，沿用模块现有模式。
4. 交叉验证正确性、副作用、下游影响和兼容性。
5. 交付说明修改文件、行为变化、验证结果、假设及待验证事项。

业务契约阅读 `CLAUDE.md` 的对应主题，用户操作与安装说明参见 `README.zh-CN.md`。
架构、命令、环境和完成状态以当前代码及实测为准。
涉及全局编码、构建或 Git 规则时，先阅读 `~/.codex/rules/` 中对应范围的文件。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `backend/kvm/api/` | HTTP 路由、DTO、工程持久化和撤销重做 |
| `backend/kvm/editing/` | 歌词、时轴、注音、声部与样式编辑操作 |
| `backend/kvm/lyrics/` | 歌词提供方、解析与导入 |
| `backend/kvm/media/` | 下载、媒体探测、分离、代理视频与波形 |
| `backend/kvm/render/` | ASS 生成、字体、几何与排版 |
| `backend/kvm/pipeline/` | 音频分析、引导旋律和成片处理 |
| `backend/kvm/models/` | 领域模型 |
| `frontend/src/` | 页面组件、API 客户端、状态和中文文案 |
| `src-tauri/` | 桌面外壳、后端生命周期和安装包配置 |
| `scripts/` | 环境、开发启动、打包与版本工具 |
| `tests/`、`frontend/scripts/` | 后端回归和浏览器验收脚本 |
| `experiments/` | 关键问题的实验和实测基线 |

## 实现原则

- 保持简单、可读，优先复用现有入口与单一规则来源。
- 自动化与手工编辑提供等价入口；自动步骤失败时保留继续操作的路径，并显示可执行的提示。
- 用户编辑通过 `ProjectStore.mutate()` 持久化并进入撤销历史；后台派生产物通过
  `update_derived()` 写回。变更需兼顾保存、重新读取、撤销和重做。
- 歌词导入和重新导入保留 token 身份、时间来源、手工锁定与有效注音；正文和 Credit 分别管理。
- 预览与导出共享字幕、字体和几何规则，核对时间基准、画幅、像素比例及字体覆盖。
- 界面文案通过 `frontend/src/i18n/` 的 `t()` 取值。桌面交互采用 WebView 可用的页面组件，
  同时考虑鼠标、键盘、取消、等待和失败重试。
- 推理和音频处理在本地完成；联网用于获取媒体、歌词、依赖和模型资源。
- 应用资源统一使用 `backend/kvm/paths.py` 的私有目录规则。
  媒体能力按实际探测结果判断，FFmpeg 需支持 libass 的字幕滤镜。
- 资源与后台作业有明确生命周期；退出和取消时清理本次创建的进程、连接和临时资源。

## 常用命令

在仓库根目录执行，前端独立命令使用 `--prefix frontend`。

```bash
uv sync --all-extras
uv run python scripts/dev.py --skip-setup
uv run python scripts/setup.py --check-only

uv run ruff format --check .
uv run ruff check .
uv run pyright <本次涉及的Python文件或目录>
uv run pytest -q

npm ci --prefix frontend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
cargo check --locked --manifest-path src-tauri/Cargo.toml

uv run python scripts/package.py
```

首次环境准备可使用 `scripts/setup.py`。打包工具依赖安装在 package 依赖组中；
CUDA 版沿用 `scripts/package.py --portable` 的免安装形态。

## 验证

根据修改范围选择检查，为修复添加能区分原问题与修复结果的回归验证。
Python 依次执行格式、lint、相关范围的类型检查和测试；前端执行类型检查、lint 和构建。
WebView 交互验证 Chromium 与 WebKit；涉及媒体时使用隔离的测试工程和临时资源。

核对命令退出码及真实产物。交付分别说明本地验证、远程 CI、安装包与实际应用验证的范围。
外部服务问题记录原始错误、环境、依赖版本和复现结果，再实施已验证的修复。

## Git、版本与发布

- 检查每个待提交文件的差异，精确暂存本次文件；检查提交范围和敏感信息后，
  提交并推送用户指定分支。
- 面向用户交付功能或修复时同步更新应用版本。先确定版本，再使用
  `scripts/version.py --set <版本>` 更新所有声明和锁文件；以 `pyproject.toml` 为真源。
  提交前执行 `--check --expect <版本>` 和版本回归测试。
- 正式发布沿用：版本提交 → `v<版本>` tag → GitHub Actions → draft Release → 正式 Release。
  安装包生成、传输和附件上传均由 GitHub runner 完成。
- 用户要求发布后，将 tag 指向对应版本提交。核对双平台检查、三个平台打包和创建草稿
  全部成功，再确认 DMG、CPU EXE、CUDA 全部 ZIP 上传完成、大小非零、分卷齐全。
- 整理用户可见变化、安装说明和验证范围；已有发布授权时将草稿转为正式 Release，
  重新确认 `draft=false`、`published_at` 非空及附件完整后报告链接。
- main 普通 push 用于检查，手动 `package=true` 用于验证打包，正式版本通过 tag 流程发布。
  流程故障先检查对应日志；需要调整发布方式或已有 tag 时，向用户说明方案后执行。

## 持续任务与交付顺序

用户要求当前版本正式发布后再推下一版时，先在本地准备与验证下一版，确认正式 Release 后
再更新版本、提交推送并启动 CI。每一版的打包和正式发布分别按用户授权执行。

监控绑定明确提交 SHA、tag 和运行编号，更新目标时保留用户的顺序与通知要求。
无实质变化时保持安静，成功或失败通知一次；失败附具体步骤、原因和链接。
有依赖的后续工作持续推进至全部完成，随后停用监控。

用户要求停止操作时，立即终止本次对应进程，核对留下的草稿、标签和附件状态，
再按用户最新安排继续。最终报告使用证据对应的状态：已推送、检查通过、打包完成、
草稿就绪、正式发布完成或本机应用已更新。
