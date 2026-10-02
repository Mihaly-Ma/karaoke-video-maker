Karaoke Video Maker · macOS 安装说明

安装
1. 将「Karaoke Video Maker.app」拖到「Applications」文件夹。
2. 从「应用程序」中启动 Karaoke Video Maker，安装后可以推出此磁盘镜像。

首次启动被 macOS 拦截时
当前发布的应用未签名。如果提示无法验证开发者或应用已损坏，请先确认
应用来自本项目的发布包，再打开「终端」，复制并执行：

  xattr -cr "/Applications/Karaoke Video Maker.app"

然后重新打开应用。命令中的 -c 清除扩展属性（包括下载隔离标记），
-r 递归处理 .app 内部文件。如果装在其他位置，请将引号内路径替换为
实际安装路径。命令应针对安装后的应用执行，无需对整个磁盘执行。
