/**
 * Persistent arm-position state across nib invocations.
 *
 * Each nib process starts with currentX = currentY = 0 in software, but the
 * physical arm is wherever the last command left it. Without persistence,
 * software thinks the arm is at origin even when it isn't — and plots can
 * start 50mm into the wrong area after a `nib move`.
 *
 * This module records the carriage position after every command that moves
 * it. `nib plot` reads the state at start so it can warn / confirm before
 * assuming origin.
 *
 * Assumes pen is up between commands (we home at end of plot, save position
 * after move, etc.). Does NOT attempt to track physical reality across crashes
 * or hardware resets — the `unknown` flag captures "we lost sync, ask the
 * user" whenever that happens.
 */

import { parse, stringify } from 'smol-toml'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const NIB_STATE_DIR  = join(homedir(), '.local', 'share', 'nib')
export const NIB_STATE_PATH = join(NIB_STATE_DIR, 'state.toml')

export interface ArmState {
  /** Carriage X in mm, relative to the most recently-established origin. */
  x: number
  /** Carriage Y in mm, relative to the most recently-established origin. */
  y: number
  /** True when we've lost sync with reality (user pushed arm by hand, etc.). */
  unknown: boolean
  /** ISO timestamp of last update */
  updatedAt: string
}

const ORIGIN: ArmState = { x: 0, y: 0, unknown: false, updatedAt: '' }

export async function loadArmState(): Promise<ArmState> {
  if (!existsSync(NIB_STATE_PATH)) return { ...ORIGIN }
  try {
    const raw = await readFile(NIB_STATE_PATH, 'utf-8')
    const data = parse(raw) as Record<string, unknown>
    return {
      x:         Number(data['x'] ?? 0),
      y:         Number(data['y'] ?? 0),
      unknown:   Boolean(data['unknown'] ?? false),
      updatedAt: String(data['updated_at'] ?? ''),
    }
  } catch {
    return { ...ORIGIN }
  }
}

export async function saveArmState(state: Partial<ArmState>): Promise<void> {
  await mkdir(NIB_STATE_DIR, { recursive: true })
  const current = await loadArmState()
  const next: ArmState = {
    x:         state.x         ?? current.x,
    y:         state.y         ?? current.y,
    unknown:   state.unknown   ?? false,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(NIB_STATE_PATH, stringify({
    x: next.x,
    y: next.y,
    unknown: next.unknown,
    updated_at: next.updatedAt,
  }), 'utf-8')
}

/** Reset position to origin (motors just enabled, arm deliberately at chosen origin). */
export async function resetArmState(): Promise<void> {
  await saveArmState({ x: 0, y: 0, unknown: false })
}

/** Mark position as unknown (user is about to push arm by hand). */
export async function markArmUnknown(): Promise<void> {
  await saveArmState({ unknown: true })
}

/** Move the tracked position by a relative offset. Preserves unknown flag. */
export async function advanceArmState(dx: number, dy: number): Promise<void> {
  const cur = await loadArmState()
  await saveArmState({ x: cur.x + dx, y: cur.y + dy, unknown: cur.unknown })
}

/** Human-readable position for prompts, e.g. "(12.3, 45.0) mm" */
export function formatPosition(state: ArmState): string {
  if (state.unknown) return 'unknown'
  return `(${state.x.toFixed(1)}, ${state.y.toFixed(1)}) mm`
}
