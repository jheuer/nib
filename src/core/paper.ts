/**
 * Resolve a paper sheet for plot + preview: dimensions, offset from home,
 * and display colour. Orthogonal to the machine envelope — an A4 sheet on
 * an A3 machine is a common case we want to visualize.
 */

import { parsePaperSize } from './preprocess.ts'

export interface ResolvedPaper {
  widthMm: number
  heightMm: number
  /** mm from the machine origin (home corner) to the paper's top-left. */
  offsetXMm: number
  offsetYMm: number
  /** CSS colour for preview rendering (ignored by the plotter). */
  color: string
  /** Original input — handy for display / logs. */
  source: string
}

export interface PaperInput {
  /** Paper size string. Named ("A4", "letter") or explicit ("297x210"). */
  size?: string
  /** "portrait" swaps W/H so width < height; "landscape" swaps the other way. */
  orientation?: 'portrait' | 'landscape'
  /** Offset string like "10,10" (mm from home). */
  offset?: string
  /** CSS colour (e.g. "#fdfcf7", "cream", "black"). */
  color?: string
}

/**
 * Resolve paper dimensions + offset + colour from CLI args / project config.
 * Returns null when no size is specified (callers render without a paper
 * inset — the envelope itself acts as the page boundary).
 */
export function resolvePaper(input: PaperInput): ResolvedPaper | null {
  if (!input.size) return null
  const dims = parsePaperSize(input.size)
  if (!dims) return null

  // Apply orientation. "portrait" forces h>=w; "landscape" forces w>=h. If the
  // input already matches, it's a no-op.
  let { width, height } = dims
  if (input.orientation === 'portrait'  && width  > height) [width, height] = [height, width]
  if (input.orientation === 'landscape' && height > width)  [width, height] = [height, width]

  const offset = parseOffset(input.offset) ?? { x: 0, y: 0 }
  const color = input.color?.trim() || '#fdfcf7'

  return {
    widthMm: width,
    heightMm: height,
    offsetXMm: offset.x,
    offsetYMm: offset.y,
    color,
    source: input.size,
  }
}

/** Parse "X,Y" (mm) into {x, y}. Returns null on malformed input. */
export function parseOffset(s: string | undefined): { x: number; y: number } | null {
  if (!s) return null
  const m = s.match(/^\s*([-\d.]+)\s*[,x]\s*([-\d.]+)\s*$/)
  if (!m) return null
  const x = parseFloat(m[1])
  const y = parseFloat(m[2])
  if (Number.isNaN(x) || Number.isNaN(y)) return null
  return { x, y }
}
