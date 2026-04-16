/**
 * Path reordering for plotter moves
 *
 * Reorders pen-down strokes to minimise travel distance between them. Matches
 * the intent of axicli's --reordering flag with three levels:
 *
 *   0 — no reorder (document order)
 *   1 — nearest-neighbor greedy on stroke endpoints
 *   2 — NN + stroke reversal (pick the endpoint that's closer) + light 2-opt
 *
 * Input is a flat `PlannerMove[]` as produced by svgToMoves; output is a new
 * array of the same shape. The first pen-up at (0,0) is preserved so downstream
 * consumers see the same origin.
 */

import type { PlannerMove } from '../backends/svg-to-moves.ts'

// ─── Public API ───────────────────────────────────────────────────────────────

export type OptimizeLevel = 0 | 1 | 2

export interface ReorderStats {
  penLiftsBefore: number
  penLiftsAfter: number
  travelMmBefore: number
  travelMmAfter: number
}

export interface ReorderResult {
  moves: PlannerMove[]
  stats: ReorderStats
}

/**
 * Reorder strokes for shorter travel. Level 0 returns input + computed stats.
 */
export function reorder(moves: PlannerMove[], level: OptimizeLevel): ReorderResult {
  const strokes = extractStrokes(moves)
  const travelBefore = computeTravel(moves)
  const liftsBefore = strokes.length

  if (level === 0 || strokes.length < 2) {
    return {
      moves,
      stats: {
        penLiftsBefore: liftsBefore,
        penLiftsAfter: liftsBefore,
        travelMmBefore: travelBefore,
        travelMmAfter: travelBefore,
      },
    }
  }

  const allowReverse = level >= 2
  const origin = findOrigin(moves)
  let ordered = nearestNeighbor(strokes, origin, allowReverse)
  if (level >= 2) ordered = twoOpt(ordered, origin, 2)

  const rebuilt = rebuildMoves(origin, ordered)
  const travelAfter = computeTravel(rebuilt)

  return {
    moves: rebuilt,
    stats: {
      penLiftsBefore: liftsBefore,
      penLiftsAfter: ordered.length,
      travelMmBefore: travelBefore,
      travelMmAfter: travelAfter,
    },
  }
}

// ─── Strokes ──────────────────────────────────────────────────────────────────

interface Stroke {
  points: PlannerMove[]   // first is the pen-down entry; all are penDown=true
}

/** Extract contiguous pen-down runs. The entry point is the move that flipped from up→down. */
function extractStrokes(moves: PlannerMove[]): Stroke[] {
  const strokes: Stroke[] = []
  let current: PlannerMove[] | null = null

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    if (m.penDown) {
      if (current === null) {
        // Start of a new stroke — prepend the last pen-up position as the entry point
        const entry = moves[i - 1]
        if (entry) current = [{ x: entry.x, y: entry.y, penDown: true }]
        else current = []
      }
      current.push(m)
    } else if (current !== null) {
      if (current.length >= 2) strokes.push({ points: current })
      current = null
    }
  }
  if (current !== null && current.length >= 2) strokes.push({ points: current })
  return strokes
}

function findOrigin(moves: PlannerMove[]): { x: number; y: number } {
  // Use the first move (conventionally a pen-up at (0,0)) as start.
  if (moves.length === 0) return { x: 0, y: 0 }
  return { x: moves[0].x, y: moves[0].y }
}

// ─── Nearest-neighbor greedy ──────────────────────────────────────────────────

function nearestNeighbor(
  strokes: Stroke[],
  origin: { x: number; y: number },
  allowReverse: boolean,
): Stroke[] {
  const remaining = [...strokes]
  const out: Stroke[] = []
  let cx = origin.x
  let cy = origin.y

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    let bestReversed = false

    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i]
      const head = s.points[0]
      const tail = s.points[s.points.length - 1]
      const dHead = dist2(cx, cy, head.x, head.y)
      if (dHead < bestDist) { bestDist = dHead; bestIdx = i; bestReversed = false }
      if (allowReverse) {
        const dTail = dist2(cx, cy, tail.x, tail.y)
        if (dTail < bestDist) { bestDist = dTail; bestIdx = i; bestReversed = true }
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0]
    const s = bestReversed ? { points: [...chosen.points].reverse() } : chosen
    out.push(s)
    const last = s.points[s.points.length - 1]
    cx = last.x
    cy = last.y
  }

  return out
}

// ─── 2-opt polish ─────────────────────────────────────────────────────────────

/**
 * Light 2-opt on the ordered stroke list. For each pair (i, j), test whether
 * reversing the sub-range [i..j] reduces total travel. Up to `passes` sweeps.
 * Complexity: O(passes * n²). Cheap for typical plotter SVGs (< 500 strokes).
 */
function twoOpt(
  strokes: Stroke[],
  origin: { x: number; y: number },
  passes: number,
): Stroke[] {
  if (strokes.length < 3) return strokes
  let order = strokes.slice()
  const n = order.length

  for (let pass = 0; pass < passes; pass++) {
    let improved = false
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const delta = twoOptDelta(order, origin, i, j)
        if (delta < -1e-6) {
          order = reverseRange(order, i, j)
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return order
}

/** Travel-distance delta for reversing strokes[i..j] (negative = improvement). */
function twoOptDelta(
  strokes: Stroke[],
  origin: { x: number; y: number },
  i: number,
  j: number,
): number {
  const prevEnd = i === 0
    ? origin
    : endpoint(strokes[i - 1], 'end')
  const nextStart = j + 1 < strokes.length
    ? endpoint(strokes[j + 1], 'start')
    : null

  const iHead  = endpoint(strokes[i], 'start')
  const jTail  = endpoint(strokes[j], 'end')

  // Current travel: prevEnd → iHead, jTail → nextStart (if exists)
  const curIn  = Math.sqrt(dist2(prevEnd.x, prevEnd.y, iHead.x, iHead.y))
  const curOut = nextStart ? Math.sqrt(dist2(jTail.x, jTail.y, nextStart.x, nextStart.y)) : 0

  // Reversed: the block becomes strokes[j..i] each also reversed
  // prevEnd → reversed head of (was strokes[j]) = jTail, then reversed tail of (was strokes[i]) = iHead → nextStart
  const newIn  = Math.sqrt(dist2(prevEnd.x, prevEnd.y, jTail.x, jTail.y))
  const newOut = nextStart ? Math.sqrt(dist2(iHead.x, iHead.y, nextStart.x, nextStart.y)) : 0

  return (newIn + newOut) - (curIn + curOut)
}

function reverseRange(strokes: Stroke[], i: number, j: number): Stroke[] {
  const out = strokes.slice()
  const sub = out.slice(i, j + 1).reverse().map(s => ({ points: [...s.points].reverse() }))
  out.splice(i, j - i + 1, ...sub)
  return out
}

function endpoint(s: Stroke, which: 'start' | 'end'): PlannerMove {
  return which === 'start' ? s.points[0] : s.points[s.points.length - 1]
}

// ─── Rebuild PlannerMove[] from ordered strokes ──────────────────────────────

function rebuildMoves(
  origin: { x: number; y: number },
  strokes: Stroke[],
): PlannerMove[] {
  const out: PlannerMove[] = [{ x: origin.x, y: origin.y, penDown: false }]
  for (const s of strokes) {
    // Entry point as pen-up travel
    const entry = s.points[0]
    out.push({ x: entry.x, y: entry.y, penDown: false })
    // Pen-down points (skip entry; it was just the travel target)
    for (let i = 1; i < s.points.length; i++) {
      out.push({ x: s.points[i].x, y: s.points[i].y, penDown: true })
    }
  }
  // End pen-up at the last stroke's tail
  const last = out[out.length - 1]
  if (last.penDown) out.push({ x: last.x, y: last.y, penDown: false })
  return out
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function computeTravel(moves: PlannerMove[]): number {
  let travel = 0
  for (let i = 1; i < moves.length; i++) {
    const cur = moves[i]
    if (cur.penDown) continue
    const prev = moves[i - 1]
    travel += Math.sqrt(dist2(prev.x, prev.y, cur.x, cur.y))
  }
  return travel
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}
