/**
 * Fast structural stats from an SVG — element count, layer IDs, viewBox,
 * dimensions. Used for quick dashboard-style reports before running the
 * heavier move planner.
 */

import { parse as parseSvg } from 'svgson'

export interface SvgStats {
  pathCount: number
  layerIds: number[]
  viewBox: { x: number; y: number; width: number; height: number } | null
  widthMm: number | null
  heightMm: number | null
}

const DRAWABLE = new Set(['path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon'])

export async function getSvgStats(svgContent: string): Promise<SvgStats> {
  const root = await parseSvg(svgContent)
  let pathCount = 0
  const layerIds: number[] = []

  function walk(node: typeof root): void {
    if (DRAWABLE.has(node.name)) pathCount++
    const mode = node.attributes['inkscape:groupmode']
    const id   = node.attributes['id']
    if (mode === 'layer' && id) {
      const num = parseInt(id.replace(/\D/g, ''), 10)
      if (!isNaN(num)) layerIds.push(num)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)

  const vb = root.attributes['viewBox']
  let viewBox: SvgStats['viewBox'] = null
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
    }
  }

  const widthMm  = parseMmAttr(root.attributes['width'])
  const heightMm = parseMmAttr(root.attributes['height'])

  return { pathCount, layerIds, viewBox, widthMm, heightMm }
}

function parseMmAttr(val: string | undefined): number | null {
  if (!val) return null
  const m = val.match(/([\d.]+)(mm|cm|in|px)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  switch (m[2]) {
    case 'cm': return n * 10
    case 'in': return n * 25.4
    case 'px': return n * 0.264583
    default:   return n
  }
}
