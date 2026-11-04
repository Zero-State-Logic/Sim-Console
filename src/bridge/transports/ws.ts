import { checkWsUrl, wsUnreachable } from '../link/env'
import { LineFramer } from '../link/framing'
import type { Transport, TransportEventState } from '../types'
import { TransportEvents } from './emitter'

/* ============================================================
   WEBSOCKET — ESP32 / Pico W / Pi Zero 2 W on ws://<ip>:81, or the
   local relay (tools/ws-relay.mjs) on ws://localhost:8787. Each
   message may hold one or several lines; all go through the framer.
   ============================================================ */

const CONNECT_TIMEOUT_MS = 5000
/** Above this many unsent bytes, non-critical lines are dropped. */
const MAX_BUFFERED = 16384

/** Thrown when the URL is unusable from this page or nothing answered; carries the guidance for the panel. */
export class WsUrlError extends Error {
  constructor(message: string, readonly guidance: string[]) {
    super(message)
    this.name = 'WsUrlError'
  }
}

export class WsTransport implements Transport {
  readonly id = 'ws' as const
  private readonly ev = new TransportEvents()
  private readonly framer = new LineFramer({ onLine: (l) => this.ev.line(l), onOversize: (b) => this.ev.drop(b) })
  private readonly decoder = new TextDecoder()
  private sock: WebSocket | null = null
  private closing = false

  constructor(private readonly url: string) {}

  isSupported(): boolean {
    return typeof WebSocket !== 'undefined'
  }

  connect(): Promise<void> {
    const check = checkWsUrl(this.url, { protocol: location.protocol, hostname: location.hostname })
    if (!check.ok) return Promise.reject(new WsUrlError(check.message, check.guidance))
    this.closing = false
    this.framer.reset()
    return new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(check.url)
      sock.binaryType = 'arraybuffer'
      this.sock = sock
      let opened = false
      const fail = (timedOut: boolean): void => {
        const f = wsUnreachable(check.url, timedOut)
        reject(new WsUrlError(f.message, f.guidance))
      }
      const timer = setTimeout(() => {
        if (opened) return
        sock.close()
        fail(true)
      }, CONNECT_TIMEOUT_MS)
      sock.onopen = () => {
        opened = true
        clearTimeout(timer)
        resolve()
      }
      sock.onerror = () => {
        // the browser hides the reason on purpose; onclose follows with a code
        if (!opened) {
          clearTimeout(timer)
          fail(false)
        }
      }
      sock.onclose = (e) => {
        clearTimeout(timer)
        this.sock = null
        if (opened && !this.closing) this.ev.state('closed', `socket closed (code ${e.code}${e.reason ? `: ${e.reason}` : ''})`)
      }
      sock.onmessage = (e: MessageEvent) => this.onMessage(e.data)
    })
  }

  async disconnect(): Promise<void> {
    this.closing = true
    const s = this.sock
    this.sock = null
    if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) s.close(1000, 'client disconnect')
  }

  write(line: string, critical = false): boolean {
    const s = this.sock
    if (!s || s.readyState !== WebSocket.OPEN) return false
    if (!critical && s.bufferedAmount > MAX_BUFFERED) return false
    s.send(`${line}\n`)
    return true
  }

  onLine(fn: (line: string) => void): () => void {
    return this.ev.onLine(fn)
  }

  onState(fn: (s: TransportEventState, detail?: string) => void): () => void {
    return this.ev.onState(fn)
  }

  onDrop(fn: (bytes: number) => void): () => void {
    return this.ev.onDrop(fn)
  }

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? this.decoder.decode(data) : ''
    if (!text) return
    // a message is a complete unit: terminate it so the last line is not held back
    this.framer.push(text.endsWith('\n') ? text : `${text}\n`)
  }
}
