import { defineCommand } from 'citty'
import chalk from 'chalk'
import { connectEbb } from '../backends/node-serial.ts'
import { parseEnvelope, resolveEnvelope, MACHINE_ENVELOPES } from '../core/envelope.ts'
import {
  loadGlobalConfig, upsertMachine, deleteMachine, getMachine,
  type MachineEntry,
} from '../core/config.ts'
import { printError, printWarning } from '../tui/output.ts'
import '../tui/env.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Briefly connect, read the QN name from EEPROM, disconnect. */
async function readBoardName(port?: string): Promise<string> {
  const ebb = await connectEbb(port)
  try {
    return await ebb.queryName()
  } finally {
    await ebb.close()
  }
}

function describeEnvelope(entry: MachineEntry): string | null {
  if (entry.envelope) return entry.envelope
  if (entry.model) {
    const e = resolveEnvelope(entry.model)
    return e ? `${e.widthMm} × ${e.heightMm} mm (${entry.model})` : entry.model
  }
  return null
}

// ─── machine current ─────────────────────────────────────────────────────────

const current = defineCommand({
  meta: { name: 'current', description: 'Query the connected board\'s name and show the matching registered machine, if any' },
  args: {
    port: { type: 'string', description: 'Serial port override (env: NIB_PORT)' },
  },
  async run({ args }) {
    const port = args.port ?? process.env.NIB_PORT
    let name: string
    try {
      name = await readBoardName(port)
    } catch (err) {
      printError(`could not read board name: ${(err as Error).message}`, 'is the AxiDraw plugged in and powered on?')
      process.exit(1)
    }

    if (!name) {
      process.stderr.write(`  ${chalk.dim('Connected board has no name set.')}\n`)
      process.stderr.write(`  Run: ${chalk.cyan('nib machine register <name>')} to tag it.\n\n`)
      process.exit(0)
    }

    const entry = await getMachine(name)
    process.stderr.write(`\n  ${chalk.bold(name)}${entry?.description ? `  ${chalk.dim('—')}  ${chalk.dim(entry.description)}` : ''}\n`)
    if (entry) {
      const env = describeEnvelope(entry)
      if (env) process.stderr.write(`  ${chalk.dim('envelope:')}  ${env}\n`)
      if (entry.marginMm !== undefined) process.stderr.write(`  ${chalk.dim('margin:')}    ${entry.marginMm} mm\n`)
    } else {
      process.stderr.write(`  ${chalk.yellow('Board name is set but not registered.')}\n`)
      process.stderr.write(`  Run: ${chalk.cyan(`nib machine register ${name}`)} to add an entry.\n`)
    }
    process.stderr.write('\n')
    process.exit(0)
  },
})

// ─── machine list ────────────────────────────────────────────────────────────

const list = defineCommand({
  meta: { name: 'list', description: 'List registered machines' },
  args: {
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    const cfg = await loadGlobalConfig()
    const entries = Object.entries(cfg.machines ?? {})
    if (args.json) {
      process.stdout.write(JSON.stringify(cfg.machines ?? {}, null, 2) + '\n')
      return
    }
    if (entries.length === 0) {
      process.stderr.write(chalk.dim('  No machines registered. Register one with: nib machine register <name>\n'))
      return
    }
    const nameWidth = Math.max(...entries.map(([n]) => n.length), 6)
    process.stderr.write(`\n  ${chalk.dim('name'.padEnd(nameWidth))}   ${chalk.dim('envelope')}\n`)
    for (const [name, entry] of entries) {
      const env = describeEnvelope(entry) ?? chalk.dim('(none)')
      const desc = entry.description ? `  ${chalk.dim('·')} ${chalk.dim(entry.description)}` : ''
      process.stderr.write(`  ${chalk.bold(name.padEnd(nameWidth))}   ${env}${desc}\n`)
    }
    process.stderr.write('\n')
  },
})

// ─── machine register ────────────────────────────────────────────────────────

const register = defineCommand({
  meta: { name: 'register', description: 'Write a name to the connected board and save a matching config entry' },
  args: {
    name:       { type: 'positional', description: 'Short identifier (≤16 chars, e.g. "A3", "studio")' },
    model:      { type: 'string', description: 'AxiDraw model for envelope lookup (V3, V3A3, SE, Mini, V3XL)' },
    envelope:   { type: 'string', description: 'Explicit envelope "WxH" in mm (takes precedence over --model)' },
    'margin-mm':{ type: 'string', description: 'Safety margin in mm (default: 5)' },
    description:{ type: 'string', description: 'Human-readable description' },
    port:       { type: 'string', description: 'Serial port override (env: NIB_PORT)' },
    'skip-board': { type: 'boolean', description: 'Save the config entry without writing to the EEPROM', default: false },
  },
  async run({ args }) {
    const name = args.name
    if (!name) { printError('missing required argument: name'); process.exit(2) }
    if (name.length > 16) { printError('machine name must be ≤16 characters'); process.exit(2) }

    // Validate the envelope options before touching hardware.
    const entry: MachineEntry = {}
    if (args.model) {
      const e = resolveEnvelope(args.model)
      if (!e) { printError(`unknown model: ${args.model}`, 'see: nib machine list-models'); process.exit(2) }
      entry.model = args.model
    }
    if (args.envelope) {
      const e = parseEnvelope(args.envelope)
      if (!e) { printError(`invalid envelope (expected "WxH"): ${args.envelope}`); process.exit(2) }
      entry.envelope = args.envelope
    }
    if (args['margin-mm'] !== undefined) {
      const m = parseFloat(args['margin-mm'])
      if (Number.isNaN(m) || m < 0) { printError('--margin-mm must be a non-negative number'); process.exit(2) }
      entry.marginMm = m
    }
    if (args.description) entry.description = args.description

    if (!entry.model && !entry.envelope) {
      printWarning('no envelope specified — plots will use project/global config instead. Pass --model or --envelope to bind envelope to this machine.')
    }

    // Write the name to EEPROM (unless --skip-board). Tag board first so a
    // failure there surfaces before we mutate the config file.
    if (!args['skip-board']) {
      const port = args.port ?? process.env.NIB_PORT
      try {
        const ebb = await connectEbb(port)
        try {
          await ebb.setName(name)
        } finally {
          await ebb.close()
        }
      } catch (err) {
        printError(`could not write board name: ${(err as Error).message}`,
          'is the AxiDraw plugged in? Use --skip-board to only save the config entry.')
        process.exit(1)
      }
    }

    await upsertMachine(name, entry)
    process.stderr.write(`  ${chalk.green('✓')} registered ${chalk.bold(name)}`)
    const env = describeEnvelope(entry)
    if (env) process.stderr.write(`  ${chalk.dim('—')}  ${env}`)
    process.stderr.write('\n\n')
    process.exit(0)
  },
})

// ─── machine unregister ──────────────────────────────────────────────────────

const unregister = defineCommand({
  meta: { name: 'unregister', description: 'Remove a registered machine (optionally clear the board name too)' },
  args: {
    name: { type: 'positional', description: 'Machine name' },
    'clear-board': { type: 'boolean', description: 'Also clear the name stored on the connected board\'s EEPROM', default: false },
    port: { type: 'string', description: 'Serial port override (env: NIB_PORT)' },
  },
  async run({ args }) {
    const name = args.name
    if (!name) { printError('missing required argument: name'); process.exit(2) }

    const entry = await getMachine(name)
    if (!entry) {
      printWarning(`machine "${name}" not registered — nothing to remove`)
    } else {
      await deleteMachine(name)
      process.stderr.write(`  ${chalk.green('✓')} unregistered ${chalk.bold(name)}\n`)
    }

    if (args['clear-board']) {
      const port = args.port ?? process.env.NIB_PORT
      try {
        const ebb = await connectEbb(port)
        try {
          await ebb.setName('')
        } finally {
          await ebb.close()
        }
        process.stderr.write(`  ${chalk.green('✓')} cleared board EEPROM name\n`)
      } catch (err) {
        printError(`could not clear board name: ${(err as Error).message}`)
        process.exit(1)
      }
    }
    process.stderr.write('\n')
    process.exit(0)
  },
})

// ─── machine models ──────────────────────────────────────────────────────────

const models = defineCommand({
  meta: { name: 'models', description: 'List supported AxiDraw models and their travel envelopes' },
  args: {
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    if (args.json) {
      process.stdout.write(JSON.stringify(MACHINE_ENVELOPES, null, 2) + '\n')
      return
    }
    const entries = Object.entries(MACHINE_ENVELOPES)
    const nameWidth = Math.max(...entries.map(([n]) => n.length))
    process.stderr.write(`\n  ${chalk.dim('model'.padEnd(nameWidth))}   ${chalk.dim('envelope')}\n`)
    for (const [name, env] of entries) {
      process.stderr.write(`  ${chalk.bold(name.padEnd(nameWidth))}   ${env.widthMm} × ${env.heightMm} mm\n`)
    }
    process.stderr.write(`\n  ${chalk.dim('Aliases:')}  a3 → V3A3, a4 → V3\n\n`)
  },
})

// ─── machine ────────────────────────────────────────────────────────────────

export const machineCmd = defineCommand({
  meta: { name: 'machine', description: 'Manage registered AxiDraw machines (QN/SN board tagging)' },
  subCommands: { current, list, register, unregister, models },
})
