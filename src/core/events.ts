import { EventEmitter } from 'events'
import type { Job, JobMetrics, LayerConfig } from './job.ts'

// ─── Typed plot event map ─────────────────────────────────────────────────────

export interface PlotEvents {
  'job:start': [job: Job]
  'layer:start': [layer: LayerConfig, index: number, total: number]
  'layer:complete': [layer: LayerConfig, metrics: Partial<JobMetrics>]
  'pen:up': []
  'pen:down': []
  'progress': [fraction: number, etaS: number]
  'complete': [metrics: JobMetrics]
  'abort': [stoppedAt: number]
  'pause': []
  'resume': []
}

// ─── Typed EventEmitter wrapper ───────────────────────────────────────────────

export class PlotEmitter extends EventEmitter {
  emit<K extends keyof PlotEvents>(event: K, ...args: PlotEvents[K]): boolean {
    return super.emit(event, ...args)
  }

  on<K extends keyof PlotEvents>(event: K, listener: (...args: PlotEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  once<K extends keyof PlotEvents>(event: K, listener: (...args: PlotEvents[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }

  off<K extends keyof PlotEvents>(event: K, listener: (...args: PlotEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void)
  }
}
