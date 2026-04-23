/**
 * nib calibrate-servo — interactive servo timing calibration
 *
 * Plots a short test grid (short strokes, short travels) and guides the user
 * through tuning pen_rate_raise / pen_delay_up (drag between strokes) and
 * pen_rate_lower / pen_delay_down (missing stroke beginnings).
 *
 * Test pattern: 5×4 horizontal strokes, 5mm long, 5mm gaps between columns,
 * 8mm between rows. Fits in a 45×24mm corner of paper.
 */

import { defineCommand } from 'citty'
import readline from 'readline'
import chalk from 'chalk'
import { getProfile, saveProfile, listProfiles, DEFAULT_PROFILE } from '../core/config.ts'
import type { ResolvedProfile } from '../core/job.ts'
import { createJob } from '../core/job.ts'
import { EBBBackend, servoDurationMs } from '../backends/ebb.ts'
import { NodeSerialTransport, findEbbPort } from '../backends/node-serial.ts'
import { PlotEmitter } from '../core/events.ts'
import { printError, ok } from '../tui/output.ts'
import { isInteractive } from '../tui/env.ts'

// ─── Test SVG ─────────────────────────────────────────────────────────────────

/**
 * Generate a diagnostic test grid: N_COLS × N_ROWS horizontal strokes.
 * Short stroke length + short gap = worst case for both drag (pen not clearing)
 * and missing beginnings (pen not landing).
 */
const STROKE_MM  = 5    // stroke length — long enough to inspect start quality
const COL_GAP_MM = 5    // gap between stroke end and next stroke start
const COL_STEP   = STROKE_MM + COL_GAP_MM
const ROW_STEP   = 8    // vertical spacing between rows
const N_COLS     = 5
const N_ROWS     = 4

function generateTestSvg(): string {
  const w = (N_COLS - 1) * COL_STEP + STROKE_MM
  const h = (N_ROWS - 1) * ROW_STEP

  const paths: string[] = []
  for (let row = 0; row < N_ROWS; row++) {
    for (let col = 0; col < N_COLS; col++) {
      const x = col * COL_STEP
      const y = row * ROW_STEP
      paths.push(`<path d="M ${x},${y} H ${x + STROKE_MM}" fill="none" stroke="black" stroke-width="0.5"/>`)
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
    ...paths,
    `</svg>`,
  ].join('\n')
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const calibrateServoCmd = defineCommand({
  meta: { name: 'calibrate-servo', description: 'Tune servo raise/lower rates and delays for clean stroke transitions' },
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
  },

  async run({ args }) {
    if (!isInteractive) {
      printError('calibrate-servo requires an interactive terminal')
      process.exit(2)
    }

    // ── Resolve profile ────────────────────────────────────────────────────
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
    const base: ResolvedProfile = existing ?? { ...DEFAULT_PROFILE, name: profileName }

    // Working copies — mutated as user adjusts
    let rateRaise  = base.penRateRaise  ?? 75
    let rateLower  = base.penRateLower  ?? 50
    let delayUp    = base.penDelayUp    ?? 0
    let delayDown  = base.penDelayDown  ?? 0

    const profile = (): ResolvedProfile => ({
      ...base,
      penRateRaise: rateRaise,
      penRateLower: rateLower,
      penDelayUp:   delayUp,
      penDelayDown: delayDown,
    })

    // ── Connect ────────────────────────────────────────────────────────────
    const rawPort = args.port ?? process.env.NIB_PORT
    const portPath = rawPort || await findEbbPort()
    if (!portPath) {
      printError('No EBB device found — is the AxiDraw connected?')
      process.exit(1)
    }

    const transport = await NodeSerialTransport.connect(portPath)
    const backend = new EBBBackend(transport)
    await backend.connect()

    const svg = generateTestSvg()

    const cleanup = async () => {
      await backend.shutdown().catch(() => undefined)
      await transport.close().catch(() => undefined)
    }

    process.once('SIGINT', () => {
      setTimeout(() => process.exit(130), 3000).unref()
      cleanup().finally(() => {
        process.stderr.write('\n  Calibration cancelled.\n\n')
        process.exit(130)
      })
    })

    // ── Intro ─────────────────────────────────────────────────────────────
    process.stderr.write(`\n  ${chalk.bold('nib calibrate-servo')}  ·  ${chalk.cyan(profileName)}\n\n`)
    process.stderr.write(`  Plots a ${N_COLS}×${N_ROWS} grid of ${STROKE_MM}mm strokes with ${COL_GAP_MM}mm gaps.\n`)
    process.stderr.write(`  Fits in a ${(N_COLS - 1) * COL_STEP + STROKE_MM}×${(N_ROWS - 1) * ROW_STEP}mm corner of your paper.\n\n`)

    printTimingRow('pen_rate_raise', rateRaise, delayUp,   base.penPosUp, base.penPosDown, 'raise')
    printTimingRow('pen_rate_lower', rateLower, delayDown, base.penPosUp, base.penPosDown, 'lower')
    process.stderr.write('\n')

    const ready = await waitForEnter('  Position pen over paper corner, then press Enter to begin...')
    if (!ready) { await cleanup(); process.exit(130) }

    // ── Phase 1: drag test (raise quality) ────────────────────────────────
    let plotCount = 0

    const replot = async () => {
      plotCount++
      process.stderr.write(`\n  ${chalk.dim(`Run ${plotCount}:`)} Plotting test grid...\n`)
      const job = createJob({ svg, profile: profile(), optimize: 2 as const })
      const emitter = new PlotEmitter()
      try {
        await backend.runJob(job, emitter)
        process.stderr.write(`  ${ok('Done.')}\n`)
      } catch (err) {
        process.stderr.write(`  ${chalk.red('Error: ')}${(err as Error).message}\n`)
      }
    }

    await replot()

    // ── Raise phase ────────────────────────────────────────────────────────
    process.stderr.write(`\n  ${chalk.bold('Step 1 / 2')} — Raise quality  ${chalk.dim('(drag between strokes)')}\n`)
    process.stderr.write(`  ${'─'.repeat(54)}\n\n`)

    let fixRaise = await yesNoPrompt('  Do you see drag marks (connecting lines) between strokes?')
    while (fixRaise) {
      process.stderr.write('\n')
      printAdjustHelp('raise')
      ;({ rate: rateRaise, delay: delayUp } = await adjustLoop(rateRaise, delayUp, base.penPosUp, base.penPosDown, 'raise'))
      await replot()
      fixRaise = await yesNoPrompt('  Still seeing drag marks?')
    }
    process.stderr.write(`\n  ${ok('Raise looks good.')}\n`)

    // ── Lower phase ────────────────────────────────────────────────────────
    process.stderr.write(`\n  ${chalk.bold('Step 2 / 2')} — Lower quality  ${chalk.dim('(missing stroke beginnings)')}\n`)
    process.stderr.write(`  ${'─'.repeat(54)}\n\n`)

    let fixLower = await yesNoPrompt('  Do strokes start with ink from the very first mm?', true)
    // note: inverted — if they say NO (strokes don't start cleanly), we need to fix
    while (!fixLower) {
      process.stderr.write('\n')
      printAdjustHelp('lower')
      ;({ rate: rateLower, delay: delayDown } = await adjustLoop(rateLower, delayDown, base.penPosUp, base.penPosDown, 'lower'))
      await replot()
      fixLower = await yesNoPrompt('  Do strokes start with ink from the very first mm?', true)
    }
    process.stderr.write(`\n  ${ok('Lower looks good.')}\n`)

    // ── Summary & save ─────────────────────────────────────────────────────
    process.stderr.write(`\n  ${'─'.repeat(54)}\n`)
    const changed = (f: string, prev: number, next: number) => {
      const tag = prev !== next ? chalk.yellow(' ← changed') : ''
      process.stderr.write(`  ${f.padEnd(16)} ${chalk.bold(String(next).padStart(3))}${tag}\n`)
    }
    changed('pen_rate_raise', base.penRateRaise ?? 75, rateRaise)
    changed('pen_rate_lower', base.penRateLower ?? 50, rateLower)
    changed('pen_delay_up',   base.penDelayUp   ?? 0,  delayUp)
    changed('pen_delay_down', base.penDelayDown ?? 0,  delayDown)
    process.stderr.write(`  ${'─'.repeat(54)}\n\n`)

    const save = await confirmPrompt('  Save to profile? [y / Enter = yes · n = no] > ')
    if (!save) {
      process.stderr.write('  Not saved.\n\n')
      await cleanup()
      return
    }

    const updated = { ...base, penRateRaise: rateRaise, penRateLower: rateLower, penDelayUp: delayUp, penDelayDown: delayDown }
    delete (updated as Partial<ResolvedProfile & { name?: string }>).name
    await saveProfile(profileName, updated)
    process.stderr.write(`\n  ${ok(`profile "${chalk.bold(profileName)}" updated`)}\n\n`)
    await cleanup()
  },
})

// ─── Interactive adjustment loop ──────────────────────────────────────────────

async function adjustLoop(
  rate: number,
  delay: number,
  penPosUp: number,
  penPosDown: number,
  kind: 'raise' | 'lower',
): Promise<{ rate: number; delay: number }> {
  return new Promise(resolve => {
    const render = () => {
      const spMs = servoDurationMs(rate, penPosUp, penPosDown)
      const dir = kind === 'raise' ? 'pen_rate_raise' : 'pen_rate_lower'
      const dly = kind === 'raise' ? 'pen_delay_up  ' : 'pen_delay_down'
      process.stderr.write(
        `\r  ${chalk.cyan(dir)} ${chalk.bold(String(rate).padStart(3))}` +
        chalk.dim(` → ${spMs}ms SP`) +
        `   ${chalk.cyan(dly)} ${chalk.bold(String(delay).padStart(4))}ms` +
        '   ' + chalk.dim('[Enter = re-plot]') + '  '
      )
    }

    render()

    process.stdin.setRawMode(true)
    process.stdin.resume()

    const done = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stderr.write('\n')
      resolve({ rate, delay })
    }

    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]

        if (b === 0x03) { done(); return }          // Ctrl-C → accept current values
        if (b === 0x0d || b === 0x0a) { done(); return }  // Enter

        // Arrow left/right → rate (coarse ±5)
        // Arrow up/down    → delay (coarse ±10)
        // Shift+arrow      → fine (rate ±1, delay ±1)
        if (b === 0x1b && chunk[i + 1] === 0x5b) {
          const arrow = chunk[i + 2]
          if (arrow === 0x44) { rate  = clamp(rate  - 5, 1,   100); i += 2 }  // ←
          if (arrow === 0x43) { rate  = clamp(rate  + 5, 1,   100); i += 2 }  // →
          if (arrow === 0x41) { delay = clamp(delay + 10, 0, 1000); i += 2 }  // ↑
          if (arrow === 0x42) { delay = clamp(delay - 10, 0, 1000); i += 2 }  // ↓
          // Shift+arrow: CSI 1;2 A/B/C/D
          if (arrow === 0x31 && chunk[i + 3] === 0x3b && chunk[i + 4] === 0x32) {
            const shifted = chunk[i + 5]
            if (shifted === 0x44) { rate  = clamp(rate  - 1, 1,   100); i += 5 }
            if (shifted === 0x43) { rate  = clamp(rate  + 1, 1,   100); i += 5 }
            if (shifted === 0x41) { delay = clamp(delay + 1, 0, 1000); i += 5 }
            if (shifted === 0x42) { delay = clamp(delay - 1, 0, 1000); i += 5 }
          }
          render(); continue
        }
      }
    }

    process.stdin.on('data', onData)
  })
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function printTimingRow(
  field: string,
  rate: number,
  delay: number,
  penPosUp: number,
  penPosDown: number,
  kind: 'raise' | 'lower',
): void {
  const spMs = servoDurationMs(rate, penPosUp, penPosDown)
  const delayField = kind === 'raise' ? 'pen_delay_up' : 'pen_delay_down'
  process.stderr.write(
    `  ${chalk.dim(field.padEnd(16))} ${chalk.bold(String(rate).padStart(3))}` +
    chalk.dim(` → ${spMs}ms SP`) +
    `   ${chalk.dim(delayField.padEnd(14))} ${chalk.bold(String(delay).padStart(4))}ms\n`
  )
}

function printAdjustHelp(kind: 'raise' | 'lower'): void {
  const rateField = kind === 'raise' ? 'pen_rate_raise' : 'pen_rate_lower'
  const delayField = kind === 'raise' ? 'pen_delay_up' : 'pen_delay_down'
  const rateTip = kind === 'raise'
    ? 'lower = servo rises more slowly = more time to clear paper'
    : 'lower = servo descends more slowly = softer landing'
  process.stderr.write(chalk.dim(
    `  ←/→ adjust ${rateField} ±5   ↑/↓ adjust ${delayField} ±10ms\n` +
    `  Shift+arrow = ±1 fine   Enter = re-plot with current values\n` +
    `  Tip: ${rateTip}\n\n`
  ))
}

// ─── Input helpers ────────────────────────────────────────────────────────────

async function yesNoPrompt(question: string, invert = false): Promise<boolean> {
  process.stderr.write(`\n  ${question} [y/n] `)
  return new Promise(resolve => {
    process.stdin.setRawMode(true)
    process.stdin.resume()

    const teardown = (result: boolean) => {
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stderr.write(result !== invert ? chalk.green(' yes\n') : chalk.dim(' no\n'))
      resolve(result)
    }

    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]
        if (b === 0x03) { teardown(invert); return }          // Ctrl-C = no
        if (b === 0x79 || b === 0x59) { teardown(true); return }   // y/Y
        if (b === 0x6e || b === 0x4e) { teardown(false); return }  // n/N
        if (b === 0x0d || b === 0x0a) { teardown(invert); return } // Enter = default
      }
    }
    process.stdin.on('data', onData)
  })
}

function linePrompt(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    process.stderr.write(question)
    rl.once('line', (line: string) => { resolve(line); rl.close() })
    rl.once('close', () => resolve(''))
  })
}

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
        if (b === 0x6e || b === 0x4e) { teardown(); process.stderr.write('\n'); resolve(false); return }
        if (b === 0x0d || b === 0x0a || b === 0x79 || b === 0x59) {
          teardown(); process.stderr.write('\n'); resolve(true); return
        }
      }
    }
    process.stdin.on('data', onData)
  })
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
