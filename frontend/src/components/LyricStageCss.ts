/**
 * 「歌词」舞台的样式，由 LyricPanel 一次性注入。
 *
 * 取值一律来自 styles.css 的设计 token（docs/ui-redesign.md §六点五：六套并行的
 * 内联样式必须收编成一套）。**唯一的例外是成片渲染区**——那里的颜色表达的是
 * "成片长什么样"，与外壳 token 是两套坐标系，套用界面配色反而会让用户分不清
 * 哪个颜色是成片的、哪个是界面的。例外集中在 `.lyr-film` 一个作用域里，并在
 * 该处逐条注明出处。
 *
 * 旧实现（`kvm-lyric-*`）带一个 `@media (prefers-color-scheme)` 分支，在浅色
 * macOS 上把面板渲染成白卡片，与无条件深色的新外壳打架。本文件不再有任何
 * 媒体查询：外壳只有一套深色，配色分叉本身就是缺陷。
 */
export const LYRIC_STAGE_CSS = `
/*
 * 舞台自身负责铺满：外壳（App.tsx）已不再套限宽容器，本舞台要的是左窄右宽、
 * 占满高度的工作区——候选靠窄列扫视、歌词靠大区域判断版本。
 *
 * overflow: hidden 是本舞台的设计意图：整页不滚，内部分区各自滚
 * （左候选列表一条、右歌词正文一条）。整页一起滚会让底部的元信息栏与
 * 「使用」按钮跟着歌词滚出屏幕，而那正是看完歌词后要点的东西。
 * 代价是高度链必须一路可收缩——任何一层漏掉 min-height: 0，多出来的高度
 * 都会在这里被裁掉且无法滚到。下面每个纵向容器的 min-height: 0 都是为此而写。
 */
.stage--scroll:has(> .lyr-stage) { padding: 0; overflow: hidden; }

.lyr-stage { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.lyr-body { flex: 1 1 auto; min-height: 0; display: flex; }

/* ---- 左窄列：搜索与导入是并列的一等入口 ---- */

.lyr-side {
  flex: 0 0 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: var(--hairline);
}

.lyr-tabs { display: flex; gap: var(--sp-1); padding: var(--sp-2); border-bottom: var(--hairline); }
.lyr-tab {
  flex: 1 1 0;
  display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
  height: 30px;
  background: transparent; border: 1px solid transparent; border-radius: var(--r-md);
  color: var(--fg-2);
}
.lyr-tab:hover:not(:disabled) { background: var(--bg-surface); color: var(--fg); }
.lyr-tab--active {
  background: var(--accent-weak);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--fg);
  font-weight: 600;
}

.lyr-form { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border-bottom: var(--hairline); }
.lyr-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.lyr-row--grow > input { flex: 1 1 auto; }
.lyr-side__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }

/* 单选组：格式、替换/追加共用 */
.lyr-seg { display: flex; gap: var(--sp-1); }
.lyr-seg__item {
  flex: 1 1 0;
  display: inline-flex; align-items: center; justify-content: center;
  height: 26px; padding: 0 var(--sp-2);
  border: var(--hairline); border-radius: var(--r-md);
  color: var(--fg-2); font-size: var(--fs-sm);
  cursor: pointer; white-space: nowrap;
}
.lyr-seg__item--active { border-color: var(--accent); background: var(--accent-weak); color: var(--fg); }
.lyr-seg__item input { position: absolute; opacity: 0; pointer-events: none; }

.lyr-drop {
  display: flex; flex-direction: column; gap: var(--sp-2);
  border: 1px dashed var(--stroke-strong); border-radius: var(--r-md); padding: var(--sp-2);
}
.lyr-drop--active { border-color: var(--accent); background: var(--accent-weak); }
.lyr-drop textarea { width: 100%; min-height: 168px; resize: vertical; font-family: var(--font-mono); font-size: var(--fs-sm); }

/* ---- 候选列表 ---- */

.lyr-cands { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: var(--sp-2); display: flex; flex-direction: column; gap: 2px; }
.lyr-cand {
  display: flex; flex-direction: column; gap: var(--sp-1);
  text-align: left; padding: var(--sp-2);
  background: transparent; border: 1px solid transparent; border-radius: var(--r-md);
  color: var(--fg);
}
.lyr-cand:hover:not(:disabled) { background: var(--bg-surface); }
.lyr-cand--active {
  background: var(--accent-weak);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.lyr-cand__top { display: flex; align-items: baseline; gap: var(--sp-2); }
.lyr-cand__title { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lyr-cand__dur { flex: 0 0 auto; color: var(--fg-2); font-size: var(--fs-sm); }
.lyr-cand__sub { color: var(--fg-2); font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lyr-cand__tags { display: flex; flex-wrap: wrap; gap: var(--sp-1); }

/* 徽章沿用全局 .badge 的几何，只换语义色（CLAUDE.md §7.4：来源必须可见地区分） */
.lyr-tag--provider { color: var(--src-provider); border-color: color-mix(in srgb, var(--src-provider) 40%, var(--stroke)); }
.lyr-tag--aligned { color: var(--src-aligned); border-color: color-mix(in srgb, var(--src-aligned) 40%, var(--stroke)); }
.lyr-tag--interp { color: var(--src-interp); border-color: color-mix(in srgb, var(--src-interp) 40%, var(--stroke)); }
.lyr-tag--manual { color: var(--src-manual); border-color: color-mix(in srgb, var(--src-manual) 40%, var(--stroke)); }
.lyr-tag--none { color: var(--fg-3); }
.lyr-tag--warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--stroke)); }

.lyr-note { padding: var(--sp-2) var(--sp-3); color: var(--fg-2); font-size: var(--fs-sm); }
.lyr-fold { border-bottom: var(--hairline); }
.lyr-fold__head {
  width: 100%; display: flex; align-items: center; gap: var(--sp-2);
  background: transparent; border: none; border-radius: 0;
  padding: var(--sp-2) var(--sp-3); color: var(--warn); font-size: var(--fs-sm); text-align: left;
}
.lyr-fold__head:hover:not(:disabled) { background: var(--bg-surface); }
.lyr-fold__body { margin: 0; padding: 0 var(--sp-3) var(--sp-2) var(--sp-5); color: var(--fg-2); font-size: var(--fs-xs); }

/* ---- 右侧主区 ---- */

/*
 * min-height: 0 不是保险起见，是这一层必须有的。
 *
 * 全文编辑态里 .lyr-main 是 .lyr-stage（纵向）的直接子项，落在主轴上；
 * flex 子项的 min-height 默认 auto，即"不得小于内容的最小高度"。歌词有
 * 60 行时这个最小高度是三千多像素，.lyr-main 于是撑到 3449px，.lyr-film
 * 跟着一起被撑开（clientHeight === scrollHeight），永远不会变成滚动容器，
 * 溢出一路上交到 .stage 被 overflow: hidden 裁掉——表现就是"歌词滚不动、
 * 后半首看不见"。选源态没暴露这个问题，只是因为那里 .lyr-main 落在
 * .lyr-body（横向）的交叉轴上，高度由 stretch 给定，与内容无关。
 */
.lyr-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

.lyr-bar {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  background: var(--bg-panel); border-bottom: var(--hairline);
  font-size: var(--fs-sm); color: var(--fg-2);
}
.lyr-bar__spacer { flex: 1 1 auto; }

.lyr-meta {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap;
  padding: var(--sp-2) var(--sp-4);
  background: var(--bg-panel); border-top: var(--hairline);
  font-size: var(--fs-sm); color: var(--fg-2);
}
.lyr-meta__spacer { flex: 1 1 auto; }

.lyr-blank { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--fg-3); }

/* ---- 成片渲染区 ----
 * 这一段的颜色**不是**界面 token，而是成片本身的取值（docs/ui-redesign.md §六：
 * "预览区域不套用界面配色"）。字号/描边比例由工程样式换算，见 LyricScript.tsx。
 */
.lyr-film {
  --lyr-film-bg: #005500;          /* 纯色背景兜底，CLAUDE.md §8.5 */
  --lyr-fill: #ffffff;             /* 未唱填充：nicokara 惯例白字 */
  --lyr-outline: #000000;          /* 未唱描边：黑边 */
  --lyr-gutter: rgb(255 255 255 / 0.42);   /* 压在成片底上的行号与操作 */
  --lyr-gutter-hi: rgb(255 255 255 / 0.14);
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  background: var(--lyr-film-bg);
  padding: var(--sp-5) var(--sp-6);
}

.lyr-script { display: flex; flex-direction: column; }

.lyr-line { display: flex; align-items: flex-start; gap: var(--sp-3); border-radius: var(--r-md); padding: 0 var(--sp-2); width: fit-content; max-width: 100%; }
.lyr-line--edit:hover { background: var(--lyr-gutter-hi); }
.lyr-line--meta { opacity: 0.55; }

.lyr-line__no {
  flex: 0 0 34px;
  padding-top: 0.6em;
  text-align: right;
  color: var(--lyr-gutter);
  font-family: var(--font-ui);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

/* 行首一条来源色的细杠：哪几行的轴是机器猜的，扫一眼就知道（CLAUDE.md §7.4） */
.lyr-line__src { flex: 0 0 3px; align-self: stretch; margin: 0.5em 0; border-radius: var(--r-pill); background: transparent; }
.lyr-line__src--provider { background: var(--src-provider); }
.lyr-line__src--aligned { background: var(--src-aligned); }
.lyr-line__src--interpolated { background: var(--src-interp); }
.lyr-line__src--manual { background: var(--src-manual); }

/* 行内元素紧跟文本而不是撑满整行：制作名单徽章要贴着它标注的那一行，
   拆行/并行按钮要落在手边——推到屏幕最右等于让用户横跨一屏去点 */
.lyr-line__body { flex: 0 1 auto; min-width: 0; }

.lyr-text {
  font-family: var(--lyr-font);
  font-size: var(--lyr-fs);
  font-weight: 700;
  line-height: 2;
  color: var(--lyr-fill);
  /* 描边画在填充下面，否则细笔画会被自己的描边吃掉一半（ASS \\bord 是纯外扩） */
  -webkit-text-stroke: var(--lyr-stroke) var(--lyr-outline);
  paint-order: stroke fill;
  word-break: break-word;
}
.lyr-text ruby { ruby-position: over; -webkit-ruby-position: before; }
.lyr-text rt {
  font-size: var(--lyr-ruby-fs);
  font-weight: 700;
  -webkit-text-stroke: var(--lyr-ruby-stroke) var(--lyr-outline);
  paint-order: stroke fill;
}

.lyr-line__ops { flex: 0 0 auto; display: flex; gap: var(--sp-1); padding-top: 0.5em; opacity: 0; }
.lyr-line:hover .lyr-line__ops,
.lyr-line__ops:focus-within,
.lyr-line--splitting .lyr-line__ops { opacity: 1; }
.lyr-line__ops button {
  width: 26px; height: 26px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--bg-surface); border: var(--hairline); color: var(--fg-2);
}
.lyr-line__ops button:hover:not(:disabled) { background: var(--bg-raise); color: var(--fg); }

.lyr-line__badge {
  align-self: center;
  flex: 0 0 auto;
  background: var(--bg-surface);
  border: var(--hairline);
  color: var(--fg-2);
}

/* 拆分态：注音结构横跨 token 边界，插不进可点的分隔符，所以整行改为逐 token 平铺 */
.lyr-split { display: flex; flex-wrap: wrap; align-items: center; font-size: var(--lyr-fs); color: var(--lyr-fill); font-family: var(--lyr-font); line-height: 1.4; }
.lyr-split__tok { padding: 0 1px; }
.lyr-split__pt {
  width: 12px; height: 1.4em; margin: 0 1px; padding: 0; vertical-align: middle;
  background: var(--lyr-gutter-hi); border: 1px solid transparent; border-radius: var(--r-sm);
  color: var(--lyr-gutter);
  display: inline-flex; align-items: center; justify-content: center;
}
/* 竖杠是分隔符本身而不是图标，用 CSS 画——图标一律走 @ant-design/icons */
.lyr-split__pt::before { content: ''; width: 2px; height: 60%; border-radius: var(--r-pill); background: currentColor; }
.lyr-split__pt:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.lyr-split__pt--risky { color: var(--warn); border-color: var(--warn); }
`
