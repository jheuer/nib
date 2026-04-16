import { defineCommand } from 'citty'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import readline from 'readline'
import chalk from 'chalk'
import chokidar from 'chokidar'
import { resolveProfile, loadProjectConfig } from '../core/config.ts'
import type { ResolvedProfile } from '../core/job.ts'
import { createJob } from '../core/job.ts'
import { nextJobId, saveJob } from '../core/history.ts'
import { PlotEmitter } from '../core/events.ts'
import { getSvgStats, type SvgStats } from '../backends/axicli.ts'
import { runJobEbb } from '../backends/ebb.ts'
import { previewStatsFromSvg } from '../backends/ebb-preview.ts'
import { attachProgressBar } from '../tui/progress.ts'
import { printPlotHeader, printPlotComplete, printError, formatDuration } from '../tui/output.ts'
import { applyPreprocessSteps } from '../core/preprocess.ts'
import '../tui/env.ts'

function expandPath(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2))
  return resolve(process.cwd(), p)
}

function formatDiff(label: string, prev: number | null, next: number | null, unit = ''): string {
  if (prev === null && next === null) return ''
  if (prev === null || next === null) return `  ${chalk.dim(label.padEnd(14))}   ${next ?? prev}${unit}`
  if (prev === next) return `  ${chalk.dim(label.padEnd(14))}   ${chalk.dim('unchanged')}`
  const delta = next - prev
  const sign = delta > 0 ? '+' : ''
  const color = delta > 0 ? chalk.yellow : chalk.green
  return `  ${chalk.dim(label.padEnd(14))}   ${prev}${unit} → ${next}${unit}  ${color(`(${sign}${delta})`)}`
}

async function askLine(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    process.stderr.write(prompt)
    rl.once('line', line => { rl.close(); resolve(line.trim().toLowerCase()) })
    rl.once('close', () => resolve(''))
  })
}

export const watchCmd = defineCommand({
  meta: { name: 'watch', description: 'Re-plot when the source SVG changes' },
  args: {
    file: {
      type: 'positional',
      description: 'SVG file to watch',
    },
    profile: {
      type: 'string',
      alias: 'P',
      description: 'Pen profile name (env: NIB_PROFILE)',
    },
    optimize: {
      type: 'string',
      description: 'Path reordering: 0=adjacent 1=nearest 2=with-reversal',
      default: '0',
    },
    port: {
      type: 'string',
      description: 'Serial port override (env: NIB_PORT)',
    },
  },
  async run({ args }) {
    const profileName = args.profile ?? process.env.NIB_PROFILE
    const port = args.port ?? process.env.NIB_PORT
    const filePath = expandPath(args.file)

    if (!existsSync(filePath)) {
      printError(`file not found: ${args.file}`)
      process.exit(1)
    }

    let profile: ResolvedProfile
    try {
      profile = await resolveProfile(profileName)
    } catch (err) {
      printError((err as Error).message, 'run: nib profile list')
      process.exit(1)
    }

    const projectConfig = await loadProjectConfig()
    const optimize = ([0, 1, 2].includes(parseInt(args.optimize, 10))
      ? parseInt(args.optimize, 10) : 0) as 0 | 1 | 2

    // Track previous stats for diff display
    const firstSvg = await readFile(filePath, 'utf-8')
    let prevStats: SvgStats = await getSvgStats(firstSvg)

    process.stderr.write(`\n  ${chalk.bold('nib watch')} — ${chalk.cyan(args.file)}\n`)
    process.stderr.write(`  Profile: ${chalk.bold(profile.name)}  ·  plots on save\n`)
    process.stderr.write(chalk.dim('  Ctrl-C to stop watching\n\n'))

    // Debounce: ignore rapid saves (editor writing temp files, etc.)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let isPlotting = false

    const watcher = chokidar.watch(filePath, {
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    })

    watcher.on('change', () => {
      if (isPlotting) {
        process.stderr.write(chalk.dim('  (file changed during plot — will check after)\n'))
        return
      }
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => handleChange(), 150)
    })

    process.on('SIGINT', () => {
      watcher.close()
      process.stderr.write('\n  Watch stopped.\n')
      process.exit(0)
    })

    // Keep process alive
    await new Promise<void>(() => { /* resolved by SIGINT above */ })

    async function handleChange(): Promise<void> {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false })
      process.stderr.write(`\n  ${chalk.dim(`[${time}]`)} ${chalk.cyan(args.file)} changed\n`)

      const newSvg = await readFile(filePath, 'utf-8').catch(() => null)
      if (!newSvg) return

      const newStats = await getSvgStats(newSvg)

      // ── Show diff ──────────────────────────────────────────────────────────
      const pathDiff = formatDiff('Paths', prevStats.pathCount, newStats.pathCount)
      if (pathDiff) process.stderr.write(pathDiff + '\n')

      const prevBB = prevStats.widthMm && prevStats.heightMm
        ? `${prevStats.widthMm} × ${prevStats.heightMm} mm` : null
      const newBB  = newStats.widthMm && newStats.heightMm
        ? `${newStats.widthMm} × ${newStats.heightMm} mm` : null
      if (prevBB !== newBB) {
        process.stderr.write(`  ${chalk.dim('Bounding box')}   ${prevBB ?? '?'} → ${newBB ?? '?'}\n`)
      } else if (prevBB) {
        process.stderr.write(`  ${chalk.dim('Bounding box')}   ${chalk.dim('unchanged')}\n`)
      }

      process.stderr.write('\n')

      // ── Prompt ─────────────────────────────────────────────────────────────
      const answer = await askLine(
        chalk.dim('  Plot now? [y · n · p preview] > ')
      )

      if (answer === 'n' || answer === 'no') {
        process.stderr.write(chalk.dim('  Skipped.\n'))
        prevStats = newStats
        return
      }

      if (answer === 'p' || answer === 'preview') {
        await showPreview(newSvg, profile, optimize)
        const answer2 = await askLine(chalk.dim('  Plot now? [y · n] > '))
        if (answer2 !== 'y' && answer2 !== 'yes') {
          process.stderr.write(chalk.dim('  Skipped.\n'))
          prevStats = newStats
          return
        }
      }

      // ── Plot ───────────────────────────────────────────────────────────────
      isPlotting = true
      prevStats = newStats

      let processedSvg = newSvg
      if (projectConfig?.preprocess?.steps?.length) {
        processedSvg = applyPreprocessSteps(newSvg, projectConfig.preprocess.steps)
      }

      const id = await nextJobId()
      const job = createJob({
        id,
        file: filePath,
        svg: processedSvg,
        profile,
        optimize,
        hooks: projectConfig?.hooks ?? {},
      })

      printPlotHeader(job.file, profile)

      const emitter = new PlotEmitter()
      attachProgressBar(emitter)

      const startedAt = new Date()
      job.status = 'running'
      job.startedAt = startedAt
      await saveJob(job)

      try {
        const result = await runJobEbb(job, emitter, { port })
        const durationS = (Date.now() - startedAt.getTime()) / 1000
        job.status = result.aborted ? 'aborted' : 'complete'
        job.completedAt = new Date()
        job.metrics.durationS = durationS
        if (!result.aborted) {
          emitter.emit('complete', job.metrics)
          printPlotComplete(durationS, job.metrics, id)
        }
      } catch (err) {
        const msg = (err as Error).message
        job.status = 'aborted'
        printError(msg)
      } finally {
        await saveJob(job)
        isPlotting = false
        process.stderr.write(chalk.dim(`  Watching ${args.file}…\n`))
      }
    }
  },
})

async function showPreview(
  svg: string,
  profile: Awaited<ReturnType<typeof resolveProfile>>,
  optimize: 0 | 1 | 2,
): Promise<void> {
  try {
    const stats = previewStatsFromSvg(svg, profile, optimize)
    if (stats.estimatedS !== null) {
      process.stderr.write(`  ${chalk.dim('Est. time:')}    ${chalk.white(formatDuration(stats.estimatedS))}\n`)
    }
    if (stats.pendownM !== null) {
      process.stderr.write(`  ${chalk.dim('Pen-down:')}     ${stats.pendownM.toFixed(1)}m\n`)
    }
    if (stats.penLifts !== null) {
      process.stderr.write(`  ${chalk.dim('Pen lifts:')}    ${stats.penLifts}\n`)
    }
    process.stderr.write('\n')
  } catch {
    process.stderr.write(chalk.dim('  (preview unavailable)\n\n'))
  }
}
