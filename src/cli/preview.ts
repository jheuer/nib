import { defineCommand } from 'citty'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import chalk from 'chalk'
import { resolveProfile, loadProjectConfig, getMachineEnvelope } from '../core/config.ts'
import { findFirstOutOfBounds } from '../core/envelope.ts'
import { svgToMoves } from '../backends/svg-to-moves.ts'
import { createJob } from '../core/job.ts'
import { runPreview, getSvgStats } from '../backends/axicli.ts'
import { previewStatsFromSvg } from '../backends/ebb-preview.ts'
import { printError, formatDuration, formatDistance } from '../tui/output.ts'
import { applyPreprocessSteps } from '../core/preprocess.ts'
import '../tui/env.ts'

function expandPath(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2))
  return resolve(process.cwd(), p)
}

export const previewCmd = defineCommand({
  meta: { name: 'preview', description: 'Simulate a plot and report stats (no hardware)' },
  args: {
    file: {
      type: 'positional',
      description: 'SVG file (use /dev/stdin to read from a pipe)',
    },
    profile: {
      type: 'string',
      alias: 'P',
      description: 'Pen profile name (env: NIB_PROFILE)',
    },
    layer: {
      type: 'string',
      description: 'Preview a single layer by ID',
    },
    open: {
      type: 'boolean',
      description: 'Open a visual preview in the browser',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output stats as JSON',
      default: false,
    },
    optimize: {
      type: 'string',
      description: 'Path reordering: 0=adjacent 1=nearest 2=with-reversal',
      default: '0',
    },
  },
  async run({ args }) {
    const profileName = args.profile ?? process.env.NIB_PROFILE
    const filePath = args.file

    // ── Read SVG ──────────────────────────────────────────────────────────────
    let svg: string
    if (filePath === '/dev/stdin') {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      svg = Buffer.concat(chunks).toString('utf-8')
    } else {
      const resolved = expandPath(filePath)
      if (!existsSync(resolved)) {
        printError(`file not found: ${filePath}`)
        process.exit(1)
      }
      svg = await readFile(resolved, 'utf-8')
    }

    // ── Fast local stats (no subprocess) ─────────────────────────────────────
    const svgStats = await getSvgStats(svg)

    // ── Resolve profile ───────────────────────────────────────────────────────
    let profile
    try {
      profile = await resolveProfile(profileName)
    } catch (err) {
      printError((err as Error).message, 'run: nib profile list')
      process.exit(1)
    }

    // ── Load project config & preprocess ─────────────────────────────────────
    const projectConfig = await loadProjectConfig()
    let processedSvg = svg
    if (projectConfig?.preprocess?.steps?.length) {
      processedSvg = applyPreprocessSteps(svg, projectConfig.preprocess.steps)
    }

    const optimizeRaw = parseInt(args.optimize, 10)
    const job = createJob({
      id: 0,
      svg: processedSvg,
      profile,
      optimize: ([0, 1, 2].includes(optimizeRaw) ? optimizeRaw : 0) as 0 | 1 | 2,
    })

    // ── Print header ──────────────────────────────────────────────────────────
    const name = filePath === '-' ? 'stdin' : (filePath.split('/').pop() ?? filePath)
    process.stderr.write(`\n  ${chalk.bold('nib preview')} — ${chalk.cyan(name)}\n`)
    process.stderr.write(`  ${chalk.dim('Profile:')}  ${profile.name} ${chalk.dim(`(${profile.speedPendown}% down · ${profile.speedPenup}% up)`)}\n\n`)

    // ── Try axicli preview, fall back to local EBB stats ─────────────────────
    let stats
    let statsSource: 'axicli' | 'local' = 'axicli'
    try {
      stats = await runPreview(processedSvg, job, {
        layer: args.layer !== undefined ? parseInt(args.layer, 10) : undefined,
      })
      // If axicli ran but produced no output (no plotter), augment with local stats
      if (stats.rawLines.length === 0) {
        const local = previewStatsFromSvg(processedSvg, profile, job.optimize)
        stats = { ...local, rawLines: stats.rawLines }
        statsSource = 'local'
      }
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('axicli') || msg.includes('Failed to run')) {
        // axicli not installed — compute entirely from SVG path analysis
        stats = previewStatsFromSvg(processedSvg, profile)
        statsSource = 'local'
      } else {
        printError(msg)
        process.exit(1)
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify({ ...stats, svgStats }, null, 2) + '\n')
      return
    }

    // ── Format stats output ───────────────────────────────────────────────────
    const rows: [string, string][] = []

    if (stats.pendownM !== null)
      rows.push(['Pen-down distance', chalk.white(`${formatDistance(stats.pendownM)}`)])

    if (stats.travelM !== null) {
      const overhead = stats.travelOverheadPct !== null
        ? chalk.dim(` (${stats.travelOverheadPct.toFixed(0)}% overhead)`)
        : ''
      rows.push(['Travel distance', `${formatDistance(stats.travelM)}${overhead}`])
    }

    if (stats.estimatedS !== null) {
      let hint = ''
      if (job.optimize === 0 && (stats.penLifts ?? 0) > 50) {
        hint = chalk.dim('  try --optimize 2 to reduce lifts')
      }
      rows.push(['Estimated time', `${chalk.white(formatDuration(stats.estimatedS))}${hint}`])
    }

    if (stats.penLifts !== null)
      rows.push(['Pen lifts', chalk.white(String(stats.penLifts))])

    if (stats.boundingBoxMm)
      rows.push(['Bounding box', chalk.white(`${stats.boundingBoxMm.width} × ${stats.boundingBoxMm.height} mm`)])

    // Paper fit
    const fits: string[] = []
    if (stats.fitsA4 !== null) fits.push(stats.fitsA4 ? chalk.green('A4 ✓') : chalk.dim('A4 ✗'))
    if (stats.fitsA3 !== null) fits.push(stats.fitsA3 ? chalk.green('A3 ✓') : chalk.dim('A3 ✗'))
    if (fits.length) rows.push(['Fits on', fits.join('  ')])

    // Machine envelope (if configured) — the physical arm travel limit.
    const envelope = await getMachineEnvelope()
    if (envelope) {
      const moves = svgToMoves(processedSvg, { tolerance: 0.1 })
      const offender = findFirstOutOfBounds(moves, envelope)
      const label = `${envelope.widthMm} × ${envelope.heightMm} mm`
      if (offender) {
        rows.push([
          'Machine',
          `${chalk.red('✗ exceeds ' + label)} ${chalk.dim(`(at ${offender.point.x.toFixed(1)}, ${offender.point.y.toFixed(1)})`)}`,
        ])
      } else {
        rows.push(['Machine', `${chalk.green('✓ fits ' + label)}`])
      }
    }

    // Always show element count from SVG parsing
    rows.push(['Elements', chalk.dim(String(svgStats.pathCount))])

    // Show SVG dimensions from parsing when axicli had nothing to report
    if (!stats.boundingBoxMm && svgStats.widthMm && svgStats.heightMm) {
      rows.push(['Size (SVG)', chalk.dim(`${svgStats.widthMm} × ${svgStats.heightMm} mm`)])
    }

    if (statsSource === 'local') {
      rows.push(['Stats source', chalk.dim('local (axicli not available)')])
    } else if (stats.rawLines.length === 0) {
      rows.push(['axicli stats', chalk.dim('(no output — plotter not connected?)')])
    }

    const labelWidth = Math.max(...rows.map(([l]) => l.length))
    for (const [label, value] of rows) {
      process.stderr.write(`  ${chalk.dim(label.padEnd(labelWidth))}   ${value}\n`)
    }
    process.stderr.write('\n')

    // ── Open browser preview ──────────────────────────────────────────────────
    if (args.open) {
      await openBrowserPreview(processedSvg, name)
    }
  },
})

function printBasicStats(stats: Awaited<ReturnType<typeof getSvgStats>>, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n')
    return
  }
  process.stderr.write(`  ${chalk.dim('Elements')}   ${stats.pathCount}\n`)
  if (stats.widthMm && stats.heightMm) {
    process.stderr.write(`  ${chalk.dim('Size')}       ${stats.widthMm} × ${stats.heightMm} mm\n`)
  }
  process.stderr.write('\n')
}

/** Generates a simple two-layer SVG (travel gray + pen-down black) and opens it */
async function openBrowserPreview(svg: string, name: string): Promise<void> {
  // Wrap original SVG paths in a container for browser display
  const previewHtml = `<!DOCTYPE html>
<html>
<head>
  <title>nib preview — ${name}</title>
  <style>
    body { background: #f5f0e8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    svg { max-width: 90vw; max-height: 90vh; border: 1px solid #ccc; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  </style>
</head>
<body>
  ${svg.replace(/<svg/, '<svg style="max-width:90vw;max-height:90vh"')}
  <p style="position:fixed;bottom:1rem;right:1rem;font-family:monospace;font-size:12px;color:#888">nib preview — ${name}</p>
</body>
</html>`

  const tmpPath = join(tmpdir(), `nib-preview-${Date.now()}.html`)
  await writeFile(tmpPath, previewHtml, 'utf-8')

  const { spawn } = await import('child_process')
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  spawn(opener, [tmpPath], { detached: true, stdio: 'ignore' }).unref()
  process.stderr.write(`  ${chalk.dim(`Opened: ${tmpPath}`)}\n\n`)
}
