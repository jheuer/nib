import { describe, it, expect } from 'bun:test'
import { parseDimMm } from '../src/core/svg-units.ts'

describe('parseDimMm', () => {
  it('mm passes through unchanged', () => {
    expect(parseDimMm('210mm')).toBe(210)
    expect(parseDimMm('0.5mm')).toBe(0.5)
  })
  it('cm → mm', () => {
    expect(parseDimMm('5cm')).toBe(50)
  })
  it('in → mm', () => {
    expect(parseDimMm('8.5in')).toBeCloseTo(215.9, 3)
  })
  it('px → mm at 96 dpi', () => {
    expect(parseDimMm('96px')).toBeCloseTo(25.4, 6)
  })
  it('pt → mm at 72 dpi', () => {
    // 72pt = 1 inch = 25.4 mm
    expect(parseDimMm('72pt')).toBeCloseTo(25.4, 6)
  })
  it('pc → mm (1pc = 12pt)', () => {
    // 6pc = 72pt = 1 inch
    expect(parseDimMm('6pc')).toBeCloseTo(25.4, 6)
  })
  it('unitless treated as px', () => {
    expect(parseDimMm('96')).toBeCloseTo(25.4, 6)
  })
  it('accepts negative and decimal values', () => {
    expect(parseDimMm('-73.3')).toBeCloseTo(-73.3 * 25.4 / 96, 6)
  })
  it('trims whitespace', () => {
    expect(parseDimMm('  5mm  ')).toBe(5)
  })
  it('returns null for unparseable input', () => {
    expect(parseDimMm('auto')).toBeNull()
    expect(parseDimMm('5em')).toBeNull()
    expect(parseDimMm('')).toBeNull()
    expect(parseDimMm(undefined)).toBeNull()
  })
})
