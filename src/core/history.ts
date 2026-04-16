import { parse, stringify } from 'smol-toml'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Job, JobStatus } from './job.ts'

export const NIB_DATA_DIR = join(homedir(), '.local', 'share', 'nib', 'jobs')

async function ensureDataDir(): Promise<void> {
  await mkdir(NIB_DATA_DIR, { recursive: true })
}

function jobPath(id: number): string {
  return join(NIB_DATA_DIR, `${String(id).padStart(4, '0')}.toml`)
}

export async function nextJobId(): Promise<number> {
  await ensureDataDir()
  const files = await readdir(NIB_DATA_DIR)
  const ids = files
    .filter(f => f.endsWith('.toml'))
    .map(f => parseInt(f.replace('.toml', ''), 10))
    .filter(n => !isNaN(n))
  return ids.length === 0 ? 1 : Math.max(...ids) + 1
}

export async function saveJob(job: Job): Promise<void> {
  await ensureDataDir()
  const data: Record<string, unknown> = {
    id: job.id,
    file: job.file ?? '',
    profile: job.profile.name,
    status: job.status,
    copies: job.copies,
    optimize: job.optimize,
    backend: job.backend,
    pendown_m: job.metrics.pendownM,
    travel_m: job.metrics.travelM,
    pen_lifts: job.metrics.penLifts,
    duration_s: job.metrics.durationS,
  }
  if (job.startedAt) data['started_at'] = job.startedAt.toISOString()
  if (job.completedAt) data['completed_at'] = job.completedAt.toISOString()
  if (job.stoppedAt !== undefined) data['stopped_at'] = job.stoppedAt
  if (job.seed !== undefined) data['seed'] = job.seed
  if (job.seriesId) data['series_id'] = job.seriesId
  if (job.session !== undefined) data['session'] = job.session
  data['settings'] = {
    speed_pendown: job.profile.speedPendown,
    speed_penup: job.profile.speedPenup,
    pen_pos_down: job.profile.penPosDown,
    pen_pos_up: job.profile.penPosUp,
    accel: job.profile.accel,
    ...(job.profile.constSpeed !== undefined && { const_speed: job.profile.constSpeed }),
    reordering: job.optimize,
  }
  await writeFile(jobPath(job.id), stringify(data), 'utf-8')
}

export async function loadJob(id: number): Promise<Job | null> {
  const path = jobPath(id)
  if (!existsSync(path)) return null
  const raw = parse(await readFile(path, 'utf-8')) as Record<string, unknown>
  const settings = (raw['settings'] ?? {}) as Record<string, unknown>
  return {
    id: raw['id'] as number,
    file: (raw['file'] as string) || null,
    svg: '',  // not persisted
    profile: {
      name: raw['profile'] as string,
      speedPendown: (settings['speed_pendown'] as number) ?? 25,
      speedPenup: (settings['speed_penup'] as number) ?? 75,
      penPosDown: (settings['pen_pos_down'] as number) ?? 40,
      penPosUp: (settings['pen_pos_up'] as number) ?? 60,
      accel: (settings['accel'] as number) ?? 75,
      constSpeed: settings['const_speed'] as boolean | undefined,
    },
    layers: [],
    preprocess: [],
    copies: (raw['copies'] as number) ?? 1,
    optimize: ((raw['optimize'] as number) ?? 0) as 0 | 1 | 2,
    guided: false,
    status: raw['status'] as JobStatus,
    startedAt: raw['started_at'] ? new Date(raw['started_at'] as string) : undefined,
    completedAt: raw['completed_at'] ? new Date(raw['completed_at'] as string) : undefined,
    stoppedAt: raw['stopped_at'] as number | undefined,
    metrics: {
      pendownM: (raw['pendown_m'] as number) ?? 0,
      travelM: (raw['travel_m'] as number) ?? 0,
      penLifts: (raw['pen_lifts'] as number) ?? 0,
      durationS: (raw['duration_s'] as number) ?? 0,
    },
    hooks: {},
    backend: (raw['backend'] as 'axicli' | 'ebb') ?? 'axicli',
    seed: raw['seed'] as number | undefined,
    seriesId: raw['series_id'] as string | undefined,
    session: raw['session'] as number | undefined,
  }
}

export interface JobSummary {
  id: number
  file: string | null
  profile: string
  status: JobStatus
  startedAt?: Date
  durationS: number
  stoppedAt?: number
}

export async function listJobs(limit = 20): Promise<JobSummary[]> {
  if (!existsSync(NIB_DATA_DIR)) return []
  const files = (await readdir(NIB_DATA_DIR))
    .filter(f => f.endsWith('.toml'))
    .sort()
    .reverse()
    .slice(0, limit)

  const summaries: JobSummary[] = []
  for (const f of files) {
    const raw = parse(await readFile(join(NIB_DATA_DIR, f), 'utf-8')) as Record<string, unknown>
    summaries.push({
      id: raw['id'] as number,
      file: (raw['file'] as string) || null,
      profile: raw['profile'] as string,
      status: raw['status'] as JobStatus,
      startedAt: raw['started_at'] ? new Date(raw['started_at'] as string) : undefined,
      durationS: (raw['duration_s'] as number) ?? 0,
      stoppedAt: raw['stopped_at'] as number | undefined,
    })
  }
  return summaries
}
