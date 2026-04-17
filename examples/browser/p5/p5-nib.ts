/**
 * p5-nib — a tiny bridge that captures p5.js drawing primitives into nib
 * strokes (in mm), so any p5 sketch can also plot.
 *
 * Monkey-patches `p.line`, `p.beginShape/vertex/endShape`, and `p.rect` on a
 * p5 instance. The wrapped calls still draw to the canvas as normal; they
 * also push stroke points into a capture buffer. All captured coordinates are
 * divided by `pxPerMm` so the output is in machine-space millimetres.
 *
 * Usage (instance-mode p5):
 *
 *   const sketch = (p) => {
 *     const capture = nibCapture(p, { pxPerMm: 3 })
 *     p.setup = () => { p.createCanvas(297*3, 210*3) }
 *     p.draw  = () => { p.line(0, 0, 100*3, 100*3) }  // auto-captured
 *     p.mousePressed = async () => {
 *       const strokes = capture.strokes()
 *       for (const s of strokes) await livePlotter.drawStroke(s)
 *     }
 *   }
 *   new p5(sketch, document.getElementById('sketch'))
 *
 * Global-mode p5 works too: pass `window` or the global p5 object.
 */

export interface NibCaptureOptions {
  /** Canvas pixels per millimetre. All captured coordinates divide by this. */
  pxPerMm: number
  /** If true, also capture rect() as a 4-point closed polyline (default true). */
  captureRect?: boolean
}

export interface NibCapture {
  /** All strokes captured since the last clear(). Points are in mm. */
  strokes(): { x: number; y: number }[][]
  /** Drop the capture buffer. */
  clear(): void
  /** Remove the monkey-patches; restores the original p5 functions. */
  unhook(): void
  /** Count of captured strokes — for status UI. */
  count(): number
}

// Minimal structural type for the subset of p5 we touch. Works with both
// instance-mode and global-mode p5 objects.
interface P5Like {
  line: (x1: number, y1: number, x2: number, y2: number) => void
  beginShape: (...args: unknown[]) => void
  vertex: (x: number, y: number, ...rest: unknown[]) => void
  endShape: (...args: unknown[]) => void
  rect?: (x: number, y: number, w: number, h: number, ...rest: unknown[]) => void
}

export function nibCapture(p: P5Like, options: NibCaptureOptions): NibCapture {
  const { pxPerMm, captureRect = true } = options
  const buf: { x: number; y: number }[][] = []

  // Track in-flight beginShape/endShape so multi-vertex strokes concatenate.
  let shapeOpen = false
  let current: { x: number; y: number }[] | null = null

  const toMm = (v: number) => v / pxPerMm

  // ── Hook p.line ──────────────────────────────────────────────────────────
  const origLine = p.line
  p.line = function (x1: number, y1: number, x2: number, y2: number) {
    buf.push([{ x: toMm(x1), y: toMm(y1) }, { x: toMm(x2), y: toMm(y2) }])
    return origLine.call(this, x1, y1, x2, y2)
  }

  // ── Hook p.beginShape / p.vertex / p.endShape ────────────────────────────
  const origBegin = p.beginShape
  const origVertex = p.vertex
  const origEnd = p.endShape
  p.beginShape = function (...args: unknown[]) {
    shapeOpen = true
    current = []
    return origBegin.apply(this, args)
  }
  p.vertex = function (x: number, y: number, ...rest: unknown[]) {
    if (shapeOpen && current) current.push({ x: toMm(x), y: toMm(y) })
    return origVertex.apply(this, [x, y, ...rest])
  }
  p.endShape = function (...args: unknown[]) {
    if (shapeOpen && current) {
      // p5 CLOSE flag is passed as first arg — close the polyline by
      // appending the first point if so.
      const first = current[0]
      const closed = args[0] !== undefined && first
      if (current.length >= 2) {
        if (closed) current.push({ x: first.x, y: first.y })
        buf.push(current)
      }
    }
    shapeOpen = false
    current = null
    return origEnd.apply(this, args)
  }

  // ── Hook p.rect ──────────────────────────────────────────────────────────
  let origRect: typeof p.rect | undefined
  if (captureRect && p.rect) {
    origRect = p.rect
    p.rect = function (x: number, y: number, w: number, h: number, ...rest: unknown[]) {
      buf.push([
        { x: toMm(x),     y: toMm(y) },
        { x: toMm(x + w), y: toMm(y) },
        { x: toMm(x + w), y: toMm(y + h) },
        { x: toMm(x),     y: toMm(y + h) },
        { x: toMm(x),     y: toMm(y) },
      ])
      return origRect!.apply(this, [x, y, w, h, ...rest])
    }
  }

  return {
    strokes: () => buf.slice(),
    clear: () => { buf.length = 0 },
    count: () => buf.length,
    unhook: () => {
      p.line = origLine
      p.beginShape = origBegin
      p.vertex = origVertex
      p.endShape = origEnd
      if (origRect) p.rect = origRect
    },
  }
}
