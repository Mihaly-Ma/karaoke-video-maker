# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 0. 怎么读这份文件

本文件是**契约**，不是进度记录：它规定该怎么做、以及哪些做法已经被验证是错的。
不要在这里追加"某某已完成"之类的状态，那是 git 历史的职责。

**代码是唯一的真实状态。** 本文件描述的架构、目录、数据结构、命令，凡未标"已实测"的，
都是**设计决策**或**待实现项**——动手前先确认它是否真的存在，不要假设。

`experiments/` 下是各阻断问题的实测脚本，结论已固化进本文件，脚本保留作为回归基线。

标注体系：

| 标记 | 含义 |
|---|---|
| 已实测 | 在真实环境中跑通过，可以直接依赖 |
| 已定 | 调研证据充分、决策已作出，实现时照此执行，不要重新讨论 |
| 待实现 | 设计已定，代码尚未写 |
| 待实测 | 调研无法定论，必须先写实验代码验证，不要凭猜测写进生产路径 |
| 待拍板 | 需要用户决策，阻塞下游选型 |

---

## 1. 项目目标

一个**一站式日式卡拉OK（ニコカラ）视频制作工具**：输入一个 YouTube 链接，输出一个带逐字扫色歌词、日语振り仮名、可选 ON VOCAL / OFF VOCAL 双音轨的成品视频。

"一站式"意味着一条硬性产品定位：**下载、歌词获取、去人声、对轴、注音、样式、预览、合成，全部在本工具内完成**。用户不需要打开第二个软件，尤其不需要打开 Aegisub。

由此推出一条容易被忽视但决定成败的结论：**三级调轴 UI（整体 / 单句 / 单词）与注音编辑 UI 不是"配套功能"，它们就是核心功能。** 自动对齐只负责把 90% 的内容放到大致正确的位置；剩下 10% 的人工收口体验，决定这个工具好不好用。任何"自动跑完就交付"的架构假设都是错的。

---

## 2. 硬约束（这几条会否决掉大量看起来合理的方案）

### 2.1 禁止云端 AI 推理

去人声、语音识别、强制对齐、注音、说话人分离，**全部必须跑在本地算力上**。允许的联网严格限于"取数据"：

| 允许 | 不允许 |
|---|---|
| yt-dlp 下载视频 | 调用云端 ASR / LLM / 分离服务 |
| 抓歌词 API（QQ音乐 / 酷狗 / LRCLIB 等） | 把音频或歌词发给远程模型做推理 |
| 首次运行下载模型权重到本地 | 任何形式的"可选云端增强" |

参考实现 `delete039/nicokara-studio` 的注音链路里有 DeepSeek 云端调用，**必须砍掉**，改用本地方案。

### 2.2 跨平台

Windows x64 与 macOS Apple Silicon (arm64) 双端。任何"只有 Linux 有 wheel"、"需要 conda 装 Kaldi"、"依赖 Intel Mac"的方案都要降权。Intel Mac 明确不支持（PyTorch 2.2 后已停止支持 Intel macOS）。

### 2.3 一站式，不依赖 Aegisub

**严禁任何"导出 ASS 让用户去 Aegisub 精修"的设计。** Aegisub 只是效果参考对象与算法参考来源（karaskel 的注音布局算法、卡拉OK 定时交互模型值得借鉴），不是工作流中的一环。

同理，中间产物（timeline.json / lyrics.ass）不允许出现"请用外部工具编辑"的说明——`nicokara-studio` 的 README 就是这么写的，那正是我们要规避的反模式。

### 2.4 不迁就当前开发机环境

环境缺什么就补什么，不要让环境现状反过来扭曲架构。按理想架构设计，然后补环境。

开发机现状：已装 `ffmpeg-full` 8.1.2_2，带 `libass + libharfbuzz + libfontconfig + libfreetype`，`ass`/`subtitles` 滤镜可用。注意 **Homebrew 主线 `ffmpeg` formula 不含 libass**，`ffmpeg@6` 含但版本旧——所以探测 ffmpeg 时必须**以滤镜是否注册为准**，不能只看版本号，也不能假设 `which ffmpeg` 拿到的那个可用。系统 Python 是 3.14，项目用 3.12，由 uv 管理，不动系统 Python。

### 2.5 自动化可以打折，一站式不能

**自动化 = 省力；一站式 = 不用出门。** 前者可以打折，后者不行。

这条定位重排了整个优先级。它**降低**了一批技术风险：对齐精度差 80ms、
读音把「運命」猜成 うんめい、歌词源完全查不到——都可以接受，因为用户能在工具里改。

但它**硬性要求**：

> **每个自动环节都必须有等价的手工旁路，且失败时要降级、不能终止。**

反面例子：歌词源查不到 → 弹「获取失败」→ 流程卡死。用户此刻唯一的出路是打开别的软件，
**一站式就在这一刻破功**。正确行为是直接打开歌词粘贴框，让他往下走。

| 环节 | 自动 | 手工旁路（必须存在） |
|---|---|---|
| 视频获取 | yt-dlp 下载 | 选本地文件 |
| 歌词 | provider 搜索 | 粘贴文本 / 导入 LRC |
| 时间轴 | QRC 逐字轴 / 强制对齐 | **tap-to-time 打轴 + 波形拖拽** |
| 读音 | `[kana:]` / 形态素 / 声学消歧 | 逐词输入假名 |
| 分行 | 自动断句 | 拆行 / 并行 |
| 段落 | 间隙检测 | 手工标间奏 |
| 声部 | （暂无可靠自动方案） | 选中词句指派声部 |

**tap-to-time 手工打轴是一等公民，不是降级方案**——要做到哪怕自动对齐完全不可用，
用户也能舒服地从零打完一首歌，因此不能藏在高级菜单里。

由此**编辑器状态层（撤销/重做、工程持久化、崩溃恢复）是第一优先级**，
不是完备性审查里排的第 4 位：用户手工调 40 分钟的轴，进程崩了就全没，
这在"高度自动化"的定位下只是遗憾，在"一站式"的定位下是致命伤。

反过来，这条也让一件事**更重要**：**自动环节的错误必须可见**。
`(value, source, locked)` 横切机制（§4.4）的价值因此上升——用户需要一眼看出
"这几个字是机器猜的，我得检查"，而不是面对一堆看起来同样自信的结果逐个核对。

### 2.6 依赖必须能自动查找 / 获取 / 安装

**用户不应该为了跑起这个工具去手动 `brew install` 任何东西。** 应用要自己搞定依赖。

这不是锦上添花：本项目的依赖恰好都属于"系统里可能有、可能没有、有也可能是残废版本"的类型——ffmpeg 可能不带 libass、字体可能缺字、模型权重动辄几百 MB。

三段式，缺一不可：

| 阶段 | 职责 | 现状 |
|---|---|---|
| **查找** | 探测系统已有的可用件。判据是**实际能力而非存在性**——ffmpeg 要看 `ass` 滤镜是否注册（`experiments/ffmpeg_locate.py` 是其原型），字体要看 cmap 是否覆盖本曲全部字符与注音假名，而不是看名字对不对 | 已实测（`kvm.doctor`） |
| **获取** | 缺失时自动下载：ffmpeg 静态构建、模型权重、字体。带进度、SHA256 校验、断点续传，并支持离线导入 | ffmpeg 已实测（`kvm.bootstrap`，macOS arm64 端到端跑通）；模型权重与字体**待实现** |
| **安装** | 一律装进**应用私有目录**，绝不污染用户系统，也绝不要求 sudo。卸载即删目录 | 已实测（Python 依赖、前端依赖、ffmpeg/ffprobe 二进制） |

**不管自动获取做没做，探测不到的外部二进制（ffmpeg / Node / uv 自身）都要给出
可直接复制粘贴的安装命令，绝不写成"请安装 X"。** 这不是"获取"缺位期间的过渡规则——
它要长期兜住"下载失败 / 离线 / 用户拒绝下载第三方构建"这三种情况。
命令按平台定义在 `kvm.bootstrap._MANUAL_INSTALL`，随状态一起下发。
**摆出来不等于推荐它**：它装进用户系统，与"卸载即删目录"的原则相反；
macOS 上还要提醒 Homebrew 主线 `ffmpeg` 不带 libass、`ffmpeg-full` 在第三方 tap 里。

#### 下载源的三条硬性要求（已实测）

自动获取意味着**应用替用户做出一次信任决定**：下载一个第三方构建的可执行文件并运行它。
这件事只能靠下面三条约束住，缺一条都不成立：

| 要求 | 为什么 | 反例 |
|---|---|---|
| **URL 必须定版** | 定版链接的内容不会变，钉死的哈希才有长期意义 | osxexperts 的 `ffmpeg81arm.zip` 只带主版本号，上游发补丁版会**原地替换**。失败方向是安全的（校验失败并报错），但用户看到的是"某天突然装不上了"，我们这边毫无察觉 |
| **期望哈希必须有独立来源** | 我们自己下载后算出来的哈希只锁得住"此后不被篡改"，证明不了第一次就下对了 | osxexperts **不发布校验和** |
| **下载必须是显式动作** | 见下方「知情下载」 | 静默下载把唯一的信任点藏在进度条后面 |

macOS arm64 因此从 osxexperts 换到 **`ffmpeg.martin-riedl.de`**：URL 按
`<构建时间戳>_<git 描述>` 定版且旧路径不被改写（实测保留 171 个历史版本，
2025-02 的构建今天仍可下载），每个归档旁边有官方 `.sha256`（代码里写死的值与它比对过），
静态链接、`ass` 与 `subtitles` 滤镜均已注册。
**ffmpeg 与 ffprobe 必须取自同一次构建**（§5.11 / `kvm.media.ffmpeg.ffprobe_for`：
ffprobe 报的时长与起始偏移直接进时间轴计算）。
Windows 仍用 `GyanD/codexffmpeg` 的**版本 tag**——GitHub release 资产在 tag 下不会被改写，
上面两个毛病它本来就没有；而 martin-riedl 只出 macOS 与 Linux，想统一也统一不了。

#### 知情下载

**开始下载前必须把「从哪个域名下、多大、SHA256 是多少」摆给用户看，等他点。**
理由与"自检不下载任何东西"同源：§2.6 把"获取"定义为显式动作。
清单本来就写死在代码里，如实报出来不多暴露任何东西，
而把它藏起来只留一条进度条，等于要求用户闭着眼睛信任我们选的第三方构建。
手工安装命令作为**并列**出路一起给出。

**失败路径要跟着一起验**（`tests/test_bootstrap.py`）：校验不过时必须删掉半截文件、
私有目录里不留任何东西、并给出带错误码的失败。
**这里踩过一个只在出错时才发作的坑**：`BootstrapError` 曾把占位符字典存进 `self.args`，
而那是 `BaseException` 的内建属性——赋值时被强制转成元组，值全丢、`str(exc)` 变成
`"('url', 'expected', 'actual')"`，HTTP 层再拿元组去填 `dict[str, str]` 直接 500。
后果是**恰好在有错误的时候**启动页轮询不到状态，只能永远转圈。
占位符现在叫 `detail_args`，并有回归测试守着。

配套硬性规则：

- **所有外部可执行文件的路径必须经由统一的解析层获取**，禁止在代码里散落 `"ffmpeg"` 字面量。解析顺序：应用私有目录 → 用户显式配置（环境变量 `KVM_FFMPEG`）→ 系统 PATH 探测 → 触发自动获取。
- **用户显式配置在它那一步是权威的：设了但探测不通过就直接失败，不许回退到别的候选。** 用户指定了一个 ffmpeg 却被静默换成另一个去渲染，等于预览与导出可能落在不同的 libass 上（§5.12），而这类分叉要到成片里才暴露。**静默换人比直接报错糟得多。**
- **应用私有目录的路径规则只允许有一份实现**（`kvm.paths`）。工程目录、媒体、模型权重、私有依赖、私有二进制都从它派生——散在各模块里各算各的，`KVM_DATA_DIR` 的语义就要靠读三处代码才拼得出来。
- **启动自检必须先于任何长任务**（`kvm.doctor`，§11）。宁可开机多花两秒，也不要让用户等 20 分钟分离完才发现 ffmpeg 不能烧字幕。
- **自检模块必须 stdlib-only**：它要在依赖尚未装好的环境里跑——那正是最需要它的时刻。第三方包一律**探测而不导入**；torch 必须在子进程里问（§5.13 禁止后端进程直接拉起 torch，且装坏的 torch 会段错误连自检一起带走）。
- **自检不下载任何东西。** 模型权重只报告有没有（§5.14：静默拉 1.3 GB 会被当成程序卡死），下载必须是显式动作。
- **每条检查都要自带"是不是启动的硬前提"。** 硬前提不满足就不启动；其余一律降级放行，并说清用户正在放弃哪些功能（§2.5 失败要降级不能终止）。判据只允许有一处定义，启动脚本不得另立一套。
- **字体缺字必须在渲染前拦截**。预览（JASSUB）与导出（ffmpeg）若 fallback 到不同字体，WYSIWYG 直接失效，而这类问题往往到成片里才暴露。
  单个字体覆盖不全是常态，所以字体是**有序候选链**（`KaraokeStyle.font_names`）而非一个族名——缺字时用谁，必须是工程里显式记着的一份数据，两端照同一份走（机制见 §5.12）。
  预检因此回答两个问题：**整条链够不够**，以及**每个字实际由链上哪个字体承担**。后者不是锦上添花——用户配了链却不知道链尾有没有被用到，等于配了个不知道有没有生效的东西。
- **预览用的子集字体必须按本曲字符集加裁**。子集默认只含 ASCII + 假名 + JIS X 0208 一/二水准，而「鷗」「𠮷」「①」「㍿」都在集合外，
  症状是**预览空白、成片正常**——与缺字相反的分叉，只看成片根本发现不了。本曲用到的额外字符由 ASS 头部的声明带给前端（§5.12）。
  **警惕这一条退化成死代码**：后端端点与前端客户端函数曾经都写好了、注释还引用着本节，却没有任何调用点——检查存在与检查生效是两回事，加接口时要连调用点一起验。
- 自检报告要能一键复制，便于排查环境问题。

---

## 3. 分发模式（已定 D0）

**D0：公开仓库 + MIT 许可证，经 GitHub Release 分发 macOS `.dmg` 与 Windows NSIS `.exe`。**

### 为什么是 MIT 而不是 GPL

运行时依赖里**没有一条 GPL**：yt-dlp 是 Unlicense、pycryptodome BSD、
audio-separator / torchcrepe / fontTools 是 MIT、librosa 是 ISC。QRC 解密是照公开常量
自己写的，没有抄 LDDC 那类 GPL 实现。没有传染源，就没有被迫按 GPL 发布的理由。

**本节曾写着"若将来开源本项目，按 GPL-3.0 发布即可"——那是当初打算直接依赖
LDDC / pykakasi / qqmusic-api-python 时的推论，而这些依赖最终一条都没进来，结论作废。**
由此得到一条仍然有效的纪律：**再引入一个 GPL 依赖 = 要改掉整个项目的许可证**。
这类库只能读它的端点与常量（事实不受版权保护）后自己重写，不要直接 import——§12 的
参考实现表已经逐条标了许可证，就是为了让这条判断在动手前就能做出来。

| 决策点 | 结论 |
|---|---|
| ffmpeg | **GPL 构建即可**。它是运行时下载、以独立进程调用的外部程序（§2.6「获取」阶段），不进安装包、不与本项目代码链接，因此不给本项目带来许可证义务。**具体用哪个构建以 `kvm.bootstrap` 里的清单为准**（macOS 取 martin-riedl，Windows 取 gyan.dev 的 **essentials**——它已含 `libass libfreetype libfribidi libharfbuzz`，而 full 是 266 MB、多出来的库本项目一个都用不到）|
| UVR / Roformer 权重（社区惯例授权，多数无 LICENSE） | **可用**。仍按 D11 运行时下载，理由是体积而非许可证 |
| 代码签名 / notarization | **仍然不做**，但理由变了，见下 |
| Tauri `externalBin` + notarization 冲突（issue #11992） | 仍不是阻断项。且 §5.15 另有一条独立理由（`--onedir` 产物是目录，`externalBin` 只收单文件），所以将来真去公证也不会被这条卡住 |

### 不签名不公证是有意的选择，代价必须写在 README 里

macOS 开发者账号 $99/年、Windows 证书同量级，而这是个人项目；不做签名是权衡后的结论，
不是遗漏。但**分发二进制之后 Gatekeeper 与 SmartScreen 的拦截就回来了**，
用户会撞上而不是读到——所以绕过方式（右键打开 / `xattr -dr com.apple.quarantine`；
SmartScreen 的「更多信息 → 仍要运行」）必须在三份 README 里写清楚。改签名策略时三份要一起改。

### CC-BY-NC 是**模型**的限制，不是代码的

这条在"公开仓库 + MIT"之下最容易被误读，所以说明白：
`MMS_FA` / `ctc-forced-aligner` 的权重是 **CC-BY-NC 4.0（禁止商业使用）**。
强制对齐目前尚未接入（§5.5 待实现），一旦接上，**限制落在"用了这份权重的那个构建及其产出"上**——
代码本身依旧是 MIT，而用它做出来的视频不得用于商业用途，除非先换掉对齐模型。
因此对齐后端必须保持可替换，不要把它的输出类型渗进核心数据模型（§4.2）。

### 随包分发的第三方资产另有一份清单

`THIRD-PARTY-NOTICES.md` 记录安装包里所有非本项目的字节（jassub 的 wasm 与它编进去的
libass / FreeType / HarfBuzz / FriBidi、随 jassub 附带的 Liberation Sans、前端与 Python
依赖图、Tauri 外壳），以及**运行时才下载、并不由本项目再分发**的那几类（ffmpeg、模型权重、
用户自己的系统字体）。它与 `LICENSE` 一起由 `scripts/package.py` 以 `--add-data` 塞进
安装包（落在 onedir 的 `_internal/`）。**增删随包分发的资产时要同步这份清单**——
"资产进了包、声明没进"是这类文件最典型的失效方式。

### 已被验证是错的做法：把字体丢进 `frontend/public/`

Vite 把 `public/` 整个目录**原样**拷进 `dist`，`dist` 又被 PyInstaller 整个塞进安装包。
所以在本机出包时，**`frontend/public/fonts/` 里躺着什么就发布什么**。
该目录已按 `.gitignore` 排除（本机那份 Noto 副本因此不在仓库里，CI 出的包也不含它），
但**正因为它不入库，本地留下的东西不会在 review 里被任何人看见**——而这个目录的用途
恰恰是放"从系统里提取出来的字体"，ヒラギノ / 游ゴシック 都是不得再分发的专有字体。
要随应用分发字体，只有一条路：显式加进仓库，并在 `THIRD-PARTY-NOTICES.md` 里登记。

**仍然保留的架构纪律**（与 D0 无关，是好设计）：模型后端与外部数据源集中在可替换的
adapter 层，核心数据模型（§4.2）只依赖自己定义的类型。这样换库、换模型、换分发模式都不用重写。

---

## 4. 架构总览

### 4.1 管线阶段与数据流

```
[1] 下载        yt-dlp  →  video.mkv（remux，不重编码）
                          ↓ ffmpeg 抽音频
[2] 音频规范化  audio_44k.wav（原始）+ audio_16k_mono.wav（喂模型）
                          ↓
[3] 人声分离    audio-separator  →  vocals.wav + instrumental.wav
                          ↓
[4] 歌词获取    provider 链 → LyricCandidate（粒度 word / line / plain）
                          ↓
[5] 重锚定      把歌词源时间轴对齐到 MV 音轨          ← 最大缺口，见 §5.3
                          ↓
[6] 读音/注音   形态素分析 + 词典 + 歌词源 ruby → mora 序列 + ruby span
                          ↓
[7] 强制对齐    CTC forced_align，只跑 locked=false 的区间
                          ↓
[8] 分行/段落   nicokara 两行交替 + 间奏检测 + 指示灯
                          ↓
[9] 编辑        三级调轴 UI + 注音编辑 UI（人工收口，可回到 [5][7] 局部重跑）
                          ↓
[10] 渲染       布局引擎（度量 + 坐标）→ ASS 序列化
                          ↓
        ┌─────────────────┴─────────────────┐
   JASSUB 预览                         ffmpeg 烧录
   （libass WASM）                （同一 libass commit）
```

**唯一真源是工程文件，不是 ASS。** ASS 只是渲染目标，从工程文件序列化产生，永远不被反向解析回来。这条不要动摇。

### 4.2 中枢数据结构：工程文件（`project.json`）

这是整个项目最需要讲透的部分：一个数据结构同时承载**文本 / 读音 / 注音 / 音节时间轴 / 样式 / 手工锁定标记**，并且要在自动重算时保护用户的手工修改。

#### 层级：Project → Line → Token → Mora

**Line**

| 字段 | 说明 |
|---|---|
| `id` | 稳定 UUID，不随重新分行变化 |
| `surface` | 该行完整书写文本（渲染用原文，不做归一化） |
| `tokens[]` | 见下 |
| `t_start_ms` / `t_end_ms` | 整数毫秒 |
| `paragraph_id` | 所属段落（间奏切分的产物） |
| `line_in_paragraph` | 段内序号，`% 2` 决定 nicokara 上/下槽位 |
| `role` | `main` / `bg` / `duet_a` / `duet_b`，驱动对唱分色 |
| `is_metadata` | 标记"词：xxx""曲：xxx"这类被歌词源塞进正文的制作名单行 |
| `locked` | 行级锁 |

**Token**（一个 token = 一个词/词素，是注音与读音挂载的单位）

| 字段 | 说明 |
|---|---|
| `id` | 内容寻址身份键，见 §4.4 |
| `surface` | 书写形式，如 `食べる` |
| `reading_display` | **表记读法**，片假名规范存储，显示时转平假名。用于生成 ruby |
| `reading_phonetic` | **发音形**，助词「は」在此为 `ワ`，长音为 `ー`。喂 G2P / 强制对齐 |
| `ruby[]` | `{s, e, rt}` 列表：surface 的字符区间 `[s,e)` → 注音文本。纯假名区间不出现在列表里 |
| `mora_ids[]` | 指向本行 mora 数组的连续区间 |
| `timing_granularity` | `provider_char` / `mora` / `line`，见 §4.3 |
| `source` | `auto` / `dict` / `provider` / `user_dict` / `manual` |
| `locked_reading` | 用户是否手工锁定了读音/注音 |

**`reading_display` 与 `reading_phonetic` 必须同时存在。** 只存一份是系统性 bug 源：注音行显示 `わ`（应显示 `は`），或者对齐器拿到 `は` 去找 /h/ 音素（实际唱的是 /w/）。默认由 display 推导 phonetic，允许高级用户单独覆写。

**但两份读音挂在字符区间上，不挂在 Token 上（实现如此，本节的表格是设计意图）。** 原因有二：

- 本仓的 `Token` 是**计时单元**（一个 `\k` 块，QRC 实测 99.1% 是单个书写字符），
  不是词/词素。把读音挂上去立刻撞上本节自己描述的粒度冲突——「学校」的 ガッコウ
  无法确定地劈给「学」「校」两个 token
- 表记读法走 `ruby` 区间，发音形走**平行的 `phonetics` 区间**。发音形不能并进 `ruby`：
  助词「は」读 ワ 这个案例恰好发生在**没有注音的纯假名字符**上，而纯假名区间按本节
  规定不允许出现在 `ruby` 里；反过来往 `ruby` 塞无注音条目也不行——渲染层会把每一条
  都做布局并画到成片上

两份读音**各自带 `source` 与 `locked`**：用户常常认可歌词源给的注音、只想改发音形，
共用一个锁表达不了这种情况。

要挂真正的词/词素层，前提是先有形态素分析（§4.5，**待实现**）。

**Mora**（时间轴的原子单位）

| 字段 | 说明 |
|---|---|
| `kana` | 单拍假名（拗音 `きゃ` 合并为一拍） |
| `phonemes[]` | 音素序列 |
| `surface_span` | 对应 surface 的字符区间 |
| `t_start_ms` / `t_end_ms` | 整数毫秒。**允许 `mora[i].t_end_ms < mora[i+1].t_start_ms`**，中间那段就是句内空隙（换气、词间停顿）——见下方不变式 |
| `timing_source` | `provider` / `aligned` / `interpolated` / `manual` |
| `locked_timing` | 用户是否手工拖过这个边界 |

#### 必须写进单元测试的不变式

1. `concat(mora.kana) === token.reading_display`
2. 每个 mora 的 `surface_span` 落在某个 ruby span 或某个假名字符上
3. ruby span 与假名字符**无缝、无重叠**地覆盖整个 surface
4. 同一行内相邻 mora **单调不重叠**：`mora[i].t_end_ms <= mora[i+1].t_start_ms`。
   **取等只是常见情况，不是要求**——两者之差就是句内空隙

**句内空隙必须保住。** 真实演唱有换气与词间停顿，而 QRC 的字级时间本来就是
`(start, duration)`、天然表达空隙。实测 633 个 token 的曲目里 **53 处相邻字之间有正空隙，
12 处 ≥100ms，最大 280ms**。

**不要把不变式写成"边界严格相等"**：那会把空隙并进前一个字，扫色就在没人唱的时候
继续往前爬，演唱者看着颜色走却无词可唱——这是卡拉OK 字幕最刺眼的一类错误。因此：

- **存储用 `(start_ms, dur_ms)`，`end_ms` 是派生量**。绝不能用"下一个字的 start"
  反推本字的 end，那等于把空隙信息抹掉（`models/karaoke.py`、`pipeline/qrc_import.py`
  已按此实现）
- **渲染给每个 token 发它自己的 `\t(本字start, 本字end, \clip(...))`**，空隙期间没有
  任何 `\t` 生效，clip 停在原地（`render/ass_builder.py` 已按此实现）。这也是不用
  `\k` 链式填充的原因之一——`\k` 的语义是首尾相接，表达不了空隙
- 因此**不存在 `sum(\k) === 行时长` 这条不变式**，本项目根本不用 `\k` 走字

#### 时间轴单位永远是 mora

surface 字符块的 `\k` 值 = 其所属 mora 时长之和。这样「学校」（2 字 4 拍）与注音行「がっこう」（4 拍）天然同步——这是 ASS 无 ruby 支持下唯一能让主行与注音行走字对齐的建模方式。

#### 粒度冲突的裁决（这是最容易在第一次 QRC 导入时爆炸的地方）

三种时间轴来源的粒度不同：

| 来源 | 粒度 |
|---|---|
| QRC / KRC | **surface 字符级**：`学(t1,d1)校(t2,d2)` |
| 强制对齐 | **mora 级** |
| 行级 LRC | **行级** |

从 QRC 导入时，你**无法**把 `学(t1,d1)` 精确拆成 `が/っ/こ/う` 四拍。裁决如下：

- **token 记录它的权威粒度** `timing_granularity`
- 权威粒度以下的 mora 时间由等分插值产生，`timing_source = "interpolated"`
- **`interpolated` 的 mora 边界永远不是锚点**：强制对齐可以自由覆盖它们；UI 上用不同颜色显示（提示"这是推算的，不是真实测得的"）
- 权威粒度层面的时间（即 QRC 给的字符块边界）标 `timing_source = "provider"`，重跑对齐时作为软约束
- **禁止把插值结果标成 `provider` 或 `aligned`** —— 伪造粒度会让后续所有判断失去依据

### 4.3 各阶段如何读写工程文件

| 阶段 | 读 | 写 |
|---|---|---|
| 歌词导入 | — | Line.surface / Token.surface / ruby（若源有）/ mora 时间（按源粒度，标 `provider`） |
| 重锚定 | 全部 mora 时间 | 平移/拉伸后的 mora 时间，`timing_source` 不变 |
| 读音/注音 | Token.surface | `reading_display` / `reading_phonetic` / `ruby[]` / Mora.kana（**只覆盖 `locked_reading=false`**） |
| 强制对齐 | `reading_phonetic` → 音素、已锁定边界作硬约束 | mora 时间，标 `aligned`（**只覆盖 `locked_timing=false`**） |
| 分行/段落 | Line 边界 | `paragraph_id` / `line_in_paragraph`（**只覆盖 `locked=false`**） |
| 编辑 UI | 全部 | 任何字段 + 对应的 `locked=true` + `source="manual"` |
| ASS 生成 | 全部 + 样式 | 不写工程文件，只产出 ASS |

### 4.4 横切机制：`(value, source, locked)`

**这是全项目最重要的一条抽象。** 注音的 L3 覆盖、对齐的 `syllable.locked`、歌词源的"来源徽章"、前端的边界数组，其实是同一个机制的四个视角。统一为：

> 任何自动产生的值——读音、注音、时间边界、分行、段落归属、声部归属——都带 `(value, source, locked)`。任何自动重算**只覆盖 `locked=false` 的项**。UI 用颜色区分 source。

配套的**token 身份键**（这是"手工修改保护"能不能真正成立的关键）：

- **绝对不要用「第几行第几个 token」做主键** —— 重新分行 / 重新对齐后必然漂移，锁定项会全部错位
- **重绑失败的锁定项不要静默丢弃**，收进「失效修正」列表让用户确认。静默丢弃 = 用户调了 40 分钟的轴莫名其妙消失

#### 内容寻址的 tid 只能做**行内**主键，不能用来定位是哪一行（已实测）

tid 是 `(归一化行文本 hash + 该文本在全曲第几次出现, surface, 该 surface 在本行的第 n 次出现)`。
**拿它去定位行会错绑**：副歌重复行（同一句出现 4 次）只要其中一句被改写，后面几句的
"第几次出现"就整体前移一位——用户在第 1 段副歌调的轴会被搬到第 4 段上，而两段歌词
一模一样，**肉眼根本发现不了**。赤春花实测：按这个方案重新导入，错绑 42 个音节。

正确的两层分工：

| 层 | 用什么 | 为什么 |
|---|---|---|
| **哪一行对哪一行** | **整曲字符对齐**（把新旧全文各拼成一条长串跑一次 diff，只映射两边完全一致的字符） | 重复片段必须放在全曲上下文里才分得清。逐行单独去比对同样会错——拆出来的后半段「宙を舞って」单独和整行比，diff 只认第一处「舞って」 |
| **行内落到哪个 token / 区间** | **tid 为主、字符偏移兜底** | 这一层 tid 无可替代：拆出来的半行仍带原行的 tid，`#っ#1` 明确指向"本行第 2 个っ" |

兜底的字符偏移**要求映射后的区间与目标严格重合**，只差一个字就宁可不绑。

> **绑错比绑不上更糟。** 绑不上会进「失效修正」清单让用户看见；绑错是静默的，
> 而且发生在重复片段上时用户永远不会发现。任何重绑策略都应当按这条来取舍。

实测命中率（633 token / 178 段注音全部锁定）：一字不改重导 100%；改写 20 行 96.8%；
用户先把 60 行拆成 117 行再改写 5 行仍 99.2%；**全部场景错绑为 0**。

### 4.5 读音的四/五层优先级模型（**待实现**）

**现状：生产代码里只有歌词源自带的 `[kana:]` 这一层（L1.5）。**
形态素分析（L0）、通用词典（L1）、用户词典（L2）都不存在，`backend/kvm/` 里没有 fugashi / SudachiPy / pyopenjtalk 的任何引用。
另外 **`reading_phonetic` 字段在工程模型里还没有**——§4.2 要求两份读音必须同时
存在，目前只有一份，注音编辑器的发音形是前端本地暂存的过渡措施。

自动读音按优先级合并求值（高层覆盖低层）：

| 层 | 来源 | 说明 |
|---|---|---|
| L0 | 形态素分析器自动 | fugashi + unidic-lite，或 SudachiPy + sudachidict-core |
| L1 | 通用词典 | JmdictFurigana / JmnedictFurigana，给出逐字切分 |
| **L1.5** | **歌词源自带 ruby** | **QRC / KRC 的 `[kana:]` 轨。优先级高于 L1** |
| L2 | 用户词典（跨歌曲全局） | 同时注入 MeCab / Sudachi / pyopenjtalk 用户词典 |
| L3 | 实例覆盖（本曲局部） | 手工修正 + `locked` |

**L1.5 的优先级高于 L1 是刻意的**：`[kana:]` 是该曲的**实际演唱读音**，JmdictFurigana 是**通用词典读音**。日语歌词里大量当て字（「運命」唱作 さだめ、「時間」唱作 とき），前者更准。

求值规则：`effective = L3 if L3.locked else (L2 if hit else (L1.5 if hit else (L1 if hit else L0)))`

**注意**：`[kana:]` 只给 `reading_display`，**不给 `reading_phonetic`**。助词「は」在 kana 轨里标的是「は」还是「わ」不确定，长音、「ん」的音位变体无法从假名串确定性还原。所以拿到 kana 后仍需推导 phonetic —— 这条路径能否走通取决于「`pyopenjtalk.g2p` 吃纯假名串时的行为」，见 §9。

---

## 5. 技术选型

### 5.1 视频下载

**`yt-dlp`**，以 Python 库方式调用（`import yt_dlp`）。

- format：`bv*+ba/b`，`merge_output_format: 'mkv'`（中间产物，vp9/av1+opus 组合兼容性最好）
- 这一步是 remux（stream copy），不重编码
- 进度：`progress_hooks` 回调
- 异常：`yt_dlp.utils.DownloadError`。**注意 `ExtractorError` 不是它的子类**，且设 `ignoreerrors=True` 时下载失败不抛异常、静默返回，必须额外检查 `download()` 返回码
- **yt-dlp 版本检测 + 一键升级必须做成产品功能**。YouTube extractor 因签名解密/PO Token 策略变化频繁失效，这是运维常态。pip/uv 安装的 yt-dlp 不能用内置 `-U` 自更新（`is_non_updateable()` 会拒绝），升级动作 = 子进程跑一次 `uv pip install -U --pre "yt-dlp[default]"` 后重启后端
- 预留 `--cookies-from-browser` 与 PO Token Provider（`bgutil-ytdlp-pot-provider`，需 Node.js 20+ 或 Deno 2.0+）作为降级路径

**不要把"当前不需要 cookie / PO Token"当成长期保证。** 实测过某支 MV 无鉴权即可取到含 2160p 的 31 个 format，但 YouTube 的策略随时会变，这类结论只是时间快照。

### 5.2 歌词源

**已定：Provider 抽象 + Resolver 打分 + 粒度提升，provider 只负责"取回并归一化"，不负责选择。**

```
LyricProvider.search(query) -> [TrackMatch]
LyricProvider.fetch(match)  -> LyricCandidate
LyricResolver.rank(candidates, target) -> 排序
promote(candidate, audio) -> 粒度提升（line→word 用受约束强制对齐）
```

Resolver 打分维度：粒度（word ≫ line ≫ plain）× 时长差（`|dur - target| < 3s` 强加分）× 标题/歌手模糊匹配 × 官方推荐标记。

**铁律：粒度可以被提升，不能被伪造。** 提升产生的时间轴 `timing_source` 必须标 `aligned` 而非 `provider`，UI 上必须有来源徽章。

Provider 清单（**优先级未最终裁决，见 §9**）。
**现状：只有 QQ 音乐接入了生产链路**（`backend/kvm/lyrics/`），其余各源仍停留在 `experiments/` 下的实验脚本，尚未进 `kvm.lyrics` 包：

| Provider | 粒度 | 端点/方式 | 状态 |
|---|---|---|---|
| QQ音乐 QRC | 逐字 + `[kana:]` + 罗马音 + 翻译 | `POST https://u.y.qq.com/cgi-bin/musicu.fcg`，`module=music.musichallSong.PlayLyricInfo` / `method=GetPlayLyricInfo`，param 含 `crypt:1, qrc:1, roma:1, trans:1` | **已实测端到端闭环，全程零 Cookie**。第一版主源，实现见 `experiments/qrc_decrypt.py` |
| 酷狗 KRC | 逐字 + `[kana:]` | 三步：`mobiles.kugou.com/api/v3/search/song` → `krcs.kugou.com/search` → `lyrics.kugou.com/download`；解密 = base64 → 去 4 字节 `krc1` 头 → 与 16 字节密钥 `40 47 61 77 5E 32 74 47 51 36 31 2D CE D2 6E 69` 循环 XOR → zlib | 已实测端到端跑通 |
| 网易云 | 行级 LRC + 中译 + **按拍分词罗马音** | `music.163.com/api/song/lyric?id=...&lv=1&kv=1&tv=1&rv=1` | 已实测；**匿名 API 与匿名 eapi 都拿不到 yrc 逐字**，别为 yrc 投入 eapi 工程量。**计划接入**：作为行级兜底与 QQ 的交叉校验源，不指望它提供逐字轴 |
| YouTube 官方 ja 字幕 | 句级，**已在 MV 时间轴上** | yt-dlp `subtitles.ja`（与 `automatic_captions` 分离即人工轨） | 已实测，65 行。**最稳的兜底，完全不依赖中国大陆 API** |
| LRCLIB | 行级 | `https://lrclib.net/api/search`，无鉴权 | 已实测 |
| UtaTen | 纯文本 + **权威 ruby** | 页面 `<span class="rb">/<span class="rt">` 成对 | 已实测可抓 |
| 用户手动粘贴 | 纯文本 | — | 必须留这个口子 |

**QRC 解密**：hex → **魔改（有 bug 的）3DES-ECB** → zlib inflate。密钥 ASCII `!@#)(*$%123ZXC!@!@#)(NHL`。腾讯的 DES S-box 有笔误（sbox2 第 2 行第 8 项是 15 而非 14；sbox4 第 4 行第 6 项是 10 而非 1 等），**`pycryptodome` / `cryptography` 的标准 DES3 解出来是垃圾**。可移植来源：MIT 的 `WXRIW/QQMusicDecoder`（C#）、`jixunmoe-go/qrc`（Go）、`wangqr/QQMusicDES`（C）；GPL 的 `chenmozhijin/LDDC`（Python，`core/decryptor/tripledes.py`）质量最高但会污染闭源分发。

**歌词源覆盖率不能拿"有商业发行的曲目"去论证。** QQ 的入库时间跟的是**数字配信/实体发售**，
不是 MV 公开日；拿一首有单曲发行的歌去验证，测的是"商业发行曲的覆盖率"，
**"只有 MV、无同步发行的新歌"这个场景根本没被覆盖到**——样本选择偏差正好就是被测变量本身。

由此三条：

- 「20 首日语曲 20/20 命中 QRC」之类的结论只适用于有商业单曲发行的曲目，置信度视为 medium
- 强制对齐兜底路径**不能降级**
- 需要另找一首"只有 MV、无同步商业发行"的真新歌重测

### 5.3 时间轴重锚定（最大的缺口，尚无验证过的方案）

**问题**：所有中文平台的歌词时间轴对齐的是**流媒体母带**，不是 YouTube MV 音轨。MV 常有不同的前奏长度、淡入淡出、专属剪辑。**必须做全局 offset + 逐句漂移校正，但具体怎么做尚无验证过的方案。**

**不要用"两份人工标注一致"去证明音轨时间基准一致。** 拿 YouTube 官方句级人工字幕对比
网易句级 LRC，两者都是人手打的句级轴、本身就有 ±100ms 的随意性，它们吻合说明不了任何事。
据此得出"偏移是全局单一常数、不必写重对齐"的结论是错的，不要用它简化架构。

**待实现的设计方向**（未经验证，实现时必须先做实验）：

1. 用分离出的 `vocals.wav` 做能量/onset 包络，与歌词源首字时间做互相关，估全局 offset
2. 行级锚点做 RANSAC 拟合仿射变换（offset + scale），抗离群
3. 残差过大的段落降级为分段线性；MV 有额外前奏/间奏剪辑时必然需要 DTW warp
4. 校准置信度低于阈值的段落标记为「需人工确认」，在 UI 上打红标，**不要静默输出错的轴**

这是「有 QRC」和「能用 QRC」之间的唯一桥梁。不解决它，QRC 全链路跑通也交付不了第一个视频。

### 5.4 人声分离

**`audio-separator`**（PyPI `audio-separator`，当前 0.44.5，MIT，Nomad Karaoke 维护），不要直接封装 `demucs`。它把 MDX / VR / MDXC-Roformer / Demucs 四种架构收敛到一个 `Separator` 类和一套模型文件名命名空间。

档位（暴露给用户三档）。**前后端一律传档位 id，不传模型文件名**——文件名属于
audio-separator 的命名空间，换模型不该逼前端跟着改。档位表由后端
`kvm.media.separate.MODEL_TIERS` 单点定义，经 `GET /api/media/separate/models` 下发：

| 档位 id | 模型 | 用途 |
|---|---|---|
| `fast` | `htdemucs.yaml`（84 MB） | 首次导入立刻出个能听的伴奏，让用户开始调轴；4 声部，顺带产出鼓轨供节拍检测 |
| `standard`（默认） | `mel_band_roformer_kim_ft_unwa.ckpt` | 比 BS-Roformer 快约 2.3x，SDR 仅低 0.1 |
| `best` | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | 639 MB，质量最高，最慢 |

实测（macOS arm64 / MPS，真实素材）：扣掉固定开销后每 30s 音频的推理成本约
**2.0s / 4.0s / 10.1s**，standard 约为 best 的 2.4 倍速。三档 corr(原混音, 各声部之和)
= 0.991 / 0.9996 / 0.998。

三条会咬人的事实：

- **声部命名三种约定并存**，消费端必须归一化后再判类型：htdemucs 给 `(Vocals)/(Bass)/(Drums)/(Other)`，
  BS-Roformer 给 `(Vocals)/(Instrumental)`，而 **MelBand 给小写 `(vocals)/(other)`——
  它的 `other` 就是完整伴奏，不是 4 声部里的那个 other**。判据要看有没有 Drums/Bass，不能看键名
- **audio-separator 一律把输出重采样到 44.1kHz**（源是 48kHz 时也一样），下游混音要留意
- **绝不用合成信号测分离模型**：BS-Roformer 在人工合成的混音上输出数字静音
  （mean = max = −91.0 dB），同一模型在真实音乐上是正常的 −17.0 dB。拿合成信号测会得出
  "模型不可用"的假结论。**测试素材必须是真实音乐**

设备策略（**已定**）：

| 平台 | device | 备注 |
|---|---|---|
| macOS arm64 | MPS | 「Demucs 因复数张量不兼容 MPS」的说法在 2026 年已过时且错误；Demucs 4.x 默认就选 mps |
| Windows + NVIDIA | CUDA + `use_autocast=True` | autocast 在 CUDA 上收益 2-3x（Roformer），MPS 上只有约 1.1x |
| Windows 纯 CPU | CPU | 必须降档到 htdemucs / MelBand，UI 明示预计耗时 |

- **Roformer 在 Windows 上无法通过 DirectML 加速**（torch-directml 显存分配器扛不住其推理循环，官方 README 列为已知上游限制）
- macOS 的 CoreMLExecutionProvider **只覆盖 MDX 的 .onnx 模型**，不覆盖 Roformer。别为了"用上 CoreML"而降档
- `mel_band_roformer_karaoke_*` 系列分的是**主唱 vs 和声**，不是人声 vs 伴奏。名字极具误导性
- `demucs --two-stems=vocals` **不省时间**（仍跑完整 4 源前向再求和）

### 5.5 强制对齐（**待实现**）

**现状：生产代码里完全没有强制对齐。** 时间轴全部来自歌词源的逐字轴，`backend/kvm/` 里没有 torchaudio / forced_align 的任何引用。
本节是选型与设计，动手前不要假设它已经存在。

**`torchaudio.functional.forced_align`** + 纯平假名 CTC 声学模型 **`vumichien/wav2vec2-large-xlsr-japanese-hiragana`**（86 个 token，其中 83 个假名 + `|` + `[UNK]` + `[PAD]`，apache-2.0，1.26 GB）。

选它而非 MMS_FA 路线的理由：MMS_FA 需要 `uroman` 罗马化，而 **uroman 把日语汉字按普通话读音罗马化**（官方 README 明确承认）。既然都要先转假名，不如直接用假名 vocab 的模型，CTC token = 假名 = mora，正好是 ASS `\k` 需要的填充单元。

分层执行：

1. **粗定位**：行级锚点。歌词源已有行时间就直接用；没有就用 `faster-whisper` 转写 + `difflib.SequenceMatcher` 模糊匹配
2. **精对齐**：按锚点把音频与假名序列切成互不重叠的区间，逐区间独立 `forced_align`（该 API 本来就 `batch_size==1`，天然契合）
3. **后处理**：拗音（`きゃ`/`しゅ`/`ちょ`）合并成单个 `\k` 块；`っ` 并入前块（声学上是静音，CTC 发射极不稳定）；`\k` 时长用「下一块起点 − 本块起点」推导，**不用 CTC 给的 offset**（长音 `ー`、melisma 拖腔上 CTC 结束时间不可信）

明确不选：

- **不选 MFA 作主链路**：精度确实最好（日语 CSJ 10.82 ms），但要 conda + Kaldi，Tauri 打包成本高；且该数字来自**朗读语音**，模型训练语料 100% 朗读，歌声上会明显退化。可作为高级用户可选后端
- **不选 WhisperX / stable-ts 作逐字对齐**：日语默认对齐模型 vocab 有 2341 个含汉字的 token，汉字 token 发射概率不可靠 —— 它"跑得通"，但会得到看起来正常实则错位的轴，比报错更危险。只用它们做锚点/兜底转写

**精度期望（必须写进产品预期）**：wav2vec2 帧量化下限 20 ms；多声部歌曲词对齐 SOTA 约 <0.2 s；神经 CTC 在**朗读语音**音素边界上就已是 ~110 ms 级。分离人声后假名起点误差预计落在 **50–150 ms**。对"整行同时亮起"够用，对"逐字擦除严丝合缝"不够。**这就是三级调轴 UI 必须是一等公民的原因。**

歌唱 vs 朗读的声学失配是本方案最大不确定性来源：所有候选日语模型（vumichien / jonatasgrosman / MFA japanese_mfa）都在朗读语料上训练。唯一歌声原生的选项是 `SOFA`（`qiuqiao/SOFA`，MIT）的社区日语模型，可作为困难段落的实验分支，不做主链路。

### 5.6 日语读音与注音

| 用途 | 包 | 理由 |
|---|---|---|
| 形态素分析（默认） | `fugashi` 1.5.2 + `unidic-lite` 1.0.8 | 有 macOS arm64 / Windows x64 预编译 wheel，MIT + BSD |
| 形态素分析（新词） | `SudachiPy` + `sudachidict-core` | Apache-2.0，词典持续更新（最新 20260723），对新歌专有名词覆盖更好 |
| Windows 兜底 | `fugashi-plus` | 修了 Windows 词典路径与 MeCab 上游停更问题，import 名仍是 `fugashi` |
| 逐字注音切分 | `JmdictFurigana`（`Doublevil/JmdictFurigana`，CC BY-SA） | 给出 `食べる → 0:た` 这种逐字索引，直接解决送り仮名切分 |
| 音素 / mora / G2P | `pyopenjtalk-plus` 0.4.1.post8（MIT） | **不是 `pyopenjtalk`** —— 上游在 PyPI 只有 sdist，Windows 装机失败率高 |
| 假名归一化 | `jaconv` 0.5.0（MIT） | 平假名↔片假名、半角↔全角 |
| 英文转片假名 | `kanalizer` 0.1.1（MIT，VOICEVOX） | 完全离线，补 MeCab/OpenJTalk 对未登录英文词的短板 |
| 汉字分级 | 自行从 KANJIDIC2（CC BY-SA 4.0）导出静态表 | **不要运行时依赖 `joyo` 包，它会联网** |

**明确排除**：`pykakasi`（GPL-3.0-or-later，且无上下文消歧）、`furiganamaker`（GPL-3.0 + 依赖 pykakasi）。

**JmdictFurigana 的键必须是 `(表記, 读音)` 二元组**，不能只用表記 —— 数据里 `明白|めいはく` 与 `明白|あからさま` 是并列条目。正确顺序：先由形态素分析器确定读音，再拿 `(surface, reading)` 查逐字切分。反过来会在多音词上系统性出错。

查不到时的**假名锚点对齐算法**（约 80 行）：surface 按字符类切成交替的 `[汉字块][假名串]`；假名串统一片假名后在 reading 中做 DP 匹配作锚点；剩余段按位置分给汉字块。**必须带连浊/促音便等价表**（手+紙→てがみ、一+本→いっぽん），否则失配率显著上升；无解时降级为整块一个 ruby（可接受，nicokara 风格常见整词注音）。

注音范围：内嵌 KANJIDIC2 导出的 `汉字 → grade` 表，四档开关（全部汉字（卡拉OK 默认）/ 常用漢字表外 / 小学 N 年级以上 / 关闭）。

### 5.7 ASS 生成

**已定：ASS 生成层分四层，全放在 Python 后端。**

1. **语义时间轴模型** —— 就是 §4.2 的工程文件，不是 ASS
2. **布局引擎（核心工作量，自己写）** —— 输入语义模型 + 样式，输出"已定位的绘制单元"
3. **ASS 序列化器**
4. **渲染器绑定与一致性保障**

布局引擎必须做的事：

- 用与 libass 一致的字体度量测每个 syllable 的 advance 宽度（叠加 ScaleX、Spacing、PlayRes 缩放）
- 主歌词行：自己算 X（按对齐方式）和 Y（自己管两行交替槽位），**一律 `\pos` + `\an`，不依赖 libass 碰撞检测**
- 注音：照抄 karaskel 的 layout group 算法（**注意它是两趟遍历**，且 `|` `#` `!` `<` 四个符号的解析在 `preproc_line_text` 而非 `do_furigana_layout`，移植时要一起搬；第一趟里 `0 < furiwidth <= basewidth` 分支也要计算负 spill 用于组间避让，漏掉会导致相邻组重叠）

#### 度量必须用尾随标记块法（已实测）

度量方式是**让 libass 自己渲染再从像素反推**，不用 `uharfbuzz` 近似——这样坐标定义与最终
渲染天然一致，且不读 hmtx/kern、不做 shaping 推演，对任意自定义字体都兼容。

但**量法只有一种是对的**：

| 量法 | 做法 | 结果 |
|---|---|---|
| 墨迹差分（❌ 禁用） | 量前缀墨迹右边界后差分 | 差分值 = `advance + (前字rsb − 本字rsb)`，混入 side bearing。同字体下全角字符给出 `明:45 ま:52`，本应相同 |
| **尾随标记块（✅ 采用）** | 每个前缀后加 `█`，由其位置反推 | 全角字符 advance 恒定（`明:50 ま:49`，±1px 取整） |

在 4 个风格迥异的字体（Noto Sans CJK JP / Hiragino Sans / Hiragino Mincho ProN / YuGothic）
与日英混排文本上均成立：CJK advance 恒定，西文按比例各异。实现见 `render/text_metrics.py`。

两条派生的硬性规则：

- **注音居中于基字的 advance 格位，不是墨迹包围盒。** 用墨迹中心会在日英混排下产生肉眼可见偏移
- **`Fontsize` ≠ em size。** 字号 72 时 Noto Sans CJK JP 的 CJK advance 仅 50px（≈0.694）。
  注音字号、行距、间距一律以**实测 advance** 为准，禁止拿字号硬算

#### 描边同步翻色用双层 + 渐进 clip（已实测）

libass 支持 `\t(t1,t2,\clip(x1,y1,x2,y2))` 的矩形 clip 动画，且 clip 边界严格单调推进、
精确吻合线性插值。因此**每句只需 2 个 Dialogue 事件**：底层未唱色、顶层已唱色 + clip 动画，
不必退化成逐音节静态 clip 导致事件数暴涨。这是 nicokara 招牌观感（黑边→白边）在纯 ASS
下的干净解法。

**ASS 标签语义要点（已从 libass 源码核实）**：

| 项 | 结论 |
|---|---|
| `\k` 单位 | **厘秒**，libass 内部 `dtoi32(val * 10)` 转毫秒 |
| `{\k}` 无参数 | 默认 **100 厘秒 = 1 秒**，不是 0。生成器绝不能输出裸 `{\k}` |
| `\kf` 与 `\K` | 完全等价，同一分支 |
| `\ko` | 高亮前去掉描边，到时间点瞬间出现描边 |
| `\kt` 单位 | 也是厘秒（与 `\k` 一致）。**需要 libass ≥ 0.17.0** |
| 取整 | 对**累积时间点**取整再取差：`k_i = round(t_i/10) - round(t_{i-1}/10)`。逐个 round 会累积漂移（每字最多丢 9ms，20 字一行就是 180ms） |
| `\t` 可动画集合 | `\fs \fsp \fscx \fscy \frx \fry \frz \fax \fay \c \1c-\4c \alpha \1a-\4a \bord \xbord \ybord \shad \xshad \yshad \be \blur` + **仅矩形版** `\clip`/`\iclip`。`\pos` `\org` `\fn` 粗斜体 矢量 `\clip` **不能动画** |
| `\pos` 坐标 | **必须取整**。小数坐标（`\pos(300.1,400)`）打破 libass 的 composite bitmap 缓存，逐帧展开时性能会崩 |
| 逐帧展开 | 对 libass 性能影响很小（官方渲染器内幕文档明说）。真正的成本是**同帧 bitmap 总面积**和 blur padding（每边约 7×blur 像素） |
| 换行 | 始终显式 `\N`。libass 的 WrapStyle 0/3 未按规范实现 |
| 已知 bug | libass #124（行首 `\kf0`/`\K0` 整行卡在 SecondaryColour）未修。**零时长音节必须合并或改用 `\kt`** |
| `\kf` 方向 | 恒为水平向右。旋转（#293）与 RTL（#406）下是错的 |

libass 扩展可以放心用（链路两端都是 libass）：`BorderStyle=4`（整条 event 画矩形底板）、`Language:` 头（影响汉字字形选择）、`Kerning: yes`。

### 5.8 nicokara 视觉规格

**默认预设 "NicoKara Classic"（PlayResX 1920 / PlayResY 1080）**，数值来自 `FMPeach/Kirakara-Player` 的 720p 配置 ×1.5（该项目是个人小项目，非官方规格，作为**起点**而非权威）：

| 项 | 值 |
|---|---|
| 上行 | 左对齐，X=192，Y(顶)=645 |
| 下行 | 右对齐，右边距=192，Y(顶)=845 |
| 槽位分配 | `line_in_paragraph % 2`（偶数上、奇数下） |
| 安全区 | 90%（1080p 下左右各 ≥100px）；单行 12–20 全角字符；`WrapStyle: 2` |
| 字体 | `源真ゴシック Heavy`（GenShinGothic-Heavy，SIL OFL 1.1，随应用打包）；兜底 `Noto Sans JP Black` |
| 主文字号 | 96，Bold，字距 +13 |
| 注音字号 | 39（= 0.40× 主文），不加粗，字距 +7，与主文垂直间隙 6px |
| 未唱 | Primary `&H00FFFFFF`（白），Outline `&H00000000`（黑） |
| 已唱 | Primary `&H000000C8`（RGB 200,0,0），Outline `&H00FFFFFF`（白） |
| 描边 | 主文 Outline=6，注音 Outline=4；`ScaledBorderAndShadow: yes` 必开 |
| 纯色背景兜底 | `#005500` |
| 提前入场 | 段落首行 4.2s（≈ 经典的 fade 0.666 + 0.5 + indicator 3s）；其余行至少 2.0s |
| 淡入淡出 | **每一句都淡**，400ms 进 400ms 出（见下方「淡化不是段落首末行的特权」） |
| 指示灯 | 4 个圆点，仅段落首行，总时长 3s，每 0.75s 熄一个，**从右往左**；直径 51px，间距 18px，白填充 + 黑描边 4.5px |
| 全局 offset | 必须有旋钮（对应 NicoKaraMaker 的 `@Offset=`） |

**淡化不是段落首末行的特权。** 参考资料里的"666ms，仅段落首/末行，段内走完即切"经实测
观感不成立：段内换句密集处硬切很跳——一句忽然消失、另一句忽然顶上。**每一句都淡入淡出。**

时长不照搬 666ms：那个值是给段落首行的，那里有整段间奏可用。每句都淡时，密集段
（赤春花实测隔行同槽位间隔 p10 仅 2.3s）会有大半时间挂在半透明状态。**400ms** 在 30fps 下
是 12 帧，看得出是"浮现"而不是硬切，又短到不占阅读时间。实现细节见 §8.5「时间」。

**配色说明**：这套「白字黑边 → 红字白边」不是"日本业界标准"，而是同人 nicokara 圈一位博主总结的实践（参考了 DAM R≈150 / JOY R≈200 的机型观察）。作为**默认预设合理，不是唯一正确答案**。样式系统必须支持自定义。

**不要照抄的东西**：`Kirakara-Player` 的默认字体是 `Microsoft YaHei`（中文字体、闭源不可再分发、macOS 上不存在、汉字是大陆字形，日语用会露馅）；`nicokara-studio` 的默认配色是反的（黑字白边→纯红）。

### 5.9 预览层

**`jassub@2.5.14`**（npm 包名 `jassub`，锁死版本）。它是当前更新最活跃的浏览器端 libass 渲染器。

- 明确排除：`SubtitlesOctopus` / `libass-wasm` / `@jellyfin/libass-wasm`（维护强度低的 fork）、`assjs` / `libjass`（DOM 渲染，与 WYSIWYG 硬约束冲突）
- `ass-compiler@0.1.16` 可留着做 JS 侧的 ASS 解析/序列化，它不是渲染器

**核心用法**：初始化时 `subContent` 一次性喂入，之后所有编辑走 `await instance.renderer.setEvent(event, index)` / `createEvent` / `removeEvent` / `setStyle` 做增量更新，**不要 `setTrackByUrl` 重载整个文件**。样式试验用 `styleOverride(style)`。

**两个必踩的坑**：

1. JASSUB **只在 rVFC 回调里重绘**。编辑器 90% 时间视频是暂停的，改了字幕不会自动刷新 —— 每次 `setEvent` 后必须显式 `manualRender(lastFrameMeta, true)`
2. `instance.renderer.*` 每个调用都是跨 worker 的 IPC 代理，**不 await 等于没执行**。拖拽时每个 mousemove 都 await 会串行排队卡顿，要 rAF 节流 + 丢弃中间帧

**COOP/COEP 第一天就配**（已定 D14），不要等后期加 Tauri 壳才发现：

| 位置 | 设置 |
|---|---|
| Vite dev server | `server.headers` 设 `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin` |
| Tauri | `app.security.headers` 设同样两个头（**需要 Tauri ≥ 2.1.0**，2.0.0 GA 没有此配置项） |
| FastAPI 媒体响应 | `Cross-Origin-Resource-Policy: cross-origin` + CORS 允许前端 origin |
| `<video>` | `crossorigin="anonymous"` |

少配一个，开发期就会表现为媒体全部加载失败。

**JASSUB v2 砍掉了 v1.x 的 `dropAllAnimations` / `targetFps` / `onDemandRender` / `blendMode` / `useLocalFonts` 等选项。** 网上教程和 AI 生成的代码大量还在用，传进去只会被静默忽略。以 `src/jassub.ts` 的 `JASSUBOptions` 类型为准。

### 5.10 波形与三级调轴交互

**`wavesurfer.js@7.x`** + `regions` 插件（不是 peaks.js）。理由：`media` 选项能直接挂到同一个 `<video>`；`peaks` + `duration` 能吃后端预算好的峰值跳过解码；v7 renderer 已有基于 scrollLeft 的懒渲染分块。

峰值数据应由 **Python 后端预计算**（ffmpeg 解码 → numpy min/max，多级 LOD），输出 BBC waveform-data 格式。**不要打包 `audiowaveform` 二进制**——为一个 min/max 循环多背一个原生依赖不划算。

**后端接口已就绪，前端只接了一半。** 两个端点都在（`GET /api/media/waveform/{project_id}/{kind}` 给多级 LOD 的峰值、`GET /api/media/probe/...` 给时长/采样率/声道/体积），媒体探测前端已在用。

**但波形仍由 wavesurfer 自己 fetch + 整段解码**，后端算好的峰值没人消费。由此素材舞台还留着那个权宜实现：多条轨的波形挂载排成队列、一次只解一条，否则内存与主线程被顶爆。接上 `peaks` + `duration` 之后这段排队逻辑可以删掉。

**交互形态（按实际效率排序）**：

1. **粗调用 tap-to-time**（Aegisub 至今没有，issue #91 开了 8 年）：0.5~0.75x 播放，空格/回车每个音节敲一次，一遍下来误差约 ±80ms
2. **交给强制对齐精修**（主力，人不该逐音节手调 500 个边界）
3. **波形上拖边界做局部修正**：拖拽 + 磁吸到能量突变点 + 方向键微调（←/→ ±10ms，Shift ±1 帧）+ Aegisub 那套 Q/W/E/D 试听快捷键

**不要做"在波形上框选每个音节"这种交互**，实测最累。

**同步（已定 D15）**：

- 全程用 rVFC 的 `mediaTime` 驱动高亮，**不用 `video.currentTime`**（Firefox 默认量化到 2ms，规范上只是"近似值"）
- `<video>` 永远静音，**音频全部走 Web Audio**：vocals / instrumental 两条 stem 作为两个 `AudioBufferSourceNode` 同时 `start`，用 `GainNode` 切换/交叉淡入。两条 stem 来自同一次分离，天然采样级对齐；"原声" = 两者相加
- 视频作为从动方，按 40~50ms 阈值纠偏
- W3C 明确指出音频经 `MediaElementAudioSourceNode` 离开 media element 后无法再与其他流保持同步 —— 所以"unmute 视频 + 另一个 `<audio>` 跟随"的做法必然漂移

**内存**：5 分钟立体声 48k float32 单条 AudioBuffer ≈ 115MB，两条 230MB。编辑期用 24kHz 单声道降采样版本（≈14MB/条），最终试听再切全质量。

**Region 虚拟化**：Region 是绝对定位 DOM div，一首 4-5 分钟日语歌可能有 600~900 个音节，全部实例化会卡死。**只为当前视口时间范围内的 2~3 句创建 region。**

### 5.11 合成

用 ffmpeg 的 **`ass` 滤镜**（不是 `subtitles`）。

修正一个常见误解：`ass` 滤镜**支持 `fontsdir`**（`filename`/`f`、`original_size`、`fontsdir`、`alpha` 是两个滤镜共用的 COMMON_OPTIONS，且 `ass_set_fonts_dir()` 在共用的 `init()` 里调用）。`ass` 滤镜反而**独有 `shaping`**（auto/simple/complex，控制是否走 HarfBuzz 整形），而 `subtitles` 在所有已发布版本上都没有这个参数。且 `ass` 用 `ass_read_file()` 直读，跳过 libavformat 解复用 + libavcodec ASS 解码的往返重序列化，与 JASSUB 的行为差异面更小。

只有需要 `force_style` / `charenc` / 烧录容器内嵌字幕流（`stream_index`）/ 直接吃 SRT 时才用 `subtitles`。本项目这几项都可以在生成 ASS 时于上游解决。

命令形态：`-vf "ass=f=/abs/path/lyrics.ass:fontsdir=/abs/path/assets/fonts:shaping=complex"`

**编码（已定 D9）**：默认 `libx264 -crf 18~20 -preset medium/slow`。硬件编码（`h264_videotoolbox` / NVENC / QSV / AMF）只作"快速预览"档位，且**必须显式指定 `-b:v` 或 `-q:v`**（不给码率时 videotoolbox 会落到约 200 kb/s 的默认值）。终端用户的 GPU / 驱动版本不可预知，无法保证硬编质量下限，不作最终导出默认。

**ON/OFF VOCAL 只烧一次视频（已定 D10）**：先做一次 `-an` 的字幕烧录重编码得到 `burned_video`，再用两次廉价的 `-c:v copy -c:a aac` 混流分别接上"含人声"与"伴奏"两条音轨。

**伴奏轨响度归一化**：`loudnorm` 两遍模式。第一遍 `print_format=json` 只测量，从 stderr 解析出 `measured_I/TP/LRA/thresh/offset`，第二遍连同 `linear=true` 传回。**直接调两次同一串静态参数是常见误用，无效。**

**进度**：ffmpeg `-progress pipe:1 -nostats` 输出 key=value 块，用 `out_time_us` 除以 ffprobe 预测总时长算百分比，同时用 `frame=` 与总帧数交叉校验。

### 5.11.5 编辑用代理视频（已定 D16）

**编辑器播放代理视频，导出用原始源。** 这不是优化，是可用性前提。

起因是 Safari 完全放不出画面。实测下载产物为 **AV1 Main / 3840×2160 / 23.976fps + Opus，
装在 Matroska 里**，对 Safari 是三重不兼容：不认 Matroska 容器、不认 MKV 里的 Opus、
且 **AV1 在 M1/M2 上没有解码支持**（Apple 自 M3 / A17 Pro 才有 AV1 硬解）。
因此**单纯 remux 成 MP4 救不了，必须转码 H.264**。

代理规格与理由：

| 项 | 取值 | 理由 |
|---|---|---|
| 编码 | H.264 | 唯一在所有目标浏览器上都能放的选择 |
| 容器 | MP4 + `faststart` | 同上；faststart 让边下边播可行 |
| 音轨 | **无**（`-an`） | 编辑器的 `<video>` 恒静音、音频走 Web Audio（D15），音轨纯属浪费 |
| 分辨率 | 高度上限约 540，`scale=-2:H` 保宽高比 | 编辑器画面框本来就不大；宽度须取偶数 |
| GOP | 约 1 秒（按源帧率算，不要写死） | **短 GOP 是刚需**：逐帧步进核对音节边界时，长 GOP 的 4K 源 seek 会卡 |
| 编码器 | macOS `h264_videotoolbox` / Windows NVENC 或 QSV / 兜底 `libx264 -preset veryfast` | 按平台探测，不写死 |

已实测（Apple Silicon，VideoToolbox）：30s 4K AV1 → 540p 用时 **1.78s（约 17× 实时）**，
整曲 4:43 约 17s、约 66 MB。代价可忽略，因此**不必为兼容性去牺牲下载画质**——
仍下最好的 4K AV1 源供导出，编辑走代理。

配套纪律：

- **导出链路必须继续用原始源**，绝不能误用代理。命名与注释要让这件事一眼可见
- 源本身已符合代理规格时直接 remux（`-c:v copy`）而不重编码。判据是
  **H.264 + 高度不超上限 + 关键帧间隔够短**，**不看容器**——MKV 里的短 GOP H.264
  换个壳就能放，没理由重编码。但**必须查关键帧间隔**：`-c:v copy` 会原样继承源 GOP，
  长 GOP 的源 copy 出来 seek 依然卡，等于没做代理
- 走 §5.13 的长任务架构：子进程 + JSON-lines 进度 + 按输入哈希缓存 + 可取消
- 生成失败要降级为"用原视频"并说明原因，不能让工程不可用（§2.5）
- **硬件编码必须显式给 `-b:v`**，否则 videotoolbox 会掉到约 200 kb/s（§5.11 已记载的坑）

### 5.12 两端 libass 必须同源（已定 D3 / D4）

这是"所见即所得"能不能兑现的地基。

**D3：ffmpeg 侧必须 vendor 与 JASSUB 完全相同的 libass commit。** "libass >= 0.17.5"是**不充分的** —— JASSUB 2.5.14 的 submodule 固定在 libass master `266b9831`（2026-07-24），比 0.17.5 tag 还领先 22 个 commit，其中包含尚未发布的无锁线程安全缓存架构与逐 event 多线程渲染重写。同时锁 freetype / harfbuzz / fribidi 的 commit。**升级 JASSUB 必须同步重建 ffmpeg 并跑像素回归。**

**D4：显式写 `LayoutResX` / `LayoutResY` = 输出分辨率**，不只是 `PlayResX/Y`。机制：

- `screen_scale = frame / PlayRes` → 只影响字号与 `ScaledBorderAndShadow: yes` 时的描边阴影，是等比缩放，PlayRes 具体取值不影响外观（宽高比匹配即可）
- `blur_scale = frame / ass_layout_res()` → 决定 `\blur`、`\be` 与 SBAS=no 时的描边阴影；`ass_layout_res()` 只看 `LayoutResX/Y` 头，其次才是 storage_size
- JASSUB 把 storage 设为视频原生尺寸，ffmpeg 默认设为滤镜输入帧尺寸 —— **只要源分辨率 ≠ 导出分辨率，或 subtitles 前有 scale，`\blur` 半径必然分叉**

日式 karaoke 重度依赖 `\blur` 做发光柔边，这个坑必然命中。显式写 `LayoutResX/Y` 就把两端都钉死了。同时显式写 `ScaledBorderAndShadow: yes`。

**字体**：JASSUB 用 `ASS_FONTPROVIDER_NONE`（浏览器侧没有系统字体，必须通过 `fonts` / `availableFonts` 显式喂入，自带的 `default.woff2` 只有 145KB 不含 CJK；关闭 `queryFonts`（会联网拉 Google Fonts）与 `useLocalFonts`（Chromium 独有、需授权、破坏确定性））。ffmpeg 用 `ASS_FONTPROVIDER_AUTODETECT`，`fontsdir` 只是**追加**搜索路径，**无法禁用** CoreText / DirectWrite / fontconfig 回退。所以更稳的做法是把字体 UUEncode 进 ASS 的 `[Fonts]` 段，并给打包字体使用唯一的 family name 以降低误匹配。

#### 字体链：缺字时用谁，必须两端同源（已定 D17，已实测）

没有一个日文字体覆盖得全，所以字体是**有序候选链**（§2.6）。难点全在"怎么让 libass 照这条链走"，
而且两端的默认行为恰好相反：预览侧无处可退（provider NONE），导出侧退到哪儿由系统说了算且禁不掉。

**下面这条是实测结论，不要凭直觉改回去**（`experiments/ass_embedded_fonts.py` 是回归基线）：

| 做法 | 结果 |
|---|---|
| 各字体保留各自的族名，全部嵌进 `[Fonts]`，指望 libass 在已加载字体间回退 | ❌ **不成立**。ffmpeg 侧照样去用系统字体——libass 不会为了一个缺字去翻族名对不上的已加载字体 |
| **把链上每个字体都改写成链首的族名**，让它们成为同一个族的多个字面 | ✅ 成立。libass 在同族字面里挑一个带该字形的，这是字体匹配的基本功能，不是回退启发式 |

族名统一之后还有一步不能漏：**把字型声明也一并归一**（`usWeightClass` → 400、
`fsSelection` 清 BOLD/ITALIC 置 REGULAR、`head.macStyle` → 0）。只归一字重是不够的——
实测 `bold=True` 时链首（`fsSelection` 带 BOLD 位）反而落选，**两个字体都有的字由链尾画出**，
用户选的主字体在自己有的字上都不生效；而 `bold=False` 时链首正常胜出。
同一份数据因为一个开关就换字体，正是这条规约要消掉的不确定性。
代价：Bold 开关从此对每个字体都走 libass 的合成粗体，而在此之前，
自称粗体的字面（如 ヒラギノ角ゴ StdN W8）会**静默忽略** Bold 开关——也就是说这一改让行为一致了。

两端各自的喂法（喂的是**同一批子集产物字节**，不是各裁一次）：

| 端 | 怎么拿到字体 | 为什么不能反过来 |
|---|---|---|
| 预览 | `GET /fonts/subset?family=&as=&extra=` 逐个取，构造 JASSUB 时 `fonts: [...]` 全部喂入 | ASS 里塞字节的话，每编辑一下就要重传几 MB（一份子集 UUEncode 后约 6.8 MB） |
| 导出 | 同一批字节 UUEncode 进 `[Fonts]` | ffmpeg 侧不把字节摆在它面前，就控制不住缺字时它选谁 |

预览侧靠 ASS 头部一行 `; kvm-preview-fonts: {"chain":[...],"extra":"..."}` 知道该取哪几个字体、
还要补哪些字。写进 ASS 而不是另开接口，是因为**它必须与这份 ASS 严格同步**——多一次往返
就多一个"字幕已经换了字体、字体还没换过来"的窗口期，而那个窗口期里画面是空白的。
这不违反 §4.1 的"ASS 永不被反向解析回工程"：读的是**渲染契约**，不是工程状态。

**验证方式也必须记下来，因为"能配置一条链"完全不构成证据**：
`frontend/scripts/verify-font-chain.mjs` 用一个链首真的没有的字（`𠮷`，ヒラギノ角ゴ StdN 的 cmap 里确实没有），
让每个字形去**认领它最像的那份参照渲染**（明朝独用 / 丸ゴ独用 / 链首独用），
两端各认一次。实测认领距离与次近相差 10–100 倍（如成片侧「𠮷」认明朝 0 格、次近 201 格），
同配置两次渲染逐格相同（噪声底 0），chromium + WebKit 双引擎全绿；
对照组 `KVM_SABOTAGE=nochain|samefont` 各自转红。
**不要退回"换链尾后差了多少格"那种阈值判据**：它只说得出"变了"，说不出"变成谁"，
而同一个字被同一个字体画两次也不是逐格相同（换链尾会让排版落在不同亚像素位置，边缘抖十几格），
拿魔数去卡，红了之后第一反应会是调阈值。

**目标是感知等价，不是像素级一致** —— JASSUB 的 `_computeRenderSize()` 默认 `prescaleHeightLimit=1080` 并乘 devicePixelRatio 取整，预览光栅化尺寸几乎不可能等于导出尺寸。回归测试用 SSIM 或像素差阈值。

### 5.13 后端长任务编排（已定 D5，待实现）

**「重计算作业」的通用架构**：独立子进程 + JSON-lines 进度协议 + 按 `(input_hash, params, version)` 缓存 + 可取消。适用于分离、强制对齐、烧录、峰值计算 —— 它们有完全相同的约束。

- **绝不在 FastAPI 的 async handler 或 ThreadPoolExecutor 里直接调 torch**：torch MPS 不 fork-safe；几十秒到几分钟的阻塞会让后端假死且无法取消；OOM / 段错误不能拖垮整个进程
- **并发闸门**：Demucs（几 GB 内存）+ ffmpeg 烧录 + JASSUB 预览同时跑会 OOM，必须有全局作业闸门
- **缓存键**：分离用 `(audio_sha256, model_id, backend_version)`；对齐用 `(vocals_sha256, text_hash, model_id, params)`；烧录用 `(ass_hash, video_hash, encode_params, libass_commit)`
- **磁盘预算**：一首歌 = 原视频 + 音频 + 2 条 stem + 代理视频 + 成片 ×2，轻松 3-5 GB。工作区必须有生命周期管理与磁盘余量检查
- **取消语义**：kill 子进程后临时文件由发起方清理，不要指望子进程自己收尾

#### 冻结形态下 `sys.executable -m <模块>` 不可用（已实测，v0.1.0 的发布阻断项）

拉 worker 的命令**不能写死成 `[sys.executable, "-m", "kvm.media.X", ...]`**。
打包后 `sys.executable` 就是 `kvm-backend` 自己，**PyInstaller 的引导器不认 `-m`**，
整串参数会掉进 `kvm.server` 的 argparse，子进程当场以
`error: the following arguments are required: --port` 秒退——
**人声分离与引导声在装好的应用里全都跑不起来**，而源码运行与全部单元测试一切正常。

这是那种"开发时永远碰不到、装完才炸"的坑，两条纪律：

- **worker 的命令与工作目录只允许有一处实现**（`kvm.media.deps.worker_command()` /
  `worker_cwd()`），冻结时改走 `kvm-backend --worker-module <模块> …`，
  由 `kvm.server` 在入口处接住（先于 argparse、先于父进程看门狗）。
  分离与引导声是同一个模式的两份调用，各写一份必然漂移。
- **`cwd` 在两种形态下的职责不同**：源码运行必须是 `backend/`（`-m` 靠它进 sys.path
  才找得到 `kvm`）；冻结后 `backend/` 不存在、`kvm` 在 PYZ 里，cwd 与 import 彻底脱钩，
  改指**应用数据根**（必定可写）。**不要用 `_MEIPASS`**——它在 `/Applications` 下是只读的，
  第三方库往 cwd 落个临时文件就会以一条与本功能无关的权限错误炸掉。

**同一个病根还有第二个受害者：`multiprocessing`。** 它的资源跟踪进程按
`<exe> -B -S -I -c "from multiprocessing.resource_tracker import main;main(N)"`
重新拉起本可执行文件（`ps` 实测原话），冻结解释器不认 `-c`，于是同样掉进 argparse。
PyInstaller 的运行时钩子已经把处理逻辑写进 `multiprocessing.freeze_support`，
**但它不会自己调用**，必须由入口点调一次（`kvm.server._divert_multiprocessing_helpers()`）。
不调的症状很有欺骗性：分离**照样能跑完**，只是资源跟踪进程死掉、命名信号量无人回收，
而那行 `required: --port` 会顺着 `run_cancelable`（它把 stderr 并进 stdout）
混进 JSON-lines 通道，**看起来就像 worker 分发失败**，排查时极易被带偏。

**两个平台都已实测**：v0.1.0 出包时 macOS arm64 与 Windows x64 的 worker 分发冒烟测试
均报「参数已抵达 worker」。Windows 这端本来是这次修复里唯一没验过的部分
（`multiprocessing` 的启动方式与资源跟踪路径在 Windows 上本就不同），
由**首次 Windows 出包**兜住——这正是把闸门设在产物上而非单测里的价值。

**还有一处同样的写法，目前安全只是因为它不在打包链路上**：`kvm.doctor` 用
`[sys.executable, "-c", …]` 起子进程问 torch 设备（§2.6 要求 torch 必须隔在子进程里问）。
冻结产物实测同样掉进 argparse——但装好的应用**从不跑自检**（`kvm.doctor` 只被
`scripts/setup.py` / `dev.py` 与命令行调用，全在源码形态下用真解释器跑），
所以这条路今天走不到。**代价是这个前提没有任何东西守着**：一旦把自检接进应用界面
（比如加个"复制诊断信息"按钮），torch 那项会立刻变成探测失败，而自检恰恰是
用户拿来判断环境好坏的东西——报错的自检比没有自检更糟。真要接的话，
先把这次探测也改走 `worker_command()` 那条统一的路。

### 5.14 模型权重分发（已定 D11）

**运行时下载，绝不打进安装包。** 独立进度条 + SHA256 校验 + 断点续传（HTTP Range，Tauri 自带 updater 不提供断点续传）+ 支持离线导入 + `HF_HUB_OFFLINE` / `HF_HOME` 控制。

**不要让 transformers / huggingface_hub 在后台静默拉 1.26 GB 权重** —— 弱网环境下用户会以为程序卡死。

模型总量约 1.3–2.5 GB（对齐 ~1.26 GB + 分离 639 MB + 可选 faster-whisper ~1.5 GB）。

**`audio-separator` 默认把模型下载到 `/tmp/audio-separator-models/`** —— macOS 会被系统定期清理、Windows 语义完全不对。**必须显式传 `model_file_dir`** 指向 `platformdirs.user_cache_dir`。

### 5.15 打包（已跑通 macOS 一端）

出包一条命令：`python3 scripts/package.py`（前端构建 → PyInstaller → Tauri）。

- Tauri 2 作为壳；Python 后端用 PyInstaller `--onedir`（**不是 `--onefile`**，PyTorch 体量下每次启动解压体验崩坏）
- **后端不走 `externalBin`，走 `bundle.resources` + `std::process::Command`（已定）。** 两条独立理由，任一条都足够：`externalBin` 在 macOS 上会导致公证失败（`tauri-apps/tauri#11992`，仍 open、无 workaround）；而且它要求每个条目是**单个文件**并带目标三元组后缀，`--onedir` 产物是一整个目录，本来就塞不进这个模型。绕开之后，**将来真要签名公证时不会被这条卡住**
- **打包后必须就地冒烟测试**（`scripts/package.py` 已内建）：起得来、`/api/health` 通、首页是 HTML、**且首页带 `COEP: require-corp`**。最后一条尤其重要——缺了它页面拿不到跨源隔离，JASSUB 起不来，而这个故障要等用户装完打开才暴露
- **冒烟测试还必须验 worker 子进程分发**（`smoke_test_workers()`）：判据是"参数到没到 worker 自己的 parser 手里"（stderr 出现 `--vocals` / `--audio`，且**不出现 `--port`**），而不是"进程起没起来"。理由见 §5.13——冻结后 `-m` 不可用，这条链路在源码环境里**永远测不出来**，只有拿打包产物跑才算数
- **`scripts/package.py` 必须由项目 venv 的 Python 跑**（`.venv/bin/python scripts/package.py`）：它用 `sys.executable -m PyInstaller`，而系统 `python3` 上没有 PyInstaller
- **实测体积（macOS arm64，含 CPU 版 torch）**：PyInstaller onedir **798 MB**，其中 torch 408 MB、llvmlite 123 MB、onnxruntime 65 MB、scipy 29 MB
- Windows NSIS/WiX 有 **2GB 单安装包硬上限**（`tauri-apps/tauri#7372`）。**v0.1.0 已实测：NSIS 安装包 276 MB，余量充裕**，此前"余量不大"的估算偏悲观。
  同一次构建的 macOS `.dmg` 是 **438 MB**——差距不是 Windows 少打了东西（Windows 的 torch wheel 反而更大：116.4 MiB vs 106.1 MiB），
  更可能是 NSIS 的 LZMA 比 dmg 压得狠。**判断"包全不全"要看冒烟测试，不要看体积**：两端的冒烟测试项相同且都通过
- **CUDA 版 torch 不进包（已定）**。PyPI 的 Windows `torch` wheel 本来就是 CPU-only；CUDA 版单个 wheel 就 2.58 GB，装进去必然撞穿 2 GB 上限。需要 CUDA 的用户自行替换，属高级用法
- **`--lean`（排除 torch 等重依赖）目前不是可交付形态**：冻结后的解释器没有 pip，`kvm.media.deps` 那套"缺依赖就自动装"走不通（`sys.executable` 是打好的可执行文件）。`ensure_dependencies()` 在冻结形态下**直接这么报错**，不再走那条自动安装的路——此前它会落到"当前 Python 不是虚拟环境"那句上（PyInstaller 把 `sys.prefix` 与 `sys.base_prefix` 都指到 `_MEIPASS`），在装好的应用里完全是误导。它只用来量体积做对照。要让它可交付，得先验证"往 `private_deps_dir` 装 wheel 再加进 sys.path"这条路
- 字体：`Noto Sans JP` / `源真ゴシック`（均 SIL OFL 1.1，允许随应用捆绑，需保留版权与许可证文本，不能单卖字体）
- 应用图标由 `python3 scripts/make_icons.py` 从 `src-tauri/icons/source.png` 生成（设计稿带水印且无 alpha，必须先清洗，理由见该脚本文档字符串）。
  同一张图标还要出现在 README、前端 favicon、启动页，而这三处的交付机制互不相同
  （仓库相对路径 / Vite `public/` / Tauri app 协议），只能各放一份 —— 所以**它们由同一个脚本一起产出**，
  换图标时重跑一次即可。**不要手工复制**：四个落点里漏掉一个不会有任何报错，只会在某一处继续显示旧图标

### 5.16 外壳形态：界面由本地 HTTP 下发（已实测，不要改回内嵌）

**结论先行：Tauri 壳的窗口不加载内嵌资源，而是加载 `http://127.0.0.1:<随机端口>`，
由 Python 后端同源下发前端、`/api` 与 `/media`。**

理由是一条硬约束（macOS 27 / Tauri 2.11 / wry 0.55 / WKWebView 实测）：

| 页面来源 | `isSecureContext` | `crossOriginIsolated` | **全局 `SharedArrayBuffer`** | rVFC | OffscreenCanvas transfer | 媒体 seek |
|---|---|---|---|---|---|---|
| `tauri://localhost`（app 协议） | ✅ | ✅ | **❌ 不存在** | ✅ | ✅ | ✅ |
| `http://127.0.0.1:<port>` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**没有 SAB 全局不是"退回单线程"，是 JASSUB 根本实例化不了**：它的 wasm 带 pthread 编译，
glue 里写死 `new WebAssembly.Memory({…, shared: true})`，且 `_emscripten_has_threading_support`
直接读这个全局。装进 app 协议的壳里就是个放不出字幕的应用。

有意思但**不要依赖**的一点：`tauri://` 上 SAB 这个*类型*其实存在
（`WebAssembly.Memory({shared:true})` 能建，其 buffer 的构造器就叫 SharedArrayBuffer），
只是全局绑定没暴露。理论上可以打 shim 救回内嵌形态——**未验证，不要走这条路**，
一个未验证的 shim 换来的"内嵌"没有价值。

已被验证是错的做法：

- **用 `tauri dev` 去验证跨源隔离**。dev 模式下前端由 Tauri 自己起的 dev server
  （`127.0.0.1:1430`）下发，那台服务器**不发 COOP/COEP**，`crossOriginIsolated` 恒为 false——
  会得到假阴性。要看真形态必须 `tauri build`（`--debug` 也行）。探针见 `src-tauri/probe/`
- **在前端里写死后端端口**。端口由外壳向内核要（`127.0.0.1:0`）后单向下发，
  用户机器上很可能已经有东西占着 8000
- **让用户知道内部走了 HTTP**。不打开系统浏览器、界面上不出现任何地址；
  只绑 `127.0.0.1`，绝不绑 `0.0.0.0`

配套事实：

- Tauri 的 app 协议**没有条件请求**（永远 200、不发 ETag），所以 Vite 那个
  「304 缺 COEP → worker 被拒」的坑在这条链路上不存在。**但不要据此删掉
  `vite.config.ts` 里的中间件**——那是在真 Safari 上实测出来的，两套链路
- 打包后的壳**不给远程页面开 IPC**（`window.__TAURI__` 有注入但命令被拒，
  报 "Plugin not found"，要在 capability 里放行 `remote.urls` 才行）。
  好在主界面根本不需要 IPC——它要的一切都走 HTTP。
- **全应用只有一条 IPC 命令 `enter_app`**（启动页 → 壳，"我准备好了，进主界面"）。
  **不要让启动页自己 `location.replace(后端地址)`**：那是跨源导航，实测时灵时不灵——
  同一份页面同一套配置，有的运行能跳、有的停在启动页上，症状是"卡在加载界面"。
  交给壳则行为确定，而且目标地址只存在于 Rust 侧，页面改不了它。
  反方向（壳 → 页面的事件）用单向 `eval`，不需要回执也就不需要再开一条命令
- 启动页（`src-tauri/boot/`）由 app 协议下发，它跨源轮询后端，所以后端 CORS
  白名单里要有 `tauri://localhost`（macOS/Linux）与 `http://tauri.localhost`（Windows）。
  **这两条只服务于"还没进主界面的那几秒"**，真界面是同源的，不要把白名单开得更宽

---

## 6. 已知陷阱清单

这一节是全文最有价值的部分，全是"看起来能行其实不行"的东西。

### 6.1 歌词源

- **QRC 的字级时间第二个数是 duration 不是 end**：`(774,242)` = 774ms 开始持续 242ms。写成 end 会导致整首歌越来越快
- **QRC 用的是有笔误的 DES S-box**，标准 3DES 解出来是垃圾。这个坑会浪费一整天
- **KRC 的时间语义要分清**：行头 `[start,duration]` 是绝对毫秒，行内 `<offset,dur,0>` 的 offset 是**相对本行起点**，而 `[kana:]` 里的 `(t,d)` 又是**绝对毫秒**
- **QRC/KRC 正文开头 5-6 行是带正常时间戳的制作名单**（「赤春花 - sumika/幾田りら」「词：片岡健太」「曲：xxx」「编曲：xxx」「制作人：xxx」）。不剥离会在视频开头闪出五行乱码般的名单。规则：时间 < 首句人声起点 且匹配 `/^(词|曲|编曲|制作人|作詞|作曲|.*-.*)/`
- **trans 轨第一行固定是**「TME享有本翻译作品的著作权」，必须丢掉
- **QRC XML 的 `LyricContent` 是 XML 属性值**，正文里的引号/&/< 是转义过的，必须先反转义再用正则解析
- **roma 轨的罗马字分词很怪**：`舞って → "ma (1439,188)'t (1627,188)te (1815,440)"`，促音写成 `'t` 且带空格。直接显示很难看
- **罗马音不能当振り仮名直接用**：`を` 写成 `wo`，ー/っ/ん 和长音有还原歧义。`[kana:]` 才是直接可用的假名
- **`[kana:]` 是无锚点的流式数据**：格式为 `<数字N><读音>`，N 是该读音覆盖的连续汉字数。消费端必须靠"基字符"定义 + 覆盖数校验和来对齐，**校验失败时应整行丢弃注音而不是错位显示**（真实案例：DECO*27 的「27」漏算导致后续注音整体错位一位）。它不是"确定性映射"，仍是工程启发式
- **版本混淆是头号坑**：`赤春花` 2025 原版在 QQ/网易上署名的是企划名 `Studio April`（247s），不是 sumika（260s）。原版在 QQ 上 `qrc=0` 且连 LRC 都没有。检索必须用 songmid 精确定位，或用「歌手含 sumika/幾田りら」+「时长≈260s」双条件过滤
- **QQ音乐搜索端点普遍失效**：`c.y.qq.com/soso/fcgi-bin/client_search_cgi` 已 404；`musicu.fcg` 的 `DoSearchForQQMusicDesktop` 从境外 IP 返回 `code=0` 但结果集恒为空（连周杰伦都 0 条）——**这会伪装成"歌曲不存在"**。已验证可用：`search_for_qq_cp` 和 `smartbox_new.fcg`。访问层必须抽象成可换端点 + 可挂 HTTP 代理
- **`fcg_query_lyric_new.fcg` 不带 `Referer: https://y.qq.com/portal/player.html` 返回 `{"retcode":-1310}`**，且它永远只给行级 LRC
- **`crypt:0` 具有误导性**：传 `crypt:0` 时 trans 返回明文，但 lyric/roma 依然是 hex 密文
- **跨源文本不一致的不只是分行**：`まだ君を見ている` vs `まだ君を見てる`（送假名）、`春 君に触れる`（半角空格）vs `春、君に触れる`（全角读点）。合并前必须归一化（NFKC + 统一全半角 + 剥离标点空白），**但渲染时要用原文**
- **官方分行 ≠ 演唱断句**，更 ≠ nicokara 一屏两行的分行。UI 必须提供拆行/并行，且拆并后时间轴要自动重分配
- **`LRCLIB` 不是独立信源**：其条目首行时间 `00:00.68` 与 Musixmatch 的 `time.total=0.68` 完全一致，高度可能同源。多源投票时要合并权重
- **Musixmatch richsync 对日语粒度是"整行/粗短语级"**（实测 79%~93% 的行只有一个 chunk），不是词级，更不是逐字。且 `apic-desktop.musixmatch.com` 是未公开的桌面客户端私有接口
- **`uta-net.com` 对爬虫 403**；`utaten.com` 可抓但带 `oncontextmenu`/`onselectstart` 防复制脚本和利用規約 —— 只在用户显式触发时抓，加 UA，本地缓存，别做批量爬虫
- **许可证污染**：`LDDC`（GPL-3.0-only）、`qqmusic-api-python`（GPL-3.0-or-later，PyPI 元数据写的 MIT 是过期的）、`pykakasi`（GPL-3.0+）。读它们的端点和常量（事实不受版权保护）自己重写是安全做法

### 6.2 时间轴与对齐

- **中文平台的时间轴对齐的是流媒体母带，不是 YouTube MV**。拿到完美 KRC 也必须重新锚定（见 §5.3）
- **`\k` 单位是厘秒，源数据全是毫秒**。逐个 `round(ms/10)` 会累积漂移，长句末尾能漂出半拍
- **拗音（きゃ/しゅ/ちょ）在假名 vocab 里是两个 token**，直接映射成两个 `\k` 会导致小假名单独擦除，必须合并
- **促音 `っ` 声学上是静音**，CTC 发射极不稳定，不要给独立 `\k`
- **长音 `ー` 与 melisma 拖腔上 CTC 的 token 结束时间不可信**，`\k` 时长必须由"下一块起点"倒推
- **日语歌词里的英文段落不能按字符切 `\k`**：`sumika`/`ikura` 在 KRC 里是整块一个单元。ASCII 连续段必须整体成词，否则出现逐字母扫光的滑稽效果
- **Whisper 在音乐上幻觉严重**（重复、凭空生成歌词）。只当锚点定位器，**绝不让它的文本覆盖用户提供的歌词**
- **前奏/间奏/纯伴奏段落**若不用 `<star>`/blank 吸收，CTC 会把歌词硬塞进无人声区间。按行切片对齐可规避大部分
- **对唱/和声重叠段**（本验证曲正好有）双声部同时发声，单流 CTC 会显著劣化。这些段落要预期人工介入
- **歌词里的当て字**（運命→さだめ、時間→とき）MeCab/Open JTalk 一定会读错。注音编辑器必须能覆盖读音，且**覆盖结果要立刻反馈给对齐器**——两模块共享读音表是硬性设计要求
- **未调研的时间基准问题**（会咬人）：yt-dlp 合并出的容器 `start_time != 0` 时 ASS 绝对时间会整体偏；VFR / YouTube VP9 的时间戳；烧录时是否强制 CFR；16 kHz mono 重采样滤波器延迟（几 ms 级，但会叠加到 50-150ms 的对齐误差上）。**所有时间轴讨论都默认"时间就是时间"，这个前提没人验证过**

### 6.3 渲染

- **libass 完全不认识 furigana 语法**。`漢字|かんじ` 和 `#` 是 **Aegisub 自动化脚本的输入约定**，不是 ASS 规范也不是渲染器功能。libass 会把 `|` 原样画出来。任何"把带 `|` 的文本直接写进 Dialogue"的实现都是错的
- **`\k`/`\kf` 只插值 PrimaryColour，描边色不跟着走字翻转**。而"黑边→白边"恰恰是 nicokara 最标志性的观感。**参考实现里只有 Kirakara-Player 真做到了，用的是浏览器 Canvas 2D 逐字 4-Pass 重绘 + `ctx.clip()`，完全脱离 ASS/libass**；`nicokara-studio` 的三层叠加只解决了填充色渐进，描边色自始至终没变过。**本项目的解法是双层 + 渐进 clip，见 §5.7**
- **一旦对注音行用 `\pos`，主歌词行也必须 `\pos`**（`\pos` 关闭碰撞检测），否则 libass 会把主行挪走、注音对不上
- **注音是派生量不是存量（已定 D8）**：换字体/字号/字距后所有注音坐标必须重算。度量由**单一实现**产出（建议后端 `uharfbuzz` 或 libass 绑定），前端只消费坐标，**绝不用 Canvas `measureText`**（不支持 letter-spacing，CJK 混排偏移肉眼可见）
- **字宽估算的固定比例是权宜之计**：`nicokara-studio` 用 `_CHAR_WIDTH_RATIO = 0.68`，在汉字/假名/拉丁/半角标点混排时必偏
- **描边宽度单位有三重语义歧义**：NicoKaraMaker 的「縁の幅」、Canvas `lineWidth`（居中描边，实际外扩只有一半）、ASS `\bord`（纯外扩半径）不是一回事。Kirakara 的 `strokeWidth 5 @ fontSize 64` 换算成 ASS `\bord` 只有约 3.75。直接把日本教程的数字填进 Outline 会粗到糊成一团。以 `\bord ≈ 字号 × 0.055~0.07` 为起点再目视调
- **`\blur` 的成本不在强度而在 bitmap padding**（每边约 7×blur 像素）。大量音节同时带强 blur 会让同屏 bitmap 总面积爆炸 —— 这才是 libass 的真实性能瓶颈，不是 event 数量
- **ミルフィーユ（上下半分双色）和纵向渐变在 ASS 里没有原生支持**，只能用两个横向 `\clip` 带叠加，事件数翻倍
- **ffmpeg 硬压时渐变/彩虹效果出现条带**（libass #816，被判定为"非 libass 的 bug"），根源在 YUV 色度子采样。考虑 `format=yuv444p` 或提高位深
- **ASS 是实现定义格式**，libass 与 VSFilter 不一致时官方立场是"VSFilter 对、libass 错"，libass 的偏离行为随时可能改。**必须把 libass 版本当作产品依赖锁死，不要用系统 ffmpeg**
- **字体覆盖检查必须做成硬性 pre-flight check**（用 `fontTools` 读 cmap，扫描全部歌词字符 + 注音假名 + 制作名单）。缺字后果严重：预览和导出可能 fallback 到**不同**字体，直接摧毁 WYSIWYG。查的是**整条字体链**，且要报出每个字由谁承担（§5.12）
- **libass 不会为了缺字去翻族名对不上的已加载字体**。"把带该字形的字体也嵌进去，它自然会找到"是错的——实测 ffmpeg 侧照样用系统字体。必须让整条链共用同一个族名（§5.12）
- **Windows 绝对路径在滤镜图里必须转义**（`:` 和 `\` 是分隔符/转义符）：`ass=f='C\:/work/lyrics.ass'`。建议统一 chdir 到工作目录 + 相对路径

### 6.4 环境与打包

- **Homebrew 主线 `ffmpeg` 配方不带 `--enable-libass`**，普通 `brew install ffmpeg` 装出来的二进制**完全不支持** `ass`/`subtitles` 滤镜。必须用 `ffmpeg-full` 或自编译。这是最常见安装路径的默认行为，不是个例配置问题
- **PyPI 的 Windows `torch` wheel 是 CPU-only**。不配 uv 的 PyTorch index 就会静默得到 CPU 版，用户以为自己有 4090 结果跑了 20 分钟。**启动自检里必须把 `torch.cuda.is_available()` 的结果显式打给用户看**
- **`audio-separator` 的依赖里有 `onnx-weekly = "*"`（未固定版本的每周构建）**。`uv.lock` 必须提交进仓库，升级时跑完整回归
- **MPS 有显存 spill 阈值**：Roformer 约 95 分钟输入、htdemucs 约 33 分钟、htdemucs_ft 约 24.5 分钟。单曲不会触发，但"整张专辑批量"或 2 小时的 live 视频会炸，要按时长分段
- **`pyopenjtalk` 上游在 PyPI 零 wheel**，`uv add pyopenjtalk` 会触发 cmake 源码编译，Windows 大概率失败。必须写 `pyopenjtalk-plus`
- **完整版 `unidic` 的 `python -m unidic download` 是安装后 770MB 联网步骤**，放进首次启动流程会让体验崩坏。默认用 `unidic-lite`（内置、约 250MB），全量版做成可选后台下载
- **强制对齐前必须把 vocals 从 44.1kHz 立体声下混到 16kHz 单声道**。直接丢给对齐器会白白多花时间，某些对齐器还会因声道数报错

---

## 7. 手工修改保护（这个不变量必须在数据结构上保证）

**用户手工调整过的时间轴 / 注音 / 分行 / 读音，在自动重新分析时绝不能被覆盖。**

这不是靠"重跑前弹个确认框"实现的，必须落在数据结构上。三层机制：

### 7.1 分离存储 + 合并求值

**绝对不要把手工值写回自动字段。** 手工覆盖是独立的一层：

```
effective = manual_override if manual_override.locked else computed
```

这样重算随时可以覆写 `computed`，手工层原样保留。

### 7.2 `locked` 是重算的硬边界

任何自动作业（重锚定、强制对齐、注音生成、自动分行）**只处理 `locked=false` 的连续区间**。

对强制对齐尤其重要：CTC 是全局最优路径，**没有"冻结部分路径"的原生接口**。正确做法不是"全曲跑一遍再打补丁"，而是：把已锁定的边界当作**硬锚点**，把音频与假名序列按锚点切成互不重叠的区间，对每个未锁定区间单独跑 `forced_align`（该 API 本来就 `batch_size==1`）。

### 7.3 内容寻址身份键 + 重绑失败清单

见 §4.4，那里有实测数据与两层分工的完整说明。三句话概括：

- **别用「第几行第几个 token」做主键**，重新分行后锁定项会全部错位
- **也别用 tid 去定位是哪一行**——重复副歌上会静默错绑（实测 42 个音节）。
  行的对应关系用整曲字符对齐，tid 只做行内主键
- **重绑失败的收进「失效修正」清单让用户确认，绝不静默丢弃**。绑错比绑不上更糟

### 7.4 UI 反馈

`source` 字段必须在 UI 上用颜色可见地区分：`provider`（歌词源）/ `aligned`（自动对齐）/ `interpolated`（插值推算）/ `manual`（手工）。这是"一站式"体验的核心可见反馈 —— 用户要知道哪些数字可信、哪些需要复核。

---

## 8. 编辑器状态层（没有它就只有一个跑批工具）

- **undo/redo 与"强制对齐重跑"如何共存**：重跑是**一个** undo 单元（整个批量变更打包成一个 patch），不是 N 个
- **项目持久化**：`project.json` 单文件 + schema 版本字段 + 迁移函数链。自动保存节流（建议 debounce 2-5s + 关键操作立即保存）
- **崩溃恢复**：用户调了 40 分钟轴、进程崩了，必须能恢复。写入用 write-temp-then-rename 保证原子性
- **重算与编辑的并发**：后台重跑对齐时用户仍在拖别的边界 —— 重跑结果落盘前必须与当前状态做 `locked` 感知的三方合并，不能整体覆盖

### 后台产物不进撤销栈（已定）

**撤销栈是用户意图的模型，不是全部状态变更的日志。** 后台作业产出的派生物——
代理视频路径、分离出的 stem 路径、峰值缓存等——**写回工程时必须绕过历史**，
不占撤销格。

反面场景：用户改完一处时间轴，后台代理刚好生成完并压入一次快照；用户按 Cmd+Z
想撤掉自己那次修改，结果撤掉的是"代理已就绪"这个登记。更糟的是撤回到代理生成之前的
快照会把路径清空，而文件其实还在。

判据很简单：**这次变更是用户主动做的吗？** 不是就绕过历史。

---

## 8.5 渲染规格（第一版已实现并出片验证）

以下行为已在 `render/ass_builder.py` 中实现，并通过赤春花全片验证。
改动这些默认值前请先理解它们的由来。

### 版面

| 项 | 规格 | 由来 |
|---|---|---|
| 字号 | 画面高度的 **7.5%**（4K → 162px） | 5.2% 实测偏小，卡拉OK 字幕要压在任意画面上仍醒目 |
| 描边 / 阴影 | 字号的 **5.5% / 2.2%**，随字号自适应 | 固定 3px 在 4K 下细到几乎不可见 |
| 上下行 | **上行贴左、下行贴右** | 日式卡拉OK 的经典错开布局，同屏两行也能一眼分清 |
| 间奏后 | **重新从上行开始** | 否则新段落可能突然从下行冒出，视觉接不上 |
| 超宽行 | **拆行**，不做水平压缩 | 压缩会让字变形；拆分点优先选**时间间隙最大处**（自然停顿） |
| 配色 | 未唱白 + 近黑描边；已唱亮蓝 + 深蓝描边 | nicokara 惯例 |

### 时间

- **窗口两端都按肉眼状态定义**：一行的 `(show, hide)` 里 `show` 是开始淡入的时刻
  （此刻全透明），`hide` 是**完全消失**的时刻。这样"前一行没了"与"后一行开始出现"
  仍是两个能直接比大小的时间点，同槽位的空档判断不必再各自减去淡化时长。
  代价是不透明区间被两头各吃掉一截，于是有两条硬性要求：
  `lead_in_ms >= fade_in_ms`（开唱时字必须已完全浮现）、
  `lead_out_ms >= fade_out_ms`（最后一个字唱完前不许开始变淡）。
- **一行的所有层必须共用同一组 `\fad`**。一行会拆成多个 Dialogue
  （多声部分段 ×2 层 + 每条注音 ×2 层），有一层淡得不同步，淡化期间未唱色就会
  从已唱色底下透出来——双层 clip 方案里两层画的是同一段文本，只是颜色不同。
- **段落首行连同它的下一行一起提前 `paragraph_lead_ms`（4.2s）出现。**
  间奏之后屏幕本来就空着，上下两个槽位一次摆满，演唱者能一眼看到接下来两句；
  只提前第一句的话第二句要等第一句开唱才浮现。
  提前量会被上一段最后一句的收尾顶回来——间奏只有 `paragraph_gap_ms`（3.5s）时，
  提前 4.2s 会压到上一句身上。
- 段内行在**当前句还在唱时**就已显示（从上一行开唱起），最多提前 `max_lead_ms`（5s），
  且无论如何至少提前 `lead_in_ms`（2.0s）。只提前几百毫秒不符合卡拉OK 实际观感。
- **同槽位冲突消解**：槽位只有两个，隔一行就复用同一位置；歌词密集时前一行尚未消失、
  新行已压上，字会叠在一起。策略是优先让前一行提前退场，腾不出位置时再推后新行入场。
  前一行"提前退场"的下限是**唱完再加一个 `fade_out_ms`**，不是唱完就算——
  按唱完去卡的话最后一个字会一边唱一边褪色。
  这条约束在密集段是真的会咬人：赤春花实测约一成的行因此拿不满 2.0s 提前量
  （最紧的一处只剩 0.96s）。槽位只有两个，这是结构性的，不是参数没调好。
- **制作名单窗口必须用行的最终窗口去找，不能用开唱时间近似。** 行会提前显示、
  唱完还会停留，近似值一旦和提前量脱节，名单就会和歌词叠在一起。
  而且要先求所有行窗口的**并集**再找空隙：行之间允许时间重叠（同屏两槽位、
  以及数据结构上允许的多声部同唱），逐对比较会把被后一行覆盖住的"空隙"误判成可用。
- **开唱引导点：先算熄灭时刻，再由它反推起亮时刻。** 点是倒计时，锚点在
  "什么时候数完"，不在"什么时候出现"——**让它跟歌词同刻浮现是错的**：段落首行
  提前 4.2s，而熄灭只占最后 n 拍，点会先亮着不动两三秒，读起来只是个静止装饰。
  正确做法是在第一个点熄灭前 `countdown_lead_ms`（750ms，取自经典指示灯
  "4 点每 0.75s 熄一个"里那"一拍"）才亮。
  **但点绝不早于它所提示的那句歌词**——歌词还没浮现就先冒出三个点，
  观众不知道它们指向哪一句，所以起亮时刻对歌词的出现时刻取下界。
  **不要把提前量复用 `countdown_beat_ms`**：那个字段只在节拍检测失败时决定熄灭间隔，
  两件事混在一个字段上，用户调其中一个会莫名其妙地改到另一个。
  空档挤不下时的降级顺序是：先压缩提前量（被歌词的出现时刻顶住），
  再从**先熄灭的那一端**（最右）逐个丢点——剩下的仍读得出倒计时，比整组不显示好。
  熄灭要干脆、**不淡出**——那一下"啪"地消失才是拍点的读数；淡入仍然要有，
  否则点是硬生生跳出来的。
  剩几个点就是还剩几拍——反向熄灭才读得出倒计时的意思。
  **点必须踩在真实拍点上**（`pipeline/beat_detect.py`），固定间隔只是"三个会消失的点"，
  与音乐无关，演唱者跟不进。节拍检测**优先用分离出的 drums stem**——
  鼓点是节拍最强的证据，而这条轨在去人声阶段本就会产出，属于免费信号。
  赤春花实测 136.0 BPM，引导点间隔 440ms，与 60000/136=441ms 吻合。
  空档不足时（如首句在 0.836s 就开唱）自动压缩间隔；检测失败则回退固定间隔，
  **不因节拍检测失败就不显示引导点**。
  只在第一句与**间奏之后**出现（阈值与段落判定共用），否则满屏是点反而干扰。

### 制作名单

- 曲名 / 歌手 / 词曲编曲制作人**单独成屏**，**居画面正中**。
- **不能沿用歌词源给的时间**：QRC 把这些行塞在正文里，实测每行只有几十毫秒
  （0/222/355/518/577ms），照搬根本来不及读。
- 显示位置是**第一段屏幕上没有歌词的区间**——不能假设片头有前奏（赤春花首句在 774ms），
  放不下就顺着找行间的第一个间隙（通常是间奏）。
- 窗口边界必须按**字幕实际出现/消失**算，而非开唱时间——下一句会提前显示、
  上一句唱完还会停留，只看开唱时间会让制作名单和歌词叠在一起。
  具体取法见上面「时间」小节最后几条（用行的最终窗口求并集）。
- **用未唱色，取 `main` 声部的那一套。** 名单不由任何人演唱，用已唱色等于谎报
  "这一句正在唱"；而未唱色本来就是为"压在任意画面上仍然醒目"定的（§5.8 白填充 +
  深描边），正好也是名单的处境。取 `main` 是因为名单没有声部归属，而 `main` 是
  工程的基准声部、也是配色查找唯一保证存在的一套。
  代价要说明白：用户把未唱色改成低对比的组合时名单会跟着变难读——
  **这是用户自己的选择，不加保护逻辑**，加了就等于"配色不完全生效"。

### 声部

- 一个声部需要的是**四个颜色而不是一个**：未唱填充/未唱描边/已唱填充/已唱描边。
  因为描边跟着填充一起翻色（双层 clip 方案），两层各需一组。四个够用——
  下面那条"未唱态分声部"与"开唱对调"都只是这四个色之间的**约束关系**，
  不需要新增色槽。（唯一表达不了的是逐声部的阴影色，`KaraokeStyle.shadow` 是全局的；
  目前没有需求。）
- **未唱态必须能区分声部（已定）。** 对唱曲里，演唱者需要在**轮到自己之前**就知道
  下一句是不是自己唱的。整个产品为此花了大力气——提前入场 2.0s、段落首行提前 4.2s、
  开唱引导点踩着真实拍点倒数——如果未唱态两个声部长得一模一样，"这句是不是我的"
  要等扫色开始才知道，那时已经晚了，前面所有提前量都白给。日本点唱机的对唱模式
  本来就是**未唱时就分色**的，这是对唱功能的核心，不是装饰。
  **已被验证是错的做法**：让同一套配色里所有声部共用未唱色、只有已唱色分声部
  （理由是"否则同屏两个声部在开唱前看起来像两首歌的歌词"）。那个顾虑是真的，
  但解法是**同族而可辨**——共享底色与明度层级，只在**未唱描边的色相**上分开，
  而不是让它们一样。
- **区分度的通道分配**：家族身份走未唱填充（面积最大、明度最高，一眼分得出），
  声部身份走未唱描边的色相（填充已被家族占用，而描边贴着字形轮廓、逐字可见）。
  描边要够暗才保得住可读性、又要够饱和才认得出声部，两者互相挤压，
  所以**"暗到看不出色相的深色"不算区分**——那是假装有区别，比没有区别更糟。
- **开唱可以让填充与描边整体对调**（未唱 = 底色填充 + 声部色描边；已唱 = 两者互换）。
  声部色因此始终有一个槽，唱之前就看得见；开唱瞬间整体反转，实测感知差
  （CIELAB ΔE 填充 + 描边合计）是"只翻填充"那一档的 1.5–2 倍。
  双层 + 渐进 clip 天生支持，不需要新机制。**代价要记住**：对调后已唱填充是深色
  （否则与白描边的对比度不够），压在纯黑画面上填充本身对比度不足，靠翻上来的白描边
  兜住——所以可读性判据必须写成"填充与描边**至少有一个**能从底上跳出来"，
  写成"填充必须"会把这个本来可读的组合误杀。
- 配色（`VoicePalette`）与排版（`KaraokeStyle`）**分离**：换声部只换配色，不动排版。
- 声部标识行级是默认值，**Token 级可覆盖**——对唱歌曲一行内男女交替是常态。
- **`Line` 的时间允许互相重叠**，这是为"同一时刻两个声部唱不同歌词、同屏各走各的轴"
  预留的。第一版编辑器不支持编辑重叠行，但**渲染层与数据结构不得假设行之间时间互斥**。
- **屏幕上的每一样东西都必须取自配色，颜色一律走事件的 `\1c` / `\3c` override，
  ASS 的 `[V4+ Styles]` 行只是"没有 override 时"的兜底。** 理由是配色逐声部、
  且用户随时能改，而 Style 行全局只有一份，表达不了"这段是 duet_b、那段是 main"。
  兜底值也不许写死字面量，要由 `main` 配色填充——否则它会在改配色后开始撒谎。
  **已被验证是错的做法**：把制作名单与引导点的颜色写死在 Style 行里。默认配色
  恰好也是白字深边，所以看起来一切正常，**只有用户改了配色才暴露**：歌词整体换色，
  这两样纹丝不动。
- **开唱引导点取它所提示的那句歌词的已唱色**，且跟随该行**第一个 token** 的有效声部
  （行级声部只是默认值，而点倒数到的正是第一个 token）。点的语义就是"这一句马上开始"，
  最后一个点熄灭的瞬间，同一个颜色会从这句第一个字开始向右扫过去——同色才让这层
  因果关系被看见。对唱曲里这顺带告诉观众"接下来是谁唱"；反过来一律用 `main` 的话，
  由别的声部领唱的段落里，点会是屏幕上唯一对不上任何人的颜色。
- 取色**一律成对**（填充 + 描边）。描边跟着填充一起翻色是本项目的既定方案，
  只改填充会让元素顶着一圈属于另一状态的边。

---

## 8.6 待实现的功能（按优先级）

| 优先级 | 功能 | 说明 |
|---|---|---|
| **高** | 编辑器状态层 | 撤销/重做、工程持久化、崩溃恢复。见 §2.5——"一站式"定位下这是致命伤而非遗憾 |
| **高** | 三级调轴 UI + 注音编辑 | 整体 / 单句 / 单词，以及 tap-to-time 手工打轴 |
| **高** | 歌词**搜索 + 下载**界面 | 不是"抓取"：多源并行搜索，把候选摆出来让用户挑。详见 §5.2 备注 |
| ~~中~~ **已实现** | **引导声（ガイドメロディ）** | 素材页可生成、试听、调参，导出与预览用同一份产物。见下方「§8.9 引导声的合成规格」 |
| **中** | 声部自动归属 | 见下方「§8.7 声部识别的方向」。手工标记已是可用主路径，这只是省力 |
| **低** | 网易云歌词源 | 行级兜底 + 与 QQ 交叉校验，**不指望逐字**（匿名 API 拿不到 yrc） |
| **低** | 同屏多声部各走各的轴 | 数据结构已预留（`Line` 时间可重叠 + `voice_part`），编辑器支持待做 |
| **高** | 界面重排 | 见 `docs/ui-redesign.md`。中间舞台随步骤切换 + 首页 + 统一设计 token |
| **中** | README + i18n | 见 §8.8。**顺序有讲究**：重排先落地，但重排时就要走翻译函数 |
| **中** | 主唱/和声分离 + 音轨混音台 | 见 §8.7。コーラス入り 是主要诉求 |

---

## 8.7 主唱 / 和声分离与音轨混音台（待实现）

### 真正要解决的是「コーラス入り」

日式卡拉OK 的伴奏不止一种。除了全去人声的 **OFF VOCAL**，还有一种常见且更受欢迎的变体：
**去掉主唱、保留和声（コーラス入り）**。理由很实际——和声是编曲织体的一部分，
整段抹掉会让伴奏显得单薄，而演唱者唱的是主旋律，和声留着反而有帮助。

所以第一优先的不是"识别谁在唱"，而是**把人声再拆成主唱与和声两层**。

### 两段式分离（推荐路线）

| 段 | 输入 | 输出 | 模型 |
|---|---|---|---|
| 第一段 | 原混音 | 人声 / 伴奏 | 现有三档（`fast` / `standard` / `best`） |
| 第二段 | **第一段的人声** | 主唱 / 和声 | `mel_band_roformer_karaoke_*` 系列 |

**关于 `mel_band_roformer_karaoke_*` 的一处澄清**：§5.4 警告过"它分的是主唱 vs 和声，
不是人声 vs 伴奏，名字极具误导性"——那条警告依然成立，指的是**别拿它当第一段的分离器**。
但用在第二段上，它恰恰就是对的工具。两处说法不矛盾，区别在于喂给它什么。

### 导出音轨是一台混音台，不是几个固定变体（已定）

层都分出来之后，再把成片音轨写死成四个预设就是白白扔掉自由度。因此：

> **导出音轨 = 一组层 × 各自增益。预设只是快捷方式，不是可选项的全集。**

可用层：主唱、和声、伴奏（或 `fast` 档进一步拆出的鼓 / 贝斯 / 其余）、合成引导旋律。
每层独立开关与增益。预设仍然保留，因为绝大多数时候用户不想调：

| 预设 | 组成 |
|---|---|
| ON VOCAL | 原混音 |
| OFF VOCAL | 伴奏 |
| コーラス入り | 伴奏 + 和声 |
| ガイドボーカル入り | 伴奏 + 和声 + **主唱压低约 −12 dB** |
| 引导声版 | 伴奏（± 和声）+ 合成引导旋律 |

这套模型的好处是**新变体不需要新代码**：日本卡拉OK 常见的"隐约留一点主唱当引导"
在固定变体模型里要单独实现，在混音台模型里只是把主唱增益拉低——而这恰恰是
"全留或全去"两档覆盖不到的中间地带。加强鼓声当节奏参考同理。

配套要点：

- **混音在全质量素材上做**，不要用编辑期的降采样版本
- **`amix` 必须 `normalize=0`**，否则各层会被平均而整体变轻（§11 已记的坑）
- **响度归一化对最终混音做一次**，不要逐层做——`loudnorm` 两遍模式（§5.11），
  否则各层各自归一化后叠加，响度全乱
- **§5.11 的「只烧一次视频」策略（D10）在这里收益更大**：字幕烧录仍只做一次，
  每个音轨组合只是廉价混流（`-c:v copy`）。变体从固定四个变成任意组合后，
  这条策略从"省一次编码"变成"省任意多次编码"
- 编辑器里应当能**试听当前混音**再导出，否则用户只能靠导出成片来验证配比

### 顺带能解决的两个老问题

拿到主唱与和声分层后，两个既有难点会一起缓解：

- **对唱重叠段的强制对齐**：两人同时唱不同歌词时单流 CTC 会显著劣化（§6.2 已记，
  验证曲正好有这种段）。分层后至少能把主唱与和声分开对齐
- **逐声部引导声**：重叠段上对混合人声提基频只会得到其中一条声部（单基频跟踪器
  面对复音本就没有正确答案），分层后可分别提取

**这里有一条容易踩错的评价标准**：用于对齐与提取 f0 的分离**不需要好听**。
CTC 要的是可懂度，引导声只要 f0，二者对残留伪影的容忍度都远高于"给人听"。
拿主观音质或 SDR 去判定这一步失败，会把可用方案误杀。
但**用于成片音轨的分离要好听**——同一份产物两种用途、两套评价标准，不要混用。

### 声部归属（谁唱的）仍是独立的另一件事

分色驱动的是 `Line.voice_part` / `Token.voice_part`，要的是**标签而非音轨**。

**识别出来颜色就自动标好了**——配色本来就是按声部组织的（`VoicePalette` 每个声部
四色，§8.5），所以声部一旦定了，分色是白拿的。为此有一条产品要求：
**自动识别出 N 个声部时要自动分配 N 套互相区分得开的默认配色**，
不能要求用户先手工建声部再配色，否则"自动"没有省到力。

**男女对唱是最容易的一档，而且有个近乎免费的信号**：引导声功能本来就要用 CREPE
抽基频（`pipeline/guide_melody.py`，§8.9），拿这份 f0 做男女判别几乎零成本——
与 §8.5 中"用去人声阶段本就产出的鼓轨做节拍检测"是同一类思路：**优先用流水线上
已经存在的信号，不要为每个功能各引入一个模型。**

判据要用**聚类而不是绝对阈值**：取每行 f0 的中位数，看整体是否呈双峰，按峰归属，
而不是拿一个固定 Hz 值切。原因是男声假声能进入女声音域、女声低音区也会落进男声音域，
绝对阈值必然在这些地方翻车；而聚类是按本曲两位歌手的实际分布切，天然自适应。

**同性别二重唱 f0 分不开**，这时才需要退到「参考嵌入 + 逐句归属」：每位歌手取一段
参考音频算嵌入，逐行比对指派。**对唱歌曲几乎必然有独唱段**，那是本曲自带、
同录音同混音的参考数据，优于外部素材；用户手动提供的参考作为补充与兜底。

层次因此是三级，按成本递增依次尝试：**f0 聚类（免费）→ 参考嵌入（要模型）→ 手工指派（永远可用）**。

两条纪律不变：

- **必须落在 `(value, source, locked)` 机制里**（§4.4）：自动归属标 `source`，
  用户改过的标 `manual` 且 `locked`，重跑不覆盖。声部猜错是常态，**猜错必须可见、可改、
  改完不被冲掉**
- **手工指派仍是主路径**（§2.5）。任何"必须先跑完识别才能标声部"的设计都是错的

**待实测**：`mel_band_roformer_karaoke_*` 在本曲男女对唱上主唱/和声分得干不干净、
主唱残留是否会破坏コーラス入り的可用性；以及参考嵌入方案的区分度
（男女对唱应当容易，**同性别二重唱才是真考验**）与歌手真假声切换时嵌入是否稳定。

---

## 8.9 引导声的合成规格（已实现）

`pipeline/guide_melody.py`（算法）+ `media/guide.py`（作业）+ CLI `--guide-vocals`。
链路：vocals stem → **CREPE** 提基频 → 切音符 → 合成 → 混入伴奏。

**不是把人声调小混回去。** 残留原唱会和演唱者打架，咬字含混反而更难跟。

### 引导声是一件**素材**，不是导出时的一个开关

它和分离出的 stem、编辑代理同类：先做好、后面反复用。所以生成入口在素材页，
产物落在 `ProjectDTO.guide_audio_path`，`GET /api/media/file/{id}/guide` 可播。

理由不是"归类整齐"，而是**它好不好用只能靠耳朵判断**。参数改完必须立刻听得到；
等到导出才发现跑调，一次几分钟的烧录就白费了。同一条理由要求预览必须真的把它
放出来——预览里放不出来的东西，用户就只能靠导出来试听，那正是这条产品线要消灭的。

配套三条：

- **导出优先复用素材页的产物**（指纹对得上时）：用户试听并认可的就是那一份，
  重算一次既慢又可能因为推理不确定性给出略有差别的结果。指纹对不上或压根没生成时
  就地合成一份，**不阻断导出**（§2.5），且用工程当前那组参数——
  否则用户调了半天，导出拿到的是默认参数那条轨。
- **导出片段时引导声仍按整曲时长合成**。它的时间是绝对的，而 `burn` 用的是
  output seek；按片段时长合成会得到一条只覆盖 `[0, duration)` 的轨，
  `start_s` 之后的片段里引导声整段消失。
- **预览的引导声增益是 1/√2，不是 1**。引导声文件是单声道，导出时 `amix` 的
  上混矩阵为保功率给每声道乘 1/√2，于是成片里比它自己的文件电平低 3 dB
  （实测：引导声 −19.45 dBFS，"成片混音 − 伴奏"残差 −22.46 dBFS，
  相关系数 1.0000）。预览按 1.0 播，用户就是照着一个比成片响 3 dB 的声音在调音量。
  **不要反过来去改导出侧的上混**——下面那个 `gain=0.11` 的默认值就是在这条链路的
  末端量出来的。

### 只暴露五个参数，其余保持默认

`GuideConfig` 有十几个字段，全摊到界面上是灾难：`pitch_median_frames`、
`cents_tolerance`、`hop_s`、`sr_analysis` 这些要么是 f0 管线的标准步骤，要么是按
实测间隙分布定死的阈值，用户既没有判据去调，调了也只会把本节的结论推翻。

留下的五个各自对应**一句真实的抱怨**，而且都能在产物上量出来（实测，赤春花全曲）：

| 参数 | 抱怨 | 客观读数 |
|---|---|---|
| 音量 `gain` | 太响 / 太轻 | 0.11→0.30 时 RMS −20.98→−12.27 dBFS（+8.71 dB，与 20·log₁₀(0.30/0.11) 相符） |
| 音色 `timbre` | 太尖 / 被编曲埋掉 | square→sine 时 >4kHz 能量占比 0.80%→0.00% |
| 明亮度 `max_harmonics` | 太亮 / 太闷 | 16→2 时 >4kHz 能量占比 0.80%→0.00% |
| 灵敏度 `voicing_drop_db` | 弱唱处没声音 | −24→−32 时发声占空比 67.3%→69.1% |
| 连音 `legato_gap_ms` | 一顿一顿 / 该停的地方还在响 | 200→0 时间隙 >20ms 的个数 15→75 |

**明亮度对 `sine` 无效**（它只有基波），界面上要禁用并说明，而不是给一个拖了
没反应的滑块。

### 改参数不自动重新生成，但"参数已变"必须可见

整曲跑一次 CREPE 是十几到几十秒（本机 4:43 / MPS / full 模型实测 16–25s）。
每拖一下滑块就重算不可接受，debounce 也只是推迟——连调三个参数就排三次队。
所以**改参数只保存，重新生成由用户显式触发**。

由此必然出现一个中间态：参数已改、产物还是旧的。**这个状态必须报出来**
（`GuideStatus.stale`），否则用户会以为参数根本没生效。

两个指纹各管一件事，不要合并：缓存命中用 `(vocals_sha256, 参数, 版本)`（内容寻址，
§5.13 规定的形态，负责正确性）；界面上的 stale 判断用
`(人声轨路径/体积/mtime, 参数, 版本)`——它会被前端轮询，为一次状态查询去哈希几十 MB
的 wav 纯属浪费，而它偶然漏判也不会出错，真正生成时第一个键仍会未命中。

### 撤销栈的两侧刚好都在这里

**参数占一格撤销**（`store.mutate`）——那是用户拖滑块表达的意图；
**产物路径与指纹不占**（`store.update_derived` + `BACKEND_ONLY_FIELDS`）——
那是后台作业的登记（§8）。撤销回到旧参数时产物路径必须原样留着，
否则界面显示"未生成"而文件明明还在磁盘上。

### 音高提取必须用 CREPE，不要用 pYIN（已定）

**`librosa.pyin` 是自相关域的单音基频跟踪器**，拿它在真实歌曲上找主旋律会有三个
同源症状，且都无法靠后处理补救：

| 症状 | 机制 |
|---|---|
| 和声段整段判无音高 | 双声部下自相关差分函数没有唯一的谷 |
| 某些音被报低一两个八度 | 基频弱、泛音强时锁到**次谐波** |
| 起音进得晚 | 自相关要攒够几个周期才锁得住 |

实测证据：某处 pYIN 报 103.8 Hz，而该频点的能量比其 4 倍频（415.2 Hz）**低 48 dB**——
锁的是次谐波。旋律上下文（C4 → D#4 → G4 → **G#4** → F4）也印证 415.3 Hz 才是对的。

改用 **`torchcrepe`（MIT）**：波形上的音高分类 CNN，不依赖自相关，**默认 Viterbi 解码
就是为消除倍频/半频错误设计的**。权重随 wheel 分发（full 89 MB / tiny 2 MB），
**运行时不联网**，满足 §2.1。换用后上述三条同时消失，且**之前为补 pYIN 窟窿而加的
持音、起音预填、次谐波纠正等补丁全部删除**——零件更少，结果更好。

两条配套注意：

- **置信度阈值不能照搬 0.5**。实测有一处 CREPE 音高正确但置信度只有 0.32——
  置信度低只说明"不像单一周期信号"，而和声段本来就不是。按 0.5 卡会把正确的音抹掉
- **f0 输出必须过中值滤波再进切分**。CREPE 在弱唱与快速换音处会有几帧误判，
  而切分逻辑会把一次几帧的跳变放大成一百多毫秒的音符——半音级的错音非常刺耳。
  在**对数音高域**取中值（赫兹域会偏向高音），边界用端点复制（否则每个乐句的头尾音
  会被拉向邻音）。这是 f0 管线的标准步骤，不是补丁
- **验证音高对错要拿频谱谐波列做真值**，不要拿另一个跟踪器的输出互相印证——
  两个自相关类方法会一起错

### 测量工具本身必须在**实际工作点**上校准

这条是被真实事故换来的，代价是一整轮基于错误证据的分析。

某次频谱筛查器把一段独唱误判成"两条声部同时存在"，据此推出的整套"跟错声部、
需要多基频跟踪"结论全部作废。根因在筛查器自己：它先补零到 16384 点、**再**对补零后的
缓冲区加窗，于是真实的 60ms 信号（1323 点）落在窗的上升沿上被乘以接近 0 的系数并被
严重幅度调制，**凭空造出谱结构**。

**最要命的是它通过了校准**：这个 bug 只在"段长 < 补零目标"时发作，而校准用的是 0.2s 段
（长于补零目标）。校准通过 → 工具被信任 → 错误证据被当成事实。

三条纪律：

- **拿实际使用的参数去校准**（这里是 60ms 窗长），不要图方便用更长的段
- **校准要能证伪**：至少包含"单音不许多出邻近峰"与"真的双声部要能分开"两个方向
- **结论与听感冲突时，先怀疑测量**。这次是用户说"听不出和声"才让我们回头查工具的；
  如果当时按测量结果去做多基频跟踪，就会为一个不存在的问题换掉整套算法

### 结果不是逐比特可复现的

torch 推理重复跑不 bit-exact（CPU 单线程亦然）。实测原始 f0 两次最大差 37.6 音分、
无一帧超过 50 音分；量化后逐帧同高 94.7%，差一个半音的都落在"本来就唱在两个半音正中间"
的音上。**不要为此去追推理确定性**：音准与旋律走向不受影响，而 §5.13 本就要求按
`(输入哈希, 参数, 版本)` 缓存作业产物——要复现就在作业层缓存，不在这里较劲。

目标音色是**卡拉OK 里那条规规矩矩的电子引导旋律**，不是"有人在哼"。四条决定成败的规格：

| 规格 | 为什么 |
|---|---|
| **音高量化到半音** | 人唱歌本就微微跑调，照实测 f0 合成等于把人的音准偏差搬到合成器上——哪怕波形是正弦，听感依然像人。踩在 MIDI 音高格上听感立刻变电子 |
| **短音符并入邻居，不丢弃** | 丢弃会留下空洞。并入音高最接近的一侧，两侧都够不着才丢 |
| **短清音间隙桥接成 legato，只有真休止才断** | pYIN 的清浊判定在辅音、换气、气声上很不稳，逐帧断开会把长音切碎 |
| **乐句内连续相位合成，淡入淡出只在乐句首尾** | 每个音符两端都做淡入淡出会一顿一顿。换音处只留几毫秒防 click 斜坡，那是防爆音不是音乐性的包络 |

**合成波必须带限**：谐波数按 `min(max_harmonics, 0.95 × 奈奎斯特 / f)` 截断，
否则高音区谐波越过奈奎斯特会产生刺耳的混叠噪声。谐波表归一化到单位 RMS，
这样换音色不必重调音量。

**判断连贯性看占空比与间隙分布，不要看音符计数。** 音符数受切分阈值支配、
与听感不成正比。真正对应听感的是**发声占空比 66.7% → 92.2%、间隙 >20ms 的个数
51 → 3**（换 CREPE 前后）。离半音格偏差则应当恰好为 0（中位/p90/max 全 0 音分）。

---

## 8.8 README 与多语言

### README

按 D0（公开仓库 + MIT + 发布安装包），README 要能让一个陌生人
在不读 `CLAUDE.md` 的前提下明白：这是什么、能做出什么、怎么装、怎么跑通第一个视频、
有哪些硬性前提（ffmpeg 必须带 libass、模型要下载、Intel Mac 不支持）。
既然装的是没签名的安装包，**Gatekeeper / SmartScreen 的绕过方式也属于"怎么装"的一部分**——
用户是先撞上拦截、再去找说明的，写在这里才来得及。

三份互相链接：`README.md`（英文，开源仓库的默认预期）、`README.zh-CN.md`、`README.ja.md`。
日语版不是可有可无——本工具做的就是日语卡拉OK，术语（ガイドメロディ / オフボーカル /
振り仮名）在日语里才是母语表达。

README 属于 `.claude/rules/doc-style.md` 里明确豁免"不许贴代码"的那一类，**可以且应当**
包含命令示例与截图。

### i18n（待实现）有个陷阱：后端在吐中文散文

界面语言至少覆盖**中文（源语言）/ 日本語 / English**。但只在前端包一层翻译函数是不够的
——**后端现在直接返回给用户看的中文句子，前端原样显示**。已知的几类：

| 位置 | 现在返回什么 |
|---|---|
| 分离依赖缺失提示 | 「请运行 `uv sync --extra separate` ……」整句中文 |
| 模型标识无法识别 | 「无法识别的分离模型标识：X。请改用档位名：……」整句中文 |
| 分离档位表 | `label` = 「快速」/「标准」/「最佳」，`hint` = 「84MB，最快……」——**这就是 UI 文案，只是由 API 下发** |
| 失效修正条目 | `OrphanedEdit.detail` 是「人类可读的中文说明」 |
| 各类任务失败原因 | 子进程拼出的中文错误串 |

**因此 i18n 必须包含一次 API 契约改造：后端返回「错误码 + 结构化参数」，由前端翻译。**
后端不再拼给人看的句子。档位表这类展示文案改为下发**键**（如 `separate.tier.fast`），
译文全部归前端。日志与开发者可见的诊断信息不受此限，可以继续是自然语言。

### 顺序（重要，做反了要返工两次）

1. **界面重排先落地**——`docs/ui-redesign.md` 明确要重写全部界面文案（"短而准"）。
   在重写之前抽取文案，等于翻译一批马上要被删掉的句子。
2. **但重排时就必须走翻译函数**：新写的组件从第一天起用 `t('...')` 取文案，
   哪怕此刻只有中文一种语言。否则等于要把所有组件再摸一遍。
3. 重排完成后再做：补齐译文、后端错误码改造、语言切换入口。

**选型倾向**：前端用 `react-i18next`（生态成熟、按需加载语言包简单）。
最终选型时注意 Artifact/Tauri 的离线约束——**语言包必须随应用打包，不许运行时联网拉取**
（§2.1 只允许"取数据"的联网，界面文案不属于此列）。

---

## 9. 待实测的开放问题

**凡标"待实测"的，一律先写实验代码验证，不要凭猜测写进生产路径。**

### 阻断编辑体验

1. **JASSUB `setEvent` 的端到端延迟**（IPC + libass 重排 + WebGL 上传）未实测，
   而它是"拖拽时实时看到字幕变化"的技术前提。若单次超过 16ms，拖拽必须改成
   "拖动时 DOM overlay 预览、松手才 setEvent"的双层策略。

2. **`pyopenjtalk.g2p` 吃纯假名串时的行为**：能否绕过词典直接做假名→音素？
   这是"注音与对齐共享读音"能否成立的关键节点——若不能，`[kana:]` 给的
   `reading_display` 就无法确定性地推导出 `reading_phonetic`。

### 影响成片质量

3. **时间轴重锚定**（见 §5.3）：歌词源的轴对齐的是流媒体母带而非 MV 音轨，
   目前整条链路直接用歌词源时间、未做任何重锚定。需实测波形互相关，
   量出真实 offset 与是否需要非线性 warp。

4. **对齐精度的 ground truth**：强制对齐尚未实现。落地后要人工标 20 个假名起点，
   量出模型在分离后歌声上的中位误差与 p90——这个数字决定 UI 需要多重的手工干预。
   **标注工具本身也要写。**

5. **段落（间奏）检测改进**：现在是固定阈值 4.0s，对慢歌会误判，而指示灯是
   nicokara 的标志性元素，判错段落就等于判错指示灯。用已有的 `vocals.wav` 做
   VAD 能量检测是免费的更好信号。

6. **自动分行**：现在只在行过宽时按最大时间间隙拆分。官方分行 ≠ nicokara 一屏两行，
   还需要按语法边界/字符数的主动重新分行，以及拆并行后的时间重分配策略。

### 歌词源

7. **Kugou vs QQ 谁做主源**：尚无同曲对比数据。半小时实测就能裁决。

8. **真正的"冷启动新歌"覆盖率**：换一首只有 MV、无同步商业发行的日语新歌重测。
   现有覆盖率结论都建立在有商业发行的样本上，不适用于这个场景。

### 分发前必须解决

9. **依赖的"获取"阶段**：ffmpeg 那一半**已实现并实测**（`kvm.bootstrap`，
   macOS arm64 端到端跑通；信任模型与下载源要求见 §2.6）。**模型权重与字体仍待实现**——
   同样要带进度、SHA256 校验、断点续传、可离线导入，装进 `kvm.paths.private_bin_dir()`
   或 `models_dir()`。照 §2.6 那三条来：URL 定版、期望哈希有独立来源、下载是显式动作。
   模型权重这一侧还多一个 ffmpeg 没有的问题：社区权重多数没有 LICENSE、
   也没有官方校验和，**"期望哈希有独立来源"这一条怎么满足，得先有答案**。
   Windows 端的 ffmpeg 获取**仍未在真机上验过**（哈希是在 macOS 上算的）。

10. **自建 ffmpeg 的实际工程量**：为 win-x64 与 mac-arm64 双平台自建含指定 libass
    commit 的 ffmpeg。**要么专门评估一次，要么明确接受"先用 Homebrew `ffmpeg-full`
    开发、分发问题后置"。**

11. **JASSUB 与 ffmpeg 的像素回归方案**：headless 截图 + ffmpeg 单帧输出做 SSIM 对比。
    重点覆盖 `\kf` 扫光边缘、`\blur`、`\bord+\shad`、`\fad`、`\t` 动画、
    日文小字号注音栅格化。

    **字体选择这一维已经有了**（`verify-font-chain.mjs`，见 §5.12），但它刻意
    **不跨引擎比像素**——两端是两份不同的 libass 构建，逐像素相等做不到，
    勉强比会得到一个"差不多"的阈值，而"差不多"正好盖住"换了个字体"这种量级的差异。
    它改为两端各自与自己的参照比，再合并结论。做整体像素回归时要正视同一个问题：
    **先想清楚阈值之下会漏掉什么**，不要先定阈值再找解释。

12. **Tauri 壳内的 WebView 兼容性**：macOS 侧**已实测**（结论见 §5.16），
    结论改变了外壳形态——界面必须由本地 HTTP 下发，不能内嵌进 app 协议。
    **Windows（WebView2）那半仍未实测**：探针已做成外壳的常驻能力
    （`src-tauri/probe/`），拿到 Windows 机器一条命令就能跑出同一张能力表。

---

## 10. Non-goals（明确不做）

- **不做纵书（縦書き）歌词**（已定 D12）。libass 的 `\kf` 在旋转/纵向下扫光方向错误（issue #293 / #406，未修），只能靠"每字一个 Dialogue + 横向 `\k`"硬拼。证据充分，早点砍掉比后期发现好。
- **不支持 Intel Mac**（PyTorch 2.2 后停止支持 Intel macOS，分离功能基本无解）。
- **不做云端加速档位**，哪怕是"可选的"。见 §2.1。
- **不做批量/歌单导入**（至少第一版）。MPS 显存 spill 阈值、磁盘预算、风控退避都是为单曲设计的。

---

## 11. 命令

**命名约定：新增脚本按此命名。** 动手前先确认目标脚本是否已存在。

### 环境准备与启动（主路径就是这两个脚本）

```bash
python3 scripts/setup.py     # 自检 + 装依赖（Python 3.12、全部 extras、前端 npm 包）
python3 scripts/dev.py       # 一键启动：先跑 setup.py，通过后同时拉起前后端
```

两个脚本都是 **stdlib-only 的 Python**，能被系统自带的任意 Python 3.9+ 直接跑起来
（它们的职责之一就是把 3.12 装出来，不能反过来要求 3.12 才能启动）。
**不要改成 `.sh` + `.ps1` 一对**：同一套逻辑写两遍，而只有一端会被实测，必然漂移。

`setup.py` 能自动装的：Python 3.12、`.venv` 与全部 extras、`frontend/node_modules`。
**不自动装** ffmpeg / Node.js / uv 自身，只探测 + 给可复制的命令。
ffmpeg 的自动获取归 `kvm.bootstrap`（应用启动时走知情下载，§2.6），
**不放进 `setup.py`**：命令行脚本没有摆出来源与校验和、等用户拍板的地方，
而"下载并执行一个第三方二进制"必须是显式动作。要在命令行装就用
`python -m kvm.bootstrap --fetch ffmpeg`，它会先把 URL 与 SHA256 打出来。

常用开关：`--check-only`（只检不装）、`--minimal`（只装 api+fonts，不拉 torch）、
`--json`（供界面/脚本消费）；`dev.py` 另有 `--backend-port` / `--frontend-port` /
`--skip-setup` / `--backend-only`。

### 环境自检

```bash
PYTHONPATH=backend uv run python -m kvm.doctor          # 人读的报告
PYTHONPATH=backend uv run python -m kvm.doctor --copy   # 顺便复制到剪贴板
PYTHONPATH=backend uv run python -m kvm.doctor --json   # 结构化，每项带稳定 key
```

**模块路径是 `kvm.doctor`，不是 `backend.doctor`**：`backend/` 只是 app-dir，
不是包（后端启动也靠 `--app-dir backend` / `PYTHONPATH=backend`）。

覆盖：平台矩阵、Python 版本、uv / Node / npm、前端依赖是否与锁文件对得上、
**ffmpeg 是否注册了 `ass` 滤镜**、ffprobe、libass 版本、六组 Python extras、
torch 设备（显式打印 `cuda.is_available()`）、模型权重是否已下载、系统字体、
应用数据目录可写性、磁盘余量、端口占用。

**改自检时必须同时验"坏环境下真的会报错"**，只验通过路径等于没验
（`tests/test_doctor.py` 用不带 libass 的 ffmpeg 替身守这条）。

### 手工开发命令（脚本内部就是跑这些，单独调试时用）

```bash
uv run uvicorn --app-dir backend kvm.api.app:app --host 127.0.0.1 --port 8000 --reload
cd frontend && npm run dev                     # Vite，COOP/COEP 头已在 vite.config.ts 配好
brew install ffmpeg-full                       # macOS：主线 ffmpeg 不带 libass！
ffmpeg -h filter=ass                           # 验证：返回 "Unknown filter" 说明没编 libass
```

### 代码质量

```bash
uv run ruff check . && uv run ruff format .
uv run pyright
uv run pytest -v
npm run lint && npm run typecheck
```

### 出片（已可用）

```bash
# 完整链路：QRC 工程 → 度量 → ASS → 烧录
uv run --python 3.12 --with numpy --with "librosa>=0.11" --with "numba>=0.61" \
  python backend/kvm/pipeline/make_video.py \
  --video   workspace/media/<视频>.mkv \
  --parsed  workspace/qrc/qrc_parsed.json \
  --kana    workspace/qrc/kana_entries.json \
  --drums   "workspace/sep_full/<曲名>_(Drums)_htdemucs.flac" \
  --out     workspace/out/成品.mp4

# 只出 ASS 不烧录（迭代样式时用，秒级）
… --ass-only --ass-out workspace/out/x.ass

# 试渲染片段（--start 用 output seek，字幕时间才不会错位）
… --start 34 --duration 14

# OFF VOCAL：替换音轨
… --audio workspace/sep_full/instrumental.wav
```

**注意 librosa 的依赖坑**：直接 `--with librosa` 会解析到不兼容 Python 3.12 的旧版
numba/llvmlite 并编译失败，必须显式约束 `--with "numba>=0.61"`。

人声分离（`audio-separator` 不会自动带上 `onnxruntime`，必须显式加）：

```bash
uv run --python 3.12 --with audio-separator --with onnxruntime audio-separator \
  workspace/media/audio_44k.wav --model_filename htdemucs.yaml \
  --model_file_dir workspace/sep_probe/models --output_dir workspace/sep_full
# 伴奏 = Bass + Drums + Other 相加（amix 必须 normalize=0，否则会被平均而变轻）
```

### 版本号与发版

```bash
python3 scripts/version.py --check         # 检查所有落点是否一致（不带参数同义）
python3 scripts/version.py --set 0.2.0     # 一条命令改全部落点（含各锁文件）
python3 scripts/version.py --print         # 只打印当前版本，供脚本消费
```

版本号的真源是 `pyproject.toml`，其余十余处（两个 `package.json`、`Cargo.toml`、
`tauri.conf.json`、FastAPI 的 `version=`，以及四份锁文件里记着的本项目自身条目）
都是副本，一律用 `--set` 一起改。`--check` 跑在 pytest 与 CI 里，手改漏一处就红。

**发版顺序：先 `--set` 改版本、提交，再对着那个 commit 打 tag。** 反过来（打完 tag
再让 CI 按 tag 注入版本）是错的：产物会和它对应的 commit 说法不一致，从成品追回源码
就断了线。CI 只做**校验**——打了 `v*` tag 就断言 tag 与仓库里的版本号相等，不一致
直接红，绝不覆写。

### 打包与环境自动获取

```bash
python3 scripts/package.py                # 前端构建 → PyInstaller onedir → Tauri 出包
python3 scripts/package.py --backend-only # 只打后端（调 PyInstaller 配置时）
python3 scripts/package.py --lean         # 排除 torch 等重依赖，只用来量体积
python3 scripts/make_icons.py             # 从 src-tauri/icons/source.png 生成整套图标

# 环境自动获取（§2.6「获取」阶段）
PYTHONPATH=backend uv run python -m kvm.bootstrap                # 看缺什么
PYTHONPATH=backend uv run python -m kvm.bootstrap --fetch ffmpeg # 下载并安装到应用私有目录
PYTHONPATH=backend uv run python -m kvm.bootstrap --import-from <归档>  # 离线导入

# 开发期在壳里跑（先 scripts/dev.py 起好前后端，再让壳指向 Vite —— 有 HMR）
KVM_BACKEND_ORIGIN=http://localhost:5173 npm run shell:dev

# WebView 能力探针（Windows 那端就靠它出结论）
python3 src-tauri/probe/probe_server.py 8321 src-tauri/probe/sample.mp4
npm run shell:probe
KVM_UI_URL=http://127.0.0.1:8321/ src-tauri/target/debug/kvm-shell
```

**`tauri dev` 测不出跨源隔离**（dev server 不发 COOP/COEP，恒得 false），必须 `tauri build`。

### 实验脚本（已存在，作为结论证据与回归基线）

```bash
uv run python -m experiments.ass_clip_animation      # 描边翻色的 clip 动画
uv run python -m experiments.text_metrics_advance    # 度量：尾随标记块法（生产采用这个）
uv run python -m experiments.text_metrics_libass     # 度量：墨迹法对照（有偏差，勿用于生产）
uv run python -m experiments.qrc_decrypt             # QRC 解密
uv run python -m experiments.reanchor_xcorr          # 重锚定
uv run python -m experiments.download_bilibili       # bilibili 兼容性
uv run python -m experiments.furigana_local          # 注音链路
uv run python -m experiments.separation_check        # 分离后端
uv run python -m experiments.ass_embedded_fonts      # 内嵌字体能否接管缺字回退（§5.12）
```

### 自检里**尚未**覆盖的两项（都是"要另建机制"，不是漏写）

- **libass 是否与 JASSUB 同 commit**（§5.12）：自检只报告 ffmpeg 链接的 libass
  版本，不做判定——版本号证明不了两端同源，要靠像素回归（§9 第 11 条）。
  而且除 macOS 外根本读不出 libass 版本，别为了填满这一栏去猜。
- **字体缺字**（§2.6）：那是"本曲全部字符 + 注音假名"对某个具体字体的 cmap 覆盖判定，
  只有在选定字体与歌词之后才有意义；而全量扫系统字体要 30–40 秒，
  放进每次启动的自检里就是纯粹的等待。判定留在样式步骤，自检只查扫描能力是否具备。

---

## 12. 参考实现（读源码，不要直接依赖）

| 仓库 | 值得看什么 | 注意 |
|---|---|---|
| `chenmozhijin/LDDC` | QQ/酷狗/网易 API + 解密 + QRC/KRC/YRC 解析 + ASS 转换，质量最高 | **GPL-3.0-only** |
| `WXRIW/QQMusicDecoder` | QRC 的 buggy-DES 实现 | MIT，可移植 |
| `FMPeach/Kirakara-Player` | nicokara 视觉参数 + **唯一真做到描边翻色的实现**（Canvas 4-Pass + clip） | 个人小项目，MIT；配色/布局数值可参考，默认字体 `Microsoft YaHei` 绝不能用 |
| `delete039/nicokara-studio` | ASS 头部模板、逐字时长分配、槽位分配 | 无可视化编辑器（正是我们要做的部分）；配色反了；含 DeepSeek 云端调用必须砍 |
| `Aegisub` `karaskel-auto4.lua` | 注音 layout group 算法（BSD 风格许可，可移植） | 两趟遍历；符号解析在 `preproc_line_text` |
| `nomadkaraoke/python-lyrics-transcriber` | Whisper + 歌词源 → 词级时间戳 → ASS/LRC，与本项目第 4-6 步高度重叠 | 与 `audio-separator` 同一维护者，接口天然衔接 |
| `walterfr/UltraStarKaraokeMaker` | Tauri + Rust + Python sidecar，多遍锚点式增量对齐 | 架构几乎同构 |
| `oHEILIo/Forced-Alignment-For-NicoKara` | MMS_FA + Silero VAD + 音量阈值混合端点检测 | 纯本地栈 |
| `arch1t3cht` 的 renderer internals gist | libass 性能模型、缓存机制、`\kf` 实现原理 | 权威 |