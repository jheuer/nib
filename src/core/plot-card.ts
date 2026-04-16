/**
 * Plot card — metadata strip appended to each job's SVG
 *
 * After plotting the main artwork, optionally queue a small strip of
 * single-stroke Hershey text in the bottom margin. Since it uses
 * plottable (single-stroke) text, the plotter draws it as part of the job.
 *
 * Config lives in axidraw.toml under [plot_card]:
 *
 *   [plot_card]
 *   enabled = true
 *   position = "bottom-margin"        # or "top-margin"
 *   content = ["title", "date", "seed", "edition", "profile"]
 *   font_size_mm = 3
 *
 * Template fields:
 *   {title}    → job.file basename (no extension)
 *   {date}     → YYYY-MM-DD
 *   {seed}     → job.seed (hex, e.g. "0x4a2f")
 *   {edition}  → "3/20"
 *   {profile}  → profile.name
 *   {duration} → "7m 14s"
 */

import { hersheyText, hersheyTextWidth } from './hershey.ts'
import { parsePaperSize } from './preprocess.ts'
import type { ResolvedProfile } from './job.ts'

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PlotCardConfig {
  enabled: boolean
  position?: 'bottom-margin' | 'top-margin'
  content?: PlotCardField[]
  fontSizeMm?: number
}

export type PlotCardField = 'title' | 'date' | 'seed' | 'edition' | 'profile' | 'duration'

export const DEFAULT_PLOT_CARD: PlotCardConfig = {
  enabled: false,
  position: 'bottom-margin',
  content: ['title', 'date', 'seed', 'edition', 'profile'],
  fontSizeMm: 3,
}

export interface PlotCardVars {
  title?: string        // artwork title / file name
  date?: string         // YYYY-MM-DD override (defaults to today)
  seed?: number         // generative seed
  edition?: string      // "3/20"
  profile?: string      // pen profile name
  duration?: string     // "7m 14s"
}

/**
 * Append a plot-card strip to an SVG string.
 * Returns the modified SVG with an additional `<g id="nib-plot-card">` element.
 */
export function appendPlotCard(
  svg: string,
  paper: string | null,
  config: PlotCardConfig,
  vars: PlotCardVars,
): string {
  if (!config.enabled) return svg

  const fields: PlotCardField[] = config.content ?? DEFAULT_PLOT_CARD.content!
  const fontSizeMm = config.fontSizeMm ?? 3
  const position   = config.position ?? 'bottom-margin'

  // Build the card text: "Title  ·  2026-04-13  ·  seed: 0x4a2f  ·  3/20  ·  fineliner"
  const parts: string[] = []
  for (const field of fields) {
    const text = renderField(field, vars)
    if (text) parts.push(text)
  }
  if (parts.length === 0) return svg

  const cardText = parts.join('  ·  ')

  // Resolve paper dimensions
  const paperMm = paper ? parsePaperSize(paper) : null
  const paperW = paperMm?.width ?? 297
  const paperH = paperMm?.height ?? 210

  const textW = hersheyTextWidth(cardText, fontSizeMm)
  const margin = 5  // mm from paper edge

  // Position
  const x = (position === 'top-margin')
    ? margin
    : Math.min(margin, (paperW - textW) / 2)

  const y = (position === 'top-margin')
    ? margin
    : paperH - margin - fontSizeMm

  const pathData = hersheyText(cardText, x, y, fontSizeMm)

  const cardGroup = [
    `  <g id="nib-plot-card" inkscape:label="plot-card" fill="none" stroke="#000" stroke-width="0.3">`,
    `    <path d="${pathData}"/>`,
    `  </g>`,
  ].join('\n')

  // Inject before </svg>
  return svg.replace(/<\/svg\s*>/, `\n${cardGroup}\n</svg>`)
}

// ─── Field renderer ───────────────────────────────────────────────────────────

function renderField(field: PlotCardField, vars: PlotCardVars): string {
  switch (field) {
    case 'title':
      return vars.title ?? ''

    case 'date': {
      const d = vars.date ?? new Date().toISOString().slice(0, 10)
      return d
    }

    case 'seed': {
      if (vars.seed === undefined) return ''
      return `seed: 0x${vars.seed.toString(16).padStart(4, '0')}`
    }

    case 'edition':
      return vars.edition ?? ''

    case 'profile':
      return vars.profile ?? ''

    case 'duration':
      return vars.duration ?? ''

    default:
      return ''
  }
}

// ─── Config helpers ───────────────────────────────────────────────────────────

/**
 * Build PlotCardVars from a job context.
 */
export function buildPlotCardVars(opts: {
  file: string | null
  profile: ResolvedProfile
  seed?: number
  seriesIndex?: number
  seriesTotal?: number
  durationS?: number
}): PlotCardVars {
  const title = opts.file
    ? opts.file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
    : undefined

  const edition = (opts.seriesIndex !== undefined && opts.seriesTotal !== undefined)
    ? `${opts.seriesIndex}/${opts.seriesTotal}`
    : undefined

  const duration = opts.durationS !== undefined
    ? formatDuration(opts.durationS)
    : undefined

  return {
    title,
    profile: opts.profile.name,
    seed: opts.seed,
    edition,
    duration,
  }
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}
