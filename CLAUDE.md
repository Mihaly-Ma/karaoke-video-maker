# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 0. 当前状态（重要）

**这是一个空仓库。除本文件外没有任何代码。** 目录 `assets/ backend/ docs/ frontend/ tests/` 目前均为空脚手架。

本文件中出现的一切架构描述、目录约定、数据结构、命令，除非明确标注"已实测"，否则都是**已确定的设计决策**或**待实现项**，不是既成事实。写代码时以本文件为设计契约，不要假设某个模块、脚本、接口已经存在。

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

开发机 ffmpeg 缺 libass、系统 Python 是 3.14 —— 这些是**待补齐的环境准备项**，不是设计约束。按理想架构设计，然后补环境。

---

## 3. 待用户拍板（阻塞下游至少 5 项选型）

**D0：产品最终是"私有自用"还是"对外分发二进制"？**

这个问题直接决定：

| 决策点 | 私有自用 | 对外分发 |
|---|---|---|
| ffmpeg | GPL 构建即可（Homebrew `ffmpeg-full`） | 必须自建 LGPL-only 构建 |
| LDDC / pykakasi / qqmusic-api-python（均 GPL-3.0） | 可直接依赖 | 会传染整个应用，必须重写 |
| MMS_FA / ctc-forced-aligner 权重（CC-BY-NC 4.0） | 可用 | 不可用，需换模型 |
| UVR / Roformer 权重（社区惯例授权，多数无 LICENSE） | 可打包 | 只能运行时下载 + 署名 |
| 代码签名 | 不需要 | macOS $99/年 + notarization；Windows 需签名 |

**在 D0 拍板之前**：按"私有自用"实现（用最省事的依赖快速跑通链路），但**所有 GPL 依赖必须集中在可替换的 adapter 层**，不要让 GPL 代码的类型渗进核心数据模型。

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

**唯一真源是工程文件，不是 ASS。** ASS 只是渲染目标，从工程文件序列化产生，永远不被反向解析回来。四个独立调研领域得出同一结论，这条不要动摇。

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

**Mora**（时间轴的原子单位）

| 字段 | 说明 |
|---|---|
| `kana` | 单拍假名（拗音 `きゃ` 合并为一拍） |
| `phonemes[]` | 音素序列 |
| `surface_span` | 对应 surface 的字符区间 |
| `t_start_ms` / `t_end_ms` | 整数毫秒，**边界共享**：`mora[i].t_end_ms === mora[i+1].t_start_ms`（同一个值） |
| `timing_source` | `provider` / `aligned` / `interpolated` / `manual` |
| `locked_timing` | 用户是否手工拖过这个边界 |

#### 必须写进单元测试的不变式

1. `concat(mora.kana) === token.reading_display`
2. 每个 mora 的 `surface_span` 落在某个 ruby span 或某个假名字符上
3. ruby span 与假名字符**无缝、无重叠**地覆盖整个 surface
4. 同一行内相邻 mora 的边界值严格相等（边界数组语义，不是两个独立的 end/start）
5. 序列化后 `sum(\k) === 行时长`

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
- 主键用内容寻址三元组：`(归一化行文本的 hash, surface, 该 surface 在本行的第 n 次出现)`
- 次要模糊重绑：行内字符偏移
- **重绑失败的锁定项不要静默丢弃**，收进「失效修正」列表让用户确认。静默丢弃 = 用户调了 40 分钟的轴莫名其妙消失

### 4.5 读音的四/五层优先级模型

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

已实测（2026-08，单次快照）：验证曲 MV `HCC-0sr_-lo` 无 cookie / 无 PO Token 即可取到 31 个 format 含 2160p。**这是易碎的时间快照，不是长期保证。**

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

Provider 清单（**优先级未最终裁决，见 §9**）：

| Provider | 粒度 | 端点/方式 | 状态 |
|---|---|---|---|
| QQ音乐 QRC | 逐字 + `[kana:]` + 罗马音 + 翻译 | `POST https://u.y.qq.com/cgi-bin/musicu.fcg`，`module=music.musichallSong.PlayLyricInfo` / `method=GetPlayLyricInfo`，param 含 `crypt:1, qrc:1, roma:1, trans:1` | 端点已实测；**解密闭环未裁决** |
| 酷狗 KRC | 逐字 + `[kana:]` | 三步：`mobiles.kugou.com/api/v3/search/song` → `krcs.kugou.com/search` → `lyrics.kugou.com/download`；解密 = base64 → 去 4 字节 `krc1` 头 → 与 16 字节密钥 `40 47 61 77 5E 32 74 47 51 36 31 2D CE D2 6E 69` 循环 XOR → zlib | 已实测端到端跑通 |
| 网易云 | 行级 LRC + 中译 + **按拍分词罗马音** | `music.163.com/api/song/lyric?id=...&lv=1&kv=1&tv=1&rv=1` | 已实测；**匿名 API 与匿名 eapi 都拿不到 yrc 逐字**，别为 yrc 投入 eapi 工程量 |
| YouTube 官方 ja 字幕 | 句级，**已在 MV 时间轴上** | yt-dlp `subtitles.ja`（与 `automatic_captions` 分离即人工轨） | 已实测，65 行。**最稳的兜底，完全不依赖中国大陆 API** |
| LRCLIB | 行级 | `https://lrclib.net/api/search`，无鉴权 | 已实测 |
| UtaTen | 纯文本 + **权威 ruby** | 页面 `<span class="rb">/<span class="rt">` 成对 | 已实测可抓 |
| 用户手动粘贴 | 纯文本 | — | 必须留这个口子 |

**QRC 解密**：hex → **魔改（有 bug 的）3DES-ECB** → zlib inflate。密钥 ASCII `!@#)(*$%123ZXC!@!@#)(NHL`。腾讯的 DES S-box 有笔误（sbox2 第 2 行第 8 项是 15 而非 14；sbox4 第 4 行第 6 项是 10 而非 1 等），**`pycryptodome` / `cryptography` 的标准 DES3 解出来是垃圾**。可移植来源：MIT 的 `WXRIW/QQMusicDecoder`（C#）、`jixunmoe-go/qrc`（Go）、`wangqr/QQMusicDES`（C）；GPL 的 `chenmozhijin/LDDC`（Python，`core/decryptor/tripledes.py`）质量最高但会污染闭源分发。

**关于验证曲的覆盖率结论（重要，不要被误导）**：`赤春花 (feat. 幾田りら)` 的 QQ 入库时间是 2026-02-27，紧随其**数字先行配信 2026-01-29 / 实体发售 2026-02-25**，而不是紧随 MV 公开的 2026-07-23。也就是说**"两周新歌冷启动"这个场景从来没被验证过**。三个调研领域都在用这个不成立的样本论证覆盖率。所以：

- 「20 首日语曲 20/20 命中 QRC」这个结论只适用于**有商业单曲发行的曲目**（样本选择偏差就是被测变量本身），置信度应视为 medium
- 强制对齐兜底路径**不能降级**
- 需要另找一首"只有 MV、无同步商业发行"的真新歌重测

### 5.3 时间轴重锚定（最大的缺口，零调研）

**问题**：所有中文平台的歌词时间轴对齐的是**流媒体母带**，不是 YouTube MV 音轨。MV 常有不同的前奏长度、淡入淡出、专属剪辑。至少 6 处调研都写了"必须做全局 offset + 逐句漂移校正"，但**没有任何领域调研过怎么做**。

**已作废的结论**：曾有结论称"MV 与母带时间轴差 11ms，偏移是全局单一常数，不要写复杂重对齐逻辑"。这条**推理不成立**——它是用 YouTube 官方句级人工字幕对比网易句级 LRC 得出的，两者都是人手打的句级时间轴，本身就有 ±100ms 的随意性。**用两份人工标注的一致性无法证明两条音频轨的时间基准一致。** 不要据此简化架构。

**待实现的设计方向**（未经验证，实现时必须先做实验）：

1. 用分离出的 `vocals.wav` 做能量/onset 包络，与歌词源首字时间做互相关，估全局 offset
2. 行级锚点做 RANSAC 拟合仿射变换（offset + scale），抗离群
3. 残差过大的段落降级为分段线性；MV 有额外前奏/间奏剪辑时必然需要 DTW warp
4. 校准置信度低于阈值的段落标记为「需人工确认」，在 UI 上打红标，**不要静默输出错的轴**

这是「有 QRC」和「能用 QRC」之间的唯一桥梁。不解决它，QRC 全链路跑通也交付不了第一个视频。

### 5.4 人声分离

**`audio-separator`**（PyPI `audio-separator`，当前 0.44.5，MIT，Nomad Karaoke 维护），不要直接封装 `demucs`。它把 MDX / VR / MDXC-Roformer / Demucs 四种架构收敛到一个 `Separator` 类和一套模型文件名命名空间。

默认模型：`model_bs_roformer_ep_317_sdr_12.9755.ckpt`（639 MB，原生 2-stem）。

档位（暴露给用户三档）：

| 档 | 模型 | 用途 |
|---|---|---|
| 快速 | `htdemucs`（84 MB） | 首次导入立刻出个能听的伴奏，让用户开始调轴 |
| 标准（默认） | `mel_band_roformer_kim_ft_unwa.ckpt` | 比 BS-Roformer 快约 2.3x，SDR 仅低 0.1 |
| 最佳 | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | 最慢 |

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

### 5.5 强制对齐

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
| 提前入场 | fade(0.666s) + 0.5s + indicator(3s) = **4.17s**（指示灯开）/ 2.0s（关） |
| 淡入淡出 | 666ms，**仅作用于段落首/末行**；段内行走完即切 |
| 指示灯 | 4 个圆点，仅段落首行，总时长 3s，每 0.75s 熄一个，**从右往左**；直径 51px，间距 18px，白填充 + 黑描边 4.5px |
| 全局 offset | 必须有旋钮（对应 NicoKaraMaker 的 `@Offset=`） |

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

峰值数据由 **Python 后端预计算**（ffmpeg 解码 → numpy min/max，多级 LOD），输出 BBC waveform-data 格式。**不要打包 `audiowaveform` 二进制**——为一个 min/max 循环多背一个原生依赖不划算。

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

### 5.12 两端 libass 必须同源（已定 D3 / D4）

这是"所见即所得"能不能兑现的地基。

**D3：ffmpeg 侧必须 vendor 与 JASSUB 完全相同的 libass commit。** "libass >= 0.17.5"是**不充分的** —— JASSUB 2.5.14 的 submodule 固定在 libass master `266b9831`（2026-07-24），比 0.17.5 tag 还领先 22 个 commit，其中包含尚未发布的无锁线程安全缓存架构与逐 event 多线程渲染重写。同时锁 freetype / harfbuzz / fribidi 的 commit。**升级 JASSUB 必须同步重建 ffmpeg 并跑像素回归。**

**D4：显式写 `LayoutResX` / `LayoutResY` = 输出分辨率**，不只是 `PlayResX/Y`。机制：

- `screen_scale = frame / PlayRes` → 只影响字号与 `ScaledBorderAndShadow: yes` 时的描边阴影，是等比缩放，PlayRes 具体取值不影响外观（宽高比匹配即可）
- `blur_scale = frame / ass_layout_res()` → 决定 `\blur`、`\be` 与 SBAS=no 时的描边阴影；`ass_layout_res()` 只看 `LayoutResX/Y` 头，其次才是 storage_size
- JASSUB 把 storage 设为视频原生尺寸，ffmpeg 默认设为滤镜输入帧尺寸 —— **只要源分辨率 ≠ 导出分辨率，或 subtitles 前有 scale，`\blur` 半径必然分叉**

日式 karaoke 重度依赖 `\blur` 做发光柔边，这个坑必然命中。显式写 `LayoutResX/Y` 就把两端都钉死了。同时显式写 `ScaledBorderAndShadow: yes`。

**字体**：JASSUB 用 `ASS_FONTPROVIDER_NONE`（浏览器侧没有系统字体，必须通过 `fonts` / `availableFonts` 显式喂入，自带的 `default.woff2` 只有 145KB 不含 CJK；关闭 `queryFonts`（会联网拉 Google Fonts）与 `useLocalFonts`（Chromium 独有、需授权、破坏确定性））。ffmpeg 用 `ASS_FONTPROVIDER_AUTODETECT`，`fontsdir` 只是**追加**搜索路径，**无法禁用** CoreText / DirectWrite / fontconfig 回退。所以更稳的做法是把字体 UUEncode 进 ASS 的 `[Fonts]` 段，并给打包字体使用唯一的 family name 以降低误匹配。

**目标是感知等价，不是像素级一致** —— JASSUB 的 `_computeRenderSize()` 默认 `prescaleHeightLimit=1080` 并乘 devicePixelRatio 取整，预览光栅化尺寸几乎不可能等于导出尺寸。回归测试用 SSIM 或像素差阈值。

### 5.13 后端长任务编排（已定 D5，待实现）

**「重计算作业」的通用架构**：独立子进程 + JSON-lines 进度协议 + 按 `(input_hash, params, version)` 缓存 + 可取消。适用于分离、强制对齐、烧录、峰值计算 —— 它们有完全相同的约束。

- **绝不在 FastAPI 的 async handler 或 ThreadPoolExecutor 里直接调 torch**：torch MPS 不 fork-safe；几十秒到几分钟的阻塞会让后端假死且无法取消；OOM / 段错误不能拖垮整个进程
- **并发闸门**：Demucs（几 GB 内存）+ ffmpeg 烧录 + JASSUB 预览同时跑会 OOM，必须有全局作业闸门
- **缓存键**：分离用 `(audio_sha256, model_id, backend_version)`；对齐用 `(vocals_sha256, text_hash, model_id, params)`；烧录用 `(ass_hash, video_hash, encode_params, libass_commit)`
- **磁盘预算**：一首歌 = 原视频 + 音频 + 2 条 stem + 代理视频 + 成片 ×2，轻松 3-5 GB。工作区必须有生命周期管理与磁盘余量检查
- **取消语义**：kill 子进程后临时文件由发起方清理，不要指望子进程自己收尾

### 5.14 模型权重分发（已定 D11）

**运行时下载，绝不打进安装包。** 独立进度条 + SHA256 校验 + 断点续传（HTTP Range，Tauri 自带 updater 不提供断点续传）+ 支持离线导入 + `HF_HUB_OFFLINE` / `HF_HOME` 控制。

**不要让 transformers / huggingface_hub 在后台静默拉 1.26 GB 权重** —— 弱网环境下用户会以为程序卡死。

模型总量约 1.3–2.5 GB（对齐 ~1.26 GB + 分离 639 MB + 可选 faster-whisper ~1.5 GB）。

**`audio-separator` 默认把模型下载到 `/tmp/audio-separator-models/`** —— macOS 会被系统定期清理、Windows 语义完全不对。**必须显式传 `model_file_dir`** 指向 `platformdirs.user_cache_dir`。

### 5.15 打包（后期）

- Tauri 2 作为壳；Python 后端用 PyInstaller `--onedir`（**不是 `--onefile`**，PyTorch 体量下每次启动解压体验崩坏）
- **风险**：Tauri `externalBin` 在 macOS 上会导致 notarization 失败（`tauri-apps/tauri#11992`，仍 open，无 workaround）。这是**分发路径上的潜在阻断项**，不是脚注 —— 若走对外分发路线，必须先验证这条
- Windows NSIS/WiX 有 **2GB 单安装包硬上限**（`tauri-apps/tauri#7372`）。这是"把 PyTorch CUDA 版 + 模型全塞进安装包"的直接天花板
- torch 默认只装 CPU wheel（macOS arm64 约 75MB 自带 MPS；Windows CPU 约 111MB）。CUDA 版单个 wheel 就 2.58GB，**uv 必须显式配 PyTorch index + 平台 marker**（PyPI 的 Windows torch wheel 是 CPU-only，不配就会静默得到 CPU 版）
- 字体：`Noto Sans JP` / `源真ゴシック`（均 SIL OFL 1.1，允许随应用捆绑，需保留版权与许可证文本，不能单卖字体）

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
- **`\k`/`\kf` 只插值 PrimaryColour，描边色不跟着走字翻转**。而"黑边→白边"恰恰是 nicokara 最标志性的观感。**参考实现里只有 Kirakara-Player 真做到了，用的是浏览器 Canvas 2D 逐字 4-Pass 重绘 + `ctx.clip()`，完全脱离 ASS/libass**；`nicokara-studio` 的三层叠加只解决了填充色渐进，描边色自始至终没变过。**纯 ASS 目前没有任何已验证方案** —— 见 §9 第一项
- **一旦对注音行用 `\pos`，主歌词行也必须 `\pos`**（`\pos` 关闭碰撞检测），否则 libass 会把主行挪走、注音对不上
- **注音是派生量不是存量（已定 D8）**：换字体/字号/字距后所有注音坐标必须重算。度量由**单一实现**产出（建议后端 `uharfbuzz` 或 libass 绑定），前端只消费坐标，**绝不用 Canvas `measureText`**（不支持 letter-spacing，CJK 混排偏移肉眼可见）
- **字宽估算的固定比例是权宜之计**：`nicokara-studio` 用 `_CHAR_WIDTH_RATIO = 0.68`，在汉字/假名/拉丁/半角标点混排时必偏
- **描边宽度单位有三重语义歧义**：NicoKaraMaker 的「縁の幅」、Canvas `lineWidth`（居中描边，实际外扩只有一半）、ASS `\bord`（纯外扩半径）不是一回事。Kirakara 的 `strokeWidth 5 @ fontSize 64` 换算成 ASS `\bord` 只有约 3.75。直接把日本教程的数字填进 Outline 会粗到糊成一团。以 `\bord ≈ 字号 × 0.055~0.07` 为起点再目视调
- **`\blur` 的成本不在强度而在 bitmap padding**（每边约 7×blur 像素）。大量音节同时带强 blur 会让同屏 bitmap 总面积爆炸 —— 这才是 libass 的真实性能瓶颈，不是 event 数量
- **ミルフィーユ（上下半分双色）和纵向渐变在 ASS 里没有原生支持**，只能用两个横向 `\clip` 带叠加，事件数翻倍
- **ffmpeg 硬压时渐变/彩虹效果出现条带**（libass #816，被判定为"非 libass 的 bug"），根源在 YUV 色度子采样。考虑 `format=yuv444p` 或提高位深
- **ASS 是实现定义格式**，libass 与 VSFilter 不一致时官方立场是"VSFilter 对、libass 错"，libass 的偏离行为随时可能改。**必须把 libass 版本当作产品依赖锁死，不要用系统 ffmpeg**
- **字体覆盖检查必须做成硬性 pre-flight check**（约 20 行：用 `fontTools` 读 cmap，扫描全部歌词字符 + 注音假名）。缺字后果严重：预览和导出可能 fallback 到**不同**字体，直接摧毁 WYSIWYG
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

见 §4.4。核心一句话：**用「第几行第几个 token」做主键，重新分行后锁定项会全部错位**。用 `(归一化行文本 hash, surface, 本行第 n 次出现)` 三元组，重绑失败的收进「失效修正」列表让用户确认，**不要静默丢弃**。

### 7.4 UI 反馈

`source` 字段必须在 UI 上用颜色可见地区分：`provider`（歌词源）/ `aligned`（自动对齐）/ `interpolated`（插值推算）/ `manual`（手工）。这是"一站式"体验的核心可见反馈 —— 用户要知道哪些数字可信、哪些需要复核。

---

## 8. 编辑器状态层（零调研，但没有它就只有一个跑批工具）

**待实现**，且必须在写调轴 UI 之前定下来：

- **undo/redo 与"强制对齐重跑"如何共存**：重跑是**一个** undo 单元（整个批量变更打包成一个 patch），不是 N 个
- **项目持久化**：`project.json` 单文件 + schema 版本字段 + 迁移函数链。自动保存节流（建议 debounce 2-5s + 关键操作立即保存）
- **崩溃恢复**：用户调了 40 分钟轴、进程崩了，必须能恢复。写入用 write-temp-then-rename 保证原子性
- **重算与编辑的并发**：后台重跑对齐时用户仍在拖别的边界 —— 重跑结果落盘前必须与当前状态做 `locked` 感知的三方合并，不能整体覆盖

---

## 9. 待实测的开放问题（按阻断性排序）

**前四项里有三项不需要联网调研，只需要写 50 行代码跑一次实验。在补更多外部调研之前，先把这三个实验做掉。**

### P0 — 阻断第一个视频

1. **描边翻色的 ASS 方案实测**（20 行 ASS + 一次 ffmpeg 就能定）
   核心问题：**libass 是否支持 `\t(t1,t2,\clip(x1,y1,x2,y2))` 的矩形 clip 动画？** 官方文档说 `\t` 只有矩形版 `\clip` 能动画，而水平扫光恰好只需要矩形版，所以答案很可能是"支持"。写一个最小 ASS 跑一次 ffmpeg 就能定。**这是第一个视频能不能有 nicokara 观感的决定性问题。** 若不支持，退化成逐音节静态 `\clip` 事件，事件数暴涨。

2. **文本度量闭环**（本项目最大的单点技术风险，注音错位 = 日式卡拉OK 观感崩塌）
   所有调研都在纠结"`uharfbuzz` 能否近似 libass"，**没人问"能不能直接用 libass 本身"**。两条确定性路径未被评估：
   - ctypes/cffi 封装 `ass_render_frame`，渲染一行到内存，读 `ASS_Image` 链表的 `dst_x/dst_y/w/h` 反推包围盒
   - 用 ffmpeg `-vf ass=...:alpha=1 -frames:v 1` 渲染到透明帧，用 numpy 求 bbox

   两条都是本地、跨平台、且**定义上就与最终渲染一致**。先试这两条，`uharfbuzz` 只作为快速路径 + 用 libass 结果标定修正系数。

3. **QRC 解密链路是否真正闭环**（两个调研领域结论直接对立）
   一方称"解密成功，10926 字符 QRC XML，首句 `桜(774,665)舞(1439,188)...`"；另一方称"没有真正看到解密后的 XML，标准 DES 9 次全败"。**这必须立刻裁决**：若解密成功，把那段代码固化下来；若没跑通，整条主链路的地基是空的，第一版应改走「YouTube 官方 ja 字幕 + 强制对齐」路线。
   同时验证：QRC 内容是真逐字还是退化的句级 QRC；逐字切分粒度是按汉字词块（`桜/舞/って`）还是按拍。

4. **重锚定算法实验**（见 §5.3）：拿验证曲的 MV 与 Art Track（`PZ3CB2vmGYo`，260s，Sony 官方上传）实测波形互相关，量出真实 offset 与是否需要非线性 warp。**不要沿用"差 11ms、全局单一常数"这个已作废的结论。**

### P1 — 阻断"一站式"

5. **JASSUB `setEvent` 的端到端延迟**（IPC + libass 重排 + WebGL 上传）。它被写成了"整个一站式的技术前提"，但**未实测**。若单次超过 16ms，拖拽必须改成"拖动时 DOM overlay 预览、松手才 setEvent"的双层策略。第一周就写最小 spike。

6. **JASSUB 与 ffmpeg 的像素回归方案**：headless 截图（Playwright？）+ ffmpeg 单帧输出做 SSIM 对比。重点覆盖 `\kf` 扫光边缘、`\blur`、`\bord+\shad`、`\fad`、`\t` 动画、日文小字号注音栅格化。这个 CI 方案本身没被调研过。

7. **`pyopenjtalk.g2p` 吃纯假名串时的行为**：能否绕过词典直接做假名→音素？这是"注音与对齐共享读音"方案能否成立的关键节点 —— 若不能，`[kana:]` 给的 `reading_display` 就无法确定性地推导出 `reading_phonetic`。

8. **编辑器状态层设计**（见 §8）—— 不是实测，是必须先设计。

### P2 — 影响质量与工作量

9. **Kugou vs QQ 谁做主源**：两个调研领域给出完全相反的排序，两边都承认"没做同曲对比"。**半小时实测就能裁决。**

10. **真正的"冷启动新歌"覆盖率**：换一首只有 MV、无同步商业发行的日语新歌，重测 QQ/Kugou/网易/LRCLIB 的覆盖情况。当前所有覆盖率结论都建立在一个不成立的样本上。

11. **对齐精度的 ground truth**：拿验证曲人工标 20 个假名起点，量出 `vumichien` 模型在分离后歌声上的中位误差与 p90。这个数字决定 UI 需要多重的手工干预，比任何进一步的文献调研都有价值。**标注工具本身也要写。**

12. **自动分行算法**：官方分行 ≠ nicokara 一屏两行。按时长间隔？按全角字符数 12-20？按语法边界？拆并行后时间如何重分配？零调研。

13. **段落（间奏）检测**：当前只有固定阈值 4.0s，对慢歌会误判，而**指示灯（4 点倒计时）是 nicokara 的标志性元素，判错段落就等于判错指示灯**。你本来就已经有 `vocals.wav`，用它的 VAD 能量做段落检测是免费的更好信号 —— 这条没人调研过。

14. **对唱声部归属（diarization）**：两个领域都说"必须手动标记""本地没有可靠方案"，但**没人真去查**。至少这三条值得评估：`pyannote.audio`（本地推理，模型在 HF 需接受条款）；先用 `mel_band_roformer_karaoke_*` 分 lead/backing 再按能量归属；QQ 的 `singingAnnotationsLyric` 字段（对本曲为空，但格式与覆盖面未查）。验证曲正好是男女对唱。

15. **环境自检设计**：ffmpeg 是否带 libass、libass 版本、torch 设备、模型是否已下载、字体是否齐、磁盘余量。桌面工具必须有这个，目前零设计。

16. **`ffmpeg` 自建的实际工程量**：为 win-x64 与 mac-arm64 双平台自建含指定 libass commit 的 ffmpeg，调研里只有一句"自己在 CI 里编译"。**要么单独立一个调研，要么明确接受"先用 Homebrew `ffmpeg-full` 开发、分发问题后置"。**

17. **Tauri WebView 兼容性**：Windows WebView2（Chromium）与 macOS WKWebView（WebKit）对 rVFC、`OffscreenCanvas.transferControlToOffscreen`、`VideoFrame`、COOP/COEP + SharedArrayBuffer 的支持。JASSUB 要求 Safari 17+，仓库里有 "fix: iOS" 类 commit 说明 WebKit 路径有过坑。**两个平台都要早测。**

18. **编辑用代理视频**：4-5 分钟 H.264 高码率 + 长 GOP 视频在 WebView 里 seek 是否够快支持"逐帧步进核对音节边界"？可能需要后端预转低分辨率短 GOP（甚至全 I 帧）代理视频专供编辑器。**这会显著改变后端设计，值得早决策。**

19. **验证曲是否真的没有官方 instrumental**：只能证明"在 CD 曲目表和主流检索中未找到"。可再查 Apple Music / mora 的『Honto』完整曲目 —— 若存在官方 inst，第一个视频质量会有质的差别。

---

## 10. Non-goals（明确不做）

- **不做纵书（縦書き）歌词**（已定 D12）。libass 的 `\kf` 在旋转/纵向下扫光方向错误（issue #293 / #406，未修），只能靠"每字一个 Dialogue + 横向 `\k`"硬拼。证据充分，早点砍掉比后期发现好。
- **不支持 Intel Mac**（PyTorch 2.2 后停止支持 Intel macOS，分离功能基本无解）。
- **不做云端加速档位**，哪怕是"可选的"。见 §2.1。
- **不做批量/歌单导入**（至少第一版）。MPS 显存 spill 阈值、磁盘预算、风控退避都是为单曲设计的。

---

## 11. 命令

**以下命令绝大多数对应的脚本尚未存在。** 列在这里是作为约定，实现时按此命名。

### 环境准备（一次性，待补齐）

```bash
# ffmpeg —— 必须带 libass。Homebrew 主线 ffmpeg 不带！
brew install ffmpeg-full                      # macOS，开发期临时方案
# 分发前需自建 vendor 指定 libass commit 的 ffmpeg（见 §5.12 / §9 第16项）
ffmpeg -h filter=ass                          # 验证：返回 "Unknown filter" 说明没编 libass

# Python —— 系统是 3.14，项目要 3.12
uv python install 3.12
uv sync

# Node（前端）
npm install
```

### 开发（待实现）

```bash
uv run uvicorn backend.app.main:app --reload   # 后端，需自行确认最终模块路径
npm run dev                                    # 前端（Vite，须配 COOP/COEP headers）
```

### 代码质量

```bash
uv run ruff check . && uv run ruff format .
uv run pyright
uv run pytest -v
npm run lint && npm run typecheck
```

### 待实现的实验脚本（对应 §9 的 P0）

```bash
# 这些脚本都还不存在，是 §9 前四项实验的落点，命名为约定
uv run python -m experiments.ass_clip_animation      # P0-1 描边翻色
uv run python -m experiments.text_metrics_libass     # P0-2 度量闭环
uv run python -m experiments.qrc_decrypt             # P0-3 QRC 解密闭环
uv run python -m experiments.reanchor_xcorr          # P0-4 重锚定实验
```

### 环境自检（待实现）

```bash
uv run python -m backend.doctor
# 应检查：ffmpeg 是否带 libass、libass 版本是否与 JASSUB 同 commit、
#         torch 设备（cuda/mps/cpu）、模型权重是否已下载、字体覆盖、磁盘余量
```

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