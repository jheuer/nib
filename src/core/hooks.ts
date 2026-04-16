import { exec } from 'child_process'
import { promisify } from 'util'
import type { HookConfig, JobMetrics } from './job.ts'
import { formatDuration, formatDistance } from '../tui/output.ts'

const execAsync = promisify(exec)

// ─── Template variables ───────────────────────────────────────────────────────

export interface HookVars {
  file?: string | null
  duration?: number           // seconds
  profile?: string
  job_id?: number
  layer?: number | string
  pendown_m?: number
  travel_m?: number
  pen_lifts?: number
}

function interpolate(template: string, vars: HookVars): string {
  const resolved: Record<string, string> = {
    file:       vars.file ?? '',
    duration:   vars.duration !== undefined ? formatDuration(vars.duration) : '',
    profile:    vars.profile ?? '',
    job_id:     vars.job_id !== undefined ? String(vars.job_id) : '',
    layer:      vars.layer !== undefined ? String(vars.layer) : '',
    pendown_m:  vars.pendown_m !== undefined ? formatDistance(vars.pendown_m) : '',
    travel_m:   vars.travel_m !== undefined ? formatDistance(vars.travel_m) : '',
    pen_lifts:  vars.pen_lifts !== undefined ? String(vars.pen_lifts) : '',
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => resolved[key] ?? `{{${key}}}`)
}

// ─── Hook runner ──────────────────────────────────────────────────────────────

/**
 * Run a single hook command template.
 * Template variables like {{duration}}, {{file}} are substituted before execution.
 * Failures are non-fatal — a warning is printed and execution continues.
 */
export async function runHook(template: string | undefined, vars: HookVars): Promise<void> {
  if (!template) return
  const cmd = interpolate(template, vars)
  try {
    await execAsync(cmd, { shell: process.env.SHELL ?? '/bin/sh' })
  } catch (err) {
    process.stderr.write(`  hook warning: ${(err as Error).message.split('\n')[0]}\n`)
  }
}

/**
 * Fire on_complete hook with job metrics.
 */
export async function fireCompleteHook(hooks: HookConfig, vars: HookVars & { metrics: JobMetrics }): Promise<void> {
  await runHook(hooks.onComplete, {
    ...vars,
    pendown_m: vars.metrics.pendownM,
    travel_m: vars.metrics.travelM,
    pen_lifts: vars.metrics.penLifts,
    duration: vars.metrics.durationS,
  })
}

/**
 * Fire on_layer_complete hook.
 */
export async function fireLayerCompleteHook(hooks: HookConfig, layerId: number | string, vars: HookVars): Promise<void> {
  await runHook(hooks.onLayerComplete, { ...vars, layer: layerId })
}

/**
 * Fire on_abort hook.
 */
export async function fireAbortHook(hooks: HookConfig, vars: HookVars): Promise<void> {
  await runHook(hooks.onAbort, vars)
}
