/**
 * `nib calibrate speed <profile>` — interactive speed discovery.
 *
 * Plots a sequence of small test patterns at increasing pen-down speeds,
 * then asks the user which one was the last clean-looking result. Records
 * that speed (× 0.9 safety margin) as the profile's speedCapMms, so the
 * profile's speedPendown percentage thereafter maps to a speed this rig +
 * pen + paper is known to handle.
 *
 * Test pattern design: a tight zigzag (many 180° reversals stress accel
 * and junction-velocity handling) + a cruise line (tests sustained top
 * speed). 18×18mm per pattern, patterns chained left-to-right across
 * the page.
 */

import { defineCommand } from 'citty'
import chalk from 'chalk'
import readline from 'readline'
import { getProfile, saveProfile, listProfiles, loadGlobalConfig, DEFAULT_PROFILE } from '../core/config.ts'
import { connectEbb, findEbbPort } from '../backends/node-serial.ts'
import { EBBBackend } from '../backends/ebb.ts'
import { PlotEmitter } from '../core/events.ts'
import { printError, ok } from '../tui/output.ts'
import { resetArmState, markArmUnknown } from '../core/state.ts'
import type { Stroke } from '../core/stroke.ts'
import type { ResolvedProfile } from '../core/job.ts'

// ─── Pattern generation ───────────────────────────────────────────────────────

const PATTERN_SIZE_MM = 18
const PATTERN_SPACING_MM = 4

/**
 * Build a test pattern at the given origin. Combines a tight-zigzag fill
 * (stresses accel and 180° junctions) with a long diagonal cruise line
 * (stresses max sustained speed).
 */
function buildPattern(originX: number, originY: number): Stroke[] {
  const s = PATTERN_SIZE_MM
  const rowPitch = 1.5   // mm between zigzag rows
  const strokes: Stroke[] = []

  // Zigzag: horizontal lines with 180° reversals at each end.
  const zigPoints: { x: number; y: number }[] = []
  let x = 0
  let y = 0
  while (y < s * 0.7) {
    zigPoints.push({ x: originX + x, y: originY + y })
    x = (x === 0 ? s : 0)
    zigPoints.push({ x: originX + x, y: originY + y })
    y += rowPitch
  }
  strokes.push({ points: zigPoints })

  // Diagonal cruise line — tests max sustained speed.
  strokes.push({
    points: [
      { x: originX,     y: originY + s },
      { x: originX + s, y: originY + s * 0.72 },
    ],
  })

  return strokes
}

/**
 * Label above a pattern — a small Hershey-free numeric marker drawn with
 * short strokes.
 */
function buildLabel(originX: number, originY: number, n: number): Stroke[] {
  // 7-segment-ish digit rendering, 6mm tall × 3mm wide.
  const h = 6, w = 3
  const tl = { x: originX,     y: originY }
  const tr = { x: originX + w, y: originY }
  const ml = { x: originX,     y: originY + h / 2 }
  const mr = { x: originX + w, y: originY + h / 2 }
  const bl = { x: originX,     y: originY + h }
  const br = { x: originX + w, y: originY + h }

  const seg = (a: typeof tl, b: typeof tr): Stroke => ({ points: [a, b] })
  const segmentMap: Record<number, Stroke[]> = {
    1: [seg(tr, br)],
    2: [seg(tl, tr), seg(tr, mr), seg(mr, ml), seg(ml, bl), seg(bl, br)],
    3: [seg(tl, tr), seg(tr, br), seg(br, bl), seg(mr, ml)],
    4: [seg(tl, ml), seg(ml, mr), seg(tr, br)],
    5: [seg(tr, tl), seg(tl, ml), seg(ml, mr), seg(mr, br), seg(br, bl)],
    6: [seg(tr, tl), seg(tl, bl), seg(bl, br), seg(br, mr), seg(mr, ml)],
    7: [seg(tl, tr), seg(tr, br)],
    8: [seg(tl, tr), seg(tr, br), seg(br, bl), seg(bl, tl), seg(ml, mr)],
    9: [seg(ml, tl), seg(tl, tr), seg(tr, br), seg(br, bl)],
  }
  return segmentMap[n] ?? [seg(tl, br)]
}

// ─── Command ──────────────────────────────────────────────────────────────────

/**
 * Speed schedule — mm/s samples from slow/conservative to aggressive.
 * Stops at 120 mm/s because above that the V3 mechanics start skipping
 * steps on pure-X motion; better to let users add higher samples manually
 * if they have a stiffer rig.
 */
const SPEED_SCHEDULE_MMS = [20, 30, 45, 60, 80, 100, 120]

export const calibrateSpeedCmd = defineCommand({
  meta: {
    name: 'calibrate-speed',
    description: 'Interactive speed discovery — plots test patterns and records the safe max speed for a profile',
  },
  args: {
    profile: { type: 'positional', description: 'Profile name to tune (optional — defaults to NIB_PROFILE / global default)', required: false },
    port:    { type: 'string', description: 'Serial port (env: NIB_PORT)' },
    yes:     { type: 'boolean', alias: 'y', description: 'Skip prompts', default: false },
  },
  async run({ args }) {
    // Resolve profile name: arg → NIB_PROFILE env → global default → prompt
    let profileName: string = args.profile?.trim() ?? ''
    if (!profileName) profileName = process.env.NIB_PROFILE ?? ''
    if (!profileName) profileName = (await loadGlobalConfig()).defaultProfile ?? ''

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
    const profile = existing ?? { ...DEFAULT_PROFILE, name: profileName }
    if (!existing) {
      process.stderr.write(`  Profile "${profileName}" not found — will create from defaults after calibration.\n`)
    }

    const rawPort = args.port ?? process.env.NIB_PORT
    const portPath = rawPort || await findEbbPort()
    if (!portPath) {
      printError('No EBB device found — is the AxiDraw connected?')
      process.exit(1)
    }

    // ── Brief the user ──────────────────────────────────────────────────────
    process.stderr.write(`\n  ${chalk.bold('nib calibrate speed')} — ${chalk.cyan(profile.name)}\n`)
    process.stderr.write(`  Will plot ${SPEED_SCHEDULE_MMS.length} numbered patterns, each ${PATTERN_SIZE_MM}mm wide.\n`)
    process.stderr.write(`  Total plot area: ~${(SPEED_SCHEDULE_MMS.length * (PATTERN_SIZE_MM + PATTERN_SPACING_MM))}mm wide × ${PATTERN_SIZE_MM + 8}mm tall.\n`)
    process.stderr.write(`  Speeds tested (mm/s): ${SPEED_SCHEDULE_MMS.join(', ')}\n\n`)
    process.stderr.write(`  Park the arm at your intended origin (top-left of a test sheet),\n`)
    process.stderr.write(`  then press Enter. Ctrl-C to abort.\n`)

    if (!args.yes) {
      await waitForEnter()
    }

    // ── Plot each pattern at its target speed ───────────────────────────────
    const transport = await (await import('../backends/node-serial.ts')).NodeSerialTransport.connect(portPath)
    const backend = new EBBBackend(transport)
    await backend.connect()

    process.on('SIGINT', async () => {
      await backend.shutdown().catch(() => undefined)
      await markArmUnknown()
      await transport.close().catch(() => undefined)
      process.stderr.write('\n  Calibration aborted.\n')
      process.exit(130)
    })

    try {
      // Plot each pattern independently with its own per-stroke profile
      // override so the effective pen-down speed matches the schedule.
      for (let i = 0; i < SPEED_SCHEDULE_MMS.length; i++) {
        const targetMms = SPEED_SCHEDULE_MMS[i]
        const runProfile: ResolvedProfile = {
          ...profile,
          // Pin speedCapMms to the target; profile.speedPendown% is applied
          // against it, so 100% = the target speed.
          speedCapMms: targetMms,
          speedPendown: 100,
          // Keep profile.accel as-is so we isolate the speed variable.
        }
        const originX = i * (PATTERN_SIZE_MM + PATTERN_SPACING_MM)
        const label = buildLabel(originX, 0, i + 1)
        const pattern = buildPattern(originX, 8)
        const strokes = [...label, ...pattern]

        process.stderr.write(`  Plotting #${i + 1} at ${targetMms} mm/s...\n`)
        const emitter = new PlotEmitter()
        await backend.runStrokes(runProfile, strokes, emitter, undefined, { optimize: 0 })
      }
    } finally {
      await backend.shutdown().catch(() => undefined)
      await resetArmState()
      await transport.close().catch(() => undefined)
    }

    // ── Ask which was the last clean one ─────────────────────────────────────
    process.stderr.write(`\n  ${ok('Plot complete.')} Examine the patterns on paper.\n\n`)
    process.stderr.write(`  Look for the last pattern that:\n`)
    process.stderr.write(`    - lines are crisp, not wavy or broken\n`)
    process.stderr.write(`    - corners end where they should (no overshoot)\n`)
    process.stderr.write(`    - no missed strokes\n\n`)

    const pick = await askNumber(
      `  Last clean pattern number (1-${SPEED_SCHEDULE_MMS.length}): `,
      1, SPEED_SCHEDULE_MMS.length,
    )
    const clean = SPEED_SCHEDULE_MMS[pick - 1]
    const safe = Math.round(clean * 0.9)

    // ── Save to profile ─────────────────────────────────────────────────────
    const updated = { ...profile, speedCapMms: safe }
    delete (updated as Partial<ResolvedProfile> & { name?: string }).name
    await saveProfile(profile.name, updated)

    process.stderr.write(`\n  ${ok(`Profile "${profile.name}" updated:`)}\n`)
    process.stderr.write(`    speed_cap_mms = ${safe} mm/s  (90% of ${clean}, the last clean pattern)\n`)
    process.stderr.write(`\n  Your profile's speedPendown % now scales against ${safe} mm/s.\n`)
    process.stderr.write(`  Example: speed_pendown = 80% → ${Math.round(safe * 0.8)} mm/s pen-down.\n\n`)
  },
})

// ─── Small input helpers ──────────────────────────────────────────────────────

function linePrompt(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    process.stderr.write(question)
    rl.once('line', (line: string) => { rl.close(); resolve(line) })
    rl.once('close', () => resolve(''))
    // Ctrl-C while waiting for input: close readline and exit cleanly.
    process.once('SIGINT', () => { rl.close(); process.stderr.write('\n'); process.exit(130) })
  })
}

function waitForEnter(): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    rl.once('line', () => { rl.close(); resolve() })
  })
}

function askNumber(prompt: string, min: number, max: number): Promise<number> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    const ask = () => {
      process.stderr.write(prompt)
      rl.once('line', (line) => {
        const n = parseInt(line.trim(), 10)
        if (!isNaN(n) && n >= min && n <= max) {
          rl.close()
          resolve(n)
        } else {
          process.stderr.write(`  Enter a number between ${min} and ${max}.\n`)
          ask()
        }
      })
    }
    ask()
  })
}
