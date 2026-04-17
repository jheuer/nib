/**
 * Parse an SVG length attribute into millimetres. Shared by SVG parsing,
 * stat computation, and anywhere else the library needs to interpret
 * document sizes.
 *
 * Supported units: mm, cm, in, px, pt, pc. Unitless values are treated as
 * user units at the SVG spec's 96 dpi convention. em / ex / % are not
 * handled (rare in plot SVGs; return null so callers can warn).
 */

const MM_PER_INCH = 25.4
const PX_PER_INCH = 96
const PT_PER_INCH = 72
const PC_PER_INCH = 6

export function parseDimMm(raw: string | undefined): number | null {
  if (!raw) return null
  // Permissive match: signed/decimal number, optional unit, optional whitespace.
  const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|in|px|pt|pc)?\s*$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  switch ((m[2] ?? '').toLowerCase()) {
    case 'mm': return n
    case 'cm': return n * 10
    case 'in': return n * MM_PER_INCH
    case 'px': return n * (MM_PER_INCH / PX_PER_INCH)
    case 'pt': return n * (MM_PER_INCH / PT_PER_INCH)
    case 'pc': return n * (MM_PER_INCH / PC_PER_INCH)
    default:   return n * (MM_PER_INCH / PX_PER_INCH)   // unitless → px
  }
}
