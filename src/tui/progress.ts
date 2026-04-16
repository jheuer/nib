import ora from 'ora'
import chalk from 'chalk'
import { isInteractive } from './env.ts'
import type { PlotEmitter } from '../core/events.ts'

/**
 * Attach a progress display to a PlotEmitter.
 * Uses an ora spinner when interactive; falls back to plain stderr lines in CI/pipe.
 */
export function attachProgressBar(emitter: PlotEmitter): void {
  if (isInteractive) {
    attachSpinner(emitter)
  } else {
    attachPlainProgress(emitter)
  }
}

function attachSpinner(emitter: PlotEmitter): void {
  const spinner = ora({ stream: process.stderr }).start('Plotting…')

  emitter.on('progress', (fraction, etaS) => {
    const pct = Math.round(fraction * 100)
    const filled = Math.round(fraction * 20)
    const bar = '█'.repeat(filled) + chalk.dim('░'.repeat(20 - filled))
    const eta = etaS > 0 ? chalk.dim(`  ${Math.ceil(etaS / 60)}m remaining`) : ''
    spinner.text = `${bar}  ${pct}%${eta}`
  })

  emitter.on('complete', () => {
    spinner.succeed(chalk.green('Plot complete'))
  })

  emitter.on('abort', (stoppedAt) => {
    spinner.fail(`Aborted at ${Math.round(stoppedAt * 100)}%`)
  })

  emitter.on('pause', () => {
    spinner.stop()
  })

  emitter.on('resume', () => {
    spinner.start('Resuming…')
  })
}

function attachPlainProgress(emitter: PlotEmitter): void {
  emitter.on('progress', (fraction) => {
    const pct = Math.round(fraction * 100)
    process.stderr.write(`progress: ${pct}%\n`)
  })

  emitter.on('complete', () => {
    process.stderr.write('plot complete\n')
  })

  emitter.on('abort', (stoppedAt) => {
    process.stderr.write(`aborted at ${Math.round(stoppedAt * 100)}%\n`)
  })
}
