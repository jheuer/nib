import { defineCommand } from 'citty'
import chalk from 'chalk'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { resolveProfile, loadProjectConfig, addProfileWear, penWearWarning, incrementSession, getMachineEnvelope, getEffectiveEnvelope, loadGlobalConfig, saveResumeState, clearResumeState } from '../core/config.ts'
import { connectEbb } from '../backends/node-serial.ts'
import { findFirstOutOfBounds } from '../core/envelope.ts'
import { svgToMoves } from '../backends/svg-to-moves.ts'
import { rotateMoves } from '../core/stroke.ts'
import { resolveAutoRotate } from '../core/auto-rotate.ts'
import { resolvePaper } from '../core/paper.ts'
import { createJob } from '../core/job.ts'
import { nextJobId, saveJob } from '../core/history.ts'
import { PlotEmitter } from '../core/events.ts'
import { getSvgStats } from '../backends/svg-stats.ts'
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
import { parseSvgLayers } from '../core/svg-layers.ts'
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
      description: 'Plot a single layer (by number from inkscape:label prefix, or by id)',
    },
    'list-layers': {
      type: 'boolean',
      description: 'Print the discovered SVG layers and exit without plotting',
      default: false,
    },
    copies: {
      type: 'string',
      description: 'Number of copies',
      default: '1',
    },
    optimize: {
      type: 'string',
      description: 'Path reordering: 0=adjacent 1=nearest 2=with-reversal',
      default: '2',
    },
    simplify: {
      type: 'string',
      description: 'Douglas-Peucker polyline simplification tolerance in mm (e.g. 0.2). 0 = off. Overrides axidraw.toml.',
    },
    rotate: {
      type: 'string',
      description: 'Rotate content before plotting. "auto" (default) fits portrait SVGs to landscape machines and vice-versa. Use "none" to disable, or a number of degrees for explicit rotation.',
    },
    paper: {
      type: 'string',
      description: 'Paper size ("A4"/"A3"/"letter"/WxH mm). Used together with --paper-offset to shift content into paper space. Overrides axidraw.toml.',
    },
    'paper-orientation': {
      type: 'string',
      description: 'Force paper orientation: "portrait" or "landscape".',
    },
    'paper-offset': {
      type: 'string',
      description: 'Paper offset from home corner as "X,Y" in mm (default 0,0). Non-zero offsets auto-shift content into paper space; disable with --machine-origin.',
    },
    'machine-origin': {
      type: 'boolean',
      description: 'Treat SVG (0,0) as machine home even when paper_offset is non-zero. Off by default.',
      default: false,
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
    live: {
      type: 'boolean',
      description: 'Live mode: read SVG paths from a subprocess stdout and plot as they arrive',
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
    'start-from': {
      type: 'string',
      description: 'Start mid-plot: fraction 0–1 or percent 0–100 (e.g. 0.5 or 50). Arm must be at home.',
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

    // Parse --start-from (percent or fraction)
    let startFrom: number | undefined
    if (args['start-from'] !== undefined) {
      const raw = parseFloat(args['start-from'])
      if (isNaN(raw) || raw < 0) {
        printError(`--start-from must be a fraction (0–1) or percent (0–100), got: ${args['start-from']}`)
        process.exit(2)
      }
      startFrom = raw > 1 ? raw / 100 : raw
      if (startFrom > 1) {
        printError(`--start-from ${args['start-from']} is out of range (max 100%)`)
        process.exit(2)
      }
    }

    // ── Live mode: stream SVG paths from a subprocess ────────────────────────
    if (args.live) {
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

    // ── --list-layers: inspect + exit ────────────────────────────────────────
    if (args['list-layers']) {
      printLayerList(svg)
      return
    }

    // ── Arm-position sanity check ─────────────────────────────────────────────
    // Each nib process resets currentX/Y to 0 in software. If a prior command
    // left the arm elsewhere (or the user released motors), the physical arm
    // isn't at origin — but we'll assume it is. Warn before that goes wrong.
    // Skip when --start-from is given: user is deliberately resuming mid-plot
    // and is responsible for having the arm at home.
    {
      const state = await loadArmState()
      const atOrigin = !state.unknown && Math.abs(state.x) < 0.01 && Math.abs(state.y) < 0.01
      if (!atOrigin && !args.yes && startFrom === undefined) {
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

    // ── Auto-apply registered machine envelope (QN/SN) ───────────────────────
    // If the user has registered machines via `nib machine register`, briefly
    // connect to the board, read its EEPROM name (QN), and use the matching
    // entry's envelope. This lets one host drive multiple AxiDraws without
    // per-plot `--model` flags. Costs ~100ms and is skipped if no machines
    // are registered.
    let machineName: string | undefined
    {
      const gcfg = await loadGlobalConfig()
      if (gcfg.machines && Object.keys(gcfg.machines).length > 0) {
        try {
          const ebb = await connectEbb(port)
          try { machineName = (await ebb.queryName()) || undefined }
          finally { await ebb.close() }
          if (machineName && gcfg.machines[machineName]) {
            process.stderr.write(`  ${chalk.dim('Machine:')}  ${machineName}${gcfg.machines[machineName].description ? chalk.dim(` · ${gcfg.machines[machineName].description}`) : ''}\n`)
          } else if (machineName) {
            printWarning(`board is tagged "${machineName}" but no matching entry in nib config — run: nib machine register ${machineName}`)
          }
        } catch (err) {
          printWarning(`could not query board name: ${(err as Error).message}`)
        }
      }
    }

    // ── Resolve rotation (incl. axicli-style auto) ───────────────────────────
    // Auto-detect portrait/landscape mismatch between the SVG and the machine
    // envelope — this matches axicli default behaviour. Runs once here and
    // reused for both the pre-flight envelope check and the actual plot call.
    const eff = await getEffectiveEnvelope(machineName)
    const svgStatsEarly = await getSvgStats(processedSvg)
    let rotateDeg: number
    try {
      const rot = resolveAutoRotate(args.rotate, {
        svgWidthMm:      svgStatsEarly.widthMm,
        svgHeightMm:     svgStatsEarly.heightMm,
        envelopeWidthMm:  eff?.envelope.widthMm  ?? null,
        envelopeHeightMm: eff?.envelope.heightMm ?? null,
      })
      rotateDeg = rot.degrees
      if (rot.auto && rot.degrees !== 0) {
        process.stderr.write(`  ${chalk.dim(`Auto-rotate:`)} ${rot.degrees}° (${rot.reason}). ${chalk.dim('Override with --rotate none.')}\n`)
      }
    } catch (err) {
      printError((err as Error).message)
      process.exit(2)
    }

    // ── Resolve paper → translate-to-paper shift ─────────────────────────────
    const paper = resolvePaper({
      size:        args.paper                              ?? projectConfig?.paper,
      orientation: (args['paper-orientation'] as 'portrait' | 'landscape' | undefined)
                     ?? projectConfig?.paperOrientation,
      offset:      args['paper-offset']                    ?? projectConfig?.paperOffset,
      color:       projectConfig?.paperColor,  // plot doesn't expose --paper-color (no preview)
    })
    const translateMm = (!args['machine-origin'] && paper && (paper.offsetXMm || paper.offsetYMm))
      ? { x: paper.offsetXMm, y: paper.offsetYMm }
      : { x: 0, y: 0 }
    if (translateMm.x || translateMm.y) {
      process.stderr.write(`  ${chalk.dim('Paper offset:')}  (${translateMm.x}, ${translateMm.y}) mm ${chalk.dim('— content shifted into paper space. Disable with --machine-origin.')}\n`)
    }

    // ── Pre-flight envelope check ────────────────────────────────────────────
    // If the user has configured a machine model or envelope, walk the SVG
    // moves and refuse to start if any point would drive the arm past its
    // physical limit (minus the configured safety margin). Skipped when no
    // envelope is configured.
    if (eff) {
      const rawPreflight = svgToMoves(processedSvg, { tolerance: 0.1 })
      const rotatedPreflight = rotateDeg ? rotateMoves(rawPreflight, rotateDeg) : rawPreflight
      const moves = (translateMm.x || translateMm.y)
        ? rotatedPreflight.map(m => ({ x: m.x + translateMm.x, y: m.y + translateMm.y, penDown: m.penDown }))
        : rotatedPreflight
      const offender = findFirstOutOfBounds(moves, eff.envelope, eff.marginMm)
      if (offender) {
        const safeW = eff.envelope.widthMm  - 2 * eff.marginMm
        const safeH = eff.envelope.heightMm - 2 * eff.marginMm
        printError(
          `SVG exceeds safe envelope (${safeW} × ${safeH} mm = machine minus ${eff.marginMm}mm margin)`,
          `point (${offender.point.x.toFixed(1)}, ${offender.point.y.toFixed(1)}) is outside bounds — ` +
          `re-scale the SVG, pick a larger model, lower margin_mm, or clear axidraw.toml's envelope`,
        )
        process.exit(1)
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
    // We don't know exact distance until the plot runs, so warn from history.
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
      // Resolve layer list in preference order:
      //   1. axidraw.toml [[layers]] — most explicit
      //   2. SVG labels (axicli convention) — self-describing, no config required
      //   3. Fast id-scan as a last resort
      let layers: Array<{ id: number; name?: string; profile?: string; prompt?: string; port?: string }>
      if ((projectConfig?.layers?.length ?? 0) > 0) {
        layers = projectConfig!.layers!
      } else {
        const svgLayers = parseSvgLayers(processedSvg).filter(l => !l.skip)
        if (svgLayers.length > 0) {
          layers = svgLayers.map(l => ({ id: l.id, name: l.name || undefined }))
        } else {
          const svgStats = await getSvgStats(processedSvg)
          layers = svgStats.layerIds.map(id => ({ id }))
        }
      }

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

    // ── Multi-layer hint (non-guided, no --layer filter) ─────────────────────
    if (!isGuided && args.layer === undefined) {
      const visibleLayers = parseSvgLayers(processedSvg).filter(l => !l.skip)
      if (visibleLayers.length > 1) {
        process.stderr.write(
          chalk.yellow(`  ⚠  ${visibleLayers.length} layers detected.`) +
          chalk.dim(' All will plot without pausing.\n') +
          chalk.dim('     Use --guided for pen-swap prompts, or --layer N to plot one layer at a time.\n\n'),
        )
      }
    }

    // ── Standard single-pass plot ─────────────────────────────────────────────
    const emitter = new PlotEmitter()
    attachProgressBar(emitter)

    const startedAt = new Date()
    job.status = 'running'
    job.startedAt = startedAt
    await saveJob(job)

    // Override SIGINT during plot: first ^C pauses (immediate feedback +
    // backend ES so motors stop within ~100ms); second ^C is a hard quit.
    const controller = new AbortController()
    let pauseHandled = false

    const sigintHandler = () => {
      if (pauseHandled) {
        process.stderr.write('\n  Force quit.\n')
        process.exit(130)
      }
      pauseHandled = true
      // Print feedback BEFORE awaiting the backend's abort path, so the user
      // sees the ^C was heard even while the firmware processes ES.
      process.stderr.write(`\n  ${chalk.yellow('Pausing')} — stopping motors (press Ctrl-C again to force-quit)…\n`)
      controller.abort()
    }

    // Remove the global SIGINT handler (set in cli/index.ts) temporarily.
    // Use on() not once() so a second ^C still has a handler attached.
    process.removeAllListeners('SIGINT')
    process.on('SIGINT', sigintHandler)

    try {
      const layerNum = args.layer !== undefined ? parseInt(args.layer, 10) : undefined
      const simplifyMm = args.simplify !== undefined
        ? parseFloat(args.simplify)
        : projectConfig?.simplifyMm

      // SVG over-sampling screening: warn before committing ink if the SVG has
      // many sub-mm segments (common with Inkscape exports that over-sample curves).
      if (!startFrom) {
        screenForOverSampling(processedSvg, simplifyMm)
      }

      const result = await runJobEbb(
        job, emitter,
        {
          port,
          layer: layerNum,
          envelope: eff?.envelope,
          marginMm: eff?.marginMm,
          simplifyMm,
          rotateDeg,
          translateMm,
          startFrom,
          homeBeforeRun: (startFrom ?? 0) > 0,
        },
        controller.signal,
      )

      if (result.aborted) {
        // Paused — the backend stopped motors (ES) but did NOT home, so the
        // arm is parked at whatever mid-stroke position it reached.
        const choice = await promptPause(result.stoppedAt)

        if (choice === 'resume') {
          process.stderr.write(`  Homing, then resuming from ${Math.round(result.stoppedAt * 100)}%…\n`)
          controller.abort()  // reset, re-run
          job.status = 'pending'
          // Recurse with resumeFrom; the new connect() inside runJobEbb will
          // issue HM first (see homeBeforeRun: true) so the arm is at a known
          // origin before we re-issue moves.
          await doPlot(job, emitter, port, result.stoppedAt, { homeBeforeRun: true })
        } else {
          job.status = 'aborted'
          job.stoppedAt = result.stoppedAt
          // Persist state so `nib resume` can restart without re-running setup.
          const layerNum = args.layer !== undefined ? parseInt(args.layer, 10) : undefined
          const simplifyMm = args.simplify !== undefined
            ? parseFloat(args.simplify)
            : projectConfig?.simplifyMm
          await saveResumeState({
            file: filePath === '/dev/stdin' ? null : resolve(filePath),
            profile: profileName ?? null,
            stoppedAt: result.stoppedAt,
            timestamp: new Date().toISOString(),
            optimize: optimize,
            rotateDeg,
            translateX: translateMm.x,
            translateY: translateMm.y,
            simplifyMm,
            layer: layerNum,
          })
          process.stderr.write(`  Job #${id} saved (aborted at ${Math.round(result.stoppedAt * 100)}%).\n`)
          process.stderr.write(`  ${chalk.dim('Run')} ${chalk.cyan('nib resume')} ${chalk.dim('to continue from where it stopped.')}\n\n`)
          // Arm position is stale (we skipped home on pause). Flag it so the
          // next plot requires a manual home first.
          await markArmUnknown()
          return
        }
        return
      }

      const durationS = (Date.now() - startedAt.getTime()) / 1000
      job.status = 'complete'
      job.completedAt = new Date()
      job.metrics.durationS = durationS
      // `complete` already emitted by runMoves inside runJobEbb — don't re-emit.
      printPlotComplete(durationS, job.metrics, id)
      // Backend homes at end of every copy — arm is at origin.
      await resetArmState()
      await addProfileWear(profile.name, job.metrics.pendownM)
      await clearResumeState()
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
      printError(msg)
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
    await runJobEbb(job, emitter, { layer: layerId, port })
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
  fromFraction: number,
  opts: { homeBeforeRun?: boolean } = {},
): Promise<void> {
  const result = await runJobEbb(job, emitter, {
    port,
    startFrom: fromFraction,
    homeBeforeRun: opts.homeBeforeRun,
  })
  if (!result.aborted) {
    emitter.emit('complete', job.metrics)
  }
}

/**
 * Scan moves for over-sampled paths (sub-mm segments) and warn the user.
 * Over-sampled SVGs drive the EBB with many redundant LM commands, slow the
 * pipeline, and can produce waviness when junction velocity is limited by
 * many tiny segments in sequence. The fix is --simplify 0.1 (or similar).
 */
function screenForOverSampling(svg: string, simplifyMm?: number): void {
  if (simplifyMm && simplifyMm > 0) return  // already simplifying

  const moves = svgToMoves(svg, { tolerance: 0.05 })
  let pendownSegments = 0
  let shortSegments = 0

  for (let i = 1; i < moves.length; i++) {
    if (!moves[i].penDown) continue
    pendownSegments++
    const dx = moves[i].x - moves[i - 1].x
    const dy = moves[i].y - moves[i - 1].y
    if (dx * dx + dy * dy < 0.01) shortSegments++  // < 0.1mm
  }

  if (pendownSegments < 200 || shortSegments < 50) return
  const pct = Math.round((shortSegments / pendownSegments) * 100)
  if (pct < 25) return

  printWarning(
    `${shortSegments.toLocaleString()} of ${pendownSegments.toLocaleString()} pen-down segments are <0.1 mm (${pct}%) — SVG may be over-sampled. Add --simplify 0.1 to merge them (safe for most SVGs)`,
  )
}

function printLayerList(svg: string): void {
  const layers = parseSvgLayers(svg)
  if (layers.length === 0) {
    process.stderr.write('  No Inkscape layers found.\n')
    process.stderr.write('  (All drawable elements will plot as a single layer.)\n')
    return
  }
  process.stderr.write(`\n  ${layers.length} layer${layers.length === 1 ? '' : 's'} found\n\n`)
  const sorted = [...layers].sort((a, b) => a.id - b.id)
  const idWidth = Math.max(...sorted.map(l => String(l.id).length), 2)
  for (const l of sorted) {
    const num = String(l.id).padStart(idWidth)
    const flag = l.skip ? '  SKIP' : '      '
    const name = l.name || '(unnamed)'
    process.stderr.write(`    #${num}${flag}  ${name}\n`)
  }
  process.stderr.write('\n')
  process.stderr.write('  Plot one: nib plot <file> --layer <N>\n')
  process.stderr.write('  Plot all: nib plot <file>  (layers marked SKIP are always omitted)\n\n')
}
