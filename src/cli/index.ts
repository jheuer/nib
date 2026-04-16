#!/usr/bin/env bun
import './env-init.ts'  // must be first: sets NO_COLOR before chalk loads
import { defineCommand, runMain } from 'citty'
import chalk from 'chalk'
import { plotCmd } from './plot.ts'
import { previewCmd } from './preview.ts'
import { watchCmd } from './watch.ts'
import { profileCmd } from './profile.ts'
import { jobCmd } from './job.ts'
import { seriesCmd } from './series.ts'
import { calibrateCmd } from './calibrate.ts'
import { loadGlobalConfig, saveGlobalConfig, getProfile } from '../core/config.ts'
import { SPEED_PENUP_MAX_MMS } from '../backends/ebb-protocol.ts'
import { connectEbb, findEbbPort } from '../backends/node-serial.ts'
import { writeProjectConfig } from '../core/config.ts'
import { printError } from '../tui/output.ts'
import { advanceArmState, resetArmState, markArmUnknown, loadArmState, formatPosition } from '../core/state.ts'

// ─── pen ──────────────────────────────────────────────────────────────────────

// Default servo positions used when no profile is specified.
// Kept inside the safe mid-range (~1.2–1.6ms pulse) — pen mechanisms often
// can't travel the full 0–100% servo range without hitting a mechanical stop.
const PEN_UP_DEFAULT   = 50
const PEN_DOWN_DEFAULT = 30

const penCmd = defineCommand({
  meta: { name: 'pen', description: 'Manual pen control' },
  args: {
    action:  { type: 'positional', description: 'up | down | cycle' },
    profile: { type: 'string',  alias: 'p', description: 'Profile name for servo positions (env: NIB_PROFILE)' },
    port:    { type: 'string',  description: 'Serial port override (env: NIB_PORT)' },
  },
  async run({ args }) {
    const action = args.action?.toLowerCase()
    if (!['up', 'down', 'cycle'].includes(action ?? '')) {
      printError(`pen action must be up, down, or cycle (got: ${args.action})`)
      process.exit(2)
    }

    const rawPort = args.port ?? process.env.NIB_PORT
    const portPath = rawPort || await findEbbPort()
    if (!portPath) {
      printError('No EBB device found — is the AxiDraw connected?')
      process.exit(1)
    }

    // Resolve servo positions from profile if given
    const profileName = args.profile ?? process.env.NIB_PROFILE
    let penPosUp   = PEN_UP_DEFAULT
    let penPosDown = PEN_DOWN_DEFAULT
    if (profileName) {
      const p = await getProfile(profileName)
      if (!p) {
        printError(`profile "${profileName}" not found`, 'run: nib profile list')
        process.exit(1)
      }
      penPosUp   = p.penPosUp
      penPosDown = p.penPosDown
    }

    const killTimer = setTimeout(() => process.exit(0), 10_000)
    killTimer.unref()

    const ebb = await connectEbb(portPath)
    await ebb.configureServo(penPosUp, penPosDown)

    if (action === 'up') {
      await ebb.penUp(300)
    } else if (action === 'down') {
      await ebb.penDown(300)
    } else {
      // cycle: up → down, useful for testing servo travel
      await ebb.penUp(300)
      await sleep(500)
      await ebb.penDown(300)
    }

    const src = profileName ? `${profileName}: up=${penPosUp}% down=${penPosDown}%` : `defaults: up=${penPosUp}% down=${penPosDown}%`
    process.stderr.write(`  pen ${action}  (${src})\n`)
    process.exit(0)
  },
})

// ─── move ─────────────────────────────────────────────────────────────────────

const MOVE_SPEED_MMS = 13  // pen-up travel speed for manual moves

const moveCmd = defineCommand({
  meta: { name: 'move', description: 'Move carriage by a relative offset' },
  args: {
    x:      { type: 'string',  description: 'X distance in mm (positive = right)' },
    y:      { type: 'string',  description: 'Y distance in mm (positive = down)' },
    home:   { type: 'boolean', description: 'Return to where motors were last enabled (EBB HM)', default: false },
    port:   { type: 'string',  description: 'Serial port override (env: NIB_PORT)' },
  },
  async run({ args }) {
    const rawPort = args.port ?? process.env.NIB_PORT
    const portPath = rawPort || await findEbbPort()
    if (!portPath) {
      printError('No EBB device found — is the AxiDraw connected?')
      process.exit(1)
    }

    // Hard fail-safe: if anything below blocks the event loop past 15s, bail.
    // closeSync on a character device can hang waiting on pending I/O; we'd
    // rather terminate than wedge the terminal.
    const killTimer = setTimeout(() => process.exit(0), 15_000)
    killTimer.unref()

    if (args.home) {
      // Walk back to tracked origin in software, not via firmware HM — that
      // command returns to "position when EM was last issued", which isn't
      // the origin we care about if other commands have moved the arm since.
      const state = await loadArmState()
      if (state.unknown) {
        printError(
          'arm position is unknown — I don\'t know where to home to',
          're-enable motors with the arm parked at your intended origin: nib motors on',
        )
        process.exit(1)
      }
      const ebb = await connectEbb(portPath)
      await ebb.penUp(200)
      await ebb.enableMotors(1, 1)
      if (Math.abs(state.x) > 0.01 || Math.abs(state.y) > 0.01) {
        await ebb.move(-state.x, -state.y, MOVE_SPEED_MMS)
      }
      await resetArmState()
      process.stderr.write(`  Home → (0, 0)\n`)
      process.exit(0)
    }

    const xMm = args.x ? parseMmArg(args.x) : null
    const yMm = args.y ? parseMmArg(args.y) : null
    if (xMm === null && yMm === null) {
      printError('provide --x <mm>, --y <mm>, or --home')
      process.exit(2)
    }

    const ebb = await connectEbb(portPath)
    await ebb.penUp(200)
    await ebb.enableMotors(1, 1)
    await ebb.move(xMm ?? 0, yMm ?? 0, MOVE_SPEED_MMS)
    await advanceArmState(xMm ?? 0, yMm ?? 0)
    process.exit(0)
  },
})

// ─── motors ───────────────────────────────────────────────────────────────────

const motorsCmd = defineCommand({
  meta: { name: 'motors', description: 'Enable or disable stepper motors' },
  args: {
    state: { type: 'positional', description: 'on | off' },
    port:  { type: 'string', description: 'Serial port override (env: NIB_PORT)' },
  },
  async run({ args }) {
    const state = args.state?.toLowerCase()
    if (state !== 'on' && state !== 'off') {
      printError(`motors state must be on or off (got: ${args.state})`)
      process.exit(2)
    }
    const rawPort = args.port ?? process.env.NIB_PORT
    const portPath = rawPort || await findEbbPort()
    if (!portPath) {
      printError('No EBB device found — is the AxiDraw connected?')
      process.exit(1)
    }

    const killTimer = setTimeout(() => process.exit(0), 10_000)
    killTimer.unref()

    const ebb = await connectEbb(portPath)
    if (state === 'on') {
      await ebb.enableMotors(1, 1)
      // Enabling motors re-establishes origin at the current physical position.
      await resetArmState()
    } else {
      await ebb.disableMotors()
      // User is about to push the arm around by hand — we can no longer trust
      // the tracked position. Flag as unknown; `nib plot` will prompt before
      // trusting it.
      await markArmUnknown()
    }
    process.stderr.write(`  motors ${state}\n`)
    process.exit(0)
  },
})

// ─── version (firmware) ───────────────────────────────────────────────────────

const fwCmd = defineCommand({
  meta: { name: 'fw', description: 'Report EBB firmware version' },
  args: {
    port: { type: 'string', description: 'Serial port (env: NIB_PORT, or "auto")' },
  },
  async run({ args }) {
    const rawPort = args.port ?? process.env.NIB_PORT
    let port: string
    if (!rawPort || rawPort === 'auto') {
      const found = await findEbbPort()
      if (!found) {
        printError('No EBB device found — is the AxiDraw connected?')
        process.exit(1)
      }
      port = found
    } else {
      port = rawPort
    }
    const killTimer = setTimeout(() => process.exit(0), 10_000)
    killTimer.unref()

    const ebb = await connectEbb(port)
    const v = await ebb.version()
    process.stdout.write(v + '\n')
    process.exit(0)
  },
})

// ─── home ────────────────────────────────────────────────────────────────────
// Explicit alias for `nib move --home`. Walks the arm back to tracked origin
// using software position state; resets state afterwards.

const homeCmd = defineCommand({
  meta: { name: 'home', description: 'Return the arm to the tracked origin (0,0)' },
  args: {
    port: { type: 'string', description: 'Serial port override (env: NIB_PORT)' },
  },
  async run({ args }) {
    const rawPort = args.port ?? process.env.NIB_PORT
    const portPath = rawPort || await findEbbPort()
    if (!portPath) {
      printError('No EBB device found — is the AxiDraw connected?')
      process.exit(1)
    }
    const killTimer = setTimeout(() => process.exit(0), 15_000)
    killTimer.unref()

    const state = await loadArmState()
    if (state.unknown) {
      printError(
        'arm position is unknown',
        're-enable motors with the arm parked at your intended origin: nib motors on',
      )
      process.exit(1)
    }

    const ebb = await connectEbb(portPath)
    await ebb.penUp(200)
    await ebb.enableMotors(1, 1)
    if (Math.abs(state.x) > 0.01 || Math.abs(state.y) > 0.01) {
      await ebb.move(-state.x, -state.y, MOVE_SPEED_MMS)
    }
    await resetArmState()
    process.stderr.write(`  Home → (0, 0)\n`)
    process.exit(0)
  },
})

// ─── position ────────────────────────────────────────────────────────────────

const positionCmd = defineCommand({
  meta: { name: 'position', description: 'Show the tracked arm position' },
  args: {
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    const state = await loadArmState()
    if (args.json) {
      process.stdout.write(JSON.stringify(state, null, 2) + '\n')
      return
    }
    process.stderr.write(`  Position:  ${formatPosition(state)}\n`)
    if (state.updatedAt) {
      process.stderr.write(`  Updated:   ${state.updatedAt}\n`)
    }
    if (state.unknown) {
      process.stderr.write(`  Run:  nib motors on  with the arm at your chosen origin\n`)
    }
  },
})

// ─── release ─────────────────────────────────────────────────────────────────

const releaseCmd = defineCommand({
  meta: { name: 'release', description: 'Release stepper motors so the arm moves freely' },
  args: {
    port: { type: 'string', description: 'Serial port (env: NIB_PORT, or "auto")' },
  },
  async run({ args }) {
    const rawPort = args.port ?? process.env.NIB_PORT
    let port: string
    if (!rawPort || rawPort === 'auto') {
      const found = await findEbbPort()
      if (!found) {
        printError('No EBB device found — is the AxiDraw connected?\n  Set NIB_PORT=/dev/cu.usbmodem... or NIB_PORT=auto')
        process.exit(1)
      }
      port = found
    } else {
      port = rawPort
    }

    const killTimer = setTimeout(() => process.exit(0), 10_000)
    killTimer.unref()

    const ebb = await connectEbb(port)
    await ebb.penUp()
    await ebb.disableMotors()
    // Freely-moving arm → tracked position is no longer reliable.
    await markArmUnknown()
    process.stderr.write('  Motors released — arm moves freely\n')
    process.exit(0)
  },
})

// ─── config ───────────────────────────────────────────────────────────────────

const configShowCmd = defineCommand({
  meta: { name: 'show', description: 'Show current global config' },
  args: {},
  async run() {
    const config = await loadGlobalConfig()
    process.stdout.write(JSON.stringify(config, null, 2) + '\n')
  },
})

const configSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set a config value' },
  args: {
    key:   { type: 'positional', description: 'Key: default-profile | model | port | history-limit' },
    value: { type: 'positional', description: 'Value' },
  },
  async run({ args }) {
    const config = await loadGlobalConfig()
    switch (args.key) {
      case 'default-profile': config.defaultProfile = args.value; break
      case 'model':           config.model = args.value; break
      case 'port':            config.port = args.value; break
      case 'history-limit':   config.historyLimit = parseInt(args.value, 10); break
      default:
        process.stderr.write(`Error: unknown config key "${args.key}"\n`)
        process.stderr.write(`  valid keys: default-profile, model, port, history-limit\n`)
        process.exit(2)
    }
    await saveGlobalConfig(config)
    process.stderr.write(`  ${args.key} = ${chalk.bold(args.value)}\n`)
  },
})

const configCmd = defineCommand({
  meta: { name: 'config', description: 'Show or edit global config' },
  subCommands: { show: configShowCmd, set: configSetCmd },
})

// ─── init ─────────────────────────────────────────────────────────────────────

const initCmd = defineCommand({
  meta: { name: 'init', description: 'Create axidraw.toml in current directory' },
  args: {},
  async run() {
    await writeProjectConfig()
    process.stderr.write(`  Created ${chalk.bold('axidraw.toml')}\n`)
  },
})

// ─── Root ─────────────────────────────────────────────────────────────────────

const main = defineCommand({
  meta: {
    name: 'nib',
    version: '0.1.0',
    description:
      'Ergonomic CLI for the AxiDraw plotter. Global flags: -v/--verbose, -V/--version. ' +
      'Env: NIB_PORT, NIB_PROFILE, NIB_VERBOSE.',
  },
  subCommands: {
    plot: plotCmd,
    preview: previewCmd,
    watch: watchCmd,
    profile: profileCmd,
    job: jobCmd,
    series: seriesCmd,
    calibrate: calibrateCmd,
    pen: penCmd,
    move: moveCmd,
    home: homeCmd,
    motors: motorsCmd,
    position: positionCmd,
    release: releaseCmd,
    fw: fwCmd,
    config: configCmd,
    init: initCmd,
  },
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseMmArg(val: string): number | null {
  const m = val.match(/([\d.]+)\s*(mm|cm|in)?/i)
  if (!m) return null
  const n = parseFloat(m[1])
  switch (m[2]?.toLowerCase()) {
    case 'cm': return n * 10
    case 'in': return n * 25.4
    default:   return n  // assume mm
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Top-level error handler ──────────────────────────────────────────────────
// Catches unhandled errors from runMain so users never see raw stack traces.

process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`\n${chalk.red('Error:')} ${msg}\n`)
  if (process.env.DEBUG || process.env.NIB_VERBOSE) {
    process.stderr.write(chalk.dim(err instanceof Error && err.stack ? err.stack : '') + '\n')
  } else {
    process.stderr.write(chalk.dim('  Run with DEBUG=1 for full details.\n'))
  }
  process.exit(1)
})

process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`\n${chalk.red('Error:')} ${msg}\n`)
  process.exit(1)
})

// Clean up on Ctrl-C: exit with 130 (128 + SIGINT) per POSIX convention
process.on('SIGINT', () => {
  process.stderr.write('\n')
  process.exit(130)
})

// ─── Pre-runMain argv shims ───────────────────────────────────────────────────
// Citty binds `--version` from the meta but not `-V`, and there's no native
// way to register a global `--verbose`/`-v` that propagates before any command
// runs. Handle both here so every subcommand sees the effects.

const argv = process.argv.slice(2)

// `-V` → `--version` alias (POSIX-ish convention used by many tools)
if (argv.length > 0 && argv[0] === '-V') argv[0] = '--version'

// `--verbose` / `-v` sets NIB_VERBOSE for the rest of the session so every
// EBB command prints its SM/LM payload. Strip the flag before citty parses.
for (let i = argv.length - 1; i >= 0; i--) {
  if (argv[i] === '--verbose' || argv[i] === '-v') {
    process.env.NIB_VERBOSE = '1'
    argv.splice(i, 1)
  }
}

// Splice back into process.argv so runMain sees the modified list.
process.argv.length = 2
process.argv.push(...argv)

runMain(main)
