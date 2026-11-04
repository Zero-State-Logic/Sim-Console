import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FrameError,
  FrameReader,
  MAX_PAYLOAD,
  OP,
  acceptKey,
  checkUpgrade,
  closePayload,
  decodeFrame,
  encodeFrame,
  parseArgs,
  parseClose,
  splitLines,
  startRelay,
} from './ws-relay.mjs'

const MASK = Uint8Array.from([0x37, 0xfa, 0x21, 0x3d])

function frameError(fn: () => unknown): FrameError {
  try {
    fn()
  } catch (e) {
    if (e instanceof FrameError) return e
    throw e
  }
  throw new Error('expected a FrameError')
}

describe('handshake', () => {
  it('computes Sec-WebSocket-Accept exactly as the RFC 6455 example', () => {
    // Arrange / Act
    const accept = acceptKey('dGhlIHNhbXBsZSBub25jZQ==')
    // Assert
    expect(accept).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  const goodHeaders = {
    upgrade: 'websocket',
    connection: 'keep-alive, Upgrade',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    host: 'localhost:8787',
  }

  it('accepts a well-formed upgrade carrying the right key', () => {
    expect(checkUpgrade({ headers: goodHeaders, url: '/?k=s3cret' }, { key: 's3cret', open: false })).toEqual({ ok: true })
  })

  it('refuses a wrong or missing key with 403, unless the relay runs --open', () => {
    expect(checkUpgrade({ headers: goodHeaders, url: '/?k=nope' }, { key: 's3cret', open: false })).toMatchObject({ ok: false, status: 403 })
    expect(checkUpgrade({ headers: goodHeaders, url: '/' }, { key: 's3cret', open: false })).toMatchObject({ ok: false, status: 403 })
    expect(checkUpgrade({ headers: goodHeaders, url: '/' }, { key: 's3cret', open: true })).toEqual({ ok: true })
  })

  it('refuses a non-loopback Host header (DNS rebinding) even with the key', () => {
    const headers = { ...goodHeaders, host: 'evil.example:8787' }
    expect(checkUpgrade({ headers, url: '/?k=s3cret' }, { key: 's3cret', open: false })).toMatchObject({ ok: false, status: 403 })
    expect(checkUpgrade({ headers: { ...goodHeaders, host: '127.0.0.1:8787' }, url: '/?k=s3cret' }, { key: 's3cret', open: false }).ok).toBe(true)
    expect(checkUpgrade({ headers: { ...goodHeaders, host: '[::1]:8787' }, url: '/?k=s3cret' }, { key: 's3cret', open: false }).ok).toBe(true)
  })

  it('rejects requests that are not WebSocket version 13 upgrades', () => {
    const opts = { key: 'k', open: true }
    expect(checkUpgrade({ headers: { ...goodHeaders, upgrade: 'h2c' } }, opts)).toMatchObject({ status: 400 })
    expect(checkUpgrade({ headers: { ...goodHeaders, 'sec-websocket-version': '8' } }, opts)).toMatchObject({ status: 426 })
    expect(checkUpgrade({ headers: { ...goodHeaders, 'sec-websocket-key': 'short' } }, opts)).toMatchObject({ status: 400 })
  })
})

describe('frame codec', () => {
  it('decodes the RFC 6455 single-frame unmasked and masked "Hello" examples', () => {
    // Arrange
    const unmasked = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f])
    const masked = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
    // Act
    const a = decodeFrame(unmasked)
    const b = decodeFrame(masked)
    // Assert
    expect(a?.payload.toString()).toBe('Hello')
    expect(a?.masked).toBe(false)
    expect(b?.payload.toString()).toBe('Hello')
    expect(b?.masked).toBe(true)
    expect(b?.length).toBe(masked.length)
  })

  it('encodes the RFC masked example byte for byte', () => {
    const f = encodeFrame(OP.TEXT, 'Hello', { mask: MASK })
    expect([...f]).toEqual([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
  })

  it.each([0, 1, 125, 126, 1000, 65535, 65536])('round-trips a %i-byte payload with the right length encoding', (n) => {
    // Arrange
    const payload = Buffer.alloc(n, 0x61)
    // Act
    const plain = encodeFrame(OP.BINARY, payload)
    const masked = encodeFrame(OP.BINARY, payload, { mask: MASK })
    const d1 = decodeFrame(plain, { maxPayload: 1 << 20 })
    const d2 = decodeFrame(masked, { maxPayload: 1 << 20 })
    // Assert
    expect(plain[1] & 0x7f).toBe(n < 126 ? n : n < 65536 ? 126 : 127)
    expect(d1?.payload.equals(payload)).toBe(true)
    expect(d2?.payload.equals(payload)).toBe(true)
    expect(d1?.length).toBe(plain.length)
  })

  it('returns null until a split frame is complete (header and payload)', () => {
    const f = encodeFrame(OP.TEXT, 'x'.repeat(300), { mask: MASK })
    for (const cut of [1, 3, 7, 50, f.length - 1]) expect(decodeFrame(f.subarray(0, cut))).toBeNull()
    expect(decodeFrame(f)?.payload.toString()).toBe('x'.repeat(300))
  })

  it('rejects reserved bits, unknown opcodes, long or fragmented control frames, oversize and unmasked client frames', () => {
    expect(frameError(() => decodeFrame(Buffer.from([0xc1, 0x00]))).code).toBe(1002)
    expect(frameError(() => decodeFrame(Buffer.from([0x83, 0x00]))).code).toBe(1002)
    expect(frameError(() => decodeFrame(encodeFrame(OP.PING, Buffer.alloc(126)))).code).toBe(1002)
    expect(frameError(() => decodeFrame(encodeFrame(OP.PING, 'x', { fin: false }))).code).toBe(1002)
    expect(frameError(() => decodeFrame(encodeFrame(OP.TEXT, Buffer.alloc(MAX_PAYLOAD + 1)))).code).toBe(1009)
    expect(frameError(() => decodeFrame(encodeFrame(OP.TEXT, 'hi'), { requireMask: true })).code).toBe(1002)
  })

  it('refuses a 64-bit length beyond the cap before buffering the payload', () => {
    const head = Buffer.alloc(10)
    head[0] = 0x82
    head[1] = 127
    head.writeBigUInt64BE(2n ** 40n, 2)
    expect(frameError(() => decodeFrame(head)).code).toBe(1009)
  })

  it('parses and builds close payloads', () => {
    expect(parseClose(closePayload(1011, 'board closed'))).toEqual({ code: 1011, reason: 'board closed' })
    expect(parseClose(Buffer.alloc(0))).toEqual({ code: 1005, reason: '' })
    expect(frameError(() => parseClose(Buffer.from([3]))).code).toBe(1002)
  })
})

describe('FrameReader', () => {
  it('reassembles a fragmented text message with a ping interleaved, across arbitrary chunking', () => {
    // Arrange
    const reader = new FrameReader({ requireMask: true })
    const wire = Buffer.concat([
      encodeFrame(OP.TEXT, '{"t":"pi', { fin: false, mask: MASK }),
      encodeFrame(OP.PING, 'p', { mask: MASK }),
      encodeFrame(OP.CONT, 'ng","id":7}', { mask: MASK }),
    ])
    const events = []
    // Act: feed 3 bytes at a time
    for (let i = 0; i < wire.length; i += 3) events.push(...reader.push(wire.subarray(i, i + 3)))
    // Assert
    expect(events.map((e) => e.type)).toEqual(['ping', 'text'])
    expect(events[1].data).toBe('{"t":"ping","id":7}')
  })

  it('reports close frames with their code and reason', () => {
    const reader = new FrameReader({ requireMask: true })
    const [ev] = reader.push(encodeFrame(OP.CLOSE, closePayload(1000, 'bye'), { mask: MASK }))
    expect(ev).toEqual({ type: 'close', code: 1000, reason: 'bye' })
  })

  it('fails invalid UTF-8 text with 1007 and stray continuations with 1002', () => {
    expect(frameError(() => new FrameReader().push(encodeFrame(OP.TEXT, Buffer.from([0xc3, 0x28]), { mask: MASK }))).code).toBe(1007)
    expect(frameError(() => new FrameReader().push(encodeFrame(OP.CONT, 'x', { mask: MASK }))).code).toBe(1002)
  })

  it('caps the reassembled message size', () => {
    const reader = new FrameReader({ maxMessage: 10 })
    reader.push(encodeFrame(OP.TEXT, '123456', { fin: false, mask: MASK }))
    expect(frameError(() => reader.push(encodeFrame(OP.CONT, '123456', { mask: MASK }))).code).toBe(1009)
  })
})

describe('lines and arguments', () => {
  it('splits NDJSON messages into lines, tolerating CRLF and dropping blanks', () => {
    expect(splitLines('{"a":1}\r\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitLines('{"c":3}')).toEqual(['{"c":3}'])
  })

  it('parses the board URL and options, with safe defaults', () => {
    expect(parseArgs(['ws://192.168.4.1:81'])).toEqual({ boardUrl: 'ws://192.168.4.1:81/', port: 8787, host: '127.0.0.1', open: false })
    expect(parseArgs(['--port', '9000', 'wss://bot.local:81', '--open'])).toMatchObject({ port: 9000, open: true, boardUrl: 'wss://bot.local:81/' })
  })

  it('explains a missing, malformed or non-WebSocket board URL and bad options', () => {
    expect(() => parseArgs([])).toThrow(/missing the board URL/)
    expect(() => parseArgs(['http://192.168.4.1'])).toThrow(/ws:\/\/ or wss:\/\//)
    expect(() => parseArgs(['nonsense'])).toThrow(/not a URL/)
    expect(() => parseArgs(['ws://x', '--port'])).toThrow(/needs a value/)
    expect(() => parseArgs(['ws://x', '--port', '99999'])).toThrow(/bad port/)
    expect(() => parseArgs(['ws://x', '--bogus'])).toThrow(/unknown option/)
  })
})

/* ---------------- end to end over real sockets ---------------- */

interface FakeBoard {
  url: string
  received: string[]
  close(): Promise<void>
  dropClients(): void
}

/** A board-side WebSocket server built from the relay's own codec: answers ping with pong. */
function startFakeBoard(): Promise<FakeBoard> {
  const received: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer()
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`)
    const reader = new FrameReader({ requireMask: true })
    socket.on('data', (chunk: Buffer) => {
      for (const ev of reader.push(chunk)) {
        if (ev.type !== 'text') continue
        for (const line of splitLines(String(ev.data))) {
          received.push(line)
          const msg = JSON.parse(line) as { t: string; id?: number }
          if (msg.t === 'ping') socket.write(encodeFrame(OP.TEXT, `${JSON.stringify({ t: 'pong', id: msg.id })}\n`))
        }
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        dropClients: () => {
          for (const s of sockets) s.destroy()
        },
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true }))
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('socket error')), { once: true })
  })
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true }))
}

describe('relay end to end (app ⇄ relay ⇄ board)', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  it('forwards app lines to the board and board messages back, then reports a board drop as 1011', async () => {
    // Arrange
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const relay = await startRelay({ boardUrl: board.url, port: 0, key: 'k3y' })
    cleanups.push(() => relay.close())
    const app = new WebSocket(`ws://127.0.0.1:${relay.port}/?k=k3y`)
    cleanups.push(() => app.close())
    await opened(app)
    // Act
    const reply = nextMessage(app)
    app.send('{"t":"hello?"}\n{"t":"ping","id":7}\n')
    // Assert
    expect(await reply).toBe('{"t":"pong","id":7}\n')
    expect(board.received).toEqual(['{"t":"hello?"}', '{"t":"ping","id":7}'])
    const done = closed(app)
    board.dropClients()
    expect((await done).code).toBe(1011)
  }, 10_000)

  it('refuses an app that does not present the key', async () => {
    // Arrange
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const relay = await startRelay({ boardUrl: board.url, port: 0, key: 'k3y' })
    cleanups.push(() => relay.close())
    // Act
    const app = new WebSocket(`ws://127.0.0.1:${relay.port}/?k=wrong`)
    const result = await new Promise<string>((resolve) => {
      app.addEventListener('open', () => resolve('open'), { once: true })
      app.addEventListener('error', () => resolve('error'), { once: true })
    })
    // Assert
    expect(result).toBe('error')
    expect(board.received).toEqual([])
  }, 10_000)

  it('prints a localhost URL carrying the key', async () => {
    const relay = await startRelay({ boardUrl: 'ws://127.0.0.1:9/', port: 0, key: 'abc' })
    cleanups.push(() => relay.close())
    expect(relay.url).toBe(`ws://localhost:${relay.port}/?k=abc`)
  })
})
