/**
 * Hardware test — Layer 4: full end-to-end plot via the CLI binary.
 *
 * ⚠ This test PLOTS the hw-calibration fixture (15×15mm box + cross).
 * Load paper and position the pen at the desired origin before running.
 *
 * Skipped when NIB_PORT is not set.
 * Requires the binary to be built: bun run build:cli
 */
import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const rawPort = process.env.NIB_PORT
const skip = !rawPort

const BINARY   = join(import.meta.dir, '../../dist/nib')
const FIXTURE  = join(import.meta.dir, '../fixtures/hw-calibration/input.svg')
const PROFILE  = process.env.NIB_PROFILE ?? 'fineliner'

function nib(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const env = { ...process.env }
  if (rawPort && rawPort !== 'auto') env.NIB_PORT = rawPort
  const result = spawnSync(BINARY, args, { encoding: 'utf-8', env })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe.skipIf(skip)('CLI binary prerequisites', () => {
  it('binary exists (run: bun run build:cli)', () => {
    expect(existsSync(BINARY)).toBe(true)
  })

  it('calibration fixture exists', () => {
    expect(existsSync(FIXTURE)).toBe(true)
  })
})

describe.skipIf(skip)('nib preview (no hardware)', () => {
  it('preview reports stats for calibration fixture', () => {
    const { stderr, status } = nib('preview', FIXTURE, '--profile', PROFILE)
    expect(status).toBe(0)
    expect(stderr).toContain('Pen-down distance')
    expect(stderr).toContain('Pen lifts')
  })

  it('preview --json outputs valid JSON', () => {
    const { stdout, status } = nib('preview', FIXTURE, '--profile', PROFILE, '--json')
    expect(status).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(typeof parsed.pendownM).toBe('number')
    expect(typeof parsed.penLifts).toBe('number')
  })
})

describe.skipIf(skip)('nib plot --dry-run', () => {
  it('dry-run exits 0 without touching hardware', () => {
    const { status, stderr } = nib(
      'plot', FIXTURE,
      '--profile', PROFILE,
      '--backend', 'ebb',
      '--dry-run',
    )
    expect(status).toBe(0)
    expect(stderr).toContain('dry-run')
  })
})

describe.skipIf(skip || !process.env.NIB_DRAW)('nib plot (DRAWS — paper required)', () => {
  // Gate the actual draw behind a second env var so you can run all other
  // hardware tests without accidentally starting a plot.
  // Usage: NIB_PORT=auto NIB_DRAW=1 bun test test/hardware/plot.test.ts

  it('plots calibration fixture via EBB backend', () => {
    const { status, stderr } = nib(
      'plot', FIXTURE,
      '--profile', PROFILE,
      '--backend', 'ebb',
      '--yes',
    )
    expect(status).toBe(0)
    expect(stderr).toContain('complete')
  }, 60_000) // 60s timeout — small fixture but real hardware
})
