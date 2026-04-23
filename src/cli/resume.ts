import { defineCommand } from 'citty'
import chalk from 'chalk'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import {
  resolveProfile, addProfileWear,
  saveResumeState, loadResumeState, clearResumeState,
} from '../core/config.ts'
import { createJob } from '../core/job.ts'
import { nextJobId, saveJob } from '../core/history.ts'
import { PlotEmitter } from '../core/events.ts'
import { runJobEbb } from '../backends/ebb.ts'
import { attachProgressBar } from '../tui/progress.ts'
import { printPlotHeader, printPlotComplete, printError } from '../tui/output.ts'
import { resetArmState, markArmUnknown } from '../core/state.ts'
import { promptPause } from '../tui/guided.ts'

export const resumeCmd = defineCommand({
  meta: { name: 'resume', description: 'Continue the last paused or aborted plot' },
  args: {
    yes:  { type: 'boolean', alias: 'y', description: 'Skip confirmation', default: false },
    port: { type: 'string',  description: 'Serial port override (env: NIB_PORT)' },
  },
  async run({ args }) {
    const stateRaw = await loadResumeState()
    if (!stateRaw) {
      process.stderr.write('  No resume state found — nothing to resume.\n')
      process.stderr.write('  (Resume state is saved when you press Ctrl-C and choose to stop.)\n')
      process.exit(0)
    }
    // Capture non-null to preserve TypeScript narrowing through closures.
    const state = stateRaw

    const pct      = Math.round(state.stoppedAt * 100)
    const dateStr  = new Date(state.timestamp).toLocaleString()
    const fileName = state.file ? state.file : '(stdin — not resumable)'

    process.stderr.write('\n')
    process.stderr.write(`  ${chalk.bold('Last interrupted plot')}\n`)
    process.stderr.write(`  File:     ${fileName}\n`)
    process.stderr.write(`  Profile:  ${state.profile ?? '(default)'}\n`)
    process.stderr.write(`  Stopped:  ${pct}%  (${dateStr})\n`)
    if (state.layer !== undefined) process.stderr.write(`  Layer:    ${state.layer}\n`)
    process.stderr.write('\n')

    if (!state.file) {
      printError('Cannot resume — original plot was read from stdin (no file path saved)')
      process.exit(1)
    }

    if (!args.yes) {
      process.stderr.write(`  Resume from ${pct}%? [Y/n] `)
      const answer = await readLine()
      if (answer.trim().toLowerCase() === 'n') {
        process.stderr.write('  Cancelled.\n')
        process.exit(0)
      }
    }

    const filePath = resolve(state.file)
    if (!existsSync(filePath)) {
      printError(`Cannot resume — file no longer exists: ${filePath}`)
      process.exit(1)
    }

    const svg = await readFile(filePath, 'utf-8')

    const profileResult = await resolveProfile(state.profile ?? undefined).catch((err: Error) => {
      printError(err.message, 'run: nib profile list')
      process.exit(1)
    })
    const profile = profileResult!

    const port = args.port ?? process.env.NIB_PORT
    const id   = await nextJobId()

    const job = createJob({
      id,
      file: filePath,
      svg,
      profile,
      layers: [],
      copies: 1,
      optimize: state.optimize,
      guided: false,
      hooks: {},
    })

    printPlotHeader(filePath, profile, false)
    process.stderr.write(`  ${chalk.dim('Resuming from')} ${pct}%  ${chalk.dim('(homing first)')}\n\n`)

    const emitter = new PlotEmitter()
    attachProgressBar(emitter)

    const startedAt = new Date()
    job.status = 'running'
    job.startedAt = startedAt
    await saveJob(job)

    // Override SIGINT during plot: first ^C pauses, second is hard quit.
    const controller = new AbortController()
    let pauseHandled = false
    process.removeAllListeners('SIGINT')
    process.on('SIGINT', () => {
      if (pauseHandled) { process.stderr.write('\n  Force quit.\n'); process.exit(130) }
      pauseHandled = true
      process.stderr.write(`\n  ${chalk.yellow('Pausing')} — stopping motors (press Ctrl-C again to force-quit)…\n`)
      controller.abort()
    })

    try {
      const result = await runJobEbb(
        job, emitter,
        {
          port,
          startFrom:    state.stoppedAt,
          homeBeforeRun: true,
          rotateDeg:    state.rotateDeg,
          translateMm:  { x: state.translateX, y: state.translateY },
          simplifyMm:   state.simplifyMm,
          layer:        state.layer,
        },
        controller.signal,
      )

      if (result.aborted) {
        job.status = 'aborted'
        job.stoppedAt = result.stoppedAt
        const choice = await promptPause(result.stoppedAt)
        if (choice === 'resume') {
          process.stderr.write(`  Homing, then resuming from ${Math.round(result.stoppedAt * 100)}%…\n`)
          // In-session re-resume: update state and restart
          await saveResumeState({ ...state, file: state.file ?? null, profile: state.profile ?? null, stoppedAt: result.stoppedAt, timestamp: new Date().toISOString() })
          const emitter2 = new PlotEmitter()
          attachProgressBar(emitter2)
          const result2 = await runJobEbb(job, emitter2, {
            port, startFrom: result.stoppedAt, homeBeforeRun: true,
            rotateDeg: state.rotateDeg, translateMm: { x: state.translateX, y: state.translateY },
            simplifyMm: state.simplifyMm, layer: state.layer,
          })
          if (!result2.aborted) {
            await finishSuccessful()
          } else {
            await handleAbort(result2.stoppedAt)
          }
        } else {
          await handleAbort(result.stoppedAt)
        }
        return
      }

      await finishSuccessful()
    } catch (err) {
      printError((err as Error).message)
      job.status = 'aborted'
      await markArmUnknown()
      await saveJob(job)
      process.exitCode = 1
    } finally {
      process.removeAllListeners('SIGINT')
      process.on('SIGINT', () => { process.stderr.write('\n'); process.exit(130) })
    }

    async function finishSuccessful() {
      const durationS = (Date.now() - startedAt.getTime()) / 1000
      job.status = 'complete'
      job.completedAt = new Date()
      job.metrics.durationS = durationS
      printPlotComplete(durationS, job.metrics, id)
      await resetArmState()
      await addProfileWear(profile.name, job.metrics.pendownM)
      await clearResumeState()
      await saveJob(job)
    }

    async function handleAbort(stoppedAt: number) {
      job.status = 'aborted'
      job.stoppedAt = stoppedAt
      await saveResumeState({ ...state, file: state.file ?? null, profile: state.profile ?? null, stoppedAt, timestamp: new Date().toISOString() })
      process.stderr.write(`  Stopped at ${Math.round(stoppedAt * 100)}%.\n`)
      process.stderr.write(`  ${chalk.dim('Run')} ${chalk.cyan('nib resume')} ${chalk.dim('to continue from where it stopped.')}\n\n`)
      await markArmUnknown()
      await saveJob(job)
    }
  },
})

function readLine(): Promise<string> {
  return new Promise(resolve => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      if (buf.includes('\n')) {
        process.stdin.removeListener('data', onData)
        process.stdin.pause()
        resolve(buf.split('\n')[0])
      }
    }
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}
