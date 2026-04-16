import { describe, it, expect } from 'bun:test'
import {
  lmRateReg,
  lmAccelReg,
  firmwareAtLeast,
  LM_TICK_HZ,
} from '../src/backends/ebb-protocol.ts'

describe('lmRateReg', () => {
  it('zero rate → zero register', () => {
    expect(lmRateReg(0)).toBe(0)
  })

  it('round-trips within one LSB', () => {
    // rate_reg = steps_per_sec × 2^31 / LM_TICK_HZ
    // decode:   steps_per_sec = rate_reg × LM_TICK_HZ / 2^31
    for (const f of [1, 100, 1000, 5000, 20000]) {
      const r = lmRateReg(f)
      const decoded = r * LM_TICK_HZ / (2 ** 31)
      expect(Math.abs(decoded - f)).toBeLessThan(0.001)
    }
  })

  it('matches the published EBB encoding for 1 step/sec', () => {
    // rate_reg(1) = 2^31 / 25000 = 85899.3456 → round to 85899
    expect(lmRateReg(1)).toBe(85899)
  })

  it('clamps at firmware ceiling (25000 steps/s)', () => {
    // At exactly 25000 steps/s rate_reg = 2^31, which overflows INT32.
    // Clamp to 2^31 - 1. (We should never plan motion this fast.)
    expect(lmRateReg(25000)).toBe(0x7fffffff)
    expect(lmRateReg(100000)).toBe(0x7fffffff)
  })

  it('preserves sign (negative rates ride the same scale)', () => {
    expect(lmRateReg(-1000)).toBe(-lmRateReg(1000))
  })
})

describe('lmAccelReg', () => {
  it('zero accel → zero register', () => {
    expect(lmAccelReg(0)).toBe(0)
  })

  it('decode matches input for realistic accels', () => {
    // accel_reg = steps_per_sec² × 2^31 / 25000² ≈ steps_per_sec² × 3.435
    // At 2000 mm/s² × 80 steps/mm = 160000 steps/s² → reg ≈ 549756
    const reg = lmAccelReg(160000)
    const decoded = reg * LM_TICK_HZ * LM_TICK_HZ / (2 ** 31)
    expect(Math.abs(decoded - 160000) / 160000).toBeLessThan(0.001)
  })

  it('preserves sign (decel)', () => {
    expect(lmAccelReg(-160000)).toBe(-lmAccelReg(160000))
  })
})

describe('firmwareAtLeast', () => {
  it('compares lexicographically by major, minor, patch', () => {
    expect(firmwareAtLeast([2, 7, 0], [2, 7, 0])).toBe(true)
    expect(firmwareAtLeast([2, 8, 1], [2, 7, 0])).toBe(true)
    expect(firmwareAtLeast([3, 0, 0], [2, 9, 9])).toBe(true)
    expect(firmwareAtLeast([2, 6, 9], [2, 7, 0])).toBe(false)
    expect(firmwareAtLeast([1, 9, 9], [2, 0, 0])).toBe(false)
  })
})
