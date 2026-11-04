import { describe, expect, it } from 'vitest'
import { parseWalkerConfig, parseWalkerSnapshot, serializeWalkerConfig } from './config'
import { DEFAULT_DIMS } from './geometry'

const ui = { tauMs: 40, speedDeg: 350, stallNm: 1, deadbandDeg: 0.5, backlashDeg: 1 }
const fallback = serializeWalkerConfig(DEFAULT_DIMS, ui)

describe('parseWalkerConfig', () => {
  it('round-trips a serialized config through JSON', () => {
    const c = JSON.parse(JSON.stringify(serializeWalkerConfig({ ...DEFAULT_DIMS, femur: 0.1 }, { ...ui, backlashDeg: 2 }))) as unknown
    expect(parseWalkerConfig(c, fallback)).toEqual({ v: 1, dims: { ...DEFAULT_DIMS, femur: 0.1 }, actuator: { ...ui, backlashDeg: 2 } })
  })

  it('clamps out-of-range numbers and falls back for missing or non-numeric fields', () => {
    const c = parseWalkerConfig({ v: 1, dims: { coxa: 9, tibia: 'long' }, actuator: { stallNm: -1, tauMs: Number.NaN } }, fallback)
    expect(c?.dims.coxa).toBe(0.08)
    expect(c?.dims.tibia).toBe(DEFAULT_DIMS.tibia)
    expect(c?.actuator.stallNm).toBe(0.05)
    expect(c?.actuator.tauMs).toBe(40)
  })

  it('rejects anything that is not a v1 walker config', () => {
    expect(parseWalkerConfig(null, fallback)).toBeNull()
    expect(parseWalkerConfig([1], fallback)).toBeNull()
    expect(parseWalkerConfig({ v: 2 }, fallback)).toBeNull()
  })
})

describe('parseWalkerSnapshot', () => {
  it('accepts a snapshot of the right shape and normalises the contacts', () => {
    const s = parseWalkerSnapshot({ v: 1, body: [0, 0, 0.08, 0, 0, 0], q: new Array(12).fill(0.1), c: [1, 0, 2, 0] }, 4)
    expect(s?.c).toEqual([1, 0, 1, 0])
  })

  it('rejects wrong lengths (another leg count) and non-finite values', () => {
    expect(parseWalkerSnapshot({ v: 1, body: [0, 0, 0, 0, 0, 0], q: new Array(18).fill(0), c: new Array(6).fill(1) }, 4)).toBeNull()
    expect(parseWalkerSnapshot({ v: 1, body: [0, 0, Number.NaN, 0, 0, 0], q: new Array(12).fill(0), c: new Array(4).fill(1) }, 4)).toBeNull()
    expect(parseWalkerSnapshot('snap', 4)).toBeNull()
  })
})
