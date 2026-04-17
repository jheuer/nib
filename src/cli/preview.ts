import { defineCommand } from 'citty'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import chalk from 'chalk'
import { resolveProfile, loadProjectConfig, getEffectiveEnvelope } from '../core/config.ts'
import { findFirstOutOfBounds } from '../core/envelope.ts'
import { svgToMoves } from '../backends/svg-to-moves.ts'
import { parseSvgLayers } from '../core/svg-layers.ts'
import { createJob } from '../core/job.ts'
import { getSvgStats } from '../backends/svg-stats.ts'
import { previewStatsFromSvg } from '../backends/ebb-preview.ts'
import { printError, formatDuration, formatDistance } from '../tui/output.ts'
import { applyPreprocessSteps } from '../core/preprocess.ts'
import { resolveAutoRotate } from '../core/auto-rotate.ts'
import '../tui/env.ts'

function expandPath(p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(2))
  return resolve(process.cwd(), p)
}

export const previewCmd = defineCommand({
  meta: { name: 'preview', description: 'Simulate a plot and report stats (no hardware)' },
  args: {
    file: {
      type: 'positional',
      description: 'SVG file (use /dev/stdin to read from a pipe)',
    },
    profile: {
      type: 'string',
      alias: 'P',
      description: 'Pen profile name (env: NIB_PROFILE)',
    },
    layer: {
      type: 'string',
      description: 'Preview a single layer (by number from inkscape:label prefix, or by id)',
    },
    'list-layers': {
      type: 'boolean',
      description: 'Print the discovered SVG layers and exit',
      default: false,
    },
    open: {
      type: 'boolean',
      description: 'Open a visual preview in the browser',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output stats as JSON',
      default: false,
    },
    optimize: {
      type: 'string',
      description: 'Path reordering: 0=adjacent 1=nearest 2=with-reversal',
      default: '0',
    },
    simplify: {
      type: 'string',
      description: 'Douglas-Peucker polyline simplification tolerance in mm (e.g. 0.2).',
    },
    rotate: {
      type: 'string',
      description: 'Rotate content before computing stats. "auto" (default) matches portrait SVGs to landscape machines. "none" disables; any number of degrees is also accepted.',
    },
    'hide-envelope': {
      type: 'boolean',
      description: 'Suppress the machine envelope + home marker overlay in --open preview (on by default when a machine is configured)',
      default: false,
    },
  },
  async run({ args }) {
    const profileName = args.profile ?? process.env.NIB_PROFILE
    const filePath = args.file

    // ── Read SVG ──────────────────────────────────────────────────────────────
    let svg: string
    if (filePath === '/dev/stdin') {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      svg = Buffer.concat(chunks).toString('utf-8')
    } else {
      const resolved = expandPath(filePath)
      if (!existsSync(resolved)) {
        printError(`file not found: ${filePath}`)
        process.exit(1)
      }
      svg = await readFile(resolved, 'utf-8')
    }

    // ── --list-layers: inspect + exit ────────────────────────────────────────
    if (args['list-layers']) {
      const layers = parseSvgLayers(svg)
      if (args.json) {
        process.stdout.write(JSON.stringify(layers, null, 2) + '\n')
        return
      }
      if (layers.length === 0) {
        process.stderr.write('  No Inkscape layers found.\n')
        return
      }
      process.stderr.write(`\n  ${layers.length} layer${layers.length === 1 ? '' : 's'} found\n\n`)
      const sorted = [...layers].sort((a, b) => a.id - b.id)
      const idWidth = Math.max(...sorted.map(l => String(l.id).length), 2)
      for (const l of sorted) {
        const num = String(l.id).padStart(idWidth)
        const flag = l.skip ? '  SKIP' : '      '
        process.stderr.write(`    #${num}${flag}  ${l.name || '(unnamed)'}\n`)
      }
      process.stderr.write('\n')
      return
    }

    // ── Fast local stats (no subprocess) ─────────────────────────────────────
    const svgStats = await getSvgStats(svg)

    // ── Resolve profile ───────────────────────────────────────────────────────
    let profile
    try {
      profile = await resolveProfile(profileName)
    } catch (err) {
      printError((err as Error).message, 'run: nib profile list')
      process.exit(1)
    }

    // ── Load project config & preprocess ─────────────────────────────────────
    const projectConfig = await loadProjectConfig()
    let processedSvg = svg
    if (projectConfig?.preprocess?.steps?.length) {
      processedSvg = applyPreprocessSteps(svg, projectConfig.preprocess.steps)
    }

    const optimizeRaw = parseInt(args.optimize, 10)
    const job = createJob({
      id: 0,
      svg: processedSvg,
      profile,
      optimize: ([0, 1, 2].includes(optimizeRaw) ? optimizeRaw : 0) as 0 | 1 | 2,
    })

    // ── Print header ──────────────────────────────────────────────────────────
    const name = filePath === '-' ? 'stdin' : (filePath.split('/').pop() ?? filePath)
    process.stderr.write(`\n  ${chalk.bold('nib preview')} — ${chalk.cyan(name)}\n`)
    process.stderr.write(`  ${chalk.dim('Profile:')}  ${profile.name} ${chalk.dim(`(${profile.speedPendown}% down · ${profile.speedPenup}% up)`)}\n\n`)

    // ── Compute stats from the planner (no hardware, no subprocess) ─────────
    const simplifyMm = args.simplify !== undefined
      ? parseFloat(args.simplify)
      : projectConfig?.simplifyMm
    // Resolve rotation (incl. axicli-style auto) using the machine envelope
    // and SVG's declared width/height.
    const envEarly = await getEffectiveEnvelope()
    let rotateDeg = 0
    try {
      const rot = resolveAutoRotate(args.rotate, {
        svgWidthMm:      svgStats.widthMm,
        svgHeightMm:     svgStats.heightMm,
        envelopeWidthMm:  envEarly?.envelope.widthMm  ?? null,
        envelopeHeightMm: envEarly?.envelope.heightMm ?? null,
      })
      rotateDeg = rot.degrees
      if (rot.auto && rot.degrees !== 0) {
        process.stderr.write(`  ${chalk.dim(`Auto-rotate:`)} ${rot.degrees}° (${rot.reason})\n\n`)
      }
    } catch (err) {
      printError((err as Error).message)
      process.exit(2)
    }
    const stats = previewStatsFromSvg(processedSvg, profile, job.optimize, simplifyMm, rotateDeg)

    if (args.json) {
      process.stdout.write(JSON.stringify({ ...stats, svgStats }, null, 2) + '\n')
      return
    }

    // ── Format stats output ───────────────────────────────────────────────────
    const rows: [string, string][] = []

    if (stats.pendownM !== null)
      rows.push(['Pen-down distance', chalk.white(`${formatDistance(stats.pendownM)}`)])

    if (stats.travelM !== null) {
      const overhead = stats.travelOverheadPct !== null
        ? chalk.dim(` (${stats.travelOverheadPct.toFixed(0)}% overhead)`)
        : ''
      rows.push(['Travel distance', `${formatDistance(stats.travelM)}${overhead}`])
    }

    if (stats.estimatedS !== null) {
      let hint = ''
      if (job.optimize === 0 && (stats.penLifts ?? 0) > 50) {
        hint = chalk.dim('  try --optimize 2 to reduce lifts')
      }
      rows.push(['Estimated time', `${chalk.white(formatDuration(stats.estimatedS))}${hint}`])
    }

    if (stats.penLifts !== null)
      rows.push(['Pen lifts', chalk.white(String(stats.penLifts))])

    if (stats.boundingBoxMm)
      rows.push(['Bounding box', chalk.white(`${stats.boundingBoxMm.width} × ${stats.boundingBoxMm.height} mm`)])

    // Paper fit
    const fits: string[] = []
    if (stats.fitsA4 !== null) fits.push(stats.fitsA4 ? chalk.green('A4 ✓') : chalk.dim('A4 ✗'))
    if (stats.fitsA3 !== null) fits.push(stats.fitsA3 ? chalk.green('A3 ✓') : chalk.dim('A3 ✗'))
    if (fits.length) rows.push(['Fits on', fits.join('  ')])

    // Machine envelope — the physical arm travel limit, minus the configured
    // safety margin (`margin_mm` in axidraw.toml, default 5mm).
    const eff = envEarly
    if (eff) {
      const rawEnv = svgToMoves(processedSvg, { tolerance: 0.1 })
      const moves = rotateDeg ? (await import('../core/stroke.ts')).rotateMoves(rawEnv, rotateDeg) : rawEnv
      const offender = findFirstOutOfBounds(moves, eff.envelope, eff.marginMm)
      const safeW = eff.envelope.widthMm  - 2 * eff.marginMm
      const safeH = eff.envelope.heightMm - 2 * eff.marginMm
      const label = eff.marginMm > 0
        ? `${safeW} × ${safeH} mm safe (envelope ${eff.envelope.widthMm} × ${eff.envelope.heightMm}, ${eff.marginMm}mm margin)`
        : `${eff.envelope.widthMm} × ${eff.envelope.heightMm} mm`
      if (offender) {
        rows.push([
          'Machine',
          `${chalk.red('✗ exceeds ' + label)} ${chalk.dim(`(at ${offender.point.x.toFixed(1)}, ${offender.point.y.toFixed(1)})`)}`,
        ])
      } else {
        rows.push(['Machine', `${chalk.green('✓ fits ' + label)}`])
      }
    }

    // Always show element count from SVG parsing
    rows.push(['Elements', chalk.dim(String(svgStats.pathCount))])

    // Show SVG dimensions from parsing when planner had no bounding box
    if (!stats.boundingBoxMm && svgStats.widthMm && svgStats.heightMm) {
      rows.push(['Size (SVG)', chalk.dim(`${svgStats.widthMm} × ${svgStats.heightMm} mm`)])
    }

    const labelWidth = Math.max(...rows.map(([l]) => l.length))
    for (const [label, value] of rows) {
      process.stderr.write(`  ${chalk.dim(label.padEnd(labelWidth))}   ${value}\n`)
    }
    process.stderr.write('\n')

    // ── Open browser preview ──────────────────────────────────────────────────
    if (args.open) {
      await openBrowserPreview(processedSvg, name, {
        nibSizeMm: profile.nibSizeMm,
        color: profile.color,
        contentWidthMm:  svgStats.widthMm,
        contentHeightMm: svgStats.heightMm,
        envelope: args['hide-envelope'] ? undefined : envEarly?.envelope,
        marginMm: args['hide-envelope'] ? undefined : envEarly?.marginMm,
        rotateDeg,
      })
    }
  },
})

interface PreviewOpts {
  nibSizeMm?: number
  color?: string
  contentWidthMm: number | null
  contentHeightMm: number | null
  envelope?: { widthMm: number; heightMm: number }
  marginMm?: number
  rotateDeg: number
}

/**
 * Generate an HTML wrapper around the SVG that renders strokes at realistic
 * nib width, in the profile's ink colour, and (when a machine envelope is
 * configured) inside an outline of the machine envelope + safety margin + home
 * corner marker — so the user can see fit, orientation, and home placement
 * before committing to paper.
 */
async function openBrowserPreview(
  svg: string, name: string, opts: PreviewOpts,
): Promise<void> {
  // Path styling: profile-supplied ink colour + realistic nib width. Applied
  // via CSS to every geometry element inside the user's SVG. Default ink is
  // black (matches the plotter output when no profile colour is configured).
  const ink = opts.color ?? '#000'
  const pathStyle = opts.nibSizeMm
    ? `stroke:${ink}; stroke-width:${opts.nibSizeMm}mm; stroke-linecap:round; stroke-linejoin:round; fill:none`
    : `stroke:${ink}; stroke-linecap:round; stroke-linejoin:round; fill:none`

  // The inner <svg> needs explicit width/height in mm so nested viewport
  // resolution lines up with the envelope (outer) viewBox, which is in mm.
  // When the author omits width/height, we fall back to the content bbox.
  const cw = opts.contentWidthMm  ?? 210
  const ch = opts.contentHeightMm ?? 297

  // If rotation will apply at plot time, show the content rotated — that's
  // what the user is actually going to get on paper. Rotate around origin
  // then translate the post-rotation bbox back to (0,0) (same transform the
  // moves pipeline applies).
  const { rotateTransform, rotatedW, rotatedH } = rotationTransform(cw, ch, opts.rotateDeg)

  const envW = opts.envelope?.widthMm  ?? rotatedW
  const envH = opts.envelope?.heightMm ?? rotatedH
  const showEnvelope = !!opts.envelope
  const margin = opts.marginMm ?? 0

  // Envelope outline + dashed margin inset + home corner marker + gantry/
  // traverse schematic. AxiDraw convention: +X runs along the long rails
  // (the gantry beam slides along X), +Y runs along the gantry beam (the
  // pen carriage slides along Y). The schematic shows the gantry beam in
  // its home position at X=0 with an arrow indicating the gantry's travel
  // direction and the pen carriage shown on the beam at Y=0.
  //
  // Drawn BEHIND the user content (appears before it in document order) so
  // plotted strokes always render on top — the schematic is decoration,
  // not content.
  // AxiDraw mechanical schematic, to-scale with the envelope. Modeled on the
  // SE/A3 layout:
  //   - A long horizontal base rail below the page carrying the gantry beam
  //     along +X. The home-end (control box + stepper) sits at X=0 and is
  //     labelled "Home"; a smaller idler bracket closes the far end.
  //   - The gantry beam itself crosses the page vertically at X=0 (its home
  //     position) and carries the pen carriage along +Y.
  //   - The pen carriage starts at (0,0) on the beam.
  // Soft blue-grey stroke so the schematic sits clearly behind the user's
  // content — it's a spatial reference, not the subject.
  const rail = '#c8d4e5'
  const railDark = '#8ba1bd'
  const homeBlockW = 16  // mm — home-end control box
  const homeBlockH = 10
  const farBlockW = 6    // mm — idler bracket at opposite end
  const farBlockH = 8
  const railY = envH + 6
  const gantryOverlay = showEnvelope ? `
    <!-- Base rail: long strip running along +X below the envelope -->
    <g stroke="${rail}" fill="none" stroke-linecap="round">
      <line x1="${homeBlockW}" y1="${railY}" x2="${envW - farBlockW}" y2="${railY}" stroke-width="0.6"/>
      <line x1="${homeBlockW}" y1="${railY + 1.5}" x2="${envW - farBlockW}" y2="${railY + 1.5}" stroke-width="0.3" stroke-dasharray="1,0.8"/>
    </g>
    <!-- Home-end: control box + stepper block at X=0 -->
    <g>
      <rect x="${-homeBlockW + 0}" y="${railY - homeBlockH / 2}" width="${homeBlockW}" height="${homeBlockH}" fill="${railDark}" stroke="none" rx="0.5"/>
      <text x="${-homeBlockW / 2}" y="${railY + 1}" text-anchor="middle" font-family="sans-serif" font-size="2.4" fill="white">Home</text>
    </g>
    <!-- Far-end idler bracket at X=envW -->
    <rect x="${envW}" y="${railY - farBlockH / 2}" width="${farBlockW}" height="${farBlockH}" fill="${railDark}" stroke="none" rx="0.5"/>
    <!-- Gantry beam: vertical bar at current home X=0 crossing the page -->
    <g stroke="${railDark}" fill="none">
      <line x1="0" y1="-2" x2="0" y2="${envH + 2}" stroke-width="1.4"/>
      <!-- beam end-cap at the base-rail side, sits on the rail -->
      <rect x="-3" y="${envH + 2}" width="6" height="${railY - envH - 2 + 0.5}" fill="${railDark}" stroke="none" rx="0.3"/>
    </g>
    <!-- Pen carriage at (0,0) on the beam -->
    <rect x="-2.6" y="-2.6" width="5.2" height="5.2" fill="${railDark}" stroke="none" rx="0.3"/>
    <!-- Travel arrows -->
    <g stroke="${railDark}" stroke-width="0.4" fill="none">
      <g transform="translate(${envW * 0.5}, ${railY + 10})">
        <line x1="-14" y1="0" x2="14" y2="0"/>
        <line x1="14" y1="0" x2="11" y2="-1.5"/>
        <line x1="14" y1="0" x2="11" y2="1.5"/>
        <line x1="-14" y1="0" x2="-11" y2="-1.5"/>
        <line x1="-14" y1="0" x2="-11" y2="1.5"/>
      </g>
      <g transform="translate(${envW + 10}, ${envH * 0.5}) rotate(90)">
        <line x1="-14" y1="0" x2="14" y2="0"/>
        <line x1="14" y1="0" x2="11" y2="-1.5"/>
        <line x1="14" y1="0" x2="11" y2="1.5"/>
        <line x1="-14" y1="0" x2="-11" y2="-1.5"/>
        <line x1="-14" y1="0" x2="-11" y2="1.5"/>
      </g>
    </g>
    <g font-family="sans-serif" font-size="2.6" fill="${railDark}">
      <text x="${envW * 0.5}" y="${railY + 14}" text-anchor="middle">gantry travel · X</text>
      <text x="${envW + 14}" y="${envH * 0.5}" text-anchor="middle" transform="rotate(90 ${envW + 14} ${envH * 0.5})">pen travel · Y</text>
    </g>
  ` : ''

  const envelopeOverlay = showEnvelope ? `
    <rect x="0" y="0" width="${envW}" height="${envH}" fill="white" stroke="#999" stroke-width="0.3"/>
    ${margin > 0 ? `<rect x="${margin}" y="${margin}" width="${envW - 2 * margin}" height="${envH - 2 * margin}" fill="none" stroke="#c8c8c8" stroke-dasharray="1.5,1" stroke-width="0.2"/>` : ''}
    ${gantryOverlay}
    <g stroke="#d33" stroke-width="0.25" fill="none">
      <circle cx="0" cy="0" r="1.5"/>
      <line x1="-3" y1="0" x2="3" y2="0"/>
      <line x1="0" y1="-3" x2="0" y2="3"/>
    </g>
    <text x="3.5" y="4.5" font-family="sans-serif" font-size="3.5" fill="#d33">home (0,0)</text>
  ` : ''

  // Extract the user's SVG body (everything between <svg> and </svg>) so we
  // can nest it inside the outer envelope SVG. The outer SVG owns the mm
  // viewport; the inner container owns the author's original viewBox.
  const userInner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const userViewBoxMatch = svg.match(/viewBox\s*=\s*"([^"]+)"/)
  const userViewBox = userViewBoxMatch ? userViewBoxMatch[1] : `0 0 ${cw} ${ch}`

  // When the envelope overlay is on, pad the outer viewBox enough to fit the
  // home-block extension (left), the schematic rail + arrows (below), and the
  // Y-axis label (right).
  const pad = showEnvelope ? 26 : 0
  const composite = `<svg xmlns="http://www.w3.org/2000/svg"
       viewBox="${showEnvelope ? `${-pad} ${-pad} ${envW + 2 * pad} ${envH + 2 * pad}` : `0 0 ${rotatedW} ${rotatedH}`}"
       width="${showEnvelope ? envW + 2 * pad : rotatedW}mm"
       height="${showEnvelope ? envH + 2 * pad : rotatedH}mm"
       style="max-width:90vw;max-height:90vh">
    ${envelopeOverlay}
    <g class="user-content" transform="${rotateTransform}">
      <svg x="0" y="0" width="${cw}" height="${ch}" viewBox="${userViewBox}" preserveAspectRatio="xMinYMin meet">
        ${userInner}
      </svg>
    </g>
  </svg>`

  const legend = showEnvelope
    ? `envelope ${envW}×${envH}mm${margin > 0 ? ` · ${margin}mm margin` : ''}`
    : `content ${Math.round(rotatedW)}×${Math.round(rotatedH)}mm`

  const previewHtml = `<!DOCTYPE html>
<html>
<head>
  <title>nib preview — ${name}</title>
  <style>
    body { background: #f5f0e8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; font-family: system-ui, sans-serif; }
    svg { border: 1px solid #ccc; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    /* Scope path styling to the nested user content only — the envelope rect
       and schematic live in the outer SVG and must keep their own fills. */
    .user-content path, .user-content polyline, .user-content line,
    .user-content polygon, .user-content circle, .user-content ellipse,
    .user-content rect { ${pathStyle}; }
    .legend { position: fixed; bottom: 1rem; right: 1rem; font-family: ui-monospace, monospace; font-size: 12px; color: #666; text-align: right; line-height: 1.4; }
    .legend .title { color: #333; }
  </style>
</head>
<body>
  ${composite}
  <div class="legend">
    <div class="title">nib preview — ${name}</div>
    <div>${legend}</div>
    ${opts.nibSizeMm ? `<div>${opts.nibSizeMm}mm nib${opts.color ? ` · ${opts.color}` : ''}</div>` : ''}
    ${opts.rotateDeg ? `<div>rotated ${opts.rotateDeg}°</div>` : ''}
  </div>
</body>
</html>`

  const tmpPath = join(tmpdir(), `nib-preview-${Date.now()}.html`)
  await writeFile(tmpPath, previewHtml, 'utf-8')

  const { spawn } = await import('child_process')
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  spawn(opener, [tmpPath], { detached: true, stdio: 'ignore' }).unref()
  process.stderr.write(`  ${chalk.dim(`Opened: ${tmpPath}`)}\n\n`)
}

/**
 * Compute an SVG transform string that rotates content by `deg` around the
 * origin and translates the post-rotation bbox back to (0,0) — matching the
 * behaviour of `rotateMoves` in src/core/stroke.ts so the preview reflects
 * what the plot will actually produce. Returns the new bbox dimensions too.
 */
function rotationTransform(w: number, h: number, deg: number): {
  rotateTransform: string
  rotatedW: number
  rotatedH: number
} {
  const normDeg = ((deg % 360) + 360) % 360
  if (normDeg === 0) {
    return { rotateTransform: '', rotatedW: w, rotatedH: h }
  }
  const theta = (normDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  // Corners of the unrotated box (0,0)-(w,h), rotated around origin.
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [x * cos - y * sin, x * sin + y * cos])
  const minX = Math.min(...pts.map(p => p[0]))
  const minY = Math.min(...pts.map(p => p[1]))
  const maxX = Math.max(...pts.map(p => p[0]))
  const maxY = Math.max(...pts.map(p => p[1]))
  return {
    rotateTransform: `translate(${-minX} ${-minY}) rotate(${normDeg})`,
    rotatedW: maxX - minX,
    rotatedH: maxY - minY,
  }
}
