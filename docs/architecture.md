# Architecture notes

The pipeline diagram lives in the [README](../README.md#how-it-works). This page explains the
decisions that diagram cannot show, for someone about to read the code.

`CLAUDE.md` at the repo root is the full engineering contract — data model, every technology
choice and why, every experiment already run and its result. It is written in Chinese and it is
long on purpose. This page is the short English version of the parts you need first.

Maintained in English only; the Chinese and Japanese READMEs link here.

---

## The project file is the only source of truth

ASS is a render *target*. It is generated fresh from the project's data model on every preview
and every export, and it is never parsed back into the project.

That is not a stylistic preference. Every automatic stage in the pipeline is designed to
overwrite only the fields a human has not locked. If ASS were round-tripped, locks would have to
survive a lossy text format that has no concept of them, and the guarantee would quietly stop
being true.

## Every automatic value carries `(value, source, locked)`

Readings, furigana, timing boundaries, line breaks, paragraph membership, voice part — anything a
machine produced records what produced it and whether a human has since frozen it. Re-running an
automatic step only touches fields where `locked = false`.

This is what makes "the aligner reran and my hand-timed chorus is untouched" a fact rather than a
promise: it is enforced in `backend/kvm/editing/ops.py`. It is also why `source` is visible in
the UI as colour — the user needs to see at a glance which numbers were guessed and deserve a
second look.

Identity matters as much as the flag. Locks are keyed by content, not by "line 7, token 3", which
drifts the moment lines are re-split. When a lock cannot be re-attached after an edit, it goes on
a visible list of orphaned corrections instead of being dropped silently — mis-binding a lock is
worse than losing it, because a mis-bind on a repeated chorus is invisible.

## Manual input is a first-class path, not a fallback

There is no step whose intended experience is "now go finish this in Aegisub." Every automatic
stage — download, lyric fetch, timing, reading, line breaking, paragraph detection — has a manual
equivalent in the same UI, and an automatic failure degrades instead of blocking.

The sharpest consequence: tap-to-time hand timing is a supported way to time a whole song from
zero, not an emergency hatch. Automatic alignment is expected to place roughly 90% of the content
approximately right; the quality of the remaining 10% of hand work is what decides whether the
tool is pleasant to use.

## Milliseconds internally, centiseconds only at serialization

Timing is integer milliseconds everywhere in the model. Centiseconds exist only inside the ASS
writer, and are derived by rounding cumulative timestamps and taking differences — not by
rounding each duration on its own, which accumulates up to 9 ms of drift per syllable and is
audible by the end of a long line.

Timing also stores `(start, duration)` rather than `(start, end)`, and gaps between adjacent
syllables are preserved rather than closed. Real singing breathes; if the gap is absorbed into
the previous character, the colour sweep keeps crawling while nobody is singing, which is one of
the most visible failure modes in karaoke subtitles.

## One libass, both ends

Preview (JASSUB, a WASM build of libass) and export (ffmpeg's `ass` filter) are meant to render
from the same libass build, so what you tune while editing is what gets burned in. ASS is an
implementation-defined format; two libass versions can legitimately disagree, which turns
"what you see is what you get" into a version-pinning problem. `CLAUDE.md` §5.12 tracks the
specifics.

Two related rules follow. Font glyph coverage is checked before rendering, because a missing
glyph makes preview and export fall back to *different* fonts and destroys the match silently.
And layout — where each syllable and each furigana group sits — is computed once, in the backend,
from real measured text advances rather than an estimated character-width ratio.

## The colour sweep

The signature nicokara look is that the outline flips colour along with the fill. Plain `\k`
karaoke tags cannot do it: they interpolate the primary colour only, and leave the border alone.

The solution here is two Dialogue events per line — an unsung layer underneath, a sung-colour
layer on top, revealed by an animated rectangular `\clip`. Both layers carry the same fade, so
neither can bleed through the other during a transition. It costs two events per line instead of
one per syllable, and it is why voice parts need four colours each: unsung fill, unsung outline,
sung fill, sung outline.
