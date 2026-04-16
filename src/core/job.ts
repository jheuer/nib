// ─── Profile types ───────────────────────────────────────────────────────────

export interface Profile {
  speedPendown: number    // 1–100, percent
  speedPenup: number      // 1–100, percent
  penPosDown: number      // 0–100, servo position
  penPosUp: number        // 0–100, servo position
  accel: number           // 1–100, percent
  constSpeed?: boolean
  description?: string
}

export interface ResolvedProfile extends Profile {
  name: string
}

// ─── Layer config ────────────────────────────────────────────────────────────

export interface LayerConfig {
  id: number
  name?: string
  profile?: string        // profile name to use for this layer
  prompt?: string         // pen-swap message shown to user
  port?: string           // override port for multi-machine splits
}

// ─── Preprocess pipeline ─────────────────────────────────────────────────────

export type PreprocessStep =
  | 'strip-fills'
  | 'center'
  | 'scale-to-paper'
  | 'registration-marks'

// ─── Hooks ───────────────────────────────────────────────────────────────────

export interface HookConfig {
  onLayerComplete?: string  // shell command; {{layer}}, {{duration}} available
  onComplete?: string       // {{file}}, {{duration}}, {{pendownM}} available
  onAbort?: string
}

// ─── Job metrics ─────────────────────────────────────────────────────────────

export interface JobMetrics {
  pendownM: number
  travelM: number
  penLifts: number
  durationS: number
}

// ─── Job ─────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'complete' | 'aborted'
export type BackendName = 'ebb'

export interface Job {
  id: number
  file: string | null     // null = piped from stdin
  svg: string             // resolved SVG content
  profile: ResolvedProfile
  layers: LayerConfig[]
  preprocess: PreprocessStep[]
  copies: number
  optimize: 0 | 1 | 2    // reordering level — maps to axicli --reordering
  guided: boolean
  status: JobStatus
  startedAt?: Date
  completedAt?: Date
  stoppedAt?: number      // fraction 0–1 where job was aborted
  metrics: JobMetrics
  hooks: HookConfig
  backend: BackendName
  seed?: number           // generative seed (series mode)
  seriesId?: string       // shared ID across a series run
  session?: number        // multi-session counter (increments per plot --session)
}

// ─── Job builder ─────────────────────────────────────────────────────────────

export function createJob(overrides: Partial<Job> & Pick<Job, 'svg' | 'profile'>): Job {
  return {
    id: 0,
    file: null,
    layers: [],
    preprocess: [],
    copies: 1,
    optimize: 0,
    guided: false,
    status: 'pending',
    metrics: { pendownM: 0, travelM: 0, penLifts: 0, durationS: 0 },
    hooks: {},
    backend: 'ebb',
    ...overrides,
  }
}
