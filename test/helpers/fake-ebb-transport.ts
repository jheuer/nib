/**
 * FakeEbbTransport — in-process EbbTransport that captures every command and
 * returns the response you expect from a real EBB. Lets us assert the full
 * command stream produced by `plotStrokes`, `plot`, `EBBBackend.runStrokes`,
 * etc., without hardware or a browser.
 *
 * Default behaviour:
 *   - `V`   → "EBBv13 EB Firmware Version 2.8.1"   (triggers LM path)
 *   - `QM`  → "OK" then "QM,0,0,0,0"               (motors idle)
 *   - `QS`  → "0,0"
 *   - `HM,*` → "OK"
 *   - anything else → "OK"
 *
 * Override responses by passing a responder function to the constructor.
 */

import type { EbbTransport } from '../../src/backends/transport.ts'

type Responder = (cmd: string) => string | string[] | null

export class FakeEbbTransport implements EbbTransport {
  /** Every command sent to the transport, without the trailing CR. */
  commands: string[] = []
  readonly isOpen = true

  private queue: string[] = []
  private pending: ((line: string) => void) | null = null
  private closed = false

  constructor(private readonly responder: Responder = defaultResponder) {}

  async write(bytes: Uint8Array | string): Promise<void> {
    if (this.closed) throw new Error('FakeEbbTransport closed')
    const s = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
    // Each `write` is expected to be one command terminated by CR.
    const cmd = s.replace(/\r$/, '').trimEnd()
    if (cmd.length === 0) return
    this.commands.push(cmd)
    const reply = this.responder(cmd)
    const lines = reply == null ? [] : Array.isArray(reply) ? reply : [reply]
    for (const line of lines) this.enqueueLine(line)
  }

  async readLine(timeoutMs: number): Promise<string> {
    if (this.closed) throw new Error('FakeEbbTransport closed')
    const queued = this.queue.shift()
    if (queued !== undefined) return queued
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`FakeEbbTransport read timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.pending) {
      const cb = this.pending
      this.pending = null
      // Resolve with empty so any awaiter unblocks.
      cb('')
    }
  }

  private enqueueLine(line: string): void {
    if (this.pending) {
      const cb = this.pending
      this.pending = null
      cb(line)
    } else {
      this.queue.push(line)
    }
  }

  /** Count commands whose first comma-delimited token equals `head`. */
  countByHead(head: string): number {
    return this.commands.filter(c => c === head || c.startsWith(head + ',')).length
  }

  /** All commands starting with the given head. */
  findByHead(head: string): string[] {
    return this.commands.filter(c => c === head || c.startsWith(head + ','))
  }
}

function defaultResponder(cmd: string): string | string[] {
  if (cmd === 'V') return 'EBBv13_and_above EB Firmware Version 2.8.1'
  if (cmd === 'QM' || cmd.startsWith('QM')) return ['OK', 'QM,0,0,0,0']
  if (cmd === 'QS' || cmd.startsWith('QS')) return '0,0'
  return 'OK'
}
