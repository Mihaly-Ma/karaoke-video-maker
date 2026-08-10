# Third-party notices

Karaoke Video Maker itself is MIT licensed — see [`LICENSE`](LICENSE). This file covers
everything **else** that ends up inside the released installers (`.dmg` / `.exe`), plus the
things the application fetches onto the user's machine at run time but never redistributes.

Two rules decide what belongs here:

- **Shipped** means the bytes are inside the installer. Those carry notice obligations, and the
  texts are reproduced or pointed at below.
- **Fetched at run time** means the user's own machine downloads it after installation. Those are
  listed too, because some of them constrain what you may do with the output — but they are not
  redistributed by this project.

---

## Shipped: web assets (`webui/` inside the app bundle)

Built from `frontend/` by Vite. Everything under `frontend/public/` is copied verbatim into the
build output, and the build output is embedded in the backend executable.

### JASSUB 2.5.14 — `webui/jassub/**`

MIT. Copyright (c) 2021-2022 JASSUB contributors; copyright (c) 2017-2021
JavascriptSubtitlesOctopus contributors. Upstream: <https://github.com/ThaUnknown/jassub>.
Full text in [Appendix A](#appendix-a--jassub-mit-license).

`frontend/scripts/sync-jassub-assets.mjs` copies these files out of `node_modules` at build time.
**Modifications made by this project**, for the record:

- `sourceMappingURL` comments are stripped from every copied `.js` file (the `.map` files are not
  copied, so the comments would only produce 404s);
- three bare import specifiers in `worker/worker.js` (`abslink`, `abslink/w3c`, `lfa-ponyfill`)
  are rewritten to relative paths so a browser can resolve them without a bundler.

The `.wasm` files are copied byte-for-byte and are not modified.

**Libraries compiled into `webui/jassub/wasm/*.wasm`.** The wasm is an unmodified upstream build.
JASSUB declares the resulting composite license as:

```
LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0
```

Identified in the binary: **libass** (ISC), **FreeType** (FTL or GPL-2.0-or-later), **HarfBuzz**
(Old MIT / MIT-Modern-Variant), **FriBidi 1.0.11** (LGPL-2.1-or-later). Their sources and license
texts are those of the JASSUB v2.5.14 release, which contains the build recipe and pins each
library; the pinned version is enforced by the sync script, so the wasm shipped here always
corresponds to that release.

As required by the FreeType License:

> Portions of this software are copyright © The FreeType Project (www.freetype.org).
> All rights reserved.

### Liberation Sans — `webui/jassub/default.woff2`

SIL Open Font License 1.1. Version 2.00.5. Copyright notice as recorded in the font's own `name`
table:

```
Digitized data copyright (c) 2010 Google Corporation.
Copyright (c) 2012 Red Hat, Inc.
```

Liberation is a trademark of Red Hat, Inc. Full license text in
[Appendix B](#appendix-b--sil-open-font-license-11).

This is JASSUB's fallback font, shipped as part of its distribution. The application does not
normally render with it — it feeds libass a subset of the user's chosen fonts instead.

### abslink — `webui/jassub/vendor/abslink/**`

Apache License 2.0, author ThaUnknown. A dependency of the JASSUB worker, vendored by the same
sync script. **Modified**: `sourceMappingURL` comments stripped, as above. The Apache-2.0 text is
not reproduced here; it is the unmodified standard text available from the Apache Software
Foundation and from the upstream package.

### lfa-ponyfill — `webui/jassub/vendor/lfa-ponyfill/**`

MIT, author ThaUnknown. Vendored unmodified except for the `sourceMappingURL` strip.

### npm runtime dependencies — `webui/assets/*.js`

Bundled and minified by Vite. React 18 and react-dom (MIT, Meta Platforms), wavesurfer.js 7
(BSD-3-Clause), zustand 5 (MIT), `@ant-design/icons` (MIT), and the main-thread half of JASSUB
(MIT, above). Each package's own license text is in its `node_modules/<pkg>` directory in a
checkout with dependencies installed.

### `webui/audio/timestretch-processor.js`

This project's own code (MIT, see `LICENSE`). Listed only because it sits next to vendored files.

---

## Shipped: frozen Python runtime (`_internal/` inside the app bundle)

PyInstaller freezes CPython 3.12 (PSF-2.0) together with the dependency graph declared in
`pyproject.toml`. Licenses of the direct dependencies, as read from the installed package
metadata:

| Package | License |
|---|---|
| torch, torchaudio | Apache-2.0 (with Apache-2.0 WITH LLVM-exception components) |
| numpy | BSD-3-Clause (with 0BSD / MIT / Zlib components) |
| scipy | BSD-3-Clause |
| librosa | ISC |
| numba | BSD-2-Clause |
| llvmlite | BSD-2-Clause and Apache-2.0 WITH LLVM-exception |
| onnxruntime | MIT |
| audio-separator | MIT |
| torchcrepe | MIT |
| soundfile | BSD-3-Clause |
| fastapi, pydantic, fontTools, Brotli | MIT |
| uvicorn, httpx | BSD-3-Clause |
| Pillow | MIT-CMU |
| requests, python-multipart | Apache-2.0 |
| pycryptodome | BSD-2-Clause and Public Domain |
| yt-dlp | Unlicense |
| certifi | MPL-2.0 |

PyInstaller does not preserve every package's license file inside the bundle. The authoritative
copy of each text is the one shipped in that package's own distribution; `uv sync` reproduces the
exact set from `uv.lock`.

## Shipped: desktop shell

`src-tauri/` builds a Tauri 2 shell. Tauri and the Rust crates it pulls in are dual-licensed
Apache-2.0 OR MIT; `Cargo.lock` pins the exact set.

## Shipped: application icons

`src-tauri/icons/` is generated from `src-tauri/icons/source.png` by `scripts/make_icons.py`.
That source image was produced with an AI image generator; it is not covered by any of the
licenses listed above.

---

## Fetched at run time — not redistributed

- **ffmpeg.** Located on the system or downloaded into the application's private directory
  (`kvm.bootstrap`). It is executed as a separate program and is never linked into or shipped
  with this software; the builds this project recommends are GPL builds, which is fine for that
  usage. ffmpeg's own license travels with the binary you obtain.
- **Separation model weights** (UVR / MDX / Roformer / Demucs, via `audio-separator`) and any
  other model weights are downloaded on demand into the application's cache directory. Their terms
  are set by whoever published them.
- **`MMS_FA` / `ctc-forced-aligner` weights are CC-BY-NC 4.0 — noncommercial use only.** Forced
  alignment is not wired in yet. If and when it is, that restriction attaches to the model, not to
  this project's code: **the code stays MIT, but a build that uses those weights, and the videos it
  produces, must not be used commercially** unless the alignment model is swapped for one without
  that restriction.
- **Fonts.** The application renders with fonts already installed on the user's machine and
  generates subsets of them into its private cache. Those subsets are derived from the user's own
  licensed fonts, stay on that machine, and are never redistributed by this project. Many system
  fonts (Hiragino, Yu Gothic, …) are proprietary and may not be redistributed at all.

---

## Appendix A — JASSUB (MIT License)

```
MIT License

Copyright (c) 2021-2022 JASSUB contributors
Copyright (c) 2017-2021 JavascriptSubtitlesOctopus contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Appendix B — SIL Open Font License 1.1

Applies to Liberation Sans (`webui/jassub/default.woff2`), and to any OFL-licensed font this
project may bundle in the future.

```
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font
creation efforts of academic and linguistic communities, and to
provide a free and open framework in which fonts may be shared and
improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to
any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software
components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to,
deleting, or substituting -- in part or in whole -- any of the
components of the Original Version, by changing formats or by porting
the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed,
modify, redistribute, and sell modified and unmodified copies of the
Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the
corresponding Copyright Holder. This restriction only applies to the
primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created using
the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
