#!/usr/bin/env node
/* ============================================================
   SIM CONSOLE WS RELAY: lets the hosted (HTTPS) app reach a
   board's plain ws:// WebSocket. Browsers block ws:// to a LAN IP
   from an https page (mixed content) but allow ws://localhost, so
   this script listens on 127.0.0.1:8787 and forwards every line to
   the board, and every board message back.

   Zero dependencies, Node 22+: node:http for the server side (a
   minimal RFC 6455 implementation below), Node's global WebSocket
   as the client that talks to the board.

     node tools/ws-relay.mjs ws://192.168.4.1:81 [--port 8787] [--host 127.0.0.1] [--open]

   Security: every web page can open a WebSocket to localhost, so
   the relay prints a one-time key and only accepts
   ws://localhost:<port>/?k=<key>. The Host header must name a
   loopback address too (DNS-rebinding guard). --open drops the key.
   ============================================================ */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const OP = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa })
/** Largest frame or reassembled message accepted (the protocol caps a line at 8 KiB). */
export const MAX_PAYLOAD = 64 * 1024
export const DEFAULT_PORT = 8787
export const DEFAULT_HOST = '127.0.0.1'
/** Lines queued for the board while its socket is still opening. */
const MAX_PENDING_LINES = 256
/** Stop forwarding to a browser that does not read (bytes buffered in the socket). */
const MAX_CLIENT_BACKLOG = 1 << 20
const KNOWN_OPCODES = new Set([OP.CONT, OP.TEXT, OP.BINARY, OP.CLOSE, OP.PING, OP.PONG])
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** A protocol violation; `code` is the WebSocket close code to send. */
export class FrameError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'FrameError'
    this.code = code
  }
}

/** Sec-WebSocket-Accept for a client's Sec-WebSocket-Key (RFC 6455 §4.2.2). */
export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/* ---------------- frame codec ---------------- */

/**
 * Encode one frame. Server frames are unmasked; pass a 4-byte `mask` to build a client frame.
 * @param {number} opcode
 * @param {string | Uint8Array} payload
 * @param {{ fin?: boolean, mask?: Uint8Array | null }} [opts]
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, opts = {}) {
  const fin = opts.fin ?? true
  const mask = opts.mask ?? null
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)
  const len = data.length
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8
  const head = Buffer.alloc(2 + ext + (mask ? 4 : 0))
  head[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  head[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127)
  if (ext === 2) head.writeUInt16BE(len, 2)
  else if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2)
  if (!mask) return Buffer.concat([head, data])
  head.set(mask.subarray(0, 4), 2 + ext)
  const body = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3]
  return Buffer.concat([head, body])
}

/** Payload length and where it ends, or null when the header is incomplete. */
function readLength(buf, maxPayload) {
  const short = buf[1] & 0x7f
  if (short < 126) return { len: short, off: 2 }
  if (short === 126) return buf.length < 4 ? null : { len: buf.readUInt16BE(2), off: 4 }
  if (buf.length < 10) return null
  const big = buf.readBigUInt64BE(2)
  if (big > BigInt(maxPayload)) throw new FrameError(1009, 'frame too large')
  return { len: Number(big), off: 10 }
}

/**
 * Decode one frame from the front of `buf`. Returns null when more bytes are needed,
 * else the frame and how many bytes it used. Throws FrameError on a protocol violation.
 * @param {Buffer} buf
 * @param {{ maxPayload?: number, requireMask?: boolean }} [opts]
 */
export function decodeFrame(buf, opts = {}) {
  const maxPayload = opts.maxPayload ?? MAX_PAYLOAD
  if (buf.length < 2) return null
  const b0 = buf[0]
  if (b0 & 0x70) throw new FrameError(1002, 'reserved bits set (no extensions negotiated)')
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  if (!KNOWN_OPCODES.has(opcode)) throw new FrameError(1002, `unknown opcode ${opcode}`)
  if (opts.requireMask && !masked) throw new FrameError(1002, 'client frames must be masked')
  const head = readLength(buf, maxPayload)
  if (!head) return null
  if (opcode >= 0x8 && (head.len > 125 || !fin)) throw new FrameError(1002, 'control frames must be short and unfragmented')
  if (head.len > maxPayload) throw new FrameError(1009, 'frame too large')
  const start = head.off + (masked ? 4 : 0)
  if (buf.length < start + head.len) return null
  const payload = Buffer.from(buf.subarray(start, start + head.len))
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[head.off + (i & 3)]
  return { fin, opcode, masked, payload, length: start + head.len }
}

/** Close frame payload → { code, reason } (1005 = no code given). */
export function parseClose(payload) {
  if (payload.length === 0) return { code: 1005, reason: '' }
  if (payload.length === 1) throw new FrameError(1002, 'close payload of one byte')
  return { code: payload.readUInt16BE(0), reason: decodeText(payload.subarray(2)) }
}

export function closePayload(code, reason = '') {
  const r = Buffer.from(reason.slice(0, 100), 'utf8').subarray(0, 123)
  const b = Buffer.alloc(2 + r.length)
  b.writeUInt16BE(code, 0)
  r.copy(b, 2)
  return b
}

function decodeText(bytes) {
  try {
    return utf8.decode(bytes)
  } catch {
    throw new FrameError(1007, 'text is not valid UTF-8')
  }
}

/**
 * Per-connection reader: buffers partial frames, reassembles fragmented messages
 * and turns frames into events ({ type: 'text' | 'binary' | 'ping' | 'pong' | 'close' }).
 */
export class FrameReader {
  /** @param {{ maxMessage?: number, requireMask?: boolean }} [opts] */
  constructor(opts = {}) {
    this.maxMessage = opts.maxMessage ?? MAX_PAYLOAD
    this.requireMask = opts.requireMask ?? true
    this.buf = Buffer.alloc(0)
    /** @type {{ opcode: number, parts: Buffer[], size: number } | null} */
    this.partial = null
  }

  /** @param {Buffer} chunk @returns {Array<{ type: string, data?: string | Buffer, code?: number, reason?: string }>} */
  push(chunk) {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
    const events = []
    for (;;) {
      const f = decodeFrame(this.buf, { maxPayload: this.maxMessage, requireMask: this.requireMask })
      if (!f) break
      this.buf = this.buf.subarray(f.length)
      const ev = this.onFrame(f)
      if (ev) events.push(ev)
    }
    return events
  }

  onFrame(f) {
    if (f.opcode === OP.PING) return { type: 'ping', data: f.payload }
    if (f.opcode === OP.PONG) return { type: 'pong', data: f.payload }
    if (f.opcode === OP.CLOSE) return { type: 'close', ...parseClose(f.payload) }
    if (f.opcode === OP.CONT) {
      if (!this.partial) throw new FrameError(1002, 'continuation without a message')
      return this.append(f)
    }
    if (this.partial) throw new FrameError(1002, 'new message inside a fragmented one')
    this.partial = { opcode: f.opcode, parts: [], size: 0 }
    return this.append(f)
  }

  append(f) {
    const p = /** @type {{ opcode: number, parts: Buffer[], size: number }} */ (this.partial)
    p.size += f.payload.length
    if (p.size > this.maxMessage) throw new FrameError(1009, 'message too large')
    p.parts.push(f.payload)
    if (!f.fin) return null
    this.partial = null
    const data = Buffer.concat(p.parts)
    return p.opcode === OP.TEXT ? { type: 'text', data: decodeText(data) } : { type: 'binary', data }
  }
}

/** NDJSON lines of a message: CRLF tolerant, empty lines dropped. */
export function splitLines(text) {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0)
}

/* ---------------- handshake checks ---------------- */

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i

/** Constant-time string compare (the relay key). */
function sameSecret(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Validate an upgrade request. `key` is the relay's one-time key (ignored when `open`).
 * @param {{ headers: Record<string, string | string[] | undefined>, url?: string }} req
 * @param {{ key: string, open: boolean }} opts
 * @returns {{ ok: true } | { ok: false, status: number, reason: string }}
 */
export function checkUpgrade(req, opts) {
  const h = req.headers
  const upgrade = String(h.upgrade ?? '').toLowerCase()
  const connection = String(h.connection ?? '').toLowerCase()
  if (upgrade !== 'websocket' || !connection.split(',').some((t) => t.trim() === 'upgrade')) {
    return { ok: false, status: 400, reason: 'Bad Request' }
  }
  if (String(h['sec-websocket-version'] ?? '') !== '13') return { ok: false, status: 426, reason: 'Upgrade Required' }
  const wsKey = String(h['sec-websocket-key'] ?? '')
  if (Buffer.from(wsKey, 'base64').length !== 16) return { ok: false, status: 400, reason: 'Bad Request' }
  if (!LOOPBACK_HOST.test(String(h.host ?? ''))) return { ok: false, status: 403, reason: 'Forbidden' }
  if (opts.open) return { ok: true }
  const k = new URL(req.url ?? '/', 'ws://localhost').searchParams.get('k') ?? ''
  if (!sameSecret(k, opts.key)) return { ok: false, status: 403, reason: 'Forbidden' }
  return { ok: true }
}

/* ---------------- arguments ---------------- */

export const USAGE = 'usage: node tools/ws-relay.mjs ws://<board-ip>:81 [--port 8787] [--host 127.0.0.1] [--open]'

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ boardUrl: string, port: number, host: string, open: boolean }}
 */
export function parseArgs(argv) {
  const out = { boardUrl: '', port: DEFAULT_PORT, host: DEFAULT_HOST, open: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--open') out.open = true
    else if (a === '--port' || a === '--host') {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`)
      if (a === '--host') out.host = v
      else out.port = Number(v)
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n${USAGE}`)
    else out.boardUrl = a
  }
  if (!out.boardUrl) throw new Error(`missing the board URL\n${USAGE}`)
  let url
  try {
    url = new URL(out.boardUrl)
  } catch {
    throw new Error(`not a URL: ${out.boardUrl}\n${USAGE}`)
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`the board URL must start with ws:// or wss://\n${USAGE}`)
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error(`bad port ${out.port}\n${USAGE}`)
  out.boardUrl = url.href
  return out
}

/* ---------------- relay session ---------------- */

/** One browser connection and its board connection. */
class RelaySession {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{ boardUrl: string, log: (msg: string) => void, BoardSocket: typeof WebSocket }} opts
   * @param {() => void} onEnd
   */
  constructor(socket, opts, onEnd) {
    this.socket = socket
    this.log = opts.log
    this.onEnd = onEnd
    this.reader = new FrameReader({ requireMask: true })
    this.pending = []
    this.closed = false
    this.board = new opts.BoardSocket(opts.boardUrl)
    this.board.binaryType = 'arraybuffer'
    this.board.onopen = () => this.onBoardOpen(opts.boardUrl)
    this.board.onmessage = (e) => this.onBoardMessage(e.data)
    this.board.onerror = () => this.log(`board socket error (${opts.boardUrl})`)
    this.board.onclose = (e) => this.close(1011, `board closed (${e.code})`)
    socket.on('data', (chunk) => this.onClientData(chunk))
    socket.on('error', () => this.close(1006, 'client socket error', false))
    socket.on('close', () => this.close(1006, 'client gone', false))
  }

  onBoardOpen(url) {
    this.log(`board connected: ${url}`)
    for (const line of this.pending) this.board.send(line)
    this.pending = []
  }

  onBoardMessage(data) {
    if (this.closed) return
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    if (this.socket.writableLength > MAX_CLIENT_BACKLOG) return
    this.socket.write(encodeFrame(OP.TEXT, text))
  }

  onClientData(chunk) {
    let events
    try {
      events = this.reader.push(chunk)
    } catch (e) {
      const code = e instanceof FrameError ? e.code : 1011
      return this.close(code, e instanceof Error ? e.message : 'protocol error')
    }
    for (const ev of events) this.onClientEvent(ev)
  }

  onClientEvent(ev) {
    if (ev.type === 'ping') this.socket.write(encodeFrame(OP.PONG, ev.data ?? Buffer.alloc(0)))
    else if (ev.type === 'close') this.close(1000, 'bye')
    else if (ev.type === 'binary') this.close(1003, 'text frames only')
    else if (ev.type === 'text') for (const line of splitLines(String(ev.data))) this.toBoard(`${line}\n`)
  }

  toBoard(line) {
    if (this.board.readyState === 1) this.board.send(line)
    else if (this.board.readyState === 0 && this.pending.length < MAX_PENDING_LINES) this.pending.push(line)
  }

  /** Close both sides once. `sendFrame` = the client socket is still writable. */
  close(code, reason, sendFrame = true) {
    if (this.closed) return
    this.closed = true
    this.log(`session closed: ${reason}`)
    if (sendFrame && this.socket.writable) this.socket.end(encodeFrame(OP.CLOSE, closePayload(code, reason)))
    else this.socket.destroy()
    if (this.board.readyState <= 1) this.board.close()
    this.onEnd()
  }
}

/* ---------------- server ---------------- */

function handshakeResponse(wsKey) {
  return ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(wsKey)}`, '', ''].join('\r\n')
}

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * Start the relay. Resolves once listening.
 * @param {{ boardUrl: string, port?: number, host?: string, open?: boolean, key?: string,
 *           log?: (msg: string) => void, BoardSocket?: typeof WebSocket }} opts
 */
export function startRelay(opts) {
  const key = opts.key ?? randomBytes(9).toString('base64url')
  const open = opts.open ?? false
  const log = opts.log ?? (() => {})
  const BoardSocket = opts.BoardSocket ?? globalThis.WebSocket
  if (typeof BoardSocket !== 'function') return Promise.reject(new Error('this Node has no global WebSocket: use Node 22 or newer'))
  /** @type {RelaySession | null} */
  let session = null
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket' })
    res.end('SIM CONSOLE ws-relay: connect the app with the ws:// URL printed in the terminal.\n')
  })
  server.on('upgrade', (req, socket) => {
    const chk = checkUpgrade(req, { key, open })
    if (!chk.ok) {
      log(`refused ${req.headers.origin ?? 'unknown origin'}: ${chk.status} ${chk.reason}`)
      return rejectUpgrade(socket, chk.status, chk.reason)
    }
    // one app at a time: a reconnecting tab replaces the old session
    session?.close(1000, 'replaced by a new connection')
    socket.setNoDelay(true)
    socket.write(handshakeResponse(String(req.headers['sec-websocket-key'])))
    log(`app connected from ${req.headers.origin ?? 'unknown origin'}`)
    const s = new RelaySession(socket, { boardUrl: opts.boardUrl, log, BoardSocket }, () => {
      if (session === s) session = null
    })
    session = s
  })
  return new Promise((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? DEFAULT_PORT, opts.host ?? DEFAULT_HOST, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? DEFAULT_PORT
      const url = `ws://localhost:${port}/${open ? '' : `?k=${key}`}`
      resolveStart({
        server,
        port,
        url,
        key,
        close: () =>
          new Promise((done) => {
            session?.close(1001, 'relay shutting down')
            server.close(() => done(undefined))
          }),
      })
    })
  })
}

/* ---------------- CLI ---------------- */

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(2)
  }
  const out = (msg) => process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${msg}\n`)
  const relay = await startRelay({ ...args, log: out })
  process.stdout.write(
    [
      '',
      'SIM CONSOLE ws-relay',
      `  board  ${args.boardUrl}`,
      `  listen ${relay.url}`,
      '',
      'In the app: drive source HARDWARE, transport WIFI, paste the listen URL, CONNECT.',
      args.open ? 'WARNING: --open accepts any web page on this PC. Use it only for testing.' : 'The key in the URL keeps other web pages from using the relay.',
      'Ctrl+C stops the relay.',
      '',
    ].join('\n'),
  )
  const stop = () => void relay.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/** True when run as a script (not imported by the tests). Windows paths compare case-insensitively. */
function isMain() {
  if (!process.argv[1]) return false
  const invoked = pathToFileURL(resolve(process.argv[1])).href
  return process.platform === 'win32' ? invoked.toLowerCase() === import.meta.url.toLowerCase() : invoked === import.meta.url
}

if (isMain()) void main()
