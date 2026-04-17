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
  getMachineEnvelope,
  incrementSession,
} from './core/config.ts'

export { listJobs, loadJob, saveJob, nextJobId } from './core/history.ts'

export { PlotEmitter } from './core/events.ts'
export type { PlotEvents } from './core/events.ts'

export type { PlotBackend } from './backends/interface.ts'
export type { EbbTransport } from './backends/transport.ts'
export type { RunJobResult, PreviewStats } from './backends/types.ts'
export { getSvgStats } from './backends/svg-stats.ts'
export type { SvgStats } from './backends/svg-stats.ts'

export {
  EbbCommands,
  lmRateReg, lmAccelReg, firmwareAtLeast, firmwareCapabilities,
  SERVO_MIN, SERVO_MAX, STEPS_PER_MM, LM_TICK_HZ,
  LM_MIN_FIRMWARE, TAG_MIN_FIRMWARE, TAG_USB_MIN_FIRMWARE,
  HM_MIN_FIRMWARE, QM_MIN_FIRMWARE, ES_MIN_FIRMWARE, QS_MIN_FIRMWARE,
  SPEED_PENDOWN_MAX_MMS, SPEED_PENUP_MAX_MMS,
  LM_SPEED_PENDOWN_MAX_MMS, LM_SPEED_PENUP_MAX_MMS, ACCEL_MAX_MMS2,
} from './backends/ebb-protocol.ts'
export type { EbbCapabilities } from './backends/ebb-protocol.ts'

export { EBBBackend, runJobEbb } from './backends/ebb.ts'
export type { EbbPlotOptions } from './backends/ebb.ts'
export { previewStatsFromSvg, previewStatsFromMoves } from './backends/ebb-preview.ts'

export { svgToMoves } from './backends/svg-to-moves.ts'
export type { PlannerMove, MovePlanOptions } from './backends/svg-to-moves.ts'

export { applyPreprocessSteps, parsePaperSize } from './core/preprocess.ts'
export { fireCompleteHook, fireLayerCompleteHook, fireAbortHook } from './core/hooks.ts'

export { hersheyText, hersheyTextWidth } from './core/hershey.ts'
export { appendPlotCard, buildPlotCardVars, DEFAULT_PLOT_CARD } from './core/plot-card.ts'
export type { PlotCardConfig, PlotCardField, PlotCardVars } from './core/plot-card.ts'

export {
  resolveEnvelope, parseEnvelope, isInEnvelope, findFirstOutOfBounds,
} from './core/envelope.ts'
export type { Envelope } from './core/envelope.ts'

export { loadArmState, saveArmState, resetArmState, markArmUnknown, advanceArmState } from './core/state.ts'
export type { ArmState } from './core/state.ts'

// ─── Code-first stroke API ────────────────────────────────────────────────────

export {
  strokesToMoves, movesToStrokes, strokeStats,
} from './core/stroke.ts'
export type { Stroke, Point, StrokeStats } from './core/stroke.ts'

export * as geom from './core/geom.ts'

// ─── High-level plot() API ────────────────────────────────────────────────────

import { resolveProfile as _resolveProfile } from './core/config.ts'
import { createJob as _createJob } from './core/job.ts'
import { nextJobId as _nextJobId, saveJob as _saveJob } from './core/history.ts'
import { PlotEmitter as _PlotEmitter } from './core/events.ts'
import { runJobEbb as _runJobEbb, EBBBackend as _EBBBackend } from './backends/ebb.ts'
import type { ResolvedProfile as _ResolvedProfile } from './core/job.ts'
import type { Stroke as _Stroke } from './core/stroke.ts'
import type { EbbTransport as _EbbTransport } from './backends/transport.ts'
import type { Envelope as _Envelope } from './core/envelope.ts'

export interface PlotApiOptions {
  profile?: string | _ResolvedProfile
  guided?: boolean
  optimize?: 0 | 1 | 2
  port?: string
}

export interface PlotStrokesOptions {
  /** Pen profile — resolve by name (Node only) or pass an inline object. */
  profile: string | _ResolvedProfile
  /** Path reordering: 0=none, 1=nearest, 2=nearest+reversal. */
  optimize?: 0 | 1 | 2
  /**
   * Transport to plot through. If omitted (Node only), NodeSerialTransport
   * will auto-detect or use `port` / NIB_PORT.
   */
  transport?: _EbbTransport
  port?: string
  /** Only plot strokes with this layer number. */
  layer?: number
  /** Machine envelope for runtime bounds check. */
  envelope?: _Envelope
  /** Number of copies (with page delay between). */
  copies?: number
  /** Progress callback, fraction 0–1. */
  onProgress?: (fraction: number) => void
  /** Per-stroke callback at each stroke boundary. */
  onStroke?: (index: number) => void
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
    await _runJobEbb(job, emitter, { port: options.port })
    job.status = 'complete'
    job.completedAt = new Date()
  } catch (err) {
    job.status = 'aborted'
    throw err
  } finally {
    await _saveJob(job)
  }
}

/**
 * Plot a list of strokes — the code-first path. No SVG round-trip.
 *
 * @example
 * import { plotStrokes, geom } from 'nib'
 * await plotStrokes([
 *   geom.polyline(myPoints),
 *   geom.circle({ x: 50, y: 50 }, 20),
 * ], {
 *   profile: 'fineliner',
 *   optimize: 2,
 *   onProgress: f => console.log(`${(f * 100).toFixed(0)}%`),
 * })
 *
 * Works in Node (auto-detects the EBB port) and in the browser (pass a
 * `transport` constructed from WebSerialTransport).
 */
export async function plotStrokes(
  strokes: _Stroke[],
  options: PlotStrokesOptions,
): Promise<void> {
  const profile = typeof options.profile === 'string'
    ? await _resolveProfile(options.profile)
    : options.profile

  let transport: _EbbTransport
  let ownsTransport: boolean
  if (options.transport) {
    transport = options.transport
    ownsTransport = false
  } else {
    const { NodeSerialTransport } = await import('./backends/node-serial.ts')
    const port = options.port
      ?? (typeof process !== 'undefined' ? process.env.NIB_PORT : undefined)
      ?? undefined
    transport = await NodeSerialTransport.connect(port)
    ownsTransport = true
  }

  const backend = new _EBBBackend(transport)
  const emitter = new _PlotEmitter()
  if (options.onProgress) emitter.on('progress', options.onProgress)
  if (options.onStroke) {
    let i = 0
    emitter.on('pen:down', () => options.onStroke!(i++))
  }

  await backend.connect()
  try {
    await backend.runStrokes(profile, strokes, emitter, undefined, {
      optimize: options.optimize ?? 0,
      copies: options.copies,
      envelope: options.envelope,
      layer: options.layer,
    })
  } finally {
    if (ownsTransport) await backend.disconnect()
    else               await backend.shutdown()
  }
}
