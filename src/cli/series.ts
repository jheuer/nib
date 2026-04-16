import { defineCommand } from 'citty'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import chalk from 'chalk'
import { resolveProfile, loadProjectConfig, addProfileWear, penWearWarning } from '../core/config.ts'
import { createJob } from '../core/job.ts'
import { nextJobId, saveJob } from '../core/history.ts'
import { PlotEmitter } from '../core/events.ts'
import { runJobEbb } from '../backends/ebb.ts'
import { previewStatsFromSvg } from '../backends/ebb-preview.ts'
import { attachProgressBar } from '../tui/progress.ts'
import { printPlotHeader, printPlotComplete, printError, printWarning, formatDuration } from '../tui/output.ts'
import { applyPreprocessSteps, parsePaperSize } from '../core/preprocess.ts'
import { fireCompleteHook } from '../core/hooks.ts'
import '../tui/env.ts'
import readline from 'readline'

// ─── Seed parsing ─────────────────────────────────────────────────────────────

function parseSeeds(seeds: string): number[] {
  // "1-20" → [1..20]
  const rangeMatch = seeds.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1], 10)
    const to   = parseInt(rangeMatch[2], 10)
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
  }
  // "1,3,5,7" → [1,3,5,7]
  if (seeds.includes(',')) {
    return seeds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
  }
  // Single seed
  const n = parseInt(seeds, 10)
  return isNaN(n) ? [] : [n]
}

// ─── Script runner ────────────────────────────────────────────────────────────

function runScript(scriptPath: string, seed: number, extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      NIB_SEED: String(seed),
      SEED: String(seed),
      ...extraEnv,
    }

    // Use bun for .ts files, node for .js, or the script's shebang
    const isBun = scriptPath.endsWith('.ts') || existsSync(scriptPath) && scriptPath.endsWith('.mjs')
    const [cmd, ...args] = isBun
      ? ['bun', 'run', scriptPath, String(seed)]
      : ['node', scriptPath, String(seed)]

    const child = spawn(cmd, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    child.on('close', code => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`Script exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`))
      }
    })
    child.on('error', err => reject(new Error(`Failed to run script: ${err.message}`)))
  })
}

function existsSync(p: string): boolean {
  try { require('fs').accessSync(p); return true } catch { return false }
}

// ─── Edition prompt ───────────────────────────────────────────────────────────

async function promptEdition(
  editionNum: number,
  totalEditions: number,
  seed: number,
  previewLine: string,
): Promise<'plot' | 'skip' | 'quit'> {
  const WIDTH = 58
  const title = `Edition ${editionNum}/${totalEditions}  seed=${seed}`
  const top    = `┌─ ${chalk.bold(title)} ${'─'.repeat(Math.max(0, WIDTH - title.length - 4))}┐`
  const bottom = `└${'─'.repeat(WIDTH)}┘`

  function boxLine(content: string): string {
    const visLen = content.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').length
    const pad = Math.max(0, WIDTH - 2 - visLen)
    return `│ ${content}${' '.repeat(pad)} │`
  }

  process.stderr.write('\n')
  process.stderr.write(`  ${top}\n`)
  if (previewLine) process.stderr.write(`  ${boxLine(chalk.dim(previewLine))}\n`)
  process.stderr.write(`  ${bottom}\n`)

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    process.stderr.write(chalk.dim('  Paper loaded? [Enter to plot · s skip · q quit] > '))
    rl.once('line', line => {
      rl.close()
      const key = line.trim().toLowerCase()
      if (key === 'q' || key === 'quit') resolve('quit')
      else if (key === 's' || key === 'skip') resolve('skip')
      else resolve('plot')
    })
    rl.once('close', () => resolve('plot'))
  })
}

// ─── Edition ledger ───────────────────────────────────────────────────────────

interface LedgerEntry {
  edition: number
  seed: number
  jobId: number | null
  status: 'complete' | 'aborted' | 'skipped'
  durationS?: number
}

function printLedger(entries: LedgerEntry[], total: number): void {
  const plotted = entries.filter(e => e.status === 'complete').length
  process.stderr.write(`\n  ${chalk.bold('Series complete.')} ${plotted}/${total} plotted.\n\n`)

  if (entries.length === 0) return

  process.stderr.write(`  ${'Edition'.padEnd(10)}${'Seed'.padEnd(10)}${'Job'.padEnd(8)}${'Status'.padEnd(12)}${'Duration'}\n`)
  process.stderr.write(`  ${'─'.repeat(52)}\n`)

  for (const e of entries) {
    const edition  = `${e.edition}/${total}`.padEnd(10)
    const seed     = chalk.dim(String(e.seed).padEnd(10))
    const job      = e.jobId ? chalk.dim(`#${e.jobId}`.padEnd(8)) : chalk.dim('—'.padEnd(8))
    const status   = e.status === 'complete' ? chalk.green('COMPLETE'.padEnd(12))
      : e.status === 'aborted'  ? chalk.red('ABORTED'.padEnd(12))
      : chalk.dim('skipped'.padEnd(12))
    const duration = e.durationS ? chalk.dim(formatDuration(e.durationS)) : ''
    process.stderr.write(`  ${edition}${seed}${job}${status}${duration}\n`)
  }
  process.stderr.write('\n')
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const seriesCmd = defineCommand({
  meta: { name: 'series', description: 'Plot a numbered edition from a generative script' },
  args: {
    script: {
      type: 'positional',
      description: 'Script that writes SVG to stdout (receives NIB_SEED env var)',
    },
    seeds: {
      type: 'string',
      description: 'Seed range (e.g. 1-20) or comma-separated list',
    },
    count: {
      type: 'string',
      description: 'Number of editions with sequential seeds starting from 1',
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
    'preview-only': {
      type: 'boolean',
      description: 'Preview all editions without plotting',
      default: false,
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip per-edition prompts — plot without pausing',
      default: false,
    },
  },

  async run({ args }) {
    const profileName = args.profile ?? process.env.NIB_PROFILE
    const port = args.port ?? process.env.NIB_PORT
    const previewOnly = args['preview-only']

    // ── Parse seeds ───────────────────────────────────────────────────────────
    let seeds: number[]
    if (args.seeds) {
      seeds = parseSeeds(args.seeds)
    } else if (args.count) {
      const n = parseInt(args.count, 10)
      seeds = Array.from({ length: n }, (_, i) => i + 1)
    } else {
      printError('provide --seeds <range> or --count <n>')
      process.exit(2)
    }

    if (seeds.length === 0) {
      printError('no valid seeds parsed from the provided range')
      process.exit(2)
    }

    // ── Resolve profile ───────────────────────────────────────────────────────
    let profile
    try {
      profile = await resolveProfile(profileName)
    } catch (err) {
      printError((err as Error).message, 'run: nib profile list')
      process.exit(1)
    }

    const warnMsg = await penWearWarning(profile.name, 0)
    if (warnMsg) printWarning(warnMsg)

    const projectConfig = await loadProjectConfig()
    const optimize = ([0, 1, 2].includes(parseInt(args.optimize, 10))
      ? parseInt(args.optimize, 10) : 0) as 0 | 1 | 2

    const seriesId = randomUUID().slice(0, 8)

    process.stderr.write(`\n  ${chalk.bold('nib series')} — ${chalk.cyan(args.script)}\n`)
    process.stderr.write(`  ${seeds.length} editions  ·  Profile: ${chalk.bold(profile.name)}  ·  seeds: ${seeds[0]}–${seeds[seeds.length-1]}\n`)
    if (previewOnly) process.stderr.write(`  ${chalk.yellow('Preview only — no hardware')}\n`)
    process.stderr.write('\n')

    const ledger: LedgerEntry[] = []

    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]
      const editionNum = i + 1

      // ── Generate SVG ────────────────────────────────────────────────────────
      process.stderr.write(chalk.dim(`  Generating edition ${editionNum}/${seeds.length} (seed=${seed})…\r`))
      let svg: string
      try {
        svg = await runScript(args.script, seed)
        if (!svg.trim().startsWith('<')) {
          throw new Error('Script did not output SVG (expected output starting with <)')
        }
      } catch (err) {
        printError(`edition ${editionNum}: ${(err as Error).message}`)
        ledger.push({ edition: editionNum, seed, jobId: null, status: 'aborted' })
        continue
      }

      // Apply preprocessing
      let processedSvg = svg
      if (projectConfig?.preprocess?.steps?.length) {
        const paperMm = projectConfig.paper ? parsePaperSize(projectConfig.paper) ?? undefined : undefined
        processedSvg = applyPreprocessSteps(svg, projectConfig.preprocess.steps, {
          paperMm,
          marginMm: projectConfig.preprocess.marginMm,
        })
      }

      // ── Quick preview stats (best-effort) ────────────────────────────────────
      let previewLine = ''
      try {
        const stats = previewStatsFromSvg(processedSvg, profile, optimize)
        const parts: string[] = []
        if (stats.estimatedS !== null) parts.push(formatDuration(stats.estimatedS))
        if (stats.penLifts !== null)   parts.push(`${stats.penLifts} lifts`)
        if (stats.fitsA3 !== null)     parts.push(stats.fitsA3 ? 'fits A3 ✓' : 'A3 ✗')
        previewLine = parts.join('  ·  ')
      } catch { /* no preview stats — continue */ }

      process.stderr.write(' '.repeat(60) + '\r')  // clear the "Generating…" line

      if (previewOnly) {
        process.stderr.write(`  Edition ${editionNum}/${seeds.length}  seed=${seed}`)
        if (previewLine) process.stderr.write(`  ${chalk.dim(previewLine)}`)
        process.stderr.write('\n')
        ledger.push({ edition: editionNum, seed, jobId: null, status: 'skipped' })
        continue
      }

      // ── Prompt per edition ───────────────────────────────────────────────────
      if (!args.yes) {
        const action = await promptEdition(editionNum, seeds.length, seed, previewLine)
        if (action === 'quit') {
          process.stderr.write('  Quit.\n')
          break
        }
        if (action === 'skip') {
          ledger.push({ edition: editionNum, seed, jobId: null, status: 'skipped' })
          process.stderr.write(chalk.dim(`  Skipped edition ${editionNum}.\n`))
          continue
        }
      }

      // ── Plot ─────────────────────────────────────────────────────────────────
      const id = await nextJobId()
      const job = createJob({
        id,
        file: args.script,
        svg: processedSvg,
        profile,
        optimize,
        hooks: projectConfig?.hooks ?? {},
        seed,
        seriesId,
      })

      printPlotHeader(null, profile)
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
          await addProfileWear(profile.name, job.metrics.pendownM)
          await fireCompleteHook(job.hooks, {
            file: job.file,
            profile: profile.name,
            job_id: id,
            metrics: job.metrics,
          })
          ledger.push({ edition: editionNum, seed, jobId: id, status: 'complete', durationS })
        } else {
          job.stoppedAt = result.stoppedAt
          ledger.push({ edition: editionNum, seed, jobId: id, status: 'aborted' })
          process.stderr.write(`  Aborted. Stopping series.\n`)
          await saveJob(job)
          break
        }
      } catch (err) {
        const msg = (err as Error).message
        job.status = 'aborted'
        printError(msg)
        ledger.push({ edition: editionNum, seed, jobId: id, status: 'aborted' })
        await saveJob(job)
        break
      }

      await saveJob(job)

      // Prompt for paper change before next edition
      if (!args.yes && i < seeds.length - 1) {
        process.stderr.write('\n')
        await new Promise<void>(resolve => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
          process.stderr.write(chalk.dim('  Remove print, load fresh paper. [Enter when ready] > '))
          rl.once('line', () => { rl.close(); resolve() })
          rl.once('close', resolve)
        })
      }
    }

    printLedger(ledger, seeds.length)
  },
})
