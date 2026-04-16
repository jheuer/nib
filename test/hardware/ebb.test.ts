/**
 * Hardware tests — EBB serial protocol (Layers 1–3).
 *
 * ALL EBBPort tests live here so they share one serial port instance and
 * run sequentially in a single Bun worker. (Bun executes test files in
 * parallel workers; multiple files each opening the same /dev/cu.* would
 * conflict and cause command timeouts.)
 *
 * Skip: set NIB_PORT to the device path or "auto".
 *   NIB_PORT=/dev/cu.usbmodem14101 bun test test/hardware/ebb.test.ts
 *   NIB_PORT=auto                  bun test test/hardware/ebb.test.ts
 *
 * Layer 3 (XY motion) MOVES the carriage. Allow 20×20mm of clear space.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  EBBPort,
  findEbbPort,
  SPEED_PENDOWN_MAX_MMS,
} from '../../src/backends/ebb-protocol.ts'

const rawPort = process.env.NIB_PORT
const skip = !rawPort

async function resolvePort(): Promise<string> {
  if (rawPort === 'auto') {
    const found = await findEbbPort()
    if (!found) throw new Error('No EBB device found — is the AxiDraw connected and powered?')
    return found
  }
  return rawPort!
}

// ── Shared port — opened once for all EBB describes ──────────────────────────

let ebb: EBBPort
let port: string

beforeAll(async () => {
  if (skip) return
  port = await resolvePort()
  ebb = new EBBPort()
  await ebb.open(port)
})

afterAll(async () => {
  if (skip || !ebb?.isOpen) return
  await ebb.penUp()           // leave pen up as a safety measure
  await ebb.disableMotors()   // release steppers
  await ebb.close()
})

// ── Layer 1: Connection ───────────────────────────────────────────────────────

describe.skipIf(skip)('EBB connection', () => {
  it('opens the serial port', () => {
    expect(ebb.isOpen).toBe(true)
  })

  it('reads firmware version (V command)', async () => {
    const v = await ebb.version()
    expect(v).toMatch(/EBB/i)
  })

  it('query motors reports not moving', async () => {
    const { moving } = await ebb.queryMotors()
    expect(moving).toBe(false)
  })

  it('reports the port path', () => {
    expect(typeof port).toBe('string')
    expect(port.length).toBeGreaterThan(0)
  })
})

// ── Layer 1b: Auto-discovery (only when NIB_PORT=auto) ───────────────────────

describe.skipIf(skip || rawPort !== 'auto')('EBB auto-discovery', () => {
  it('findEbbPort returns a non-empty string', async () => {
    const found = await findEbbPort()
    expect(found).not.toBeNull()
    expect(typeof found).toBe('string')
  })
})

// ── Layer 2: Pen servo ────────────────────────────────────────────────────────

describe.skipIf(skip)('pen servo', () => {
  afterAll(async () => {
    // Leave pen up between layers
    if (ebb?.isOpen) await ebb.penUp()
  })

  it('pen down does not throw', async () => {
    await expect(ebb.penDown()).resolves.toBeUndefined()
  })

  it('pen up does not throw', async () => {
    await expect(ebb.penUp()).resolves.toBeUndefined()
  })

  it('pen cycle completes without error', async () => {
    await ebb.penDown(200)
    await ebb.penUp(200)
  })
})

// ── Layer 2b: Motor enable/disable ───────────────────────────────────────────

describe.skipIf(skip)('motor enable/disable', () => {
  afterAll(async () => {
    if (ebb?.isOpen) await ebb.disableMotors()
  })

  it('enables motors (1/16 microstepping)', async () => {
    await expect(ebb.enableMotors(5, 5)).resolves.toBeUndefined()
  })

  it('query after enable reports not moving', async () => {
    await ebb.enableMotors(5, 5)
    const { moving } = await ebb.queryMotors()
    expect(moving).toBe(false)
  })

  it('disables motors', async () => {
    await expect(ebb.disableMotors()).resolves.toBeUndefined()
  })
})

// ── Layer 3: XY motion ────────────────────────────────────────────────────────
//
// ⚠  Position the carriage at least 20mm from all four rails before running.
//    The test moves +10mm in X, then +10mm in Y, then diagonally back.
//    If the carriage is already against a rail the move will stall silently —
//    the EBB acknowledges the SM command regardless of mechanical resistance.

describe.skipIf(skip)('XY motion', () => {
  let posX = 0
  let posY = 0

  async function moveTo(x: number, y: number, speedMms = SPEED_PENDOWN_MAX_MMS) {
    await ebb.move(x - posX, y - posY, speedMms)
    posX = x
    posY = y
  }

  beforeAll(async () => {
    if (!ebb?.isOpen) return
    await ebb.enableMotors(5, 5)
    await ebb.penUp()
    posX = 0
    posY = 0
  })

  afterAll(async () => {
    if (!ebb?.isOpen) return
    await ebb.penUp()
    await moveTo(0, 0)        // return to origin
    await ebb.disableMotors()
  })

  it('moves 10mm right without error', async () => {
    await expect(moveTo(10, 0)).resolves.toBeUndefined()
  })

  it('moves 10mm down without error', async () => {
    await expect(moveTo(10, 10)).resolves.toBeUndefined()
  })

  it('moves diagonally back to origin', async () => {
    await expect(moveTo(0, 0)).resolves.toBeUndefined()
  })

  it('ignores sub-threshold move (< 0.001mm)', async () => {
    await expect(ebb.move(0.0001, 0.0001, SPEED_PENDOWN_MAX_MMS)).resolves.toBeUndefined()
  })

  it('reports not moving after moves complete', async () => {
    const { moving } = await ebb.queryMotors()
    expect(moving).toBe(false)
  })
})
