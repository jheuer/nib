import { describe, it, expect } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { jobToAxicliFlags, getSvgStats } from '../src/backends/axicli.ts'
import { createJob } from '../src/core/job.ts'
import type { ResolvedProfile } from '../src/core/job.ts'

const FIXTURES = join(import.meta.dir, 'fixtures')

const DEFAULT_PROFILE: ResolvedProfile = {
  name: 'default',
  speedPendown: 25,
  speedPenup: 75,
  penPosDown: 40,
  penPosUp: 60,
  accel: 75,
}

// ─── jobToAxicliFlags ─────────────────────────────────────────────────────────

describe('jobToAxicliFlags', () => {
  it('produces expected flags for default profile', () => {
    const job = createJob({ svg: '', profile: DEFAULT_PROFILE })
    const flags = jobToAxicliFlags(job)
    expect(flags).toContain('--speed_pendown')
    expect(flags).toContain('25')
    expect(flags).toContain('--speed_penup')
    expect(flags).toContain('75')
    expect(flags).toContain('--pen_pos_down')
    expect(flags).toContain('40')
    expect(flags).toContain('--pen_pos_up')
    expect(flags).toContain('60')
    expect(flags).toContain('--accel')
    expect(flags).toContain('75')
    expect(flags).toContain('--reordering')
    expect(flags).toContain('0')
  })

  it('includes --preview in preview mode', () => {
    const job = createJob({ svg: '', profile: DEFAULT_PROFILE })
    const flags = jobToAxicliFlags(job, 'preview')
    expect(flags).toContain('--preview')
  })

  it('does not include --preview in plot mode', () => {
    const job = createJob({ svg: '', profile: DEFAULT_PROFILE })
    const flags = jobToAxicliFlags(job, 'plot')
    expect(flags).not.toContain('--preview')
  })

  it('includes --const_speed when profile has constSpeed=true', () => {
    const profile = { ...DEFAULT_PROFILE, constSpeed: true }
    const job = createJob({ svg: '', profile })
    expect(jobToAxicliFlags(job)).toContain('--const_speed')
  })

  it('respects optimize level in --reordering flag', () => {
    const job = createJob({ svg: '', profile: DEFAULT_PROFILE, optimize: 2 })
    const flags = jobToAxicliFlags(job)
    const idx = flags.indexOf('--reordering')
    expect(flags[idx + 1]).toBe('2')
  })
})

// ─── Fixture: simple-rect flag sequence ──────────────────────────────────────

describe('fixture: simple-rect axicli flags', () => {
  it('matches expected flag set from fixture', async () => {
    const expected = JSON.parse(
      await readFile(join(FIXTURES, 'simple-rect', 'expected-commands.json'), 'utf-8')
    )
    const job = createJob({ svg: '', profile: DEFAULT_PROFILE })
    const flags = jobToAxicliFlags(job)
    expect(flags).toEqual(expected.flags)
  })
})

// ─── Fixture: multi-layer flag sequence ──────────────────────────────────────

describe('fixture: multi-layer axicli flags', () => {
  it('layer 1 flags match expected', async () => {
    const expected = JSON.parse(
      await readFile(join(FIXTURES, 'multi-layer', 'expected-commands.json'), 'utf-8')
    )
    const job = createJob({ svg: '', profile: DEFAULT_PROFILE })
    const flags = [...jobToAxicliFlags(job), '--layer', '1']
    expect(flags).toEqual(expected.flags_layer1)
  })

  it('layer 2 flags match expected', async () => {
    const expected = JSON.parse(
      await readFile(join(FIXTURES, 'multi-layer', 'expected-commands.json'), 'utf-8')
    )
    const job = createJob({ svg: '', profile: DEFAULT_PROFILE })
    const flags = [...jobToAxicliFlags(job), '--layer', '2']
    expect(flags).toEqual(expected.flags_layer2)
  })
})

// ─── getSvgStats ──────────────────────────────────────────────────────────────

describe('getSvgStats', () => {
  it('counts drawable elements', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = await getSvgStats(svg)
    expect(stats.pathCount).toBe(1)  // one <rect>
  })

  it('detects Inkscape layers', async () => {
    const svg = await readFile(join(FIXTURES, 'multi-layer', 'input.svg'), 'utf-8')
    const stats = await getSvgStats(svg)
    expect(stats.layerIds).toHaveLength(2)
    expect(stats.layerIds).toContain(1)
    expect(stats.layerIds).toContain(2)
  })

  it('reads width/height in mm', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = await getSvgStats(svg)
    expect(stats.widthMm).toBeCloseTo(100, 0)
    expect(stats.heightMm).toBeCloseTo(100, 0)
  })

  it('parses viewBox', async () => {
    const svg = await readFile(join(FIXTURES, 'simple-rect', 'input.svg'), 'utf-8')
    const stats = await getSvgStats(svg)
    expect(stats.viewBox?.width).toBeCloseTo(100, 0)
    expect(stats.viewBox?.height).toBeCloseTo(100, 0)
  })
})
