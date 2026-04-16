import { describe, it, expect } from 'bun:test'
import { applyPreprocessSteps, parsePaperSize } from '../src/core/preprocess.ts'

// ─── parsePaperSize ───────────────────────────────────────────────────────────

describe('parsePaperSize', () => {
  it('parses named sizes case-insensitively', () => {
    expect(parsePaperSize('A4')).toEqual({ width: 210, height: 297 })
    expect(parsePaperSize('a3')).toEqual({ width: 297, height: 420 })
    expect(parsePaperSize('letter')).toEqual({ width: 215.9, height: 279.4 })
  })

  it('parses WxHmm format', () => {
    expect(parsePaperSize('297x420mm')).toEqual({ width: 297, height: 420 })
    expect(parsePaperSize('210x297mm')).toEqual({ width: 210, height: 297 })
  })

  it('parses WxH without unit as mm', () => {
    expect(parsePaperSize('200x300')).toEqual({ width: 200, height: 300 })
  })

  it('parses inch dimensions', () => {
    const r = parsePaperSize('8.5x11in')!
    expect(r.width).toBeCloseTo(215.9, 0)
    expect(r.height).toBeCloseTo(279.4, 0)
  })

  it('returns null for garbage input', () => {
    expect(parsePaperSize('notasize')).toBeNull()
    expect(parsePaperSize('')).toBeNull()
  })
})

// ─── strip-fills ─────────────────────────────────────────────────────────────

describe('strip-fills', () => {
  it('removes explicit fill colors', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect fill="red" stroke="black"/>
      <circle fill="#fff"/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['strip-fills'])
    expect(out).toContain('fill="none"')
    expect(out).not.toMatch(/fill="red"/)
    expect(out).not.toMatch(/fill="#fff"/)
  })

  it('removes fill from inline style', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <path style="fill:blue;stroke:black"/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['strip-fills'])
    expect(out).toContain('fill:none')
    expect(out).not.toContain('fill:blue')
  })

  it('preserves fill:none untouched', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect fill="none" stroke="black"/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['strip-fills'])
    expect(out).toContain('fill="none"')
  })

  it('adds fill:none to elements with no fill attribute', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <rect stroke="black"/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['strip-fills'])
    expect(out).toContain('fill="none"')
  })
})

// ─── scale-to-paper ──────────────────────────────────────────────────────────

describe('scale-to-paper', () => {
  const paperMm = { width: 210, height: 297 }

  it('updates root width, height, viewBox', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <rect x="0" y="0" width="100" height="100"/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['scale-to-paper'], { paperMm })
    expect(out).toContain('width="210mm"')
    expect(out).toContain('height="297mm"')
    expect(out).toContain('viewBox="0 0 210 297"')
  })

  it('wraps children in a transform group', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <rect x="0" y="0" width="100" height="100"/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['scale-to-paper'], { paperMm })
    expect(out).toMatch(/transform="translate\(/)
  })

  it('respects margin', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200mm" height="200mm">
      <rect/>
    </svg>`
    // 10mm margin (default): available = 190x277, scale = min(190/200, 277/200) = 0.95
    const out = applyPreprocessSteps(svg, ['scale-to-paper'], { paperMm, marginMm: 10 })
    expect(out).toContain('scale(0.95)')
  })

  it('is a no-op without paperMm', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect/></svg>`
    const out = applyPreprocessSteps(svg, ['scale-to-paper'])
    // No transform group added, original structure preserved
    expect(out).not.toMatch(/transform="translate/)
  })
})

// ─── center ──────────────────────────────────────────────────────────────────

describe('center', () => {
  const paperMm = { width: 200, height: 200 }

  it('centers a smaller SVG on the paper', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <rect/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['center'], { paperMm })
    // Should translate by 50mm in both axes (200-100)/2
    expect(out).toContain('translate(50,50)')
  })

  it('does not translate when already centered', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200mm" height="200mm">
      <rect/>
    </svg>`
    const out = applyPreprocessSteps(svg, ['center'], { paperMm })
    expect(out).not.toMatch(/transform="translate/)
  })
})

// ─── registration-marks ──────────────────────────────────────────────────────

describe('registration-marks', () => {
  const paperMm = { width: 200, height: 200 }

  it('appends a registration group', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`
    const out = applyPreprocessSteps(svg, ['registration-marks'], { paperMm })
    expect(out).toContain('id="nib-registration"')
  })

  it('adds 8 paths (2 cross arms × 4 corners)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`
    const out = applyPreprocessSteps(svg, ['registration-marks'], { paperMm })
    const pathCount = (out.match(/<path/g) ?? []).length
    // rect is not a <path>, so only 8 registration paths
    expect(pathCount).toBe(8)
  })
})

// ─── step composition ─────────────────────────────────────────────────────────

describe('step composition', () => {
  it('applies steps in order', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
      <rect fill="green" stroke="black"/>
    </svg>`
    const paperMm = { width: 210, height: 297 }
    const out = applyPreprocessSteps(svg, ['strip-fills', 'scale-to-paper'], { paperMm })
    expect(out).toContain('fill="none"')
    expect(out).toContain('width="210mm"')
  })
})
