import { describe, it, expect } from 'bun:test'
import { resolvePaper, parseOffset } from '../src/core/paper.ts'

describe('resolvePaper', () => {
  it('returns null when no size is given', () => {
    expect(resolvePaper({})).toBeNull()
  })

  it('parses a named size as portrait by default', () => {
    const p = resolvePaper({ size: 'A4' })!
    expect(p.widthMm).toBe(210)
    expect(p.heightMm).toBe(297)
  })

  it('orientation=landscape flips a portrait name', () => {
    const p = resolvePaper({ size: 'A4', orientation: 'landscape' })!
    expect(p.widthMm).toBe(297)
    expect(p.heightMm).toBe(210)
  })

  it('orientation=portrait keeps already-portrait sizes', () => {
    const p = resolvePaper({ size: 'A4', orientation: 'portrait' })!
    expect(p.widthMm).toBe(210)
    expect(p.heightMm).toBe(297)
  })

  it('orientation=portrait flips an explicit landscape size', () => {
    const p = resolvePaper({ size: '297x210', orientation: 'portrait' })!
    expect(p.widthMm).toBe(210)
    expect(p.heightMm).toBe(297)
  })

  it('parses explicit "297x210" without swap', () => {
    const p = resolvePaper({ size: '297x210' })!
    expect(p.widthMm).toBe(297)
    expect(p.heightMm).toBe(210)
  })

  it('default offset is (0,0)', () => {
    const p = resolvePaper({ size: 'A4' })!
    expect(p.offsetXMm).toBe(0)
    expect(p.offsetYMm).toBe(0)
  })

  it('offset "10,15" parses to mm', () => {
    const p = resolvePaper({ size: 'A4', offset: '10,15' })!
    expect(p.offsetXMm).toBe(10)
    expect(p.offsetYMm).toBe(15)
  })

  it('default color is a soft cream', () => {
    const p = resolvePaper({ size: 'A4' })!
    expect(p.color).toBe('#fdfcf7')
  })

  it('custom color passes through', () => {
    const p = resolvePaper({ size: 'A4', color: '#000' })!
    expect(p.color).toBe('#000')
  })

  it('unknown size returns null', () => {
    expect(resolvePaper({ size: 'notasize' })).toBeNull()
  })
})

describe('parseOffset', () => {
  it('accepts "X,Y"', () => {
    expect(parseOffset('10,20')).toEqual({ x: 10, y: 20 })
  })
  it('accepts "XxY" too', () => {
    expect(parseOffset('10x20')).toEqual({ x: 10, y: 20 })
  })
  it('accepts negative values', () => {
    expect(parseOffset('-5,3')).toEqual({ x: -5, y: 3 })
  })
  it('rejects malformed input', () => {
    expect(parseOffset('junk')).toBeNull()
  })
})
