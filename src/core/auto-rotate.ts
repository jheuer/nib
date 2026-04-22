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

  if (!sw || !sh) {
    return { degrees: 0, auto: true, reason: 'SVG dimensions unknown' }
  }

  const svgPortrait = sh > sw

  // When the envelope is known, use it to determine machine orientation.
  // When it isn't, assume landscape — every AxiDraw model is wider than tall.
  const machineLandscape = ew && eh ? ew > eh : true

  const shapeMatches = svgPortrait !== machineLandscape  // portrait≠landscape means mismatch → rotate
  if (!shapeMatches) {
    return { degrees: 0, auto: true, reason: 'orientation matches machine' }
  }
  return {
    degrees: 90,
    auto: true,
    reason: svgPortrait
      ? `portrait SVG on landscape machine`
      : `landscape SVG on portrait machine`,
  }
}
