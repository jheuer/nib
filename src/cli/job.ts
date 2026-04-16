import { defineCommand } from 'citty'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { listJobs, loadJob, saveJob, nextJobId } from '../core/history.ts'
import { createJob } from '../core/job.ts'
import { PlotEmitter } from '../core/events.ts'
import { runJobEbb } from '../backends/ebb.ts'
import { attachProgressBar } from '../tui/progress.ts'
import { formatJobRow, printError, printPlotHeader, printPlotComplete } from '../tui/output.ts'

const list = defineCommand({
  meta: { name: 'list', description: 'List past jobs' },
  args: {
    limit: { type: 'string',  description: 'Max jobs to show', default: '20' },
    json:  { type: 'boolean', description: 'Output as JSON',   default: false },
  },
  async run({ args }) {
    const jobs = await listJobs(parseInt(args.limit, 10))
    if (jobs.length === 0) {
      process.stderr.write('  No jobs yet.\n')
      return
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(jobs, null, 2) + '\n')
      return
    }
    process.stderr.write(
      chalk.dim('   #     Date              File                      Profile         Status    Duration\n')
    )
    process.stderr.write(chalk.dim('   ' + '─'.repeat(85) + '\n'))
    for (const job of jobs) {
      process.stderr.write(formatJobRow(job) + '\n')
    }
  },
})

const show = defineCommand({
  meta: { name: 'show', description: 'Show full details for a job' },
  args: {
    id: { type: 'positional', description: 'Job ID' },
  },
  async run({ args }) {
    const job = await loadJob(parseInt(args.id, 10))
    if (!job) {
      printError(`job #${args.id} not found`)
      process.exit(1)
    }
    process.stdout.write(JSON.stringify(job, null, 2) + '\n')
  },
})

const resume = defineCommand({
  meta: { name: 'resume', description: 'Resume an aborted job' },
  args: {
    id: {
      type: 'string',
      description: 'Job ID (omit to resume the most recent aborted job)',
    },
    port: {
      type: 'string',
      description: 'Serial port override (env: NIB_PORT)',
    },
  },
  async run({ args }) {
    const port = args.port ?? process.env.NIB_PORT

    // ── Find the job ──────────────────────────────────────────────────────────
    let sourceJob
    if (args.id) {
      sourceJob = await loadJob(parseInt(args.id, 10))
      if (!sourceJob) {
        printError(`job #${args.id} not found`)
        process.exit(1)
      }
    } else {
      // Most recent aborted job
      const all = await listJobs(50)
      const aborted = all.find(j => j.status === 'aborted')
      if (!aborted) {
        process.stderr.write('  No aborted jobs found.\n')
        return
      }
      sourceJob = await loadJob(aborted.id)
      if (!sourceJob) {
        printError(`failed to load job #${aborted.id}`)
        process.exit(1)
      }
    }

    if (sourceJob.status !== 'aborted') {
      printError(`job #${sourceJob.id} is not aborted (status: ${sourceJob.status})`)
      process.exit(1)
    }

    // ── Re-read the original SVG ──────────────────────────────────────────────
    if (!sourceJob.file) {
      printError('cannot resume a job piped from stdin (no file path saved)')
      process.exit(1)
    }

    if (!existsSync(sourceJob.file)) {
      printError(
        `original file no longer exists: ${sourceJob.file}`,
        'move the file back to its original location and try again',
      )
      process.exit(1)
    }

    const svg = await readFile(sourceJob.file, 'utf-8')

    // ── Create a new job with the same settings ───────────────────────────────
    const newId = await nextJobId()
    const job = createJob({
      id: newId,
      file: sourceJob.file,
      svg,
      profile: sourceJob.profile,
      layers: sourceJob.layers,
      copies: sourceJob.copies,
      optimize: sourceJob.optimize,
      guided: true,   // guided = true so operator can skip already-completed layers
      hooks: sourceJob.hooks,
      backend: sourceJob.backend,
    })

    const stoppedPct = sourceJob.stoppedAt !== undefined
      ? Math.round(sourceJob.stoppedAt * 100)
      : 0

    process.stderr.write(`\n  ${chalk.bold('nib job resume')} — ${chalk.dim(`#${sourceJob.id}`)} → ${chalk.dim(`#${newId}`)}\n`)
    process.stderr.write(`  ${chalk.dim(`Original job stopped at ${stoppedPct}%. Replaying in guided mode — skip layers already plotted.`)}\n\n`)

    printPlotHeader(job.file, job.profile)

    const emitter = new PlotEmitter()
    attachProgressBar(emitter)

    const startedAt = new Date()
    job.status = 'running'
    job.startedAt = startedAt
    await saveJob(job)

    try {
      const result = await runJobEbb(job, emitter, {
        port,
        startFrom: sourceJob.stoppedAt,
      })

      const durationS = (Date.now() - startedAt.getTime()) / 1000
      job.status = result.aborted ? 'aborted' : 'complete'
      job.completedAt = new Date()
      job.metrics.durationS = durationS

      if (!result.aborted) {
        emitter.emit('complete', job.metrics)
        printPlotComplete(durationS, job.metrics, newId)
      } else {
        job.stoppedAt = result.stoppedAt
        process.stderr.write(`  Aborted at ${Math.round(result.stoppedAt * 100)}%. Job #${newId} saved.\n\n`)
      }
    } catch (err) {
      const msg = (err as Error).message
      job.status = 'aborted'
      printError(msg)
      process.exitCode = 1
    } finally {
      await saveJob(job)
    }
  },
})

export const jobCmd = defineCommand({
  meta: { name: 'job', description: 'View and manage past jobs' },
  subCommands: { list, show, resume },
})
