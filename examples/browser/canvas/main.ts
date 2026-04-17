/**
 * nib live-canvas demo.
 *
 * Draws a to-scale page inside a canvas. Mouse / pen strokes stream to a
 * connected AxiDraw via WebSerial; each stroke plots as it's completed.
 */

import {
  LivePlotter,
  requestEbbPort,
  resolveEnvelope,
  type Profile,
  type Envelope,
} from '../../../src/browser.ts'

// ─── Paper + scale setup ─────────────────────────────────────────────────────

type PaperKey = 'A4-p' | 'A4-l' | 'A3-p' | 'A3-l'
const PAPER_MM: Record<PaperKey, { w: number; h: number }> = {
  'A4-p': { w: 210, h: 297 },
  'A4-l': { w: 297, h: 210 },
  'A3-p': { w: 297, h: 420 },
  'A3-l': { w: 420, h: 297 },
}

// ─── State ───────────────────────────────────────────────────────────────────

const canvas  = document.getElementById('pad') as HTMLCanvasElement
const paperEl = document.getElementById('paper') as HTMLSelectElement
const connectBtn = document.getElementById('connect') as HTMLButtonElement
const clearBtn   = document.getElementById('clear')   as HTMLButtonElement
const homeBtn    = document.getElementById('home')    as HTMLButtonElement
const closeBtn   = document.getElementById('close')   as HTMLButtonElement
const statusEl   = document.getElementById('status')  as HTMLDivElement
const legendEl   = document.getElementById('legend')  as HTMLDivElement
const ctx = canvas.getContext('2d')!

let paper: PaperKey = (paperEl.value as PaperKey)
let mmPerPx = 1   // recomputed on resize / paper change
let plotter: LivePlotter | null = null
let drawing = false
let currentStroke: { x: number; y: number }[] = []
const historyStrokes: { x: number; y: number }[][] = []

// Default profile — users can tune these for their pen.
const profile: Profile & { name?: string; nibSizeMm?: number; color?: string } = {
  name: 'live',
  speedPendown: 25,
  speedPenup:   50,
  penPosDown:   35,
  penPosUp:     55,
  accel:        40,
  nibSizeMm:    0.3,
  color:        '#111',
}

// ─── Layout / rendering ──────────────────────────────────────────────────────

function layoutCanvas() {
  // Stage at fixed CSS size (900×600). Compute mm-per-pixel so the paper fills
  // the stage with padding for the machine schematic around the page.
  const stageW = 900
  const stageH = 600
  const pad = 60   // px of schematic padding around the page

  const sel = PAPER_MM[paper]
  const paperW = sel.w
  const paperH = sel.h
  const scaleW = (stageW - pad * 2) / paperW
  const scaleH = (stageH - pad * 2) / paperH
  const pxPerMm = Math.min(scaleW, scaleH)
  mmPerPx = 1 / pxPerMm

  const dpr = window.devicePixelRatio || 1
  canvas.width  = stageW * dpr
  canvas.height = stageH * dpr
  canvas.style.width  = stageW + 'px'
  canvas.style.height = stageH + 'px'
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // Establish an origin-centered coordinate system in *page mm*, with (0,0)
  // at the home corner of the paper, which sits inside the padded stage.
  ctx.translate(pad, pad)
  ctx.scale(pxPerMm, pxPerMm)

  drawPaper()
  redrawAllStrokes()
}

function drawPaper() {
  ctx.save()
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0)
  ctx.fillStyle = '#fdfcf7'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.restore()

  const sel = PAPER_MM[paper]

  // Schematic: black gantry rail below the page, silver traverse arm at X=0.
  ctx.save()
  ctx.fillStyle = '#1c1c1c'
  ctx.fillRect(-18, sel.h + 8, sel.w + 24, 14)
  ctx.fillStyle = '#fff'
  ctx.font = `2.8px system-ui`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('Home', -9, sel.h + 15)
  // Silver arm at X=0
  ctx.fillStyle = '#d5d8dc'
  ctx.strokeStyle = '#8a8e94'
  ctx.lineWidth = 0.2
  ctx.fillRect(-5, -4, 10, sel.h + 4 + (22))
  ctx.strokeRect(-5, -4, 10, sel.h + 4 + (22))
  // Pen carriage at (0,0)
  ctx.fillStyle = '#8a8e94'
  ctx.fillRect(-6, -3, 12, 6)
  ctx.restore()

  // Paper rect with a thin border
  ctx.save()
  ctx.fillStyle = '#fdfcf7'
  ctx.strokeStyle = '#bbb'
  ctx.lineWidth = 0.2
  ctx.fillRect(0, 0, sel.w, sel.h)
  ctx.strokeRect(0, 0, sel.w, sel.h)
  ctx.restore()

  // Home cross in the corner
  ctx.save()
  ctx.strokeStyle = '#d33'
  ctx.lineWidth = 0.3
  ctx.beginPath()
  ctx.moveTo(-3, 0); ctx.lineTo(3, 0)
  ctx.moveTo(0, -3); ctx.lineTo(0, 3)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(0, 0, 1.5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  // Labels
  ctx.save()
  ctx.fillStyle = '#888'
  ctx.font = `3px system-ui`
  ctx.textAlign = 'center'
  ctx.fillText('+X · traverse along gantry rail', sel.w / 2, sel.h + 30)
  ctx.restore()
}

function redrawAllStrokes() {
  for (const s of historyStrokes) drawStrokePath(s, false)
  if (drawing && currentStroke.length > 1) drawStrokePath(currentStroke, true)
}

function drawStrokePath(points: { x: number; y: number }[], inProgress: boolean) {
  if (points.length < 2) return
  ctx.save()
  ctx.strokeStyle = inProgress ? '#444' : profile.color ?? '#111'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = profile.nibSizeMm ?? 0.4
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  ctx.stroke()
  ctx.restore()
}

// ─── Pointer input → strokes ─────────────────────────────────────────────────

function pointerToMm(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const stageX = ev.clientX - rect.left
  const stageY = ev.clientY - rect.top
  // Inverse of the transform applied in layoutCanvas: subtract pad, multiply mmPerPx.
  const pad = 60
  return {
    x: (stageX - pad) * mmPerPx,
    y: (stageY - pad) * mmPerPx,
  }
}

function strokeInBounds(points: { x: number; y: number }[]): boolean {
  const sel = PAPER_MM[paper]
  for (const p of points) {
    if (p.x < 0 || p.y < 0 || p.x > sel.w || p.y > sel.h) return false
  }
  return true
}

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId)
  drawing = true
  currentStroke = [pointerToMm(ev)]
})

canvas.addEventListener('pointermove', (ev) => {
  if (!drawing) return
  const p = pointerToMm(ev)
  // Drop near-duplicate samples; the plotter doesn't need 1000 Hz.
  const last = currentStroke[currentStroke.length - 1]
  if (Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return
  currentStroke.push(p)
  drawPaper()
  redrawAllStrokes()
})

canvas.addEventListener('pointerup', async () => {
  if (!drawing) return
  drawing = false
  if (currentStroke.length < 2) return
  const stroke = currentStroke
  currentStroke = []
  historyStrokes.push(stroke)
  drawPaper()
  redrawAllStrokes()

  if (!plotter) return
  if (!strokeInBounds(stroke)) {
    setStatus('stroke out of bounds — skipped', 'error')
    return
  }
  setStatus('plotting…', 'busy')
  try {
    await plotter.drawStroke(stroke)
    setStatus('idle', 'ok')
  } catch (err) {
    console.error(err)
    setStatus('plot error — see console', 'error')
  }
})

document.addEventListener('keydown', (ev) => {
  if (ev.key === ' ') {
    historyStrokes.length = 0
    drawPaper()
  }
})

// ─── Control buttons ─────────────────────────────────────────────────────────

paperEl.addEventListener('change', () => {
  paper = paperEl.value as PaperKey
  layoutCanvas()
})

connectBtn.addEventListener('click', async () => {
  try {
    setStatus('opening serial port…', 'busy')
    const transport = await requestEbbPort()
    const sel = PAPER_MM[paper]
    const envelope: Envelope = resolveEnvelope('V3A3') ?? { widthMm: sel.w, heightMm: sel.h }
    plotter = new LivePlotter(transport, { profile, envelope })
    await plotter.start()
    setStatus('idle', 'ok')
    connectBtn.disabled = true
    clearBtn.disabled = false
    homeBtn.disabled  = false
    closeBtn.disabled = false
    legendEl.textContent = `pen ${profile.nibSizeMm}mm · ${profile.color} · profile "${profile.name}"`
  } catch (err) {
    console.error(err)
    setStatus((err as Error).message.slice(0, 40), 'error')
  }
})

clearBtn.addEventListener('click', () => {
  historyStrokes.length = 0
  drawPaper()
})

homeBtn.addEventListener('click', async () => {
  if (!plotter) return
  setStatus('homing…', 'busy')
  // LivePlotter doesn't expose a bare home call; ending the session homes the
  // arm and disables motors. For a live workflow that's acceptable — user can
  // reconnect if they want to keep drawing.
  try {
    await plotter.end()
    plotter = null
    setStatus('homed · disconnect to end', 'ok')
    connectBtn.disabled = false
    homeBtn.disabled = true
    closeBtn.disabled = true
  } catch (err) {
    console.error(err)
    setStatus('home failed', 'error')
  }
})

closeBtn.addEventListener('click', async () => {
  if (!plotter) return
  setStatus('closing…', 'busy')
  try {
    await plotter.close()
    plotter = null
    setStatus('disconnected', '')
    connectBtn.disabled = false
    clearBtn.disabled   = true
    homeBtn.disabled    = true
    closeBtn.disabled   = true
  } catch (err) {
    console.error(err)
    setStatus('close failed', 'error')
  }
})

function setStatus(msg: string, kind: 'ok' | 'busy' | 'error' | '' = '') {
  statusEl.textContent = msg
  statusEl.className = 'status' + (kind ? ' ' + kind : '')
}

// ─── Init ────────────────────────────────────────────────────────────────────

layoutCanvas()
if (!('serial' in navigator)) {
  setStatus('WebSerial unsupported — use Chrome/Edge', 'error')
  connectBtn.disabled = true
}
