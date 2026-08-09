/**
 * 「样式」舞台的样式，由 StylePanel 一次性注入。
 *
 * 取值一律来自 styles.css 的设计 token（docs/ui-redesign.md §六点五：六套并行的
 * 内联样式必须收编成一套）。**唯一的例外是成片预览区**——那里的颜色表达的是
 * "成片长什么样"，与界面 token 是两套坐标系；例外集中在 `StyleFilmPreview.tsx`
 * 的 `BACKDROPS` 一个常量里，并在该处注明出处，本文件不出现任何颜色字面量。
 *
 * 旧实现（`kvm-style-*` / `kvm-palette-*`）自带一套与全局 token 无关的深色配色，
 * 且按 148px 固定标签列排版——那是为中等宽度侧栏设计的，放进宽舞台又空又乱。
 * 本文件按"左大预览 + 右控件"重写。
 */
export const STYLE_STAGE_CSS = `
/*
 * 舞台自身负责铺满：外壳给的是 .stage--scroll（整页滚 + 内边距），而本舞台要的是
 * 整页不滚、内部分区各自滚——预览必须始终占住画面中央，不能跟着控件一起滚出去。
 *
 * 代价是高度链必须一路可收缩：纵向 flex 子项的 min-height 默认是 auto（"不得小于
 * 内容高度"），任何一层漏掉 min-height: 0，右侧控件栏就会把自己撑到内容全高、
 * clientHeight === scrollHeight，于是永远不会变成滚动容器，溢出一路上交到最外层
 * 被裁掉（docs/ui-redesign.md §七点五）。下面每个 min-height: 0 都是为此而写。
 */
.stage--scroll:has(> .sty-stage) { padding: 0; overflow: hidden; }

.sty-stage { flex: 1 1 auto; min-height: 0; display: flex; }
.sty-stage * { box-sizing: border-box; }

/* ---- 左：成片预览 ---- */

.sty-film-col {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}

.sty-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: var(--hairline);
  background: var(--bg-panel);
  font-size: var(--fs-sm);
  color: var(--fg-2);
}
.sty-bar__spacer { flex: 1 1 auto; }
.sty-bar__label { color: var(--fg-3); }

.sty-chips { display: inline-flex; gap: var(--sp-1); }
.sty-chip {
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: var(--r-sm);
  border: var(--hairline-strong);
}
.sty-chip--on { outline: 2px solid var(--accent); outline-offset: 1px; }

/* 预览盒：flex 居中 + aspect-ratio，比例由工程的画面尺寸决定（内联 --sty-aspect）。
   max-height 经宽高比转移成宽度上限，画面因此在任意窗口尺寸下都是信箱式内缩，
   不会被拉伸——JASSUB 在画布模式下按同一个比例做内缩，两边必须一致。 */
.sty-film-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  overflow: hidden;
}
.sty-film {
  position: relative;
  width: 100%;
  max-height: 100%;
  aspect-ratio: var(--sty-aspect, 16 / 9);
  overflow: hidden;
  border-radius: var(--r-sm);
}
/* 画布的宿主：React 不往里放任何子节点，JASSUB 的 canvas 独占它（见 StyleFilmPreview） */
.sty-film__host { position: absolute; inset: 0; }
.sty-film__canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

.sty-film__note {
  position: absolute;
  z-index: 1;
  left: var(--sp-2);
  top: var(--sp-2);
  padding: 2px var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--bg-panel);
  border: var(--hairline);
  color: var(--fg-2);
  font-size: var(--fs-xs);
}

.sty-empty {
  margin: auto;
  color: var(--fg-3);
  font-size: var(--fs-sm);
  text-align: center;
  padding: var(--sp-5);
}

/* ---- transport：本舞台的形态是"播放这一句"，不是完整走带（§五） ---- */

.sty-transport {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-top: var(--hairline);
  background: var(--bg-panel);
}
.sty-transport__scrub { flex: 1 1 auto; min-width: 0; accent-color: var(--accent); }
.sty-transport__clock {
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-sm);
  color: var(--fg-2);
  min-width: 92px;
  text-align: right;
}

/* ---- 句子选择：横向条，只需就近换一句，不需要通读全曲 ---- */

.sty-lines {
  flex: 0 0 auto;
  display: flex;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border-top: var(--hairline);
  background: var(--bg-panel);
  overflow-x: auto;
  overflow-y: hidden;
}
.sty-line {
  flex: 0 0 auto;
  max-width: 220px;
  display: inline-flex;
  align-items: baseline;
  gap: var(--sp-2);
  height: 26px;
  padding: 0 var(--sp-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  color: var(--fg-2);
  font-size: var(--fs-sm);
  white-space: nowrap;
}
.sty-line:hover:not(:disabled) { background: var(--bg-surface); color: var(--fg); }
.sty-line--on {
  background: var(--accent-weak);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--fg);
}
.sty-line__no { flex: 0 0 auto; color: var(--fg-3); font-variant-numeric: tabular-nums; }
.sty-line__text { overflow: hidden; text-overflow: ellipsis; }

/* ---- 右：控件栏 ---- */

.sty-side {
  flex: 0 0 360px;
  min-height: 0;
  overflow-y: auto;
  border-left: var(--hairline);
  background: var(--bg-panel);
}

.sty-sec { padding: var(--sp-3); border-bottom: var(--hairline); }
.sty-sec__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
  font-size: var(--fs-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-2);
}
.sty-sec__spacer { flex: 1 1 auto; }

/* 一个参数一格：标签与数字同行，滑块独占一行——360px 的栏放不下"标签列 + 滑块 + 数字" */
.sty-f { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) 0; }
.sty-f + .sty-f { border-top: 1px solid var(--stroke); }
.sty-f__head { display: flex; align-items: center; gap: var(--sp-2); }
.sty-f__label { flex: 1 1 auto; font-size: var(--fs-sm); color: var(--fg); }
.sty-f__num { width: 68px; text-align: right; font-variant-numeric: tabular-nums; }
.sty-f__unit { flex: 0 0 auto; width: 20px; font-size: var(--fs-xs); color: var(--fg-3); }
.sty-f__range { width: 100%; accent-color: var(--accent); }
.sty-f__warn {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--warn);
}
.sty-f__hint { font-size: var(--fs-xs); color: var(--fg-3); }

.sty-check { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) 0; cursor: pointer; }
.sty-check input { accent-color: var(--accent); }
.sty-check span { font-size: var(--fs-sm); }

.sty-note { font-size: var(--fs-xs); color: var(--fg-3); margin-top: var(--sp-2); }
.sty-note--pad { padding: var(--sp-2); margin: 0; }
.sty-err {
  padding: var(--sp-2);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
  font-size: var(--fs-sm);
}

/* ---- 字体 ---- */

.sty-fontgrid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); }
.sty-fontpreset {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--sp-2);
  text-align: left;
  background: var(--bg-surface);
  border: var(--hairline);
  border-radius: var(--r-md);
}
.sty-fontpreset--on { border-color: var(--accent); background: var(--accent-weak); }
.sty-fontpreset__label { font-size: var(--fs-sm); font-weight: 600; color: var(--fg); }
.sty-fontpreset__sub { font-size: var(--fs-xs); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; max-width: 100%; white-space: nowrap; }

.sty-fontlist {
  margin-top: var(--sp-2);
  max-height: 200px;
  overflow-y: auto;
  border: var(--hairline);
  border-radius: var(--r-md);
  background: var(--bg-surface);
}
.sty-fontitem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  background: transparent;
  border: none;
  border-radius: 0;
  border-bottom: 1px solid var(--stroke);
  color: var(--fg-2);
  font-size: var(--fs-sm);
  text-align: left;
}
.sty-fontitem:last-child { border-bottom: none; }
.sty-fontitem:hover:not(:disabled) { background: var(--bg-raise); color: var(--fg); }
.sty-fontitem--on { background: var(--accent-weak); color: var(--fg); font-weight: 600; }
.sty-fontitem__warn { flex: 0 0 auto; font-size: var(--fs-xs); color: var(--warn); }

.sty-fontbar { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); font-size: var(--fs-xs); color: var(--fg-3); }
.sty-fontbar__spacer { flex: 1 1 auto; }

/* ---- 声部配色 ---- */

.sty-parts { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-bottom: var(--sp-3); }
.sty-part {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: 26px;
  padding: 0 var(--sp-2);
  background: transparent;
  border: var(--hairline);
  border-radius: var(--r-pill);
  color: var(--fg-2);
  font-size: var(--fs-sm);
}
.sty-part--on { background: var(--accent-weak); border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--fg); }

.sty-color { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0; }
.sty-color__pick {
  width: 34px;
  height: 26px;
  padding: 0;
  border: var(--hairline-strong);
  border-radius: var(--r-sm);
  background: transparent;
  cursor: pointer;
}
.sty-color__label { font-size: var(--fs-sm); color: var(--fg-2); }
.sty-color__hex {
  width: 116px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  text-align: center;
}
.sty-color__hex--bad { border-color: var(--danger); }

.sty-tpls { display: flex; flex-direction: column; gap: var(--sp-1); }
.sty-tpl {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  background: var(--bg-surface);
  border: var(--hairline);
  border-radius: var(--r-md);
  color: var(--fg-2);
  font-size: var(--fs-sm);
  text-align: left;
}
.sty-tpl:hover:not(:disabled) { border-color: var(--accent); color: var(--fg); }
.sty-tpl__swatch { display: inline-flex; gap: 2px; flex: 0 0 auto; }
.sty-tpl__dot { width: 12px; height: 12px; border-radius: 3px; border: var(--hairline-strong); }
.sty-tpl__name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
