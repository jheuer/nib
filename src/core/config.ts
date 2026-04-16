import { parse, stringify } from 'smol-toml'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Profile, ResolvedProfile, LayerConfig, PreprocessStep, HookConfig } from './job.ts'
import type { PlotCardConfig, PlotCardField } from './plot-card.ts'

// ─── Config dir paths ─────────────────────────────────────────────────────────

export const NIB_CONFIG_DIR = join(homedir(), '.config', 'nib')
export const PROFILES_PATH = join(NIB_CONFIG_DIR, 'profiles.toml')
export const GLOBAL_CONFIG_PATH = join(NIB_CONFIG_DIR, 'config.toml')
export const PROJECT_CONFIG_NAME = 'axidraw.toml'

// ─── Global config ────────────────────────────────────────────────────────────

export interface GlobalConfig {
  defaultProfile?: string
  model?: string
  port?: string
  historyLimit?: number
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return {}
  const raw = await readFile(GLOBAL_CONFIG_PATH, 'utf-8')
  const data = parse(raw) as Record<string, unknown>
  return {
    defaultProfile: data['default_profile'] as string | undefined,
    model: data['model'] as string | undefined,
    port: data['port'] as string | undefined,
    historyLimit: data['history_limit'] as number | undefined,
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await ensureConfigDir()
  const data: Record<string, unknown> = {}
  if (config.defaultProfile) data['default_profile'] = config.defaultProfile
  if (config.model) data['model'] = config.model
  if (config.port) data['port'] = config.port
  if (config.historyLimit) data['history_limit'] = config.historyLimit
  await writeFile(GLOBAL_CONFIG_PATH, stringify(data), 'utf-8')
}

// ─── Per-project config (axidraw.toml) ───────────────────────────────────────

export interface ProjectConfig {
  model?: string
  defaultProfile?: string
  paper?: string
  layers?: LayerConfig[]
  preprocess?: {
    steps?: PreprocessStep[]
    registrationMarks?: boolean
    marginMm?: number
  }
  hooks?: HookConfig
  plotCard?: PlotCardConfig
  session?: {
    count?: number          // current session number (auto-incremented)
    total?: number          // total sessions planned for this series
    registration?: boolean  // emit registration marks in session 1
  }
}

export async function loadProjectConfig(cwd = process.cwd()): Promise<ProjectConfig | null> {
  const path = join(cwd, PROJECT_CONFIG_NAME)
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  const data = parse(raw) as Record<string, unknown>
  const config: ProjectConfig = {}
  if (data['model']) config.model = data['model'] as string
  if (data['default_profile']) config.defaultProfile = data['default_profile'] as string
  if (data['paper']) config.paper = data['paper'] as string
  if (Array.isArray(data['layers'])) {
    config.layers = (data['layers'] as Record<string, unknown>[]).map(l => ({
      id: l['id'] as number,
      name: l['name'] as string | undefined,
      profile: l['profile'] as string | undefined,
      prompt: l['prompt'] as string | undefined,
      port: l['port'] as string | undefined,
    }))
  }
  if (data['hooks']) {
    const h = data['hooks'] as Record<string, unknown>
    config.hooks = {
      onLayerComplete: h['on_layer_complete'] as string | undefined,
      onComplete: h['on_complete'] as string | undefined,
      onAbort: h['on_abort'] as string | undefined,
    }
  }
  if (data['plot_card']) {
    const pc = data['plot_card'] as Record<string, unknown>
    config.plotCard = {
      enabled: (pc['enabled'] as boolean) ?? false,
      position: (pc['position'] as 'bottom-margin' | 'top-margin') ?? 'bottom-margin',
      content: (pc['content'] as PlotCardField[]) ?? ['title', 'date', 'seed', 'edition', 'profile'],
      fontSizeMm: (pc['font_size_mm'] as number) ?? 3,
    }
  }
  if (data['session']) {
    const s = data['session'] as Record<string, unknown>
    config.session = {
      count: s['count'] as number | undefined,
      total: s['total'] as number | undefined,
      registration: s['registration'] as boolean | undefined,
    }
  }
  return config
}

/**
 * Increment the session counter in axidraw.toml and return the new session number.
 */
export async function incrementSession(cwd = process.cwd()): Promise<number> {
  const configPath = join(cwd, PROJECT_CONFIG_NAME)
  if (!existsSync(configPath)) {
    throw new Error('No axidraw.toml found. Run: nib init')
  }
  const raw = await readFile(configPath, 'utf-8')
  const data = parse(raw) as Record<string, unknown>
  const session = (data['session'] as Record<string, unknown>) ?? {}
  const current = ((session['count'] as number) ?? 0) + 1
  session['count'] = current
  data['session'] = session
  await writeFile(configPath, stringify(data), 'utf-8')
  return current
}

export async function writeProjectConfig(cwd = process.cwd()): Promise<void> {
  const path = join(cwd, PROJECT_CONFIG_NAME)
  const data = {
    model: 'V3',
    default_profile: '',
    paper: '297x420mm',
    layers: [] as unknown[],
  }
  await writeFile(path, stringify(data), 'utf-8')
}

// ─── Profile store ────────────────────────────────────────────────────────────

type ProfilesFile = { profiles: Record<string, Record<string, unknown>> }

async function loadProfilesFile(): Promise<ProfilesFile> {
  if (!existsSync(PROFILES_PATH)) return { profiles: {} }
  const raw = await readFile(PROFILES_PATH, 'utf-8')
  const data = parse(raw) as Record<string, unknown>
  return { profiles: (data['profiles'] ?? {}) as Record<string, Record<string, unknown>> }
}

async function saveProfilesFile(file: ProfilesFile): Promise<void> {
  await ensureConfigDir()
  const data = { profiles: file.profiles }
  await writeFile(PROFILES_PATH, stringify(data), 'utf-8')
}

// ─── Pen wear ─────────────────────────────────────────────────────────────────

export interface PenWear {
  totalM: number       // total pen-down distance plotted with this profile
  jobs: number         // number of completed jobs
  lastUsed?: string    // ISO date
  lifespanM?: number   // expected pen lifespan in meters (user-configured)
}

/** Return wear info for a profile, or zeros if none recorded. */
export async function getProfileWear(name: string): Promise<PenWear> {
  const file = await loadProfilesFile()
  const raw = file.profiles[name]
  if (!raw) return { totalM: 0, jobs: 0 }
  return {
    totalM:    (raw['wear_total_m']    as number) ?? 0,
    jobs:      (raw['wear_jobs']       as number) ?? 0,
    lastUsed:  raw['wear_last_used']   as string | undefined,
    lifespanM: raw['wear_lifespan_m']  as number | undefined,
  }
}

/** Accumulate pen-down distance after a completed job. */
export async function addProfileWear(name: string, pendownM: number): Promise<void> {
  if (pendownM <= 0) return
  const file = await loadProfilesFile()
  if (!file.profiles[name]) return  // profile deleted meanwhile

  const raw = file.profiles[name]
  raw['wear_total_m'] = ((raw['wear_total_m'] as number) ?? 0) + pendownM
  raw['wear_jobs']    = ((raw['wear_jobs']    as number) ?? 0) + 1
  raw['wear_last_used'] = new Date().toISOString().slice(0, 10)
  await saveProfilesFile(file)
}

/**
 * Returns a warning string if the pen may not last the upcoming plot, or null if fine.
 * @param name         profile name
 * @param expectedM    expected pen-down distance for the upcoming plot
 */
export async function penWearWarning(name: string, expectedM: number): Promise<string | null> {
  const wear = await getProfileWear(name)
  if (!wear.lifespanM || wear.lifespanM <= 0) return null

  const remaining = wear.lifespanM - wear.totalM
  if (remaining <= 0) {
    return `${name} has exceeded its ${wear.lifespanM}m estimated lifespan — consider replacing`
  }
  if (expectedM > remaining) {
    return `${name} has ~${remaining.toFixed(1)}m remaining but this plot needs ~${expectedM.toFixed(1)}m — pen may run dry`
  }
  if (remaining < wear.lifespanM * 0.15) {
    return `${name} has ~${remaining.toFixed(1)}m remaining (${Math.round((1 - remaining/wear.lifespanM)*100)}% used)`
  }
  return null
}

// ─── Profile serialization ────────────────────────────────────────────────────

function deserializeProfile(raw: Record<string, unknown>): Profile {
  return {
    speedPendown: (raw['speed_pendown'] as number) ?? 25,
    speedPenup: (raw['speed_penup'] as number) ?? 75,
    penPosDown: (raw['pen_pos_down'] as number) ?? 40,
    penPosUp: (raw['pen_pos_up'] as number) ?? 60,
    accel: (raw['accel'] as number) ?? 75,
    constSpeed: raw['const_speed'] as boolean | undefined,
    description: raw['description'] as string | undefined,
  }
}

function serializeProfile(profile: Profile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    speed_pendown: profile.speedPendown,
    speed_penup: profile.speedPenup,
    pen_pos_down: profile.penPosDown,
    pen_pos_up: profile.penPosUp,
    accel: profile.accel,
  }
  if (profile.constSpeed !== undefined) out['const_speed'] = profile.constSpeed
  if (profile.description) out['description'] = profile.description
  return out
}

export async function listProfiles(): Promise<ResolvedProfile[]> {
  const file = await loadProfilesFile()
  return Object.entries(file.profiles).map(([name, raw]) => ({
    name,
    ...deserializeProfile(raw),
  }))
}

export async function getProfile(name: string): Promise<ResolvedProfile | null> {
  const file = await loadProfilesFile()
  const raw = file.profiles[name]
  if (!raw) return null
  return { name, ...deserializeProfile(raw) }
}

export async function saveProfile(name: string, profile: Profile): Promise<void> {
  const file = await loadProfilesFile()
  file.profiles[name] = serializeProfile(profile)
  await saveProfilesFile(file)
}

export async function deleteProfile(name: string): Promise<boolean> {
  const file = await loadProfilesFile()
  if (!file.profiles[name]) return false
  delete file.profiles[name]
  await saveProfilesFile(file)
  return true
}

export async function cloneProfile(
  sourceName: string,
  destName: string,
  overrides: Partial<Profile> = {},
): Promise<ResolvedProfile | null> {
  const source = await getProfile(sourceName)
  if (!source) return null
  const cloned: Profile = { ...source, ...overrides }
  delete (cloned as Partial<ResolvedProfile>).name
  await saveProfile(destName, cloned)
  return { name: destName, ...cloned }
}

/** Resolve a profile name → ResolvedProfile, falling back to global default then hardcoded axicli defaults */
export async function resolveProfile(name?: string): Promise<ResolvedProfile> {
  const targetName = name ?? (await loadGlobalConfig()).defaultProfile
  if (targetName) {
    const profile = await getProfile(targetName)
    if (profile) return profile
    throw new Error(`Profile "${targetName}" not found. Run: nib profile list`)
  }
  // Fallback to axicli defaults
  return {
    name: 'default',
    speedPendown: 25,
    speedPenup: 75,
    penPosDown: 40,
    penPosUp: 60,
    accel: 75,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureConfigDir(): Promise<void> {
  await mkdir(NIB_CONFIG_DIR, { recursive: true })
}
