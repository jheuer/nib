# EBB-Only Plotting Plan

Goal: `nib` offers a high-quality CLI experience for plotting SVGs over USB serial to an EBB-driven AxiDraw, with **no axicli/Python dependency**.

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

## Phase 4 — Remove axicli

15. Delete `src/backends/axicli.ts`, `test/axicli-flags.test.ts`; remove from `src/index.ts` exports.
16. Update README to drop `pip install axicli`.
17. Keep `AxicliBackend` only as optional escape hatch, if at all.

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
