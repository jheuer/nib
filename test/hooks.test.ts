import { describe, it, expect, mock } from 'bun:test'
import { runHook, fireCompleteHook, fireAbortHook } from '../src/core/hooks.ts'

// ─── interpolate (tested via runHook output) ──────────────────────────────────

describe('runHook', () => {
  it('does nothing when template is undefined', async () => {
    // Should not throw
    await runHook(undefined, {})
  })

  it('runs the interpolated command', async () => {
    // A command that always succeeds and produces no side effects
    await expect(runHook('echo hello', {})).resolves.toBeUndefined()
  })

  it('is non-fatal on command failure', async () => {
    // A command that fails — should not throw
    await expect(runHook('false', {})).resolves.toBeUndefined()
  })

  it('substitutes {{file}} template variable', async () => {
    // Capture the command that would be run by intercepting exec
    // We test indirectly: a command writing to a temp file
    const tmp = `/tmp/nib-hook-test-${Date.now()}.txt`
    await runHook(`echo {{file}} > ${tmp}`, { file: 'my-drawing.svg' })
    const content = await Bun.file(tmp).text()
    expect(content.trim()).toBe('my-drawing.svg')
    await Bun.file(tmp).exists() && Bun.spawnSync(['rm', tmp])
  })

  it('substitutes {{profile}} template variable', async () => {
    const tmp = `/tmp/nib-hook-test-${Date.now()}.txt`
    await runHook(`echo {{profile}} > ${tmp}`, { profile: 'fineliner' })
    const content = await Bun.file(tmp).text()
    expect(content.trim()).toBe('fineliner')
    Bun.spawnSync(['rm', tmp])
  })

  it('leaves unknown {{vars}} as-is', async () => {
    const tmp = `/tmp/nib-hook-test-${Date.now()}.txt`
    await runHook(`echo {{unknown}} > ${tmp}`, {})
    const content = await Bun.file(tmp).text()
    expect(content.trim()).toBe('{{unknown}}')
    Bun.spawnSync(['rm', tmp])
  })
})

// ─── fireCompleteHook ─────────────────────────────────────────────────────────

describe('fireCompleteHook', () => {
  it('passes pendown_m, travel_m, pen_lifts from metrics', async () => {
    const tmp = `/tmp/nib-hook-test-${Date.now()}.txt`
    await fireCompleteHook(
      { onComplete: `echo {{pendown_m}} > ${tmp}` },
      {
        file: 'test.svg',
        profile: 'fineliner',
        job_id: 1,
        metrics: { pendownM: 1.23, travelM: 0.5, penLifts: 42, durationS: 60 },
      },
    )
    const content = await Bun.file(tmp).text()
    expect(content.trim()).toContain('1.2m')
    Bun.spawnSync(['rm', tmp])
  })
})

// ─── fireAbortHook ────────────────────────────────────────────────────────────

describe('fireAbortHook', () => {
  it('runs without error when hook is set', async () => {
    await expect(
      fireAbortHook({ onAbort: 'true' }, { file: 'test.svg', profile: 'fineliner', job_id: 1 })
    ).resolves.toBeUndefined()
  })

  it('is a no-op when hook is not set', async () => {
    await expect(
      fireAbortHook({}, { file: 'test.svg', profile: 'fineliner', job_id: 1 })
    ).resolves.toBeUndefined()
  })
})
