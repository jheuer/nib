/**
 * nib calibrate — interactive pen-height calibration wizard
 *
 * Guides the user through finding the correct servo positions for a pen profile:
 *   1. Pen-down sweep: step toward paper until ink first touches
 *   2. Pen-up sweep:   step away from paper until pen clears without dragging
 *
 * Servo position scale: 0% = pen fully down (at paper), 100% = pen fully up.
 * For most pens, pen-down ~30–50%, pen-up ~50–70%.
 */

import { defineCommand } from 'citty'
import readline from 'readline'
import chalk from 'chalk'
import { getProfile, saveProfile, listProfiles } from '../core/config.ts'
import type { Profile } from '../core/job.ts'
import { EbbCommands, SERVO_MIN, SERVO_MAX } from '../backends/ebb-protocol.ts'
import { connectEbb, findEbbPort } from '../backends/node-serial.ts'
import { ok, printError } from '../tui/output.ts'
import { isInteractive } from '../tui/env.ts'

// ─── Command definition ───────────────────────────────────────────────────────

export const calibrateCmd = defineCommand({
  meta: { name: 'calibrate', description: 'Interactive pen-height calibration wizard' },
  args: {
    profile: {
      type: 'positional',
      description: 'Profile to calibrate (creates if missing)',
      required: false,
    },
    port: {
      type: 'string',
      description: 'Serial port override (env: NIB_PORT)',
    },
    start: {
      type: 'string',
      description: 'Starting position for pen-down sweep, 0–100 (default: 50)',
      default: '50',
    },
  },

  async run({ args }) {
    if (!isInteractive) {
      printError('calibrate requires an interactive terminal')
      process.exit(2)
    }

    // ── Resolve profile name ────────────────────────────────────────────────
    let profileName = args.profile?.trim()

    if (!profileName) {
      const profiles = await listProfiles()
      if (profiles.length === 0) {
        printError('No profiles exist.', 'create one first: nib profile create <name>')
        process.exit(1)
      }
      process.stderr.write('\n  Available profiles:\n')
      for (const p of profiles) {
        const desc = p.description ? chalk.dim('  ' + p.description) : ''
        process.stderr.write(`    ${chalk.bold(p.name)}${desc}\n`)
      }
      profileName = (await linePrompt('\n  Profile to calibrate: ')).trim()
      if (!profileName) process.exit(0)
    }

    const existing = await getProfile(profileName)

    process.stderr.write(`\n  ${chalk.bold('nib calibrate')}  ·  ${chalk.cyan(profileName)}`)
    if (existing?.description) process.stderr.write(chalk.dim('  ' + existing.description))
    process.stderr.write('\n')

    if (existing) {
      process.stderr.write(
        `  Current values:  pen-down ${chalk.bold(existing.penPosDown)}  ·  pen-up ${chalk.bold(existing.penPosUp)}\n`
      )
    }
    process.stderr.write('\n')

    // ── Connect ─────────────────────────────────────────────────────────────
    const rawPort = args.port ?? process.env.NIB_PORT
    const portPath = rawPort || await findEbbPort()
    if (!portPath) {
      printError('No EBB device found — is the AxiDraw connected?')
      process.exit(1)
    }

    const ebb = await connectEbb(portPath)
    await ebb.enableMotors(1, 1)

    // Safe-up position used during calibration (pen definitely clear of paper).
    // Set SC,4 to this once — it doesn't change during the sweep.
    const SAFE_UP_RAW = servoRaw(80)
    await ebb.command(`SC,4,${SAFE_UP_RAW}`)
    await ebb.penUp(300)

    const cleanup = async () => {
      await ebb.penUp(300).catch(() => undefined)
      await ebb.disableMotors().catch(() => undefined)
      await ebb.close().catch(() => undefined)
    }

    // SIGINT (delivered outside raw mode) + hard fail-safe. 3s is plenty for
    // penUp + disableMotors + close to finish or time out.
    process.once('SIGINT', () => {
      setTimeout(() => process.exit(130), 3000).unref()
      cleanup().finally(() => {
        process.stderr.write('\n  Calibration cancelled.\n\n')
        process.exit(130)
      })
    })

    process.stderr.write('  AxiDraw connected. Position the pen tip directly over your paper.\n')
    const ready = await waitForEnter('  Press Enter when ready...')
    if (!ready) { await cleanup(); process.exit(130) }

    const startPct = clamp(parseInt(args.start, 10) || 50, 1, 99)

    // ── Phase 1: pen-down ────────────────────────────────────────────────────
    printPhaseHeader('Step 1 / 2', 'Pen-down position')
    process.stderr.write('  Lower the pen until ink just touches the paper.\n\n')
    printKeyHelp('lower pen', 'raise pen')

    const penDown = await sweep(ebb, startPct, 'down')
    if (penDown === null) {
      await cleanup()
      process.stderr.write('\n  Calibration cancelled.\n\n')
      process.exit(130)
    }

    process.stderr.write(`\n\n  ${ok(`pen-down recorded: ${chalk.bold(penDown)}`)}\n\n`)

    // ── Phase 2: pen-up ──────────────────────────────────────────────────────
    printPhaseHeader('Step 2 / 2', 'Pen-up position')
    process.stderr.write('  Raise the pen until it clears the paper without dragging.\n\n')
    printKeyHelp('raise pen', 'lower pen')

    const penUp = await sweep(ebb, penDown + 2, 'up')
    if (penUp === null) {
      await cleanup()
      process.stderr.write('\n  Calibration cancelled.\n\n')
      process.exit(130)
    }

    process.stderr.write(`\n\n  ${ok(`pen-up recorded: ${chalk.bold(penUp)}`)}\n\n`)

    // ── Summary ──────────────────────────────────────────────────────────────
    process.stderr.write(`  ${'─'.repeat(40)}\n`)
    process.stderr.write(`  pen-down   ${chalk.bold(String(penDown).padStart(3))}\n`)
    process.stderr.write(`  pen-up     ${chalk.bold(String(penUp).padStart(3))}\n`)
    process.stderr.write(`  gap        ${penUp - penDown} points\n`)
    process.stderr.write(`  ${'─'.repeat(40)}\n\n`)

    const save = await confirmPrompt('  Save to profile? [y / Enter = yes · n = no] > ')
    if (!save) {
      process.stderr.write('  Not saved.\n\n')
      await cleanup()
      return
    }

    // Merge into existing profile (preserves speed/accel) or create with defaults
    const base: Profile = existing ?? {
      speedPendown: 25,
      speedPenup:   75,
      penPosDown:   penDown,
      penPosUp:     penUp,
      accel:        75,
    }
    const updated: Profile = { ...base, penPosDown: penDown, penPosUp: penUp }
    delete (updated as Partial<Profile & { name?: string }>).name
    await saveProfile(profileName, updated)

    process.stderr.write(`\n  ${ok(`profile "${chalk.bold(profileName)}" updated`)}\n\n`)
    await cleanup()
  },
})

// ─── Sweep loop ───────────────────────────────────────────────────────────────

/**
 * Interactive servo position sweep. Moves the servo in real time as the user
 * presses keys. Returns the confirmed position (0–100), or null on Ctrl-C.
 *
 * Uses readline.emitKeypressEvents so that:
 *   - Arrow keys (3-byte ESC sequences) arrive as a single 'keypress' event
 *     with key.name === 'up' / 'down', not as raw byte strings that may split.
 *   - Enter (\r\n) is normalised to one 'return' event, preventing a buffered
 *     \n from the preceding waitForEnter call from immediately exiting the sweep.
 */
async function sweep(
  ebb: EbbCommands,
  startPct: number,
  direction: 'down' | 'up',
): Promise<number | null> {
  let pos = clamp(startPct, 0, 100)
  let sentPos = -1
  let pumping = false

  // Coalescing pump: when pos diverges from sentPos, walk the servo to it,
  // one command at a time. If the user spams keys, intermediate targets are
  // skipped — we always chase the latest position. Errors are logged but
  // don't abort calibration.
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (pos !== sentPos) {
        const target = pos
        sentPos = target
        try { await setServoPos(ebb, target) }
        catch (err) { process.stderr.write(`\n  [servo] ${(err as Error).message}\n`) }
      }
    } finally {
      pumping = false
    }
  }

  // Move to initial position
  renderPos(pos, direction)
  pump()

  return new Promise((resolve) => {
    process.stdin.setRawMode(true)
    process.stdin.resume()

    const done = (result: number | null) => {
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      // Ctrl-C: exit immediately. Don't wait for graceful cleanup — the
      // command/close path can hang on a wedged port, which is exactly when
      // the user is most likely to reach for Ctrl-C. 2s fail-safe for any
      // in-flight pump command to finish, then force-exit.
      if (result === null) {
        setTimeout(() => process.exit(130), 2000).unref()
      }
      resolve(result)
    }

    // Raw-byte parsing. Arrow keys arrive as 3-byte CSI sequences:
    //   Up    = ESC [ A = 1b 5b 41
    //   Down  = ESC [ B = 1b 5b 42
    // Enter = 0x0d / 0x0a, Space = 0x20, Ctrl-C = 0x03.
    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]

        if (b === 0x03) { done(null); return }         // Ctrl-C
        if (b === 0x0d || b === 0x0a || b === 0x20) {  // Enter / Space
          done(pos); return
        }

        // Vim/wasd keys. Lowercase = coarse (5%), uppercase = fine (1%).
        if (b === 0x64 || b === 0x6a /* d/j */) { step(-5); continue }
        if (b === 0x75 || b === 0x6b /* u/k */) { step(+5); continue }
        if (b === 0x44 || b === 0x4a /* D/J */) { step(-1); continue }
        if (b === 0x55 || b === 0x4b /* U/K */) { step(+1); continue }

        // CSI arrow sequence: 0x1b 0x5b 0x41/0x42
        if (b === 0x1b && chunk[i + 1] === 0x5b) {
          const arrow = chunk[i + 2]
          if (arrow === 0x41) { step(+5); i += 2; continue }  // Up (coarse)
          if (arrow === 0x42) { step(-5); i += 2; continue }  // Down (coarse)
        }
      }
    }

    const step = (delta: number) => {
      pos = clamp(pos + delta, 0, 100)
      renderPos(pos, direction)
      pump()
    }

    process.stdin.on('data', onData)
  })
}

// ─── EBB helpers ─────────────────────────────────────────────────────────────

/**
 * Move the servo to a given 0–100% position. Awaits the EBB OK so that
 * errors surface and the queue doesn't flood under fast keypress. 250ms
 * servo-travel duration gives a visible, audible move.
 */
/**
 * Drive the pen servo directly via S2 (bypassing the SP,0/SP,1 state machine).
 * S2,position,channel=4,rate=16000,delay=0 — channel 4 is the standard pen
 * servo on EBB v3+. Rate controls how fast the servo walks to the new value;
 * 16000 is ~smooth at 1% increments without being sluggish.
 */
async function setServoPos(ebb: EbbCommands, pct: number): Promise<void> {
  const raw = servoRaw(pct)
  // S2 drives PWM directly — bypasses the SP,0/SP,1 state machine which
  // can ignore repeated SP commands on some firmware.
  await ebb.command(`S2,${raw},4,16000,0`)
}

/** Convert a 0–100% value to the raw EBB servo unit. */
function servoRaw(pct: number): number {
  return Math.round(SERVO_MIN + (pct / 100) * (SERVO_MAX - SERVO_MIN))
}

// ─── Display ──────────────────────────────────────────────────────────────────

const BAR_WIDTH = 32

function renderPos(pct: number, direction: 'down' | 'up'): void {
  // Bar: left = 0% (down), right = 100% (up). Filled portion = current position.
  const filled = Math.round((pct / 100) * BAR_WIDTH)
  const bar = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(BAR_WIDTH - filled))

  const label = direction === 'down'
    ? chalk.dim('0=down') + ` [${bar}] ` + chalk.dim('100=up')
    : chalk.dim('0=down') + ` [${bar}] ` + chalk.dim('100=up')

  process.stderr.write(`\r  ${label}  ${chalk.bold(String(pct).padStart(3))}  `)
}

function printPhaseHeader(step: string, title: string): void {
  process.stderr.write(`  ${chalk.bold(step)} — ${title}\n`)
  process.stderr.write(`  ${'─'.repeat(48)}\n`)
}

function printKeyHelp(primaryLabel: string, secondaryLabel: string): void {
  process.stderr.write(
    chalk.dim(`  ↓/d/j  ${primaryLabel} 5%   ↑/u/k  ${secondaryLabel} 5%   shift = 1% fine   Enter  record\n\n`)
  )
}

// ─── Input helpers ────────────────────────────────────────────────────────────

/**
 * Read a line of text via readline. Only safe to use BEFORE any raw-mode
 * interaction — readline leaves stdin in a paused state that breaks raw mode
 * data events in Bun.
 */
function linePrompt(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    })
    process.stderr.write(question)
    rl.once('line', line => { rl.close(); resolve(line) })
    rl.once('close', () => resolve(''))
  })
}

/**
 * Wait for Enter/Space in raw mode. Returns false if Ctrl-C was pressed.
 * Use this instead of linePrompt after hardware has connected.
 */
function waitForEnter(message: string): Promise<boolean> {
  process.stderr.write(message)
  return new Promise(resolve => {
    process.stdin.setRawMode(true)
    process.stdin.resume()

    const teardown = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }

    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]
        if (b === 0x03) { teardown(); resolve(false); return }
        if (b === 0x0d || b === 0x0a || b === 0x20) { teardown(); resolve(true); return }
      }
    }
    process.stdin.on('data', onData)
  })
}

/**
 * Show a yes/no prompt in raw mode. Returns true for yes, false for no/Ctrl-C.
 * y/Enter = yes, n = no, Ctrl-C = cancel (returns false).
 */
function confirmPrompt(message: string): Promise<boolean> {
  process.stderr.write(message)
  return new Promise(resolve => {
    process.stdin.setRawMode(true)
    process.stdin.resume()

    const teardown = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }

    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]
        if (b === 0x03) { teardown(); process.stderr.write('\n'); resolve(false); return }
        if (b === 0x6e || b === 0x4e /* n/N */) { teardown(); process.stderr.write('\n'); resolve(false); return }
        if (b === 0x0d || b === 0x0a || b === 0x79 || b === 0x59 /* Enter/y/Y */) {
          teardown(); process.stderr.write('\n'); resolve(true); return
        }
      }
    }
    process.stdin.on('data', onData)
  })
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
