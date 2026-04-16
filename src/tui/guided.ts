import readline from 'readline'
import chalk from 'chalk'
import type { Job, LayerConfig } from '../core/job.ts'
import type { PreviewStats } from '../backends/types.ts'
import { formatDuration, formatDistance } from './output.ts'
import { isInteractive } from './env.ts'

export interface GuidedLayerResult {
  action: 'plot' | 'skip' | 'quit'
}

/**
 * Render a layer info box and prompt the user to plot, skip, or quit.
 *
 * Example output:
 *   ┌─ Layer 1/3 — outlines ──────────────────────────────────┐
 *   │  Profile:   fineliner                                    │
 *   │  Est. time: 4m 12s  ·  Pen-down: 2.1m  ·  Lifts: 89    │
 *   └──────────────────────────────────────────────────────────┘
 *   Pen loaded? [Enter to plot · s skip · q quit] >
 */
export async function promptLayer(
  _job: Job,
  layer: LayerConfig,
  index: number,
  total: number,
  stats?: PreviewStats | null,
): Promise<GuidedLayerResult> {
  if (!isInteractive) {
    // Non-interactive: just plot everything
    return { action: 'plot' }
  }

  const WIDTH = 58
  const layerLabel = layer.name ? `${layer.name}` : `layer ${layer.id}`
  const title = `Layer ${index + 1}/${total} — ${layerLabel}`
  const profileLabel = layer.profile ?? 'default'

  // ── Build box ─────────────────────────────────────────────────────────────
  const top    = `┌─ ${chalk.bold(title)} ${'─'.repeat(Math.max(0, WIDTH - title.length - 4))}┐`
  const bottom = `└${'─'.repeat(WIDTH)}┘`

  const line1 = boxLine(`Profile:   ${chalk.bold(profileLabel)}`, WIDTH)
  const lines = [top, line1]

  if (stats) {
    const parts: string[] = []
    if (stats.estimatedS !== null) parts.push(`Est. time: ${formatDuration(stats.estimatedS)}`)
    if (stats.pendownM !== null)   parts.push(`Pen-down: ${formatDistance(stats.pendownM)}`)
    if (stats.penLifts !== null)   parts.push(`Lifts: ${stats.penLifts}`)
    if (parts.length) lines.push(boxLine(parts.join('  ·  '), WIDTH))
  }

  // Pen swap prompt if specified
  if (layer.prompt) {
    lines.push(boxLine('', WIDTH))
    lines.push(boxLine(chalk.yellow(`⚡ ${layer.prompt}`), WIDTH))
  }

  lines.push(bottom)

  process.stderr.write('\n' + lines.map(l => `  ${l}`).join('\n') + '\n')

  const question = layer.prompt
    ? chalk.dim('  Ready? [Enter to plot · s skip · q quit] > ')
    : chalk.dim('  Pen loaded? [Enter to plot · s skip · q quit] > ')

  const answer = await readLine(question)
  const key = answer.trim().toLowerCase()

  if (key === 'q' || key === 'quit') return { action: 'quit' }
  if (key === 's' || key === 'skip') return { action: 'skip' }
  return { action: 'plot' }
}

/**
 * Prompt after Ctrl-C during a plot.
 * Returns what to do next.
 */
export async function promptPause(stoppedAt: number): Promise<'resume' | 'skip' | 'quit'> {
  if (!isInteractive) return 'quit'

  const pct = Math.round(stoppedAt * 100)
  process.stderr.write(`\n  ${chalk.yellow('Paused')} at ${pct}%.\n`)
  const answer = await readLine(
    chalk.dim('  What next? [r resume · s skip to next layer · q quit and save position] > ')
  )
  const key = answer.trim().toLowerCase()

  if (key === 'r' || key === 'resume' || key === '') return 'resume'
  if (key === 's' || key === 'skip')                  return 'skip'
  return 'quit'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Pad a line to fit inside a box of given width (strip ANSI for length calculation). */
function boxLine(content: string, width: number): string {
  const visLen = stripAnsi(content).length
  const pad = Math.max(0, width - 2 - visLen)
  return `│ ${content}${' '.repeat(pad)} │`
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function readLine(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    process.stderr.write(prompt)
    rl.once('line', line => {
      rl.close()
      resolve(line)
    })
    rl.once('close', () => resolve(''))
  })
}
