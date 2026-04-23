import chalk from 'chalk'
import type { ResolvedProfile } from '../core/job.ts'
import type { JobSummary } from '../core/history.ts'

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export function formatDistance(meters: number): string {
  return `${meters.toFixed(1)}m`
}

export function formatProfile(profile: ResolvedProfile): string {
  const parts = [
    `${profile.speedPendown}% down`,
    `${profile.speedPenup}% up`,
    `accel ${profile.accel}%`,
  ]
  if (profile.constSpeed) parts.push('const-speed')
  return parts.join(' · ')
}

// ─── Status symbols ───────────────────────────────────────────────────────────

export function ok(msg: string): string {
  return `${chalk.green('✓')} ${msg}`
}

export function fail(msg: string): string {
  return `${chalk.red('✗')} ${msg}`
}

export function warn(msg: string): string {
  return `${chalk.yellow('⚠')} ${msg}`
}

export function active(msg: string): string {
  return `${chalk.cyan('▶')} ${msg}`
}

// ─── Error output (always to stderr) ─────────────────────────────────────────

export function printError(message: string, hint?: string): void {
  process.stderr.write(`${chalk.red('Error:')} ${message}\n`)
  if (hint) process.stderr.write(`${chalk.dim('  hint:')} ${hint}\n`)
}

export function printUsageError(message: string, hint?: string): void {
  process.stderr.write(`${chalk.red('Error:')} ${message}\n`)
  if (hint) process.stderr.write(`${chalk.dim('  hint:')} ${hint}\n`)
}

export function printWarning(message: string): void {
  process.stderr.write(`${chalk.yellow('Warning:')} ${message}\n`)
}

// ─── Plot header ──────────────────────────────────────────────────────────────

export interface PlotHeaderOpts {
  svgTitle?: string | null
  widthMm?: number | null
  heightMm?: number | null
  /** Resolved rotation in degrees (0 = no rotation). */
  rotateDeg?: number
  /** True if rotation was chosen automatically (auto-rotate). */
  rotateAuto?: boolean
  /** Human-readable reason for auto-rotation. */
  rotateReason?: string
  /** Machine name read from board EEPROM (QN), if any. */
  machineName?: string
  isDryRun?: boolean
}

export function printPlotHeader(
  file: string | null,
  profile: ResolvedProfile,
  isDryRun = false,
  opts: PlotHeaderOpts = {},
): void {
  const name = file ? file.split('/').pop()! : 'stdin'
  process.stderr.write(`\n  ${chalk.bold('nib')} — ${chalk.cyan(name)}\n`)

  // SVG title (when present and different from the filename)
  const fileBase = name.replace(/\.[^.]+$/, '')
  if (opts.svgTitle && opts.svgTitle !== fileBase && opts.svgTitle !== name) {
    process.stderr.write(`  ${chalk.dim('Title:')}    ${opts.svgTitle}\n`)
  }

  // Dimensions + orientation
  if (opts.widthMm && opts.heightMm) {
    const orientation = opts.heightMm > opts.widthMm ? 'portrait' : 'landscape'
    const dims = `${Math.round(opts.widthMm)} × ${Math.round(opts.heightMm)} mm  ·  ${orientation}`
    let rotateNote = ''
    if (opts.rotateDeg) {
      rotateNote = opts.rotateAuto
        ? chalk.dim(`  →  rotated ${opts.rotateDeg}° (auto)`)
        : chalk.dim(`  →  rotated ${opts.rotateDeg}°`)
    }
    process.stderr.write(`  ${chalk.dim('Size:')}     ${dims}${rotateNote}\n`)
  } else if (opts.rotateDeg) {
    const autoNote = opts.rotateAuto ? ' (auto)' : ''
    process.stderr.write(`  ${chalk.dim('Rotate:')}   ${opts.rotateDeg}°${autoNote}\n`)
  }

  if (opts.machineName) {
    process.stderr.write(`  ${chalk.dim('Machine:')}  ${opts.machineName}\n`)
  }

  process.stderr.write(`  ${chalk.dim('Profile:')}  ${profile.name} ${chalk.dim(`(${formatProfile(profile)})`)}\n`)

  if (isDryRun) process.stderr.write(`  ${chalk.yellow('Mode:')}     ${chalk.yellow('dry-run (no hardware)')}\n`)

  process.stderr.write('\n')
}

export function printPlotComplete(durationS: number, metrics: { pendownM: number; travelM: number; penLifts: number }, jobId: number): void {
  process.stderr.write(`  ${ok(`done in ${formatDuration(durationS)}`)}\n`)
  if (metrics.pendownM > 0) {
    process.stderr.write(
      `  ${chalk.dim(`Pen-down: ${formatDistance(metrics.pendownM)}  ·  Travel: ${formatDistance(metrics.travelM)}  ·  Lifts: ${metrics.penLifts}`)}\n`
    )
  }
  process.stderr.write(`  ${chalk.dim(`Job #${jobId} saved.`)}\n\n`)
}

// ─── Job list ─────────────────────────────────────────────────────────────────

function statusBadge(status: string): string {
  switch (status) {
    case 'complete': return chalk.green('COMPLETE')
    case 'aborted':  return chalk.red('ABORTED ')
    case 'running':  return chalk.cyan('RUNNING ')
    case 'pending':  return chalk.dim('PENDING ')
    default:         return status.toUpperCase().padEnd(8)
  }
}

export function formatJobRow(job: JobSummary): string {
  const id      = chalk.dim(`#${String(job.id).padStart(2)}`)
  const date    = job.startedAt
    ? chalk.dim(job.startedAt.toISOString().slice(0, 16).replace('T', ' '))
    : chalk.dim('                ')
  const file    = (job.file ? job.file.split('/').pop() ?? job.file : 'stdin').padEnd(24)
  const profile = job.profile.padEnd(14)
  const status  = statusBadge(job.status)
  const dur     = job.durationS > 0 ? chalk.dim(formatDuration(job.durationS)) : ''
  const stopped = job.stoppedAt !== undefined
    ? chalk.yellow(`  (stopped at ${Math.round(job.stoppedAt * 100)}%)`)
    : ''
  return `  ${id}  ${date}  ${file}  ${profile}  ${status}  ${dur}${stopped}`
}

// ─── Profile list ─────────────────────────────────────────────────────────────

export function formatProfileRow(profile: ResolvedProfile): string {
  const desc = profile.description ? `  ${chalk.dim(profile.description)}` : ''
  return `  ${chalk.bold(profile.name.padEnd(16))}  ${chalk.dim(formatProfile(profile))}${desc}`
}
