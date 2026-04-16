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
import type { RunJobResult } from './axicli.ts'
import {
  EBBPort, findEbbPort,
  SPEED_PENDOWN_MAX_MMS, SPEED_PENUP_MAX_MMS,
  LM_MIN_FIRMWARE, firmwareAtLeast,
} from './ebb-protocol.ts'
import { svgToMoves } from './svg-to-moves.ts'
import { reorder, type OptimizeLevel } from '../core/reorder.ts'
import { planMove, optionsForProfile } from '../core/planner.ts'

// ─── EBBBackend ───────────────────────────────────────────────────────────────

export class EBBBackend implements PlotBackend {
  private ebb = new EBBPort()
  private currentX = 0
  private currentY = 0
  private penIsDown = false
  private useLm = false

  // ── PlotBackend interface ─────────────────────────────────────────────────

  async connect(port: string): Promise<void> {
    const resolvedPort = (port || await findEbbPort()) ?? ''
    if (!resolvedPort) {
      throw new Error(
        'No EBB/AxiDraw device found. ' +
        'Check that the USB cable is connected and the device is powered.'
      )
    }
    await this.ebb.open(resolvedPort)

    // Firmware-capability gate for LM (trapezoid accel).
    // Only auto-upgrade on ≥ 2.7; SM stays the default otherwise.
    try {
      const fw = await this.ebb.firmwareVersion()
      this.useLm = firmwareAtLeast(fw, LM_MIN_FIRMWARE)
    } catch {
      this.useLm = false
    }

    await this.ebb.penUp()
    await this.ebb.enableMotors(1, 1)  // 1/16 microstepping (EM=1, not 5; see ebb-protocol.ts)
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

  /** Poll QM until motors are idle (FIFO drained). Gives up after 30s. */
  private async waitForMotorsIdle(): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const { moving } = await this.ebb.queryMotors()
      if (!moving) return
      await sleep(20)
    }
  }

  async disconnect(): Promise<void> {
    // Force the servo to pen-up via S2. SP can be a no-op on this firmware
    // when it thinks the pen is already up, so we bypass it.
    await this.ebb.forceServoUp().catch(() => undefined)
    await sleep(300)
    this.penIsDown = false
    await this.ebb.disableMotors().catch(() => undefined)
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
    const profile = job.profile
    const layer = options.layer
    const startFrom = clamp01(options.startFrom ?? 0)
    const copies = Math.max(1, job.copies ?? 1)
    const pageDelayMs = Math.max(0, (options.pageDelayS ?? 0) * 1000)

    await this.ebb.configureServo(profile.penPosUp, profile.penPosDown)
    await this.ebb.setServoTimeout(60_000)
    await this.ebb.penUp()
    this.penIsDown = false

    // Parse SVG → moves, apply layer filter, then reorder per optimize level.
    const rawMoves = svgToMoves(job.svg, { tolerance: 0.1, layer })
    if (rawMoves.length === 0) {
      return { stoppedAt: 1, aborted: false }
    }
    const { moves } = reorder(rawMoves, (job.optimize ?? 0) as OptimizeLevel)

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

      for (let i = copy === 0 ? firstIdx : 0; i < moves.length; i++) {
        if (signal?.aborted) {
          if (this.penIsDown) {
            await this.ebb.penUp().catch(() => undefined)
            this.penIsDown = false
          }
          await this.home()
          const fraction = (copy + i / moves.length) / copies
          emitter.emit('abort', fraction)
          return { stoppedAt: fraction, aborted: true }
        }

        const move = moves[i]
        const dx = move.x - this.currentX
        const dy = move.y - this.currentY
        const dist = Math.sqrt(dx * dx + dy * dy)

        if (move.penDown && !this.penIsDown) {
          await this.ebb.penDown()
          this.penIsDown = true
          penLifts++
          emitter.emit('pen:down')
        } else if (!move.penDown && this.penIsDown) {
          await this.ebb.penUp()
          this.penIsDown = false
          emitter.emit('pen:up')
        }

        if (dist > 0.001) {
          if (this.useLm) {
            await this.lmSingleMove(dx, dy, profile, this.penIsDown)
          } else {
            const speed = this.penIsDown ? speedDown : speedUp
            await this.ebb.move(dx, dy, speed)
          }
          this.currentX = move.x
          this.currentY = move.y

          if (this.penIsDown) pendownM += dist / 1000
          else                travelM  += dist / 1000
        }

        if (i % 50 === 0) {
          emitter.emit('progress', (copy + i / moves.length) / copies, 0)
        }
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

    job.metrics.pendownM += pendownM
    job.metrics.travelM  += travelM
    job.metrics.penLifts += penLifts

    emitter.emit('complete', job.metrics)
    return { stoppedAt: 1, aborted: false }
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
}

export interface EbbPlotOptions extends RunJobOptions {
  port?: string
}

/**
 * Connect to an EBB device, execute a job, then disconnect.
 * EBB equivalent of axicli.ts runJob().
 */
export async function runJobEbb(
  job: Job,
  emitter: PlotEmitter,
  options: EbbPlotOptions = {},
  signal?: AbortSignal,
): Promise<RunJobResult> {
  const backend = new EBBBackend()
  const port = options.port ?? process.env.NIB_PORT ?? ''

  await backend.connect(port)
  try {
    return await backend.runJob(job, emitter, signal, {
      layer: options.layer,
      startFrom: options.startFrom,
      pageDelayS: options.pageDelayS,
    })
  } finally {
    await backend.disconnect()
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
