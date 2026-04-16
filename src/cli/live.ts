/**
 * Live mode — read SVG paths from a subprocess stdout and plot as they arrive
 *
 * Usage:
 *   nib plot my-sketch.js --live --backend ebb [--profile fineliner]
 *
 * The target script (or stdin) emits SVG path elements line by line, e.g.:
 *   <path d="M 10,10 L 50,50"/>
 *   <path d="M 50,50 C 60,40 80,40 90,50"/>
 *
 * nib collects each <path> as it arrives, converts it to plotter moves,
 * and sends SM commands to the EBB board immediately — zero buffering.
 *
 * You can also pipe a process:
 *   node weather-lines.js | nib plot - --live --backend ebb
 *
 * Lines that don't look like SVG path elements are printed to stderr verbatim
 * (useful for debug output from the generator script).
 */

import { spawn } from 'child_process'
import { createInterface } from 'readline'
import chalk from 'chalk'
import { resolveProfile } from '../core/config.ts'
import { EBBBackend } from '../backends/ebb.ts'
import { NodeSerialTransport } from '../backends/node-serial.ts'
import { svgToMoves } from '../backends/svg-to-moves.ts'
import { printError } from '../tui/output.ts'

export interface LiveModeOptions {
  port?: string
  profile?: string
}

/**
 * Stream SVG paths from a file/script or stdin and plot each path immediately.
 *
 * @param source  Path to script (run via bun/node), or '-' for stdin
 */
export async function runLiveMode(source: string, options: LiveModeOptions = {}): Promise<void> {
  const profile = await resolveProfile(options.profile).catch(err => {
    printError((err as Error).message, 'run: nib profile list')
    process.exit(1)
  })

  process.stderr.write(`\n  ${chalk.bold('nib live')} — ${chalk.cyan(source)}\n`)
  process.stderr.write(`  Profile: ${chalk.bold(profile.name)}  ·  waiting for paths…\n\n`)

  const port = options.port ?? process.env.NIB_PORT ?? ''
  let backend: EBBBackend
  try {
    const transport = await NodeSerialTransport.connect(port || undefined)
    backend = new EBBBackend(transport)
    await backend.connect()
  } catch (err) {
    printError((err as Error).message)
    process.exit(1)
  }

  let pathCount = 0
  let aborted = false

  // Graceful SIGINT — lift pen and home
  const onSigint = async () => {
    aborted = true
    process.stderr.write('\n  Stopping live mode…\n')
    await backend.disconnect().catch(() => undefined)
    process.stderr.write(`  Plotted ${pathCount} paths.\n\n`)
    process.exit(130)
  }
  process.removeAllListeners('SIGINT')
  process.once('SIGINT', () => { void onSigint() })

  // Set up the path source (script subprocess or stdin)
  const lineReader = source === '-'
    ? createInterface({ input: process.stdin })
    : createChildLineReader(source)

  for await (const line of lineReader) {
    if (aborted) break

    const trimmed = line.trim()

    // Recognize <path d="..."/> — may span one line
    const pathMatch = trimmed.match(/<path[^>]*\sd="([^"]+)"/)
    if (pathMatch) {
      const d = pathMatch[1]
      pathCount++
      process.stderr.write(chalk.dim(`  path #${pathCount}  ${d.slice(0, 40)}${d.length > 40 ? '…' : ''}\n`))

      // Convert path to moves and execute
      const wrappedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210"><path d="${escapeXml(d)}"/></svg>`
      const moves = svgToMoves(wrappedSvg, { tolerance: 0.1 })

      try {
        for (const move of moves) {
          if (aborted) break
          await backend.moveTo(move.x, move.y, move.penDown
            ? profile.speedPendown
            : profile.speedPenup)
          // Transition pen state via moveTo approximation — backend tracks internally
        }
      } catch (err) {
        process.stderr.write(chalk.red(`  Error on path #${pathCount}: ${(err as Error).message}\n`))
      }
    } else if (trimmed && !trimmed.startsWith('<')) {
      // Pass non-SVG output through as generator diagnostics
      process.stderr.write(chalk.dim(`  [gen] ${trimmed}\n`))
    }
    // Skip pure SVG wrapper lines (<svg>, </svg>, etc.)
  }

  if (!aborted) {
    await backend.disconnect()
    process.stderr.write(`\n  Live mode complete. Plotted ${pathCount} paths.\n\n`)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createChildLineReader(scriptPath: string): AsyncIterable<string> {
  const isBun = scriptPath.endsWith('.ts') || scriptPath.endsWith('.mjs')
  const [cmd, ...args] = isBun
    ? ['bun', 'run', scriptPath]
    : ['node', scriptPath]

  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] })
  const rl = createInterface({ input: child.stdout })

  child.on('error', err => {
    process.stderr.write(chalk.red(`  Failed to start script: ${err.message}\n`))
    process.exit(1)
  })

  return rl
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
