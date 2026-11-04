'use strict'

/* ============================================================
   DESKTOP HELPERS: the pure parts of the desktop shell
   (electron/main.cjs). No Electron and no file-system access,
   so Vitest covers them in plain Node: MIME lookup, safe path
   resolution, origin and permission rules, device labels, the
   Bluetooth chooser state machine and the menu template.
   ============================================================ */

const nodePath = require('node:path')

const REPO_URL = 'https://github.com/Zero-State-Logic/Sim-Console'

const LINKS = Object.freeze({
  project: REPO_URL,
  issues: `${REPO_URL}/issues`,
  releases: `${REPO_URL}/releases/latest`,
})

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
])

const DEFAULT_MIME = 'application/octet-stream'

/** Content-Type for a file name, by extension (case-insensitive). */
function mimeTypeFor(fileName) {
  const ext = nodePath.extname(String(fileName)).toLowerCase()
  return MIME_TYPES.get(ext) ?? DEFAULT_MIME
}

/**
 * Segments no build output uses and Windows treats specially: device names (CON, NUL,
 * COM1...), and names ending in a dot or space, which it trims ('.. ' would become '..').
 */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$|[. ]$/i

/**
 * Map a request URL ('/assets/x.js?v=1') to an absolute file inside root, or null when the
 * path is malformed or would leave root. Backslashes count as separators on every OS, '..'
 * and drive or stream colons are rejected outright, and the joined path is checked once more.
 */
function resolveSafePath(root, requestUrl, pathImpl = nodePath) {
  if (typeof requestUrl !== 'string' || !requestUrl.startsWith('/')) return null
  const rawPath = requestUrl.split(/[?#]/, 1)[0]
  let decoded
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const segments = decoded.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..' || s.includes(':') || RESERVED_SEGMENT.test(s))) return null
  const wantsIndex = segments.length === 0 || /[\\/]$/.test(decoded)
  const base = pathImpl.resolve(root)
  const full = pathImpl.resolve(base, ...segments, ...(wantsIndex ? ['index.html'] : []))
  const inside = pathImpl.relative(base, full)
  if (inside === '' || inside === '..' || inside.startsWith(`..${pathImpl.sep}`) || pathImpl.isAbsolute(inside)) return null
  return full
}

/** The Host header names this machine (DNS-rebinding guard for the local server). */
function isLoopbackHostHeader(host) {
  if (typeof host !== 'string' || !/^[^@/\\?#\s]+$/.test(host)) return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/** Both URLs parse and share scheme, host and port. Opaque origins never match. */
function sameOrigin(a, b) {
  try {
    const origin = new URL(a).origin
    return origin !== 'null' && origin === new URL(b).origin
  } catch {
    return false
  }
}

/** Links the shell may hand to the default browser: https only. */
function isExternalHttpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * What the app's own page may use. Serial for USB boards, clipboard writes for the firmware
 * dialog, fullscreen, and the local-network family so ws:// links reach boards on the LAN.
 * Everything else (camera, microphone, location, notifications...) is refused.
 */
const ALLOWED_PERMISSIONS = new Set([
  'serial',
  'clipboard-sanitized-write',
  'fullscreen',
  'local-network-access',
  'local-network',
  'loopback-network',
])

function isPermissionAllowed(permission, requestingUrl, appUrl) {
  return ALLOWED_PERMISSIONS.has(permission) && sameOrigin(requestingUrl, appUrl)
}

/** Electron reports USB ids as decimal strings ('9025' is 0x2341, Arduino). */
function usbHex(raw) {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return null
  const n = Number(raw)
  return n <= 0xffff ? n.toString(16).toUpperCase().padStart(4, '0') : null
}

/** 'Arduino Uno (COM3) (USB 2341:0043)', or the port name when there is no display name. */
function serialPortLabel(port) {
  const display = typeof port.displayName === 'string' ? port.displayName.trim() : ''
  const portName = port.portName || port.portId || 'serial port'
  const name = display === '' ? portName : display.includes(portName) ? display : `${display} · ${portName}`
  const vid = usbHex(port.vendorId)
  const pid = usbHex(port.productId)
  const ids = vid || pid ? ` (USB ${vid ?? '????'}:${pid ?? '????'})` : ''
  return `${name}${ids}`
}

/** 'kiyobridge (AA:BB:CC:DD:EE:FF)'. */
function bluetoothDeviceLabel(device) {
  const name = typeof device.deviceName === 'string' ? device.deviceName.trim() : ''
  return `${name === '' ? 'Unnamed device' : name} (${device.deviceId})`
}

/** Unique by id, named devices first, otherwise in discovery order. New array. */
function orderBluetoothDevices(devices) {
  const list = Array.isArray(devices) ? devices : []
  const valid = list.filter((d) => d && typeof d.deviceId === 'string' && d.deviceId !== '')
  const unique = valid.filter((d, i) => valid.findIndex((o) => o.deviceId === d.deviceId) === i)
  const isNamed = (d) => typeof d.deviceName === 'string' && d.deviceName.trim() !== ''
  return [...unique.filter(isNamed), ...unique.filter((d) => !isNamed(d))]
}

/** A native message box shows buttons, so long lists are capped. */
const MAX_CHOOSER_ITEMS = 10

/** Buttons for a native chooser: one per item (capped), then Cancel. */
function buildChooser(items, toLabel, toId, max = MAX_CHOOSER_ITEMS) {
  const shown = items.slice(0, max)
  return Object.freeze({
    buttons: Object.freeze([...shown.map(toLabel), 'Cancel']),
    ids: Object.freeze(shown.map(toId)),
    cancelId: shown.length,
    hidden: items.length - shown.length,
  })
}

/** The id behind a message-box response, or '' (cancel) for Cancel, Esc or anything else. */
function chosenId(chooser, response) {
  return Number.isInteger(response) && response >= 0 && response < chooser.ids.length ? chooser.ids[response] : ''
}

/** Wrap a callback so only its first call goes through. */
function once(fn) {
  let called = false
  return (...args) => {
    if (called) return false
    called = true
    fn(...args)
    return true
  }
}

/*
 * Web Bluetooth chooser. Electron fires 'select-bluetooth-device' again every time the scan
 * finds or renames a device, until the request is answered. The machine collects them and
 * says when to show the native chooser: at maxMs, or at settleMs once a device is known.
 *   idle --devices--> scanning --tick (ready)--> prompting --done--> idle
 */
const SCAN_TIMING = Object.freeze({ settleMs: 2000, maxMs: 3000 })
const SCAN_IDLE = Object.freeze({ phase: 'idle', startedAt: 0, devices: Object.freeze([]) })

/**
 * One transition. Effects: 'wait' (re-arm the single timer: tick after delayMs, replacing any
 * pending one), 'prompt' (show state.devices), 'none'.
 */
function bluetoothScanStep(state, event, timing = SCAN_TIMING) {
  if (event.type === 'done') return { state: SCAN_IDLE, effect: 'none', delayMs: 0 }
  if (event.type === 'devices') {
    if (state.phase === 'prompting') return { state, effect: 'none', delayMs: 0 }
    const startedAt = state.phase === 'idle' ? event.now : state.startedAt
    const next = Object.freeze({ phase: 'scanning', startedAt, devices: Object.freeze(orderBluetoothDevices(event.devices)) })
    // the first device can bring the deadline forward, so every update re-arms the timer
    return { state: next, effect: 'wait', delayMs: scanDelay(next, event.now, timing) }
  }
  if (event.type !== 'tick' || state.phase !== 'scanning') return { state, effect: 'none', delayMs: 0 }
  const delayMs = scanDelay(state, event.now, timing)
  if (delayMs > 0) return { state, effect: 'wait', delayMs }
  return { state: Object.freeze({ ...state, phase: 'prompting' }), effect: 'prompt', delayMs: 0 }
}

/** Milliseconds until the chooser is due (0 = now). */
function scanDelay(state, now, timing) {
  const elapsed = now - state.startedAt
  const due = state.devices.length > 0 ? timing.settleMs : timing.maxMs
  return Math.max(0, due - elapsed)
}

/** Text for a Bluetooth pairing prompt, or null when a PIN must be typed (no text field available). */
function pairingPrompt(details) {
  if (details.pairingKind === 'confirm') {
    return { message: 'Pair with this Bluetooth device?', detail: `Device ${details.deviceId}` }
  }
  if (details.pairingKind === 'confirmPin') {
    return { message: `Does the device show the PIN ${details.pin ?? ''}?`, detail: `Device ${details.deviceId}` }
  }
  return null
}

/** About box text. */
function aboutDetail(versions) {
  return [
    'Robot simulator bench: a walker, a mecanum sweeper and a quadrotor swarm, driven by the simulator, a real board or your own code.',
    '',
    'Open source under the MIT License. By Faysal Ali Shah.',
    LINKS.project,
    '',
    `Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`,
  ].join('\n')
}

/** The application menu. Actions come in as callbacks so the template stays testable. */
function menuTemplate({ isMac, openUrl, showAbout }) {
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'quit' }] },
    // macOS routes copy and paste shortcuts through the Edit menu, so the code editor needs it
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' }] : []),
    {
      role: 'help',
      submenu: [
        { label: 'Project on GitHub', click: () => openUrl(LINKS.project) },
        { label: 'Report an issue', click: () => openUrl(LINKS.issues) },
        { label: 'Download the latest version', click: () => openUrl(LINKS.releases) },
        { type: 'separator' },
        { label: 'About SIM CONSOLE', click: () => showAbout() },
      ],
    },
  ]
}

module.exports = {
  LINKS,
  MIME_TYPES,
  DEFAULT_MIME,
  MAX_CHOOSER_ITEMS,
  SCAN_TIMING,
  SCAN_IDLE,
  ALLOWED_PERMISSIONS,
  mimeTypeFor,
  resolveSafePath,
  isLoopbackHostHeader,
  sameOrigin,
  isExternalHttpsUrl,
  isPermissionAllowed,
  serialPortLabel,
  bluetoothDeviceLabel,
  orderBluetoothDevices,
  buildChooser,
  chosenId,
  once,
  bluetoothScanStep,
  pairingPrompt,
  aboutDetail,
  menuTemplate,
}
