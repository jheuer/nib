import { describe, it, expect } from 'bun:test'
import { svgToMoves } from '../src/backends/svg-to-moves.ts'
import type { PlannerMove } from '../src/backends/svg-to-moves.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function penDownMoves(moves: PlannerMove[]): PlannerMove[] {
  return moves.filter(m => m.penDown)
}

function penUpMoves(moves: PlannerMove[]): PlannerMove[] {
  return moves.filter(m => !m.penDown)
}

function penLifts(moves: PlannerMove[]): number {
  let count = 0
  for (let i = 1; i < moves.length; i++) {
    if (!moves[i - 1].penDown && moves[i].penDown) count++
  }
  return count
}

// Bounding box of pen-down moves
function bbox(moves: PlannerMove[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const down = penDownMoves(moves)
  return {
    minX: Math.min(...down.map(m => m.x)),
    minY: Math.min(...down.map(m => m.y)),
    maxX: Math.max(...down.map(m => m.x)),
    maxY: Math.max(...down.map(m => m.y)),
  }
}

// ─── Line ─────────────────────────────────────────────────────────────────────

describe('line element', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
    <line x1="10" y1="10" x2="90" y2="90"/>
  </svg>`

  it('produces a pen-up to start and one pen-down move', () => {
    const moves = svgToMoves(svg)
    expect(penDownMoves(moves).length).toBe(1)
    expect(penLifts(moves)).toBe(1)
  })

  it('endpoints are in mm (scale = 100mm / 100 = 1.0)', () => {
    const moves = svgToMoves(svg)
    const down = penDownMoves(moves)
    expect(down[0].x).toBeCloseTo(90, 1)
    expect(down[0].y).toBeCloseTo(90, 1)
  })
})

// ─── Rect ─────────────────────────────────────────────────────────────────────

describe('rect element', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
    <rect x="10" y="10" width="80" height="80"/>
  </svg>`

  it('produces exactly 4 pen-down moves (4 edges)', () => {
    const moves = svgToMoves(svg)
    expect(penDownMoves(moves).length).toBe(4)
  })

  it('produces exactly 1 pen lift', () => {
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('bounding box matches rect dimensions in mm', () => {
    const bb = bbox(svgToMoves(svg))
    expect(bb.minX).toBeCloseTo(10, 1)
    expect(bb.minY).toBeCloseTo(10, 1)
    expect(bb.maxX).toBeCloseTo(90, 1)
    expect(bb.maxY).toBeCloseTo(90, 1)
  })
})

// ─── Path ─────────────────────────────────────────────────────────────────────

describe('path element', () => {
  it('handles M L Z (triangle)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <path d="M 10,10 L 90,10 L 50,90 Z"/>
    </svg>`
    const moves = svgToMoves(svg)
    // M(pen-up) + L + L + Z(close) = 3 pen-down moves
    expect(penDownMoves(moves).length).toBe(3)
    expect(penLifts(moves)).toBe(1)
  })

  it('handles multiple subpaths (two separate strokes)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <path d="M 10,10 L 40,10 M 60,10 L 90,10"/>
    </svg>`
    const moves = svgToMoves(svg)
    expect(penLifts(moves)).toBe(2)
  })

  it('flattens cubic beziers into multiple pen-down moves', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <path d="M 10,50 C 10,10 90,10 90,50"/>
    </svg>`
    const moves = svgToMoves(svg)
    // A bezier must produce more than 1 pen-down point
    expect(penDownMoves(moves).length).toBeGreaterThan(1)
  })

  it('handles H and V shorthand (normalised before processing)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <path d="M 10,10 H 90 V 90 H 10 Z"/>
    </svg>`
    const moves = svgToMoves(svg)
    expect(penDownMoves(moves).length).toBe(4) // 4 sides
  })
})

// ─── Circle ──────────────────────────────────────────────────────────────────

describe('circle element', () => {
  it('produces many pen-down moves (approximated by beziers)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <circle cx="50" cy="50" r="40"/>
    </svg>`
    const moves = svgToMoves(svg)
    expect(penDownMoves(moves).length).toBeGreaterThan(10)
    expect(penLifts(moves)).toBe(1)
  })

  it('bounding box is approximately 2r × 2r', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <circle cx="50" cy="50" r="40"/>
    </svg>`
    const bb = bbox(svgToMoves(svg))
    expect(bb.maxX - bb.minX).toBeCloseTo(80, 0)
    expect(bb.maxY - bb.minY).toBeCloseTo(80, 0)
  })
})

// ─── Polyline / Polygon ───────────────────────────────────────────────────────

describe('polyline element', () => {
  it('traces all points with one pen lift', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <polyline points="10,10 50,50 90,10 50,90"/>
    </svg>`
    const moves = svgToMoves(svg)
    expect(penDownMoves(moves).length).toBe(3)
    expect(penLifts(moves)).toBe(1)
  })
})

describe('polygon element', () => {
  it('closes the shape (last move returns to start)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <polygon points="10,10 90,10 50,90"/>
    </svg>`
    const moves = svgToMoves(svg)
    const down = penDownMoves(moves)
    // Triangle: 2 explicit + 1 closing = 3 pen-down moves
    expect(down.length).toBe(3)
    // Last pen-down move returns to first corner
    expect(down[down.length - 1].x).toBeCloseTo(10, 1)
    expect(down[down.length - 1].y).toBeCloseTo(10, 1)
  })
})

// ─── Coordinate scaling ───────────────────────────────────────────────────────

describe('coordinate scaling', () => {
  it('scales viewBox units to mm via width/height attributes', () => {
    // viewBox is 0 0 200 200, width=100mm → scale = 0.5
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100mm" height="100mm">
      <line x1="0" y1="0" x2="200" y2="0"/>
    </svg>`
    const moves = svgToMoves(svg)
    const down = penDownMoves(moves)
    // 200 viewBox units → 100mm
    expect(down[0].x).toBeCloseTo(100, 1)
    expect(down[0].y).toBeCloseTo(0, 1)
  })
})

// ─── Transform handling ───────────────────────────────────────────────────────

describe('transform handling', () => {
  it('applies translate transform', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <g transform="translate(20,30)">
        <line x1="0" y1="0" x2="10" y2="0"/>
      </g>
    </svg>`
    const moves = svgToMoves(svg)
    const down = penDownMoves(moves)
    // Line endpoint: (10,0) + translate(20,30) = (30,30)
    expect(down[0].x).toBeCloseTo(30, 1)
    expect(down[0].y).toBeCloseTo(30, 1)
  })

  it('applies scale transform', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <g transform="scale(2)">
        <line x1="0" y1="0" x2="10" y2="0"/>
      </g>
    </svg>`
    const moves = svgToMoves(svg)
    const down = penDownMoves(moves)
    // 10 × scale(2) = 20 viewBox units = 20mm (scale factor 1.0)
    expect(down[0].x).toBeCloseTo(20, 1)
  })

  it('accumulates nested transforms', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <g transform="translate(10,0)">
        <g transform="translate(10,0)">
          <line x1="0" y1="0" x2="0" y2="10"/>
        </g>
      </g>
    </svg>`
    const up = penUpMoves(svgToMoves(svg)).slice(1) // skip initial (0,0)
    // Pen-up to start of line: x = 0+10+10 = 20
    expect(up[0].x).toBeCloseTo(20, 1)
  })
})

// ─── Layer filtering ──────────────────────────────────────────────────────────

describe('layer filtering', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
    viewBox="0 0 200 200" width="200mm" height="200mm">
    <g inkscape:groupmode="layer" id="layer1">
      <line x1="0" y1="0" x2="50" y2="0"/>
    </g>
    <g inkscape:groupmode="layer" id="layer2">
      <line x1="100" y1="0" x2="150" y2="0"/>
    </g>
  </svg>`

  it('returns moves only from the specified layer', () => {
    const layer1 = svgToMoves(svg, { layer: 1 })
    const layer2 = svgToMoves(svg, { layer: 2 })
    const bb1 = bbox(layer1)
    const bb2 = bbox(layer2)
    // Layer1 line ends at x=50; layer2 starts at x=100
    expect(bb1.maxX).toBeCloseTo(50, 0)
    expect(bb2.minX).toBeCloseTo(150, 0)
  })

  it('returns all moves when no layer filter is set', () => {
    const all = svgToMoves(svg)
    expect(penLifts(all)).toBe(2) // two separate lines = two pen lifts
  })
})

// ─── Fixture: simple-rect ─────────────────────────────────────────────────────

describe('fixture: simple-rect', () => {
  it('produces 4 pen-down moves for a 80×80 rect', async () => {
    const svg = await Bun.file(new URL('./fixtures/simple-rect/input.svg', import.meta.url)).text()
    const moves = svgToMoves(svg)
    expect(penDownMoves(moves).length).toBe(4)
    expect(penLifts(moves)).toBe(1)
    // 100mm×100mm viewBox, rect from (10,10) to (90,90)
    const bb = bbox(moves)
    expect(bb.minX).toBeCloseTo(10, 0)
    expect(bb.minY).toBeCloseTo(10, 0)
    expect(bb.maxX).toBeCloseTo(90, 0)
    expect(bb.maxY).toBeCloseTo(90, 0)
  })
})

// ─── Fixture: multi-layer ─────────────────────────────────────────────────────

describe('fixture: multi-layer', () => {
  it('detects 2 layers and each has content', async () => {
    const svg = await Bun.file(new URL('./fixtures/multi-layer/input.svg', import.meta.url)).text()
    const layer1 = svgToMoves(svg, { layer: 1 })
    const layer2 = svgToMoves(svg, { layer: 2 })
    expect(penLifts(layer1)).toBe(1)
    expect(penLifts(layer2)).toBe(1)
  })

  it('layer 1 rect is larger than layer 2 rect', async () => {
    const svg = await Bun.file(new URL('./fixtures/multi-layer/input.svg', import.meta.url)).text()
    const bb1 = bbox(svgToMoves(svg, { layer: 1 }))
    const bb2 = bbox(svgToMoves(svg, { layer: 2 }))
    const size1 = (bb1.maxX - bb1.minX) * (bb1.maxY - bb1.minY)
    const size2 = (bb2.maxX - bb2.minX) * (bb2.maxY - bb2.minY)
    expect(size1).toBeGreaterThan(size2)
  })
})

// ─── Visibility + style inheritance ───────────────────────────────────────────

describe('visibility', () => {
  it('skips elements with display="none"', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="0" y1="0" x2="50" y2="50"/>
      <line x1="0" y1="0" x2="90" y2="90" display="none"/>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('skips elements with visibility="hidden"', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="0" y1="0" x2="50" y2="50"/>
      <line x1="0" y1="0" x2="90" y2="90" visibility="hidden"/>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('inherits display:none from ancestor group', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="0" y1="0" x2="50" y2="50"/>
      <g display="none">
        <line x1="0" y1="0" x2="90" y2="90"/>
        <line x1="10" y1="10" x2="20" y2="20"/>
      </g>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('inherits visibility:hidden via style attribute on ancestor', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="0" y1="0" x2="50" y2="50"/>
      <g style="visibility:hidden">
        <line x1="0" y1="0" x2="90" y2="90"/>
      </g>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('skips elements with stroke="none"', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="0" y1="0" x2="50" y2="50"/>
      <line x1="0" y1="0" x2="90" y2="90" stroke="none"/>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('skips elements with style="stroke:none"', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <line x1="0" y1="0" x2="50" y2="50"/>
      <line x1="0" y1="0" x2="90" y2="90" style="stroke:none"/>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('child stroke="black" overrides ancestor stroke="none"', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <g stroke="none">
        <line x1="0" y1="0" x2="50" y2="50" stroke="black"/>
      </g>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(1)
  })

  it('ancestor display="none" hides the whole subtree even if a child says inline', () => {
    // Per SVG spec: display:none on an ancestor is absolute — descendants
    // are not rendered regardless of their own display setting. We implement
    // this by returning early from the subtree walk.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <g display="none">
        <line x1="0" y1="0" x2="50" y2="50" display="inline"/>
      </g>
    </svg>`
    expect(penLifts(svgToMoves(svg))).toBe(0)
  })
})
