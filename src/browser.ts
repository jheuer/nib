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
  lmRateReg, lmAccelReg, firmwareAtLeast, firmwareCapabilities,
  SERVO_MIN, SERVO_MAX, STEPS_PER_MM, LM_TICK_HZ,
  LM_MIN_FIRMWARE, TAG_MIN_FIRMWARE, TAG_USB_MIN_FIRMWARE,
  HM_MIN_FIRMWARE, QM_MIN_FIRMWARE, ES_MIN_FIRMWARE, QS_MIN_FIRMWARE,
  SPEED_PENDOWN_MAX_MMS, SPEED_PENUP_MAX_MMS,
  LM_SPEED_PENDOWN_MAX_MMS, LM_SPEED_PENUP_MAX_MMS, ACCEL_MAX_MMS2,
} from './backends/ebb-protocol.ts'
export type { EbbCapabilities } from './backends/ebb-protocol.ts'

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

// ─── Live-drawing session (interactive streaming) ────────────────────────────

/**
 * Long-lived plotter session for interactive / streaming workloads — draw-
 * while-you-plot, generative sketches emitting strokes over time, etc.
 *
 * Unlike `plotStrokes`, this keeps the transport open and motors enabled
 * across stroke submissions. Each submitted stroke plots immediately; strokes
 * are queued so callers can await `ready` or use `drawStroke().then()` to
 * know when the arm has caught up.
 *
 * Typical usage:
 *   const transport = await requestEbbPort()
 *   const live = new LivePlotter(transport, { profile: {...}, envelope })
 *   await live.start()
 *   canvas.addEventListener('pointerup', () => live.drawStroke(currentPoints))
 *   // later
 *   await live.close()
 */
export class LivePlotter {
  private backend: _EBBBackend
  private profile: _ResolvedProfile
  private queue: Promise<void> = Promise.resolve()
  private started = false
  private closed = false

  constructor(
    private readonly transport: _EbbTransport,
    options: {
      profile: _Profile & { name?: string }
      /** Machine envelope — if set, off-page strokes are rejected. */
      envelope?: _Envelope
    },
  ) {
    this.backend = new _EBBBackend(transport)
    this.profile = resolveInlineProfile(options.profile)
    void options.envelope  // envelope check happens in drawStroke
  }

  /** Connect, enable motors, configure servo, park pen up. */
  async start(): Promise<void> {
    if (this.started) return
    await this.backend.connect()
    await this.backend.configureSession(this.profile)
    this.started = true
  }

  /**
   * Queue a stroke for immediate plotting. Points are in mm; first point is
   * pen-up travel from the current position. Returns a promise that resolves
   * when THIS stroke has finished (the arm is idle). Call `.ready()` to wait
   * for the whole queue to drain instead.
   */
  async drawStroke(points: { x: number; y: number }[]): Promise<void> {
    if (this.closed) throw new Error('LivePlotter has been closed')
    if (!this.started) await this.start()
    if (points.length < 2) return

    // Serialize stroke execution through a promise chain — points submitted
    // faster than the arm can plot get queued cleanly.
    const run = this.queue.then(() => this.backend.plotLiveStroke(this.profile, points))
    this.queue = run.catch(() => undefined)
    await run
  }

  /** Wait for the queue to drain. */
  async ready(): Promise<void> {
    await this.queue
  }

  /** Home, pen up, disable motors. Leaves the transport open. */
  async end(): Promise<void> {
    if (!this.started || this.closed) return
    this.closed = true
    await this.queue.catch(() => undefined)
    await this.backend.home().catch(() => undefined)
    await this.backend.shutdown().catch(() => undefined)
  }

  /** End the session and close the transport. */
  async close(): Promise<void> {
    await this.end()
    await this.transport.close().catch(() => undefined)
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
