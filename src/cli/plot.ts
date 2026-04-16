import { defineCommand } from 'citty'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { resolveProfile, loadProjectConfig, addProfileWear, penWearWarning, incrementSession, getMachineEnvelope } from '../core/config.ts'
import { findFirstOutOfBounds } from '../core/envelope.ts'
import { svgToMoves } from '../backends/svg-to-moves.ts'
import { createJob } from '../core/job.ts'
import { nextJobId, saveJob } from '../core/history.ts'
import { PlotEmitter } from '../core/events.ts'
import { runJob, getSvgStats } from '../backends/axicli.ts'
import { runJobEbb } from '../backends/ebb.ts'
import { previewStatsFromSvg } from '../backends/ebb-preview.ts'
import { LM_SPEED_PENDOWN_MAX_MMS } from '../backends/ebb-protocol.ts'
import { formatDuration } from '../tui/output.ts'
import { attachProgressBar } from '../tui/progress.ts'
import { printPlotHeader, printPlotComplete, printError, printWarning } from '../tui/output.ts'
import { promptLayer, promptPause } from '../tui/guided.ts'
import { applyPreprocessSteps, parsePaperSize } from '../core/preprocess.ts'
import { fireCompleteHook, fireAbortHook } from '../core/hooks.ts'
import { appendPlotCard, buildPlotCardVars, DEFAULT_PLOT_CARD } from '../core/plot-card.ts'
import { runLiveMode } from './live.ts'
import { loadArmState, resetArmState, markArmUnknown, formatPosition } from '../core/state.ts'
import '../tui/env.ts'

function expandPath(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2))
  return resolve(process.cwd(), p)
}

export const plotCmd = defineCommand({
  meta: { name: 'plot', description: 'Plot an SVG file' },
  args: {
    file: {
      type: 'positional',
      description: 'SVG file to plot (use /dev/stdin to read from a pipe)',
    },
    profile: {
      type: 'string',
      alias: 'P',
      description: 'Pen profile name (env: NIB_PROFILE)',
    },
    layer: {
      type: 'string',
      description: 'Plot a single layer by ID',
    },
    copies: {
      type: 'string',
      description: 'Number of copies',
      default: '1',
    },
    optimize: {
      type: 'string',
      description: 'Path reordering: 0=adjacent 1=nearest 2=with-reversal',
      default: '0',
    },
    guided: {
      type: 'boolean',
      description: 'Interactive multi-pen guided mode (walks layers with pen-swap prompts)',
      default: false,
    },
    port: {
      type: 'string',
      description: 'Serial port override (env: NIB_PORT)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate the job without touching hardware',
      default: false,
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip confirmations (for scripts and CI)',
      default: false,
    },
    backend: {
      type: 'string',
      description: 'Plot backend: ebb (default, native serial) or axicli (legacy Python subprocess)',
      default: 'ebb',
    },
    live: {
      type: 'boolean',
      description: 'Live mode: read SVG paths from a subprocess stdout and plot as they arrive (requires --backend ebb)',
      default: false,
    },
    session: {
      type: 'boolean',
      description: 'Increment and record the session counter in axidraw.toml (multi-session works)',
      default: false,
    },
    'plot-card': {
      type: 'boolean',
      description: 'Append a Hershey-text metadata strip to the plot (overrides axidraw.toml plot_card.enabled)',
      default: false,
    },
  },
  async run({ args }) {
    const profileName = args.profile ?? process.env.NIB_PROFILE
    const port = args.port ?? process.env.NIB_PORT

    // ── Validate flags ────────────────────────────────────────────────────────
    const optimizeRaw = parseInt(args.optimize, 10)
    if (![0, 1, 2].includes(optimizeRaw)) {
      printError(`--optimize must be 0, 1, or 2 (got: ${args.optimize})`)
      process.exit(2)
    }

    const backendName = args.backend as 'axicli' | 'ebb'
    if (!['axicli', 'ebb'].includes(backendName)) {
      printError(`--backend must be axicli or ebb (got: ${args.backend})`)
      process.exit(2)
    }
    if (backendName === 'axicli') {
      printWarning('--backend axicli is deprecated and will be removed; ebb is the default')
    }

    // ── Live mode (requires ebb backend) ─────────────────────────────────────
    if (args.live) {
      if (backendName !== 'ebb') {
        printError('--live requires --backend ebb (axicli cannot stream paths in real time)')
        process.exit(2)
      }
      await runLiveMode(args.file, { port, profile: profileName })
      return
    }

    // ── Read SVG ──────────────────────────────────────────────────────────────
    let svg: string
    const filePath = args.file

    if (filePath === '/dev/stdin') {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      svg = Buffer.concat(chunks).toString('utf-8')
    } else {
      const resolved = expandPath(filePath)
      if (!existsSync(resolved)) {
        printError(`file not found: ${filePath}`, 'check the path and try again')
        process.exit(1)
      }
      svg = await readFile(resolved, 'utf-8')
    }

    // ── Arm-position sanity check ─────────────────────────────────────────────
    // Each nib process resets currentX/Y to 0 in software. If a prior command
    // left the arm elsewhere (or the user released motors), the physical arm
    // isn't at origin — but we'll assume it is. Warn before that goes wrong.
    {
      const state = await loadArmState()
      const atOrigin = !state.unknown && Math.abs(state.x) < 0.01 && Math.abs(state.y) < 0.01
      if (!atOrigin && !args.yes) {
        if (state.unknown) {
          printWarning('arm position is unknown — last command released motors')
        } else {
          printWarning(`arm was last left at ${formatPosition(state)}`)
        }
        process.stderr.write('  Run `nib home` to return to origin, `nib motors on` to set a new origin,\n')
        process.stderr.write('  or pass --yes to plot from the current position as if it were (0,0).\n\n')
        process.exit(1)
      }
      // If we're proceeding, clear the state: the EBBBackend will home at end
      // of plot so (0,0) is the correct post-plot position.
      if (!atOrigin) await resetArmState()
    }

    // ── Resolve profile + config ──────────────────────────────────────────────
    let profile
    try {
      profile = await resolveProfile(profileName)
    } catch (err) {
      printError((err as Error).message, 'run: nib profile list')
      process.exit(1)
    }

    const projectConfig = await loadProjectConfig()

    let processedSvg = svg
    if (projectConfig?.preprocess?.steps?.length) {
      const paperMm = projectConfig.paper ? parsePaperSize(projectConfig.paper) ?? undefined : undefined
      processedSvg = applyPreprocessSteps(svg, projectConfig.preprocess.steps, {
        paperMm,
        marginMm: projectConfig.preprocess.marginMm,
      })
    }

    // ── Pre-flight envelope check ────────────────────────────────────────────
    // If the user has configured a machine model or envelope, walk the SVG
    // moves and refuse to start if any point would drive the arm past its
    // physical limit. Skipped when no envelope is configured.
    {
      const envelope = await getMachineEnvelope()
      if (envelope) {
        const moves = svgToMoves(processedSvg, { tolerance: 0.1 })
        const offender = findFirstOutOfBounds(moves, envelope)
        if (offender) {
          printError(
            `SVG exceeds machine envelope (${envelope.widthMm} × ${envelope.heightMm} mm)`,
            `point (${offender.point.x.toFixed(1)}, ${offender.point.y.toFixed(1)}) is outside bounds — ` +
            `re-scale the SVG, pick a larger model, or clear axidraw.toml's envelope to disable the check`,
          )
          process.exit(1)
        }
      }
    }

    // ── Session tracking ──────────────────────────────────────────────────────
    let sessionNum: number | undefined
    if (args.session) {
      try {
        sessionNum = await incrementSession()
        process.stderr.write(`  Session ${sessionNum}${projectConfig?.session?.total ? `/${projectConfig.session.total}` : ''}\n`)
      } catch (err) {
        printWarning((err as Error).message)
      }
    }

    // ── Pen wear check ────────────────────────────────────────────────────────
    // (We don't know exact distance until axicli runs, so warn based on history)
    const warnMsg = await penWearWarning(profile.name, 0)
    if (warnMsg) printWarning(warnMsg)

    // ── Build job ─────────────────────────────────────────────────────────────
    const id = await nextJobId()
    const optimize = optimizeRaw as 0 | 1 | 2
    const copies = Math.max(1, parseInt(args.copies, 10))
    const isDryRun = args['dry-run']
    const isGuided = args.guided

    // ── Plot card ─────────────────────────────────────────────────────────────
    const plotCardConfig = args['plot-card']
      ? { ...(projectConfig?.plotCard ?? DEFAULT_PLOT_CARD), enabled: true }
      : (projectConfig?.plotCard ?? DEFAULT_PLOT_CARD)

    const cardSvg = appendPlotCard(
      processedSvg,
      projectConfig?.paper ?? null,
      plotCardConfig,
      buildPlotCardVars({
        file: filePath === '-' ? null : filePath,
        profile,
        seriesIndex: sessionNum,
        seriesTotal: projectConfig?.session?.total,
      }),
    )

    const job = createJob({
      id,
      file: filePath === '-' ? null : filePath,
      svg: cardSvg,
      profile,
      layers: projectConfig?.layers ?? [],
      copies,
      optimize,
      guided: isGuided,
      hooks: projectConfig?.hooks ?? {},
      backend: backendName,
      session: sessionNum,
    })

    printPlotHeader(job.file, profile, isDryRun)

    if (isDryRun) {
      // Planner-driven dry-run summary: run the same pipeline a real plot
      // would (svgToMoves → reorder → planStroke/planMove), and report the
      // stats the user cares about before committing paper and ink.
      const stats = previewStatsFromSvg(cardSvg, profile, optimize)
      const maxSpeedMms = (profile.speedPendown / 100) * LM_SPEED_PENDOWN_MAX_MMS
      process.stderr.write('  Dry-run summary\n')
      if (stats.pendownM !== null)  process.stderr.write(`    Pen-down:     ${stats.pendownM.toFixed(2)} m\n`)
      if (stats.travelM !== null)   process.stderr.write(`    Travel:       ${stats.travelM.toFixed(2)} m\n`)
      if (stats.penLifts !== null)  process.stderr.write(`    Pen lifts:    ${stats.penLifts}\n`)
      if (stats.estimatedS !== null) process.stderr.write(`    Est. time:    ${formatDuration(stats.estimatedS)}\n`)
      process.stderr.write(`    Max speed:    ${maxSpeedMms.toFixed(1)} mm/s pen-down\n`)
      if (stats.boundingBoxMm)      process.stderr.write(`    Bounding box: ${stats.boundingBoxMm.width.toFixed(1)} × ${stats.boundingBoxMm.height.toFixed(1)} mm\n`)
      process.stderr.write('\n')
      return
    }

    // ── Guided mode: walk layers one at a time ────────────────────────────────
    if (isGuided) {
      const svgStats = await getSvgStats(processedSvg)

      // Resolve layer list: prefer axidraw.toml, fall back to SVG layer IDs
      const layers = (projectConfig?.layers?.length ?? 0) > 0
        ? projectConfig!.layers!
        : svgStats.layerIds.map(id => ({ id }))

      if (layers.length === 0) {
        process.stderr.write('  No layers found — plotting without guided mode.\n\n')
      } else {
        const startedAt = new Date()
        job.status = 'running'
        job.startedAt = startedAt
        await saveJob(job)

        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i]
          const result = await promptLayer(job, layer, i, layers.length)

          if (result.action === 'quit') {
            job.status = 'aborted'
            job.stoppedAt = i / layers.length
            await saveJob(job)
            process.stderr.write('  Quit.\n')
            return
          }

          if (result.action === 'skip') {
            process.stderr.write(`  Skipped layer ${layer.id}.\n`)
            continue
          }

          // Plot this layer
          await plotSingleLayer(job, layer.id, port, i, layers.length)
        }

        const durationS = (Date.now() - startedAt.getTime()) / 1000
        job.status = 'complete'
        job.completedAt = new Date()
        job.metrics.durationS = durationS
        await saveJob(job)
        printPlotComplete(durationS, job.metrics, id)
        return
      }
    }

    // ── Standard single-pass plot ─────────────────────────────────────────────
    const emitter = new PlotEmitter()
    attachProgressBar(emitter)

    const startedAt = new Date()
    job.status = 'running'
    job.startedAt = startedAt
    await saveJob(job)

    // Override SIGINT during plot to pause instead of hard-exit
    const controller = new AbortController()
    let pauseHandled = false

    const sigintHandler = async () => {
      if (pauseHandled) return
      pauseHandled = true
      controller.abort()
    }

    // Remove the global SIGINT handler (set in cli/index.ts) temporarily
    process.removeAllListeners('SIGINT')
    process.once('SIGINT', sigintHandler)

    try {
      const layerNum = args.layer !== undefined ? parseInt(args.layer, 10) : undefined
      const envelope = (await getMachineEnvelope()) ?? undefined
      const result = backendName === 'ebb'
        ? await runJobEbb(job, emitter, { port, layer: layerNum, envelope }, controller.signal)
        : await runJob(job, emitter, {
            mode: 'plot',
            layer: layerNum,
            port,
          }, controller.signal)

      if (result.aborted) {
        // Paused — ask what to do
        const choice = await promptPause(result.stoppedAt)

        if (choice === 'resume') {
          // Re-run the full job (axicli doesn't support mid-job resume)
          process.stderr.write('  Resuming from the beginning of this layer…\n')
          controller.abort()  // reset, re-run
          job.status = 'pending'
          // Recurse: re-invoke the runner without the pause handler
          await doPlot(job, emitter, port, result.stoppedAt)
        } else {
          job.status = 'aborted'
          job.stoppedAt = result.stoppedAt
          process.stderr.write(`  Job #${id} saved (aborted at ${Math.round(result.stoppedAt * 100)}%).\n\n`)
        }
        // Aborted mid-plot — the backend homes on abort so the arm is at (0,0).
        await resetArmState()
        return
      }

      const durationS = (Date.now() - startedAt.getTime()) / 1000
      job.status = 'complete'
      job.completedAt = new Date()
      job.metrics.durationS = durationS
      emitter.emit('complete', job.metrics)
      printPlotComplete(durationS, job.metrics, id)
      // Backend homes at end of every copy — arm is at origin.
      await resetArmState()
      await addProfileWear(profile.name, job.metrics.pendownM)
      await fireCompleteHook(job.hooks, {
        file: job.file,
        profile: profile.name,
        job_id: id,
        metrics: job.metrics,
      })
    } catch (err) {
      const msg = (err as Error).message
      job.status = 'aborted'
      emitter.emit('abort', 0)
      printError(msg, msg.includes('axicli') ? 'install with: pip install axicli' : undefined)
      // Exception mid-plot — we don't know how far the arm got. Flag unknown
      // so the next plot requires the user to re-home first.
      await markArmUnknown()
      await fireAbortHook(job.hooks, { file: job.file, profile: profile.name, job_id: id })
      process.exitCode = 1
    } finally {
      process.removeAllListeners('SIGINT')
      // Restore global SIGINT handler
      process.on('SIGINT', () => { process.stderr.write('\n'); process.exit(130) })
      await saveJob(job)
    }
  },
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function plotSingleLayer(
  job: ReturnType<typeof createJob>,
  layerId: number,
  port: string | undefined,
  layerIndex: number,
  totalLayers: number,
): Promise<void> {
  const emitter = new PlotEmitter()
  attachProgressBar(emitter)

  emitter.on('layer:start', (_layer, i, total) => {
    process.stderr.write(`  Layer ${i + 1}/${total}…\n`)
  })

  emitter.emit('layer:start', { id: layerId }, layerIndex, totalLayers)

  try {
    await runJob(job, emitter, { layer: layerId, port })
    emitter.emit('layer:complete', { id: layerId }, {})
  } catch (err) {
    printError((err as Error).message)
    throw err
  }
}

async function doPlot(
  job: ReturnType<typeof createJob>,
  emitter: PlotEmitter,
  port: string | undefined,
  _fromFraction: number,
): Promise<void> {
  // axicli doesn't support fractional resume; re-run from the start
  const result = await runJob(job, emitter, { port })
  if (!result.aborted) {
    emitter.emit('complete', job.metrics)
  }
}
