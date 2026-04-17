import { describe, it, expect } from 'bun:test'
import { svgToMoves } from '../src/backends/svg-to-moves.ts'

const penDown = (moves: ReturnType<typeof svgToMoves>) => moves.filter(m => m.penDown)

describe('viewBox origin handling', () => {
  it('non-zero viewBox origin shifts content so (vbX, vbY) → (0, 0) mm', () => {
    // viewBox x = -100, width = 200 → user unit 0 is 100 units right of the
    // viewport origin. With page width 100mm and viewBox width 200, scale is
    // 0.5 mm/unit. So user (0, 0) should land at (50, 0) mm.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"
      viewBox="-100 0 200 100" width="100mm" height="50mm">
      <line x1="0" y1="0" x2="0" y2="50" stroke="black"/>
    </svg>`
    const moves = svgToMoves(svg)
    const pts = penDown(moves)
    // Should plot from (50, 0) down to (50, 25)
    expect(pts[0].x).toBeCloseTo(50, 2)
    expect(pts[0].y).toBeCloseTo(25, 2)
  })

  it('content anchored to viewBox top-left lands at (0, 0) mm', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"
      viewBox="-73.3 -73.3 879.6 1146.6" width="8.5in" height="11in">
      <line x1="-73.3" y1="-73.3" x2="879.6" y2="1146.6" stroke="black"/>
    </svg>`
    const moves = svgToMoves(svg)
    // The move preceding the first pen-down should be at (0, 0) — the line
    // start. (Our pen-up emitter dedupes consecutive identical points, so
    // the initial pen-up at (0, 0) IS the line start.)
    const firstDownIdx = moves.findIndex(m => m.penDown)
    expect(firstDownIdx).toBeGreaterThan(0)
    const before = moves[firstDownIdx - 1]
    expect(before.x).toBeCloseTo(0, 1)
    expect(before.y).toBeCloseTo(0, 1)
  })

  it('no viewBox: content plots in raw user units (96 dpi default)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <line x1="96" y1="0" x2="96" y2="96" stroke="black"/>
    </svg>`
    const moves = svgToMoves(svg)
    const pts = penDown(moves)
    // 96 user units at 96 dpi → 25.4 mm
    expect(pts[0].x).toBeCloseTo(25.4, 2)
  })
})

describe('fill-only skip rule', () => {
  it('skips an element with explicit fill and no stroke', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <rect x="0" y="0" width="100" height="100" fill="black"/>
      <line x1="10" y1="10" x2="50" y2="50" stroke="black"/>
    </svg>`
    const moves = svgToMoves(svg)
    const pts = penDown(moves)
    // Only the line plots — rect with fill+no-stroke is decorative
    expect(pts.length).toBe(1)
    expect(pts[0].x).toBeCloseTo(50, 2)
  })

  it('skips an element with style="fill:…" and no stroke', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <rect x="0" y="0" width="100" height="100" style="fill:red"/>
      <line x1="10" y1="10" x2="50" y2="50" stroke="black"/>
    </svg>`
    expect(penDown(svgToMoves(svg)).length).toBe(1)
  })

  it('plots an element with both fill and stroke', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <rect x="10" y="10" width="50" height="50" fill="red" stroke="black"/>
    </svg>`
    // rect outline = 4 pen-down segments
    expect(penDown(svgToMoves(svg)).length).toBeGreaterThan(0)
  })

  it('plots an element with fill="none"', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="10" y1="10" x2="50" y2="50" fill="none" stroke="black"/>
    </svg>`
    expect(penDown(svgToMoves(svg)).length).toBe(1)
  })

  it('plots when neither fill nor stroke is declared (generative default)', () => {
    // Generative scripts often emit <polyline points="..."/> with no style
    // attrs. SVG spec renders these filled-black, but authors clearly want
    // lines — keep plotting.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="10" y1="10" x2="50" y2="50"/>
    </svg>`
    expect(penDown(svgToMoves(svg)).length).toBe(1)
  })

  it('inherits fill from parent group — child without its own stroke is skipped', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <g fill="black">
        <rect x="0" y="0" width="10" height="10"/>
      </g>
      <line x1="20" y1="20" x2="40" y2="40" stroke="black"/>
    </svg>`
    const pts = penDown(svgToMoves(svg))
    // Only the line plots; rect in fill-only group is skipped
    expect(pts.length).toBe(1)
    expect(pts[0].x).toBeCloseTo(40, 2)
  })

  it('child stroke overrides inherited fill-only', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <g fill="black">
        <rect x="0" y="0" width="10" height="10" stroke="red"/>
      </g>
    </svg>`
    // rect has stroke now → plot
    expect(penDown(svgToMoves(svg)).length).toBeGreaterThan(0)
  })
})
