import { describe, it, expect } from 'bun:test'
import { resolveAutoRotate } from '../src/core/auto-rotate.ts'

const landscapeMachine = { envelopeWidthMm: 430, envelopeHeightMm: 297 }
const portraitMachine  = { envelopeWidthMm: 297, envelopeHeightMm: 430 }
const portraitSvg  = { svgWidthMm: 210, svgHeightMm: 297 }
const landscapeSvg = { svgWidthMm: 297, svgHeightMm: 210 }
const squareSvg    = { svgWidthMm: 200, svgHeightMm: 200 }

describe('resolveAutoRotate — explicit values', () => {
  it('numeric string returns that number, auto=false', () => {
    expect(resolveAutoRotate('90',  { ...portraitSvg, ...landscapeMachine })).toEqual({ degrees: 90,  auto: false })
    expect(resolveAutoRotate('180', { ...portraitSvg, ...landscapeMachine })).toEqual({ degrees: 180, auto: false })
  })

  it('"none" → 0, auto=false', () => {
    expect(resolveAutoRotate('none', { ...portraitSvg, ...landscapeMachine })).toEqual({ degrees: 0, auto: false })
  })

  it('"0" is explicit no-rotate', () => {
    expect(resolveAutoRotate('0', { ...portraitSvg, ...landscapeMachine })).toEqual({ degrees: 0, auto: false })
  })

  it('invalid string throws', () => {
    expect(() => resolveAutoRotate('junk', { ...portraitSvg, ...landscapeMachine })).toThrow()
  })
})

describe('resolveAutoRotate — auto-detect', () => {
  it('portrait SVG on landscape machine → rotate 90°', () => {
    const r = resolveAutoRotate(undefined, { ...portraitSvg, ...landscapeMachine })
    expect(r.degrees).toBe(90)
    expect(r.auto).toBe(true)
  })

  it('landscape SVG on portrait machine → rotate 90°', () => {
    const r = resolveAutoRotate(undefined, { ...landscapeSvg, ...portraitMachine })
    expect(r.degrees).toBe(90)
    expect(r.auto).toBe(true)
  })

  it('orientation matches → 0°', () => {
    const r = resolveAutoRotate(undefined, { ...portraitSvg, ...portraitMachine })
    expect(r.degrees).toBe(0)
    expect(r.auto).toBe(true)
  })

  it('square SVG → 0° (no preference)', () => {
    const r = resolveAutoRotate(undefined, { ...squareSvg, ...landscapeMachine })
    expect(r.degrees).toBe(0)
  })

  it('"auto" keyword behaves identically to undefined', () => {
    const a = resolveAutoRotate('auto',    { ...portraitSvg, ...landscapeMachine })
    const b = resolveAutoRotate(undefined, { ...portraitSvg, ...landscapeMachine })
    expect(a).toEqual(b)
  })

  it('missing dimensions → 0° with reason', () => {
    const r = resolveAutoRotate(undefined, {
      svgWidthMm: null, svgHeightMm: null,
      envelopeWidthMm: 430, envelopeHeightMm: 297,
    })
    expect(r.degrees).toBe(0)
    expect(r.auto).toBe(true)
    expect(r.reason).toBeDefined()
  })
})
