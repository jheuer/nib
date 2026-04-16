import { parseSync, stringify } from 'svgson'
import type { PreprocessStep } from './job.ts'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface PreprocessConfig {
  paperMm?: { width: number; height: number }
  marginMm?: number
}

type SvgNode = ReturnType<typeof parseSync>

// Drawable element names that carry fill/stroke
const DRAWABLE = new Set(['path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon'])

// ─── Public API ───────────────────────────────────────────────────────────────

export function applyPreprocessSteps(
  svg: string,
  steps: PreprocessStep[],
  config: PreprocessConfig = {},
): string {
  if (steps.length === 0) return svg
  let node = parseSync(svg)
  for (const step of steps) {
    node = applyStep(node, step, config)
  }
  return stringify(node)
}

// ─── Steps ────────────────────────────────────────────────────────────────────

function applyStep(node: SvgNode, step: PreprocessStep, config: PreprocessConfig): SvgNode {
  switch (step) {
    case 'strip-fills':       return stripFills(node)
    case 'center':            return centerOnPaper(node, config)
    case 'scale-to-paper':    return scaleToPaper(node, config)
    case 'registration-marks': return addRegistrationMarks(node, config)
  }
}

// ─── strip-fills ─────────────────────────────────────────────────────────────
// Removes fill colors from all drawable elements, leaving only strokes.
// Plotter-safe output: paths plot their outline, nothing is filled.

function stripFills(node: SvgNode): SvgNode {
  return walkNode(node, (n) => {
    if (!DRAWABLE.has(n.name) && n.name !== 'g' && n.name !== 'svg') return n
    const attrs = { ...n.attributes }

    // Direct fill attribute
    if (attrs['fill'] && attrs['fill'] !== 'none') {
      attrs['fill'] = 'none'
    } else if (n.name !== 'g' && n.name !== 'svg' && !attrs['fill']) {
      // SVG default fill is black — make it explicit none for plotters
      attrs['fill'] = 'none'
    }

    // Inline style: strip fill:color, keep everything else
    if (attrs['style']) {
      attrs['style'] = attrs['style']
        .replace(/fill\s*:\s*(?!none)[^;]+;?/gi, 'fill:none;')
        .replace(/;{2,}/g, ';')
        .replace(/^;|;$/g, '')
    }

    return { ...n, attributes: attrs }
  })
}

// ─── scale-to-paper ──────────────────────────────────────────────────────────
// Scales the SVG content to fit within the target paper bounds (with margin).
// Maintains aspect ratio. Updates the root SVG's width/height/viewBox.

function scaleToPaper(node: SvgNode, config: PreprocessConfig): SvgNode {
  const paper = config.paperMm
  if (!paper) {
    process.stderr.write('  preprocess warning: scale-to-paper requires paper size in axidraw.toml\n')
    return node
  }
  const margin = config.marginMm ?? 10
  const available = { w: paper.width - 2 * margin, h: paper.height - 2 * margin }

  const vb = parseViewBox(node.attributes['viewBox'])
  const svgW = vb?.width  ?? parseMmValue(node.attributes['width'])  ?? available.w
  const svgH = vb?.height ?? parseMmValue(node.attributes['height']) ?? available.h

  const scale = Math.min(available.w / svgW, available.h / svgH)

  const scaledW = svgW * scale
  const scaledH = svgH * scale
  const offsetX = margin + (available.w - scaledW) / 2
  const offsetY = margin + (available.h - scaledH) / 2

  // Wrap content in a transform group, update root dimensions
  const contentChildren = node.children
  const wrapper: SvgNode = {
    name: 'g',
    type: 'element',
    value: '',
    attributes: { transform: `translate(${fmt(offsetX)},${fmt(offsetY)}) scale(${fmt(scale)})` },
    children: contentChildren,
  }

  return {
    ...node,
    attributes: {
      ...node.attributes,
      width:   `${fmt(paper.width)}mm`,
      height:  `${fmt(paper.height)}mm`,
      viewBox: `0 0 ${fmt(paper.width)} ${fmt(paper.height)}`,
    },
    children: [wrapper],
  }
}

// ─── center ──────────────────────────────────────────────────────────────────
// Centers the SVG content on the target paper without resizing it.

function centerOnPaper(node: SvgNode, config: PreprocessConfig): SvgNode {
  const paper = config.paperMm
  if (!paper) {
    process.stderr.write('  preprocess warning: center requires paper size in axidraw.toml\n')
    return node
  }

  const vb = parseViewBox(node.attributes['viewBox'])
  const svgW = vb?.width  ?? parseMmValue(node.attributes['width'])  ?? paper.width
  const svgH = vb?.height ?? parseMmValue(node.attributes['height']) ?? paper.height

  const dx = (paper.width  - svgW) / 2
  const dy = (paper.height - svgH) / 2

  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return node

  const wrapper: SvgNode = {
    name: 'g',
    type: 'element',
    value: '',
    attributes: { transform: `translate(${fmt(dx)},${fmt(dy)})` },
    children: node.children,
  }

  return {
    ...node,
    attributes: {
      ...node.attributes,
      width:   `${fmt(paper.width)}mm`,
      height:  `${fmt(paper.height)}mm`,
      viewBox: `0 0 ${fmt(paper.width)} ${fmt(paper.height)}`,
    },
    children: [wrapper],
  }
}

// ─── registration-marks ──────────────────────────────────────────────────────
// Adds small "+" crosses at the four corners of the paper.
// Used for multi-session re-alignment.

function addRegistrationMarks(node: SvgNode, config: PreprocessConfig): SvgNode {
  const paper = config.paperMm
  if (!paper) {
    process.stderr.write('  preprocess warning: registration-marks requires paper size in axidraw.toml\n')
    return node
  }
  const margin = config.marginMm ?? 10
  const size = 4     // cross arm length in mm
  const half = size / 2

  const corners = [
    [margin, margin],
    [paper.width - margin, margin],
    [margin, paper.height - margin],
    [paper.width - margin, paper.height - margin],
  ]

  const marks: SvgNode[] = corners.flatMap(([cx, cy]) => [
    makePath(`M${fmt(cx - half)},${fmt(cy)} L${fmt(cx + half)},${fmt(cy)}`),
    makePath(`M${fmt(cx)},${fmt(cy - half)} L${fmt(cx)},${fmt(cy + half)}`),
  ])

  const marksGroup: SvgNode = {
    name: 'g',
    type: 'element',
    value: '',
    attributes: {
      id: 'nib-registration',
      stroke: 'black',
      'stroke-width': '0.2',
      fill: 'none',
    },
    children: marks,
  }

  return { ...node, children: [...node.children, marksGroup] }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function walkNode(node: SvgNode, fn: (n: SvgNode) => SvgNode): SvgNode {
  const updated = fn(node)
  return { ...updated, children: (updated.children ?? []).map(c => walkNode(c, fn)) }
}

function makePath(d: string): SvgNode {
  return { name: 'path', type: 'element', value: '', attributes: { d }, children: [] }
}

function fmt(n: number): string {
  return parseFloat(n.toFixed(4)).toString()
}

function parseViewBox(vb?: string): { x: number; y: number; width: number; height: number } | null {
  if (!vb) return null
  const parts = vb.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) return null
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

function parseMmValue(val?: string): number | null {
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

// ─── Paper size parser (used by callers) ─────────────────────────────────────

export function parsePaperSize(paper: string): { width: number; height: number } | null {
  // Accepts "297x420mm", "A3", "A4", "letter", etc.
  const named: Record<string, { width: number; height: number }> = {
    a4:     { width: 210, height: 297 },
    a3:     { width: 297, height: 420 },
    a2:     { width: 420, height: 594 },
    letter: { width: 215.9, height: 279.4 },
    legal:  { width: 215.9, height: 355.6 },
    tabloid:{ width: 279.4, height: 431.8 },
  }
  const lower = paper.toLowerCase().replace(/\s+/g, '')
  if (named[lower]) return named[lower]

  const m = paper.match(/([\d.]+)\s*[x×]\s*([\d.]+)\s*(mm|cm|in)?/i)
  if (!m) return null
  const factor = m[3]?.toLowerCase() === 'cm' ? 10 : m[3]?.toLowerCase() === 'in' ? 25.4 : 1
  return { width: parseFloat(m[1]) * factor, height: parseFloat(m[2]) * factor }
}
