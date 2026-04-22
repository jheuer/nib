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
  ACCEL_MAX_MMS2,
  firmwareCapabilities, type EbbCapabilities,
} from './ebb-protocol.ts'
import type { EbbTransport } from './transport.ts'
import { svgToMoves, type PlannerMove } from './svg-to-moves.ts'
import { strokesToMoves, simplifyMoves, rotateMoves, translateMoves, type Stroke } from '../core/stroke.ts'
import { reorder, type OptimizeLevel } from '../core/reorder.ts'
import { planMove, planStroke, optionsForProfile } from '../core/planner.ts'
import { isInEnvelope, type Envelope } from '../core/envelope.ts'

// How long penUpFast() waits before returning (ms). Used to compute how much
// additional settle time is needed before short pen-up travels.
const PEN_UP_FAST_MS = 80

// Safe stderr write — process.stderr is unavailable in browser bundles.
const stderrWrite = (msg: string) =>
  typeof process !== 'undefined' && typeof process.stderr?.write === 'function'
    ? process.stderr.write(msg)
    : undefined

// ─── EBBBackend ───────────────────────────────────────────────────────────────

export class EBBBackend implements PlotBackend {
  private ebb: EbbCommands
  private currentX = 0
  private currentY = 0
  private penIsDown = false
  private useLm = false
  private penReadyForFirstStroke = false
  /** Firmware capability flags, populated by `connect()`. Defaults to "nothing
   *  available" so methods that call into guarded features fail cleanly if
   *  they're (incorrectly) called before connect. */
  public caps: EbbCapabilities = {
    firmware: [0, 0, 0], lm: false, qm: false, es: false,
    hm: false, qs: false, tag: false, tagUsbVisible: false,
  }

  constructor(transport: EbbTransport) {
    this.ebb = new EbbCommands(transport)
  }

  // ── PlotBackend interface ─────────────────────────────────────────────────

  /**
   * Initialize the already-connected transport for plotting:
   * probe firmware version, home pen up, enable motors at 1/16 microstep.
   */
  async connect(_port: string = ''): Promise<void> {
    // Query firmware + derive per-feature capability flags. Callers can
    // inspect `backend.caps` before issuing commands that need newer firmware.
    try {
      const fw = await this.ebb.firmwareVersion()
      this.caps = firmwareCapabilities(fw)
    } catch {
      // Leave caps at the pessimistic defaults.
    }
    this.useLm = this.caps.lm

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

    stderrWrite(`  [home] returning (${this.currentX.toFixed(1)}, ${this.currentY.toFixed(1)}) → (0, 0)\n`)

    if (Math.abs(this.currentX) < 0.001 && Math.abs(this.currentY) < 0.001) {
      stderrWrite(`  [home] already at origin\n`)
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
    signal?: AbortSignal,
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
    // Wait for the whole move to complete. Use an abortable sleep so Ctrl-C
    // during a long pen-up traversal is noticed immediately rather than after
    // the full move duration.
    if (plan.durationS > 0) {
      await sleepAbortable(Math.round(plan.durationS * 1000) + 20, signal)
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
    // Wait for motion to complete. Prefer QM (poll firmware for idle) when
    // available; fall back to a fixed sleep for firmware < 2.4.4 which
    // predates the QM command.
    if (this.caps.qm) {
      const idleDeadline = Date.now() + Math.round(totalDurationS * 1000) + 2000
      while (Date.now() < idleDeadline) {
        if (signal?.aborted) return false
        try {
          const { moving } = await this.ebb.queryMotors()
          if (!moving) break
        } catch { /* transient — keep polling */ }
        await sleep(20)
      }
    } else {
      // No QM — sleep for the planned duration plus a small settle margin.
      // Less precise (we can't detect an early stall) but always correct
      // on working hardware.
      if (signal?.aborted) return false
      await sleepAbortable(Math.round(totalDurationS * 1000) + 80, signal)
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
    { returnHome = true }: { returnHome?: boolean } = {},
  ): Promise<void> {
    // ES (emergency stop) needs firmware ≥ 2.2.7. On older boards we can
    // only drop any pending sleep and let the remaining FIFO drain — the
    // pause will be slower but still land cleanly.
    if (this.caps.es) {
      await this.ebb.emergencyStop().catch(() => undefined)
      await sleep(100)  // let the firmware process ES and settle
    }
    if (this.penIsDown) {
      await this.ebb.penUp().catch(() => undefined)
      this.penIsDown = false
    }
    // On user-initiated pause we skip home so the resume/abort prompt appears
    // immediately. The arm stays wherever it stopped; caller must home it
    // (e.g. via HM) before resuming, since software position is now stale.
    if (returnHome) {
      await this.home().catch(() => undefined)
    }
    const fraction = (copy + moveIdx / totalMoves) / copies
    stderrWrite(`\n  ${reason}\n`)
    emitter.emit('abort', fraction)
  }

  /**
   * Firmware-native home via HM. Use after a pause/ES when software position
   * is stale — HM uses the firmware's internal step counter (the origin set
   * when motors were enabled), so it returns to the physical origin regardless
   * of whether currentX/Y agrees.
   */
  async homeMachine(): Promise<void> {
    if (!this.caps.hm) {
      throw new Error(
        `HM requires EBB firmware ≥ 2.6.2 (board reports ${this.caps.firmware.join('.')}). ` +
        `Update firmware or perform a manual home.`,
      )
    }
    if (this.penIsDown) {
      await this.ebb.penUp().catch(() => undefined)
      this.penIsDown = false
    }
    await this.ebb.homeMove()
    this.currentX = 0
    this.currentY = 0
  }

  /**
   * Configure the pen servo + idle timeout and park the pen up. Call once
   * at the start of a live session so subsequent `plotLiveStroke` calls can
   * skip re-configuring per stroke.
   */
  async configureSession(profile: ResolvedProfile): Promise<void> {
    // SC only — no SP/S2 commands. The servo does not move during connect.
    // The first plotLiveStroke call will issue penUp before any travel,
    // guaranteeing the pen is physically up before the arm moves.
    await this.ebb.configureServo(profile.penPosUp, profile.penPosDown)
    await this.ebb.setServoTimeout(profile.servoIdleMs ?? 60_000)
    this.penIsDown = false
    this.penReadyForFirstStroke = false
  }

  /**
   * Plot a single stroke immediately — pen-up travel to its start, pen down,
   * run the points, pen up again. Does not home or reorder or simplify. Use
   * this for live/interactive workflows where the next stroke isn't known in
   * advance. Caller must first `connect()` + `configureSession(profile)`.
   */
  async plotLiveStroke(
    profile: ResolvedProfile,
    points: { x: number; y: number }[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (points.length < 2) return

    // First stroke of the session: physically lift the pen before any travel.
    // configureSession deliberately skips SP commands so connect is silent;
    // we do it here instead, right before the arm first needs to move.
    if (!this.penReadyForFirstStroke) {
      this.penReadyForFirstStroke = true
      await this.ebb.penUp()
      this.penIsDown = false
    }

    // Pen-up travel to the stroke's start point.
    const start = points[0]
    const dx = start.x - this.currentX
    const dy = start.y - this.currentY
    if (Math.hypot(dx, dy) > 0.001) {
      if (this.penIsDown) {
        await this.ebb.penUpFast()
        this.penIsDown = false
      }
      if (this.useLm) {
        await this.lmSingleMove(dx, dy, profile, false, signal)
      } else {
        await this.ebb.move(dx, dy, percentToMms(profile.speedPenup, false))
      }
      this.currentX = start.x
      this.currentY = start.y
    }

    // Pen down + run the stroke.
    if (!this.penIsDown) {
      await this.ebb.penDown()
      this.penIsDown = true
    }
    if (this.useLm) {
      await this.runStroke(points, profile, signal)
    } else {
      const speedDown = percentToMms(profile.speedPendown, true)
      for (let k = 1; k < points.length; k++) {
        const d = { x: points[k].x - this.currentX, y: points[k].y - this.currentY }
        if (Math.hypot(d.x, d.y) > 0.001) {
          await this.ebb.move(d.x, d.y, speedDown)
          this.currentX = points[k].x
          this.currentY = points[k].y
        }
      }
    }

    // Lift at the end so the user can see the finished stroke cleanly.
    await this.ebb.penUpFast().catch(() => undefined)
    this.penIsDown = false
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
   * Current tracked arm position in mm from origin (software-tracked via moves).
   * Resets to (0, 0) when motors are re-enabled via reenableMotors().
   */
  get currentPosition(): { x: number; y: number } {
    return { x: this.currentX, y: this.currentY }
  }

  /** Disable both stepper motors so the user can reposition the arm by hand. */
  async releaseMotors(): Promise<void> {
    await this.ebb.disableMotors()
  }

  /**
   * Re-enable motors at the current physical position, treating it as the new
   * origin. Resets currentX/Y to 0 so subsequent home() returns here.
   */
  async reenableMotors(): Promise<void> {
    await this.ebb.enableMotors(1, 1)
    this.currentX = 0
    this.currentY = 0
    this.penReadyForFirstStroke = false
  }

  /** Lift pen if it is currently down. No-op if already up. */
  async liftPen(): Promise<void> {
    if (this.penIsDown) {
      await this.ebb.penUpFast()
      this.penIsDown = false
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
    // Pipeline: rotate → simplify → reorder → plan. Rotate first so
    // orientation doesn't affect subsequent geometry decisions. Simplify
    // before reorder because reorder treats each stroke as atomic;
    // reducing internal points doesn't change endpoints.
    const rotated = options.rotateDeg ? rotateMoves(rawMoves, options.rotateDeg) : rawMoves
    const translated = options.translateMm
      ? translateMoves(rotated, options.translateMm.x, options.translateMm.y)
      : rotated
    const simplifyMm = options.simplifyMm ?? 0
    const simplified = simplifyMm > 0 ? simplifyMoves(translated, simplifyMm) : translated
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
          await this.safeAbort(emitter, i, moves.length, copy, copies, 'paused', { returnHome: false })
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
            await this.ebb.penUpFast()
            this.penIsDown = false
            emitter.emit('pen:up')
          }
          const dx = move.x - this.currentX
          const dy = move.y - this.currentY
          const dist = Math.hypot(dx, dy)
          if (dist > 0.001) {
            // penUpFast already waited PEN_UP_FAST_MS. If the travel is so short
            // that the servo won't finish rising before we arrive, wait out the
            // remainder now — before moving. For typical plots the travel time
            // exceeds the remaining settle so this adds zero latency.
            //
            // Lower-bound on travel time: the triangle (no speed-cap) profile
            // is always the fastest possible, so it gives a conservative estimate
            // that never over-counts travel coverage of the settle window.
            const fullSettleMs = profile.penUpSettleMs ?? 150
            const accelMms2 = profile.accelCapMms2 ?? ACCEL_MAX_MMS2
            const travelLowerBoundMs = 2 * Math.sqrt(dist / accelMms2) * 1000
            const extraSettleMs = Math.max(0, fullSettleMs - PEN_UP_FAST_MS - travelLowerBoundMs)
            if (extraSettleMs > 0) await sleep(extraSettleMs)

            if (this.useLm) await this.lmSingleMove(dx, dy, profile, false, signal)
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
            await this.safeAbort(emitter, strokeStartIdx, moves.length, copy, copies, 'paused', { returnHome: false })
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
  /**
   * Rotate content by this many degrees (90 / 180 / 270) before planning.
   * Applied BEFORE simplify/reorder. Useful for paper-orientation fit and
   * for diagnostic re-plots that isolate hardware- vs content-specific
   * artifacts (compare same SVG at 0° vs 90°).
   */
  rotateDeg?: number
  /**
   * Translate content by (x, y) mm AFTER rotation, BEFORE simplify/reorder.
   * Used to shift the SVG origin into paper space when the paper is not
   * cornered at machine home: (paperOffsetX, paperOffsetY) makes SVG (0,0)
   * land at the paper's top-left instead of the machine's.
   */
  translateMm?: { x: number; y: number }
}

export interface EbbPlotOptions extends RunJobOptions {
  /** Node-only: path like /dev/cu.usbmodem14101. Ignored when `transport` is given. */
  port?: string
  /**
   * Pre-opened transport to use. If omitted (Node only), the function will
   * construct a NodeSerialTransport from `port` or auto-detect.
   */
  transport?: EbbTransport
  /**
   * Before running the job, issue a firmware-native home (HM) move. Use this
   * to resume after a pause where software position is stale.
   */
  homeBeforeRun?: boolean
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
  if (options.homeBeforeRun) {
    await backend.homeMachine()
  }
  try {
    return await backend.runJob(job, emitter, signal, {
      layer: options.layer,
      startFrom: options.startFrom,
      pageDelayS: options.pageDelayS,
      envelope: options.envelope,
      marginMm: options.marginMm,
      simplifyMm: options.simplifyMm,
      rotateDeg: options.rotateDeg,
      translateMm: options.translateMm,
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

// Like sleep() but resolves immediately if the signal fires, so Ctrl-C during
// a fixed-duration wait is noticed without waiting out the full duration.
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
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
