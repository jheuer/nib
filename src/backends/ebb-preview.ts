/**
 * EBB-native preview stats
 *
 * Computes preview statistics locally from the SVG move sequence — no axicli,
 * no hardware. Used when --backend ebb is specified, or as a fallback when
 * axicli is not installed.
 *
 * Results are equivalent (not identical) to axicli --preview output: the path
 * ordering and bezier flattening resolution differ slightly, but distances and
 * lift counts are accurate to ~1%.
 */

import { svgToMoves } from './svg-to-moves.ts'
import type { PlannerMove } from './svg-to-moves.ts'
import type { ResolvedProfile } from '../core/job.ts'
import type { PreviewStats } from './axicli.ts'
import { planMove, planStroke, optionsForProfile } from '../core/planner.ts'
import { reorder, type OptimizeLevel } from '../core/reorder.ts'

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute preview statistics from an SVG string + profile, without hardware.
 *
 * Applies the same reorder level the plot will use, so lift count / travel /
 * ETA reflect what actually happens on paper — not the raw document order.
 */
export function previewStatsFromSvg(
  svg: string,
  profile: ResolvedProfile,
  optimize: OptimizeLevel = 0,
): PreviewStats {
  const raw = svgToMoves(svg, { tolerance: 0.05 })
  const { moves } = reorder(raw, optimize)
  return previewStatsFromMoves(moves, profile)
}

/**
 * Compute preview statistics from a pre-computed move sequence.
 * Useful when you already have the moves (e.g. from a series preview);
 * caller is expected to have already reordered if they want optimization applied.
 */
export function previewStatsFromMoves(moves: PlannerMove[], profile: ResolvedProfile): PreviewStats {
  let pendownM  = 0
  let travelM   = 0
  let penLifts  = 0
  let motionS   = 0

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  // Walk moves, grouping pen-down runs into strokes (matching EBBBackend.runJob).
  // For each stroke/travel, we call the actual motion planner and sum durations
  // so the ETA matches what will happen on hardware (trapezoid + junction speeds
  // + rest-to-rest between strokes), not a naive distance/speed quotient.
  const penDownOpts = optionsForProfile(profile, true)
  const penUpOpts   = optionsForProfile(profile, false)

  let i = 0
  let curX = moves.length > 0 ? moves[0].x : 0
  let curY = moves.length > 0 ? moves[0].y : 0
  while (i < moves.length) {
    const m = moves[i]
    if (!m.penDown) {
      const dx = m.x - curX
      const dy = m.y - curY
      const dist = Math.hypot(dx, dy)
      if (dist > 0.001) {
        travelM += dist / 1000
        motionS += planMove(dx, dy, 0, 0, penUpOpts).durationS
      }
      curX = m.x; curY = m.y
      i++
      continue
    }
    // Pen-down stroke: gather consecutive pen-down points
    const pts: { x: number; y: number }[] = [{ x: curX, y: curY }]
    while (i < moves.length && moves[i].penDown) {
      pts.push({ x: moves[i].x, y: moves[i].y })
      // Bounding box is computed from pen-down moves only
      minX = Math.min(minX, moves[i].x); maxX = Math.max(maxX, moves[i].x)
      minY = Math.min(minY, moves[i].y); maxY = Math.max(maxY, moves[i].y)
      i++
    }
    if (pts.length < 2) continue
    penLifts++
    // Stroke distance
    for (let k = 1; k < pts.length; k++) {
      pendownM += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) / 1000
    }
    // Stroke duration via the real planner (junction velocities)
    for (const pm of planStroke(pts, penDownOpts)) {
      motionS += pm.durationS
    }
    curX = pts[pts.length - 1].x
    curY = pts[pts.length - 1].y
  }

  // Pen transition overhead per stroke: ~80 ms for penUpFast (overlaps with
  // travel), ~270 ms for penDown full settle (blocks before stroke starts).
  // Call it 350 ms / stroke.
  const penTransitionS = penLifts * 0.35

  const totalM = pendownM + travelM
  const travelOverheadPct = totalM > 0 ? Math.round((travelM / totalM) * 100) : null

  const estimatedS = motionS + penTransitionS

  const boundingBoxMm = (isFinite(minX) && isFinite(minY))
    ? { width: maxX - minX, height: maxY - minY }
    : null

  const fitsA4 = boundingBoxMm
    ? boundingBoxMm.width <= 210 && boundingBoxMm.height <= 297
    : null
  const fitsA3 = boundingBoxMm
    ? boundingBoxMm.width <= 297 && boundingBoxMm.height <= 420
    : null

  return {
    pendownM:          roundM(pendownM),
    travelM:           roundM(travelM),
    travelOverheadPct,
    estimatedS:        estimatedS > 0 ? Math.round(estimatedS) : null,
    penLifts,
    boundingBoxMm,
    fitsA4,
    fitsA3,
    rawLines: [],   // no subprocess output
  }
}

function roundM(m: number): number {
  return parseFloat(m.toFixed(4))
}
