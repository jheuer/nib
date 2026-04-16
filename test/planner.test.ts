import { describe, it, expect } from 'bun:test'
import { planTrapezoid, planMove } from '../src/core/planner.ts'
import { STEPS_PER_MM } from '../src/backends/ebb-protocol.ts'

describe('planTrapezoid', () => {
  it('long move reaches vMax with a cruise phase', () => {
    // dist = 100mm, rest-to-rest, vMax=50, accel=2000
    // accelDist = 50²/(2×2000) = 0.625mm. cruise = 100 - 1.25 = 98.75mm
    const p = planTrapezoid(100, 0, 0, 50, 2000)
    expect(p.triangular).toBe(false)
    expect(p.vPeak).toBe(50)
    expect(p.accelDist).toBeCloseTo(0.625, 3)
    expect(p.decelDist).toBeCloseTo(0.625, 3)
    expect(p.cruiseDist).toBeCloseTo(98.75, 2)
  })

  it('short move → triangular profile with peak < vMax', () => {
    // dist = 0.5mm, rest-to-rest, vMax=50, accel=2000
    // accel+decel at 50 would need 1.25mm > 0.5mm → triangle
    const p = planTrapezoid(0.5, 0, 0, 50, 2000)
    expect(p.triangular).toBe(true)
    expect(p.cruiseDist).toBe(0)
    expect(p.vPeak).toBeLessThan(50)
    // vPeak = sqrt(accel × dist) = sqrt(2000 × 0.5) = sqrt(1000) ≈ 31.6
    expect(p.vPeak).toBeCloseTo(Math.sqrt(1000), 3)
  })

  it('respects non-zero entry/exit velocities', () => {
    // dist = 100mm, v0=30, v1=0, vMax=50, accel=2000
    const p = planTrapezoid(100, 30, 0, 50, 2000)
    // accelDist (30→50): (50² - 30²)/(2×2000) = 1600/4000 = 0.4
    // decelDist (50→0):  2500/4000 = 0.625
    expect(p.accelDist).toBeCloseTo(0.4, 3)
    expect(p.decelDist).toBeCloseTo(0.625, 3)
    expect(p.cruiseDist).toBeCloseTo(100 - 0.4 - 0.625, 2)
  })

  it('when vEntry == vMax, accel phase has zero length', () => {
    const p = planTrapezoid(50, 50, 0, 50, 2000)
    expect(p.accelDist).toBe(0)
    expect(p.decelDist).toBeGreaterThan(0)
    expect(p.cruiseDist).toBeGreaterThan(0)
  })
})

describe('planMove', () => {
  it('per-axis step totals match (dX±dY)·STEPS_PER_MM exactly', () => {
    const m = planMove(30, 10, 0, 0, { vMax: 40, accel: 2000 })
    const totalSteps1 = m.phases.reduce((s, p) => s + p.steps1, 0)
    const totalSteps2 = m.phases.reduce((s, p) => s + p.steps2, 0)
    expect(totalSteps1).toBe(Math.round((30 + 10) * STEPS_PER_MM))
    expect(totalSteps2).toBe(Math.round((30 - 10) * STEPS_PER_MM))
  })

  it('long move emits 3 phases (accel, cruise, decel)', () => {
    const m = planMove(100, 0, 0, 0, { vMax: 50, accel: 2000 })
    expect(m.phases.length).toBe(3)
    expect(m.phases[0].vEntry).toBe(0)
    expect(m.phases[0].vExit).toBe(50)
    expect(m.phases[1].vEntry).toBe(50)
    expect(m.phases[1].vExit).toBe(50)
    expect(m.phases[2].vEntry).toBe(50)
    expect(m.phases[2].vExit).toBe(0)
  })

  it('short move emits 2 phases (triangle: accel, decel)', () => {
    const m = planMove(0.5, 0, 0, 0, { vMax: 50, accel: 2000 })
    expect(m.phases.length).toBe(2)
    expect(m.phases[0].vExit).toBeGreaterThan(0)
    expect(m.phases[0].vExit).toBeLessThan(50)
    expect(m.phases[1].vExit).toBe(0)
  })

  it('zero-length move produces no phases', () => {
    const m = planMove(0, 0, 0, 0, { vMax: 40, accel: 2000 })
    expect(m.phases.length).toBe(0)
    expect(m.distMm).toBe(0)
  })

  it('durationS ~ 2·d / (vEntry + vExit) for rest-to-rest cruise', () => {
    // 100mm @ cruise 50 mm/s: cruise phase alone = 98.75/50 ≈ 1.975s
    // accel 50/2000 = 0.025s, decel 50/2000 = 0.025s → total ≈ 2.025s
    const m = planMove(100, 0, 0, 0, { vMax: 50, accel: 2000 })
    expect(m.durationS).toBeGreaterThan(2.0)
    expect(m.durationS).toBeLessThan(2.1)
  })

  it('pure-Y move has symmetric motor steps of opposite sign', () => {
    const m = planMove(0, 20, 0, 0, { vMax: 40, accel: 2000 })
    const total1 = m.phases.reduce((s, p) => s + p.steps1, 0)
    const total2 = m.phases.reduce((s, p) => s + p.steps2, 0)
    expect(total1).toBe(Math.round(20 * STEPS_PER_MM))
    expect(total2).toBe(Math.round(-20 * STEPS_PER_MM))
  })
})
