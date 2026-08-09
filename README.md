# Karaoke Video Maker (ニコカラ Maker)

**Language:** English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A one-stop, fully local **J-pop / anime karaoke ("nicokara") video generator**: give it a
YouTube link, get back a finished video with word-by-word color-sweep lyrics, Japanese
furigana (振り仮名), and optional dual audio tracks (vocals-on / vocals-off). Every
inference step — vocal separation, timing, reading generation — runs on your own machine.
Nothing is sent to a cloud AI service.

![Rendered output — color-sweep lyrics with furigana over the source MV](docs/images/hero-render.png)
*A still frame from an actual rendered output: the currently-sung phrase turns blue, furigana
sits above the kanji, and the rest of the line stays white — the classic nicokara look.*

---

## What this actually is right now

This repository is under active development. There is a real, working **FastAPI backend**
(`backend/kvm/`) and a real **React + TypeScript editor** (`frontend/src/`), not just a design
document. Concretely, today you can:

- Pull a video via `yt-dlp` (YouTube, and experimentally Bilibili) or import a local file
- Separate vocals from instrumental locally with `audio-separator` (three quality tiers)
- Search QQ Music for a character-level, furigana-tagged lyric source (QRC), or paste/import
  lyrics by hand
- Manually time every line and word against a waveform (tap-to-time, drag boundaries, global
  offset nudge) with full undo/redo and per-item lock so hand-tuned timing is never silently
  overwritten
- Edit furigana per character span, with a visible "where did this reading come from" badge
- Pick a font from your installed system fonts (with a CJK-coverage check before you commit to
  one), tune size/outline/shadow as a percentage of frame height, and assign color palettes per
  voice part
- Export a burned-in MP4, optionally with a second OFF VOCAL cut and/or a synthesized guide
  melody (ガイドメロディ) mixed into the instrumental track

The project's working contract — `CLAUDE.md` at the repo root — describes a considerably
larger target architecture (forced alignment, morphological-analysis-based reading generation,
multi-provider lyric search, automatic environment self-check, automatic dependency
acquisition, etc.). Some of that is implemented, some is not yet. **§ Project status** below is
an honest, code-verified breakdown — read it before assuming a feature exists.

| | |
|---|---|
| ![Timing editor: waveform, tap-to-time, timing-source legend, undo/redo](docs/images/editor-timing.png) | ![Furigana editor: per-span reading with source badges](docs/images/editor-ruby.png) |
| Timing step — waveform + tap-to-time + timing-source colors | Furigana step — per-character-span reading editor |

---

## Hard prerequisites (read this before you try to install anything)

Skipping any of these will make the app fail in a way that's not obviously about the thing you
skipped, so check them up front.

1. **ffmpeg must be built with libass, and you must verify it by capability, not by version
   number.** The mainline Homebrew `ffmpeg` formula does **not** include libass — you need
   `ffmpeg-full` (macOS) or a "full"/gyan.dev-style build with `--enable-libass` (Windows).
   Verify with:

   ```bash
   ffmpeg -h filter=ass
   ```

   If this prints `Unknown filter 'ass'` (or similar), your ffmpeg cannot burn subtitles and
   nothing downstream will work, no matter what `ffmpeg -version` says. On this machine,
   `brew install ffmpeg-full` gives ffmpeg 8.1.2 with the `ass` filter registered — confirmed
   working while writing this README.

2. **Python 3.12, managed by [`uv`](https://docs.astral.sh/uv/).** The project pins
   `requires-python = ">=3.12,<3.13"`; don't fight this with whatever Python your OS ships.
   `uv python install 3.12` gets you a pinned interpreter without touching the system one.

3. **Node.js** (18+ recommended; developed and verified against Node 22 / npm 10) for the
   frontend.

4. **Model weights are downloaded at first use, not bundled.** Vocal separation models range
   from ~84 MB (fast tier) to ~640 MB (best tier); the guide-melody pitch model is 2–89 MB
   depending on which CREPE variant you pick. First run of a feature that needs a model will
   pause to download it — this is expected, not a hang, but you do need network access at
   that moment even though the rest of the pipeline is offline-capable afterward.

5. **Apple Silicon (arm64) only on macOS — Intel Macs are not supported.** PyTorch dropped
   Intel-macOS support after 2.2, and vocal separation depends on it. On Windows, x64 with
   either an NVIDIA GPU (CUDA) or CPU-only both work, at very different speeds.

6. **No cloud AI, by design.** Downloading source video/audio and fetching lyric text over the
   network is fine; sending audio or lyrics to a remote model for inference is explicitly out
   of scope for this project (see `CLAUDE.md` §2.1). If you're evaluating this repo, don't
   expect (or add) an "optional cloud acceleration" mode.

---

## Getting started

Clone the repo, then from the repository root:

```bash
# Python toolchain (backend)
uv python install 3.12
uv sync --extra api --extra fonts --extra audio --extra separate --extra download --extra lyrics

# Node toolchain (frontend)
cd frontend && npm install && cd ..
```

Dependencies are grouped in `pyproject.toml` on purpose: the core pipeline is light, and heavy
extras (`torch`-based separation, `librosa`-based audio analysis) only get pulled in if you
actually use those features. `uv sync` with no `--extra` flags gives you just enough to run the
render pipeline on already-prepared inputs.

### Run the backend

```bash
uv run uvicorn --app-dir backend kvm.api.app:app --host 127.0.0.1 --port 8000 --reload
```

(`--app-dir backend` is required because the importable package is `backend/kvm/`, not a
top-level `kvm/` — this is the exact invocation the dev server on this machine is running
under.) On startup it also kicks off a background system-font scan (can take 30–40 seconds on
a machine with many fonts installed); the style step in the editor will show a "scanning…"
state until that finishes, rather than blocking.

The backend serves `GET /api/health` and sets the COOP/COEP headers the frontend's libass-based
previewer (JASSUB) needs for `SharedArrayBuffer`.

### Run the frontend

```bash
cd frontend
npm run dev
```

This starts Vite on `http://localhost:5173` with the COOP/COEP headers already configured, and
copies JASSUB's worker/wasm assets into `public/` first (`predev` hook). Open that URL, and
you'll land on the project library (create a new project, or open an existing one):

![Project library — multiple in-progress karaoke projects with completion status](docs/images/editor-home.png)

The editor
is a six-step flow: **素材/Material → 歌词/Lyrics → 对轴/Timing → 注音/Furigana →
样式/Style → 导出/Export**, each step's stage using the full main area for whatever that step
actually needs (waveform for timing, ruby editor for furigana, etc.) rather than a fixed
"video player + timeline" layout.

> The editor UI text is **Chinese only** right now. There's an i18n abstraction in
> `frontend/src/i18n/` (all UI strings already route through a `t()` function), but the
> Japanese and English string tables haven't been written yet, and there's no in-app language
> switcher. If you don't read Chinese, the six-step icons and screenshots above are your best
> guide for now.

---

## Producing your first video

### Via the GUI (recommended)

1. Open the app, create a project, paste a YouTube link (or pick a local video file) in the
   **Material** step and let it download; optionally kick off vocal separation there too.
2. In **Lyrics**, search QQ Music (currently the only wired-up automatic lyric source) or paste
   lyric text / import an LRC/QRC file by hand.
3. In **Timing**, either accept the QRC-provided character timing, or hand-time from scratch
   with tap-to-time against the waveform (press <kbd>T</kbd>), then nudge/drag to refine.
4. In **Furigana**, review and fix any readings — every span shows where its reading came from
   (lyric source / dictionary / manual).
5. In **Style**, pick a font your system actually has full coverage for the song's characters,
   and adjust size/outline/color per voice part.
6. In **Export**, optionally enable an OFF VOCAL cut and/or a mixed-in guide melody, then export.

### Via the CLI (useful for iterating on rendering/style code without the GUI)

The CLI takes an already-imported QRC lyric (`qrc_parsed.json` + `kana_entries.json`, as
produced by the QRC import pipeline) and a downloaded video, and burns a finished MP4:

```bash
uv run --python 3.12 --with numpy --with "librosa>=0.11" --with "numba>=0.61" \
  python backend/kvm/pipeline/make_video.py \
  --video   workspace/media/<video>.mkv \
  --parsed  workspace/qrc/qrc_parsed.json \
  --kana    workspace/qrc/kana_entries.json \
  --drums   "workspace/sep_full/<track>_(Drums)_htdemucs.flac" \
  --out     workspace/out/final.mp4
```

Useful flags (all confirmed via `--help`): `--ass-only` to generate just the `.ass` file for
fast style iteration; `--start`/`--duration` to render a short preview segment; `--audio` to
swap in an instrumental track for an OFF VOCAL export; `--guide-vocals` to synthesize and mix
in a guide melody (with `--guide-timbre`, `--guide-gain`, and several shaping parameters); `--offset-ms`
for a global timing offset. Run `python backend/kvm/pipeline/make_video.py --help` for the full,
current list — it changes as the pipeline evolves, so treat this README's flag list as a
pointer, not the source of truth.

Vocal separation from the CLI:

```bash
uv run --python 3.12 --with audio-separator --with onnxruntime audio-separator \
  workspace/media/audio_44k.wav --model_filename htdemucs.yaml \
  --model_file_dir workspace/sep_probe/models --output_dir workspace/sep_full
```
(`audio-separator` doesn't pull in `onnxruntime` on its own — pass it explicitly, or the
separation step will fail with an import error.)

---

## How it works

**The single source of truth is the project file — never the ASS subtitle file.** ASS is a
render *target*, generated fresh from the project's data model every time you export or
preview; it is never parsed back into the project. This matters because every stage below is
designed to only overwrite fields that haven't been locked by a manual edit — if ASS were
round-tripped, that guarantee would be impossible to keep.

```
YouTube link ──▶ download (yt-dlp) ──▶ extract audio
                                            │
                                            ▼
                                   vocal separation (audio-separator)
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
             lyric source            re-anchor timing          guide melody /
          (QRC search / paste)     to the MV's own audio       beat detection
                    │                       │                       │
                    └───────────┬───────────┘                       │
                                 ▼                                  │
                    furigana / reading editing                      │
                                 │                                  │
                                 ▼                                  │
                  three-tier timing (whole / line / word)           │
                        — manual is a first-class path,             │
                          not a fallback                            │
                                 │                                  │
                                 ▼                                  │
                       layout engine + style ◀──────────────────────┘
                                 │
                                 ▼
                        ASS serialization
                                 │
                    ┌────────────┴────────────┐
                    ▼                          ▼
           JASSUB preview (WASM libass)   ffmpeg burn-in (same libass build)
```

A few design points worth calling out:

- **"One-stop" is a hard product constraint, not a nice-to-have.** There is no step in this
  pipeline where the intended UX is "now go do this part in Aegisub." Every automatic step
  (download, lyric fetch, timing, reading, line-breaking, paragraph detection) has a manual
  fallback in the same UI, and automatic failures degrade gracefully rather than blocking the
  pipeline.
- **Every automatically-produced value carries `(value, source, locked)`.** Re-running an
  automatic step only touches fields where `locked = false`. This is what makes "the aligner
  reran and it's fine, my hand-timed chorus is untouched" actually true rather than aspirational
  — it's enforced in `backend/kvm/editing/ops.py`, not just documented.
- **Timing units are always milliseconds internally**; centiseconds (`\k` in ASS) only exist at
  serialization time, and are derived by rounding cumulative timestamps and taking differences —
  not by rounding each duration independently — to avoid drift accumulating across a long line.
- Preview (JASSUB, a WASM build of libass) and export (ffmpeg's `ass` filter) are intended to
  render from the *same* libass build so what you see while editing matches the burned-in
  output; see `CLAUDE.md` §5.12 for the specifics this project tracks to keep that true.

For the full architecture — the project file's data model, the reading-priority system, the
ASS-generation layout engine, every already-run experiment and its result — see `CLAUDE.md` at
the repo root. It's long and dense on purpose: it's the actual engineering contract this
project is built against, not marketing copy.

---

## Project status

This section is generated from reading the actual code, not from the design doc. Where the two
disagree, the code wins here.

**Implemented and working (verified in this environment):**

- FastAPI backend with routers for projects (incl. undo/redo + autosave-on-mutate), lyric
  search/preview/apply/import, media download/separation/proxy generation, editing operations
  (shift/set-timing/lock/ruby/split/merge/voice-part), ASS generation + async export jobs, and
  system-font scanning/coverage-checking/subsetting
- A six-step React editor (Material / Lyrics / Timing / Furigana / Style / Export) with a
  project library/home screen, undo/redo, and a stage layout that gives each step the full
  main area instead of a fixed video-player-centric shell
- Tap-to-time manual timing against a waveform, boundary dragging, global-offset nudge,
  line split/merge, and a visible timing-source legend (un-timed / lyric-source / auto-aligned
  / interpolated / manual+locked)
- Manual + lyric-source-driven furigana editing with per-span source badges
- YouTube (and experimental Bilibili) download via yt-dlp, with audio-quality-first stream
  selection and content-start-offset detection
- Local vocal separation via `audio-separator`, run in an isolated subprocess with JSON-lines
  progress reporting and content-hash-keyed caching (not in-process, not blocking the API)
- QQ Music QRC lyric search/fetch, including the (non-standard, buggy-S-box) DES decryption —
  independently reimplemented in Python from publicly-documented constants, importing no
  third-party decryption code
- Guide melody synthesis (pYIN/CREPE-based pitch extraction → quantized synthesis, mixed into
  the instrumental) and drum-stem-based beat detection driving the karaoke "get ready" indicator
  dots
- 192 backend tests passing at time of writing (`pytest`, run via `uv run --with pytest pytest`)
- ffmpeg auto-*detection* (capability-probed, not version-probed) across known install locations

**Designed but not yet implemented — do not assume these exist:**

- **Forced alignment / CTC-based timing** — the data model has `TimingSource.ALIGNED` reserved,
  but nothing in the pipeline currently produces it; today's timing is QRC-provided or manual
  only. The re-anchoring-to-MV-audio experiment (`experiments/reanchor_xcorr.py`) is a standalone
  script, not wired into the pipeline.
- **Automatic reading generation** (morphological analysis, dictionary lookup, acoustic
  disambiguation) — `ReadingSource.MORPH`/`DICT`/`ACOUSTIC` are reserved enum values with no
  producer yet. Furigana today comes from the QRC kana track or manual entry only.
- **Additional lyric providers** — Kugou, NetEase, LRCLIB, UtaTen, and YouTube's own captions
  are all researched (see `CLAUDE.md` §5.2 and the `experiments/` scripts) but only QQ Music is
  wired into the production `kvm.lyrics` package today.
- **Speaker/voice-part diarization** — voice parts are assigned manually via the editor; there
  is no automatic lead/backing-vocal detection.
- **Automatic dependency acquisition** — ffmpeg is *located* if already present, but not
  auto-downloaded/installed into an app-private directory yet; there's no environment
  self-check command (`backend.doctor` doesn't exist yet).
- **Bundled fonts** — the style step lets you pick from fonts already installed on your system
  (with a CJK-coverage check), it does not ship or auto-fetch any font files itself yet.
- **Japanese/English UI** — as noted above, the editor is Chinese-only; the i18n plumbing exists,
  the translations don't.
- **Windows** has not been exercised in this environment (developed and verified here on macOS
  Apple Silicon only); the architecture targets both platforms per `CLAUDE.md` §2.2, but nobody
  has run it on Windows yet as far as this README's author could verify.

If you're deciding whether to rely on a specific feature, grep the code before trusting either
this list or `CLAUDE.md` — both age, the code is ground truth.

---

## License and legal notes

There is currently **no `LICENSE` file in this repository**. The project's stated distribution
posture (see `CLAUDE.md` §3) is: private/self-use, at most published as source-visible open
source — **no compiled binaries are distributed**. Treat the code accordingly until a license
file says otherwise.

A few things that follow from that posture and are worth knowing if you build on this repo:

- Some optional runtime dependencies are **GPL-licensed** (e.g. `pykakasi`, some lyric-provider
  reference implementations this project deliberately does *not* import from — see `CLAUDE.md`
  §3/§6.1 for exactly what was and wasn't used). This project's own QRC-decryption code was
  independently written in Python from publicly-documented constants, not copied from any
  GPL codebase.
- The forced-alignment model this project's design targets (`MMS_FA` / `ctc-forced-aligner`
  weights) is **CC-BY-NC 4.0 — noncommercial only**. It isn't wired into the pipeline yet (see
  Project status above), but if/when it is, **this project and anything produced with it must
  not be used commercially** unless that model is swapped out first.
- **Downloading video/audio and scraping lyric text is subject to the terms of service and
  copyright of the platforms involved** (YouTube, QQ Music, etc.). This tool automates fetching
  publicly-served data for personal, non-commercial use; it does not grant you any rights you
  didn't already have, and you're responsible for how you use it. This is not legal advice.

---

## Further reading

- `CLAUDE.md` (repo root) — the full engineering contract: data model, every technology
  decision and why, every experiment already run and its result, and every open question still
  being worked through. Long, dense, and the actual source of truth for anyone contributing.
- `docs/ui-redesign.md` — the current front-end information-architecture spec (the six-step
  stage-based shell described above is what this document specifies).
