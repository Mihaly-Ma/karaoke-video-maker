# 事故记录：GPU 版打包撞穿 NSIS 2 GB 上限

> CI run #28（tag `v0.2.0`），job `打包 (windows-x64-cuda)`，step「出包」退出码 1。
> macOS 与 windows-x64（CPU）两条不受影响。修复在 v0.2.1。

## 现象

```
Internal compiler error #12345: error mmapping file (2064879402, 33554432) is out of range.
failed to bundle project: `Failed to bundle app with makensis`
```

这句话与体积无关的措辞是 NSIS 自己的锅：`Source/mmap.cpp` 用**有符号 32 位整数**
存偏移与长度，数据一过 2³¹ 就变负，`offset + size > m_iSize` 随之给出一个假的
「out of range」。报错里那个 offset **2064879402 ≈ 1.92 GB**，就是撞线的证据。

## 根因：契约只写了一半

`scripts/package.py` 的 docstring 里早就写定了立场——「CUDA 版 torch 不进包（已定）」。
但 `.github/workflows/ci.yml` 的 `windows-x64-cuda` 那条 matrix 先把 torch 换成 CUDA
轮子，然后调用**同一个** `scripts/package.py`；脚本并不知道自己这次不该出安装器，
照常走到 NSIS。

**所以这不是「体积超了」这么一个孤立事实，而是口径写在文档里、没有写进代码里。**
一段散文拦不住一条 matrix。

它此前是擦着线过的：`package.py` 里那句注释写着「GPU 版实测压完 1.63 GB，离上限只剩
375 MB，torch 升一次版就可能吃掉」。torch 就是升了一次版。这条注释预言得很准，
只是没有变成一道能执行的闸门。

## 第二个缺陷：闸门装在了下游

`_check_installer_limit()` 正是为拦这件事写的，可它**从写下来那天起就没有开口的机会**：

```python
if not args.backend_only:
    build_shell()      # ← NSIS 在这里炸，直接 SystemExit
report()               # ← _check_installer_limit() 在这里面，轮不到执行
```

它读的是 `bundle/` 里**已经产出**的 `.exe`/`.msi`——而撞穿上限时那个文件根本不会产出。
结果就是这次的形态：本该被自家闸门以一句人话拦住的事，最后以一句 mmap 报错出现，
中间还白烧了约 7 分钟 Rust 编译。

## 修复

### 1. GPU 版改出免安装 zip（`package.py --portable`）

带 CUDA 运行时的 Windows 产物**基本没有人做成安装包**：ComfyUI 官方分发就是
`ComfyUI_windows_portable_nvidia.7z`，A1111 一族同理。NSIS 侧确实有绕过 2 GB 的分支
（nsisbi）与插件（CABSetup），但 Tauri 的打包器会自己下载并校验它那份 NSIS 3.11
（构建日志里那两行 Downloading + validating hash），换编译器等于绕开整个 bundler；
换 WiX/MSI 也不是出路，`tauri-apps/tauri#7372` 明确两者都失败。

对本项目这条路格外便宜，因为**外壳一行 Rust 都不用改**。`lib.rs` 的
`bundled_backend()` 解析的是 `resource_dir()/backend/kvm-backend.exe`，而 Windows 上
`resource_dir()` 就是 exe 所在目录，所以免安装目录摆成和 NSIS 装出来的一样即可：

```
Karaoke Video Maker/
  Karaoke Video Maker.exe     ← target/release/kvm-shell.exe
  backend/                    ← dist-backend/kvm-backend/ 的**内容**，不是目录本身
    kvm-backend.exe
    _internal/...
  LICENSE / THIRD-PARTY-NOTICES.md / 使用说明.txt
```

`build_portable_zip()` **直接逐条写 zip，不先摊一份目录**：GPU 版 onedir 就 3 GB 上下，
runner 上 CUDA venv（约 3.5 GB）+ onedir + Rust target 已经十几 GB，多一份完整拷贝
很可能把盘撑爆——而磁盘满的报错通常出现在某个无关的步骤里。

**代价写在明处**：没有安装器就没人负责 WebView2 Runtime。Win11 与打过近年更新的
Win10 自带，老机器上要用户自己装一次。这条写进了包里的「使用说明.txt」，因为用户
解压之后手边只有那个文件夹，那时候他不会回去翻网页。

### 2. 闸门挪到花钱之前（`preflight_installer_limit()`）

按 onedir 体积估算安装包大小，在 `build_shell()` **之前**判定。比例 0.55 来自实测
（onedir 3.1 GB → 安装包 1.63 GB ≈ 0.53），往悲观一侧取。超限默认失败，留
`--force-installer` 让人覆盖——拦错了只浪费一次重跑，放过了浪费的是整条发布链路。

### 3. 两边互相点名

`package.py` 的 docstring 与 `ci.yml` 的 matrix 注释现在互相引用，并各写了一句
「别把这条改回去」。上次红就是因为口径只活在其中一半里。

## 验证

- zip 布局：断言 `backend/` 下是 onedir 的内容而非多套一层（`lib.rs` 里为同一个坑
  写过一次注释），断言 exe 权限位没丢。
- 闸门：把压缩比与上限调成假值，确认它在 **Rust 编译开始之前**失败，且 `--force-installer`
  能放行。**这一条是修复的核心**——不验的话，下次它可能又装在了下游。
- `ruff check` / `ruff format --check` / `tests/test_packaging_config.py` 全过。

## 参考

- [NSIS bug #1284 — 有符号整数导致 >2 GiB 时 mmap 假报错](https://sourceforge.net/p/nsis/bugs/1284/)
- [tauri-apps/tauri#7372 — NSIS 与 WiX 在应用超 2 GB 时都失败](https://github.com/tauri-apps/tauri/issues/7372)
- [nsisbi — 去掉 2 GB 限制的 NSIS 分支（本项目不采用，理由见上）](https://sourceforge.net/projects/nsisbi/)
- [ComfyUI-Windows-Portable — 带 CUDA 的 Windows 产物走归档而非安装器](https://github.com/YanWenKun/ComfyUI-Windows-Portable/releases)
