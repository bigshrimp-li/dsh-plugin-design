# Provenance and licensing

This repository is **not all one licence**. It mixes three kinds of material, and they carry
different terms. Read this before you redistribute anything.

## 1. Original code (this repository's own work)

Written for this plugin, no third-party rights attached beyond the repository's own terms:

| Path | What |
|---|---|
| `src/render.ts` | serves a design canvas, drives headless Chrome, collects the artboard's self-reported size and errors |
| `src/export.ts` | turns `.dc.html` into a self-contained viewable HTML |
| `src/index.ts` | the plugin entry |
| `test/` | the test suite and fixtures |
| `install.sh`, `build-support.sh` | tooling |
| `docs/*.md` | architecture and porting analysis |

## 2. Ported from BaoCut (BaoCut Community License 1.0)

`src/check/` is a near-verbatim copy of BaoCut's design/design-system validators, and the tool
descriptions in `src/tools.ts` are copied verbatim. `src/blobs.ts` and `src/shared.ts` are lifted
from BaoCut's slides package and protocol types.

| Path | Upstream | Change |
|---|---|---|
| `src/check/tokens-check.ts` | `packages/design-system/src/tokens-check.ts` | **none** |
| `src/check/canvas-check.ts` | `packages/design/src/canvas-check.ts` | imports only |
| `src/check/canvas-layout.ts` | `packages/design/src/canvas-layout.ts` | imports only |
| `src/check/system-check.ts` | `packages/design-system/src/check.ts` | imports only |
| `src/check/system-layout.ts` | `packages/design-system/src/layout.ts` | imports only |
| `src/blobs.ts` | `packages/slides/src/deck-store.ts` | trimmed to the blob store |
| `src/shared.ts` | deck-store + protocol types | constants and types |
| `src/tools.ts` (descriptions) | `packages/runtime-core/src/agent-tools/design*.ts` | framework adapted to DSH |

Source: <https://github.com/JimLiu/baocut> at `7aa049e8` (the files above) and `37a5c351` (the runtime below).

`skills/` is BaoCut's `skills/baocut/built-in-skills/{design,design-system}/`, adapted to run under
DSH instead of BaoCut (see `skills/README.md`).

The **BaoCut Community License 1.0** is source-available, not open source. In summary — and the
licence text is what governs, not this summary:

- ✅ personal, learning, research, experimentation
- ✅ **internal use**, including paid internal development
- ✅ creating and selling *content* made with the software
- ❌ selling, renting or commercially distributing the software or a modified version
- ❌ running it for outside users as a commercial hosted service
- ❌ **incorporating its code into a commercial product, library, SDK or service supplied to others**

These restrictions apply whether you modify it or not and whether you publish your source or not.
For commercial licensing, contact the maintainer, Jim Liu (`junminliu@gmail.com`).

## 3. `vendor/support.js` — the artboard runtime (separate rights)

This 1.1 MB file is the **artboard runtime**: it is what turns a `.dc.html` source file into a live
interface. It was built by `vendor/build-support.sh` from
`baocut/packages/design-runtime/src/runtime/` (15 files, 3,576 lines), bundled with React 18.3.1.

BaoCut's own README describes that directory as a **1:1 reconstruction of the Claude Design editor's
shipped, minified JavaScript** — the project fingerprinted the live `app.js` function by function to
rebuild it. So:

> **BaoCut's community licence does not settle the rights to this file.** It is not BaoCut's code to
> license in the first place. Treat it as a separate question from everything above, and get your own
> legal read before you redistribute it or ship it inside anything you hand to other people.

Keeping it in a private repository for your own use is the same posture as keeping the BaoCut checkout
you built it from. Publishing this repository publicly is a different act.

It is also **not covered by whatever licence you apply to your own code in this repo** — you cannot
relicense it by adding a LICENSE file.

### Other third-party material inside `vendor/support.js`

Bundled by esbuild from npm, each under its own licence: React and ReactDOM 18.3.1 (MIT, Meta).
Nothing else is pulled in — the runtime imports only `react`, `react-dom` and `react-dom/client`.

## 4. Fonts referenced by example designs

The example designs ask for **Fraunces** and **Karla** from Google Fonts. They are not vendored here;
the designs link them at runtime and fall back to Georgia / system sans when offline. Both are
SIL Open Font License 1.1. If you keep those links, you are loading them from Google's CDN.
