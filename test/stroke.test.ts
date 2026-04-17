import { describe, it, expect } from 'bun:test'
import {
  strokesToMoves, movesToStrokes, strokeStats,
  type Stroke,
} from '../src/core/stroke.ts'

describe('strokesToMoves', () => {
  it('empty list → just the origin pen-up', () => {
    const moves = strokesToMoves([])
    expect(moves).toEqual([{ x: 0, y: 0, penDown: false }])
  })

  it('single line stroke → up(0,0), up(start), down(end), up(end)', () => {
    const moves = strokesToMoves([
      { points: [{ x: 10, y: 0 }, { x: 90, y: 0 }] },
    ])
    expect(moves.length).toBe(4)
    expect(moves[0]).toEqual({ x: 0,  y: 0, penDown: false })
    expect(moves[1]).toEqual({ x: 10, y: 0, penDown: false })
    expect(moves[2]).toEqual({ x: 90, y: 0, penDown: true })
    expect(moves[3]).toEqual({ x: 90, y: 0, penDown: false })
  })

  it('multiple strokes produce one pen-up travel between each', () => {
    const moves = strokesToMoves([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { points: [{ x: 50, y: 0 }, { x: 60, y: 0 }] },
    ])
    const lifts = moves.filter((m, i) => i > 0 && !moves[i - 1].penDown && m.penDown).length
    expect(lifts).toBe(2)
  })

  it('skips strokes with skip=true', () => {
    const moves = strokesToMoves([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { points: [{ x: 50, y: 0 }, { x: 60, y: 0 }], skip: true },
    ])
    // Only one pen-down stroke remains
    const penDownPoints = moves.filter(m => m.penDown)
    expect(penDownPoints.length).toBe(1)
  })

  it('skips strokes with fewer than 2 points', () => {
    const moves = strokesToMoves([
      { points: [{ x: 10, y: 10 }] },
      { points: [] },
      { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
    ])
    expect(moves.filter(m => m.penDown).length).toBe(1)
  })

  it('layer filter keeps only matching strokes', () => {
    const moves = strokesToMoves([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], layer: 1 },
      { points: [{ x: 20, y: 0 }, { x: 30, y: 0 }], layer: 2 },
    ], { layer: 2 })
    expect(moves.filter(m => m.penDown)[0]).toEqual({ x: 30, y: 0, penDown: true })
  })

  it('ends pen-up', () => {
    const moves = strokesToMoves([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
    ])
    expect(moves[moves.length - 1].penDown).toBe(false)
  })
})

describe('movesToStrokes', () => {
  it('round-trips strokesToMoves output', () => {
    const original: Stroke[] = [
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      { points: [{ x: 50, y: 50 }, { x: 60, y: 60 }] },
    ]
    const moves = strokesToMoves(original)
    const back = movesToStrokes(moves)
    expect(back.length).toBe(original.length)
    expect(back[0].points.length).toBe(original[0].points.length)
    expect(back[0].points[0]).toEqual(original[0].points[0])
  })
})

describe('strokeStats', () => {
  it('counts strokes, points, distance, and bbox', () => {
    const stats = strokeStats([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      { points: [{ x: 50, y: 50 }, { x: 60, y: 50 }] },
    ])
    expect(stats.strokeCount).toBe(2)
    expect(stats.pointCount).toBe(5)
    expect(stats.pendownMm).toBeCloseTo(10 + 10 + 10, 3)   // 2 segments × 10mm + 10mm
    expect(stats.bbox).toEqual({ minX: 0, minY: 0, maxX: 60, maxY: 50 })
  })

  it('ignores skipped strokes', () => {
    const stats = strokeStats([
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { points: [{ x: 100, y: 100 }, { x: 110, y: 100 }], skip: true },
    ])
    expect(stats.strokeCount).toBe(1)
    expect(stats.bbox).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 0 })
  })

  it('empty list → null bbox', () => {
    expect(strokeStats([]).bbox).toBeNull()
  })
})
