/**
 * Pure geometry primitives for code-first generative sketches.
 *
 * Every function returns a `Stroke` (or `Stroke[]` for shapes that naturally
 * produce multiple, like a group of rect corners). Consumers compose these
 * into a scene and pass to `plotStrokes`.
 *
 * No I/O, no side effects, no framework dependencies — safe to use in any
 * runtime (Node, Bun, browser, Deno).
 */

import type { Point, Stroke } from './stroke.ts'

// Default flatness tolerance: how far a flattened curve may deviate from the
// true curve, in mm. 0.1 mm matches svg-to-moves default and is visually
// perfect for a 0.3mm fineliner.
const DEFAULT_TOL_MM = 0.1

// ─── Straight primitives ──────────────────────────────────────────────────────

/** A single straight line segment from `a` to `b`. */
export function line(a: Point, b: Point): Stroke {
  return { points: [{ ...a }, { ...b }] }
}

/** Multi-segment polyline through the given points. At least 2 points required. */
export function polyline(points: Point[]): Stroke {
  return { points: points.map(p => ({ ...p })) }
}

/** Closed polygon — same as polyline with the first point appended at the end. */
export function polygon(points: Point[]): Stroke {
  if (points.length < 3) return { points: points.map(p => ({ ...p })) }
  const closed = points.map(p => ({ ...p }))
  closed.push({ ...points[0] })
  return { points: closed }
}

/**
 * Axis-aligned rectangle as a single closed stroke. `rx`/`ry` produce a
 * rounded rectangle (0 = sharp corners). Origin is the top-left corner.
 */
export function rect(
  x: number, y: number,
  width: number, height: number,
  rx = 0, ry = rx,
  tolMm = DEFAULT_TOL_MM,
): Stroke {
  const w = width, h = height
  if (rx === 0 && ry === 0) {
    return polygon([
      { x,         y         },
      { x: x + w,  y         },
      { x: x + w,  y: y + h  },
      { x,         y: y + h  },
    ])
  }

  // Rounded: straight edges + 4 quarter-circle bezier corners.
  const rxC = Math.min(rx, w / 2)
  const ryC = Math.min(ry, h / 2)
  const k = 0.5522847498   // quarter-circle bezier kappa
  const kx = rxC * k
  const ky = ryC * k

  const points: Point[] = []
  const emit = (p: Point) => {
    const last = points[points.length - 1]
    if (!last || last.x !== p.x || last.y !== p.y) points.push(p)
  }

  // Start at the top-right of the top edge's rounded arc entry
  emit({ x: x + rxC, y })

  // Top edge
  emit({ x: x + w - rxC, y })
  // Top-right corner
  flattenCubic(
    x + w - rxC, y,
    x + w - rxC + kx, y,
    x + w, y + ryC - ky,
    x + w, y + ryC,
    tolMm, emit,
  )
  // Right edge
  emit({ x: x + w, y: y + h - ryC })
  // Bottom-right corner
  flattenCubic(
    x + w, y + h - ryC,
    x + w, y + h - ryC + ky,
    x + w - rxC + kx, y + h,
    x + w - rxC, y + h,
    tolMm, emit,
  )
  // Bottom edge
  emit({ x: x + rxC, y: y + h })
  // Bottom-left corner
  flattenCubic(
    x + rxC, y + h,
    x + rxC - kx, y + h,
    x, y + h - ryC + ky,
    x, y + h - ryC,
    tolMm, emit,
  )
  // Left edge
  emit({ x, y: y + ryC })
  // Top-left corner
  flattenCubic(
    x, y + ryC,
    x, y + ryC - ky,
    x + rxC - kx, y,
    x + rxC, y,
    tolMm, emit,
  )

  return { points }
}

// ─── Curves ───────────────────────────────────────────────────────────────────

/**
 * Circle centered at `center` with radius `r`. Approximated with 4 cubic
 * beziers (standard kappa ≈ 0.5523) flattened to `tolMm`.
 */
export function circle(center: Point, r: number, tolMm = DEFAULT_TOL_MM): Stroke {
  return ellipse(center, r, r, tolMm)
}

/**
 * Ellipse centered at `center` with horizontal radius `rx` and vertical
 * radius `ry`. Four quadrants, flattened.
 */
export function ellipse(center: Point, rx: number, ry: number, tolMm = DEFAULT_TOL_MM): Stroke {
  const k = 0.5522847498
  const cx = center.x, cy = center.y
  const kx = rx * k, ky = ry * k
  const points: Point[] = []
  const emit = (p: Point) => {
    const last = points[points.length - 1]
    if (!last || last.x !== p.x || last.y !== p.y) points.push(p)
  }

  emit({ x: cx + rx, y: cy })
  // Quadrant I → II
  flattenCubic(cx + rx, cy,  cx + rx, cy + ky,  cx + kx, cy + ry,  cx,       cy + ry, tolMm, emit)
  // II → III
  flattenCubic(cx,      cy + ry, cx - kx, cy + ry, cx - rx, cy + ky,  cx - rx,  cy,      tolMm, emit)
  // III → IV
  flattenCubic(cx - rx, cy,      cx - rx, cy - ky, cx - kx, cy - ry,  cx,       cy - ry, tolMm, emit)
  // IV → I
  flattenCubic(cx,      cy - ry, cx + kx, cy - ry, cx + rx, cy - ky,  cx + rx,  cy,      tolMm, emit)

  return { points }
}

/**
 * Circular arc from angle `a0` to `a1` (radians, counterclockwise positive,
 * 0 = +x axis) around `center` with radius `r`. For short arcs this is much
 * cheaper than constructing a full circle and chopping it.
 *
 * Implemented by subdividing into ≤ 90° chunks, each a single cubic bezier
 * approximation with a k-factor that depends on the subtended angle. Then
 * flatten to tolerance.
 */
export function arc(
  center: Point, r: number,
  a0: number, a1: number,
  tolMm = DEFAULT_TOL_MM,
): Stroke {
  const points: Point[] = []
  const emit = (p: Point) => {
    const last = points[points.length - 1]
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) points.push(p)
  }

  const total = a1 - a0
  const dir = Math.sign(total) || 1
  const absTotal = Math.abs(total)
  const nSegs = Math.max(1, Math.ceil(absTotal / (Math.PI / 2)))
  const da = total / nSegs

  // Start point
  emit({ x: center.x + r * Math.cos(a0), y: center.y + r * Math.sin(a0) })

  for (let i = 0; i < nSegs; i++) {
    const theta0 = a0 + i * da
    const theta1 = theta0 + da
    const sub = Math.abs(theta1 - theta0)
    // Bezier k-factor for a circular arc of angle `sub`:
    //   k = (4/3) * tan(sub/4)
    const k = (4 / 3) * Math.tan(sub / 4)

    const p0x = center.x + r * Math.cos(theta0)
    const p0y = center.y + r * Math.sin(theta0)
    const p3x = center.x + r * Math.cos(theta1)
    const p3y = center.y + r * Math.sin(theta1)

    // Control points, tangent to the circle at p0 and p3
    const p1x = p0x - dir * r * k * Math.sin(theta0)
    const p1y = p0y + dir * r * k * Math.cos(theta0)
    const p2x = p3x + dir * r * k * Math.sin(theta1)
    const p2y = p3y - dir * r * k * Math.cos(theta1)

    flattenCubic(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, tolMm, emit)
  }

  return { points }
}

/**
 * Flattened cubic bezier from p0 to p3 with control points p1 and p2.
 * Returns a single stroke tracing the curve.
 */
export function bezier(
  p0: Point, p1: Point, p2: Point, p3: Point,
  tolMm = DEFAULT_TOL_MM,
): Stroke {
  const points: Point[] = [{ ...p0 }]
  flattenCubic(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, tolMm, p => {
    const last = points[points.length - 1]
    if (!last || last.x !== p.x || last.y !== p.y) points.push(p)
  })
  return { points }
}

/** Flattened quadratic bezier — delegates to cubic via the standard lift. */
export function quadBezier(
  p0: Point, p1: Point, p2: Point,
  tolMm = DEFAULT_TOL_MM,
): Stroke {
  // Cubic equivalent control points: (p0 + 2·p1) / 3 and (p2 + 2·p1) / 3
  const c1 = { x: (p0.x + 2 * p1.x) / 3, y: (p0.y + 2 * p1.y) / 3 }
  const c2 = { x: (p2.x + 2 * p1.x) / 3, y: (p2.y + 2 * p1.y) / 3 }
  return bezier(p0, c1, c2, p2, tolMm)
}

// ─── Composition helpers ──────────────────────────────────────────────────────

/**
 * Translate every point of every stroke by (dx, dy). Returns a new array;
 * input is not mutated.
 */
export function translate(strokes: Stroke[], dx: number, dy: number): Stroke[] {
  return strokes.map(s => ({
    ...s,
    points: s.points.map(p => ({ x: p.x + dx, y: p.y + dy })),
  }))
}

/**
 * Scale every point of every stroke around origin (0, 0). Pass a single
 * number for uniform scale or {x, y} for non-uniform.
 */
export function scale(
  strokes: Stroke[],
  s: number | { x: number; y: number },
): Stroke[] {
  const sx = typeof s === 'number' ? s : s.x
  const sy = typeof s === 'number' ? s : s.y
  return strokes.map(stroke => ({
    ...stroke,
    points: stroke.points.map(p => ({ x: p.x * sx, y: p.y * sy })),
  }))
}

/**
 * Rotate every stroke by `radians` around the given pivot (default origin).
 */
export function rotate(
  strokes: Stroke[],
  radians: number,
  pivot: Point = { x: 0, y: 0 },
): Stroke[] {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return strokes.map(stroke => ({
    ...stroke,
    points: stroke.points.map(p => {
      const dx = p.x - pivot.x
      const dy = p.y - pivot.y
      return {
        x: pivot.x + dx * cos - dy * sin,
        y: pivot.y + dx * sin + dy * cos,
      }
    }),
  }))
}

// ─── Internal: cubic bezier flattening ────────────────────────────────────────

/**
 * Adaptively flatten a cubic bezier curve. Uses the control-point deviation
 * test: if the sum of distances from the control points to the chord is below
 * the tolerance, emit the endpoint; otherwise subdivide at t=0.5 and recurse.
 */
function flattenCubic(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  tol: number,
  emit: (p: Point) => void,
): void {
  // Cheap flatness test using control-point deviations. Not exact, but fast
  // and good enough for plotter tolerances.
  const d1 = Math.abs(x1 - (2 * x1 - x0)) + Math.abs(y1 - (2 * y1 - y0))
  const d2 = Math.abs(x2 - (2 * x2 - x3)) + Math.abs(y2 - (2 * y2 - y3))

  if (d1 + d2 < tol * 4) {
    emit({ x: x3, y: y3 })
    return
  }

  // de Casteljau subdivide at t=0.5
  const mx01 = (x0 + x1) / 2, my01 = (y0 + y1) / 2
  const mx12 = (x1 + x2) / 2, my12 = (y1 + y2) / 2
  const mx23 = (x2 + x3) / 2, my23 = (y2 + y3) / 2
  const mx012 = (mx01 + mx12) / 2, my012 = (my01 + my12) / 2
  const mx123 = (mx12 + mx23) / 2, my123 = (my12 + my23) / 2
  const mx = (mx012 + mx123) / 2, my = (my012 + my123) / 2

  flattenCubic(x0, y0, mx01, my01, mx012, my012, mx, my, tol, emit)
  flattenCubic(mx, my, mx123, my123, mx23, my23, x3, y3, tol, emit)
}
