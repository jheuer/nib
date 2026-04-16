/**
 * NodeSerialTransport — Node/Bun implementation of EbbTransport over USB CDC
 * serial using the OS's /dev/cu.usbmodem* (macOS) or /dev/ttyACM* (Linux).
 *
 * Uses stty to set baud rate and raw mode, then opens separate read and write
 * file descriptors. Sharing a single O_RDWR fd between createReadStream and
 * writeSync drops data on Bun's character-device backend — two fds is safer.
 *
 * Port auto-detection enumerates USB devices (ioreg on macOS, /sys on Linux)
 * looking for the EBB's VID:PID (04d8:fd92 / 04d8:fd93).
 */

import { openSync, writeSync, closeSync, createReadStream, constants as fsConstants } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { spawnSync, execSync } from 'node:child_process'
import type { EbbTransport } from './transport.ts'
import { EbbCommands } from './ebb-protocol.ts'

export const EBB_BAUD = 115200

// ─── NodeSerialTransport ──────────────────────────────────────────────────────

export class NodeSerialTransport implements EbbTransport {
  private rFd = -1
  private wFd = -1
  private stream: ReadStream | null = null
  private lineBuffer = ''
  private pendingReply: ((line: string) => void) | null = null
  private draining = false
  private resumeTimer: ReturnType<typeof setInterval> | null = null

  get isOpen(): boolean { return this.rFd >= 0 && this.wFd >= 0 }

  /**
   * Resolve a port path (or auto-detect) and return a connected transport.
   * Throws if no EBB device is found.
   */
  static async connect(port?: string): Promise<NodeSerialTransport> {
    const resolved = port ?? await findEbbPort()
    if (!resolved) {
      throw new Error(
        'No EBB/AxiDraw device found. ' +
        'Check that the USB cable is connected and the device is powered.',
      )
    }
    const t = new NodeSerialTransport()
    await t.open(resolved)
    return t
  }

  async open(rawPath: string): Promise<void> {
    // On macOS, /dev/tty.* blocks until DCD is asserted; the EBB never asserts
    // DCD, so use /dev/cu.* (callout unit) instead. No-op on Linux.
    const path = toCuPath(rawPath)

    const sttyFlag = process.platform === 'darwin' ? '-f' : '-F'
    const r = spawnSync('stty', [
      sttyFlag, path,
      '115200', 'cs8', '-cstopb', '-parenb',
      'raw', '-echo', 'clocal', 'cread',
    ])
    if (r.status !== 0) {
      throw new Error(
        `stty failed on ${path}: ${r.stderr?.toString().trim() || r.stdout?.toString().trim()}\n` +
        'Is the device connected and do you have read/write permission?',
      )
    }

    const { O_RDONLY, O_WRONLY, O_NOCTTY } = fsConstants
    this.rFd = openSync(path, O_RDONLY | O_NOCTTY)
    this.wFd = openSync(path, O_WRONLY | O_NOCTTY)
    this.lineBuffer = ''
    this.pendingReply = null

    this.draining = true
    this.stream = createReadStream('', { fd: this.rFd, autoClose: false })
    this.stream.on('data', (chunk: Buffer | string) => {
      if (!this.draining) {
        this.lineBuffer += Buffer.isBuffer(chunk) ? chunk.toString('ascii') : chunk
        this.processBuffer()
      }
      this.stream?.resume()
    })
    this.stream.on('error', (err) => {
      if (this.pendingReply) {
        const cb = this.pendingReply
        this.pendingReply = null
        cb(`ERROR: ${err.message}`)
      }
    })

    // Drain 500ms of power-on banner / stale kernel buffer
    await sleep(500)
    this.draining = false
    this.lineBuffer = ''
    this.stream?.resume()

    // Poll resume() — Bun pauses character-device streams between bursts
    this.resumeTimer = setInterval(() => this.stream?.resume(), 50)
    this.resumeTimer.unref()
  }

  async close(): Promise<void> {
    if (this.rFd < 0) return
    if (this.resumeTimer) { clearInterval(this.resumeTimer); this.resumeTimer = null }
    const s = this.stream
    const rFd = this.rFd, wFd = this.wFd
    this.stream = null
    this.rFd = -1
    this.wFd = -1
    this.lineBuffer = ''
    this.pendingReply = null
    this.draining = false
    if (s) {
      s.removeAllListeners()
      s.on('error', () => { /* swallow */ })
      try { closeSync(rFd) } catch { /* ignore */ }
      s.destroy()
    } else {
      try { closeSync(rFd) } catch { /* ignore */ }
    }
    try { closeSync(wFd) } catch { /* ignore */ }
  }

  // ── EbbTransport ──────────────────────────────────────────────────────────

  async write(bytes: Uint8Array | string): Promise<void> {
    this.assertOpen()
    const buf = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes)
    writeSync(this.wFd, buf)
  }

  async readLine(timeoutMs: number): Promise<string> {
    this.assertOpen()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReply = null
        reject(new Error(`EBB read timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingReply = (line) => {
        clearTimeout(timeout)
        resolve(line)
      }
    })
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private processBuffer(): void {
    let idx: number
    while ((idx = this.lineBuffer.search(/[\r\n]/)) >= 0) {
      const line = this.lineBuffer.slice(0, idx).trim()
      const c = this.lineBuffer[idx]
      const next = this.lineBuffer[idx + 1]
      const skip = (c === '\r' && next === '\n') || (c === '\n' && next === '\r') ? 2 : 1
      this.lineBuffer = this.lineBuffer.slice(idx + skip)
      if (line.length > 0 && this.pendingReply) {
        const cb = this.pendingReply
        this.pendingReply = null
        cb(line)
      }
    }
  }

  private assertOpen(): void {
    if (this.rFd < 0 || this.wFd < 0 || !this.stream) {
      throw new Error('NodeSerialTransport is not open')
    }
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────

/**
 * Open a Node serial transport and wrap it in an EbbCommands. A drop-in
 * replacement for the old `new EBBPort(); await port.open(path)` pattern —
 * calling `ebb.close()` closes the underlying transport.
 */
export async function connectEbb(port?: string): Promise<EbbCommands> {
  const transport = await NodeSerialTransport.connect(port)
  return new EbbCommands(transport)
}

// ─── Port auto-discovery ──────────────────────────────────────────────────────

/**
 * Find the first serial port that looks like an AxiDraw / EBB device.
 * Returns the device path (e.g. /dev/cu.usbmodem14101) or null if none found.
 * Uses OS-native USB enumeration — no `serialport` npm dependency.
 */
export async function findEbbPort(): Promise<string | null> {
  if (process.platform === 'darwin') return findEbbPortMacos()
  if (process.platform === 'linux')  return findEbbPortLinux()
  return null
}

function findEbbPortMacos(): string | null {
  try {
    const out = execSync(
      'ioreg -r -c IOUSBHostDevice -l -x 2>/dev/null || ioreg -r -c IOUSBDevice -l -x 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    )
    const blocks = out.split(/(?=\+-)/)
    for (const block of blocks) {
      const vid = block.match(/"idVendor"\s*=\s*0x([0-9a-f]+)/i)?.[1] ?? ''
      const pid = block.match(/"idProduct"\s*=\s*0x([0-9a-f]+)/i)?.[1] ?? ''
      const isEbb = vid === '4d8' && (pid === 'fd92' || pid === 'fd93')
      const isEbbAlt = block.toLowerCase().includes('schmalzhaus')
                    || block.toLowerCase().includes('eggbot')
      if (isEbb || isEbbAlt) {
        const serial = block.match(/"USB Serial Number"\s*=\s*"([^"]+)"/i)?.[1]
        if (serial) {
          try {
            const tty = execSync('ls /dev/cu.usbmodem* 2>/dev/null | head -1', { encoding: 'utf-8' }).trim()
            if (tty) return tty
          } catch { /* fallthrough */ }
        }
      }
    }
  } catch { /* fallthrough */ }

  try {
    const tty = execSync('ls /dev/cu.usbmodem* 2>/dev/null | head -1', { encoding: 'utf-8' }).trim()
    if (tty) return tty
  } catch { /* ignore */ }
  return null
}

function findEbbPortLinux(): string | null {
  try {
    const out = execSync(
      "grep -rl '04d8' /sys/bus/usb/devices/*/idVendor 2>/dev/null | head -5",
      { encoding: 'utf-8', timeout: 3000 },
    )
    for (const vendorPath of out.trim().split('\n').filter(Boolean)) {
      const devDir = vendorPath.replace('/idVendor', '')
      try {
        const pid = execSync(`cat ${devDir}/idProduct 2>/dev/null`, { encoding: 'utf-8' }).trim()
        if (pid === 'fd92' || pid === 'fd93') {
          const tty = execSync(`ls ${devDir}/*/tty/tty* 2>/dev/null | head -1`, { encoding: 'utf-8' }).trim()
          if (tty) return `/dev/${tty.split('/').pop()}`
        }
      } catch { /* continue */ }
    }
  } catch { /* fallthrough */ }

  try {
    const tty = execSync('ls /dev/ttyACM* 2>/dev/null | head -1', { encoding: 'utf-8' }).trim()
    if (tty) return tty
  } catch { /* ignore */ }
  return null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function toCuPath(path: string): string {
  if (process.platform !== 'darwin') return path
  return path.replace('/dev/tty.', '/dev/cu.')
}
