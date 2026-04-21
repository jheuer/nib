/**
 * p5-nib flow-field example.
 *
 * Seeds a simplex-noise-ish flow field, drops particles at random start
 * points, integrates short trails, captures each trail as a nib stroke
 * via `nibCapture`. Click **Plot** to stream captured strokes to the
 * connected AxiDraw; click **Regenerate** for a new composition.
 *
 * This is instance-mode p5 (created via `new p5(sketch)` at the bottom),
 * so it never pollutes globals — friendlier to host inside real apps.
 */

import {
  LivePlotter,
  requestEbbPort,
  resolveEnvelope,
  renderPreview,
  strokesToMoves,
  type Profile,
} from '../../../src/browser.ts'
import { nibCapture, type NibCapture } from './p5-nib.ts'

// Declare the global p5 constructor loaded via CDN script tag.
declare const p5: new (
  sketchFn: (p: unknown) => void,
  host: HTMLElement,
) => { remove(): void }

// ── Paper sizes ──────────────────────────────────────────────────────────────

type PaperKey = 'A4-p' | 'A4-l' | 'A3-p' | 'A3-l'
const PAPER_MM: Record<PaperKey, { w: number; h: number }> = {
  'A4-p': { w: 210, h: 297 },
  'A4-l': { w: 297, h: 210 },
  'A3-p': { w: 297, h: 420 },
  'A3-l': { w: 420, h: 297 },
}

// Scale down for A3 so the canvas stays a reasonable screen size.
function pxPerMm(paper: { w: number; h: number }): number {
  return Math.max(paper.w, paper.h) <= 297 ? 3 : 2
}

// ── Sketch constants ─────────────────────────────────────────────────────────

const MARGIN_MM   = 10
const STEP_MM     = 0.6
const MAX_STEPS   = 220
const FIELD_SCALE = 0.007
const PARTICLES   = 180

// ── Profile ──────────────────────────────────────────────────────────────────

const profile: Profile & { name?: string } = {
  name: 'live',
  speedPendown: 25,
  speedPenup:   50,
  penPosDown:   35,
  penPosUp:     55,
  accel:        40,
}

// ── State ────────────────────────────────────────────────────────────────────

let plotter: LivePlotter | null = null
let capture: NibCapture  | null = null
let p5Instance: { remove(): void } | null = null
let seed = Math.random() * 10000

// ── DOM ──────────────────────────────────────────────────────────────────────

const statusEl      = document.getElementById('status')         as HTMLDivElement
const countEl       = document.getElementById('count')          as HTMLSpanElement
const paperEl       = document.getElementById('paper')          as HTMLSelectElement
const connectBtn    = document.getElementById('connect')        as HTMLButtonElement
const plotBtn       = document.getElementById('plot')           as HTMLButtonElement
const homeBtn       = document.getElementById('home')           as HTMLButtonElement
const releaseBtn    = document.getElementById('release')        as HTMLButtonElement
const liftBtn       = document.getElementById('lift')           as HTMLButtonElement
const closeBtn      = document.getElementById('close')          as HTMLButtonElement
const previewCanvas = document.getElementById('preview-canvas') as HTMLCanvasElement
const previewStats  = document.getElementById('preview-stats')  as HTMLSpanElement
const showTravelEl  = document.getElementById('show-travel')    as HTMLInputElement

function setStatus(msg: string, kind: 'ok' | 'busy' | 'error' | '' = '') {
  statusEl.textContent = msg
  statusEl.className = 'status' + (kind ? ' ' + kind : '')
}

function drawPreview() {
  const strokes = capture?.strokes() ?? []
  const paper = PAPER_MM[paperEl.value as PaperKey]
  // Match preview canvas width to sketch canvas; height proportional to paper.
  const w = paper.w <= 297 ? 630 : 900
  const h = Math.round(w * (paper.h / paper.w))
  previewCanvas.width  = w
  previewCanvas.height = h
  previewCanvas.style.width  = w + 'px'
  previewCanvas.style.height = h + 'px'

  const moves = strokesToMoves(strokes.map(pts => ({ points: pts })))
  const ctx = previewCanvas.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  const stats = renderPreview(moves, ctx, {
    paper: { widthMm: paper.w, heightMm: paper.h },
    paddingPx: 20,
    inkColor: '#1a1a1a',
    nibSizeMm: 0.35,
    showTravel: showTravelEl.checked,
  })

  const etaStr = (s: number) => s >= 60
    ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
    : `${s}s`
  const pd = (stats.pendownM * 1000).toFixed(0)
  const tr = (stats.travelM  * 1000).toFixed(0)
  previewStats.textContent =
    `${stats.penLifts} strokes · ${pd} mm pendown · ${tr} mm travel` +
    (stats.travelOverheadPct !== null ? ` (${stats.travelOverheadPct}% travel)` : '')
  void etaStr  // ETA requires planner; shown if we add it later
}

// ── Sketch ───────────────────────────────────────────────────────────────────

function initSketch() {
  if (p5Instance) p5Instance.remove()
  capture = null
  countEl.textContent = '0'

  const paper = PAPER_MM[paperEl.value as PaperKey]
  const px    = pxPerMm(paper)

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sketchFn = (p: any) => {
    p.setup = () => {
      p.createCanvas(paper.w * px, paper.h * px)
      capture = nibCapture(p, { pxPerMm: px })
      p.noLoop()
      p.noiseSeed(seed)
      runField(p, paper, px)
    }
  }

  p5Instance = new p5(sketchFn, document.getElementById('sketch')!)
}

function runField(p: any, paper: { w: number; h: number }, px: number) {
  capture?.clear()
  p.background(253, 252, 247)
  p.stroke(20)
  p.strokeWeight(0.4 * px)
  p.noFill()

  const { w: W, h: H } = paper

  for (let i = 0; i < PARTICLES; i++) {
    let x = p.random(MARGIN_MM, W - MARGIN_MM)
    let y = p.random(MARGIN_MM, H - MARGIN_MM)
    p.beginShape()
    p.vertex(x * px, y * px)
    for (let s = 0; s < MAX_STEPS; s++) {
      const angle = p.noise(x * FIELD_SCALE, y * FIELD_SCALE) * Math.PI * 2
      x += Math.cos(angle) * STEP_MM
      y += Math.sin(angle) * STEP_MM
      if (x < MARGIN_MM || x > W - MARGIN_MM || y < MARGIN_MM || y > H - MARGIN_MM) break
      p.vertex(x * px, y * px)
    }
    p.endShape()
  }

  countEl.textContent = String(capture?.count() ?? 0)
  drawPreview()
}

// ── Controls ─────────────────────────────────────────────────────────────────

document.getElementById('regen')!.addEventListener('click', () => {
  seed = Math.random() * 10000
  initSketch()
})

paperEl.addEventListener('change', () => {
  initSketch()  // keep seed — same composition, new paper aspect
})

showTravelEl.addEventListener('change', drawPreview)

connectBtn.addEventListener('click', async () => {
  try {
    setStatus('opening port…', 'busy')
    const transport = await requestEbbPort()
    const paper = PAPER_MM[paperEl.value as PaperKey]
    plotter = new LivePlotter(transport, {
      profile,
      envelope: resolveEnvelope('V3A3') ?? { widthMm: paper.w, heightMm: paper.h },
    })
    await plotter.start()
    setStatus('connected', 'ok')
    connectBtn.disabled  = true
    plotBtn.disabled     = false
    homeBtn.disabled     = false
    releaseBtn.disabled  = false
    liftBtn.disabled     = false
    closeBtn.disabled    = false
  } catch (err) {
    console.error(err)
    setStatus((err as Error).message.slice(0, 50), 'error')
  }
})

plotBtn.addEventListener('click', async () => {
  if (!plotter || !capture) return
  const strokes = capture.strokes()
  setStatus(`plotting 0/${strokes.length}`, 'busy')
  let done = 0
  for (const s of strokes) {
    await plotter.drawStroke(s)
    done++
    setStatus(`plotting ${done}/${strokes.length}`, 'busy')
  }
  setStatus('done', 'ok')
})

homeBtn.addEventListener('click', async () => {
  if (!plotter) return
  setStatus('homing…', 'busy')
  try {
    await plotter.home()
    setStatus('idle', 'ok')
  } catch (err) {
    console.error(err)
    setStatus('home failed', 'error')
  }
})

releaseBtn.addEventListener('click', async () => {
  if (!plotter) return
  if (releaseBtn.textContent === 'Set Home') {
    setStatus('setting home…', 'busy')
    try {
      await plotter.reenableMotors()
      releaseBtn.textContent = 'Release Motors'
      homeBtn.disabled = false
      liftBtn.disabled = false
      setStatus('idle', 'ok')
    } catch (err) {
      console.error(err)
      setStatus('rearm failed', 'error')
    }
  } else {
    setStatus('motors released — move arm to home corner, then Set Home', 'busy')
    try {
      await plotter.releaseMotors()
      releaseBtn.textContent = 'Set Home'
      homeBtn.disabled = true
      liftBtn.disabled = true
    } catch (err) {
      console.error(err)
      setStatus('release failed', 'error')
    }
  }
})

liftBtn.addEventListener('click', async () => {
  if (!plotter) return
  setStatus('lifting pen…', 'busy')
  try {
    await plotter.liftPen()
    setStatus('idle', 'ok')
  } catch (err) {
    console.error(err)
    setStatus('lift failed', 'error')
  }
})

closeBtn.addEventListener('click', async () => {
  if (!plotter) return
  setStatus('closing…', 'busy')
  try {
    await plotter.close()
    plotter = null
    setStatus('disconnected', '')
    connectBtn.disabled  = false
    plotBtn.disabled     = true
    homeBtn.disabled     = true
    releaseBtn.disabled  = true
    releaseBtn.textContent = 'Release Motors'
    liftBtn.disabled     = true
    closeBtn.disabled    = true
  } catch (err) {
    console.error(err)
    setStatus('close failed', 'error')
  }
})

if (!('serial' in navigator)) {
  setStatus('WebSerial unsupported — use Chrome/Edge', 'error')
  connectBtn.disabled = true
}

// ── Init ─────────────────────────────────────────────────────────────────────

initSketch()
