/**
 * EBBBackend — native AxiDraw control via EiBotBoard serial protocol
 *
 * Drops the Python/axicli dependency. Talks directly to the EBB firmware
 * over USB serial. SVG paths are parsed and flattened in-process.
 *
 * Requires `serialport` to be installed (already a project dependency).
 *
 * Phase 4 — see design spec §Backend.
 */

import type { PlotBackend } from './interface.ts'
import type { Job, ResolvedProfile } from '../core/job.ts'
import type { PlotEmitter } from '../core/events.ts'
import type { RunJobResult } from './types.ts'
import type { JobMetrics } from '../core/job.ts'
import {
  EbbCommands,
  SPEED_PENDOWN_MAX_MMS, SPEED_PENUP_MAX_MMS,
  LM_MIN_FIRMWARE, firmwareAtLeast,
} from './ebb-protocol.ts'
import type { EbbTransport } from './transport.ts'
import { svgToMoves, type PlannerMove } from './svg-to-moves.ts'
import { strokesToMoves, simplifyMoves, type Stroke } from '../core/stroke.ts'
import { reorder, type OptimizeLevel } from '../core/reorder.ts'
import { planMove, planStroke, optionsForProfile } from '../core/planner.ts'
import { isInEnvelope, type Envelope } from '../core/envelope.ts'

// ─── EBBBackend ───────────────────────────────────────────────────────────────

export class EBBBackend implements PlotBackend {
  private ebb: EbbCommands
  private currentX = 0
  private currentY = 0
  private penIsDown = false
  private useLm = false

  constructor(transport: EbbTransport) {
    this.ebb = new EbbCommands(transport)
  }

  // ── PlotBackend interface ─────────────────────────────────────────────────

  /**
   * Initialize the already-connected transport for plotting:
   * probe firmware version, home pen up, enable motors at 1/16 microstep.
   */
  async connect(_port: string = ''): Promise<void> {
    // Firmware-capability gate for LM (trapezoid accel).
    try {
      const fw = await this.ebb.firmwareVersion()
      this.useLm = firmwareAtLeast(fw, LM_MIN_FIRMWARE)
    } catch {
      this.useLm = false
    }

    // Enable motors now; DO NOT penUp yet. At connect-time we have no profile,
    // so we can't fire the S2 servo-position safety net — a lone SP,0 against
    // the firmware's stale SC,4 value risks leaving the pen on the paper for
    // the ~500ms until runMoves.penUp finally lifts it. That interval shows
    // as an ink dot at (0,0). Deferring all servo control to runMoves (where
    // configureServo runs BEFORE penUp) eliminates the undefined pen-state
    // window entirely.
    await this.ebb.enableMotors(1, 1)  // 1/16 microstepping (EM=1, not 5)
  }

  async moveTo(x: number, y: number, speed: number): Promise<void> {
    const speedMms = percentToMms(speed, this.penIsDown)
    const dx = x - this.currentX
    const dy = y - this.currentY
    await this.ebb.move(dx, dy, speedMms)
    this.currentX = x
    this.currentY = y
  }

  async penUp(height: number, _rate: number): Promise<void> {
    await this.ebb.configureServo(height, height)
    await this.ebb.penUp()
    this.penIsDown = false
  }

  async penDown(height: number, _rate: number): Promise<void> {
    await this.ebb.configureServo(height, height)
    await this.ebb.penDown()
    this.penIsDown = true
  }

  async home(): Promise<void> {
    if (this.penIsDown) {
      await this.ebb.penUp()
      this.penIsDown = false
    }

    process.stderr.write(`  [home] returning (${this.currentX.toFixed(1)}, ${this.currentY.toFixed(1)}) → (0, 0)\n`)

    if (Math.abs(this.currentX) < 0.001 && Math.abs(this.currentY) < 0.001) {
      process.stderr.write(`  [home] already at origin\n`)
      return
    }

    // Software position tracking: move the inverse of the accumulated displacement.
    // HM returns to mechanical home (hardwired firmware position), not QS=0.
    // Use SM for home regardless of LM availability — it's a fail-safe return
    // that doesn't need the extra speed and avoids depending on any profile.
    await this.ebb.move(-this.currentX, -this.currentY, SPEED_PENUP_MAX_MMS)
    this.currentX = 0
    this.currentY = 0
  }

  /**
   * Execute a single cartesian move as a trapezoid of 1–3 LM commands.
   * Rest-to-rest (vEntry = vExit = 0) for Phase 2a; junction-velocity pipelining
   * comes in Phase 2b.
   */
  private async lmSingleMove(
    dXmm: number, dYmm: number,
    profile: ResolvedProfile, penDown: boolean,
  ): Promise<void> {
    const opts = optionsForProfile(profile, penDown)
    const plan = planMove(dXmm, dYmm, 0, 0, opts)
    // Queue ALL phases into the EBB FIFO back-to-back. The firmware runs them
    // as a continuous trapezoid — inserting a sleep between phases would let
    // the motor stall between accel/cruise/decel and lose steps.
    for (const phase of plan.phases) {
      await this.ebb.lm(
        phase.rate1Reg, phase.steps1, phase.accel1Reg,
        phase.rate2Reg, phase.steps2, phase.accel2Reg,
      )
    }
    // Now wait for the whole move to complete. +20ms fudge so the motor is
    // fully at rest before the next move (or a pen state change) fires.
    if (plan.durationS > 0) {
      await sleep(Math.round(plan.durationS * 1000) + 20)
    }
  }

  /**
   * Execute a pen-down stroke with junction-velocity planning. Queues every
   * LM phase for every move back-to-back so the firmware runs the whole
   * stroke as one continuous motion — no stops at internal corners.
   * Sleeps once at the end for the total stroke duration.
   */
  private async runStroke(
    strokePoints: { x: number; y: number }[],
    profile: ResolvedProfile,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const opts = optionsForProfile(profile, true)
    const planned = planStroke(strokePoints, opts)
    let totalDurationS = 0
    for (const move of planned) {
      for (const phase of move.phases) {
        if (signal?.aborted) return false
        await this.ebb.lm(
          phase.rate1Reg, phase.steps1, phase.accel1Reg,
          phase.rate2Reg, phase.steps2, phase.accel2Reg,
        )
      }
      totalDurationS += move.durationS
    }
    // Wait for motion to complete by polling QM, not a fixed sleep. A fixed
    // sleep either over-waits (pen sits on paper pooling ink at stroke end)
    // or under-waits (next pen-up fires while motor still moving). Polling
    // QM lifts the pen within ~20 ms of actual motor idle, regardless of
    // whether the planner's predicted duration matched wall-clock reality.
    //
    // totalDurationS + 2s is a safety upper bound — gives up if the motor
    // never reports idle within a reasonable window (e.g. if the firmware is
    // wedged), rather than hanging forever.
    const idleDeadline = Date.now() + Math.round(totalDurationS * 1000) + 2000
    while (Date.now() < idleDeadline) {
      if (signal?.aborted) return false
      try {
        const { moving } = await this.ebb.queryMotors()
        if (!moving) break
      } catch { /* transient — keep polling */ }
      await sleep(20)
    }
    const last = strokePoints[strokePoints.length - 1]
    this.currentX = last.x
    this.currentY = last.y
    return true
  }

  /**
   * Stop motors immediately, lift pen, and return home. Shared abort path used
   * by SIGINT and envelope violations.
   *
   * Sends `ES` (emergency stop) FIRST so the EBB drops any LM/SM commands
   * still in the FIFO and halts motion now, rather than making us wait ~seconds
   * for queued moves to drain before we can react. After ES, we'd lose sync
   * with the firmware's step counter — but nib's position tracking is
   * software-side, so this doesn't matter here.
   */
  private async safeAbort(
    emitter: PlotEmitter,
    moveIdx: number, totalMoves: number,
    copy: number, copies: number,
    reason: string,
  ): Promise<void> {
    await this.ebb.emergencyStop().catch(() => undefined)
    await sleep(100)  // let the firmware process ES and settle
    if (this.penIsDown) {
      await this.ebb.penUp().catch(() => undefined)
      this.penIsDown = false
    }
    await this.home().catch(() => undefined)
    const fraction = (copy + moveIdx / totalMoves) / copies
    process.stderr.write(`\n  ${reason}\n`)
    emitter.emit('abort', fraction)
  }

  /** Poll QM until motors are idle (FIFO drained). Gives up after 30s. */
  private async waitForMotorsIdle(): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const { moving } = await this.ebb.queryMotors()
      if (!moving) return
      await sleep(20)
    }
  }

  /**
   * Clean up pen + motor state without closing the transport. Use this when
   * the transport is owned by the caller (e.g. a long-lived WebSerial port
   * that will host multiple jobs).
   */
  async shutdown(): Promise<void> {
    await this.ebb.forceServoUp().catch(() => undefined)
    await sleep(300)
    this.penIsDown = false
    await this.ebb.disableMotors().catch(() => undefined)
  }

  /** Shutdown and close the underlying transport. */
  async disconnect(): Promise<void> {
    await this.shutdown()
    await this.ebb.close()
  }

  // ── High-level job execution ───────────────────────────────────────────────

  /**
   * Execute a full plot job via native EBB serial.
   * Replaces axicli.runJob for the native backend path.
   */
  async runJob(
    job: Job,
    emitter: PlotEmitter,
    signal?: AbortSignal,
    options: RunJobOptions = {},
  ): Promise<RunJobResult> {
    const rawMoves = svgToMoves(job.svg, { tolerance: 0.1, layer: options.layer })
    const result = await this.runMoves(job.profile, rawMoves, emitter, signal, {
      ...options,
      optimize: (job.optimize ?? 0) as OptimizeLevel,
      copies: job.copies ?? 1,
    })
    if (result.metrics) {
      job.metrics.pendownM += result.metrics.pendownM
      job.metrics.travelM  += result.metrics.travelM
      job.metrics.penLifts += result.metrics.penLifts
    }
    return result
  }

  /**
   * Run a plot from a list of stroke polylines — the code-first path. Converts
   * to planner moves internally then delegates to runMoves.
   */
  async runStrokes(
    profile: ResolvedProfile,
    strokes: Stroke[],
    emitter: PlotEmitter,
    signal?: AbortSignal,
    options: RunJobOptions & { optimize?: OptimizeLevel; copies?: number } = {},
  ): Promise<RunJobResult> {
    const moves = strokesToMoves(strokes, { layer: options.layer })
    return this.runMoves(profile, moves, emitter, signal, options)
  }

  /**
   * Run a plot from an already-flattened move sequence. This is the common
   * inner engine used by runJob (after SVG parsing) and runStrokes (after
   * stroke-to-move conversion). Callers pass raw moves; this method handles
   * reorder, servo config, the main loop, and end-of-copy cleanup.
   */
  async runMoves(
    profile: ResolvedProfile,
    rawMoves: PlannerMove[],
    emitter: PlotEmitter,
    signal?: AbortSignal,
    options: RunJobOptions & { optimize?: OptimizeLevel; copies?: number } = {},
  ): Promise<RunJobResult> {
    const startFrom = clamp01(options.startFrom ?? 0)
    const copies = Math.max(1, options.copies ?? 1)
    const pageDelayMs = Math.max(0, (options.pageDelayS ?? 0) * 1000)
    const envelope = options.envelope ?? null
    const marginMm = options.marginMm ?? 0

    await this.ebb.configureServo(profile.penPosUp, profile.penPosDown)
    await this.ebb.setServoTimeout(profile.servoIdleMs ?? 60_000)
    await this.ebb.penUp()
    this.penIsDown = false

    if (rawMoves.length === 0) {
      return { stoppedAt: 1, aborted: false }
    }
    // Simplify first (fewer points per stroke) → reorder (fewer strokes to
    // compare) → plan. Simplify before reorder because reorder treats each
    // stroke as an atomic unit; reducing internal points doesn't change its
    // endpoints. Order is preserved.
    const simplifyMm = options.simplifyMm ?? 0
    const simplified = simplifyMm > 0 ? simplifyMoves(rawMoves, simplifyMm) : rawMoves
    const { moves } = reorder(simplified, options.optimize ?? 0)

    const speedDown = percentToMms(profile.speedPendown, true)
    const speedUp   = percentToMms(profile.speedPenup, false)

    // Start index from fractional resume (rounded to nearest pen-up boundary so
    // we don't drop pen mid-stroke).
    const firstIdx = resumeIndex(moves, startFrom)

    let pendownM = 0
    let travelM  = 0
    let penLifts = 0

    for (let copy = 0; copy < copies; copy++) {
      if (copy > 0 && pageDelayMs > 0) await sleep(pageDelayMs)

      let i = copy === 0 ? firstIdx : 0
      while (i < moves.length) {
        if (signal?.aborted) {
          await this.safeAbort(emitter, i, moves.length, copy, copies, 'aborted')
          return { stoppedAt: (copy + i / moves.length) / copies, aborted: true }
        }

        const move = moves[i]

        // Pen-up travel: single move, rest-to-rest. Just navigate to the next
        // position and advance the index.
        if (!move.penDown) {
          if (!isInEnvelope(move.x, move.y, envelope, marginMm)) {
            await this.safeAbort(emitter, i, moves.length, copy, copies,
              `envelope violation: travel target (${move.x.toFixed(1)}, ${move.y.toFixed(1)}) is outside machine bounds`)
            return { stoppedAt: (copy + i / moves.length) / copies, aborted: true }
          }
          if (this.penIsDown) {
            // Fast lift: pen continues rising to full up while we travel.
            // Saves ~140 ms per stroke transition vs waiting for full settle.
            await this.ebb.penUpFast()
            this.penIsDown = false
            emitter.emit('pen:up')
          }
          const dx = move.x - this.currentX
          const dy = move.y - this.currentY
          const dist = Math.hypot(dx, dy)
          if (dist > 0.001) {
            if (this.useLm) await this.lmSingleMove(dx, dy, profile, false)
            else            await this.ebb.move(dx, dy, speedUp)
            this.currentX = move.x
            this.currentY = move.y
            travelM += dist / 1000
          }
          i++
          continue
        }

        // Pen-down stroke: gather all consecutive pen-down moves as one stroke
        // and plan them together with junction velocities so we don't stop
        // at internal corners.
        const strokeStart = { x: this.currentX, y: this.currentY }
        const strokePoints: { x: number; y: number }[] = [strokeStart]
        const strokeStartIdx = i
        while (i < moves.length && moves[i].penDown) {
          strokePoints.push({ x: moves[i].x, y: moves[i].y })
          i++
        }

        if (strokePoints.length < 2) continue

        // Runtime envelope check — catches live mode, where the pre-flight
        // static check didn't see these moves.
        if (envelope) {
          for (const p of strokePoints) {
            if (!isInEnvelope(p.x, p.y, envelope)) {
              await this.safeAbort(emitter, strokeStartIdx, moves.length, copy, copies,
                `envelope violation: stroke point (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) is outside machine bounds`)
              return { stoppedAt: (copy + strokeStartIdx / moves.length) / copies, aborted: true }
            }
          }
        }

        if (!this.penIsDown) {
          await this.ebb.penDown()
          this.penIsDown = true
          penLifts++
          emitter.emit('pen:down')
        }

        if (this.useLm) {
          const completed = await this.runStroke(strokePoints, profile, signal)
          if (!completed) {
            await this.safeAbort(emitter, strokeStartIdx, moves.length, copy, copies, 'aborted')
            return { stoppedAt: (copy + strokeStartIdx / moves.length) / copies, aborted: true }
          }
        } else {
          // SM fallback: per-move constant-speed. Loses junction-velocity benefits.
          for (let k = 1; k < strokePoints.length; k++) {
            const dx = strokePoints[k].x - this.currentX
            const dy = strokePoints[k].y - this.currentY
            if (Math.hypot(dx, dy) > 0.001) {
              await this.ebb.move(dx, dy, speedDown)
              this.currentX = strokePoints[k].x
              this.currentY = strokePoints[k].y
            }
          }
        }

        // Track accumulated pen-down distance
        for (let k = 1; k < strokePoints.length; k++) {
          pendownM += Math.hypot(
            strokePoints[k].x - strokePoints[k - 1].x,
            strokePoints[k].y - strokePoints[k - 1].y,
          ) / 1000
        }

        // Progress: emit every stroke boundary (at most ~N progress events per plot)
        emitter.emit('progress', (copy + i / moves.length) / copies, 0)
        void strokeStartIdx
      }

      // Force pen up via S2 — SP,0 can be silently no-op'd by firmware if it
      // thinks the pen is already up, even when it's physically down. S2
      // drives the servo directly to the configured pen-up raw value.
      await this.ebb.forceServoUp()
      await sleep(300)
      // Also update firmware pen-state so later SP commands in this session
      // behave correctly.
      await this.ebb.penUp().catch(() => undefined)
      this.penIsDown = false
      await this.home()
    }

    const metrics = { pendownM, travelM, penLifts }
    emitter.emit('complete', { ...metrics, durationS: 0 } as JobMetrics)
    return { stoppedAt: 1, aborted: false, metrics }
  }
}

// ─── Standalone job runner ────────────────────────────────────────────────────

export interface RunJobOptions {
  /** Only plot this Inkscape layer (numeric ID) */
  layer?: number
  /** Fractional resume point (0–1). Rounded down to nearest pen-up boundary. */
  startFrom?: number
  /** Delay between copies in seconds (for multi-copy jobs) */
  pageDelayS?: number
  /** Machine envelope — target positions outside this rectangle abort the job. */
  envelope?: Envelope
  /** Safety inset from the envelope (mm, all sides). Default 0. */
  marginMm?: number
  /**
   * Polyline simplification tolerance in mm. Applied before reorder and
   * planning. 0 disables. 0.1–0.3 typical for over-sampled SVGs.
   */
  simplifyMm?: number
}

export interface EbbPlotOptions extends RunJobOptions {
  /** Node-only: path like /dev/cu.usbmodem14101. Ignored when `transport` is given. */
  port?: string
  /**
   * Pre-opened transport to use. If omitted (Node only), the function will
   * construct a NodeSerialTransport from `port` or auto-detect.
   */
  transport?: EbbTransport
}

/**
 * Connect to an EBB device, execute a job, then disconnect.
 *
 * For Node consumers: pass `port` (or leave unset for auto-detect) and this
 * function will open a NodeSerialTransport for you.
 *
 * For browser / custom-transport consumers: pass `transport` directly (the
 * function will NOT close a user-provided transport at the end; the caller
 * owns its lifecycle).
 */
export async function runJobEbb(
  job: Job,
  emitter: PlotEmitter,
  options: EbbPlotOptions = {},
  signal?: AbortSignal,
): Promise<RunJobResult> {
  let transport: EbbTransport
  let ownsTransport: boolean
  if (options.transport) {
    transport = options.transport
    ownsTransport = false
  } else {
    // Node-only path — lazy-imported so the browser entry point doesn't pull
    // in fs/stty code.
    const { NodeSerialTransport } = await import('./node-serial.ts')
    const port = options.port ?? (typeof process !== 'undefined' ? process.env.NIB_PORT : undefined) ?? undefined
    transport = await NodeSerialTransport.connect(port)
    ownsTransport = true
  }

  const backend = new EBBBackend(transport)
  await backend.connect()
  try {
    return await backend.runJob(job, emitter, signal, {
      layer: options.layer,
      startFrom: options.startFrom,
      pageDelayS: options.pageDelayS,
      envelope: options.envelope,
      marginMm: options.marginMm,
      simplifyMm: options.simplifyMm,
    })
  } finally {
    if (ownsTransport) {
      await backend.disconnect()
    } else {
      // User-owned transport — just clean up motors/pen, leave the port open.
      await backend.shutdown()
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function percentToMms(percent: number, isPenDown: boolean): number {
  const maxMms = isPenDown ? SPEED_PENDOWN_MAX_MMS : SPEED_PENUP_MAX_MMS
  return Math.max(0.5, (percent / 100) * maxMms)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/**
 * Find the move index to resume from, rounded to the nearest pen-up boundary
 * so we never drop pen mid-stroke.
 */
function resumeIndex(moves: { penDown: boolean }[], fraction: number): number {
  if (fraction <= 0) return 0
  if (fraction >= 1) return moves.length
  const raw = Math.floor(fraction * moves.length)
  // Walk backward to the last pen-up so resume starts at a stroke boundary.
  for (let i = Math.min(raw, moves.length - 1); i > 0; i--) {
    if (!moves[i].penDown) return i
  }
  return 0
}
