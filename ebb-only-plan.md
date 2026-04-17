# EBB-Only Plotting Plan

Goal: `nib` offers a high-quality CLI experience for plotting SVGs over USB serial to an EBB-driven AxiDraw, with **no axicli/Python dependency**. Also a clean TypeScript library for Node and browser consumers.

## Where we're going — ROI-ranked next steps

### Tier 1 — do next (each ≈ ½ day, high leverage)

1. **Hardware validation on real content.** Plot something with curves and connected strokes (anything from `sketches/`) to confirm Phase 2b/2c/3/5a work together on non-fixture content. Cheapest way to surface latent bugs before more code lands on top.
2. **Phase 6b — WebSerialTransport.** Unlocks browser consumers completely. `~100` lines wrapping a `SerialPort` object, plus a package exports map. Hardware-in-the-loop smoke test in Chrome.
3. **Phase 6c — `plotStrokes` + `geom` module.** Canonical API for code-first generative sketches (the declared primary web use case). Extract pure geometry helpers from the SVG parser, add the strokes-first pipeline.

### Tier 2 — soon after (each ≈ ½ day, compounding value)

4. **README** — three worked examples: CLI, Node library, browser library. Library without docs is under-adopted.
5. **`plot()` public API events polish.** Wire `PlotEmitter` into the top-level `plot()` wrapper with typed callbacks (`onProgress`, `onStroke`). Currently only exposed via the lower-level `runJobEbb`.
6. **Time-based progress bar.** Driven by planner duration instead of move-count. Only matters for long plots but that's when progress matters.

### Tier 3 — nice to have

7. Phase 6d — `Plotter` class (stateful live API, for canvas UIs and camera-in-the-loop).
8. `<text>` handling — loud warning or Hershey-path conversion (we already have the Hershey font).
9. Phase 5b — `+pause` / `+speed{N}` layer-label action prefixes.
10. npm publish — needs README + version tagging + .npmignore.
11. Shell completions.
12. Reference-diff harness vs Python axidraw.
13. `<use href="#...">` SVG resolution.

**Sequencing note.** Tier 1 items are independent — any order works. #1 before #2/#3 is slightly preferred so any bugs land on smaller surface area, but not required.

---

## Current state (2026-04-16)

| Capability | EBB-native | Still axicli |
|---|---|---|
| SVG → moves (path/rect/circle/polyline/bezier) | `svg-to-moves.ts` | — |
| Preview stats (distance, lifts, bbox, fits) | `ebb-preview.ts` | opt-in |
| Plot runner (EBBBackend.runJob) | `ebb.ts` | default |
| Pen up/down, servo, motors, move | `ebb-protocol.ts` | — |
| Calibration wizard | native | — |
| `move`, `motors`, `home` subcommands | — | subprocess to `axicli manual` |
| Path reordering (`--optimize`) | — | `--reordering` flag |
| Copies (`--copies N`) | runs once | `--copies` flag |
| Layer filter at plot time | ignored by EBBBackend | `--layer` flag |
| `series`, `watch`, `job resume` | — | hardcoded axicli |
| Acceleration / speeds > 13 mm/s | — (SM only) | — |
| Default `--backend` | — | `axicli` |

## The four real gaps

1. **Speed.** SM-only tops out ~10 mm/s pen-down. LM (trapezoidal accel) is what makes axicli feel "fast." Without it, native plots are 3–5× slower.
2. **Path ordering.** Native runs in document order. Needs a local reorderer to match axicli's `--reordering 2`.
3. **Coverage of manual ops.** `nib move / motors / home` still shell out. These must be native `EBBPort` calls so axicli can be removed entirely.
4. **Feature parity in runJob.** Copies, layer filter, fractional resume, wall-clock ETA.

---

## Phase 1 — Feature parity of the native plot path

1. **Path reordering module** `src/core/reorder.ts`
   - Input: `PlannerMove[]`. Group into strokes (pen-down run with entry/exit).
   - Level 0: pass-through (doc order).
   - Level 1: nearest-neighbor greedy on stroke endpoints.
   - Level 2: NN + stroke reversal + light 2-opt.
   - Returns reordered moves + before/after lift count and travel distance.

2. **EBBBackend feature additions** (`src/backends/ebb.ts`)
   - Apply reorder when `job.optimize > 0`.
   - Honor layer filter via `svgToMoves({ layer })`.
   - Loop `for c in 0..job.copies` with page-delay between copies; home between.
   - Fractional resume: accept `startFrom: number` (0–1), fast-forward to nearest pen-up boundary.

3. **Replace axicli manual commands** (`src/cli/index.ts`)
   - `move --x --y` → open EBBPort, enable motors, SM to offset.
   - `move --home` → software home-return (or refuse without a known origin).
   - `motors on|off` → `enableMotors(5,5)` / `disableMotors()`.
   - Delete `runAxicliManual()`.

4. **Flip the default backend**
   - `--backend ebb` becomes default. Keep `--backend axicli` as opt-in for one release with a deprecation warning.
   - Wire `series.ts`, `watch.ts`, `cli/job.ts` through `runJobEbb`.

## Phase 2 — Speed: LM command with acceleration

### Phase 2a — Per-move trapezoids (done 2026-04-16)

- `ebb-protocol.ts`: `lm()` command, `lmRateReg`/`lmAccelReg` encoders, `firmwareVersion()`, `firmwareAtLeast`, new caps `LM_SPEED_PENDOWN_MAX_MMS=50`, `LM_SPEED_PENUP_MAX_MMS=100`, `ACCEL_MAX_MMS2=2000`. Tests in `test/lm-encoding.test.ts`.
- `core/planner.ts`: `planTrapezoid` + `planMove` — emits 1–3 LM phases per move with exact per-axis step totals. Tests in `test/planner.test.ts`.
- `EBBBackend.connect` auto-detects firmware; ≥ 2.7 enables LM path. Older firmware falls back to SM cleanly.
- Rest-to-rest per move (no junction look-ahead yet). Hardware not yet run against LM — needs a test plot to confirm the direction-sign / CoreXY translation is correct under acceleration.

### Phase 2b — Junction velocities (done 2026-04-16)

- `planStroke(points, options)` in `core/planner.ts` — forward + backward pass using Marlin's junction-deviation formula. Straight-line junctions → vMax, 90° corners → `sqrt(accel · d_junction · (1 + cos θ) / (1 - cos θ))`, reversals → 0. Tests in `test/planner.test.ts`.
- `EBBBackend.runJob` groups consecutive pen-down moves into strokes and calls `runStroke`, which queues all LM phases of all segments back-to-back (FIFO pipelined) and sleeps once at the end for the total stroke duration. Pen-up travels remain single rest-to-rest moves.
- Net effect: connected strokes (especially flattened beziers) now cruise through internal junctions instead of stopping at every segment boundary. Real plotting throughput jumps noticeably.

### Phase 2d — Safety rails (done 2026-04-16)

- **Persistent arm position**: `~/.local/share/nib/state.toml` tracks carriage X/Y across invocations. `nib move` advances it, `nib motors on` resets to (0,0), `nib motors off` / `nib release` mark it unknown. `nib plot` refuses to run when position is non-zero or unknown without `--yes`, with hints to `nib home` / `nib motors on`.
- **`nib home` / `nib position`** — explicit commands for returning to origin and inspecting tracked state.
- **Envelope bounds check**: `axidraw.toml` accepts `model = "V3A3"` (built-in table for V3 / V3A3 / Mini / SE/A3 / V3XLX) or `envelope = "280x218"` override. `nib preview` shows a machine-fit row, `nib plot` pre-flights every move against the envelope and refuses to start if any point is outside bounds. EBBBackend also runtime-guards every move during the plot and aborts cleanly on violation.

### Phase 2c — Preview parity + transition tuning (done 2026-04-16)

- `previewStatsFromMoves` now walks strokes through `planStroke` and pen-up travel through `planMove`, summing per-phase durations plus a fixed per-lift transition cost (~0.35 s). ETA reflects trapezoid acceleration + junction speeds, not a naive distance/speed quotient.
- `EBBPort.penUpFast(clearMs=80)` — pen up for plot transitions. Sleeps only long enough for the pen to clear paper; servo continues rising in the background while the next travel move runs. Saves ~140 ms per stroke transition vs full settle. Used in `runJob`'s pen-up branch.
- Full `penUp` (220 ms settle) still used at end of copy, in `disconnect`, and in manual CLI commands — those don't benefit from overlapped servo travel.
- FIFO batching across move boundaries (polling `QM` to keep commands queued) skipped for now — sleep-for-duration after each stroke matches actual wall clock, and the LM FIFO is already utilized within each stroke.

## Phase 3 — Partially done (2026-04-16)

Delivered:
- **SVG visibility inheritance + style parsing** — `svg-to-moves.ts` now carries a `StyleContext` down the tree and merges presentation attributes + inline `style="..."`. `display:none`, `visibility:hidden`, `stroke:none` all work on ancestors. `+8 tests` in `svg-to-moves.test.ts`.
- **Preview reorders before computing stats** — `previewStatsFromSvg(svg, profile, optimize)` now runs the same reorder the plot will use. Travel distance / pen lifts / ETA match what actually prints.
- **Dry-run prints planner summary** — `nib plot --dry-run` outputs pen-down / travel / lift count / ETA / max speed / bounding box, driven by the same `previewStatsFromSvg` pipeline. No more misleading "would invoke axicli with..." message.
- **ES-based SIGINT abort** — `safeAbort` fires `ES` first to drop queued FIFO commands and halt motion immediately, then pen-up and home. Same path is used by envelope violations and SIGINT.

Still to do:
- `<use href="#..."` resolution
- `<text>` warning / `--text-as-paths` preprocess
- Time-based progress bar

## Phase 3 — SVG robustness & CLI polish (original scope)

9. **SVG parsing gaps** in `svg-to-moves.ts`
   - Inheritable `display`/`visibility`/`style="display:none"` on ancestors.
   - Parse `style="..."` for stroke / visibility.
   - Optional `<use href="#..."` resolution.
   - `<text>` flagged loudly as unsupported unless `--text-as-paths` preprocess step is used.

10. **Preview with reorder** — run reorder before computing stats so reported lifts / travel match actual plot.

11. **Progress bar rewrite** — time-based from planner duration, updated from elapsed time, not move index.

12. **Resume from fraction** — `nib job resume N` uses saved `stoppedAt` + `svg`; planner skips moves before that point.

13. **Abort path** — on SIGINT, send `ES` (emergency stop), wait for drain, then pen-up and home.

14. **`dry-run` output** — print planner summary: `N moves, M lifts, est Xm Ys, max speed Z mm/s`.

## Phase 6 — Embeddable library (transport abstraction + WebSerial)

Goal: make `nib` usable from an arbitrary Node program or a browser app over WebSerial / WebUSB, without the CLI's config-and-storage coupling.

**Three-tier shape:**

1. **Pure core** — already done. `svgToMoves`, `reorder`, `planMove`/`planStroke`, `previewStatsFromMoves`, envelope math, LM encoding. Zero I/O.
2. **Transport abstraction** — new, this phase. `EbbTransport` interface: `write / readLine / close`. Two impls ship: `NodeSerialTransport` (current stty+fs code) and `WebSerialTransport` (browser).
3. **Plot runner** — `runJob(job, transport, emitter, options)` — takes any transport, no config lookup.

CLI storage (profiles.toml, state.toml, job history) stays Node-only, out of the core.

### Phase 6a — Transport refactor (Node only, no browser yet)

1. Add `src/backends/transport.ts` with `EbbTransport` interface.
2. Extract the stty / fs.createReadStream / writeSync code from `EBBPort` into `src/backends/node-serial.ts` as `NodeSerialTransport implements EbbTransport`. Move `findEbbPort` into that file.
3. Rename `EBBPort` → `EbbCommands` in `ebb-protocol.ts`. Constructor takes `EbbTransport`; `command()` / `send()` delegate to `transport.readLine` / `transport.write`. Protocol methods (`penUp`, `lm`, `configureServo`, etc.) stay.
4. Update `EBBBackend` — accept `EbbCommands` (or a transport + construct internally). Drop the "open port from string" convenience.
5. Update all CLI call sites (`pen`, `move`, `motors`, `home`, `fw`, `release`, `calibrate`, `live`).

### Phase 6b — WebSerial transport + browser entry (done 2026-04-16)

Shipped the browser support needed to use nib from a web app over WebSerial (Chrome / Edge / Opera).

- `src/backends/web-serial.ts` — `WebSerialTransport` implements `EbbTransport` wrapping an already-opened `SerialPort`. Background read loop → line-buffered queue. `EBB_USB_FILTERS` (VID 0x04d8, PID 0xfd92/93) pre-packaged. `requestEbbPort()` one-call helper: prompts the user, opens at 115200 baud, wraps in a transport.
- `src/browser.ts` — dedicated browser entry point. Exports pure core + protocol layer + `WebSerialTransport` + browser-native `plot()` / `plotStrokes()` that take inline profile objects (no profiles.toml lookup in the browser).
- `package.json` `exports` map adds `./browser` alongside the default Node entry. Bundles via `bun run build:browser` → `dist/browser.js`, 130 KB, zero Node API references.
- Browser bundle explicitly does NOT export `runJobEbb` — that function auto-creates a `NodeSerialTransport` when no transport is given, which would pull Node's fs/child_process into the browser bundle. Browser consumers use `plot` / `plotStrokes` from `nib/browser` instead.
- Not yet hardware-validated in a real browser; needs a test page in Chrome with a physical EBB attached.

### Phase 6c — Stroke-level API (done 2026-04-16)

Shipped the code-first pipeline. Consumers can now build generative scenes from pure-function geometry primitives and plot them without going through SVG.

- `src/core/stroke.ts` — `Stroke` type, `strokesToMoves`, `movesToStrokes`, `strokeStats`.
- `src/core/geom.ts` — pure primitives: `line`, `polyline`, `polygon`, `rect` (square + rounded), `circle`, `ellipse`, `arc`, `bezier`, `quadBezier`. Transform helpers: `translate`, `scale`, `rotate`.
- `EBBBackend.runJob` split into `runJob` (SVG) → `runMoves` (flattened moves) + `runStrokes` (stroke list) → shared inner loop.
- Top-level `plotStrokes(strokes, options)` — works in Node (auto-detects port) or browser (pass a transport). Supports `onProgress` / `onStroke` callbacks, envelope bounds, layer filter, copies.
- Public surface exported from `src/index.ts`: `plotStrokes`, `Stroke`, `Point`, `strokesToMoves`, `movesToStrokes`, `strokeStats`, and `geom` namespace.
- Tests: `test/stroke.test.ts` (11), `test/geom.test.ts` (18). 158 pass total.

### Phase 6c — Stroke-level API, original plan:

Decision: code-first generative sketches are the dominant web consumer, not canvas-UI drawing apps. The library should feel natural when a script produces polylines programmatically — no SVG round-trip required.

**Canonical intermediate format: strokes.** Not SVG, not canvas ops, not raw PlannerMove[]. A flat list of polylines with optional layer + skip flags:

```typescript
interface Stroke {
  points: { x: number; y: number }[]  // absolute mm
  layer?: number
  skip?: boolean
}
```

Rationale: intent-level, minimal, works from any source (SVG → strokes, canvas → strokes, code → strokes), flattening math already lives in `svg-to-moves.ts`.

9. Extract `src/core/geom.ts` — pure functions returning `Stroke` or `Stroke[]`: `line`, `polyline`, `arc`, `circle`, `rect`, `bezier`, `polygon`. Most of the flattening logic moves from `svg-to-moves.ts` to `geom.ts` and `svg-to-moves` becomes a thin adapter.
10. Add `plotStrokes(strokes, options)` to the public API:
    ```typescript
    import { plotStrokes, geom } from 'nib'
    await plotStrokes([
      geom.polyline(myPoints),
      geom.circle({ x: 50, y: 50 }, 20),
    ], { transport, profile, optimize: 2 })
    ```
11. Add `strokesToPlannerMoves(strokes)` bridge so consumers can drop into the planner pipeline at any level.
12. Typed events on `plotStrokes`: `progress`, `stroke:start`, `stroke:complete`, `pen:up`, `pen:down`, `abort`, `complete`.

### Phase 6d — Live Plotter class (deferred, lower priority)

For canvas-UI apps and camera-in-the-loop feedback workflows. Not urgent for code-first sketches.

13. `class Plotter { beginPath(); moveTo(x,y); lineTo(x,y); flush(); ... }` — stateful, imperative, long-lived transport (`connect` once, many plots).
14. Streaming methods: `await plotter.strokeTo(point)` queues motion and returns when it completes; `plotter.drain()` to await the queue.
15. Escape hatch: `plotter.raw` exposes the underlying `EbbCommands` for direct protocol access.
16. Events on the instance — same taxonomy as plotStrokes.

**Concurrency model (locked in):** single plotter per transport. `strokeTo` / `moveTo` queue into a bounded buffer (default ~8 pending). `drain()` awaits empty. `flush()` on a beginPath accumulator commits buffered strokes with junction-velocity planning. Explicit `abort()` emergency-stops and clears the queue.

### Tradeoff decisions (locked in)

- Single package, multiple entry points (not three packages).
- WebSerial over WebUSB — better API fit, same browser coverage for practical purposes.
- Strict library: no `fs` in `nib/core` or `nib/browser`. CLI keeps all its storage helpers.
- **Strokes, not SVG or canvas, as the canonical intermediate.** SVG stays a first-class input, not a requirement.
- **Plotter is stateful and long-lived**, not per-plot. Enables live streaming without reconnection overhead.
- **Queue-based concurrency** on the Plotter — ergonomic for streaming, with explicit drain/abort for control.

## Phase 5a — SVG layer label convention (done 2026-04-16)

Matches the axicli Inkscape layer convention so SVGs exported from Inkscape with `1 outline` / `2 fills` / `!notes` labels work without an `axidraw.toml`.

- `src/core/svg-layers.ts` — `parseSvgLayers(svg)` and `parseLayerAttrs(attrs)`. Leading integer in `inkscape:label` becomes the layer number; `!` prefix marks layer as skip; falls back to id digits for unnumbered labels.
- `svgToMoves` now routes layer filtering and `!skip` through `parseLayerAttrs`, replacing the old id-digit scan.
- `nib plot --list-layers` / `nib preview --list-layers` print the discovered layers with their number, name, and SKIP flag (`--json` on preview emits the same list machine-readably).
- `nib plot --layer N` / `nib preview --layer N` match against the label-derived number first, with id fallback.
- Guided mode (`nib plot --guided`) resolves layers in this order: `axidraw.toml [[layers]]` → SVG-label layers → id-scan.

Tests: `test/svg-layers.test.ts` (12 pass). Full suite: 129.

Future (Phase 5b, not yet built): `+pause`, `+HH:MM:SS` delay, `+speed{N}`, `+pos_down{N}`, `+pos_up{N}` per-layer overrides.

## Phase 4 — Axicli removed (done 2026-04-16)

- `src/backends/axicli.ts` deleted. `test/axicli-flags.test.ts` deleted.
- `RunJobResult` / `PreviewStats` moved to `src/backends/types.ts`.
- `getSvgStats` / `SvgStats` moved to `src/backends/svg-stats.ts`.
- `--backend axicli` flag removed from `nib plot` (no opt-in escape hatch; the EBB path has fully replaced it).
- `BackendName` type narrowed to `'ebb'`.
- `src/index.ts` exports rewritten: public API surface is now EBB-native.
- 117 tests pass (was 129, -12 from the deleted axicli-flags test).

---

## Tests

Offline, in `test/`:
- `reorder.test.ts` — crafted move sequences with known-optimal orderings; assert lift count and travel bounds.
- `planner.test.ts` — long stroke reaches peak speed mid-segment; 90° corner forces vcorner.
- `ebb-preview.test.ts` — extend with reorder-integrated duration vs planner.
- `svg-robustness.test.ts` — hidden groups, nested transforms, `<use>`, styled stroke.
- `lm-math.test.ts` — rate/accel encoding vs axicli motion.py reference.

Hardware tests stay manual under `test/hardware/*.ts`.

## Sequencing

Phase 1 + 2 = minimum viable ship. Phase 1 alone is parity at painful speeds; Phase 2 is what makes people actually drop axicli. Phase 3 tightens quality; Phase 4 is cleanup.

Rough budget: Phase 1 ≈ 2–3 focused days. Phase 2 ≈ 1 day on motion math + hardware session.

---

## Reference sources — watch for parity + compatibility

Two upstream sources drive what nib needs to track. Skim them when cutting a
release or when behavior diverges from what the hardware expects.

### Axidraw Python library releases
**https://github.com/evil-mad/axidraw/releases**

The canonical implementation of the AxiDraw motion stack (SVG parsing, path
optimization, LM motion planning, pen control). Watch release notes for:
- Changes to `motion.py` — LM math, trapezoid shape, junction handling. A
  behavior change here is the best signal our planner needs a revisit.
- Changes to `axidraw_conf.py` — defaults (servo_min / servo_max, speeds,
  accel). If the canonical defaults drift, our constants should track them.
- New high-level features (plot modes, reordering strategies) — candidates to
  port into nib if they meet a real need.
- Deprecated / removed commands — signals to remove from our support list.

Local clone path: memory note `reference_axidraw_codebase.md`. Re-clone for
a fresh release when diffing.

### EBB firmware command reference
**https://evil-mad.github.io/EggBot/ebb.html**

The authoritative spec for EBB commands (SM, LM, SP, SC, S2, QS, QM, HM, ES,
EM, V, R…). Watch for:
- New firmware versions adding commands — we've seen LM land in 2.7, HM in
  2.6.2, QS in 2.4.3. Future commands may unlock features worth adopting
  (e.g. faster motion primitives, richer queries).
- Documented rate/accel register encoding — our `lmRateReg`/`lmAccelReg` are
  derived from the LM section of this doc; a spec change means re-derivation.
- SP/SC behavior clarifications — Jeff's hardware on firmware 2.8.1 has
  SP,0/SP,1 no-op on repeated-state transitions (we bypass with S2). A docs
  update might change whether our workaround is still required.
- Firmware-version feature gates — update `LM_MIN_FIRMWARE` and add new
  version constants when new commands land.

**Triggers to pull both:** before a release, when something misbehaves in
ways that look motion-math-related, or quarterly as a routine check.

## Future considerations

### Reference-diff against the Python axidraw library

When to pick this up: *only* if Phase 5+ work touches motion math (LM speedups, new corner-smoothing scheme), or if a hardware anomaly looks like a step-math off-by-one. Right now plots land cleanly; ROI is low.

What would go in a harness (build on demand):
- Clone `github.com/evil-mad/axidraw` locally (memory: `reference_axidraw_codebase.md`).
- Generate 4–5 canonical segments: long straight, 90° corner, flattened bezier arc, 180° reversal, zero-length move.
- Run each through our `planStroke` / `planMove` and capture the emitted `(rate1Reg, steps1, accel1Reg, rate2Reg, steps2, accel2Reg)` tuples.
- Run axicli `--preview --report_time` with the same input SVGs and parse the motion output for its corresponding rate/step/accel values.
- `diff` the two. Within rounding on canonical cases = good. Large divergence = bug in one of:
  - LM rate/accel register encoding (nib `lmRateReg` / `lmAccelReg`)
  - CoreXY sign convention (`steps1 = (dX + dY)·80`)
  - Trapezoid geometry (`planTrapezoid`)
  - Junction velocity formula (Marlin deviation vs axicli's cornering-angle cap)

Don't wire axicli in as a runtime comparator — that would reverse Phase 4. Use it as an external reference only.

Canonical axidraw files to study if math looks off:
- `axidraw/motion.py` — step math, LM generation, trapezoid planner, junction handling
- `axidraw/axidraw_conf.py` — default constants (servo, step rates)
- `axidraw/pyaxidraw/` — higher-level API wrapper

### Other deferred items

- `<use href="#...">` resolution in `svg-to-moves.ts` (needs one-level symbol-reference traversal).
- `<text>` → paths conversion for plots with label text; currently text elements are silently ignored.
- Time-based progress bar driven by planner duration (currently fraction of move count).
- `tabtab`-style shell completions (citty doesn't auto-generate them).
