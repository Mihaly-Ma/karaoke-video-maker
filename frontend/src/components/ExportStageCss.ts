/**
 * 「导出」舞台的样式，由 ExportPanel 一次性注入。
 *
 * 取值一律来自 styles.css 的设计 token（docs/ui-redesign.md §六点五）。
 *
 * **唯一的例外是 `.exp-viewport` 里那块预览**——它的颜色表达的是"成片长什么样"，
 * 与外壳 token 是两套坐标系。不过那些颜色全部由 `Preview` 组件自己内联（黑底 +
 * libass 画出来的真实字幕），本文件一个颜色字面量都不需要写，例外仅体现为
 * "这块区域不套面板底色"。
 */
export const EXPORT_STAGE_CSS = `
/*
 * 舞台自身负责铺满与滚动分区（docs/ui-redesign.md §七点五）。
 *
 * 外壳给的是 .stage--scroll（整页滚 + 内边距），但本舞台要的是"整页不滚、
 * 左栏自己滚"：预览与它下面那条关键位置必须始终可见——用户来这一步就是为了
 * 抽查几个位置再决定要不要烧几分钟，把走带和跳转条滚出屏幕等于把这一步废掉。
 */
.stage--scroll:has(> .exp-stage) { padding: 0; overflow: hidden; }

/*
 * 下面每个纵向容器的 min-height: 0 都是必要条件而非保险：纵向 flex 子项的
 * min-height 默认是 auto（不得小于内容最小高度），漏一处整条高度链就断，
 * 症状是"滚不动、后半截看不见"，而 overflow 设置本身是对的。
 */
.exp-stage { flex: 1 1 auto; min-height: 0; display: flex; }

/* ---- 左栏：设置 + 产物。两者都是清单式内容，共用一条滚动 ---- */

.exp-side {
  flex: 0 0 360px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  overflow-y: auto;
  background: var(--bg-panel);
  border-right: var(--hairline);
}

.exp-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  background: var(--bg-surface);
  border: var(--hairline);
  border-radius: var(--r-lg);
}
.exp-card__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--fg);
}
.exp-field { display: flex; flex-direction: column; gap: var(--sp-2); }
.exp-field__label { font-size: var(--fs-sm); color: var(--fg-2); }

/* 音轨二选一：产物名就叫 ON VOCAL / OFF VOCAL，控件用同一套词，免得对不上 */
.exp-seg { display: flex; gap: var(--sp-1); }
.exp-seg__item {
  flex: 1 1 0;
  display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 var(--sp-2);
  border: var(--hairline); border-radius: var(--r-md);
  background: transparent;
  color: var(--fg-2); font-size: var(--fs-sm);
  cursor: pointer; white-space: nowrap;
}
.exp-seg__item:hover:not(:disabled) { background: var(--bg-raise); color: var(--fg); }
.exp-seg__item--active {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--fg);
  font-weight: 600;
}
.exp-seg__item:disabled { cursor: not-allowed; opacity: 0.45; }

/*
 * 长任务前的警告（当前只有字形缺字）。用底色块而不是一行小字：
 * 它就在导出按钮上方，一次烧录几分钟，必须在按下之前被看到。
 * 但只是警告——按钮不禁用（CLAUDE.md §2.5 降级不终止）。
 */
.exp-warn {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.exp-warn span { word-break: break-all; }

/* ---- 产物 ---- */

.exp-arts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.exp-art {
  display: flex; flex-direction: column; gap: var(--sp-1);
  padding: var(--sp-2);
  border: var(--hairline); border-radius: var(--r-md);
  background: var(--bg-panel);
}
.exp-art__head { display: flex; align-items: center; gap: var(--sp-2); }
/* 变体名（ON VOCAL + 引导声）不许折行：折成两行的胶囊读起来像两个标签 */
.exp-art__head > .badge { flex: 0 0 auto; white-space: nowrap; }
.exp-art__spacer { flex: 1 1 auto; min-width: 0; }
/* 下载是 <a> 而不是 <button>（要让浏览器自己流式落盘），所以按钮外观得自己给 */
.exp-art__dl {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; gap: var(--sp-1);
  height: 26px; padding: 0 var(--sp-2);
  border: var(--hairline); border-radius: var(--r-md);
  background: var(--bg-raise);
  color: var(--fg-2); font-size: var(--fs-sm); text-decoration: none;
  cursor: pointer; white-space: nowrap;
}
.exp-art__dl:hover { border-color: var(--accent); background: var(--accent-weak); color: var(--fg); }
.exp-art__meta { font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }

/* ---- 右侧：预览 ---- */

.exp-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

.exp-head {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  border-bottom: var(--hairline);
  background: var(--bg-panel);
}
.exp-head__title { font-size: var(--fs-md); font-weight: 600; color: var(--fg); }
.exp-head__spacer { flex: 1 1 auto; }
/* 与 styles.css 的 .badge--ok 同构，只是换成警示色：说明预览覆盖不到的部分 */
.exp-tag--warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--stroke)); }

/*
 * 预览取高而不是取宽：宽度驱动（16/9 自然高度）在矮窗口下会把走带顶到折叠线以下，
 * 而走带正是这一步要用的东西。这里让画面吃掉剩余高度，<video> 的 objectFit: contain
 * 自己做信箱边。上限 1280px 是为了超宽屏上不至于把画面拉到看不完整。
 */
.exp-viewport {
  flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column; align-items: center;
  padding: var(--sp-3) var(--sp-4);
  overflow: hidden;
}
.exp-preview { flex: 1 1 auto; min-height: 0; width: 100%; max-width: 1280px; }
/*
 * Preview 的第一个子元素是画面区（内联写死 aspect-ratio: 16/9、没有 flex 设定）。
 * 不给它 min-height: 0 就无法收缩，矮窗口下会把下面的走带挤出 overflow: hidden。
 * 这是对 Preview 内部结构的一处刻意耦合——该组件不归本舞台所有、也不可改，
 * 只能从外部约束它的盒子；若将来它的 DOM 变了，症状是预览撑高、走带被裁。
 */
.exp-preview > div:first-child { flex: 1 1 auto; min-height: 0; }

/* ---- 关键位置：横向跳转条 ---- */

.exp-cues {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  border-top: var(--hairline);
  background: var(--bg-panel);
}
.exp-cues__label {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; gap: var(--sp-1);
  font-size: var(--fs-sm); color: var(--fg-2);
}
.exp-cues__list {
  flex: 1 1 auto; min-width: 0;
  display: flex; gap: var(--sp-2);
  overflow-x: auto;
  padding-bottom: var(--sp-1);
}
.exp-cue {
  flex: 0 0 auto;
  display: flex; flex-direction: column; gap: 2px;
  max-width: 168px;
  padding: var(--sp-1) var(--sp-2);
  border: var(--hairline); border-radius: var(--r-md);
  background: var(--bg-surface);
  color: var(--fg-2);
  cursor: pointer; text-align: left;
}
.exp-cue:hover { border-color: var(--accent); background: var(--accent-weak); color: var(--fg); }
.exp-cue__top { display: flex; align-items: baseline; gap: var(--sp-2); }
.exp-cue__kind { font-size: var(--fs-sm); color: inherit; white-space: nowrap; }
.exp-cue__time { font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
.exp-cue__snippet {
  font-size: var(--fs-xs); color: var(--fg-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
`
