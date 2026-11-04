import { describe, expect, it } from 'vitest'
import { MAX_DRONES, MAX_JOINT_VALUES, MAX_MSG_CHARS, MAX_SCAN_SAMPLES, parseInbound } from './validate'
import type { BotToApp } from '../../core/protocol'

function okMsg(line: string): BotToApp {
  const r = parseInbound(line)
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.msg
}

function invalidReason(line: string): string {
  const r = parseInbound(line)
  if (r.ok || r.kind !== 'invalid') throw new Error(`expected invalid, got ${JSON.stringify(r)}`)
  return r.reason
}

const HELLO = '{"t":"hello","proto":1,"board":"esp32","robot":"walker","legs":6,"joints":18,"fw":"kiyobridge-1.0","caps":["imu"]}'

describe('parseInbound: well-formed messages', () => {
  it('parses the protocol hello example into a typed message', () => {
    expect(okMsg(HELLO)).toEqual({
      t: 'hello', proto: 1, board: 'esp32', robot: 'walker', joints: 18, legs: 6, fw: 'kiyobridge-1.0', caps: ['imu'],
    })
  })

  it('parses a full tel with ang, load, imu, enc, pose, vbat, scan and drones', () => {
    const line = JSON.stringify({
      t: 'tel', ms: 10422, ang: [1.5, -2], load: [0.5], imu: [1, 2, 3], enc: [3.2], pose: [0.1, 0.2, 90], vbat: 7.4,
      scan: { a0: 0, da: 0.8, r: [1, 0, 2.5] },
      drones: [{ id: 0, p: [0, 1, 0], att: [0, 0, 45], bat: 3.9 }],
    })
    expect(okMsg(line)).toEqual({
      t: 'tel', ms: 10422, ang: [1.5, -2], load: [0.5], enc: [3.2], imu: [1, 2, 3], pose: [0.1, 0.2, 90], vbat: 7.4,
      scan: { a0: 0, da: 0.8, r: [1, 0, 2.5] },
      drones: [{ id: 0, p: [0, 1, 0], att: [0, 0, 45], bat: 3.9 }],
    })
  })

  it('parses ack, pong and log', () => {
    expect(okMsg('{"t":"ack","of":"home","ok":true}')).toEqual({ t: 'ack', of: 'home', ok: true })
    expect(okMsg('{"t":"pong","id":7}')).toEqual({ t: 'pong', id: 7 })
    expect(okMsg('{"t":"log","lvl":"warn","msg":"servo 4 clamped"}')).toEqual({ t: 'log', lvl: 'warn', msg: 'servo 4 clamped' })
  })

  it('reads an unknown log level as info instead of dropping the line', () => {
    expect(okMsg('{"t":"log","lvl":"debug","msg":"x"}')).toEqual({ t: 'log', lvl: 'info', msg: 'x' })
  })
})

describe('parseInbound: rejection', () => {
  it('reports non-JSON and non-object lines as not-json', () => {
    expect(parseInbound('ets Jun  8 2016 00:22:57')).toMatchObject({ ok: false, kind: 'not-json' })
    expect(parseInbound('[1,2]')).toMatchObject({ ok: false, kind: 'not-json' })
    expect(parseInbound('null')).toMatchObject({ ok: false, kind: 'not-json' })
    expect(parseInbound('"tel"')).toMatchObject({ ok: false, kind: 'not-json' })
  })

  it('reports an unknown t value as unknown, including app-to-bot types echoed back', () => {
    expect(parseInbound('{"t":"teleport"}')).toEqual({ ok: false, kind: 'unknown', t: 'teleport' })
    expect(parseInbound('{"t":"cmd","q":[1]}')).toEqual({ ok: false, kind: 'unknown', t: 'cmd' })
  })

  it('does not treat inherited Object.prototype names as message types', () => {
    expect(parseInbound('{"t":"constructor"}')).toMatchObject({ kind: 'unknown' })
    expect(parseInbound('{"t":"toString"}')).toMatchObject({ kind: 'unknown' })
  })

  it('rejects a missing or non-string t', () => {
    expect(invalidReason('{"x":1}')).toMatch(/type t/)
    expect(invalidReason('{"t":5}')).toMatch(/type t/)
  })

  it('rejects wrong field types', () => {
    expect(invalidReason('{"t":"tel","vbat":"7.4"}')).toMatch(/vbat/)
    expect(invalidReason('{"t":"tel","ang":"1,2"}')).toMatch(/ang is not an array/)
    expect(invalidReason('{"t":"tel","ang":[1,"2"]}')).toMatch(/ang\[1\]/)
    expect(invalidReason('{"t":"ack","of":"home","ok":"yes"}')).toMatch(/ok/)
    expect(invalidReason('{"t":"pong","id":1.5}')).toMatch(/id/)
    expect(invalidReason('{"t":"hello","proto":1,"board":"esp32","robot":"walker","joints":"18"}')).toMatch(/joints/)
  })

  it('rejects Infinity produced by an overflowing JSON number', () => {
    expect(invalidReason('{"t":"tel","ang":[1e999]}')).toMatch(/finite/)
    expect(invalidReason('{"t":"tel","ms":-1e400}')).toMatch(/finite/)
  })

  it('rejects NaN-like tokens because they are not JSON', () => {
    expect(parseInbound('{"t":"tel","vbat":NaN}')).toMatchObject({ kind: 'not-json' })
  })

  it('rejects imu and pose that are not exactly three values', () => {
    expect(invalidReason('{"t":"tel","imu":[1,2]}')).toMatch(/imu/)
    expect(invalidReason('{"t":"tel","pose":[1,2,3,4]}')).toMatch(/pose/)
  })

  it('caps joint arrays at 64 values', () => {
    const at = JSON.stringify({ t: 'tel', ang: new Array(MAX_JOINT_VALUES).fill(0) })
    const over = JSON.stringify({ t: 'tel', ang: new Array(MAX_JOINT_VALUES + 1).fill(0) })
    expect(parseInbound(at).ok).toBe(true)
    expect(invalidReason(over)).toMatch(/max 64/)
  })

  it('caps LiDAR scans at 2048 samples and rejects negative ranges', () => {
    const over = JSON.stringify({ t: 'tel', scan: { a0: 0, da: 0.1, r: new Array(MAX_SCAN_SAMPLES + 1).fill(1) } })
    expect(invalidReason(over)).toMatch(/max 2048/)
    expect(invalidReason('{"t":"tel","scan":{"a0":0,"da":1,"r":[1,-1]}}')).toMatch(/negative/)
  })

  it('caps drones at 16 and validates each entry', () => {
    const drone = { id: 0, p: [0, 0, 0], att: [0, 0, 0] }
    const over = JSON.stringify({ t: 'tel', drones: new Array(MAX_DRONES + 1).fill(drone) })
    expect(invalidReason(over)).toMatch(/max 16/)
    expect(invalidReason('{"t":"tel","drones":[{"id":0,"p":[0,0],"att":[0,0,0]}]}')).toMatch(/drones\[0\]\.p/)
  })

  it('rejects unknown boards and robots in hello', () => {
    expect(invalidReason('{"t":"hello","proto":1,"board":"nano","robot":"walker","joints":1}')).toMatch(/board/)
    expect(invalidReason('{"t":"hello","proto":1,"board":"esp32","robot":"tank","joints":1}')).toMatch(/robot/)
  })
})

describe('parseInbound: hostile input', () => {
  it('drops extra keys and builds a fresh object', () => {
    const msg = okMsg('{"t":"pong","id":3,"evil":"x","constructor":{"y":1}}')
    expect(Object.keys(msg)).toEqual(['t', 'id'])
    expect(Object.getPrototypeOf(msg)).toBe(Object.prototype)
  })

  it('cannot pollute Object.prototype through __proto__ keys', () => {
    const msg = okMsg('{"t":"tel","__proto__":{"polluted":true},"ang":[1],"constructor":{"prototype":{"polluted":true}}}')
    expect(Object.keys(msg)).toEqual(['t', 'ang'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((msg as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('ignores fields inherited from a __proto__ key when reading required values', () => {
    // a crafted own "__proto__" property must not satisfy the required "id"
    expect(invalidReason('{"t":"pong","__proto__":{"id":1}}')).toMatch(/missing id/)
  })

  it('truncates over-long free-text strings', () => {
    const long = 'x'.repeat(MAX_MSG_CHARS + 100)
    const msg = okMsg(JSON.stringify({ t: 'log', msg: long }))
    expect(msg.t === 'log' && msg.msg.length).toBe(MAX_MSG_CHARS)
  })

  it('copies arrays so later mutation of the parsed JSON cannot alias them', () => {
    const msg = okMsg('{"t":"tel","ang":[1,2,3]}')
    expect(msg.t === 'tel' && Array.isArray(msg.ang)).toBe(true)
  })
})
