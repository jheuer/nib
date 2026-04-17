/**
 * End-to-end smoke test of the browser entry point's plot pipeline using an
 * in-process FakeEbbTransport. Catches the full chain:
 *
 *   plotStrokes → strokesToMoves → reorder → planStroke → EbbCommands
 *     → transport.write (captured for assertions)
 *
 * Every change to any layer above the transport is validated here without
 * touching hardware or a real browser.
 */

import { describe, it, expect } from 'bun:test'
import { plotStrokes, plot, geom, type BrowserPlotOptions } from '../src/browser.ts'
import { FakeEbbTransport } from './helpers/fake-ebb-transport.ts'

const basicProfile: BrowserPlotOptions['profile'] = {
  speedPendown: 80,
  speedPenup:   80,
  penPosDown:   20,
  penPosUp:     50,
  accel:        50,
}

describe('nib/browser plotStrokes end-to-end', () => {
  it('sends a sensible command sequence for a single stroke', async () => {
    const transport = new FakeEbbTransport()
    await plotStrokes(
      [geom.line({ x: 0, y: 0 }, { x: 10, y: 0 })],
      { transport, profile: basicProfile, optimize: 0 },
    )

    // Firmware version query happens on connect (gates the LM path)
    expect(transport.countByHead('V')).toBeGreaterThanOrEqual(1)
    // Servo config (SC,4 = up, SC,5 = down) runs before any motion
    expect(transport.countByHead('SC')).toBeGreaterThanOrEqual(2)
    // Motors enabled at least once (EM,1,1 for 1/16 microstep)
    expect(transport.findByHead('EM').some(c => c === 'EM,1,1')).toBe(true)
    // Pen came down at least once
    expect(transport.findByHead('SP').some(c => c.startsWith('SP,1'))).toBe(true)
    // LM commands issued (LM path — firmware 2.8.1 satisfies ≥ 2.7)
    expect(transport.countByHead('LM')).toBeGreaterThanOrEqual(1)
    // Pen lifted
    expect(transport.findByHead('SP').some(c => c.startsWith('SP,0'))).toBe(true)
  })

  it('reports progress and stroke-start callbacks', async () => {
    const transport = new FakeEbbTransport()
    const progresses: number[] = []
    let strokeCount = 0
    await plotStrokes(
      [
        geom.line({ x: 0, y: 0 }, { x: 5, y: 0 }),
        geom.line({ x: 10, y: 0 }, { x: 15, y: 0 }),
      ],
      {
        transport,
        profile: basicProfile,
        optimize: 0,
        onProgress: f => progresses.push(f),
        onStroke:   _ => { strokeCount++ },
      },
    )
    expect(progresses.length).toBeGreaterThan(0)
    // Progress is emitted at stroke boundaries, so the final value reflects
    // `(strokesDone / totalMoves)` which approaches but may not reach 1.
    const last = progresses[progresses.length - 1]
    expect(last).toBeGreaterThanOrEqual(0.5)
    expect(strokeCount).toBe(2)
  })

  it('skips elements with skip=true', async () => {
    const transport = new FakeEbbTransport()
    await plotStrokes(
      [
        geom.line({ x: 0, y: 0 }, { x: 10, y: 0 }),
        { ...geom.line({ x: 20, y: 0 }, { x: 30, y: 0 }), skip: true },
      ],
      { transport, profile: basicProfile, optimize: 0 },
    )
    // Each real stroke triggers at least one SP,1 pen-down. Skipping one
    // stroke means only one pen-down transition occurred during plotting.
    const penDowns = transport.findByHead('SP').filter(c => c.startsWith('SP,1'))
    expect(penDowns.length).toBe(1)
  })

  it('does not close the user-provided transport', async () => {
    const transport = new FakeEbbTransport()
    await plotStrokes(
      [geom.line({ x: 0, y: 0 }, { x: 10, y: 0 })],
      { transport, profile: basicProfile, optimize: 0 },
    )
    // Transport still open (isOpen is readonly=true on FakeEbbTransport until
    // close() is called). plotStrokes must not have closed it.
    expect(transport.isOpen).toBe(true)
  })

  it('reorder level 2 affects command count for a multi-stroke plot', async () => {
    // Keep coordinates small — the SM home move sleeps for real motor
    // duration (13 mm/s), so plots run in real-time. Two plots + home
    // each needs to stay well under the test timeout budget.
    const strokes = [
      geom.line({ x: 0, y: 0 }, { x: 3, y: 0 }),
      geom.line({ x: 8, y: 0 }, { x: 4, y: 0 }),
    ]
    const t0 = new FakeEbbTransport()
    await plotStrokes(strokes, { transport: t0, profile: basicProfile, optimize: 0 })
    const t2 = new FakeEbbTransport()
    await plotStrokes(strokes, { transport: t2, profile: basicProfile, optimize: 2 })
    expect(t0.commands).not.toEqual(t2.commands)
  }, 15_000)   // ~7s worst case for two plots + homes
})

describe('nib/browser plot (SVG) end-to-end', () => {
  // Tiny coordinates keep test wall-clock fast. The SM fallback used for the
  // final home move sleeps for the real motor duration (~13 mm/s), so a 90mm
  // home → 7 seconds of test sleep. Keep content within ~15mm of origin.
  it('parses and plots an SVG with a stroked line', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20" width="20mm" height="20mm">
      <line x1="0" y1="0" x2="10" y2="0" stroke="black"/>
    </svg>`
    const transport = new FakeEbbTransport()
    await plot(svg, { transport, profile: basicProfile, optimize: 0 })
    expect(transport.countByHead('LM')).toBeGreaterThanOrEqual(1)
    const scIdx = transport.commands.findIndex(c => c.startsWith('SC,'))
    const lmIdx = transport.commands.findIndex(c => c.startsWith('LM,'))
    expect(scIdx).toBeGreaterThanOrEqual(0)
    expect(scIdx).toBeLessThan(lmIdx)
  })

  it('skips fill-only elements (the plotter convention)', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20" width="20mm" height="20mm">
      <rect x="0" y="0" width="20" height="20" fill="black"/>
      <line x1="0" y1="0" x2="10" y2="10" stroke="black"/>
    </svg>`
    const transport = new FakeEbbTransport()
    await plot(svg, { transport, profile: basicProfile, optimize: 0 })
    const penDowns = transport.findByHead('SP').filter(c => c.startsWith('SP,1'))
    expect(penDowns.length).toBe(1)
  })
})

describe('nib/browser safety guards', () => {
  it('honors machine envelope', async () => {
    const transport = new FakeEbbTransport()
    // Stroke endpoint is outside the 10×10 envelope — triggers runtime guard.
    // Small coords keep the abort-home move short.
    await expect(plotStrokes(
      [geom.line({ x: 0, y: 0 }, { x: 20, y: 0 })],
      {
        transport,
        profile: basicProfile,
        envelope: { widthMm: 10, heightMm: 10 },
      },
    )).resolves.toBeUndefined()
    expect(transport.findByHead('SP').some(c => c.startsWith('SP,0'))).toBe(true)
  })
})
