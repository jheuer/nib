import { describe, it, expect } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { previewStatsFromSvg, previewStatsFromMoves } from '../src/backends/ebb-preview.ts'
import { svgToMoves } from '../src/backends/svg-to-moves.ts'
import type { ResolvedProfile } from '../src/core/job.ts'

const FIXTURES = join(import.meta.dir, 'fixtures')

const PROFILE: ResolvedProfile = {
  name: 'test',
  speedPendown: 25,
  speedPenup: 75,
  penPosDown: 40,
  penPosUp: 60,
  accel: 75,
}

// ─── previewStatsFromMoves ────────────────────────────────────────────────────

describe('previewStatsFromMoves', () => {
  it('returns zero stats for empty move list', () => {
    const stats = previewStatsFromMoves([], PROFILE)
    expect(stats.pendownM).toBe(0)
    expect(stats.travelM).toBe(0)
    expect(stats.penLifts).toBe(0)
    expect(stats.estimatedS).toBeNull()
  })

  it('counts one pen lift for a single stroke', () => {
    const moves = [
      { x: 0,  y: 0,  penDown: false },
      { x: 10, y: 0,  penDown: false },
      { x: 10, y: 0,  penDown: true  },
      { x: 50, y: 0,  penDown: true  },
    ]
    const stats = previewStatsFromMoves(moves, PROFILE)
    expect(stats.penLifts).toBe(1)
  })

  it('counts two pen lifts for two separate strokes', () => {
    const moves = [
      { x: 0,  y: 0,  penDown: false },
      { x: 10, y: 0,  penDown: true  },
      { x: 50, y: 0,  penDown: true  },
      { x: 50, y: 0,  penDown: false },
      { x: 60, y: 0,  penDown: true  },
      { x: 90, y: 0,  penDown: true  },
    ]
    const stats = previewStatsFromMoves(moves, PROFILE)
    expect(stats.penLifts).toBe(2)
  })

  it('computes pen-down distance correctly', () => {
    // Straight 100mm horizontal stroke
    const moves = [
      { x: 0,   y: 0, penDown: false },
      { x: 0,   y: 0, penDown: true  },
      { x: 100, y: 0, penDown: true  },
    ]
    const stats = previewStatsFromMoves(moves, PROFILE)
    expect(stats.pendownM).toBeCloseTo(0.1, 4)  // 100mm = 0.1m
  })

  it('computes travel distance correctly', () => {
    // 50mm travel (pen up), 100mm pen-down
    const moves = [
      { x: 0,   y: 0, penDown: false },
      { x: 50,  y: 0, penDown: false },
      { x: 50,  y: 0, penDown: true  },
      { x: 150, y: 0, penDown: true  },
    ]
    const stats = previewStatsFromMoves(moves, PROFILE)
    expect(stats.travelM).toBeCloseTo(0.05, 4)   // 50mm = 0.05m
    expect(stats.pendownM).toBeCloseTo(0.1,  4)  // 100mm = 0.1m
  })

  it('computes bounding box of pen-down moves only', () => {
    const moves = [
      { x: 0,  y: 0,  penDown: false },
      { x: 100,y: 100,penDown: false },  // travel, not in bbox
      { x: 100,y: 100,penDown: true  },
      { x: 200,y: 150,penDown: true  },
    ]
    const stats = previewStatsFromMoves(moves, PROFILE)
    expect(stats.boundingBoxMm?.width).toBeCloseTo(100, 0)
    expect(stats.boundingBoxMm?.height).toBeCloseTo(50, 0)
  })

  it('returns positive estimatedS for non-zero distances', () => {
    const moves = [
      { x: 0,   y: 0, penDown: false },
      { x: 0,   y: 0, penDown: true  },
      { x: 100, y: 0, penDown: true  },
    ]
    const stats = previewStatsFromMoves(moves, PROFILE)
    expect(stats.estimatedS).not.toBeNull()
    expect(stats.estimatedS!).toBeGreaterThan(0)
  })
})

// ─── previewStatsFromSvg ──────────────────────────────────────────────────────

describe('previewStatsFromSvg', () => {
  it('returns non-null stats for simple-rect fixture', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = previewStatsFromSvg(svg, PROFILE)
    expect(stats.pendownM).toBeGreaterThan(0)
    expect(stats.penLifts).toBe(1)
    expect(stats.estimatedS).toBeGreaterThan(0)
  })

  it('reports 1 pen lift for a single rect', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = previewStatsFromSvg(svg, PROFILE)
    expect(stats.penLifts).toBe(1)
  })

  it('bounding box roughly matches rect (80×80mm inside 100×100mm canvas)', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = previewStatsFromSvg(svg, PROFILE)
    expect(stats.boundingBoxMm?.width).toBeCloseTo(80, 0)
    expect(stats.boundingBoxMm?.height).toBeCloseTo(80, 0)
  })

  it('fits A4 for a 100×100mm canvas', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = previewStatsFromSvg(svg, PROFILE)
    expect(stats.fitsA4).toBe(true)
    expect(stats.fitsA3).toBe(true)
  })

  it('detects 2 pen lifts for multi-layer (both layers visible)', async () => {
    const svg = await readFile(join(FIXTURES, 'multi-layer', 'input.svg'), 'utf-8')
    const stats = previewStatsFromSvg(svg, PROFILE)
    expect(stats.penLifts).toBe(2)
  })

  it('pen-down distance for a rect perimeter is 4 × 80 = 320mm = 0.32m', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = previewStatsFromSvg(svg, PROFILE)
    expect(stats.pendownM).toBeCloseTo(0.32, 2)
  })
})

// ─── consistency between previewStatsFromSvg and previewStatsFromMoves ────────

describe('stats consistency', () => {
  it('previewStatsFromMoves matches previewStatsFromSvg when given same moves', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const moves = svgToMoves(svg)
    const fromMoves = previewStatsFromMoves(moves, PROFILE)
    const fromSvg   = previewStatsFromSvg(svg, PROFILE)
    // They should be identical (same tolerance used internally)
    expect(fromMoves.pendownM).toBeCloseTo(fromSvg.pendownM ?? 0, 4)
    expect(fromMoves.penLifts).toBe(fromSvg.penLifts)
  })
})
