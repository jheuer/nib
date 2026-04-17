import { describe, it, expect } from 'bun:test'
import {
  line, polyline, polygon, rect, circle, ellipse, arc, bezier, quadBezier,
  translate, scale, rotate,
  simplifyPolyline, simplifyStrokes,
} from '../src/core/geom.ts'
import type { Point } from '../src/core/stroke.ts'

const closeEnough = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol

describe('line', () => {
  it('two points, exact', () => {
    const s = line({ x: 0, y: 0 }, { x: 10, y: 5 })
    expect(s.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 5 }])
  })
})

describe('polyline / polygon', () => {
  it('polyline copies the input', () => {
    const input = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    const s = polyline(input)
    expect(s.points).toEqual(input)
    // Mutation independence
    input[0].x = 999
    expect(s.points[0].x).toBe(0)
  })

  it('polygon closes with the first point', () => {
    const s = polygon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(s.points.length).toBe(4)
    expect(s.points[s.points.length - 1]).toEqual({ x: 0, y: 0 })
  })
})

describe('rect', () => {
  it('axis-aligned sharp corners: 5 points (closed)', () => {
    const s = rect(0, 0, 10, 20)
    expect(s.points.length).toBe(5)
    expect(s.points[0]).toEqual({ x: 0,  y: 0  })
    expect(s.points[1]).toEqual({ x: 10, y: 0  })
    expect(s.points[2]).toEqual({ x: 10, y: 20 })
    expect(s.points[3]).toEqual({ x: 0,  y: 20 })
    expect(s.points[4]).toEqual({ x: 0,  y: 0  })
  })

  it('rounded rect has more points and stays inside the bounding box', () => {
    const s = rect(0, 0, 100, 50, 10, 10, 0.1)
    expect(s.points.length).toBeGreaterThan(10)
    for (const p of s.points) {
      expect(p.x).toBeGreaterThanOrEqual(-0.001)
      expect(p.y).toBeGreaterThanOrEqual(-0.001)
      expect(p.x).toBeLessThanOrEqual(100.001)
      expect(p.y).toBeLessThanOrEqual(50.001)
    }
  })
})

describe('circle / ellipse', () => {
  it('circle points all lie on the radius circle', () => {
    const s = circle({ x: 0, y: 0 }, 10, 0.05)
    for (const p of s.points) {
      const r = Math.hypot(p.x, p.y)
      expect(Math.abs(r - 10)).toBeLessThan(0.1)
    }
  })

  it('ellipse points satisfy the ellipse equation', () => {
    const s = ellipse({ x: 0, y: 0 }, 20, 10, 0.05)
    for (const p of s.points) {
      const value = (p.x / 20) ** 2 + (p.y / 10) ** 2
      expect(Math.abs(value - 1)).toBeLessThan(0.01)
    }
  })

  it('circle has at least 4 distinct quadrant points', () => {
    const s = circle({ x: 50, y: 50 }, 10)
    const hasRight = s.points.some(p => p.x > 59 && Math.abs(p.y - 50) < 1)
    const hasTop   = s.points.some(p => p.y > 59 && Math.abs(p.x - 50) < 1)
    const hasLeft  = s.points.some(p => p.x < 41 && Math.abs(p.y - 50) < 1)
    const hasBot   = s.points.some(p => p.y < 41 && Math.abs(p.x - 50) < 1)
    expect(hasRight && hasTop && hasLeft && hasBot).toBe(true)
  })
})

describe('arc', () => {
  it('quarter arc (0 → π/2) from r*î to r*ĵ', () => {
    const s = arc({ x: 0, y: 0 }, 10, 0, Math.PI / 2, 0.05)
    const first = s.points[0]
    const last  = s.points[s.points.length - 1]
    expect(closeEnough(first.x, 10, 0.1)).toBe(true)
    expect(closeEnough(first.y, 0,  0.1)).toBe(true)
    expect(closeEnough(last.x,  0,  0.1)).toBe(true)
    expect(closeEnough(last.y,  10, 0.1)).toBe(true)
    // All points on the radius
    for (const p of s.points) {
      const r = Math.hypot(p.x, p.y)
      expect(Math.abs(r - 10)).toBeLessThan(0.1)
    }
  })

  it('full circle via arc(0, 2π) behaves like circle', () => {
    const a = arc({ x: 0, y: 0 }, 5, 0, 2 * Math.PI, 0.05)
    for (const p of a.points) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 5)).toBeLessThan(0.1)
    }
  })
})

describe('bezier / quadBezier', () => {
  it('cubic endpoints match input', () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 20, y: 50 }, p2 = { x: 80, y: 50 }, p3 = { x: 100, y: 0 }
    const s = bezier(p0, p1, p2, p3, 0.05)
    expect(s.points[0]).toEqual(p0)
    expect(s.points[s.points.length - 1]).toEqual(p3)
  })

  it('quadratic endpoints match input', () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 50, y: 100 }, p2 = { x: 100, y: 0 }
    const s = quadBezier(p0, p1, p2, 0.05)
    expect(s.points[0]).toEqual(p0)
    expect(s.points[s.points.length - 1].x).toBeCloseTo(p2.x, 3)
    expect(s.points[s.points.length - 1].y).toBeCloseTo(p2.y, 3)
  })
})

describe('transforms', () => {
  const L: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]

  it('translate', () => {
    const out = translate([{ points: L }], 5, 3)
    expect(out[0].points).toEqual([{ x: 5, y: 3 }, { x: 15, y: 3 }])
  })

  it('scale uniform', () => {
    const out = scale([{ points: L }], 2)
    expect(out[0].points).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }])
  })

  it('scale non-uniform', () => {
    const out = scale([{ points: L }], { x: 2, y: 3 })
    expect(out[0].points).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }])
  })

  it('rotate 90° around origin', () => {
    const out = rotate([{ points: L }], Math.PI / 2)
    expect(out[0].points[0].x).toBeCloseTo(0, 10)
    expect(out[0].points[0].y).toBeCloseTo(0, 10)
    expect(out[0].points[1].x).toBeCloseTo(0, 10)
    expect(out[0].points[1].y).toBeCloseTo(10, 10)
  })

  it('rotate around custom pivot', () => {
    const out = rotate([{ points: L }], Math.PI, { x: 5, y: 0 })
    expect(out[0].points[0].x).toBeCloseTo(10, 10)
    expect(out[0].points[1].x).toBeCloseTo(0, 10)
  })

  it('transforms preserve skip and layer flags', () => {
    const out = translate([{ points: L, layer: 1, skip: true }], 10, 10)
    expect(out[0].layer).toBe(1)
    expect(out[0].skip).toBe(true)
  })
})

describe('simplifyPolyline', () => {
  it('colinear points collapse to endpoints', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]
    expect(simplifyPolyline(pts, 0.1)).toEqual([
      { x: 0, y: 0 }, { x: 4, y: 0 },
    ])
  })

  it('preserves corners above tolerance', () => {
    // L-shape: (0,0) → (10,0) → (10,10). Middle corner is 10mm off the direct
    // chord — preserved at any reasonable tolerance.
    const out = simplifyPolyline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.1,
    )
    expect(out.length).toBe(3)
  })

  it('drops points with small perpendicular deviation', () => {
    // Line with tiny wiggle — single off-line point 0.01mm from the chord.
    const out = simplifyPolyline(
      [{ x: 0, y: 0 }, { x: 5, y: 0.01 }, { x: 10, y: 0 }], 0.1,
    )
    expect(out.length).toBe(2)
  })

  it('keeps points with large perpendicular deviation', () => {
    // Same shape but the middle point is 2mm off — must be preserved.
    const out = simplifyPolyline(
      [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 0 }], 0.1,
    )
    expect(out.length).toBe(3)
  })

  it('always preserves first and last points', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }))
    const out = simplifyPolyline(pts, 0.5)
    expect(out[0]).toEqual({ x: 0, y: 0 })
    expect(out[out.length - 1]).toEqual({ x: 49, y: 0 })
  })

  it('degenerate inputs pass through unchanged', () => {
    expect(simplifyPolyline([], 0.1)).toEqual([])
    expect(simplifyPolyline([{ x: 0, y: 0 }], 0.1)).toEqual([{ x: 0, y: 0 }])
    expect(simplifyPolyline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.1,
    )).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
  })

  it('zero tolerance is a no-op', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]
    expect(simplifyPolyline(pts, 0)).toEqual(pts)
  })

  it('handles very long polylines without stack overflow', () => {
    // 100_000 points on a noisy line — recursive DP would overflow Bun's
    // stack; the iterative version copes fine.
    const pts = Array.from({ length: 100_000 }, (_, i) => ({
      x: i * 0.01,
      y: Math.sin(i * 0.001) * 0.01,     // noise well below 0.1mm tolerance
    }))
    const out = simplifyPolyline(pts, 0.1)
    expect(out.length).toBeLessThan(100)
  })

  it('matches a known case: flattened circle compresses aggressively', () => {
    // Circle sampled at 0.01 mm arc-length steps — huge point count that
    // should compact dramatically at 0.1mm tolerance.
    const r = 10
    const steps = 6000
    const pts = Array.from({ length: steps }, (_, i) => {
      const t = (i / steps) * 2 * Math.PI
      return { x: Math.cos(t) * r, y: Math.sin(t) * r }
    })
    const out = simplifyPolyline(pts, 0.1)
    // A circle of r=10 at 0.1mm tolerance should hit ~28-45 points — check
    // that we're in a sensible range, not point-for-point pass-through.
    expect(out.length).toBeGreaterThan(10)
    expect(out.length).toBeLessThan(200)
  })
})

describe('simplifyStrokes', () => {
  it('applies to every stroke', () => {
    const strokes = [
      { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
      { points: [{ x: 0, y: 0 }, { x: 1, y: 10 }, { x: 2, y: 0 }] },
    ]
    const out = simplifyStrokes(strokes, 0.1)
    expect(out[0].points.length).toBe(2)   // collapsed
    expect(out[1].points.length).toBe(3)   // corner preserved
  })

  it('preserves layer and skip flags', () => {
    const out = simplifyStrokes([
      { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], layer: 2, skip: true },
    ], 0.1)
    expect(out[0].layer).toBe(2)
    expect(out[0].skip).toBe(true)
  })
})
