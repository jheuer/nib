/**
 * nib/browser — entry point for browser consumers.
 *
 * Re-exports the pure core + the WebSerial transport, and nothing else.
 * Does NOT import Node-specific code (no `fs`, no child_process), so
 * bundlers can ship a clean browser build.
 *
 * Typical usage:
 *
 *   import { plotStrokes, geom, requestEbbPort } from 'nib/browser'
 *
 *   const button = document.querySelector('button#connect')
 *   button.addEventListener('click', async () => {
 *     const transport = await requestEbbPort()   // user picks the port
 *     await plotStrokes([
 *       geom.circle({ x: 50, y: 50 }, 20),
 *       geom.rect(0, 0, 100, 100),
 *     ], {
 *       transport,
 *       profile: { speedPendown: 30, speedPenup: 50, penPosDown: 15, penPosUp: 32, accel: 25 },
 *       onProgress: f => ui.setBar(f),
 *     })
 *     await transport.close()
 *   })
 */

// ─── Pure core (browser-safe, no I/O) ─────────────────────────────────────────

export type {
  Stroke, Point, StrokeStats,
} from './core/stroke.ts'
export {
  strokesToMoves, movesToStrokes, strokeStats,
} from './core/stroke.ts'

export * as geom from './core/geom.ts'

export { svgToMoves } from './backends/svg-to-moves.ts'
export type { PlannerMove, MovePlanOptions } from './backends/svg-to-moves.ts'

export { parseSvgLayers, parseLayerAttrs } from './core/svg-layers.ts'
export type { SvgLayer } from './core/svg-layers.ts'

export { reorder } from './core/reorder.ts'
export type { OptimizeLevel, ReorderResult, ReorderStats } from './core/reorder.ts'

export { planMove, planStroke, planTrapezoid, optionsForProfile } from './core/planner.ts'
export type {
  PlannedMove, LmPhase, TrapezoidProfile, PlanOptions, Segment,
} from './core/planner.ts'

export { previewStatsFromSvg, previewStatsFromMoves } from './backends/ebb-preview.ts'

export {
  resolveEnvelope, parseEnvelope, isInEnvelope, findFirstOutOfBounds,
} from './core/envelope.ts'
export type { Envelope } from './core/envelope.ts'

export type { Profile, ResolvedProfile, JobMetrics } from './core/job.ts'

// ─── Protocol layer (transport-agnostic) ─────────────────────────────────────

export type { EbbTransport } from './backends/transport.ts'
export type { RunJobResult, PreviewStats } from './backends/types.ts'
export {
  EbbCommands,
  lmRateReg, lmAccelReg, firmwareAtLeast,
  SERVO_MIN, SERVO_MAX, STEPS_PER_MM, LM_TICK_HZ, LM_MIN_FIRMWARE,
  SPEED_PENDOWN_MAX_MMS, SPEED_PENUP_MAX_MMS,
  LM_SPEED_PENDOWN_MAX_MMS, LM_SPEED_PENUP_MAX_MMS, ACCEL_MAX_MMS2,
} from './backends/ebb-protocol.ts'

// ─── Backend + plot runners ──────────────────────────────────────────────────
// Note: runJobEbb is NOT exported here — it auto-creates a NodeSerialTransport
// when no transport is given, which pulls in Node's fs/child_process and
// bloats the browser bundle. Browser consumers use `plot` / `plotStrokes`
// below, which take the transport directly.

export { EBBBackend } from './backends/ebb.ts'

export { PlotEmitter } from './core/events.ts'
export type { PlotEvents } from './core/events.ts'

// ─── Browser transport ───────────────────────────────────────────────────────

export {
  WebSerialTransport,
  requestEbbPort,
  EBB_USB_FILTERS,
} from './backends/web-serial.ts'

// ─── High-level plot API (browser flavor — no config-file lookup) ────────────

import { PlotEmitter as _PlotEmitter } from './core/events.ts'
import { EBBBackend as _EBBBackend } from './backends/ebb.ts'
import type { EbbTransport as _EbbTransport } from './backends/transport.ts'
import type { ResolvedProfile as _ResolvedProfile, Profile as _Profile } from './core/job.ts'
import type { Stroke as _Stroke } from './core/stroke.ts'
import type { Envelope as _Envelope } from './core/envelope.ts'

export interface BrowserPlotOptions {
  /** Open transport obtained from requestEbbPort() or WebSerialTransport.connect(). */
  transport: _EbbTransport
  /** Pen profile — plain object (browser has no profiles.toml). */
  profile: _Profile & { name?: string }
  /** Path reordering: 0=none, 1=nearest, 2=nearest+reversal. */
  optimize?: 0 | 1 | 2
  layer?: number
  envelope?: _Envelope
  copies?: number
  onProgress?: (fraction: number) => void
  onStroke?: (index: number) => void
}

function resolveInlineProfile(p: BrowserPlotOptions['profile']): _ResolvedProfile {
  return { name: p.name ?? 'inline', ...p }
}

/**
 * Plot a stroke list from a browser. The transport you pass in is owned by
 * the caller — this function does not close it. Call `transport.close()` (or
 * keep the port open across multiple plots) as appropriate.
 */
export async function plotStrokes(
  strokes: _Stroke[],
  options: BrowserPlotOptions,
): Promise<void> {
  const profile = resolveInlineProfile(options.profile)
  const backend = new _EBBBackend(options.transport)
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
    await backend.shutdown()
  }
}

/**
 * Plot an SVG string from a browser.
 */
export async function plot(
  svg: string,
  options: BrowserPlotOptions,
): Promise<void> {
  const { svgToMoves: _svgToMoves } = await import('./backends/svg-to-moves.ts')
  const profile = resolveInlineProfile(options.profile)
  const backend = new _EBBBackend(options.transport)
  const emitter = new _PlotEmitter()
  if (options.onProgress) emitter.on('progress', options.onProgress)
  const moves = _svgToMoves(svg, { tolerance: 0.1, layer: options.layer })
  await backend.connect()
  try {
    await backend.runMoves(profile, moves, emitter, undefined, {
      optimize: options.optimize ?? 0,
      copies: options.copies,
      envelope: options.envelope,
      layer: options.layer,
    })
  } finally {
    await backend.shutdown()
  }
}
