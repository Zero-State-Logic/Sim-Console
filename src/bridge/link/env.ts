import type { TransportId } from '../../core/protocol'

/* ============================================================
   ENVIRONMENT CHECKS — pure, so they run in Node tests.
   WebSocket URL / mixed-content rules, Web Serial / Bluetooth
   feature detection, and friendly connect-error text.
   ============================================================ */

export const RELAY_URL = 'ws://localhost:8787'

export interface PageLocation {
  protocol: string
  hostname: string
}

export type WsUrlCheck =
  | { ok: true; url: string; secure: boolean }
  | { ok: false; reason: 'empty' | 'invalid' | 'scheme' | 'mixed-content'; message: string; guidance: string[] }

const MIXED_GUIDANCE = [
  'Use USB SERIAL or BLUETOOTH, which work from this HTTPS page.',
  'Or run the app locally with npm run dev (http://localhost may open ws:// links).',
  `Or run node tools/ws-relay.mjs ws://<board-ip>:81 on this PC and connect to the URL it prints (${RELAY_URL}/?k=...).`,
]

/** Hosts browsers treat as potentially trustworthy, so ws:// to them is allowed from https. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/** Validate a board WebSocket URL and detect mixed content against the page origin. */
export function checkWsUrl(raw: string, page: PageLocation): WsUrlCheck {
  const text = raw.trim()
  if (text.length === 0) return { ok: false, reason: 'empty', message: 'Enter the board URL, e.g. ws://192.168.4.1:81', guidance: [] }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'invalid', message: `"${text}" is not a valid URL`, guidance: ['Format: ws://<board-ip>:81'] }
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return {
      ok: false,
      reason: 'scheme',
      message: `URL must start with ws:// or wss:// (got ${url.protocol}//)`,
      guidance: ['The generated firmware serves a WebSocket on port 81: ws://<board-ip>:81'],
    }
  }
  const secure = url.protocol === 'wss:'
  if (page.protocol === 'https:' && !secure && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      reason: 'mixed-content',
      message: `This page is HTTPS, so the browser blocks ws:// to ${url.hostname} (mixed content).`,
      guidance: MIXED_GUIDANCE,
    }
  }
  return { ok: true, url: url.href, secure }
}

export interface WsFailure {
  message: string
  guidance: string[]
}

/**
 * Why a WebSocket that never opened failed. Browsers hide the reason on purpose, so the
 * advice depends on the target: a loopback URL is the local relay (often missing its key).
 */
export function wsUnreachable(url: string, timedOut: boolean): WsFailure {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    /* checkWsUrl already validated it; keep the generic advice */
  }
  const how = timedOut ? 'did not answer within 5 s' : 'refused or did not answer'
  if (host && isLoopbackHost(host)) {
    return {
      message: `The local relay at ${url} ${how}.`,
      guidance: [
        'Start it on this PC: node tools/ws-relay.mjs ws://<board-ip>:81',
        'Paste the full URL it prints, including ?k=<key>: without the key the relay refuses the connection.',
      ],
    }
  }
  return {
    message: `The board at ${url} ${how}.`,
    guidance: [
      "Check that the board is powered and on the same WiFi network (or that this PC joined the board's access point).",
      'Check the IP address (the firmware prints it on USB serial at boot) and that it listens on port 81.',
    ],
  }
}

/** The minimal view of the browser needed for feature detection. */
export interface BrowserEnv {
  hasSerial: boolean
  hasBluetooth: boolean
  hasWebSocket: boolean
  isSecureContext: boolean
  userAgent: string
}

export interface TransportSupport {
  supported: boolean
  /** Why not, for the notice in the panel. */
  reason?: string
}

function browserName(ua: string): string {
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Edg\//.test(ua)) return 'Edge'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return 'this browser'
}

export function transportSupport(id: TransportId, env: BrowserEnv): TransportSupport {
  if (id === 'loopback') return { supported: true }
  if (id === 'ws') {
    return env.hasWebSocket ? { supported: true } : { supported: false, reason: 'This browser has no WebSocket support.' }
  }
  const api = id === 'serial' ? 'Web Serial' : 'Web Bluetooth'
  const has = id === 'serial' ? env.hasSerial : env.hasBluetooth
  if (!env.isSecureContext) {
    return { supported: false, reason: `${api} needs a secure page: open the app over HTTPS or from http://localhost.` }
  }
  if (!has) {
    const where = id === 'serial' ? 'Chrome or Edge on desktop' : 'Chrome or Edge on desktop or Android'
    return { supported: false, reason: `${api} is not available in ${browserName(env.userAgent)}. Use ${where}.` }
  }
  return { supported: true }
}

/** Read the real browser (guarded so it also runs in Node). */
export function readBrowserEnv(): BrowserEnv {
  const nav = typeof navigator === 'undefined' ? null : navigator
  return {
    hasSerial: !!nav && 'serial' in nav,
    hasBluetooth: !!nav && 'bluetooth' in nav,
    hasWebSocket: typeof WebSocket !== 'undefined',
    isSecureContext: typeof isSecureContext === 'boolean' ? isSecureContext : false,
    userAgent: nav?.userAgent ?? '',
  }
}

export interface ConnectErrorInfo {
  /** The user dismissed the device chooser: not an error. */
  cancelled: boolean
  message: string
  detail?: string
}

/** Turn a DOMException from requestPort / requestDevice / open into actionable text. */
export function describeConnectError(e: unknown, transport: TransportId): ConnectErrorInfo {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : ''
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error'
  if (name === 'NotFoundError' && /select|chooser|cancel/i.test(raw)) {
    return { cancelled: true, message: 'No device selected.' }
  }
  if (name === 'NotFoundError') return { cancelled: false, message: 'Device not found.', detail: raw }
  if (name === 'WsUrlError') {
    const g = (e as { guidance?: unknown }).guidance
    return { cancelled: false, message: raw, detail: Array.isArray(g) ? g.filter((x) => typeof x === 'string').join(' ') : undefined }
  }
  if (name === 'SecurityError') {
    return { cancelled: false, message: 'The browser blocked access.', detail: 'Device access needs HTTPS (or localhost) and a click on CONNECT. ' + raw }
  }
  if (transport === 'serial' && (name === 'NetworkError' || name === 'InvalidStateError')) {
    return {
      cancelled: false,
      message: 'Could not open the serial port.',
      detail: 'Another program may hold it: close the Arduino Serial Monitor, PlatformIO monitor or another tab. ' + raw,
    }
  }
  if (transport === 'ble' && name === 'NetworkError') {
    return { cancelled: false, message: 'Bluetooth connection failed.', detail: 'Move closer, power-cycle the board and retry. ' + raw }
  }
  if (transport === 'ble' && name === 'NotSupportedError') {
    return { cancelled: false, message: 'The device has no Nordic UART service.', detail: 'Flash the kiyobridge BLE firmware. ' + raw }
  }
  return { cancelled: false, message: 'Connection failed.', detail: raw }
}
