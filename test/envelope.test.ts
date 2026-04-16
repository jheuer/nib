import { describe, it, expect } from 'bun:test'
import {
  resolveEnvelope, parseEnvelope, isInEnvelope, findFirstOutOfBounds,
} from '../src/core/envelope.ts'

describe('resolveEnvelope', () => {
  it('resolves known models case-insensitively', () => {
    expect(resolveEnvelope('V3')?.widthMm).toBe(280)
    expect(resolveEnvelope('v3a3')?.widthMm).toBe(430)
    expect(resolveEnvelope('mini')?.widthMm).toBe(152)
  })

  it('aliases A3 → V3A3 and A4 → V3', () => {
    expect(resolveEnvelope('A3')?.widthMm).toBe(430)
    expect(resolveEnvelope('a4')?.widthMm).toBe(280)
  })

  it('returns null for unknown models', () => {
    expect(resolveEnvelope('galaxy-brain-edition')).toBeNull()
    expect(resolveEnvelope(undefined)).toBeNull()
    expect(resolveEnvelope('')).toBeNull()
  })
})

describe('parseEnvelope', () => {
  it('parses WxH form', () => {
    expect(parseEnvelope('280x218')).toEqual({ widthMm: 280, heightMm: 218 })
    expect(parseEnvelope('430 x 297')).toEqual({ widthMm: 430, heightMm: 297 })
  })
  it('parses comma form', () => {
    expect(parseEnvelope('280,218')).toEqual({ widthMm: 280, heightMm: 218 })
  })
  it('accepts trailing mm', () => {
    expect(parseEnvelope('280x218mm')).toEqual({ widthMm: 280, heightMm: 218 })
  })
  it('returns null on gibberish', () => {
    expect(parseEnvelope('eight by ten')).toBeNull()
    expect(parseEnvelope('280')).toBeNull()
  })
})

describe('isInEnvelope', () => {
  const env = { widthMm: 100, heightMm: 50 }
  it('accepts origin', () => {
    expect(isInEnvelope(0, 0, env)).toBe(true)
  })
  it('accepts the far corner', () => {
    expect(isInEnvelope(100, 50, env)).toBe(true)
  })
  it('rejects outside on any axis', () => {
    expect(isInEnvelope(101, 10, env)).toBe(false)
    expect(isInEnvelope(10, 51, env)).toBe(false)
    expect(isInEnvelope(-1, 10, env)).toBe(false)
    expect(isInEnvelope(10, -1, env)).toBe(false)
  })
  it('allows small float drift at the boundary', () => {
    expect(isInEnvelope(100.05, 50.05, env)).toBe(true)
    expect(isInEnvelope(-0.05, -0.05, env)).toBe(true)
  })
  it('no envelope → no bounds (returns true)', () => {
    expect(isInEnvelope(1_000_000, -999, null)).toBe(true)
  })
})

describe('findFirstOutOfBounds', () => {
  const env = { widthMm: 100, heightMm: 50 }
  it('returns null when every point is in bounds', () => {
    expect(findFirstOutOfBounds([{ x: 0, y: 0 }, { x: 50, y: 25 }], env)).toBeNull()
  })
  it('returns the first offender', () => {
    const out = findFirstOutOfBounds(
      [{ x: 0, y: 0 }, { x: 50, y: 25 }, { x: 200, y: 10 }, { x: 201, y: 10 }],
      env,
    )
    expect(out?.index).toBe(2)
    expect(out?.point).toEqual({ x: 200, y: 10 })
  })
  it('null envelope → never reports', () => {
    expect(findFirstOutOfBounds([{ x: 9999, y: -9999 }], null)).toBeNull()
  })
})
