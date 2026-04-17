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
  type Profile,
} from '../../../src/browser.ts'
import { nibCapture, type NibCapture } from './p5-nib.ts'

// Declare the global p5 constructor loaded via CDN script tag.
declare const p5: new (sketchFn: (p: unknown) => void, host: HTMLElement) => unknown

// ── Constants ───────────────────────────────────────────────────────────────

const PAPER_MM = { w: 297, h: 210 }  // A4 landscape
const PX_PER_MM = 3                  // canvas scale
const MARGIN_MM = 10
const STEP_MM   = 0.6
const MAX_STEPS = 220
const FIELD_SCALE = 0.007
const PARTICLES = 180

const profile: Profile & { name?: string } = {
  name: 'live',
  speedPendown: 25,
  speedPenup:   50,
  penPosDown:   35,
  penPosUp:     55,
  accel:        40,
}

// ── Global state (per page instance) ────────────────────────────────────────

let plotter: LivePlotter | null = null
let capture: NibCapture | null = null
let seed = Math.random() * 10000

const statusEl = document.getElementById('status') as HTMLDivElement
const countEl  = document.getElementById('count')  as HTMLSpanElement
function setStatus(msg: string, kind: 'ok' | 'busy' | 'error' | '' = '') {
  statusEl.textContent = msg
  statusEl.className = 'status' + (kind ? ' ' + kind : '')
}

// ── The p5 sketch ───────────────────────────────────────────────────────────

// Narrow helper type for the p5 primitives we use. p5 itself has no types
// distributed here so we reach for `any` for simplicity in the sketch.
/* eslint-disable @typescript-eslint/no-explicit-any */

const sketch = (p: any) => {
  p.setup = () => {
    p.createCanvas(PAPER_MM.w * PX_PER_MM, PAPER_MM.h * PX_PER_MM)
    capture = nibCapture(p, { pxPerMm: PX_PER_MM })
    p.noLoop()
    p.noiseSeed(seed)
    redrawField(p)
  }

  p.redrawField = () => redrawField(p)
}

function redrawField(p: any) {
  capture?.clear()
  p.background(253, 252, 247)
  p.stroke(20)
  p.strokeWeight(0.4 * PX_PER_MM)
  p.noFill()

  const px = PX_PER_MM
  const W = PAPER_MM.w, H = PAPER_MM.h

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
}

new p5(sketch, document.getElementById('sketch')!)

// ── Controls ────────────────────────────────────────────────────────────────

document.getElementById('regen')!.addEventListener('click', () => {
  seed = Math.random() * 10000
  const inst = (window as any)._p5Instance
  // Grab the instance via p5's internal mechanism — instance-mode p5 doesn't
  // expose it nicely, so we just call redrawField on the sketch's p by
  // locating the canvas's owner. Simplest: reload the canvas.
  void inst
  // We stored the redraw function on the p instance as `redrawField`. Call
  // it through the most accessible path — find the p5 canvas and its parent.
  const ev = new Event('regen-request')
  window.dispatchEvent(ev)
})

// Alternative hook: listen for regen-request and re-run from within sketch.
// (Wired via the p.redrawField above — but to keep this demo simple and
// avoid fishing for the p5 instance, re-instantiate on regen.)
window.addEventListener('regen-request', () => {
  const host = document.getElementById('sketch')!
  host.innerHTML = ''
  new p5(sketch, host)
})

document.getElementById('connect')!.addEventListener('click', async () => {
  try {
    setStatus('opening port…', 'busy')
    const transport = await requestEbbPort()
    plotter = new LivePlotter(transport, {
      profile,
      envelope: resolveEnvelope('V3A3') ?? undefined,
    })
    await plotter.start()
    setStatus('connected', 'ok')
    ;(document.getElementById('plot') as HTMLButtonElement).disabled = false
    ;(document.getElementById('home') as HTMLButtonElement).disabled = false
  } catch (err) {
    console.error(err)
    setStatus((err as Error).message.slice(0, 50), 'error')
  }
})

document.getElementById('plot')!.addEventListener('click', async () => {
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

document.getElementById('home')!.addEventListener('click', async () => {
  if (!plotter) return
  setStatus('homing…', 'busy')
  await plotter.end()
  plotter = null
  ;(document.getElementById('plot') as HTMLButtonElement).disabled = true
  ;(document.getElementById('home') as HTMLButtonElement).disabled = true
  setStatus('homed · disconnected', '')
})

if (!('serial' in navigator)) {
  setStatus('WebSerial unsupported — use Chrome/Edge', 'error')
  ;(document.getElementById('connect') as HTMLButtonElement).disabled = true
}
