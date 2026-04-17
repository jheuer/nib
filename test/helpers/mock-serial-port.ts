/**
 * MockSerialPort — in-process stand-in for a WebSerial SerialPort.
 *
 * Shape-compatible with what WebSerialTransport expects: `readable.getReader()`,
 * `writable.getWriter()`, `close()`. Lets tests feed bytes into the "device"
 * (feed()), inspect everything the transport wrote (writes), and observe
 * lifecycle events (close, cancel).
 *
 * Sits outside src/ so the production bundle never accidentally imports it.
 */

export class MockSerialPort {
  /** Every chunk written by the transport, in order. */
  writes: Uint8Array[] = []
  /** Set to true when transport calls port.close(). */
  closed = false
  /** Set to true when reader.cancel() is called (close path). */
  readCancelled = false

  readable: MockReadable | null = new MockReadable()
  writable: MockWritable = new MockWritable(this)

  /** Queue bytes as if they had arrived from the device. */
  feed(bytes: Uint8Array | string): void {
    const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
    this.readable?.push(buf)
  }

  /** Feed an "OK\r\n" response line — the EBB's typical ack. */
  feedOk(): void {
    this.feed('OK\r\n')
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Read the most recent write as a string (trimmed of trailing CR). */
  lastWriteString(): string {
    const last = this.writes[this.writes.length - 1]
    if (!last) return ''
    return new TextDecoder().decode(last).replace(/\r$/, '')
  }
}

class MockReadable {
  private reader: MockReader | null = null
  getReader(): MockReader {
    if (this.reader) throw new Error('reader already locked')
    this.reader = new MockReader(() => { this.reader = null })
    return this.reader
  }
  push(chunk: Uint8Array): void {
    this.reader?.push(chunk)
  }
}

class MockReader {
  private buf: Uint8Array[] = []
  private waiting: ((v: { value?: Uint8Array; done: boolean }) => void) | null = null
  private cancelled = false

  constructor(private readonly onRelease: () => void) {}

  push(chunk: Uint8Array): void {
    if (this.waiting) {
      const cb = this.waiting
      this.waiting = null
      cb({ value: chunk, done: false })
    } else {
      this.buf.push(chunk)
    }
  }

  async read(): Promise<{ value?: Uint8Array; done: boolean }> {
    if (this.cancelled) return { done: true }
    const chunk = this.buf.shift()
    if (chunk) return { value: chunk, done: false }
    return new Promise(resolve => { this.waiting = resolve })
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    if (this.waiting) {
      const cb = this.waiting
      this.waiting = null
      cb({ done: true })
    }
  }

  releaseLock(): void {
    this.onRelease()
  }
}

class MockWritable {
  constructor(private readonly port: MockSerialPort) {}
  private writer: MockWriter | null = null
  getWriter(): MockWriter {
    if (this.writer) throw new Error('writer already locked')
    this.writer = new MockWriter(this.port, () => { this.writer = null })
    return this.writer
  }
}

class MockWriter {
  constructor(
    private readonly port: MockSerialPort,
    private readonly onRelease: () => void,
  ) {}
  async write(chunk: Uint8Array): Promise<void> {
    this.port.writes.push(chunk)
  }
  async close(): Promise<void> {}
  releaseLock(): void { this.onRelease() }
}
