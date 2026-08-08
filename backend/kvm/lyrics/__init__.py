"""歌词获取层：provider 抽象、QQ 音乐实现、手工导入解析。

CLAUDE.md §5.2 已定：provider 只负责"取回并归一化"，不负责选择/排序；
排序（resolver）与最终裁决留给路由层与用户。
"""
