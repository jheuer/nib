/**
 * SVG layer discovery, matching the AxiDraw / axicli label convention.
 *
 * Inkscape stores layer metadata on <g> elements as:
 *   <g inkscape:groupmode="layer" inkscape:label="1 outline" id="layer1">
 *
 * We parse the label — not the id — because `inkscape:label` is the name
 * the user typed in the Layers panel and is what axicli matches against.
 *
 * Label prefix conventions (subset of axicli's — Phase 5a covers these):
 *
 *   "1 outline"        → layer number 1, name "outline"
 *   "! hidden notes"   → skip entirely (never plot)
 *   "outlines"         → no leading digit → unnumbered layer, inherits id
 *                        as fallback layer number (like old behavior)
 *
 * Phase 5b may add `+pause`, `+speed{N}`, `+pos_down{N}` overrides.
 */

import { parseSync as parseSvg } from 'svgson'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SvgLayer {
  /** Numeric layer ID — leading integer from the label, or id fallback. */
  id: number
  /** Human-friendly layer name (label with prefix stripped, trimmed). */
  name: string
  /** Original raw inkscape:label (or id) string, for diagnostics. */
  rawLabel: string
  /** True when label starts with `!` — don't plot this layer. */
  skip: boolean
  /** SVG `id` attribute of the layer <g> element, for CSS targeting. */
  svgId?: string
}

/**
 * Parse all layer groups in the SVG and return one entry per discovered layer,
 * in document order. Layers without a parseable number (no leading digit in
 * label, no digits in id) are omitted — they behave like non-layer content
 * and plot as part of the main document.
 */
export function parseSvgLayers(svg: string): SvgLayer[] {
  const root = parseSvg(svg)
  const out: SvgLayer[] = []
  walk(root, out)
  return out
}

/**
 * Extract layer metadata from a single element's attributes. Returns null if
 * this element is not an Inkscape layer group (i.e. inkscape:groupmode is not
 * "layer"). Returned `.id` is NaN when the label has no leading digit and the
 * id has no digits either — callers should treat NaN as "unnumbered layer".
 */
export function parseLayerAttrs(attrs: Record<string, string>): SvgLayer | null {
  const mode = attrs['inkscape:groupmode']
  if (mode !== 'layer') return null

  const rawLabel = attrs['inkscape:label'] ?? attrs['id'] ?? ''
  const trimmed  = rawLabel.trim()

  // `!` prefix → skip. Allowed with or without a layer number following.
  //   "!hidden"        → skip, no number
  //   "!1 debug"       → skip, number 1
  let work = trimmed
  let skip = false
  if (work.startsWith('!')) {
    skip = true
    work = work.slice(1).trim()
  }

  // Leading integer (optional): "1 outline", "12"
  //   first try the label, fall back to parsing digits out of the id.
  const labelMatch = work.match(/^(\d+)\s*(.*)$/)
  let id: number
  let name: string
  if (labelMatch) {
    id = parseInt(labelMatch[1], 10)
    name = labelMatch[2].trim()
  } else {
    // Label has no leading digit — check the id attribute for trailing digits.
    //   "layer1" → 1, "mylayer_3" → 3
    const idAttr = attrs['id'] ?? ''
    const idMatch = idAttr.match(/(\d+)\D*$/)
    id = idMatch ? parseInt(idMatch[1], 10) : NaN
    // `work` already has leading `!` stripped, so it's safe to use as the
    // displayed name. Falls back to the trimmed label when no skip marker.
    name = work
  }

  return { id, name, rawLabel, skip, svgId: attrs['id'] || undefined }
}

// ─── Tree walk ────────────────────────────────────────────────────────────────

interface SvgNode {
  name: string
  attributes: Record<string, string>
  children?: SvgNode[]
}

function walk(node: SvgNode, out: SvgLayer[]): void {
  const info = parseLayerAttrs(node.attributes)
  if (info && !isNaN(info.id)) out.push(info)
  for (const child of node.children ?? []) walk(child as SvgNode, out)
}
