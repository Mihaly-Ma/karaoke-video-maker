/**
 * 卸载时把媒体元素占的东西交回浏览器。
 *
 * ## 为什么必须显式做这件事
 *
 * React 卸载 `<video>` / `<audio>` 只是把节点从 DOM 里摘掉，**浏览器不一定
 * 因此释放解码器与已经缓冲的数据**。规范里让媒体元素放手的动作是"把 src 清掉
 * 再 `load()` 一次"——只有这一步会让它进入 empty 状态、丢掉缓冲。
 *
 * 这在 Chromium 上通常不明显（它自己会较快回收），但 WebKit 上会一路堆起来：
 * 编辑页与素材页各有若干媒体元素，来回切几次工程，光媒体缓冲就是几百 MB，
 * 而用户看到的是「Out of memory」——音轨解码这类后来的分配先失败。
 *
 * 用法：把媒体元素的 ref 传进来，本 hook 只在**卸载时**动手，中途换 src 不受影响。
 */

import { useEffect, type RefObject } from 'react'

export function useReleaseMediaOnUnmount(ref: RefObject<HTMLMediaElement | null>): void {
  useEffect(() => {
    // 在挂载时抓住元素：卸载阶段 React 可能已经把 ref.current 置空了
    const el = ref.current
    return () => {
      if (!el) return
      try {
        el.pause()
        el.removeAttribute('src')
        // 只清 src 是不够的：要再走一次资源选择算法，元素才会真的松手
        el.load()
      } catch {
        /* 卸载竞态：元素可能已经不在文档里了，忽略 */
      }
    }
  }, [ref])
}
