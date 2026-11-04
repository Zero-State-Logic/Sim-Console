import { describe, expect, it } from 'vitest'
import { RateLimiter, SeqCounter, encodeMsg, fmtNum, serializeCmd, validateOutboundLine } from './outbound'
import { MAX_LINE_BYTES } from '../../core/protocol'

describe('RateLimiter', () => {
  it('averages the configured rate when 60 fps frames do not divide the 50 Hz period', () => {
    // Arrange
    const rl = new RateLimiter(50)
    let sends = 0
    // Act: 10 s of 60 fps frames
    for (let f = 0; f < 600; f++) if (rl.ready((f * 1000) / 60)) sends++
    // Assert
    expect(sends).toBeGreaterThanOrEqual(499)
    expect(sends).toBeLessThanOrEqual(501)
  })

  it('never sends twice inside one period', () => {
    const rl = new RateLimiter(50)
    expect(rl.ready(0)).toBe(true)
    expect(rl.ready(5)).toBe(false)
    expect(rl.ready(19.9)).toBe(false)
    expect(rl.ready(20)).toBe(true)
  })

  it('does not burst to catch up after a long stall', () => {
    const rl = new RateLimiter(50)
    rl.ready(0)
    expect(rl.ready(1000)).toBe(true)
    expect(rl.ready(1001)).toBe(false)
    expect(rl.ready(1019)).toBe(false)
    expect(rl.ready(1020)).toBe(true)
  })

  it('applies a new rate with setHz', () => {
    const rl = new RateLimiter(50)
    rl.setHz(10)
    expect(rl.period).toBe(100)
    rl.ready(0)
    expect(rl.ready(50)).toBe(false)
    expect(rl.ready(100)).toBe(true)
  })

  it('reset() allows an immediate send', () => {
    const rl = new RateLimiter(1)
    rl.ready(0)
    rl.reset()
    expect(rl.ready(1)).toBe(true)
  })
})

describe('SeqCounter', () => {
  it('counts up from zero and wraps to zero after WRAP', () => {
    const s = new SeqCounter()
    expect([s.next(), s.next(), s.next()]).toEqual([0, 1, 2])
    for (let i = 0; i < 3; i++) s.reset()
    expect(s.value).toBe(0)
  })

  it('wraps at the 31-bit limit', () => {
    const s = new SeqCounter()
    ;(s as unknown as { n: number }).n = SeqCounter.WRAP
    expect(s.next()).toBe(SeqCounter.WRAP)
    expect(s.next()).toBe(0)
  })
})

describe('serializeCmd', () => {
  it('emits valid JSON in protocol key order with a seq', () => {
    const r = serializeCmd({ t: 'cmd', q: [12.4, -30.1, 55] }, 42)
    expect(r).toEqual({ ok: true, line: '{"t":"cmd","seq":42,"q":[12.4,-30.1,55]}' })
  })

  it('rounds joint angles to 0.01 degree and prints -0 as 0', () => {
    const r = serializeCmd({ t: 'cmd', q: [1.23456, -0.0001, 2.005] }, 1)
    expect(r.ok && JSON.parse(r.line).q).toEqual([1.23, 0, 2.01])
  })

  it('serializes high-level, wheel and swarm fields', () => {
    const r = serializeCmd({ t: 'cmd', v: [0.1, 0, 0.2], mode: 'tripod', h: 0.09 }, 43)
    expect(r.ok && r.line).toBe('{"t":"cmd","seq":43,"v":[0.1,0,0.2],"mode":"tripod","h":0.09}')
    const w = serializeCmd({ t: 'cmd', w: [1.23456, -2] }, 0)
    expect(w.ok && JSON.parse(w.line).w).toEqual([1.235, -2])
    const sp = serializeCmd({ t: 'cmd', sp: [{ id: 0, p: [1, 2.00049, 3], yaw: 90 }, { id: 1, p: [0, 1, 0] }] }, 5)
    expect(sp.ok && JSON.parse(sp.line).sp).toEqual([{ id: 0, p: [1, 2, 3], yaw: 90 }, { id: 1, p: [0, 1, 0] }])
  })

  it('escapes the mode string so it cannot break the JSON', () => {
    const r = serializeCmd({ t: 'cmd', mode: 'a"}\n{"t":"estop' }, 0)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.line.includes('\n')).toBe(false)
      expect(JSON.parse(r.line).mode).toBe('a"}\n{"t":"estop')
    }
  })

  it('refuses to send NaN or Infinity anywhere', () => {
    expect(serializeCmd({ t: 'cmd', q: [1, NaN] }, 0)).toEqual({ ok: false, reason: 'non-finite value in q[1]' })
    expect(serializeCmd({ t: 'cmd', v: [Infinity, 0, 0] }, 0)).toMatchObject({ ok: false })
    expect(serializeCmd({ t: 'cmd', h: NaN }, 0)).toMatchObject({ ok: false, reason: 'non-finite value in h' })
    expect(serializeCmd({ t: 'cmd', sp: [{ id: 0, p: [0, NaN, 0] }] }, 0)).toMatchObject({ ok: false })
  })
})

describe('fmtNum and encodeMsg', () => {
  it('formats shortest decimals', () => {
    expect(fmtNum(1.5, 2)).toBe('1.5')
    expect(fmtNum(-0.004, 2)).toBe('0')
    expect(fmtNum(3, 0)).toBe('3')
  })

  it('encodes control messages as compact JSON', () => {
    expect(encodeMsg({ t: 'ping', id: 7 })).toBe('{"t":"ping","id":7}')
    expect(encodeMsg({ t: 'hello?' })).toBe('{"t":"hello?"}')
  })
})

describe('validateOutboundLine', () => {
  it('accepts a JSON object with t and re-serializes it to one line', () => {
    const r = validateOutboundLine('  {"t": "home",\n "x": 1}  ')
    expect(r).toEqual({ ok: true, line: '{"t":"home","x":1}', known: true })
  })

  it('flags an unknown t as not known but still sendable', () => {
    expect(validateOutboundLine('{"t":"custom"}')).toEqual({ ok: true, line: '{"t":"custom"}', known: false })
  })

  it('rejects empty, invalid JSON, non-objects and missing t', () => {
    expect(validateOutboundLine('   ')).toMatchObject({ ok: false, reason: 'empty line' })
    expect(validateOutboundLine('{t:home}')).toMatchObject({ ok: false })
    expect(validateOutboundLine('[1]')).toMatchObject({ ok: false, reason: 'must be a JSON object' })
    expect(validateOutboundLine('{"x":1}')).toMatchObject({ ok: false })
  })

  it('rejects a line over the protocol cap', () => {
    const big = JSON.stringify({ t: 'cmd', pad: 'x'.repeat(MAX_LINE_BYTES) })
    expect(validateOutboundLine(big)).toMatchObject({ ok: false })
  })
})
