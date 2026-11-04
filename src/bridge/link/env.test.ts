import { describe, expect, it } from 'vitest'
import { checkWsUrl, describeConnectError, isLoopbackHost, transportSupport, wsUnreachable, type BrowserEnv } from './env'

const HTTPS = { protocol: 'https:', hostname: 'me.github.io' }
const HTTP_LOCAL = { protocol: 'http:', hostname: 'localhost' }

describe('checkWsUrl', () => {
  it('accepts ws:// to a LAN board from an http page', () => {
    expect(checkWsUrl('ws://192.168.4.1:81', HTTP_LOCAL)).toEqual({ ok: true, url: 'ws://192.168.4.1:81/', secure: false })
  })

  it('detects mixed content: https page to ws:// on a LAN host', () => {
    const r = checkWsUrl('ws://192.168.4.1:81', HTTPS)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('mixed-content')
      expect(r.guidance.join(' ')).toMatch(/USB SERIAL/)
      expect(r.guidance.join(' ')).toMatch(/npm run dev/)
      expect(r.guidance.join(' ')).toMatch(/ws-relay\.mjs/)
    }
  })

  it('allows ws:// to localhost, 127.x and [::1] from https (the relay path)', () => {
    expect(checkWsUrl('ws://localhost:8787/?k=abc', HTTPS).ok).toBe(true)
    expect(checkWsUrl('ws://127.0.0.1:8787', HTTPS).ok).toBe(true)
    expect(checkWsUrl('ws://[::1]:8787', HTTPS).ok).toBe(true)
    expect(checkWsUrl('ws://robot.localhost:81', HTTPS).ok).toBe(true)
  })

  it('accepts wss:// anywhere', () => {
    expect(checkWsUrl('wss://bot.example.com/ws', HTTPS)).toMatchObject({ ok: true, secure: true })
  })

  it('rejects other schemes, garbage and empty input', () => {
    expect(checkWsUrl('http://192.168.4.1', HTTP_LOCAL)).toMatchObject({ ok: false, reason: 'scheme' })
    expect(checkWsUrl('javascript:alert(1)', HTTP_LOCAL)).toMatchObject({ ok: false, reason: 'scheme' })
    expect(checkWsUrl('192.168.4.1:81', HTTP_LOCAL)).toMatchObject({ ok: false })
    expect(checkWsUrl('not a url', HTTP_LOCAL)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(checkWsUrl('  ', HTTP_LOCAL)).toMatchObject({ ok: false, reason: 'empty' })
  })
})

describe('isLoopbackHost', () => {
  it('recognises loopback names and rejects look-alikes', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('127.10.0.1')).toBe(true)
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
    expect(isLoopbackHost('128.0.0.1')).toBe(false)
  })
})

const CHROME: BrowserEnv = { hasSerial: true, hasBluetooth: true, hasWebSocket: true, isSecureContext: true, userAgent: 'Mozilla/5.0 Chrome/130.0' }

describe('transportSupport', () => {
  it('supports everything in desktop Chrome over HTTPS', () => {
    for (const id of ['serial', 'ble', 'ws', 'loopback'] as const) expect(transportSupport(id, CHROME).supported).toBe(true)
  })

  it('explains that Firefox lacks Web Serial and Web Bluetooth', () => {
    const ff: BrowserEnv = { ...CHROME, hasSerial: false, hasBluetooth: false, userAgent: 'Mozilla/5.0 Firefox/131.0' }
    expect(transportSupport('serial', ff)).toEqual({ supported: false, reason: expect.stringMatching(/Web Serial is not available in Firefox/) })
    expect(transportSupport('ble', ff).reason).toMatch(/Android/)
    expect(transportSupport('loopback', ff).supported).toBe(true)
  })

  it('explains the HTTPS requirement on an insecure page', () => {
    const insecure: BrowserEnv = { ...CHROME, isSecureContext: false }
    expect(transportSupport('serial', insecure).reason).toMatch(/HTTPS/)
  })
})

describe('describeConnectError', () => {
  function dom(name: string, message: string): Error {
    const e = new Error(message)
    e.name = name
    return e
  }

  it('treats a dismissed chooser as a cancel, not an error', () => {
    expect(describeConnectError(dom('NotFoundError', 'No port selected by the user.'), 'serial').cancelled).toBe(true)
    expect(describeConnectError(dom('NotFoundError', 'User cancelled the requestDevice() chooser.'), 'ble').cancelled).toBe(true)
  })

  it('explains a busy serial port', () => {
    const r = describeConnectError(dom('NetworkError', 'Failed to open serial port.'), 'serial')
    expect(r.cancelled).toBe(false)
    expect(r.detail).toMatch(/Arduino Serial Monitor/)
  })

  it('falls back to the raw message', () => {
    expect(describeConnectError('boom', 'ws')).toEqual({ cancelled: false, message: 'Connection failed.', detail: 'boom' })
  })
})

describe('wsUnreachable', () => {
  it('points at the relay and its key when a loopback URL does not answer', () => {
    // Act
    const f = wsUnreachable('ws://localhost:8787/?k=', false)
    // Assert
    expect(f.message).toMatch(/local relay at ws:\/\/localhost:8787/)
    expect(f.guidance.join(' ')).toMatch(/node tools\/ws-relay\.mjs/)
    expect(f.guidance.join(' ')).toMatch(/\?k=<key>/)
  })

  it('points at the board network and IP for a LAN URL, and says when it timed out', () => {
    // Act
    const f = wsUnreachable('ws://192.168.4.1:81/', true)
    // Assert
    expect(f.message).toBe('The board at ws://192.168.4.1:81/ did not answer within 5 s.')
    expect(f.guidance.join(' ')).toMatch(/same WiFi network/)
    expect(f.guidance.join(' ')).toMatch(/port 81/)
  })

  it('reaches the panel as message + guidance through describeConnectError', () => {
    // Arrange: the shape WsTransport rejects with
    const f = wsUnreachable('ws://192.168.4.1:81/', false)
    const err = Object.assign(new Error(f.message), { name: 'WsUrlError', guidance: f.guidance })
    // Act
    const r = describeConnectError(err, 'ws')
    // Assert
    expect(r.message).toBe(f.message)
    expect(r.detail).toBe(f.guidance.join(' '))
  })
})
