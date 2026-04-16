// nib — public library API
// import { plot, preview } from 'nib'

export type {
  Job,
  JobStatus,
  JobMetrics,
  Profile,
  ResolvedProfile,
  LayerConfig,
  PreprocessStep,
  HookConfig,
  BackendName,
} from './core/job.ts'

export { createJob } from './core/job.ts'

export type { GlobalConfig, ProjectConfig, PenWear } from './core/config.ts'
export {
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  cloneProfile,
  resolveProfile,
  loadGlobalConfig,
  saveGlobalConfig,
  loadProjectConfig,
  getProfileWear,
  addProfileWear,
  penWearWarning,
} from './core/config.ts'

export { listJobs, loadJob, saveJob, nextJobId } from './core/history.ts'

export { PlotEmitter } from './core/events.ts'
export type { PlotEvents } from './core/events.ts'

export type { PlotBackend } from './backends/interface.ts'
export { AxicliBackend, runJob, runPreview, getSvgStats, jobToAxicliFlags } from './backends/axicli.ts'
export type { PlotOptions, RunJobResult, PreviewStats, SvgStats } from './backends/axicli.ts'

export { applyPreprocessSteps, parsePaperSize } from './core/preprocess.ts'

export { fireCompleteHook, fireLayerCompleteHook, fireAbortHook } from './core/hooks.ts'

// ── Phase 4 exports ───────────────────────────────────────────────────────────

export { EBBBackend, runJobEbb } from './backends/ebb.ts'
export type { EbbPlotOptions } from './backends/ebb.ts'

export { svgToMoves } from './backends/svg-to-moves.ts'
export type { PlannerMove, MovePlanOptions } from './backends/svg-to-moves.ts'

export { hersheyText, hersheyTextWidth } from './core/hershey.ts'
export { appendPlotCard, buildPlotCardVars, DEFAULT_PLOT_CARD } from './core/plot-card.ts'
export type { PlotCardConfig, PlotCardField, PlotCardVars } from './core/plot-card.ts'

export { incrementSession } from './core/config.ts'

// ─── High-level plot() API ────────────────────────────────────────────────────

import { resolveProfile as _resolveProfile } from './core/config.ts'
import { createJob as _createJob } from './core/job.ts'
import { nextJobId as _nextJobId, saveJob as _saveJob } from './core/history.ts'
import { PlotEmitter as _PlotEmitter } from './core/events.ts'
import { runJob as _runJob } from './backends/axicli.ts'
import type { ResolvedProfile as _ResolvedProfile } from './core/job.ts'

export interface PlotApiOptions {
  profile?: string | _ResolvedProfile
  guided?: boolean
  optimize?: 0 | 1 | 2
  port?: string
  preview?: boolean
}

/**
 * Plot an SVG string directly from your generative script.
 *
 * @example
 * import { plot } from 'nib'
 * const svg = generateSVG(seed)
 * await plot(svg, { profile: 'fineliner' })
 */
export async function plot(svg: string, options: PlotApiOptions = {}): Promise<void> {
  const profile = typeof options.profile === 'string' || options.profile === undefined
    ? await _resolveProfile(options.profile)
    : options.profile

  const id = await _nextJobId()
  const job = _createJob({
    id,
    svg,
    profile,
    optimize: options.optimize ?? 0,
    guided: options.guided ?? false,
  })

  const emitter = new _PlotEmitter()
  job.status = 'running'
  job.startedAt = new Date()
  await _saveJob(job)

  try {
    await _runJob(job, emitter, {
      mode: options.preview ? 'preview' : 'plot',
      port: options.port,
    })
    job.status = 'complete'
    job.completedAt = new Date()
  } catch (err) {
    job.status = 'aborted'
    throw err
  } finally {
    await _saveJob(job)
  }
}
