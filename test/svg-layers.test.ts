import { describe, it, expect } from 'bun:test'
import { parseSvgLayers, parseLayerAttrs } from '../src/core/svg-layers.ts'

const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg"
  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
  viewBox="0 0 100 100" width="100mm" height="100mm">${inner}</svg>`

describe('parseLayerAttrs', () => {
  it('returns null for non-layer groups', () => {
    expect(parseLayerAttrs({})).toBeNull()
    expect(parseLayerAttrs({ 'inkscape:groupmode': 'other' })).toBeNull()
  })

  it('extracts layer number from "1 outline" label', () => {
    const info = parseLayerAttrs({
      'inkscape:groupmode': 'layer',
      'inkscape:label': '1 outline',
      'id': 'layer1',
    })
    expect(info?.id).toBe(1)
    expect(info?.name).toBe('outline')
    expect(info?.skip).toBe(false)
  })

  it('extracts bare numeric label "12"', () => {
    const info = parseLayerAttrs({
      'inkscape:groupmode': 'layer',
      'inkscape:label': '12',
      'id': 'layer12',
    })
    expect(info?.id).toBe(12)
    expect(info?.name).toBe('')
  })

  it('!prefix marks layer as skip', () => {
    const info = parseLayerAttrs({
      'inkscape:groupmode': 'layer',
      'inkscape:label': '! hidden notes',
      'id': 'layer3',
    })
    expect(info?.skip).toBe(true)
    // After stripping `!`, remainder has no leading digit → id fallback
    expect(info?.id).toBe(3)
  })

  it('!1 debug — combined skip + layer number', () => {
    const info = parseLayerAttrs({
      'inkscape:groupmode': 'layer',
      'inkscape:label': '!1 debug',
      'id': 'layer5',
    })
    expect(info?.skip).toBe(true)
    expect(info?.id).toBe(1)
    expect(info?.name).toBe('debug')
  })

  it('falls back to id digits when label has no leading number', () => {
    const info = parseLayerAttrs({
      'inkscape:groupmode': 'layer',
      'inkscape:label': 'outlines',
      'id': 'layer2',
    })
    expect(info?.id).toBe(2)
    expect(info?.name).toBe('outlines')
  })

  it('returns NaN id when nothing numeric is available', () => {
    const info = parseLayerAttrs({
      'inkscape:groupmode': 'layer',
      'inkscape:label': 'my-layer',
      'id': 'noDigitsHere',
    })
    expect(isNaN(info!.id)).toBe(true)
  })

  it('preserves rawLabel unchanged', () => {
    const info = parseLayerAttrs({
      'inkscape:groupmode': 'layer',
      'inkscape:label': '  !1 debug  ',
    })
    expect(info?.rawLabel).toBe('  !1 debug  ')
    expect(info?.skip).toBe(true)
    expect(info?.id).toBe(1)
  })
})

describe('parseSvgLayers', () => {
  it('returns empty for an SVG with no layers', () => {
    expect(parseSvgLayers(wrap('<rect width="10" height="10"/>'))).toEqual([])
  })

  it('discovers all numbered layers in document order', () => {
    const svg = wrap(`
      <g inkscape:groupmode="layer" inkscape:label="1 outline" id="l1">
        <rect width="10" height="10"/>
      </g>
      <g inkscape:groupmode="layer" inkscape:label="2 fills" id="l2">
        <rect width="20" height="20"/>
      </g>
    `)
    const layers = parseSvgLayers(svg)
    expect(layers.length).toBe(2)
    expect(layers[0].id).toBe(1)
    expect(layers[0].name).toBe('outline')
    expect(layers[1].id).toBe(2)
    expect(layers[1].name).toBe('fills')
  })

  it('includes a skipped layer but with skip=true', () => {
    const svg = wrap(`
      <g inkscape:groupmode="layer" inkscape:label="1 outline" id="l1"/>
      <g inkscape:groupmode="layer" inkscape:label="!notes" id="l2"/>
    `)
    const layers = parseSvgLayers(svg)
    expect(layers.length).toBe(2)
    expect(layers.find(l => l.id === 1)?.skip).toBe(false)
    expect(layers.find(l => l.rawLabel === '!notes')?.skip).toBe(true)
  })

  it('omits unnumbered layers (no label prefix, no id digits)', () => {
    const svg = wrap(`
      <g inkscape:groupmode="layer" inkscape:label="1 outline" id="l1"/>
      <g inkscape:groupmode="layer" inkscape:label="unnamed" id="unnamed"/>
    `)
    const layers = parseSvgLayers(svg)
    expect(layers.length).toBe(1)
    expect(layers[0].id).toBe(1)
  })
})
