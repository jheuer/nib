/**
 * Low-level EiBotBoard (EBB) serial protocol — transport-agnostic.
 *
 * This module has no I/O. It:
 *   - Defines protocol constants (servo range, step scale, speed caps)
 *   - Encodes/decodes LM command rate/accel registers
 *   - Ships `EbbCommands` — a high-level wrapper that speaks EBB commands
 *     over any `EbbTransport` implementation (Node serial, WebSerial, mock…)
 *
 * Reference: https://evil-mad.github.io/EggBot/ebb.html
 *
 * For Node-only hardware I/O, see `node-serial.ts`.
 */

import type { EbbTransport } from './transport.ts'

// ─── EBB constants ───────────────────────────────────────────────────────────

/**
 * Servo range for pen positions. Matches axicli defaults so that pen_pos
 * percentages produce identical servo values via both backends.
 * Source: axidraw_conf_copy.py — servo_min/servo_max defaults.
 *   0% (SERVO_MIN) = pen fully down (at paper)
 * 100% (SERVO_MAX) = pen fully up (raised)
 *
 * Scale: 1 raw unit = 1/(12MHz) = 83.3 ns. Range: ~0.82ms – ~2.32ms pulse.
 * NOTE: percentages near 0 or 100 can push the servo past the pen mechanism's
 * physical travel. Stay within 20–60% for typical AxiDraw pen mounts.
 */
export const SERVO_MIN = 9855
export const SERVO_MAX = 27831

/**
 * AxiDraw steps per mm at 1/16 microstepping (EM,1,1).
 * 200 steps/rev × 16 microsteps = 3200 steps/rev.
 * GT2 belt with 20-tooth pulley: 20 × 2mm = 40mm/rev.
 * 3200 / 40 = 80 steps/mm.
 *
 * SM command motor mapping (from axidraw motion.py):
 *   AxisSteps1 = (dX + dY) * stepsPerMm
 *   AxisSteps2 = (dX - dY) * stepsPerMm
 */
export const STEPS_PER_MM = 80

/** Minimum SM command duration in ms (EBB firmware minimum) */
export const SM_MIN_DURATION_MS = 40

/**
 * Maximum speeds for SM-based moves (no acceleration ramp).
 *
 * SM moves at constant velocity — the firmware hardcodes Accel=0. The mechanical
 * stall threshold is ~1600 steps/s per motor (~20mm/s XY for pure X). For a 45°
 * diagonal the faster motor runs at v × √2 × 80 steps/s, so we must stay below
 * 1600 / (√2 × 80) ≈ 14mm/s to be safe on any trajectory.
 *
 * LM paths raise these — see LM_SPEED_* below.
 */
export const SPEED_PENDOWN_MAX_MMS = 10
export const SPEED_PENUP_MAX_MMS   = 13

/**
 * Maximum cruise speeds for LM-based moves (with trapezoidal acceleration).
 */
export const LM_SPEED_PENDOWN_MAX_MMS = 50
export const LM_SPEED_PENUP_MAX_MMS   = 100

/** Acceleration cap in mm/s² (cartesian). Profile accel percent scales against this. */
export const ACCEL_MAX_MMS2 = 2000

/**
 * EBB LM ISR tick rate. Rate/accel registers are scaled against 2^31 at this
 * sample rate.
 */
export const LM_TICK_HZ = 25000
const LM_RATE_SCALE = 2 ** 31

/** Minimum firmware version that supports LM command. */
export const LM_MIN_FIRMWARE = [2, 7, 0] as const

/** Default per-command response timeout (ms). */
const COMMAND_TIMEOUT_MS = 3000

// ─── EbbCommands class ───────────────────────────────────────────────────────

/**
 * High-level EBB protocol speaker. Wraps an {@link EbbTransport} and exposes
 * the firmware commands nib actually uses (pen state, motors, motion, servo,
 * queries). Stateless apart from a small servo-position cache populated by
 * {@link configureServo}.
 */
export class EbbCommands {
  private servoUpRaw:   number = SERVO_MAX
  private servoDownRaw: number = SERVO_MIN
  private servoConfigured = false

  constructor(public readonly transport: EbbTransport) {}

  get isOpen(): boolean { return this.transport.isOpen }

  async close(): Promise<void> { await this.transport.close() }

  // ── Raw command I/O ────────────────────────────────────────────────────────

  /** Send a command and wait for exactly one response line. */
  async command(cmd: string): Promise<string> {
    const readPromise = this.transport.readLine(COMMAND_TIMEOUT_MS)
    await this.transport.write(cmd + '\r')
    try {
      return await readPromise
    } catch (err) {
      // Transport-level timeout message; include the command for debuggability.
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`EBB command "${cmd}" failed: ${msg}`)
    }
  }

  /** Send a command with no response expected. */
  async send(cmd: string): Promise<void> {
    await this.transport.write(cmd + '\r')
  }

  // ── Firmware + state queries ──────────────────────────────────────────────

  /** Query firmware version. Returns the raw version string. */
  async version(): Promise<string> {
    return this.command('V')
  }

  /** Parse firmware version into [major, minor, patch]. */
  async firmwareVersion(): Promise<readonly [number, number, number]> {
    const v = await this.version()
    const m = v.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!m) return [0, 0, 0]
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
  }

  /** Reset the EBB to its power-on state. */
  async reset(): Promise<void> {
    await this.send('R')
    await sleep(500)
  }

  /**
   * Read the board name stored in EEPROM (QN command, firmware ≥ 2.5.5).
   * Response is typically `<name>\r\nOK\r\n`. Returns empty string if no name
   * is set. Nib uses this to auto-select machine config on connect when the
   * user has multiple AxiDraws.
   */
  async queryName(): Promise<string> {
    const resp = await this.command('QN')
    // Response format: "<name>\r\nOK" — the first line before OK is the name.
    // Some firmwares return just "OK" when no name is set.
    const firstLine = resp.split(/[\r\n]/)[0] ?? ''
    if (firstLine === 'OK') return ''
    return firstLine.trim()
  }

  /**
   * Write the board name to EEPROM (SN command, firmware ≥ 2.5.5). Name is
   * stored persistently, survives power cycles. Max length is firmware-defined
   * (16 chars on 2.8.x).
   */
  async setName(name: string): Promise<void> {
    if (name.length > 16) {
      throw new Error(`EBB name must be ≤16 characters (got ${name.length})`)
    }
    const resp = await this.command(`SN,${name}`)
    if (!resp.startsWith('OK')) throw new Error(`SN rejected: ${resp}`)
  }

  /**
   * Enable motors with the given microstep mode.
   * EBB firmware convention (DO NOT GUESS — this is inverted from what the
   * name suggests): 0=disable, 1=1/16, 2=1/8, 3=1/4, 4=1/2, 5=full step.
   * Use enableMotors(1,1) for 1/16 microstepping (STEPS_PER_MM=80).
   */
  async enableMotors(motor1Mode: number, motor2Mode: number): Promise<void> {
    await this.command(`EM,${motor1Mode},${motor2Mode}`)
  }

  /** Disable both stepper motors. */
  async disableMotors(): Promise<void> {
    await this.command('EM,0,0')
  }

  /**
   * Query accumulated step position from firmware (QS command).
   * Returns raw motor step counts since last EM (motor enable).
   * Requires EBB firmware ≥ 2.4.3.
   *
   * NOTE: QS sends a data line then a separate OK line. The OK arrives as a
   * second serial event after this call returns — callers must sleep ~200ms
   * before sending the next command to prevent that OK from poisoning the
   * next command's response.
   */
  async querySteps(): Promise<{ steps1: number; steps2: number }> {
    const resp = await this.command('QS')
    const parts = resp.split(',')
    return {
      steps1: parseInt(parts[0] ?? '0', 10),
      steps2: parseInt(parts[1] ?? '0', 10),
    }
  }

  /** Query motor status. Returns true if motors are moving. */
  async queryMotors(): Promise<{ moving: boolean; queueDepth: number }> {
    let resp = await this.command('QM')
    if (resp === 'OK') resp = await this.command('QM')
    const parts = resp.split(',')
    const moving = parts[2] === '1' || parts[3] === '1'
    return { moving, queueDepth: 0 }
  }

  /** Emergency stop — halts all motion immediately. */
  async emergencyStop(): Promise<void> {
    await this.send('ES')
  }

  // ── Servo configuration ───────────────────────────────────────────────────

  /**
   * Set servo idle timeout. After this many ms of no SP commands, the servo
   * is powered off. Matches axicli default of 60000ms.
   */
  async setServoTimeout(ms: number): Promise<void> {
    await this.command(`SC,10,${Math.round(ms)}`)
  }

  /**
   * Set servo up/down positions from profile pen_pos_up/pen_pos_down (0–100).
   * This configures the SP up/down target positions AND caches the raw values
   * so {@link forceServoUp}/{@link forceServoDown} can drive the servo
   * directly via S2.
   */
  async configureServo(penPosUp: number, penPosDown: number): Promise<void> {
    const upPos   = Math.round(SERVO_MIN + (penPosUp   / 100) * (SERVO_MAX - SERVO_MIN))
    const downPos = Math.round(SERVO_MIN + (penPosDown / 100) * (SERVO_MAX - SERVO_MIN))
    this.servoUpRaw   = upPos
    this.servoDownRaw = downPos
    this.servoConfigured = true
    await this.command(`SC,4,${upPos}`)
    await this.command(`SC,5,${downPos}`)
  }

  /** Drive the servo directly to its configured pen-up position via S2 PWM. */
  async forceServoUp(): Promise<void> {
    await this.command(`S2,${this.servoUpRaw},4,16000,0`)
  }

  /** Drive the servo directly to its configured pen-down position via S2 PWM. */
  async forceServoDown(): Promise<void> {
    await this.command(`S2,${this.servoDownRaw},4,16000,0`)
  }

  // ── Pen state ─────────────────────────────────────────────────────────────

  /**
   * Pen up. On some EBB firmware revisions (seen on 2.8.1), SP,0 is silently
   * ignored when the firmware thinks the pen is already up — so we also fire
   * an S2 to guarantee the servo reaches the pen-up target.
   */
  async penUp(durationMs = 200): Promise<void> {
    await this.command(`SP,0,${durationMs}`)
    if (this.servoConfigured) {
      await this.command(`S2,${this.servoUpRaw},4,16000,0`)
    }
    await sleep(durationMs + 20)
  }

  /**
   * Pen up for between-stroke transitions: sleeps only long enough for the
   * pen to clear paper (~80ms). The servo continues rising to full up in
   * background while the next travel move runs.
   */
  async penUpFast(clearMs = 80): Promise<void> {
    await this.command('SP,0,80')
    if (this.servoConfigured) {
      await this.command(`S2,${this.servoUpRaw},4,16000,0`)
    }
    await sleep(clearMs)
  }

  /**
   * Pen down. Adds an extra 120 ms settle on top of the servo transition so
   * the spring-loaded pen tip fully contacts paper before the next motion
   * command fires — without this the first 2–3mm of each stroke draws in air.
   */
  async penDown(durationMs = 150): Promise<void> {
    await this.command(`SP,1,${durationMs}`)
    if (this.servoConfigured) {
      await this.command(`S2,${this.servoDownRaw},4,16000,0`)
    }
    await sleep(durationMs + 120)
  }

  // ── Motion ────────────────────────────────────────────────────────────────

  /**
   * Constant-velocity stepper move (SM command). No acceleration.
   * See class-level notes on CoreXY kinematics and speed caps.
   */
  async move(dXmm: number, dYmm: number, speedMms: number): Promise<void> {
    if (Math.abs(dXmm) < 0.001 && Math.abs(dYmm) < 0.001) return

    const steps1 = Math.round((dXmm + dYmm) * STEPS_PER_MM)
    const steps2 = Math.round((dXmm - dYmm) * STEPS_PER_MM)

    const distMm = Math.sqrt(dXmm * dXmm + dYmm * dYmm)
    const durationMs = Math.max(SM_MIN_DURATION_MS, Math.round((distMm / speedMms) * 1000))

    if (typeof process !== 'undefined' && process.env?.NIB_VERBOSE) {
      process.stderr.write(`  [ebb] SM,${durationMs},${steps1},${steps2}  (dX=${dXmm}mm dY=${dYmm}mm v=${speedMms}mm/s)\n`)
    }

    const response = await this.command(`SM,${durationMs},${steps1},${steps2}`)
    if (!response.startsWith('OK')) {
      throw new Error(`SM command rejected: ${response}`)
    }
    await sleep(durationMs + 5)
  }

  /**
   * Low-level linear-acceleration move (LM command, firmware ≥ 2.7).
   * Both axes step independently with per-tick accel. Rate/accel are register
   * values — use {@link lmRateReg}/{@link lmAccelReg} to convert from Hz.
   */
  async lm(
    rate1Reg: number, steps1: number, accel1Reg: number,
    rate2Reg: number, steps2: number, accel2Reg: number,
  ): Promise<void> {
    if (steps1 === 0 && steps2 === 0) return
    const cmd =
      `LM,${rate1Reg},${steps1},${accel1Reg},` +
      `${rate2Reg},${steps2},${accel2Reg}`
    if (typeof process !== 'undefined' && process.env?.NIB_VERBOSE) {
      process.stderr.write(`  [ebb] ${cmd}\n`)
    }
    const resp = await this.command(cmd)
    if (!resp.startsWith('OK')) throw new Error(`LM rejected: ${resp}`)
  }

  /**
   * Firmware-native home move (HM command). Returns the carriage to the
   * position where EM was last issued. Requires EBB firmware ≥ 2.6.2.
   */
  async homeMove(stepsPerSec = 3200): Promise<void> {
    const { steps1, steps2 } = await this.querySteps()
    const maxSteps = Math.max(Math.abs(steps1), Math.abs(steps2))
    if (maxSteps === 0) return

    const durationMs = Math.round((maxSteps / stepsPerSec) * 1000)
    // Drain the floating OK that QS sends as a second serial event.
    await sleep(200)

    const resp = await this.command(`HM,${stepsPerSec}`)
    if (!resp.startsWith('OK')) throw new Error(`HM rejected: ${resp}`)

    await sleep(durationMs + 200)
  }
}

// ─── LM register encoding ─────────────────────────────────────────────────────

/**
 * Encode a step frequency (steps/sec) as the EBB LM rate register.
 *   steps/sec = rate × LM_TICK_HZ / 2^31
 *   ⇒ rate   = (steps/sec) × 2^31 / LM_TICK_HZ
 * Clamped to INT32 signed range.
 */
export function lmRateReg(stepsPerSec: number): number {
  const raw = Math.round(stepsPerSec * LM_RATE_SCALE / LM_TICK_HZ)
  return clampInt32(raw)
}

/**
 * Encode an acceleration (steps/sec²) as the EBB LM accel register.
 *   Δ(steps/sec)/sec = accel × LM_TICK_HZ² / 2^31
 *   ⇒ accel = (steps/sec²) × 2^31 / LM_TICK_HZ²
 * Sign-preserving (negative = decel).
 */
export function lmAccelReg(stepsPerSec2: number): number {
  const raw = Math.round(stepsPerSec2 * LM_RATE_SCALE / (LM_TICK_HZ * LM_TICK_HZ))
  return clampInt32(raw)
}

/** Returns true if `fw` meets or exceeds `min`. */
export function firmwareAtLeast(
  fw: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (fw[i] > min[i]) return true
    if (fw[i] < min[i]) return false
  }
  return true
}

function clampInt32(v: number): number {
  const MAX = 0x7fffffff
  const MIN = -0x80000000
  if (v > MAX) return MAX
  if (v < MIN) return MIN
  return v
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
