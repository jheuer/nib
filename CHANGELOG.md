# Changelog

All notable changes to nib are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/). Pre-1.0 minor bumps
may include breaking changes.

---

## [0.2.0] — 2025-04-21

### Added

**SVG parser**
- `<text>` elements rendered using Hershey Simplex font (previously silently skipped).
  All CTM transforms (rotation, scale, skew) apply correctly to each glyph point.
- `<use>` element resolution — looks up referenced elements by `href` / `xlink:href`
  across the full document (not just `<defs>`). `x`/`y` translation is applied.

**Core API**
- `hersheyStrokes(text, x, y, fontSizeMm) → Stroke[]` — direct code-first Hershey
  rendering without an SVG round-trip. Exported from `nib` and `nib/browser`.
- `deduplicateStrokes(strokes, toleranceMm?) → Stroke[]` — removes exact-duplicate
  strokes (forward or reverse) within the given mm tolerance.
- `validateProfile(profile) → string[]` — returns human-readable validation errors
  for out-of-range or inconsistent profile values.

**Typed error hierarchy** (`nib` and `nib/browser`)
- `NibError` — base class with a machine-readable `code` field.
- `PortNotFoundError` — no EBB device found.
- `EnvelopeViolationError` — move exceeds safe machine bounds.
- `DeviceDisconnectedError` — transport lost mid-job.
- `ValidationError` — profile or config value failed validation.
- `ConfigError` — config file unreadable or malformed.

**Visual preview renderer** (`nib/browser` and `nib`)
- `renderPreview(moves, ctx, options) → PreviewRenderStats` — paints a to-scale
  plotter preview onto any `CanvasRenderingContext2D`. Shows pen-down strokes,
  dashed pen-up travel (toggleable), paper rectangle, origin crosshair, machine
  envelope outline. Returns stroke count, distances, and travel overhead %.
- `renderPreviewSvg(moves, options) → string` — same output as a self-contained
  SVG string (no DOM required — works in Node, workers, CI).

**LivePlotter**
- `liveSession.currentPosition` — current tracked arm position in mm, software-
  counted from submitted moves. Resets on `reenableMotors()`.

**Browser demos**
- p5 demo: preview panel below the sketch shows the plotter's view of every
  generation, with a "show travel" toggle and live stats.
- Canvas demo: Release Motors / Set Home / Lift Pen / Disconnect buttons.
- Both demos: paper size selector (A4-p, A4-l, A3-p, A3-l).

**TypeScript**
- `tsconfig.examples.json` — ESM-mode config that includes `examples/` so
  type mismatches between example code and library types are caught at compile time.
- `bun run typecheck:examples` script.

### Fixed
- `EBBBackend.configureSession` no longer sends SP (servo move) commands at
  connect time, preventing the pen from touching the paper before the first stroke.
- `LivePlotter.home()` added as a standalone method; previously `home` was only
  accessible via `end()` which also closed the session.
- `process.stderr.write` guarded in `ebb.ts` so browser builds don't throw on
  calls that reach the diagnostic path.

---

## [0.1.0] — 2025-04-13

Initial release.

### Added
- Native EBB protocol backend (LM/SM stepper moves, servo control, firmware
  capability detection). No Python/axicli dependency.
- SVG parser: `<path>`, `<line>`, `<rect>`, `<circle>`, `<ellipse>`,
  `<polyline>`, `<polygon>` with full affine transform support.
- Hershey Simplex font (`hersheyText`, `hersheyTextWidth`) for SVG path output.
- Code-first stroke API (`Stroke`, `strokesToMoves`, `movesToStrokes`,
  `simplifyMoves`, `rotateMoves`, `translateMoves`, `strokeStats`).
- `geom` module: `line`, `polyline`, `polygon`, `rect`, `circle`, `ellipse`,
  `arc`, `bezier`, `quadBezier`, `translate`, `scale`, `rotate`, `simplifyStrokes`.
- Profile system: `profiles.toml`, named profiles, pen wear tracking,
  speed/accel caps, per-profile tuning.
- Machine envelope registry and bounds checking.
- Nearest-neighbour path reorder (opt levels 0/1/2).
- Trapezoid motion planner with junction-deviation corner smoothing.
- `LivePlotter` — long-lived browser session for interactive/streaming plots.
- WebSerial transport (`requestEbbPort`, `WebSerialTransport`).
- Browser demos: live freehand canvas, p5.js flow-field generator.
- CLI: `plot`, `preview`, `watch`, `profile`, `machine`, `job`, `series`,
  `calibrate`, `pen`, `move`, `home`, `motors`, `release`, `fw`, `config`, `init`.
- Preview stats: ETA, pendown/travel distance, lift count, bounding box.
- Plot card / annotation stamp.
- Auto-rotate SVG to fit paper orientation.
- Paper offset support (shifts content into paper space from machine origin).
- Multi-machine layer routing via `port` in layer config.
