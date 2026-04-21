# nib roadmap

Items are ordered by impact. "Incredible" threshold is roughly: does this make a plotter artist's day materially better?

---

## T1 — Do first

### Visual preview renderer
**Status: in progress**

`renderPreview(moves, options)` → `HTMLCanvasElement` (browser) / SVG string (universal).

- Pen-down strokes drawn in configurable color (or per-layer colors)
- Pen-up travel drawn as dashed light gray (toggleable)
- Paper background, envelope outline
- Stats overlay: estimated time, pendown/travel distance, lift count
- Lives in `src/core/preview-render.ts` (no DOM dependency — takes a `CanvasRenderingContext2D` from caller)

This pays off in every workflow: CLI `nib preview`, browser demos, generative scripts.

### 2-opt path optimization
**Status: planned**

Post-pass on top of nearest-neighbor reorder. Swap pairs of travel edges until no improvement. Typically cuts travel 20–40% on dense compositions. Lives in `src/core/reorder.ts` as an optional second pass.

### Fill / hatch engine
**Status: planned**

`hatch(path, options) → Stroke[]` — clips parallel lines to a closed polygon boundary.

Variants:
- `linear` — parallel lines at angle + spacing
- `crosshatch` — two linear passes at 90°
- `contour` — concentric insets (like a topographic map)
- `spiral` — Archimedean spiral fill

Geometry: line-segment clipping against polygon edges (Sutherland–Hodgman or scan-line).
Lives in `src/core/hatch.ts`.

---

## T2 — High value

### Plot resumption
**Status: planned**

Long plots fail. Save stroke index to a checkpoint file every N strokes during `runJobEbb`. New CLI flag: `nib plot --resume <job-id>` skips to the last checkpoint. Needs a checkpoint store alongside the job history.

### SVG `<clipPath>` and `<symbol>` support
**Status: planned**

`<clipPath>` is common in Inkscape output. `<symbol>` + `<use>` is the standard SVG reuse pattern (`<use>` resolution is already wired — `<symbol>` just needs to resolve as the referenced element without its own viewport transform).

Approach: collect `<clipPath>` definitions during the `buildDefsMap` pre-pass; apply clip polygons when processing child elements.

### Typed error propagation
**Status: planned**

The typed error hierarchy (`NibError` etc.) exists but throw sites in `web-serial.ts`, `ebb.ts`, and `config.ts` still throw generic `Error`. Update them to throw the right typed errors so user code can `catch (e) { if (e instanceof PortNotFoundError) ... }`.

---

## T3 — Polish / ecosystem

### Stippling engine
`stipple(imageData | grayscaleGrid, options) → Stroke[]` via weighted Voronoi / Mitchell's best-candidate. Produces point arrays that can then be connected or plotted as individual dots.

### `nib preview` CLI command
Render a plot to PNG without hardware. Calls the preview renderer, pipes to an image file. Useful for CI, README generation, generative pipelines.

### Per-media velocity calibration wizard
`nib calibrate speed <profile>` — plots test strokes at increasing speeds, prompts user to pick the fastest clean result, writes `speedCapMms` back to the profile.

### Velocity-aware corner dwell
At tight corners below a configurable angle threshold, insert a brief dwell (pen-down pause) to let ink settle. Prevents the characteristic "gap at corner" artifact on fast plots with watery inks.

### Streaming large jobs
Replace `PlannerMove[]` with `AsyncIterable<PlannerMove>` through planner and backend for 50k+ stroke compositions. Avoids the memory cliff on large generative outputs.

---

## Completed

- EBB native protocol (LM/SM, servo, firmware caps)
- SVG parser: path/line/rect/circle/ellipse/polyline/polygon/text/use
- Hershey Simplex font (SVG path + Stroke[] APIs)
- Live plotting session (LivePlotter)
- Nearest-neighbor path reorder
- Profile system (profiles.toml, validation, wear tracking)
- Envelope bounds checking
- Typed error hierarchy (NibError, PortNotFoundError, EnvelopeViolationError, …)
- `deduplicateStrokes()`, `validateProfile()`
- `LivePlotter.currentPosition`
- Browser demos: canvas (freehand), p5.js (flow field)
- Plot card / stamp
- Multi-machine / paper_offset support
- Preview stats (ETA, distances, bounding box)
