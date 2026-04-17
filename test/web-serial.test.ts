import { describe, it, expect } from 'bun:test'
import { WebSerialTransport } from '../src/backends/web-serial.ts'
import { MockSerialPort } from './helpers/mock-serial-port.ts'

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('WebSerialTransport.write', () => {
  it('string → UTF-8 bytes delivered to the port', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    await t.write('V\r')
    expect(port.writes.length).toBe(1)
    expect(decode(port.writes[0])).toBe('V\r')
    await t.close()
  })

  it('Uint8Array passes through unchanged', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    const bytes = new Uint8Array([65, 66, 67])
    await t.write(bytes)
    expect(port.writes[0]).toEqual(bytes)
    await t.close()
  })
})

describe('WebSerialTransport.readLine', () => {
  it('returns a line fed before the call', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    port.feed('OK\r\n')
    await new Promise(r => setTimeout(r, 5))  // let the background loop drain
    expect(await t.readLine(100)).toBe('OK')
    await t.close()
  })

  it('resolves a pending readLine when a line arrives later', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    const p = t.readLine(500)
    await new Promise(r => setTimeout(r, 10))
    port.feed('hello world\r\n')
    expect(await p).toBe('hello world')
    await t.close()
  })

  it('rejects on timeout if no line arrives', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    await expect(t.readLine(50)).rejects.toThrow(/timed out/i)
    await t.close()
  })

  it('handles CRLF terminators', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    port.feed('line1\r\nline2\r\n')
    await new Promise(r => setTimeout(r, 5))
    expect(await t.readLine(100)).toBe('line1')
    expect(await t.readLine(100)).toBe('line2')
    await t.close()
  })

  it('handles bare-LF terminators', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    port.feed('line1\nline2\n')
    await new Promise(r => setTimeout(r, 5))
    expect(await t.readLine(100)).toBe('line1')
    expect(await t.readLine(100)).toBe('line2')
    await t.close()
  })

  it('handles lines split across multiple chunks', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    const p = t.readLine(500)
    port.feed('hel')
    await new Promise(r => setTimeout(r, 5))
    port.feed('lo\r')
    await new Promise(r => setTimeout(r, 5))
    port.feed('\n')
    expect(await p).toBe('hello')
    await t.close()
  })

  it('handles CR and LF split across chunks (pair swallowed correctly)', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    const p1 = t.readLine(500)
    port.feed('A\r')
    await new Promise(r => setTimeout(r, 5))
    port.feed('\nB\r\n')
    expect(await p1).toBe('A')
    expect(await t.readLine(100)).toBe('B')
    await t.close()
  })

  it('skips the power-on drain window (first 500ms discarded)', async () => {
    const port = new MockSerialPort()
    // feed before connect — should be drained
    port.feed('banner_garbage\r\n')
    const t = await WebSerialTransport.connect(port)
    // Now feed the real line
    port.feed('OK\r\n')
    await new Promise(r => setTimeout(r, 10))
    expect(await t.readLine(100)).toBe('OK')
    await t.close()
  })
})

describe('WebSerialTransport.close', () => {
  it('marks isOpen false after close', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    expect(t.isOpen).toBe(true)
    await t.close()
    expect(t.isOpen).toBe(false)
  })

  it('cancels the read loop so close() does not hang', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    // Start a readLine that will never complete unless cancelled.
    const reading = t.readLine(10_000)
    // close() should terminate the read loop and resolve the pending read.
    await t.close()
    // The pending readLine now resolves (empty) or rejects — either is fine;
    // we just require close() itself to return promptly.
    await Promise.race([
      reading.catch(() => undefined),
      new Promise(r => setTimeout(r, 200)),
    ])
    expect(port.closed).toBe(true)
  })

  it('is idempotent', async () => {
    const port = new MockSerialPort()
    const t = await WebSerialTransport.connect(port)
    await t.close()
    await t.close()   // should not throw
  })
})

describe('WebSerialTransport.connect', () => {
  it('throws when the port is not opened (no readable/writable)', async () => {
    const port = new MockSerialPort()
    port.readable = null
    await expect(WebSerialTransport.connect(port)).rejects.toThrow(/opened/)
  })
})
