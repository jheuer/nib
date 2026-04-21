/**
 * SVG → plotter move sequence
 *
 * Parses an SVG document and returns a flat list of absolute XY moves with
 * pen-down state. All coordinates are in millimetres relative to the SVG's
 * top-left origin.
 *
 * Supports: <path>, <line>, <rect>, <circle>, <ellipse>, <polyline>, <polygon>,
 *           <text> (rendered with Hershey Simplex font), <use> (symbol/element refs)
 * Handles: nested groups with cumulative transforms, viewBox / width-height scaling
 */

import { parseSync as parseSvg } from 'svgson'
import { SVGPathData, SVGPathDataTransformer } from 'svg-pathdata'
import { parseLayerAttrs } from '../core/svg-layers.ts'
import { parseDimMm } from '../core/svg-units.ts'
import { HERSHEY_GLYPHS, HERSHEY_CAP_HEIGHT } from '../core/hershey.ts'
// SVGCommand is not re-exported from the top-level — import from the sub-path
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SVGPathDataCommand = any

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PlannerMove {
  x: number          // mm from SVG origin
  y: number          // mm from SVG origin
  penDown: boolean   // true = pen contact with paper
}

export interface MovePlanOptions {
  /** Flatness tolerance for bezier flattening in mm (default 0.1) */
  tolerance?: number
  /** Only include paths on this Inkscape layer (by numeric layer ID) */
  layer?: number
}

/**
 * Convert an SVG string into a flat list of plotter moves (in mm).
 * Output always starts with pen-up at (0,0). Caller maps speed from profile.
 */
export function svgToMoves(svgContent: string, options: MovePlanOptions = {}): PlannerMove[] {
  const tol = options.tolerance ?? 0.1
  const root = parseSvg(svgContent)

  // ── Coordinate scale + viewBox origin: user-units → mm, shifted so the
  // viewport top-left corner = (0, 0) mm. Without the shift, SVGs with a
  // non-zero viewBox origin (common when authors use the viewBox to express
  // a page margin) would plot at negative coords and crash the envelope.
  const { scale, vbX, vbY } = resolveScale(root)
  // Bake the viewBox translation into the initial CTM so every downstream
  // transform sees content in post-shift user units. Avoids threading an
  // offset through every helper.
  const initialCtm: Matrix = [1, 0, 0, 1, -vbX, -vbY]

  // Build a map of id → node for <use> element resolution.
  const defsMap = buildDefsMap(root)

  const moves: PlannerMove[] = [{ x: 0, y: 0, penDown: false }]

  walkNode(root, initialCtm, INITIAL_STYLE, scale, tol, options.layer ?? null, moves, defsMap)

  // Ensure we end pen-up
  if (moves.length > 0 && moves[moves.length - 1].penDown) {
    moves.push({ ...moves[moves.length - 1], penDown: false })
  }

  return moves
}

// ─── Defs map ─────────────────────────────────────────────────────────────────

function buildDefsMap(root: SvgNode): Map<string, SvgNode> {
  const map = new Map<string, SvgNode>()
  collectIds(root, map)
  return map
}

function collectIds(node: SvgNode, map: Map<string, SvgNode>): void {
  const id = node.attributes['id']
  if (id) map.set(id, node)
  for (const child of node.children ?? []) collectIds(child as SvgNode, map)
}

// ─── Coordinate scale resolution ─────────────────────────────────────────────

function resolveScale(root: ReturnType<typeof parseSvg>): { scale: number; vbX: number; vbY: number } {
  const vb = root.attributes['viewBox']
  const wAttr = root.attributes['width']
  const hAttr = root.attributes['height']

  let vbX = 0, vbY = 0, vbW = 0, vbH = 0
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      vbX = parts[0]; vbY = parts[1]; vbW = parts[2]; vbH = parts[3]
    }
  }

  const widthMm  = parseDimMm(wAttr)
  const heightMm = parseDimMm(hAttr)

  let scale: number
  if (vbW > 0 && widthMm !== null)       scale = widthMm / vbW
  else if (vbH > 0 && heightMm !== null) scale = heightMm / vbH
  else                                    scale = 25.4 / 96   // SVG spec fallback

  return { scale, vbX, vbY }
}

// ─── 2D Affine matrix ─────────────────────────────────────────────────────────
// [a c e]
// [b d f]
// [0 0 1]

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiplyMatrix(A: Matrix, B: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = A
  const [a2, b2, c2, d2, e2, f2] = B
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function parseTransform(attr: string): Matrix {
  let result: Matrix = IDENTITY
  // Find all transform functions
  const re = /(\w+)\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(attr)) !== null) {
    const fn = match[1]
    const args = match[2].split(/[\s,]+/).map(Number)
    result = multiplyMatrix(result, transformFn(fn, args))
  }
  return result
}

function transformFn(fn: string, a: number[]): Matrix {
  switch (fn) {
    case 'translate': return [1, 0, 0, 1, a[0], a[1] ?? 0]
    case 'scale':     return [a[0], 0, 0, a[1] ?? a[0], 0, 0]
    case 'rotate': {
      const rad = (a[0] * Math.PI) / 180
      const cos = Math.cos(rad); const sin = Math.sin(rad)
      const cx = a[1] ?? 0; const cy = a[2] ?? 0
      return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]
    }
    case 'matrix': return [a[0], a[1], a[2], a[3], a[4], a[5]] as Matrix
    case 'skewX': { const t = Math.tan((a[0] * Math.PI) / 180); return [1, 0, t, 1, 0, 0] }
    case 'skewY': { const t = Math.tan((a[0] * Math.PI) / 180); return [1, t, 0, 1, 0, 0] }
    default: return IDENTITY
  }
}

// ─── Tree walker ──────────────────────────────────────────────────────────────

interface SvgNode {
  name: string
  type?: string   // 'element' | 'text' (svgson text-content nodes have type='text')
  value?: string  // text content for type='text' nodes
  attributes: Record<string, string>
  children?: SvgNode[]
}

/**
 * Computed style context inherited from ancestors. SVG's painting-and-visibility
 * attributes cascade down the tree — a hidden <g> hides all its descendants.
 * We only track the minimum set that affects what a plotter draws.
 */
interface StyleContext {
  display: 'inline' | 'none'
  visibility: 'visible' | 'hidden'
  /** null = not declared, 'none' = explicit skip, anything else = plot */
  stroke: string | null
  /** null = not declared. Explicit non-none fill with no stroke means "filled
   *  region, decorative" — plotters don't draw fills, so skip it. */
  fill: string | null
}

const INITIAL_STYLE: StyleContext = {
  display: 'inline',
  visibility: 'visible',
  stroke: null,
  fill: null,
}

/**
 * Parse relevant painting properties from an SVG element's own `style="..."`
 * and presentation attributes, returning a merged context (child-over-parent).
 */
function mergeStyle(parent: StyleContext, attrs: Record<string, string>): StyleContext {
  // Start by copying parent (inheritance)
  const next: StyleContext = { ...parent }

  // Inline style first so presentation attributes can override (SVG spec says
  // presentation attributes have lower specificity than `style`; but in practice
  // most authoring tools set one or the other — either order works for us).
  const styleAttr = attrs['style']
  if (styleAttr) {
    for (const decl of styleAttr.split(';')) {
      const [rawKey, ...rest] = decl.split(':')
      const key = rawKey?.trim()
      const val = rest.join(':').trim()
      if (!key || !val) continue
      if (key === 'display')         next.display    = val === 'none' ? 'none' : 'inline'
      else if (key === 'visibility') next.visibility = val === 'hidden' ? 'hidden' : 'visible'
      else if (key === 'stroke')     next.stroke     = val
      else if (key === 'fill')       next.fill       = val
    }
  }

  // Presentation attributes
  const dispAttr = attrs['display']
  if (dispAttr === 'none') next.display = 'none'
  else if (dispAttr)       next.display = 'inline'

  const visAttr = attrs['visibility']
  if (visAttr === 'hidden')  next.visibility = 'hidden'
  else if (visAttr)          next.visibility = 'visible'

  const strokeAttr = attrs['stroke']
  if (strokeAttr) next.stroke = strokeAttr

  const fillAttr = attrs['fill']
  if (fillAttr) next.fill = fillAttr

  return next
}

/**
 * Plotter skip rule: an element with an explicit non-none fill and no
 * effective stroke is a decorative filled region — skip it. Matches axicli's
 * convention. Elements with neither fill nor stroke declared fall through
 * and plot (common in generative output that relies on SVG defaults).
 */
function isFillOnly(style: StyleContext): boolean {
  const hasVisibleFill = style.fill !== null && style.fill !== 'none'
  const hasVisibleStroke = style.stroke !== null && style.stroke !== 'none'
  return hasVisibleFill && !hasVisibleStroke
}

function walkNode(
  node: SvgNode,
  ctm: Matrix,        // current transform matrix
  style: StyleContext,// inherited painting context
  scale: number,      // document scale: user-units → mm
  tol: number,        // flatness tolerance (mm)
  filterLayer: number | null,
  out: PlannerMove[],
  defsMap: Map<string, SvgNode> = new Map(),
): void {
  // Accumulate transform
  const txAttr = node.attributes['transform']
  const local = txAttr ? parseTransform(txAttr) : IDENTITY
  const m = multiplyMatrix(ctm, local)

  // Merge this element's painting context into the inherited one
  const merged = mergeStyle(style, node.attributes)

  // Layer handling (Inkscape convention). A group with inkscape:groupmode="layer"
  // may encode a layer number and `!skip` prefix in its `inkscape:label`.
  //   - If the label/id doesn't say this is a layer, fall through and process
  //     as a normal group.
  //   - If it IS a layer and has `!` prefix → never plot its subtree.
  //   - If filterLayer is set → plot only the matching layer's subtree.
  const layerInfo = parseLayerAttrs(node.attributes)
  if (layerInfo) {
    if (layerInfo.skip) return
    if (filterLayer !== null && layerInfo.id !== filterLayer) return
  }

  // Skip whole subtree if this element (or any ancestor) is non-displaying.
  if (merged.display === 'none' || merged.visibility === 'hidden') return

  // Plotter skip rules for leaf drawable elements:
  //   - explicit stroke:none → never plot
  //   - explicit fill (non-none) with no stroke → decorative filled region
  //
  // Groups are not subject to either rule — their children may declare their
  // own style and override inherited context.
  const name = node.name
  const isLeaf = name === 'path' || name === 'line' || name === 'rect'
              || name === 'circle' || name === 'ellipse'
              || name === 'polyline' || name === 'polygon'
  if (isLeaf && merged.stroke === 'none') return
  if (isLeaf && isFillOnly(merged)) return

  if (name === 'path') {
    const d = node.attributes['d']
    if (d) appendPathMoves(d, m, scale, tol, out)
  } else if (name === 'line') {
    appendLineMoves(node.attributes, m, scale, out)
  } else if (name === 'rect') {
    appendRectMoves(node.attributes, m, scale, tol, out)
  } else if (name === 'circle') {
    appendCircleMoves(node.attributes, m, scale, tol, out)
  } else if (name === 'ellipse') {
    appendEllipseMoves(node.attributes, m, scale, tol, out)
  } else if (name === 'polyline') {
    appendPolylineMoves(node.attributes['points'] ?? '', false, m, scale, out)
  } else if (name === 'polygon') {
    appendPolylineMoves(node.attributes['points'] ?? '', true, m, scale, out)
  } else if (name === 'text') {
    appendTextMoves(node, m, scale, out)
  } else if (name === 'use') {
    const href = node.attributes['href'] ?? node.attributes['xlink:href'] ?? ''
    const refId = href.startsWith('#') ? href.slice(1) : ''
    const refNode = defsMap.get(refId)
    if (refNode) {
      const ux = parseFloat(node.attributes['x'] ?? '0')
      const uy = parseFloat(node.attributes['y'] ?? '0')
      const useTx: Matrix = [1, 0, 0, 1, ux, uy]
      walkNode(refNode, multiplyMatrix(m, useTx), merged, scale, tol, filterLayer, out, defsMap)
    }
  }

  for (const child of node.children ?? []) {
    walkNode(child as SvgNode, m, merged, scale, tol, filterLayer, out, defsMap)
  }
}

// ─── Per-element move generators ─────────────────────────────────────────────

function appendPathMoves(
  d: string,
  m: Matrix,
  scale: number,
  tol: number,
  out: PlannerMove[],
): void {
  // Normalize: absolute coords, arcs→cubics, S/T→C/Q, Q→C, HV→L
  const parser = new SVGPathData(d)
  const commands = parser
    .transform(SVGPathDataTransformer.TO_ABS())
    .transform(SVGPathDataTransformer.NORMALIZE_HVZ())
    .transform(SVGPathDataTransformer.A_TO_C() as ReturnType<typeof SVGPathDataTransformer.TO_ABS>)
    .transform(SVGPathDataTransformer.NORMALIZE_ST())
    .transform(SVGPathDataTransformer.QT_TO_C())
    .commands as SVGPathDataCommand[]

  let cx = 0; let cy = 0
  let startX = 0; let startY = 0

  for (const cmd of commands) {
    const t = cmd.type

    if (t === SVGPathData.MOVE_TO) {
      const c = cmd as { x: number; y: number }
      cx = c.x; cy = c.y
      startX = cx; startY = cy
      const [px, py] = transformPoint(cx, cy, m, scale)
      penUp(px, py, out)
    } else if (t === SVGPathData.LINE_TO) {
      const c = cmd as { x: number; y: number }
      cx = c.x; cy = c.y
      const [px, py] = transformPoint(cx, cy, m, scale)
      penDown(px, py, out)
    } else if (t === SVGPathData.CURVE_TO) {
      const c = cmd as { x1: number; y1: number; x2: number; y2: number; x: number; y: number }
      flattenCubic(cx, cy, c.x1, c.y1, c.x2, c.y2, c.x, c.y, m, scale, tol, out, true)
      cx = c.x; cy = c.y
    } else if (t === SVGPathData.CLOSE_PATH) {
      const [px, py] = transformPoint(startX, startY, m, scale)
      penDown(px, py, out)
      cx = startX; cy = startY
    }
  }
}

function appendLineMoves(
  attrs: Record<string, string>,
  m: Matrix,
  scale: number,
  out: PlannerMove[],
): void {
  const x1 = parseFloat(attrs['x1'] ?? '0')
  const y1 = parseFloat(attrs['y1'] ?? '0')
  const x2 = parseFloat(attrs['x2'] ?? '0')
  const y2 = parseFloat(attrs['y2'] ?? '0')
  const [px1, py1] = transformPoint(x1, y1, m, scale)
  const [px2, py2] = transformPoint(x2, y2, m, scale)
  penUp(px1, py1, out)
  penDown(px2, py2, out)
}

function appendRectMoves(
  attrs: Record<string, string>,
  m: Matrix,
  scale: number,
  tol: number,
  out: PlannerMove[],
): void {
  const x = parseFloat(attrs['x'] ?? '0')
  const y = parseFloat(attrs['y'] ?? '0')
  const w = parseFloat(attrs['width'] ?? '0')
  const h = parseFloat(attrs['height'] ?? '0')
  const rx = parseFloat(attrs['rx'] ?? attrs['ry'] ?? '0') || 0
  const ry = parseFloat(attrs['ry'] ?? attrs['rx'] ?? '0') || rx

  if (rx === 0 && ry === 0) {
    // Simple rectangle
    const corners: Array<[number, number]> = [
      [x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y],
    ]
    const [p0x, p0y] = transformPoint(x, y, m, scale)
    penUp(p0x, p0y, out)
    for (let i = 1; i < corners.length; i++) {
      const [px, py] = transformPoint(corners[i][0], corners[i][1], m, scale)
      penDown(px, py, out)
    }
  } else {
    // Rounded rectangle: build path string and recurse
    const r = Math.min(rx, w / 2)
    const s = Math.min(ry, h / 2)
    const d = `M ${x + r},${y} L ${x + w - r},${y} ` +
      `C ${x + w - r * 0.448},${y} ${x + w},${y + s * 0.448} ${x + w},${y + s} ` +
      `L ${x + w},${y + h - s} ` +
      `C ${x + w},${y + h - s * 0.448} ${x + w - r * 0.448},${y + h} ${x + w - r},${y + h} ` +
      `L ${x + r},${y + h} ` +
      `C ${x + r * 0.448},${y + h} ${x},${y + h - s * 0.448} ${x},${y + h - s} ` +
      `L ${x},${y + s} ` +
      `C ${x},${y + s * 0.448} ${x + r * 0.448},${y} ${x + r},${y} Z`
    appendPathMoves(d, m, scale, tol, out)
  }
}

function appendCircleMoves(
  attrs: Record<string, string>,
  m: Matrix,
  scale: number,
  tol: number,
  out: PlannerMove[],
): void {
  const cx = parseFloat(attrs['cx'] ?? '0')
  const cy = parseFloat(attrs['cy'] ?? '0')
  const r  = parseFloat(attrs['r'] ?? '0')
  // Circle approximated by 4 cubic beziers (κ ≈ 0.5522847498)
  const k = r * 0.5522847498
  const d = `M ${cx + r},${cy} ` +
    `C ${cx + r},${cy + k} ${cx + k},${cy + r} ${cx},${cy + r} ` +
    `C ${cx - k},${cy + r} ${cx - r},${cy + k} ${cx - r},${cy} ` +
    `C ${cx - r},${cy - k} ${cx - k},${cy - r} ${cx},${cy - r} ` +
    `C ${cx + k},${cy - r} ${cx + r},${cy - k} ${cx + r},${cy} Z`
  appendPathMoves(d, m, scale, tol, out)
}

function appendEllipseMoves(
  attrs: Record<string, string>,
  m: Matrix,
  scale: number,
  tol: number,
  out: PlannerMove[],
): void {
  const cx = parseFloat(attrs['cx'] ?? '0')
  const cy = parseFloat(attrs['cy'] ?? '0')
  const rx = parseFloat(attrs['rx'] ?? '0')
  const ry = parseFloat(attrs['ry'] ?? '0')
  const kx = rx * 0.5522847498
  const ky = ry * 0.5522847498
  const d = `M ${cx + rx},${cy} ` +
    `C ${cx + rx},${cy + ky} ${cx + kx},${cy + ry} ${cx},${cy + ry} ` +
    `C ${cx - kx},${cy + ry} ${cx - rx},${cy + ky} ${cx - rx},${cy} ` +
    `C ${cx - rx},${cy - ky} ${cx - kx},${cy - ry} ${cx},${cy - ry} ` +
    `C ${cx + kx},${cy - ry} ${cx + rx},${cy - ky} ${cx + rx},${cy} Z`
  appendPathMoves(d, m, scale, tol, out)
}

function appendPolylineMoves(
  pointsAttr: string,
  close: boolean,
  m: Matrix,
  scale: number,
  out: PlannerMove[],
): void {
  const nums = pointsAttr.trim().split(/[\s,]+/).map(Number)
  if (nums.length < 2) return
  const [px0, py0] = transformPoint(nums[0], nums[1], m, scale)
  penUp(px0, py0, out)
  for (let i = 2; i + 1 < nums.length; i += 2) {
    const [px, py] = transformPoint(nums[i], nums[i + 1], m, scale)
    penDown(px, py, out)
  }
  if (close) {
    penDown(px0, py0, out)
  }
}

// ─── Bezier flattening ────────────────────────────────────────────────────────

/**
 * Adaptively flatten a cubic bezier using the midpoint subdivision test.
 * Appends pen-down moves to `out`. If `isFirst` is true, a pen-up to p0
 * is NOT prepended (caller already positioned); otherwise one is added.
 */
function flattenCubic(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  m: Matrix,
  scale: number,
  tol: number,
  out: PlannerMove[],
  continuePath: boolean,
): void {
  // Check if the bezier is flat enough (using the control point deviation test)
  // in document coordinates (before scale)
  const tolDoc = tol / scale

  const d1 = Math.abs(x1 - (2 * x1 - x0)) + Math.abs(y1 - (2 * y1 - y0))
  const d2 = Math.abs(x2 - (2 * x2 - x3)) + Math.abs(y2 - (2 * y2 - y3))

  if (d1 + d2 < tolDoc * 4) {
    // Flat enough: emit the endpoint
    const [px, py] = transformPoint(x3, y3, m, scale)
    penDown(px, py, out)
    return
  }

  // Subdivide at t=0.5 using de Casteljau
  const mx01 = (x0 + x1) / 2; const my01 = (y0 + y1) / 2
  const mx12 = (x1 + x2) / 2; const my12 = (y1 + y2) / 2
  const mx23 = (x2 + x3) / 2; const my23 = (y2 + y3) / 2
  const mx012 = (mx01 + mx12) / 2; const my012 = (my01 + my12) / 2
  const mx123 = (mx12 + mx23) / 2; const my123 = (my12 + my23) / 2
  const mid = (mx012 + mx123) / 2; const midy = (my012 + my123) / 2

  flattenCubic(x0, y0, mx01, my01, mx012, my012, mid, midy, m, scale, tol, out, continuePath)
  flattenCubic(mid, midy, mx123, my123, mx23, my23, x3, y3, m, scale, tol, out, true)
}

// ─── Text → Hershey ──────────────────────────────────────────────────────────

/**
 * Render a `<text>` element using the Hershey Simplex font. Works in user-unit
 * space so the CTM (transforms, viewBox scale) applies correctly to each glyph
 * point — including rotated or scaled text containers.
 *
 * SVG `y` on a text element is the baseline; Hershey y=0 is the cap top.
 * Adjustment: capTop = baseline − capHeight.
 */
function appendTextMoves(
  node: SvgNode,
  m: Matrix,
  scale: number,
  out: PlannerMove[],
): void {
  // Collect text content from immediate text children and <tspan> descendants.
  let content = ''
  for (const child of node.children ?? []) {
    const c = child as SvgNode
    if (c.type === 'text') {
      content += c.value ?? ''
    } else if (c.name === 'tspan') {
      for (const tc of c.children ?? []) {
        const t = tc as SvgNode
        if (t.type === 'text') content += t.value ?? ''
      }
    }
  }
  content = content.trim()
  if (!content) return

  const attrs = node.attributes
  const xUser = parseFloat(attrs['x'] ?? '0')
  const yUser = parseFloat(attrs['y'] ?? '0')

  // font-size: explicit units (12mm, 12px…) take priority, else treat as user units.
  const fsRaw  = attrs['font-size'] ?? attrs['fontSize'] ?? '12'
  const fsMmExplicit = parseDimMm(fsRaw)
  const fsUserUnits  = fsMmExplicit !== null
    ? fsMmExplicit / scale
    : (parseFloat(fsRaw) || 12)

  const fontScale = fsUserUnits / HERSHEY_CAP_HEIGHT
  // SVG y is the baseline; Hershey origin is the cap-top.
  const capTopY = yUser - HERSHEY_CAP_HEIGHT * fontScale

  let cursorX = xUser
  for (const char of content) {
    const code = char.codePointAt(0) ?? 63
    const glyph = HERSHEY_GLYPHS[code] ?? HERSHEY_GLYPHS[63]!
    const glyphX = cursorX - glyph.left * fontScale

    for (const stroke of glyph.strokes) {
      if (stroke.length < 2) continue
      const [p0x, p0y] = transformPoint(glyphX + stroke[0][0] * fontScale, capTopY + stroke[0][1] * fontScale, m, scale)
      penUp(p0x, p0y, out)
      for (let i = 1; i < stroke.length; i++) {
        const [px, py] = transformPoint(glyphX + stroke[i][0] * fontScale, capTopY + stroke[i][1] * fontScale, m, scale)
        penDown(px, py, out)
      }
    }

    cursorX += (glyph.right - glyph.left) * fontScale
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function transformPoint(x: number, y: number, m: Matrix, scale: number): [number, number] {
  const [tx, ty] = applyMatrix(m, x, y)
  return [tx * scale, ty * scale]
}

function penUp(x: number, y: number, out: PlannerMove[]): void {
  // If last move was already pen-up at this position, skip
  const last = out[out.length - 1]
  if (last && !last.penDown && Math.abs(last.x - x) < 0.001 && Math.abs(last.y - y) < 0.001) return
  out.push({ x, y, penDown: false })
}

function penDown(x: number, y: number, out: PlannerMove[]): void {
  out.push({ x, y, penDown: true })
}
