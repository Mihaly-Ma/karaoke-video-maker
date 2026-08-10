# Project status

The long version of the README's short "not built yet" list. Written by reading the code, not
the design doc — where this page, the README and `CLAUDE.md` disagree, the code wins. Grep
before you rely on anything here.

Maintained in English only, on purpose. The Chinese and Japanese READMEs link here instead of
carrying three copies of a list that moves with every merge; each README still states in its own
language which major features do not exist yet.

---

## Working today

### Backend

- FastAPI app (`backend/kvm/api/`) with routers for projects (undo/redo, autosave on every
  mutation), lyric search / preview / apply / import, media download / separation / proxy
  generation, editing operations (shift, set timing, lock, ruby, split, merge, voice part), ASS
  generation with async export jobs, and system-font scanning, coverage checking and subsetting.
- Local vocal separation through `audio-separator`, three quality tiers. It runs in an isolated
  subprocess, reports progress as JSON lines, and caches by content hash. It never runs inside
  the API process and never blocks it.
- Editing proxy video: a short-GOP, audio-less H.264/MP4 built from sources browsers refuse to
  play (4K AV1 in Matroska). Editing only — export always goes back to the original file.
- Waveform peaks precomputed server-side (multi-level LOD, BBC `audiowaveform` binary format)
  plus an ffprobe-backed media probe endpoint, so the browser never decodes a whole track.
- YouTube download via `yt-dlp` (Bilibili is experimental), with audio-quality-first stream
  selection and container start-offset detection.
- QQ Music QRC search and fetch, including the non-standard (buggy S-box) DES decryption. It was
  reimplemented in Python from publicly documented constants; no third-party decryption code is
  imported.
- ASS generation: the double-layer progressive `\clip` sweep, so fill *and* outline flip colour
  together; per-line fade in and out; per-voice-part colour segmentation inside a single line; a
  centred credits card; and "get ready" dots placed on detected beats.
- Guide melody synthesis — CREPE pitch extraction, median filter, note segmentation, semitone
  quantization, band-limited harmonic synthesis, mixed into the instrumental. Beat detection runs
  off the separated drum stem. It is a Material-stage artifact, not an export-time switch: it runs
  as a cancellable subprocess job cached on `(vocals hash, params, version)`, five parameters are
  exposed (volume, timbre, brightness, sensitivity, legato), the result is playable at
  `/api/media/file/{id}/guide`, and export reuses that same file when the fingerprint still
  matches. CREPE weights ship inside the wheel — nothing is downloaded at runtime.
- ffmpeg detection by capability (is the `ass` filter registered), not by version number, across
  the known install locations, plus a `KVM_FFMPEG` override that fails loudly rather than
  silently substituting a different build.
- An environment self-check, `python -m kvm.doctor`: platform matrix, Python version, uv, Node
  and npm, whether `node_modules` matches the lockfile, ffmpeg/ffprobe/libass, each of the six
  optional dependency groups, the torch device (`cuda.is_available()` printed explicitly),
  downloaded model weights, system fonts, a writable data directory, free disk, and port
  availability on both loopback families. Copy-pasteable report, JSON mode, downloads nothing.
- One-key scripts on top of it: `scripts/setup.py` (check and install) and `scripts/dev.py`
  (check, then run both servers, with clean group shutdown on Ctrl-C).
- `uv run pytest -q` was last measured at 506 passing, 1 skipped.

### Editor

- Five steps — Material, Lyrics, Edit, Style, Export — plus a project library home screen. Each
  step's stage takes over the full main area instead of a fixed player-plus-timeline shell, and
  playback belongs to the Edit stage alone, so a stray second play button cannot exist.
- Timing and furigana were originally two steps and are now one. They fix the same selected word
  from two angles (when it is sung, how it is read), and a separate furigana step had no way to
  play audio — which is the only way to check a reading.
- Tap-to-time against the waveform, boundary dragging with optional ripple into the neighbouring
  token, global-offset nudge, line and token split/merge, and a visible timing-source legend:
  untimed, from the lyric source, auto-aligned, interpolated, manual and locked.
- Per-span furigana editing with source badges, and in-place rewriting of a line's lyric text.
  The rewrite carries existing timing, readings and voice parts across and reports what it could
  not re-attach, rather than discarding it quietly.
- Real libass preview (JASSUB) fed the *same* ASS the exporter burns, on the Edit, Style and
  Export stages. System fonts are subsetted server-side so the preview can use the family the
  export will use.
- Fonts are an ordered **chain**, not one family: whatever the primary font lacks, the next one
  supplies. Both ends are fed the same subset bytes — the preview gets them via `GET
  /api/fonts/subset`, the exporter embeds them in the ASS `[Fonts]` section — and every font in
  the chain is rewritten to share the primary's family name, which is what actually makes libass
  honour the chain (`experiments/ass_embedded_fonts.py`).
- Font glyph coverage is checked before you render: the Style step reports whether the whole
  chain covers every character in the song (lyrics, furigana, credits card) and which font ends
  up drawing each one, and the Export step repeats the check right above the button. Missing
  glyphs warn, they do not block.
- The system font list is searchable by any of a font's names, so `Hiragino Sans` is reachable
  by typing `ヒラギノ`, `ひらぎの` or `hiragino`.

| | |
|---|---|
| ![Project library with completion status per project](images/editor-home.png) | ![Furigana inspector with per-span source badges](images/editor-ruby.png) |
| Project library — pick up an existing song or start a new one | The Edit stage, seen from the reading side |

![Export step — output options, cue rail for spot-checking, finished files as downloads](images/step-export.png)

The Export step. The cue rail along the bottom jumps the preview to the places most likely to be
wrong — first line, verse heads, credits card, widest line, densest furigana, ending — so a
mistake is caught before a multi-minute burn, not after.

---

## Not built yet

Reserved enum values and design docs are not implementations. None of the following exist in the
running pipeline.

- **Forced alignment / CTC timing.** `TimingSource.ALIGNED` is reserved in the data model, but
  nothing produces it. Today's timing is QRC-provided or hand-made, and nothing else.
- **Automatic reading generation.** No morphological analysis, dictionary lookup or acoustic
  disambiguation. `ReadingSource.MORPH`, `DICT` and `ACOUSTIC` are reserved values with no
  producer. Furigana comes from the QRC kana track or from you.
- **Timeline re-anchoring.** Lyric sources are timed against the commercial master, not the MV's
  audio, and nothing corrects for it automatically. There is one global offset knob you set by
  ear (`global_offset_ms`). The cross-correlation experiment
  (`experiments/reanchor_xcorr.py`) is a standalone script, not wired into the pipeline.
- **Lyric providers other than QQ Music.** Kugou, NetEase, LRCLIB, UtaTen and YouTube's own
  captions are all researched — see `CLAUDE.md` §5.2 and the `experiments/` scripts — but only QQ
  Music is wired into the production `kvm.lyrics` package.
- **Voice-part diarization.** Voice parts are assigned by hand in the editor. There is no
  automatic lead/backing detection and no second separation pass splitting a lead vocal from its
  harmonies, so there is no コーラス入り variant yet.
- **Dependency auto-*acquisition*.** The self-check (`python -m kvm.doctor`) and the install side
  (`scripts/setup.py`, which handles Python 3.12, the venv, every extra, and `npm install`) are
  both in place, but the middle stage of `CLAUDE.md` §2.6 is not: nothing downloads an external
  binary. ffmpeg, Node and uv are *located* and, if missing, reported with a copy-pasteable
  install command — never fetched into an app-private directory. Separation and `yt-dlp` are the
  exceptions, and only because they are Python packages: both install and update themselves into
  an app-private environment on demand.
- **Bundled fonts.** The Style step picks from fonts already installed on your machine; the
  project ships and fetches none. The subset served to the preview is now cut per song, so
  characters outside the default set — `鷗`, `𠮷`, `①` — render in the preview too; they used to
  be blank there while the burned-in video rendered them correctly.
- **A persisted phonetic reading layer.** The project model and API do carry a separate "how it
  is actually sung" reading alongside the displayed furigana (particle は → ワ, and so on), with
  a rule-based derivation endpoint. The editor still keeps the phonetic field in browser local
  storage and never sends it, so it does not survive moving to another machine. It only starts to
  matter once forced alignment lands, which it has not.
- **Japanese and English UI.** Every string already routes through `t()` in `frontend/src/i18n/`,
  but only the Chinese table is written and there is no in-app language switcher.
- **Windows.** The architecture targets Windows x64 and macOS arm64 (`CLAUDE.md` §2.2), but
  everything here was developed and verified on macOS Apple Silicon. Nobody has run it on
  Windows.
