/**
 * Resolve the `--rotate` flag, including axicli-style auto-orientation.
 *
 * Axicli auto-rotates portrait-oriented documents 90° when the machine is
 * landscape (and vice versa) so content fits without the user having to think
 * about orientation. nib copies that behaviour by default, but makes it
 * explicit and overridable.
 */

export interface AutoRotateInput {
  svgWidthMm: number | null
  svgHeightMm: number | null
  envelopeWidthMm: number | null
  envelopeHeightMm: number | null
}

export interface AutoRotateResult {
  /** Degrees of rotation to apply (0, 90, 180, 270, or user-supplied). */
  degrees: number
  /** True when the decision was made by auto-detect (not an explicit user value). */
  auto: boolean
  /** Human-readable reason the auto decision went this way; present when auto=true. */
  reason?: string
}

/**
 * Decide rotation from a user-facing string arg.
 *
 * Accepted forms:
 *   undefined | "auto"     → auto-detect from orientation
 *   "none" | "0"           → no rotation
 *   "90" | "180" | "270"   → explicit rotation (any number is accepted)
 */
export function resolveAutoRotate(
  arg: string | undefined,
  input: AutoRotateInput,
): AutoRotateResult {
  if (arg === undefined || arg === 'auto') {
    return autoDetect(input)
  }
  if (arg === 'none') return { degrees: 0, auto: false }
  const n = parseFloat(arg)
  if (Number.isNaN(n)) {
    throw new Error(`invalid --rotate value: ${arg} (expected auto, none, or a number of degrees)`)
  }
  return { degrees: n, auto: false }
}

function autoDetect(input: AutoRotateInput): AutoRotateResult {
  const { svgWidthMm: sw, svgHeightMm: sh, envelopeWidthMm: ew, envelopeHeightMm: eh } = input
  // We need both the SVG dimensions and the machine envelope to decide. If
  // either is missing, don't rotate — the user can set `--rotate 90` manually.
  if (!sw || !sh || !ew || !eh) {
    return { degrees: 0, auto: true, reason: 'dimensions unknown' }
  }
  const svgPortrait = sh > sw
  const envLandscape = ew > eh
  if (svgPortrait === envLandscape && svgPortrait !== (eh > ew)) {
    // Same shape already — no rotation needed.
  }
  const shapeMatches = svgPortrait === (eh > ew)  // both portrait or both landscape
  if (shapeMatches) {
    return { degrees: 0, auto: true, reason: 'orientation matches machine' }
  }
  return {
    degrees: 90,
    auto: true,
    reason: `${svgPortrait ? 'portrait' : 'landscape'} SVG on ${envLandscape ? 'landscape' : 'portrait'} machine`,
  }
}
