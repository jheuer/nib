import { spawn, type ChildProcess } from 'child_process'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse as parseSvg } from 'svgson'
import type { PlotBackend } from './interface.ts'
import type { Job } from '../core/job.ts'
import { PlotEmitter } from '../core/events.ts'

// ─── Flag translation ─────────────────────────────────────────────────────────

export function jobToAxicliFlags(job: Job, mode: 'plot' | 'preview' = 'plot'): string[] {
  const p = job.profile
  const flags: string[] = [
    '--speed_pendown', String(p.speedPendown),
    '--speed_penup',   String(p.speedPenup),
    '--pen_pos_down',  String(p.penPosDown),
    '--pen_pos_up',    String(p.penPosUp),
    '--accel',         String(p.accel),
    '--reordering',    String(job.optimize),
  ]
  if (p.constSpeed) flags.push('--const_speed')
  if (mode === 'preview') flags.push('--preview')
  return flags
}

// ─── SVG stats (fast, no subprocess) ─────────────────────────────────────────

export interface SvgStats {
  pathCount: number       // total drawable elements
  layerIds: number[]      // Inkscape layer IDs found
  viewBox: { x: number; y: number; width: number; height: number } | null
  widthMm: number | null
  heightMm: number | null
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
      // Inkscape layer IDs are like "layer1" or just a number
      const num = parseInt(id.replace(/\D/g, ''), 10)
      if (!isNaN(num)) layerIds.push(num)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)

  // Parse viewBox
  const vb = root.attributes['viewBox']
  let viewBox: SvgStats['viewBox'] = null
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
    }
  }

  // Parse width/height with unit conversion
  const widthMm  = parseMmAttr(root.attributes['width'])
  const heightMm = parseMmAttr(root.attributes['height'])

  return { pathCount, layerIds, viewBox, widthMm, heightMm }
}

function parseMmAttr(val: string | undefined): number | null {
  if (!val) return null
  const m = val.match(/([\d.]+)(mm|cm|in|px)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  switch (m[2]) {
    case 'cm': return n * 10
    case 'in': return n * 25.4
    case 'px': return n * 0.264583  // 96dpi → mm
    default:   return n             // assume mm
  }
}

// ─── Preview stats ────────────────────────────────────────────────────────────

export interface PreviewStats {
  pendownM: number | null
  travelM: number | null
  travelOverheadPct: number | null
  estimatedS: number | null
  penLifts: number | null
  boundingBoxMm: { width: number; height: number } | null
  fitsA4: boolean | null
  fitsA3: boolean | null
  rawLines: string[]    // full axicli preview output for debugging
}

/**
 * Run axicli in preview mode and return parsed stats.
 * Does not touch hardware.
 */
export async function runPreview(svg: string, job: Job, options: { port?: string; layer?: number } = {}): Promise<PreviewStats> {
  const tmpSvg = join(tmpdir(), `nib-preview-${Date.now()}.svg`)
  await writeFile(tmpSvg, svg, 'utf-8')

  const flags = jobToAxicliFlags(job, 'preview')
  if (options.layer !== undefined) flags.push('--layer', String(options.layer))
  if (options.port) flags.push('--port', options.port)

  const lines: string[] = []
  try {
    await runAxicliProcess(['axicli', tmpSvg, ...flags], line => lines.push(line))
  } finally {
    await unlink(tmpSvg).catch(() => undefined)
  }

  return parsePreviewStats(lines)
}

function parsePreviewStats(lines: string[]): PreviewStats {
  const text = lines.join('\n')

  const pendownM  = extractFloat(text, /pen[-\s]*down\s+dist(?:ance)?\s*[:\s]+([\d.]+)\s*m/i)
  const travelM   = extractFloat(text, /travel\s+dist(?:ance)?\s*[:\s]+([\d.]+)\s*m/i)
  const overhead  = extractFloat(text, /\(([\d.]+)%\s+overhead\)/i)
  const penLifts  = extractInt(text, /pen\s+lifts?\s*[:\s]+(\d+)/i)
  const estS      = parseEstTime(text)

  // Bounding box: "180 × 240 mm" or "180x240 mm"
  const bbMatch = text.match(/([\d.]+)\s*[×x]\s*([\d.]+)\s*mm/i)
  const boundingBoxMm = bbMatch
    ? { width: parseFloat(bbMatch[1]), height: parseFloat(bbMatch[2]) }
    : null

  // Paper fit lines like "Fits on: A3 ✓  A4 ✗" or "A3: yes"
  const fitsA4 = parseFit(text, 'A4')
  const fitsA3 = parseFit(text, 'A3')

  return { pendownM, travelM, travelOverheadPct: overhead, estimatedS: estS, penLifts, boundingBoxMm, fitsA4, fitsA3, rawLines: lines }
}

function extractFloat(text: string, re: RegExp): number | null {
  const m = text.match(re)
  return m ? parseFloat(m[1]) : null
}

function extractInt(text: string, re: RegExp): number | null {
  const m = text.match(re)
  return m ? parseInt(m[1], 10) : null
}

function parseEstTime(text: string): number | null {
  // "6m 48s" or "6:48" or "408 seconds"
  const m1 = text.match(/est(?:imated)?\s+time\s*[:\s]+([\d]+)m\s*([\d]+)s/i)
  if (m1) return parseInt(m1[1]) * 60 + parseInt(m1[2])
  const m2 = text.match(/est(?:imated)?\s+time\s*[:\s]+([\d]+):([\d]+)/i)
  if (m2) return parseInt(m2[1]) * 60 + parseInt(m2[2])
  const m3 = text.match(/est(?:imated)?\s+time\s*[:\s]+([\d]+)\s*s(?:ec)?/i)
  if (m3) return parseInt(m3[1])
  return null
}

function parseFit(text: string, paper: string): boolean | null {
  const re = new RegExp(`${paper}[:\\s]+(yes|✓|true|no|✗|false)`, 'i')
  const m = text.match(re)
  if (!m) return null
  return /yes|✓|true/i.test(m[1])
}

// ─── AxicliBackend ────────────────────────────────────────────────────────────

export class AxicliBackend implements PlotBackend {
  private port?: string

  async connect(port: string): Promise<void> {
    this.port = port
  }

  async moveTo(x: number, y: number, _speed: number): Promise<void> {
    await this.runAxicli(['manual', '--walk_dist', `${x},${y}`])
  }

  async penUp(height: number, _rate: number): Promise<void> {
    await this.runAxicli(['manual', '--pen_up_position', String(height)])
  }

  async penDown(height: number, _rate: number): Promise<void> {
    await this.runAxicli(['manual', '--pen_down_position', String(height)])
  }

  async home(): Promise<void> {
    await this.runAxicli(['manual', '--walk_home'])
  }

  async disconnect(): Promise<void> {
    this.port = undefined
  }

  private async runAxicli(args: string[]): Promise<void> {
    const portArgs = this.port ? ['--port', this.port] : []
    await runAxicliProcess(['axicli', ...portArgs, ...args])
  }
}

// ─── Plot runner ──────────────────────────────────────────────────────────────

export interface PlotOptions {
  mode?: 'plot' | 'preview'
  layer?: number
  port?: string
}

export interface RunJobResult {
  stoppedAt: number    // 0–1 fraction; 1 = complete
  aborted: boolean
}

/**
 * Execute a job via axicli, emitting events on the provided emitter.
 * Pass a signal to support pause/abort mid-plot.
 */
export async function runJob(
  job: Job,
  emitter: PlotEmitter,
  options: PlotOptions = {},
  signal?: AbortSignal,
): Promise<RunJobResult> {
  const mode = options.mode ?? 'plot'
  const tmpSvg = join(tmpdir(), `nib-${job.id}-${Date.now()}.svg`)
  await writeFile(tmpSvg, job.svg, 'utf-8')

  const flags = jobToAxicliFlags(job, mode)
  if (options.layer !== undefined) flags.push('--layer', String(options.layer))
  if (options.port) flags.push('--port', options.port)

  let currentFraction = 0
  let child: ChildProcess | null = null

  // Wire abort signal to kill the subprocess
  let aborted = false
  const onAbort = () => {
    aborted = true
    child?.kill('SIGINT')  // axicli handles SIGINT gracefully (homes pen)
  }
  signal?.addEventListener('abort', onAbort)

  try {
    await runAxicliProcessWithHandle(
      ['axicli', tmpSvg, ...flags],
      (line) => parseAxicliOutput(line, emitter, (f) => { currentFraction = f }),
      (c) => { child = c },
    )
  } catch (err) {
    if (aborted) {
      emitter.emit('abort', currentFraction)
      return { stoppedAt: currentFraction, aborted: true }
    }
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await unlink(tmpSvg).catch(() => undefined)
  }

  return { stoppedAt: 1, aborted: false }
}

// ─── axicli subprocess ────────────────────────────────────────────────────────

function runAxicliProcess(args: string[], onLine?: (line: string) => void): Promise<void> {
  return runAxicliProcessWithHandle(args, onLine, () => undefined)
}

function runAxicliProcessWithHandle(
  args: string[],
  onLine: ((line: string) => void) | undefined,
  onChild: (child: ChildProcess) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args
    const child = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'pipe'] })
    onChild(child)

    let stderr = ''

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) onLine?.(line)
      }
    })

    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve()
      } else {
        reject(new Error(
          `axicli exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`
        ))
      }
    })

    child.on('error', (err) => {
      reject(new Error(
        `Failed to run axicli: ${err.message}\nIs axicli installed? (pip install axicli)`
      ))
    })
  })
}

// ─── Output parser ────────────────────────────────────────────────────────────

function parseAxicliOutput(
  line: string,
  emitter: PlotEmitter,
  onProgress: (fraction: number) => void,
): void {
  const progressMatch = line.match(/progress[:\s]+([\d.]+)%/i)
  if (progressMatch) {
    const fraction = parseFloat(progressMatch[1]) / 100
    onProgress(fraction)
    emitter.emit('progress', fraction, 0)
    return
  }

  // Some axicli versions emit "X% complete"
  const completeMatch = line.match(/([\d.]+)%\s+complete/i)
  if (completeMatch) {
    const fraction = parseFloat(completeMatch[1]) / 100
    onProgress(fraction)
    emitter.emit('progress', fraction, 0)
    return
  }

  if (/pen\s+down/i.test(line)) { emitter.emit('pen:down'); return }
  if (/pen\s+up/i.test(line))   { emitter.emit('pen:up');   return }
}
