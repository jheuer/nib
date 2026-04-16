import { defineCommand } from 'citty'
import { confirm } from '@clack/prompts'
import chalk from 'chalk'
import {
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  cloneProfile,
  getProfileWear,
} from '../core/config.ts'
import type { Profile } from '../core/job.ts'
import { formatProfileRow, printError, printUsageError, ok, fail } from '../tui/output.ts'
import { isInteractive } from '../tui/env.ts'

// ─── profile create ───────────────────────────────────────────────────────────

const create = defineCommand({
  meta: { name: 'create', description: 'Create a new pen profile' },
  args: {
    name: { type: 'positional', description: 'Profile name' },
    'speed-down': { type: 'string', description: 'Pen-down speed 1–100', default: '25' },
    'speed-up':   { type: 'string', description: 'Pen-up speed 1–100',   default: '75' },
    'pen-down':   { type: 'string', description: 'Pen-down position 0–100', default: '40' },
    'pen-up':     { type: 'string', description: 'Pen-up position 0–100',   default: '60' },
    accel:        { type: 'string', description: 'Acceleration 1–100',  default: '75' },
    'const-speed': { type: 'boolean', description: 'Constant speed mode', default: false },
    description:  { type: 'string', description: 'Description, e.g. "Staedtler 0.3mm"' },
  },
  async run({ args }) {
    const existing = await getProfile(args.name)
    if (existing) {
      printUsageError(
        `profile "${args.name}" already exists`,
        'use: nib profile clone to copy it, or edit ~/.config/nib/profiles.toml directly',
      )
      process.exit(2)
    }

    const speedDown = parseInt(args['speed-down'], 10)
    const speedUp   = parseInt(args['speed-up'], 10)
    const penDown   = parseInt(args['pen-down'], 10)
    const penUp     = parseInt(args['pen-up'], 10)
    const accel     = parseInt(args.accel, 10)

    if ([speedDown, speedUp, penDown, penUp, accel].some(isNaN)) {
      printUsageError('all numeric flags must be integers')
      process.exit(2)
    }

    const profile: Profile = {
      speedPendown: speedDown,
      speedPenup:   speedUp,
      penPosDown:   penDown,
      penPosUp:     penUp,
      accel,
      constSpeed:   args['const-speed'] || undefined,
      description:  args.description,
    }
    await saveProfile(args.name, profile)
    process.stderr.write(`  ${ok(`profile "${chalk.bold(args.name)}" created`)}\n`)
  },
})

// ─── profile list ─────────────────────────────────────────────────────────────

const list = defineCommand({
  meta: { name: 'list', description: 'List all profiles' },
  args: {
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    const profiles = await listProfiles()
    if (profiles.length === 0) {
      process.stderr.write(chalk.dim('  No profiles. Create one with: nib profile create <name>\n'))
      return
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(profiles, null, 2) + '\n')
      return
    }
    process.stderr.write(chalk.dim('  Name              Speeds & accel                   Description\n'))
    process.stderr.write(chalk.dim('  ' + '─'.repeat(75) + '\n'))
    for (const p of profiles) {
      process.stderr.write(formatProfileRow(p) + '\n')
    }
  },
})

// ─── profile show ─────────────────────────────────────────────────────────────

const show = defineCommand({
  meta: { name: 'show', description: "Show a profile's settings" },
  args: {
    name: { type: 'positional', description: 'Profile name' },
    json: { type: 'boolean', description: 'Output as JSON', default: false },
  },
  async run({ args }) {
    const p = await getProfile(args.name)
    if (!p) {
      printError(`profile "${args.name}" not found`, 'run: nib profile list')
      process.exit(1)
    }
    const wear = await getProfileWear(args.name)

    if (args.json) {
      process.stdout.write(JSON.stringify({ ...p, wear }, null, 2) + '\n')
      return
    }
    process.stderr.write(`\n  ${chalk.bold(p.name)}${p.description ? `  ${chalk.dim('—')}  ${chalk.dim(p.description)}` : ''}\n`)
    process.stderr.write(`  ${chalk.dim('speed-down:')}   ${p.speedPendown}%\n`)
    process.stderr.write(`  ${chalk.dim('speed-up:')}     ${p.speedPenup}%\n`)
    process.stderr.write(`  ${chalk.dim('pen-down:')}     ${p.penPosDown}\n`)
    process.stderr.write(`  ${chalk.dim('pen-up:')}       ${p.penPosUp}\n`)
    process.stderr.write(`  ${chalk.dim('accel:')}        ${p.accel}%\n`)
    if (p.constSpeed) process.stderr.write(`  ${chalk.dim('const-speed:')}  true\n`)

    // Wear stats
    if (wear.totalM > 0 || wear.jobs > 0) {
      process.stderr.write('\n')
      process.stderr.write(`  ${chalk.dim('Total plotted:')}  ${wear.totalM.toFixed(1)}m  across ${wear.jobs} job${wear.jobs !== 1 ? 's' : ''}\n`)
      if (wear.lastUsed) {
        process.stderr.write(`  ${chalk.dim('Last used:')}      ${wear.lastUsed}\n`)
      }
      if (wear.lifespanM) {
        const used = Math.min(100, Math.round((wear.totalM / wear.lifespanM) * 100))
        const remaining = Math.max(0, wear.lifespanM - wear.totalM)
        const bar = '█'.repeat(Math.round(used / 5)) + chalk.dim('░'.repeat(20 - Math.round(used / 5)))
        process.stderr.write(`  ${chalk.dim('Wear:')}           ${bar}  ${used}%  (~${remaining.toFixed(1)}m remaining)\n`)
        if (remaining < wear.lifespanM * 0.2) {
          process.stderr.write(`  ${chalk.yellow('⚠')}  ${chalk.yellow(`Low ink — consider having a spare ready`)}\n`)
        }
      }
    }
    process.stderr.write('\n')
  },
})

// ─── profile set ──────────────────────────────────────────────────────────────

const set = defineCommand({
  meta: { name: 'set', description: 'Update one or more fields of an existing profile' },
  args: {
    name:          { type: 'positional', description: 'Profile name' },
    'speed-down':  { type: 'string', description: 'Pen-down speed 1–100' },
    'speed-up':    { type: 'string', description: 'Pen-up speed 1–100' },
    'pen-down':    { type: 'string', description: 'Pen-down position 0–100' },
    'pen-up':      { type: 'string', description: 'Pen-up position 0–100' },
    accel:         { type: 'string', description: 'Acceleration 1–100' },
    'const-speed': { type: 'boolean', description: 'Constant speed mode' },
    description:   { type: 'string', description: 'Description text' },
  },
  async run({ args }) {
    const existing = await getProfile(args.name)
    if (!existing) {
      printError(`profile "${args.name}" not found`, 'run: nib profile list')
      process.exit(1)
    }

    const overrides: Partial<Profile> = {}
    if (args['speed-down'] !== undefined) overrides.speedPendown = parseInt(args['speed-down'], 10)
    if (args['speed-up']   !== undefined) overrides.speedPenup   = parseInt(args['speed-up'],   10)
    if (args['pen-down']   !== undefined) overrides.penPosDown   = parseInt(args['pen-down'],   10)
    if (args['pen-up']     !== undefined) overrides.penPosUp     = parseInt(args['pen-up'],     10)
    if (args.accel         !== undefined) overrides.accel        = parseInt(args.accel,         10)
    if (args['const-speed'] !== undefined) overrides.constSpeed  = args['const-speed'] || undefined
    if (args.description   !== undefined) overrides.description  = args.description

    if (Object.keys(overrides).length === 0) {
      printUsageError('no fields specified — nothing to update')
      process.exit(2)
    }

    const updated: Profile = { ...existing, ...overrides }
    delete (updated as Partial<typeof existing>).name
    await saveProfile(args.name, updated)
    process.stderr.write(`  ${ok(`profile "${chalk.bold(args.name)}" updated`)}\n`)
  },
})

// ─── profile clone ────────────────────────────────────────────────────────────

const clone = defineCommand({
  meta: { name: 'clone', description: 'Clone a profile, optionally overriding fields' },
  args: {
    source: { type: 'positional', description: 'Source profile name' },
    dest:   { type: 'positional', description: 'New profile name' },
    'speed-down': { type: 'string', description: 'Override pen-down speed' },
    'speed-up':   { type: 'string', description: 'Override pen-up speed' },
    'pen-down':   { type: 'string', description: 'Override pen-down position' },
    'pen-up':     { type: 'string', description: 'Override pen-up position' },
    accel:        { type: 'string', description: 'Override acceleration' },
  },
  async run({ args }) {
    const overrides: Partial<Profile> = {}
    if (args['speed-down']) overrides.speedPendown = parseInt(args['speed-down'], 10)
    if (args['speed-up'])   overrides.speedPenup   = parseInt(args['speed-up'], 10)
    if (args['pen-down'])   overrides.penPosDown   = parseInt(args['pen-down'], 10)
    if (args['pen-up'])     overrides.penPosUp     = parseInt(args['pen-up'], 10)
    if (args.accel)         overrides.accel        = parseInt(args.accel, 10)

    const result = await cloneProfile(args.source, args.dest, overrides)
    if (!result) {
      printError(`profile "${args.source}" not found`, 'run: nib profile list')
      process.exit(1)
    }
    process.stderr.write(`  ${ok(`cloned "${chalk.bold(args.source)}" → "${chalk.bold(args.dest)}"`)}\n`)
  },
})

// ─── profile delete ───────────────────────────────────────────────────────────

const del = defineCommand({
  meta: { name: 'delete', description: 'Delete a profile' },
  args: {
    name: { type: 'positional', description: 'Profile name' },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip confirmation (for scripts and CI)',
      default: false,
    },
  },
  async run({ args }) {
    const existing = await getProfile(args.name)
    if (!existing) {
      printError(`profile "${args.name}" not found`, 'run: nib profile list')
      process.exit(1)
    }

    // Require confirmation for destructive operation unless --yes or non-interactive
    if (!args.yes) {
      if (!isInteractive) {
        printUsageError(
          `refusing to delete "${args.name}" in non-interactive mode without --yes`,
          'pass --yes to confirm: nib profile delete --yes ' + args.name,
        )
        process.exit(2)
      }
      const confirmed = await confirm({
        message: `Delete profile "${chalk.bold(args.name)}"? This cannot be undone.`,
        initialValue: false,
      })
      if (!confirmed || confirmed === Symbol.for('clack:cancel')) {
        process.stderr.write('  Cancelled.\n')
        return
      }
    }

    await deleteProfile(args.name)
    process.stderr.write(`  ${fail(`profile "${chalk.bold(args.name)}" deleted`)}\n`)
  },
})

// ─── profile (parent) ─────────────────────────────────────────────────────────

export const profileCmd = defineCommand({
  meta: { name: 'profile', description: 'Manage pen profiles' },
  subCommands: { create, list, show, set, clone, delete: del },
})
