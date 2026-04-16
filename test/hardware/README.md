# Hardware Tests

These tests require a live AxiDraw connected via USB. They are **skipped automatically**
when `NIB_PORT` is not set, so they never run in CI.

## Running

```bash
# Auto-discover the port (looks for EBB USB VID/PID):
NIB_PORT=auto bun test test/hardware

# Specify the port explicitly:
NIB_PORT=/dev/tty.usbmodem14101 bun test test/hardware

# EBB protocol tests only (faster — skips CLI binary tests):
NIB_PORT=/dev/tty.usbmodem14101 bun test test/hardware/ebb.test.ts

# Actual plot (requires paper loaded + NIB_DRAW=1):
NIB_PORT=auto NIB_DRAW=1 bun test test/hardware/plot.test.ts
```

> **Note**: All EBBPort tests live in `ebb.test.ts` (a single file) so they share one
> serial connection and run sequentially. Bun runs test files in parallel workers —
> splitting hardware tests across multiple files would cause port conflicts.

## Test layers

| File | Motion? | What it verifies |
|---|---|---|
| `ebb.test.ts` | XY + pen | Port open, firmware version, servo up/down, motor enable, XY moves |
| `plot.test.ts` | Full plot | End-to-end `nib plot` via CLI binary (drawing gated behind `NIB_DRAW=1`) |

## `ebb.test.ts` describes

| Describe | Commands used |
|---|---|
| EBB connection | V, QM |
| EBB auto-discovery | findEbbPort() — only when `NIB_PORT=auto` |
| pen servo | SP (pen down/up) |
| motor enable/disable | EM |
| XY motion | EM, SP, SM, QM — **moves the carriage ~14mm** |

XY motion tests require ~20×20mm of clear space from the current carriage position.
The AxiDraw has no endstop sensors — if the carriage is against a rail, the EBB will still
acknowledge the SM command ("OK") but the arm stalls silently. Manually jog the carriage to
roughly the center of the travel area before running.

## Calibration fixture (`test/fixtures/hw-calibration/input.svg`)

A 15×15mm target used by `plot.test.ts`: outer rect, center cross, corner tick marks.

**What to look for after plotting:**
- **Box closure**: start and end points meet cleanly — tests homing accuracy
- **Cross center**: arms intersect at the true center of the box
- **Corner ticks**: each 2mm tick is parallel to the box edges — tests orthogonality
- **Stroke consistency**: uniform line weight — tests speed/acceleration settings
