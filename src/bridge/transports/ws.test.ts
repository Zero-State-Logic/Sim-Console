import { afterEach, describe, expect, it, vi } from 'vitest'
import { WsTransport, WsUrlError } from './ws'

/* WebSocket transport against a scripted fake socket. */

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: FakeSocket | null = null
  readyState = FakeSocket.CONNECTING
  bufferedAmount = 0
  binaryType = 'blob'
  sent: string[] = []
  closedWith: [number?, string?] | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  send(s: string): void {
    this.sent.push(s)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = [code, reason]
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '' })
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  fail(): void {
    this.onerror?.()
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1006, reason: '' })
  }
}

function install(protocol = 'http:', hostname = 'localhost'): void {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol, hostname })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakeSocket.last = null
})

describe('WsTransport: connect', () => {
  it('opens the validated URL and resolves on open', async () => {
    // Arrange
    install()
    const t = new WsTransport('ws://192.168.4.1:81')
    // Act
    const p = t.connect()
    FakeSocket.last?.open()
    await p
    // Assert
    expect(FakeSocket.last?.url).toBe('ws://192.168.4.1:81/')
    expect(FakeSocket.last?.binaryType).toBe('arraybuffer')
  })

  it('refuses mixed content from an https page with the guidance attached', async () => {
    // Arrange
    install('https:', 'me.github.io')
    const t = new WsTransport('ws://192.168.4.1:81')
    // Act
    const err = await t.connect().catch((e: unknown) => e)
    // Assert
    expect(err).toBeInstanceOf(WsUrlError)
    expect((err as WsUrlError).guidance.join(' ')).toMatch(/ws-relay\.mjs/)
    expect(FakeSocket.last).toBeNull()
  })

  it('explains an unreachable relay and a silent board (5 s timeout)', async () => {
    // Arrange
    install()
    vi.useFakeTimers()
    const relay = new WsTransport('ws://localhost:8787/?k=')
    const board = new WsTransport('ws://192.168.4.1:81')
    // Act
    const p1 = relay.connect().catch((e: unknown) => e)
    FakeSocket.last?.fail()
    const e1 = (await p1) as WsUrlError
    const p2 = board.connect().catch((e: unknown) => e)
    vi.advanceTimersByTime(5000)
    const e2 = (await p2) as WsUrlError
    // Assert
    expect(e1.message).toMatch(/local relay/)
    expect(e1.guidance.join(' ')).toMatch(/\?k=<key>/)
    expect(e2.message).toMatch(/did not answer within 5 s/)
  })
})

describe('WsTransport: traffic', () => {
  async function opened(): Promise<{ t: WsTransport; s: FakeSocket; lines: string[]; states: string[] }> {
    install()
    const t = new WsTransport('ws://192.168.4.1:81')
    const lines: string[] = []
    const states: string[] = []
    t.onLine((l) => lines.push(l))
    t.onState((st, d) => states.push(`${st}:${d}`))
    const p = t.connect()
    const s = FakeSocket.last as FakeSocket
    s.open()
    await p
    return { t, s, lines, states }
  }

  it('frames several lines per message, text or binary, and ends each message', async () => {
    // Arrange
    const { s, lines } = await opened()
    // Act
    s.onmessage?.({ data: '{"t":"a"}\n{"t":"b"}' })
    s.onmessage?.({ data: new TextEncoder().encode('{"t":"c"}\n').buffer })
    s.onmessage?.({ data: 42 })
    // Assert
    expect(lines).toEqual(['{"t":"a"}', '{"t":"b"}', '{"t":"c"}'])
  })

  it('sends newline-terminated lines and drops non-critical ones over the buffer limit', async () => {
    // Arrange
    const { t, s } = await opened()
    // Act
    const a = t.write('{"t":"ping","id":1}')
    s.bufferedAmount = 20000
    const b = t.write('{"t":"cmd"}')
    const c = t.write('{"t":"estop"}', true)
    // Assert
    expect([a, b, c]).toEqual([true, false, true])
    expect(s.sent).toEqual(['{"t":"ping","id":1}\n', '{"t":"estop"}\n'])
  })

  it('reports a socket closed by the board, but not one closed by disconnect()', async () => {
    // Arrange
    const one = await opened()
    // Act
    one.s.close(1011, 'board closed (1006)')
    const two = await opened()
    await two.t.disconnect()
    // Assert
    expect(one.states).toEqual(['closed:socket closed (code 1011: board closed (1006))'])
    expect(two.states).toEqual([])
    expect(two.s.closedWith).toEqual([1000, 'client disconnect'])
    expect(two.t.write('x')).toBe(false)
  })
})
