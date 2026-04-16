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

### Phase 2b — Junction velocities (next)

5. **Motion planner** `src/core/planner.ts`
   - Forward-backward pass over the stroke-level move list.
   - Input: junction angle (between successive pen-down segments) + profile accel → `vJunction`.
   - Output: each move gets a non-zero `vEntry`/`vExit` where safe, eliminating full stop-start between connected strokes.

6. **Preview parity** — feed the junction-aware planner's durations into `previewStatsFromMoves` so ETA matches wall-clock within ~5%.

### Phase 2c — FIFO batching

7. Push 4–8 LM commands into the EBB FIFO; poll `QM` to keep it topped up instead of `sleep(durationMs)`-between-phases.

## Phase 3 — SVG robustness & CLI polish

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
