import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_PERMISSIONS,
  LINKS,
  MAX_CHOOSER_ITEMS,
  SCAN_IDLE,
  SCAN_TIMING,
  aboutDetail,
  bluetoothDeviceLabel,
  bluetoothScanStep,
  buildChooser,
  chosenId,
  isExternalHttpsUrl,
  isLoopbackHostHeader,
  isPermissionAllowed,
  menuTemplate,
  mimeTypeFor,
  once,
  orderBluetoothDevices,
  pairingPrompt,
  resolveSafePath,
  sameOrigin,
  serialPortLabel,
  type MenuItem,
  type ScanState,
} from './lib.cjs'

describe('mimeTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/index-abc.js', 'text/javascript; charset=utf-8'],
    ['worker.mjs', 'text/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['favicon.svg', 'image/svg+xml'],
    ['icon.png', 'image/png'],
    ['data.json', 'application/json; charset=utf-8'],
    ['rapier_bg.wasm', 'application/wasm'],
    ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['font.woff2', 'font/woff2'],
    ['notes.txt', 'text/plain; charset=utf-8'],
  ])('%s is served as %s', (file, type) => {
    expect(mimeTypeFor(file)).toBe(type)
  })

  it('ignores extension case', () => {
    expect(mimeTypeFor('PHYSICS.WASM')).toBe('application/wasm')
  })

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(mimeTypeFor('_headers')).toBe('application/octet-stream')
    expect(mimeTypeFor('archive.7z')).toBe('application/octet-stream')
    expect(mimeTypeFor('a.constructor')).toBe('application/octet-stream')
  })
})

describe('resolveSafePath', () => {
  const posixRoot = '/opt/sim/dist'
  const winRoot = 'C:\\Program Files\\SIM CONSOLE\\dist'
  const posix = (url: string) => resolveSafePath(posixRoot, url, path.posix)
  const win = (url: string) => resolveSafePath(winRoot, url, path.win32)

  it('maps the root and directories to index.html', () => {
    expect(posix('/')).toBe('/opt/sim/dist/index.html')
    expect(posix('/assets/')).toBe('/opt/sim/dist/assets/index.html')
    expect(win('/')).toBe('C:\\Program Files\\SIM CONSOLE\\dist\\index.html')
  })

  it('resolves files and drops the query string and fragment', () => {
    expect(posix('/assets/index-eqwDkMi0.js?v=3#x')).toBe('/opt/sim/dist/assets/index-eqwDkMi0.js')
    expect(win('/assets/three.js')).toBe('C:\\Program Files\\SIM CONSOLE\\dist\\assets\\three.js')
  })

  it('decodes percent-escapes', () => {
    expect(posix('/my%20file.txt')).toBe('/opt/sim/dist/my file.txt')
  })

  it('ignores empty and dot segments', () => {
    expect(posix('//assets/./x.js')).toBe('/opt/sim/dist/assets/x.js')
  })

  it('allows file names that merely start with two dots', () => {
    expect(posix('/..chunk.js')).toBe('/opt/sim/dist/..chunk.js')
    expect(win('/assets/..chunk.js')).toBe('C:\\Program Files\\SIM CONSOLE\\dist\\assets\\..chunk.js')
  })

  it.each([
    '/../package.json',
    '/assets/../../secret',
    '/%2e%2e/package.json',
    '/%2E%2E%2Fpackage.json',
    '/..%5c..%5cWindows%5cwin.ini',
    '/assets/..\\..\\secret',
    '/assets/../index.html',
  ])('rejects traversal %s', (url) => {
    expect(posix(url)).toBeNull()
    expect(win(url)).toBeNull()
  })

  it('rejects drive letters, stream names and device names', () => {
    expect(win('/C:/Windows/win.ini')).toBeNull()
    expect(win('/index.html::$DATA')).toBeNull()
    expect(win('/COM3')).toBeNull()
    expect(win('/assets/nul.js')).toBeNull()
  })

  it('rejects names Windows would trim into something else', () => {
    expect(win('/..%20/secret')).toBeNull()
    expect(win('/..%2e/secret')).toBeNull()
    expect(win('/index.html.')).toBeNull()
    expect(win('/index.html%20')).toBeNull()
    expect(win('/.well-known/x.json')).toBe('C:\\Program Files\\SIM CONSOLE\\dist\\.well-known\\x.json')
  })

  it('rejects malformed input', () => {
    expect(posix('/%E0%A4%A')).toBeNull()
    expect(posix('/a%00b')).toBeNull()
    expect(posix('relative/path')).toBeNull()
    expect(posix('')).toBeNull()
  })

  it('never returns a path outside the root', () => {
    const urls = ['/', '/a', '/a/b/../c', '/%2e', '/.%2e/', '/x/%2e%2e/%2e%2e/y', '/....//', '/.../x', '/..%20/x', '/%5c%5cserver%5cshare']
    for (const url of urls) {
      const out = posix(url)
      if (out !== null) expect(out.startsWith(`${posixRoot}/`)).toBe(true)
    }
  })
})

describe('isLoopbackHostHeader', () => {
  it('accepts loopback hosts with or without a port', () => {
    expect(isLoopbackHostHeader('127.0.0.1:42613')).toBe(true)
    expect(isLoopbackHostHeader('localhost:42613')).toBe(true)
    expect(isLoopbackHostHeader('[::1]:42613')).toBe(true)
    expect(isLoopbackHostHeader('127.0.0.1')).toBe(true)
  })

  it('rejects other hosts (DNS rebinding) and junk', () => {
    expect(isLoopbackHostHeader('evil.example:42613')).toBe(false)
    expect(isLoopbackHostHeader('evil.example@127.0.0.1')).toBe(false)
    expect(isLoopbackHostHeader('192.168.4.1')).toBe(false)
    expect(isLoopbackHostHeader('')).toBe(false)
    expect(isLoopbackHostHeader(undefined)).toBe(false)
  })
})

describe('origins and links', () => {
  const app = 'http://127.0.0.1:42613/'

  it('compares scheme, host and port', () => {
    expect(sameOrigin('http://127.0.0.1:42613', app)).toBe(true)
    expect(sameOrigin('http://127.0.0.1:42613/assets/x.js', app)).toBe(true)
    expect(sameOrigin('http://127.0.0.1:42614/', app)).toBe(false)
    expect(sameOrigin('http://localhost:42613/', app)).toBe(false)
    expect(sameOrigin('https://127.0.0.1:42613/', app)).toBe(false)
    expect(sameOrigin('file:///C:/x.html', 'file:///C:/x.html')).toBe(false)
    expect(sameOrigin(undefined, app)).toBe(false)
    expect(sameOrigin('not a url', app)).toBe(false)
  })

  it('opens only https links externally', () => {
    expect(isExternalHttpsUrl('https://github.com/Zero-State-Logic/Sim-Console')).toBe(true)
    expect(isExternalHttpsUrl('http://example.com')).toBe(false)
    expect(isExternalHttpsUrl('file:///etc/passwd')).toBe(false)
    expect(isExternalHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalHttpsUrl('ms-settings:privacy')).toBe(false)
    expect(isExternalHttpsUrl('')).toBe(false)
  })

  it('points the help links at the project', () => {
    expect(LINKS.project).toBe('https://github.com/Zero-State-Logic/Sim-Console')
    expect(LINKS.issues).toBe('https://github.com/Zero-State-Logic/Sim-Console/issues')
    expect(LINKS.releases).toBe('https://github.com/Zero-State-Logic/Sim-Console/releases/latest')
  })
})

describe('isPermissionAllowed', () => {
  const app = 'http://127.0.0.1:42613/'

  it('grants serial and the clipboard to the app origin', () => {
    expect(isPermissionAllowed('serial', 'http://127.0.0.1:42613', app)).toBe(true)
    expect(isPermissionAllowed('clipboard-sanitized-write', 'http://127.0.0.1:42613/', app)).toBe(true)
    expect(ALLOWED_PERMISSIONS.has('serial')).toBe(true)
  })

  it('refuses other origins', () => {
    expect(isPermissionAllowed('serial', 'https://fonts.googleapis.com', app)).toBe(false)
    expect(isPermissionAllowed('serial', undefined, app)).toBe(false)
  })

  it('refuses permissions the app does not use', () => {
    for (const p of ['media', 'geolocation', 'notifications', 'hid', 'usb', 'openExternal', 'clipboard-read']) {
      expect(isPermissionAllowed(p, app, app)).toBe(false)
    }
  })
})

describe('device labels', () => {
  it('shows the display name and the USB ids in hex', () => {
    const label = serialPortLabel({ portId: 'p1', portName: 'COM3', displayName: 'Arduino Uno (COM3)', vendorId: '9025', productId: '67' })
    expect(label).toBe('Arduino Uno (COM3) (USB 2341:0043)')
  })

  it('adds the port name when the display name lacks it', () => {
    const label = serialPortLabel({ portId: 'p2', portName: '/dev/cu.usbserial-110', displayName: 'USB Serial', vendorId: '6790', productId: '29987' })
    expect(label).toBe('USB Serial · /dev/cu.usbserial-110 (USB 1A86:7523)')
  })

  it('falls back to the port name and skips missing ids', () => {
    expect(serialPortLabel({ portId: 'p3', portName: 'ttyS0' })).toBe('ttyS0')
    expect(serialPortLabel({ portId: 'p4', portName: 'COM9', displayName: '  ', vendorId: '1027' })).toBe('COM9 (USB 0403:????)')
    expect(serialPortLabel({ portId: 'p5', portName: 'COM1', vendorId: '0x1a86' })).toBe('COM1')
  })

  it('labels Bluetooth devices by name and id', () => {
    expect(bluetoothDeviceLabel({ deviceId: 'AA:BB', deviceName: 'kiyobridge' })).toBe('kiyobridge (AA:BB)')
    expect(bluetoothDeviceLabel({ deviceId: 'CC:DD', deviceName: '' })).toBe('Unnamed device (CC:DD)')
  })

  it('orders devices: unique, named first, discovery order kept', () => {
    const list = [
      { deviceId: '1', deviceName: '' },
      { deviceId: '2', deviceName: 'bot-a' },
      { deviceId: '2', deviceName: 'bot-a (dup)' },
      { deviceId: '3', deviceName: 'bot-b' },
      { deviceId: '', deviceName: 'no id' },
    ]
    expect(orderBluetoothDevices(list).map((d) => d.deviceId)).toEqual(['2', '3', '1'])
    expect(list).toHaveLength(5)
  })
})

describe('chooser', () => {
  const ports = [
    { id: 'a', name: 'Port A' },
    { id: 'b', name: 'Port B' },
  ]

  it('builds one button per item, then Cancel', () => {
    const c = buildChooser(ports, (p) => p.name, (p) => p.id)
    expect(c.buttons).toEqual(['Port A', 'Port B', 'Cancel'])
    expect(c.cancelId).toBe(2)
    expect(c.hidden).toBe(0)
  })

  it('maps responses to ids and anything else to cancel', () => {
    const c = buildChooser(ports, (p) => p.name, (p) => p.id)
    expect(chosenId(c, 0)).toBe('a')
    expect(chosenId(c, 1)).toBe('b')
    expect(chosenId(c, 2)).toBe('')
    expect(chosenId(c, -1)).toBe('')
    expect(chosenId(c, 1.5)).toBe('')
  })

  it('caps long lists', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, name: `Device ${i}` }))
    const c = buildChooser(many, (p) => p.name, (p) => p.id)
    expect(c.buttons).toHaveLength(MAX_CHOOSER_ITEMS + 1)
    expect(c.hidden).toBe(25 - MAX_CHOOSER_ITEMS)
    expect(chosenId(c, MAX_CHOOSER_ITEMS)).toBe('')
  })

  it('handles an empty list', () => {
    const c = buildChooser([], String, String)
    expect(c.buttons).toEqual(['Cancel'])
    expect(chosenId(c, 0)).toBe('')
  })
})

describe('once', () => {
  it('calls through only the first time', () => {
    const fn = vi.fn()
    const wrapped = once(fn)
    expect(wrapped('dev-1')).toBe(true)
    expect(wrapped('dev-2')).toBe(false)
    expect(wrapped('')).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('dev-1')
  })
})

describe('bluetoothScanStep', () => {
  const dev = (id: string, name = `bot-${id}`) => ({ deviceId: id, deviceName: name })

  /** Drive the machine the way main.cjs does, firing ticks when it asks to wait. */
  function run(arrivals: Array<{ at: number; devices: ReturnType<typeof dev>[] }>) {
    let state: ScanState = SCAN_IDLE
    let tickAt: number | null = null
    const timeline = [...arrivals].sort((a, b) => a.at - b.at)
    for (let now = 0; now <= 10000; now += 50) {
      for (const a of timeline.filter((x) => x.at === now)) {
        const out = bluetoothScanStep(state, { type: 'devices', devices: a.devices, now })
        state = out.state
        if (out.effect === 'wait') tickAt = now + out.delayMs
      }
      if (tickAt !== null && now >= tickAt) {
        tickAt = null
        const out = bluetoothScanStep(state, { type: 'tick', now })
        state = out.state
        if (out.effect === 'wait') tickAt = now + out.delayMs
        if (out.effect === 'prompt') return { at: now, devices: state.devices.map((d) => d.deviceId) }
      }
    }
    return null
  }

  it('waits settleMs after the first device, collecting later ones', () => {
    const result = run([
      { at: 100, devices: [dev('a')] },
      { at: 900, devices: [dev('a'), dev('b')] },
      { at: 1500, devices: [dev('a'), dev('b'), dev('c', '')] },
    ])
    expect(result).toEqual({ at: 100 + SCAN_TIMING.settleMs, devices: ['a', 'b', 'c'] })
  })

  it('prompts at maxMs when the scan has no devices', () => {
    const result = run([{ at: 0, devices: [] }])
    expect(result).toEqual({ at: SCAN_TIMING.maxMs, devices: [] })
  })

  it('shortens to settleMs once a device shows up during an empty scan', () => {
    const result = run([
      { at: 0, devices: [] },
      { at: 2500, devices: [dev('x')] },
    ])
    expect(result).toEqual({ at: 2500, devices: ['x'] })
  })

  it('keeps one deadline per request: later updates re-arm to the same moment', () => {
    const first = bluetoothScanStep(SCAN_IDLE, { type: 'devices', devices: [dev('a')], now: 0 })
    expect(first.effect).toBe('wait')
    expect(first.delayMs).toBe(SCAN_TIMING.settleMs)
    const second = bluetoothScanStep(first.state, { type: 'devices', devices: [dev('a'), dev('b')], now: 500 })
    expect(second.effect).toBe('wait')
    expect(second.delayMs).toBe(SCAN_TIMING.settleMs - 500)
    expect(second.state.startedAt).toBe(0)
    expect(second.state.devices).toHaveLength(2)
  })

  it('ignores updates while the chooser is open and resets on done', () => {
    let state = bluetoothScanStep(SCAN_IDLE, { type: 'devices', devices: [dev('a')], now: 0 }).state
    const prompt = bluetoothScanStep(state, { type: 'tick', now: SCAN_TIMING.settleMs })
    expect(prompt.effect).toBe('prompt')
    state = prompt.state
    expect(state.phase).toBe('prompting')
    const during = bluetoothScanStep(state, { type: 'devices', devices: [dev('a'), dev('z')], now: 2100 })
    expect(during.effect).toBe('none')
    expect(during.state).toBe(state)
    expect(bluetoothScanStep(state, { type: 'tick', now: 9000 }).effect).toBe('none')
    expect(bluetoothScanStep(state, { type: 'done' }).state).toBe(SCAN_IDLE)
  })

  it('treats a new scan after done as a new request', () => {
    const out = bluetoothScanStep(SCAN_IDLE, { type: 'devices', devices: [dev('b')], now: 7000 })
    expect(out.state.startedAt).toBe(7000)
    expect(out.effect).toBe('wait')
  })

  it('ignores ticks when idle and does not mutate state', () => {
    const before = JSON.stringify(SCAN_IDLE)
    expect(bluetoothScanStep(SCAN_IDLE, { type: 'tick', now: 5000 })).toEqual({ state: SCAN_IDLE, effect: 'none', delayMs: 0 })
    expect(JSON.stringify(SCAN_IDLE)).toBe(before)
    expect(Object.isFrozen(SCAN_IDLE)).toBe(true)
  })
})

describe('pairingPrompt', () => {
  it('asks to confirm, shows the PIN, declines PIN entry', () => {
    expect(pairingPrompt({ deviceId: 'AA', pairingKind: 'confirm' })?.message).toMatch(/Pair/)
    expect(pairingPrompt({ deviceId: 'AA', pairingKind: 'confirmPin', pin: '123456' })?.message).toContain('123456')
    expect(pairingPrompt({ deviceId: 'AA', pairingKind: 'providePin' })).toBeNull()
  })
})

describe('menuTemplate', () => {
  const flatten = (items: MenuItem[]): MenuItem[] => items.flatMap((i) => [i, ...flatten(i.submenu ?? [])])

  it('has File, Edit, View and Help, plus the app menu on macOS', () => {
    const win = menuTemplate({ isMac: false, openUrl: () => {}, showAbout: () => {} })
    expect(win.map((m) => m.label ?? m.role)).toEqual(['File', 'editMenu', 'View', 'help'])
    const mac = menuTemplate({ isMac: true, openUrl: () => {}, showAbout: () => {} })
    expect(mac[0].role).toBe('appMenu')
  })

  it('wires the View roles', () => {
    const roles = flatten(menuTemplate({ isMac: false, openUrl: () => {}, showAbout: () => {} })).map((i) => i.role)
    for (const r of ['reload', 'quit', 'togglefullscreen', 'zoomIn', 'zoomOut', 'resetZoom', 'toggleDevTools']) {
      expect(roles).toContain(r)
    }
  })

  it('opens the project links and the about box', () => {
    const openUrl = vi.fn()
    const showAbout = vi.fn()
    const help = menuTemplate({ isMac: false, openUrl, showAbout }).find((m) => m.role === 'help')
    const items = (help?.submenu ?? []).filter((i) => i.click)
    for (const item of items) item.click?.()
    expect(openUrl.mock.calls.map((c) => c[0])).toEqual([LINKS.project, LINKS.issues, LINKS.releases])
    expect(showAbout).toHaveBeenCalledTimes(1)
    expect(items.map((i) => i.label)).toEqual(['Project on GitHub', 'Report an issue', 'Download the latest version', 'About SIM CONSOLE'])
  })
})

describe('aboutDetail', () => {
  it('names the license, the author and the runtime versions', () => {
    const text = aboutDetail({ electron: '44.9.3', chrome: '146.0', node: '24.1.0' })
    expect(text).toContain('MIT License')
    expect(text).toContain('Faysal Ali Shah')
    expect(text).toContain('Electron 44.9.3')
    expect(text).toContain(LINKS.project)
  })
})
