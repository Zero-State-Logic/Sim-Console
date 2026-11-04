import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERIAL_BUFFER, SerialTransport, serialPendingCap } from './serial'

/* Web Serial against a fake port built on real Web Streams (Node 22). */

class FakePort extends EventTarget {
  opened: SerialOptions | null = null
  closed = false
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  written: string[] = []
  /** When set, writes never complete (a stalled board). */
  stall = false
  private rx: ReadableStreamDefaultController<Uint8Array> | null = null

  async open(opts: SerialOptions): Promise<void> {
    this.opened = opts
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => void (this.rx = c) })
    const dec = new TextDecoder()
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => (this.stall ? new Promise<void>(() => undefined) : void this.written.push(dec.decode(chunk))),
    })
  }

  async close(): Promise<void> {
    this.closed = true
  }

  feed(text: string): void {
    this.rx?.enqueue(new TextEncoder().encode(text))
  }

  end(): void {
    this.rx?.close()
  }
}

function install(port: FakePort): EventTarget {
  const serial = new EventTarget() as EventTarget & { requestPort: () => Promise<FakePort> }
  serial.requestPort = async () => port
  vi.stubGlobal('navigator', { serial })
  return serial
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SerialTransport', () => {
  it('reports support from navigator.serial', () => {
    // Arrange
    vi.stubGlobal('navigator', {})
    const t = new SerialTransport(921600)
    // Act / Assert
    expect(t.isSupported()).toBe(false)
    install(new FakePort())
    expect(t.isSupported()).toBe(true)
  })

  it('opens at the configured baud with the buffer size and frames chunked lines', async () => {
    // Arrange
    const port = new FakePort()
    install(port)
    const t = new SerialTransport(460800)
    const lines: string[] = []
    t.onLine((l) => lines.push(l))
    // Act
    await t.connect()
    port.feed('{"t":"he')
    port.feed('llo"}\r\n{"t":"tel"}\n{"t":')
    await settle()
    // Assert
    expect(port.opened).toEqual({ baudRate: 460800, bufferSize: SERIAL_BUFFER })
    expect(lines).toEqual(['{"t":"hello"}', '{"t":"tel"}'])
    await t.disconnect()
  })

  it('scales the non-critical backlog to about 50 ms of wire time, within 512..4096 bytes', () => {
    expect(serialPendingCap(115200)).toBe(576)
    expect(serialPendingCap(921600)).toBe(4096)
    expect(serialPendingCap(9600)).toBe(512)
  })

  it('keeps a low-baud backlog short so a critical line is not stuck behind 1/3 s of commands', async () => {
    // Arrange
    const port = new FakePort()
    install(port)
    const t = new SerialTransport(115200)
    await t.connect()
    port.stall = true
    const cmd = `{"t":"cmd","q":[${new Array(18).fill('-12.34').join(',')}]}`
    // Act
    const accepted: boolean[] = []
    for (let i = 0; i < 10; i++) accepted.push(t.write(cmd))
    const critical = t.write('{"t":"estop"}', true)
    // Assert: 576 B of 144-byte lines (newline included) = 4 in flight
    expect(accepted.filter(Boolean)).toHaveLength(4)
    expect(critical).toBe(true)
  })

  it('writes newline-terminated lines and drops non-critical ones when the board stalls', async () => {
    // Arrange
    const port = new FakePort()
    install(port)
    const t = new SerialTransport(921600)
    await t.connect()
    // Act
    const first = t.write('{"t":"ping","id":1}')
    await settle()
    port.stall = true
    const big = 'x'.repeat(1500)
    const accepted = [t.write(big), t.write(big), t.write(big), t.write(big)]
    const critical = t.write('{"t":"estop"}', true)
    // Assert
    expect(first).toBe(true)
    expect(port.written[0]).toBe('{"t":"ping","id":1}\n')
    expect(accepted).toEqual([true, true, false, false])
    expect(critical).toBe(true)
  })

  it('reports an unplugged device once and closes the port', async () => {
    // Arrange
    const port = new FakePort()
    const serial = install(port)
    const t = new SerialTransport(921600)
    const states: string[] = []
    t.onState((s, d) => states.push(`${s}:${d}`))
    await t.connect()
    // Act
    const ev = new Event('disconnect')
    Object.defineProperty(ev, 'target', { value: port })
    serial.dispatchEvent(ev)
    port.dispatchEvent(new Event('disconnect'))
    await settle()
    // Assert
    expect(states).toEqual(['closed:USB device unplugged'])
    expect(port.closed).toBe(true)
  })

  it('reports a stream that ends on its own, but not one closed by disconnect()', async () => {
    // Arrange
    const a = new FakePort()
    install(a)
    const ta = new SerialTransport(921600)
    const sa: string[] = []
    ta.onState((s, d) => sa.push(`${s}:${d}`))
    await ta.connect()
    // Act
    a.end()
    await settle()
    const b = new FakePort()
    install(b)
    const tb = new SerialTransport(921600)
    const sb: string[] = []
    tb.onState((s) => sb.push(s))
    await tb.connect()
    await tb.disconnect()
    await settle()
    // Assert
    expect(sa).toEqual(['closed:the serial stream ended'])
    expect(sb).toEqual([])
    expect(b.closed).toBe(true)
    expect(tb.write('x')).toBe(false)
  })

  it('surfaces lines over the protocol cap as drops', async () => {
    // Arrange
    const port = new FakePort()
    install(port)
    const t = new SerialTransport(921600)
    const drops: number[] = []
    t.onDrop((b) => drops.push(b))
    await t.connect()
    // Act
    port.feed(`${'z'.repeat(9000)}\n{"t":"ok"}\n`)
    await settle()
    // Assert
    expect(drops).toEqual([9000])
    await t.disconnect()
  })
})
