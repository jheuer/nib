/**
 * Fast structural stats from an SVG — element count, layer IDs, viewBox,
 * dimensions. Used for quick dashboard-style reports before running the
 * heavier move planner.
 */

import { parse as parseSvg } from 'svgson'
import { parseDimMm } from '../core/svg-units.ts'

export interface SvgStats {
  pathCount: number
  layerIds: number[]
  viewBox: { x: number; y: number; width: number; height: number } | null
  widthMm: number | null
  heightMm: number | null
  /** Content of the SVG's first <title> element, if present. */
  title: string | null
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

  const widthMm  = parseDimMm(root.attributes['width'])
  const heightMm = parseDimMm(root.attributes['height'])

  // <title> is conventionally a direct child of <svg>
  const titleNode = root.children?.find(c => c.name === 'title')
  const title = titleNode?.children?.[0]?.value?.trim() ?? null

  return { pathCount, layerIds, viewBox, widthMm, heightMm, title }
}
