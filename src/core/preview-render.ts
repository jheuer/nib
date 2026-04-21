/// <reference lib="dom" />
/**
 * Visual preview renderer for nib move sequences.
 *
 * Draws a to-scale plot preview onto any CanvasRenderingContext2D — browser
 * canvas, Node canvas (via `canvas` npm package), or OffscreenCanvas. Caller
 * owns the canvas and its size; this function only paints into it.
 *
 * Pen-down strokes are drawn in configurable color (defaults to ink-black).
 * Pen-up travel is drawn as dashed light gray (toggleable).
 * The paper rectangle and an optional machine envelope are drawn behind the art.
 *
 * Browser usage:
 *   const canvas = document.createElement('canvas')
 *   canvas.width = 900; canvas.height = 600
 *   renderPreview(moves, canvas.getContext('2d')!, { paper: { widthMm: 297, heightMm: 210 } })
 *   document.body.appendChild(canvas)
 *
 * Returns a `PreviewRenderStats` object with the same numbers as
 * `previewStatsFromMoves` but computed cheaply (no planner, distances only).
 */

import type { PlannerMove } from '../backends/svg-to-moves.ts'
import type { Envelope } from './envelope.ts'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PreviewRenderOptions {
  /**
   * Paper size in mm. Drawn as an off-white rectangle behind the strokes.
   * If omitted, the paper rect is sized to the content bounding box + 10 mm margin.
   */
  paper?: { widthMm: number; heightMm: number }

  /**
   * Machine envelope. If provided, drawn as a faint dashed border outside the
   * paper rect showing the full travel range.
   */
  envelope?: Envelope

  /** Padding in canvas pixels around the outermost drawn element. Default: 24. */
  paddingPx?: number

  /**
   * Pen-down stroke color. CSS color string, or an array of colors indexed by
   * layer. When a layer array is given, each stroke's layer index selects the
   * color (wrapping if needed).
   * Default: '#1a1a1a'
   */
  inkColor?: string | string[]

  /** Draw pen-up travel as dashed gray. Default: true. */
  showTravel?: boolean

  /** Draw origin crosshair at (0, 0). Default: true. */
  showOrigin?: boolean

  /**
   * Stroke width of pen-down paths in mm (before scaling to canvas pixels).
   * Default: 0.35 — a typical 0.35mm fineliner.
   */
  nibSizeMm?: number

  /**
   * Layer number → color override map. Supersedes `inkColor` per-layer.
   * e.g. `{ 1: '#e63', 2: '#36e' }` for a two-color plot.
   */
  layerColors?: Record<number, string>

  /** Background color for the canvas surface outside the paper. Default: '#ede8dd'. */
  backgroundColor?: string

  /** Paper rectangle fill color. Default: '#fdfcf7'. */
  paperColor?: string
}

export interface PreviewRenderStats {
  /** Total pen-down distance in meters. */
  pendownM: number
  /** Total pen-up travel distance in meters. */
  travelM: number
  /** Number of pen lifts (= number of strokes). */
  penLifts: number
  /** Pen-down / (pen-down + travel), 0–100. null if no motion. */
  travelOverheadPct: number | null
  /** Content bounding box in mm (pen-down only). null if no strokes. */
  contentMm: { minX: number; minY: number; maxX: number; maxY: number } | null
}

/**
 * Render a move sequence onto a canvas context.
 *
 * The context's current transform is respected — paint happens in the canvas's
 * CSS pixel coordinate system. The function does NOT clear the canvas before
 * drawing; call `ctx.clearRect` first if needed.
 */
export function renderPreview(
  moves: PlannerMove[],
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  options: PreviewRenderOptions = {},
): PreviewRenderStats {
  const {
    paddingPx      = 24,
    showTravel     = true,
    showOrigin     = true,
    nibSizeMm      = 0.35,
    backgroundColor = '#ede8dd',
    paperColor     = '#fdfcf7',
    inkColor       = '#1a1a1a',
    layerColors    = {},
  } = options

  // ── Compute content bounding box (pen-down only) ──────────────────────────

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of moves) {
    if (!m.penDown) continue
    if (m.x < minX) minX = m.x; if (m.x > maxX) maxX = m.x
    if (m.y < minY) minY = m.y; if (m.y > maxY) maxY = m.y
  }
  const hasContent = isFinite(minX)

  // ── Resolve paper rect (mm) ───────────────────────────────────────────────

  let paperW: number
  let paperH: number
  if (options.paper) {
    paperW = options.paper.widthMm
    paperH = options.paper.heightMm
  } else if (hasContent) {
    const margin = 10
    paperW = (maxX < 0 ? 0 : maxX) + margin
    paperH = (maxY < 0 ? 0 : maxY) + margin
  } else {
    paperW = 210; paperH = 297  // fallback A4 portrait
  }

  // ── Compute scale: fit the larger of paper/envelope into the canvas ───────

  const cw = (ctx.canvas as HTMLCanvasElement | OffscreenCanvas).width
  const ch = (ctx.canvas as HTMLCanvasElement | OffscreenCanvas).height

  const envW = options.envelope ? Math.max(options.envelope.widthMm, paperW) : paperW
  const envH = options.envelope ? Math.max(options.envelope.heightMm, paperH) : paperH

  const scaleW = (cw - paddingPx * 2) / envW
  const scaleH = (ch - paddingPx * 2) / envH
  const pxPerMm = Math.min(scaleW, scaleH)

  // Offset so the origin (0, 0) sits within the padded area.
  const originX = paddingPx
  const originY = paddingPx

  function toCanvas(xMm: number, yMm: number): [number, number] {
    return [originX + xMm * pxPerMm, originY + yMm * pxPerMm]
  }

  // ── Background ────────────────────────────────────────────────────────────

  ctx.save()
  ctx.fillStyle = backgroundColor
  ctx.fillRect(0, 0, cw, ch)

  // ── Machine envelope ──────────────────────────────────────────────────────

  if (options.envelope) {
    const [ex, ey] = toCanvas(0, 0)
    ctx.strokeStyle = '#c8c2b8'
    ctx.lineWidth = 0.5
    ctx.setLineDash([3, 4])
    ctx.strokeRect(ex, ey, options.envelope.widthMm * pxPerMm, options.envelope.heightMm * pxPerMm)
    ctx.setLineDash([])
  }

  // ── Paper rect ────────────────────────────────────────────────────────────

  const [px, py] = toCanvas(0, 0)
  ctx.fillStyle = paperColor
  ctx.fillRect(px, py, paperW * pxPerMm, paperH * pxPerMm)
  ctx.strokeStyle = '#bbb'
  ctx.lineWidth = 0.5
  ctx.strokeRect(px, py, paperW * pxPerMm, paperH * pxPerMm)

  // ── Origin crosshair ──────────────────────────────────────────────────────

  if (showOrigin) {
    const [ox, oy] = toCanvas(0, 0)
    const r = 3
    ctx.strokeStyle = '#d33'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    ctx.arc(ox, oy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(ox - r * 1.8, oy); ctx.lineTo(ox + r * 1.8, oy)
    ctx.moveTo(ox, oy - r * 1.8); ctx.lineTo(ox, oy + r * 1.8)
    ctx.stroke()
  }

  // ── Walk moves → draw ─────────────────────────────────────────────────────

  let pendownM  = 0
  let travelM   = 0
  let penLifts  = 0

  const nibPx = Math.max(0.5, nibSizeMm * pxPerMm)

  // Resolve ink color for a given layer number (from the move sequence).
  // Moves don't carry layer info directly, but we can track which layer is
  // active by watching for pen-up → pen-down transitions at known positions.
  // For now use a single color or the inkColor array in order of strokes.
  const inkColors = Array.isArray(inkColor) ? inkColor : [inkColor]
  let strokeIndex = 0

  let i = 0
  let curX = moves.length > 0 ? moves[0].x : 0
  let curY = moves.length > 0 ? moves[0].y : 0

  while (i < moves.length) {
    const m = moves[i]

    if (!m.penDown) {
      // Pen-up travel segment
      if (showTravel) {
        const [x1, y1] = toCanvas(curX, curY)
        const [x2, y2] = toCanvas(m.x, m.y)
        const dx = m.x - curX; const dy = m.y - curY
        if (dx * dx + dy * dy > 0.01) {
          ctx.save()
          ctx.strokeStyle = 'rgba(0,0,0,0.12)'
          ctx.lineWidth = 0.6
          ctx.setLineDash([2, 3])
          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.stroke()
          ctx.restore()
        }
      }
      travelM += Math.hypot(m.x - curX, m.y - curY) / 1000
      curX = m.x; curY = m.y
      i++
      continue
    }

    // Pen-down stroke: gather consecutive pen-down points
    const layerKey = (m as PlannerMove & { layer?: number }).layer
    const color = (layerKey !== undefined && layerColors[layerKey])
      ? layerColors[layerKey]
      : inkColors[strokeIndex % inkColors.length]!

    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = nibPx
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.setLineDash([])
    ctx.beginPath()
    const [sx, sy] = toCanvas(curX, curY)
    ctx.moveTo(sx, sy)

    while (i < moves.length && moves[i].penDown) {
      const mv = moves[i]
      const [cx2, cy2] = toCanvas(mv.x, mv.y)
      ctx.lineTo(cx2, cy2)
      pendownM += Math.hypot(mv.x - curX, mv.y - curY) / 1000
      curX = mv.x; curY = mv.y
      i++
    }

    ctx.stroke()
    ctx.restore()

    penLifts++
    strokeIndex++
  }

  ctx.restore()

  // ── Stats ─────────────────────────────────────────────────────────────────

  const totalM = pendownM + travelM
  const travelOverheadPct = totalM > 0.0001
    ? Math.round((travelM / totalM) * 100)
    : null

  const contentMm = hasContent
    ? { minX, minY, maxX, maxY }
    : null

  return { pendownM, travelM, penLifts, travelOverheadPct, contentMm }
}

// ─── SVG output (universal — no DOM needed) ───────────────────────────────────

/**
 * Render a move sequence as an SVG string. Works in any environment (Node,
 * browser, worker) without a canvas. The returned string can be written to a
 * `.svg` file, inlined in HTML, or rendered with an image viewer.
 */
export function renderPreviewSvg(
  moves: PlannerMove[],
  options: PreviewRenderOptions & {
    /** Output canvas width in px (used as SVG viewBox). Default: 900. */
    widthPx?: number
    /** Output canvas height in px. Default: 600. */
    heightPx?: number
  } = {},
): string {
  const {
    paddingPx      = 24,
    showTravel     = true,
    showOrigin     = true,
    nibSizeMm      = 0.35,
    backgroundColor = '#ede8dd',
    paperColor     = '#fdfcf7',
    inkColor       = '#1a1a1a',
    layerColors    = {},
    widthPx        = 900,
    heightPx       = 600,
  } = options

  const inkColors = Array.isArray(inkColor) ? inkColor : [inkColor]

  // ── Bounding box ──────────────────────────────────────────────────────────
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of moves) {
    if (!m.penDown) continue
    if (m.x < minX) minX = m.x; if (m.x > maxX) maxX = m.x
    if (m.y < minY) minY = m.y; if (m.y > maxY) maxY = m.y
  }
  const hasContent = isFinite(minX)

  let paperW: number, paperH: number
  if (options.paper) {
    paperW = options.paper.widthMm; paperH = options.paper.heightMm
  } else if (hasContent) {
    paperW = (maxX < 0 ? 0 : maxX) + 10; paperH = (maxY < 0 ? 0 : maxY) + 10
  } else {
    paperW = 210; paperH = 297
  }

  const envW = options.envelope ? Math.max(options.envelope.widthMm, paperW) : paperW
  const envH = options.envelope ? Math.max(options.envelope.heightMm, paperH) : paperH
  const pxPerMm = Math.min((widthPx - paddingPx * 2) / envW, (heightPx - paddingPx * 2) / envH)
  const ox = paddingPx, oy = paddingPx

  function x(mm: number): string { return f2(ox + mm * pxPerMm) }
  function y(mm: number): string { return f2(oy + mm * pxPerMm) }
  function mm(val: number): string { return f2(val * pxPerMm) }

  const parts: string[] = []

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">`)
  parts.push(`<rect width="${widthPx}" height="${heightPx}" fill="${backgroundColor}"/>`)

  if (options.envelope) {
    parts.push(`<rect x="${x(0)}" y="${y(0)}" width="${mm(options.envelope.widthMm)}" height="${mm(options.envelope.heightMm)}" fill="none" stroke="#c8c2b8" stroke-width="0.5" stroke-dasharray="3 4"/>`)
  }

  parts.push(`<rect x="${x(0)}" y="${y(0)}" width="${mm(paperW)}" height="${mm(paperH)}" fill="${paperColor}" stroke="#bbb" stroke-width="0.5"/>`)

  if (showOrigin) {
    const r = 3
    parts.push(`<circle cx="${x(0)}" cy="${y(0)}" r="${r}" fill="none" stroke="#d33" stroke-width="0.8"/>`)
    parts.push(`<line x1="${f2(ox - r * 1.8)}" y1="${y(0)}" x2="${f2(ox + r * 1.8)}" y2="${y(0)}" stroke="#d33" stroke-width="0.8"/>`)
    parts.push(`<line x1="${x(0)}" y1="${f2(oy - r * 1.8)}" x2="${x(0)}" y2="${f2(oy + r * 1.8)}" stroke="#d33" stroke-width="0.8"/>`)
  }

  // ── Walk moves ────────────────────────────────────────────────────────────
  const nibPx = Math.max(0.5, nibSizeMm * pxPerMm)
  let strokeIndex = 0
  let i = 0
  let curX = moves.length > 0 ? moves[0].x : 0
  let curY = moves.length > 0 ? moves[0].y : 0

  const travelPaths: string[] = []
  const strokeGroups: string[] = []

  while (i < moves.length) {
    const m = moves[i]

    if (!m.penDown) {
      if (showTravel) {
        const dx = m.x - curX, dy = m.y - curY
        if (dx * dx + dy * dy > 0.01) {
          travelPaths.push(`M${x(curX)},${y(curY)}L${x(m.x)},${y(m.y)}`)
        }
      }
      curX = m.x; curY = m.y
      i++
      continue
    }

    const layerKey = (m as PlannerMove & { layer?: number }).layer
    const color = (layerKey !== undefined && layerColors[layerKey])
      ? layerColors[layerKey]
      : inkColors[strokeIndex % inkColors.length]!

    let d = `M${x(curX)},${y(curY)}`
    while (i < moves.length && moves[i].penDown) {
      const mv = moves[i]
      d += `L${x(mv.x)},${y(mv.y)}`
      curX = mv.x; curY = mv.y
      i++
    }

    strokeGroups.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${f2(nibPx)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    strokeIndex++
  }

  if (travelPaths.length > 0) {
    parts.push(`<path d="${travelPaths.join(' ')}" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="0.6" stroke-dasharray="2 3"/>`)
  }
  for (const sg of strokeGroups) parts.push(sg)

  parts.push('</svg>')
  return parts.join('\n')
}

function f2(n: number): string { return parseFloat(n.toFixed(2)).toString() }
