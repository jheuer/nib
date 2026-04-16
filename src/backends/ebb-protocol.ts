/**
 * Low-level EiBotBoard (EBB) serial protocol
 *
 * Talks to the AxiDraw firmware over USB serial (115200 baud, 8N1).
 * Reference: https://evil-mad.github.io/EggBot/ebb.html
 *
 * Uses Bun-native serial I/O (stty + fs) — no serialport / libuv dependency.
 * All methods throw if the port is not open.
 */

import { openSync, writeSync, closeSync, createReadStream, constants as fsConstants } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { spawnSync, execSync } from 'node:child_process'

// ─── EBB constants ───────────────────────────────────────────────────────────

export const EBB_BAUD = 115200

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
export const SERVO_MIN = 9855   // 0%   — pen fully down
export const SERVO_MAX = 27831  // 100% — pen fully up

/**
 * AxiDraw steps per mm at 1/16 microstepping (EM,5,5).
 * 200 steps/rev × 16 microsteps = 3200 steps/rev.
 * GT2 belt with 20-tooth pulley: 20 × 2mm = 40mm/rev.
 * 3200 / 40 = 80 steps/mm.
 *
 * Source: axidraw motion.py — step_scale = 2032 steps/inch = 79.84 ≈ 80 steps/mm.
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
 *
 * LM implements a linear rate ramp — starting and ending at rest, with a
 * per-axis accel. Since the motors accelerate from 0, the instantaneous
 * stall limit no longer gates cruise speed; the steady-state motor torque
 * and belt/pulley dynamics do. Conservative caps chosen so a pure-X move
 * at 50 mm/s = 4000 steps/s per motor, well under the documented 25 kHz
 * EBB LM step-rate ceiling.
 */
export const LM_SPEED_PENDOWN_MAX_MMS = 50
export const LM_SPEED_PENUP_MAX_MMS   = 100

/**
 * Acceleration cap in mm/s² (cartesian). Profile accel percent scales against this.
 * 2000 mm/s² reaches 50 mm/s in 25 ms — feels snappy without slipping belts.
 */
export const ACCEL_MAX_MMS2 = 2000

/**
 * EBB LM ISR tick rate. Rate/accel registers are scaled against 2^31 at this
 * sample rate — at each 40µs tick, `rate` is added to an accumulator; when the
 * accumulator overflows 2^31, a step is emitted. At each tick, `accel` is
 * added to `rate` (signed).
 */
export const LM_TICK_HZ = 25000
const LM_RATE_SCALE = 2 ** 31

/**
 * Minimum firmware version that supports LM command. 2.7.0 introduced LM.
 */
export const LM_MIN_FIRMWARE = [2, 7, 0] as const

// ─── EBBPort class ───────────────────────────────────────────────────────────

export class EBBPort {
  private rFd = -1   // read-only fd → createReadStream
  private wFd = -1   // write-only fd → writeSync
  private stream: ReadStream | null = null
  private lineBuffer = ''
  private pendingReply: ((line: string) => void) | null = null
  private draining = false   // while true, incoming data is silently discarded
  private resumeTimer: ReturnType<typeof setInterval> | null = null
  // Cached raw servo targets (set by configureServo). Used by forceServoUp/Down
  // to drive the servo via S2 without relying on the SP,0/SP,1 state machine,
  // which can silently ignore repeated commands on some firmware revisions.
  private servoUpRaw:   number = SERVO_MAX
  private servoDownRaw: number = SERVO_MIN
  // Becomes true after configureServo — only then is it safe for penUp/penDown
  // to automatically enforce the servo position via S2 (otherwise S2 might
  // drive the servo past the pen mechanism's physical range).
  private servoConfigured = false

  get isOpen(): boolean { return this.rFd >= 0 && this.wFd >= 0 }

  async open(rawPath: string): Promise<void> {
    // On macOS, /dev/tty.* blocks until DCD is asserted (modem behaviour).
    // The EBB never asserts DCD, so we must use /dev/cu.* (callout unit) instead.
    const path = toCuPath(rawPath)

    // Configure port: 115200 baud, 8N1, raw mode, no echo
    const sttyFlag = process.platform === 'darwin' ? '-f' : '-F'
    const r = spawnSync('stty', [
      sttyFlag, path,
      '115200',          // baud rate
      'cs8',             // 8 data bits
      '-cstopb',         // 1 stop bit (clear stop-bit flag = 1 stop bit)
      '-parenb',         // no parity
      'raw',             // disable all line processing
      '-echo',           // no local echo
      'clocal',          // ignore modem control lines
      'cread',           // enable receiver
    ])
    if (r.status !== 0) {
      throw new Error(
        `stty failed on ${path}: ${r.stderr?.toString().trim() || r.stdout?.toString().trim()}\n` +
        'Is the device connected and do you have read/write permission?'
      )
    }

    // Open separate read and write fds for the same device.
    // Sharing a single O_RDWR fd between createReadStream and writeSync
    // causes dropped data events in Bun's I/O backend for character devices.
    const { O_RDONLY, O_WRONLY, O_NOCTTY } = fsConstants
    this.rFd = openSync(path, O_RDONLY | O_NOCTTY)
    this.wFd = openSync(path, O_WRONLY | O_NOCTTY)
    this.lineBuffer = ''
    this.pendingReply = null

    // createReadStream keeps emitting data events for each incoming chunk.
    // writeSync on the separate write fd handles outgoing commands.
    this.draining = true
    this.stream = createReadStream('', { fd: this.rFd, autoClose: false })
    this.stream.on('data', (chunk: Buffer | string) => {
      if (!this.draining) {
        this.lineBuffer += Buffer.isBuffer(chunk) ? chunk.toString('ascii') : chunk
        this.processBuffer()
      }
      // Keep the stream in flowing mode. Bun pauses character-device streams
      // after a data burst with no immediately available bytes; without this
      // resume() the next response never triggers another 'data' event.
      this.stream?.resume()
    })
    this.stream.on('error', (err) => {
      if (this.pendingReply) {
        const cb = this.pendingReply
        this.pendingReply = null
        cb(`ERROR: ${err.message}`)
      }
    })

    // Drain: discard anything the EBB sends unsolicited (power-on banner, stale
    // OS kernel buffer) for 500ms. The draining flag makes the data handler
    // silently drop all chunks during this window, including any split banner
    // chunks that arrive after the initial sleep. Clearing lineBuffer at the end
    // discards any final stray bytes that landed just before the flag was cleared.
    await sleep(500)
    this.draining = false
    this.lineBuffer = ''
    this.stream?.resume()

    // Bun pauses character-device streams between data bursts. Poll resume() so
    // the stream never stays paused when a response arrives. unref() so the timer
    // doesn't prevent process exit if the port is closed without calling close().
    this.resumeTimer = setInterval(() => this.stream?.resume(), 50)
    this.resumeTimer.unref()
  }

  async close(): Promise<void> {
    if (this.rFd < 0) return
    if (this.resumeTimer) { clearInterval(this.resumeTimer); this.resumeTimer = null }
    const s = this.stream
    const rFd = this.rFd, wFd = this.wFd
    // Clear all state first
    this.stream = null
    this.rFd = -1
    this.wFd = -1
    this.lineBuffer = ''
    this.pendingReply = null
    this.draining = false
    if (s) {
      // Replace all listeners with a no-op error handler before destroying,
      // so EBADF errors from in-flight reads don't surface as unhandled.
      s.removeAllListeners()
      s.on('error', () => { /* swallow */ })
      // Close the read fd first — this aborts any in-flight async read and
      // causes the stream to clean up its internal I/O handle promptly.
      try { closeSync(rFd) } catch { /* ignore */ }
      s.destroy()
    } else {
      try { closeSync(rFd) } catch { /* ignore */ }
    }
    try { closeSync(wFd) } catch { /* ignore */ }
  }

  // ── Raw command I/O ────────────────────────────────────────────────────────

  /** Send a command and wait for exactly one response line */
  async command(cmd: string): Promise<string> {
    this.assertOpen()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReply = null
        reject(new Error(`EBB command "${cmd}" timed out after 3s`))
      }, 3000)

      this.pendingReply = (line) => {
        clearTimeout(timeout)
        resolve(line)
      }

      writeSync(this.wFd, Buffer.from(cmd + '\r'))
    })
  }

  /** Send a command with no response expected */
  async send(cmd: string): Promise<void> {
    this.assertOpen()
    writeSync(this.wFd, Buffer.from(cmd + '\r'))
  }

  // ── EBB protocol commands ─────────────────────────────────────────────────

  /** Query firmware version. Returns version string. */
  async version(): Promise<string> {
    return this.command('V')
  }

  /** Reset the EBB to its power-on state */
  async reset(): Promise<void> {
    await this.send('R')
    await sleep(500)
  }

  /**
   * Enable motors with the given microstep mode.
   * EBB firmware convention (DO NOT GUESS — this is inverted from what the name
   * suggests): 0=disable, 1=1/16, 2=1/8, 3=1/4, 4=1/2, 5=full step.
   * Use enableMotors(1,1) for 1/16 microstepping (STEPS_PER_MM=80).
   */
  async enableMotors(motor1Mode: number, motor2Mode: number): Promise<void> {
    await this.command(`EM,${motor1Mode},${motor2Mode}`)
  }

  /** Disable both stepper motors */
  async disableMotors(): Promise<void> {
    await this.command('EM,0,0')
  }

  /**
   * Set servo idle timeout. After this many ms of no SP commands, the servo
   * is powered off (no more PWM signal). Matches axicli default of 60000ms.
   * Pass 0 to disable timeout (servo stays powered indefinitely).
   */
  async setServoTimeout(ms: number): Promise<void> {
    await this.command(`SC,10,${Math.round(ms)}`)
  }

  /**
   * Set servo min/max positions from profile pen_pos_up/pen_pos_down (0–100).
   * This configures the SP up/down target positions AND caches the raw values
   * so forceServoUp/Down can drive the servo directly via S2.
   */
  async configureServo(penPosUp: number, penPosDown: number): Promise<void> {
    const upPos   = Math.round(SERVO_MIN + (penPosUp   / 100) * (SERVO_MAX - SERVO_MIN))
    const downPos = Math.round(SERVO_MIN + (penPosDown / 100) * (SERVO_MAX - SERVO_MIN))
    this.servoUpRaw   = upPos
    this.servoDownRaw = downPos
    this.servoConfigured = true
    await this.command(`SC,4,${upPos}`)    // pen-up position
    await this.command(`SC,5,${downPos}`)  // pen-down position
  }

  /**
   * Force the servo to its configured pen-up position via S2 PWM, bypassing
   * the SP,0/SP,1 state machine. Needed at end-of-plot to guarantee the pen
   * is lifted regardless of what the firmware thinks the current pen state is.
   * Rate 16000 gives a smooth ~250ms travel to the target.
   */
  async forceServoUp(): Promise<void> {
    await this.command(`S2,${this.servoUpRaw},4,16000,0`)
  }

  async forceServoDown(): Promise<void> {
    await this.command(`S2,${this.servoDownRaw},4,16000,0`)
  }

  /**
   * Pen up. Duration = servo transition time in ms.
   * Also fires S2 directly when configureServo has been called — on some EBB
   * firmware revisions (seen on 2.8.1), SP,0 is silently ignored when the
   * firmware thinks the pen is already up, even if the servo is physically
   * down. S2 guarantees the PWM reaches the pen-up target.
   */
  async penUp(durationMs = 200): Promise<void> {
    await this.command(`SP,0,${durationMs}`)
    if (this.servoConfigured) {
      await this.command(`S2,${this.servoUpRaw},4,16000,0`)
    }
    await sleep(durationMs + 20)
  }

  /**
   * Pen up for plot transitions between strokes. Sleeps only long enough for
   * the pen to clear the paper (default 80ms) — the servo continues rising
   * to its full up target in the background while the next travel move runs.
   * Safe because the subsequent pen-up travel move takes much longer than the
   * remaining servo travel, so the pen is fully up before we land at the
   * next stroke's entry point.
   */
  async penUpFast(clearMs = 80): Promise<void> {
    await this.command(`SP,0,80`)
    if (this.servoConfigured) {
      await this.command(`S2,${this.servoUpRaw},4,16000,0`)
    }
    await sleep(clearMs)
  }

  /**
   * Pen down. Duration = servo transition time in ms.
   * See penUp for why S2 is fired alongside SP.
   *
   * Adds an extra settle window on top of the servo transition: the pen
   * mechanism has mass and spring, so after the servo horn reaches the
   * pen-down position the tip takes additional milliseconds to fully contact
   * paper. Without this, the first 2–3 mm of each stroke draw in the air.
   */
  async penDown(durationMs = 150): Promise<void> {
    await this.command(`SP,1,${durationMs}`)
    if (this.servoConfigured) {
      await this.command(`S2,${this.servoDownRaw},4,16000,0`)
    }
    await sleep(durationMs + 120)  // 120ms tip-settle margin
  }

  /**
   * Stepper motor move.
   * dX, dY: displacement in mm (from current position, in SVG coordinate space)
   * speedMms: target speed in mm/s
   *
   * The AxiDraw CoreXY kinematics — empirically confirmed sign convention:
   * positive steps on both motors moves the carriage TOWARD home (upper-left),
   * so displacements away from home require negated steps.
   *   Motor1 (left)  = -(dX - dY) steps
   *   Motor2 (right) = -(dX + dY) steps
   */
  async move(dXmm: number, dYmm: number, speedMms: number): Promise<void> {
    if (Math.abs(dXmm) < 0.001 && Math.abs(dYmm) < 0.001) return

    const steps1 = Math.round((dXmm + dYmm) * STEPS_PER_MM)
    const steps2 = Math.round((dXmm - dYmm) * STEPS_PER_MM)

    const distMm = Math.sqrt(dXmm * dXmm + dYmm * dYmm)
    const durationMs = Math.max(SM_MIN_DURATION_MS, Math.round((distMm / speedMms) * 1000))

    if (process.env.NIB_VERBOSE) {
      process.stderr.write(`  [ebb] SM,${durationMs},${steps1},${steps2}  (dX=${dXmm}mm dY=${dYmm}mm v=${speedMms}mm/s)\n`)
    }

    const response = await this.command(`SM,${durationMs},${steps1},${steps2}`)
    if (!response.startsWith('OK')) {
      throw new Error(`SM command rejected: ${response}`)
    }
    // SM is non-blocking on EBB firmware — wait for the move to complete
    await sleep(durationMs + 5)
  }

  /**
   * Low-level linear-acceleration move (LM command, firmware ≥ 2.7).
   *
   * Both axes step independently, each with its own initial rate and per-tick
   * accel. Steps fields are SIGNED (sign = direction, magnitude = step count).
   * Rate/accel are register values — use lmRateReg / lmAccelReg to convert.
   * The firmware stops ticking each axis once its own step count is reached.
   *
   * If both step counts are 0, the command is a no-op and we skip sending it.
   */
  async lm(
    rate1Reg: number, steps1: number, accel1Reg: number,
    rate2Reg: number, steps2: number, accel2Reg: number,
  ): Promise<void> {
    if (steps1 === 0 && steps2 === 0) return
    const cmd =
      `LM,${rate1Reg},${steps1},${accel1Reg},` +
      `${rate2Reg},${steps2},${accel2Reg}`
    const resp = await this.command(cmd)
    if (!resp.startsWith('OK')) throw new Error(`LM rejected: ${resp}`)
  }

  /**
   * Parse firmware version string from the V command.
   * Example response: "EBBv13_and_above EB Firmware Version 2.8.1"
   */
  async firmwareVersion(): Promise<readonly [number, number, number]> {
    const v = await this.version()
    const m = v.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!m) return [0, 0, 0]
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
  }

  /**
   * Query accumulated step position from firmware (QS command).
   * Returns the raw motor step counts since last EM (motor enable).
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

  /**
   * Firmware-native home move (HM command). Returns the carriage to the
   * position where EM was last called, using the firmware's own step counters.
   * Much more reliable than manual QS → SM computation.
   *
   * stepsPerSec: max step rate for the faster motor (default 3200 ≈ 40mm/s).
   * Requires EBB firmware ≥ 2.6.2.
   */
  async homeMove(stepsPerSec = 3200): Promise<void> {
    // Query current position to estimate duration (so we know how long to wait).
    const { steps1, steps2 } = await this.querySteps()
    const maxSteps = Math.max(Math.abs(steps1), Math.abs(steps2))
    if (maxSteps === 0) return

    const durationMs = Math.round((maxSteps / stepsPerSec) * 1000)

    // Drain the floating OK that QS sends as a second serial event.
    await sleep(200)

    const resp = await this.command(`HM,${stepsPerSec}`)
    if (!resp.startsWith('OK')) throw new Error(`HM rejected: ${resp}`)

    // HM queues into the EBB FIFO like SM — wait for motion to complete.
    await sleep(durationMs + 200)
  }

  /**
   * Query motor status. Returns true if motors are moving.
   */
  async queryMotors(): Promise<{ moving: boolean; queueDepth: number }> {
    // EBB firmware sends OK first, then the QM data line.
    // command() consumes the first line; if it got 'OK', read a second line.
    let resp = await this.command('QM')
    if (resp === 'OK') resp = await this.command('QM')
    // Response: "QM,commandStatus,motor1Status,motor2Status,FIFOStatus"
    // Use motor1/motor2 status only — commandStatus can be transiently 1.
    const parts = resp.split(',')
    const moving = parts[2] === '1' || parts[3] === '1'
    return { moving, queueDepth: 0 }
  }

  /** Emergency stop — halts all motion immediately */
  async emergencyStop(): Promise<void> {
    await this.send('ES')
  }

  /** Return to home position stub — callers (EBBBackend) track position */
  async goHome(): Promise<void> {}

  // ── Internal helpers ───────────────────────────────────────────────────────

  private processBuffer(): void {
    // EBB terminates responses with \r\n or \n\r (firmware-version dependent).
    // Match any CR or LF and consume the paired character if present.
    let idx: number
    while ((idx = this.lineBuffer.search(/[\r\n]/)) >= 0) {
      const line = this.lineBuffer.slice(0, idx).trim()
      const c = this.lineBuffer[idx]
      const next = this.lineBuffer[idx + 1]
      const skip = (c === '\r' && next === '\n') || (c === '\n' && next === '\r') ? 2 : 1
      this.lineBuffer = this.lineBuffer.slice(idx + skip)
      if (line.length > 0 && this.pendingReply) {
        const cb = this.pendingReply
        this.pendingReply = null
        cb(line)
      }
    }
  }

  private assertOpen(): void {
    if (this.rFd < 0 || this.wFd < 0 || !this.stream) throw new Error('EBBPort is not open — call open() first')
  }
}

// ─── LM encoding ──────────────────────────────────────────────────────────────

/**
 * Encode a step frequency (steps/sec) as the EBB LM rate register.
 * Derivation: at each ISR tick (1/LM_TICK_HZ sec), `rate` is added to an
 * accumulator; when it overflows 2^31, a step is emitted. Thus:
 *   steps/sec = rate × LM_TICK_HZ / 2^31
 *   ⇒ rate   = (steps/sec) × 2^31 / LM_TICK_HZ
 *
 * Output is clamped to INT32 signed range. Max representable rate is 2^31-1
 * (= 25000 steps/sec at LM_TICK_HZ=25k, the firmware's own hard limit).
 */
export function lmRateReg(stepsPerSec: number): number {
  const raw = Math.round(stepsPerSec * LM_RATE_SCALE / LM_TICK_HZ)
  return clampInt32(raw)
}

/**
 * Encode an acceleration (steps/sec²) as the EBB LM accel register.
 * `accel` is added to `rate` each ISR tick, so:
 *   Δrate/sec = accel × LM_TICK_HZ
 *   Δ(steps/sec)/sec = accel × LM_TICK_HZ² / 2^31
 *   ⇒ accel = (steps/sec²) × 2^31 / LM_TICK_HZ²
 * Sign-preserving (negative = decel).
 */
export function lmAccelReg(stepsPerSec2: number): number {
  const raw = Math.round(stepsPerSec2 * LM_RATE_SCALE / (LM_TICK_HZ * LM_TICK_HZ))
  return clampInt32(raw)
}

/**
 * Returns true if `fw` meets or exceeds `min` (both [major, minor, patch]).
 */
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

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * On macOS, /dev/tty.* blocks waiting for DCD (carrier detect).
 * The EBB never asserts DCD, so convert to /dev/cu.* (callout unit).
 * No-op on Linux.
 */
function toCuPath(path: string): string {
  if (process.platform !== 'darwin') return path
  return path.replace('/dev/tty.', '/dev/cu.')
}

// ─── Port auto-discovery ──────────────────────────────────────────────────────

/**
 * Find the first serial port that looks like an AxiDraw/EBB device.
 * Uses OS-native enumeration — no serialport dependency.
 * Returns the port path, or null if not found.
 */
export async function findEbbPort(): Promise<string | null> {
  if (process.platform === 'darwin') {
    return findEbbPortMacos()
  } else if (process.platform === 'linux') {
    return findEbbPortLinux()
  }
  return null
}

function findEbbPortMacos(): string | null {
  // ioreg lists USB devices with VID/PID. EBB: VID=04d8, PID=fd92 or fd93.
  try {
    const out = execSync(
      'ioreg -r -c IOUSBHostDevice -l -x 2>/dev/null || ioreg -r -c IOUSBDevice -l -x 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 }
    )

    // Find EBB by VID/PID
    const blocks = out.split(/(?=\+-)/)
    for (const block of blocks) {
      const vid = block.match(/"idVendor"\s*=\s*0x([0-9a-f]+)/i)?.[1] ?? ''
      const pid = block.match(/"idProduct"\s*=\s*0x([0-9a-f]+)/i)?.[1] ?? ''
      const isEbb = vid === '4d8' && (pid === 'fd92' || pid === 'fd93')
      const isEbbAlt = block.toLowerCase().includes('schmalzhaus') || block.toLowerCase().includes('eggbot')

      if (isEbb || isEbbAlt) {
        // Find the corresponding tty device
        const serial = block.match(/"USB Serial Number"\s*=\s*"([^"]+)"/i)?.[1]
        if (serial) {
          // AxiDraw tty path typically contains the serial number
          try {
            const tty = execSync(`ls /dev/cu.usbmodem* 2>/dev/null | head -1`, { encoding: 'utf-8' }).trim()
            if (tty) return tty
          } catch { /* fallthrough */ }
        }
      }
    }
  } catch { /* fallthrough */ }

  // Fallback: return the first usbmodem device
  try {
    const tty = execSync('ls /dev/cu.usbmodem* 2>/dev/null | head -1', { encoding: 'utf-8' }).trim()
    if (tty) return tty
  } catch { /* ignore */ }

  return null
}

function findEbbPortLinux(): string | null {
  // Check /sys for USB devices with EBB VID/PID
  try {
    const out = execSync(
      "grep -rl '04d8' /sys/bus/usb/devices/*/idVendor 2>/dev/null | head -5",
      { encoding: 'utf-8', timeout: 3000 }
    )
    for (const vendorPath of out.trim().split('\n').filter(Boolean)) {
      const devDir = vendorPath.replace('/idVendor', '')
      try {
        const pid = execSync(`cat ${devDir}/idProduct 2>/dev/null`, { encoding: 'utf-8' }).trim()
        if (pid === 'fd92' || pid === 'fd93') {
          // Find the ttyACM device under this USB device
          const tty = execSync(`ls ${devDir}/*/tty/tty* 2>/dev/null | head -1`, { encoding: 'utf-8' }).trim()
          if (tty) return `/dev/${tty.split('/').pop()}`
        }
      } catch { /* continue */ }
    }
  } catch { /* fallthrough */ }

  // Fallback: first ttyACM device
  try {
    const tty = execSync('ls /dev/ttyACM* 2>/dev/null | head -1', { encoding: 'utf-8' }).trim()
    if (tty) return tty
  } catch { /* ignore */ }

  return null
}
