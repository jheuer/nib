import { describe, it, expect } from 'bun:test'
import { reorder } from '../src/core/reorder.ts'
import type { PlannerMove } from '../src/backends/svg-to-moves.ts'

// Build a move list from a sequence of strokes; each stroke is [(x,y), (x,y), ...]
function movesFromStrokes(strokes: Array<Array<[number, number]>>): PlannerMove[] {
  const out: PlannerMove[] = [{ x: 0, y: 0, penDown: false }]
  for (const s of strokes) {
    const [x0, y0] = s[0]
    out.push({ x: x0, y: y0, penDown: false })
    for (let i = 1; i < s.length; i++) {
      out.push({ x: s[i][0], y: s[i][1], penDown: true })
    }
  }
  const last = out[out.length - 1]
  if (last.penDown) out.push({ x: last.x, y: last.y, penDown: false })
  return out
}

// Total travel = sum of pen-up segment lengths
function travelOf(moves: PlannerMove[]): number {
  let t = 0
  for (let i = 1; i < moves.length; i++) {
    const cur = moves[i]
    if (cur.penDown) continue
    const prev = moves[i - 1]
    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    t += Math.sqrt(dx * dx + dy * dy)
  }
  return t
}

function lifts(moves: PlannerMove[]): number {
  let n = 0
  for (let i = 1; i < moves.length; i++) {
    if (!moves[i - 1].penDown && moves[i].penDown) n++
  }
  return n
}

describe('reorder', () => {
  it('level 0 returns input unchanged', () => {
    const moves = movesFromStrokes([[[10, 0], [20, 0]], [[0, 0], [5, 0]]])
    const { moves: out, stats } = reorder(moves, 0)
    expect(out).toEqual(moves)
    expect(stats.travelMmAfter).toBe(stats.travelMmBefore)
  })

  it('level 1 reduces travel with nearest-neighbor', () => {
    // Three strokes placed to make doc order wasteful:
    //   A: (0,0) → (1,0)
    //   B: (100, 0) → (101, 0)
    //   C: (2, 0) → (3, 0)
    // Doc order travels 0→100→2 ≈ 200. NN should go A → C → B, travel ≈ 100.
    const moves = movesFromStrokes([
      [[0, 0], [1, 0]],
      [[100, 0], [101, 0]],
      [[2, 0], [3, 0]],
    ])
    const before = travelOf(moves)
    const { moves: out, stats } = reorder(moves, 1)
    const after = travelOf(out)
    expect(after).toBeLessThan(before)
    expect(stats.travelMmAfter).toBeLessThan(stats.travelMmBefore)
    expect(lifts(out)).toBe(3)
  })

  it('level 2 uses stroke reversal when it saves travel', () => {
    // Two strokes; reversing the second makes travel shorter.
    //   A: (0,0) → (10,0)       ends at (10,0)
    //   B: (100,0) → (11,0)     head is far from A's end, tail is close
    // Level 1 (no reverse): 10 → 100 = 90 travel.
    // Level 2 (reverse B):  10 → 11  = 1 travel.
    const moves = movesFromStrokes([
      [[0, 0], [10, 0]],
      [[100, 0], [11, 0]],
    ])
    const l1 = reorder(moves, 1)
    const l2 = reorder(moves, 2)
    expect(l2.stats.travelMmAfter).toBeLessThan(l1.stats.travelMmAfter)
    expect(lifts(l2.moves)).toBe(2)
  })

  it('preserves pen-down stroke count', () => {
    const moves = movesFromStrokes([
      [[0, 0], [5, 5], [10, 0]],
      [[50, 50], [60, 60]],
      [[20, 20], [25, 25], [30, 20]],
    ])
    const penDownBefore = moves.filter(m => m.penDown).length
    const { moves: out } = reorder(moves, 2)
    const penDownAfter = out.filter(m => m.penDown).length
    expect(penDownAfter).toBe(penDownBefore)
  })

  it('output starts at origin and ends pen-up', () => {
    const moves = movesFromStrokes([[[50, 50], [60, 60]], [[10, 10], [20, 20]]])
    const { moves: out } = reorder(moves, 2)
    expect(out[0]).toEqual({ x: 0, y: 0, penDown: false })
    expect(out[out.length - 1].penDown).toBe(false)
  })

  it('handles zero or one stroke as pass-through', () => {
    const empty: PlannerMove[] = [{ x: 0, y: 0, penDown: false }]
    expect(reorder(empty, 2).moves).toEqual(empty)

    const oneStroke = movesFromStrokes([[[10, 10], [20, 20]]])
    const { moves: out, stats } = reorder(oneStroke, 2)
    expect(stats.penLiftsAfter).toBe(1)
    expect(out.filter(m => m.penDown).length).toBe(oneStroke.filter(m => m.penDown).length)
  })
})
