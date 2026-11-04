import { describe, expect, it } from 'vitest'
import type { ControlDef, SelectDef, SliderDef } from '../../core/types'
import { GAIN_KEYS, SCHEMA, applyValues, buildLayout, droneCountFrom, sanitizeControl, schemaFor } from './schema'
import { DEFAULT_GAINS } from './sim/controller'
import { defaultSettings } from './sim/swarmSim'

function def(key: string): ControlDef {
  const d = SCHEMA.find((x) => x.key === key)
  if (!d) throw new Error(`no control ${key}`)
  return d
}

describe('swarm control schema', () => {
  it('groups the controls into MISSION, SIMULATION, FORMATION, GAINS and DISPLAY', () => {
    const groups = new Set(SCHEMA.map((d) => d.group))
    expect([...groups]).toEqual(['MISSION', 'SIMULATION', 'FORMATION', 'GAINS', 'DISPLAY'])
    expect(new Set(SCHEMA.map((d) => d.key)).size).toBe(SCHEMA.length)
  })

  it('offers 3-6 drones and the 500 / 1000 / 2000 Hz physics rates as segmented selects', () => {
    const drones = def('drones') as SelectDef
    const rate = def('rate') as SelectDef
    expect(drones.display).toBe('segmented')
    expect(drones.options.map((o) => o.value)).toEqual(['3', '4', '5', '6'])
    expect(rate.options.map((o) => o.value)).toEqual(['500', '1000', '2000'])
    expect(rate.value).toBe('1000')
  })

  it('exposes every cascade gain with its tuned default, and the mission buttons', () => {
    expect([...GAIN_KEYS]).toEqual(['posP', 'posD', 'velP', 'velI', 'attP', 'rateP', 'rateI', 'rateD'])
    for (const k of GAIN_KEYS) {
      const d = def(k) as SliderDef
      expect(d.group).toBe('GAINS')
      expect(d.value).toBe(DEFAULT_GAINS[k])
      expect(d.max).toBeGreaterThan(d.value)
    }
    for (const k of ['takeoff', 'land', 'clearWp', 'reset']) expect(def(k).type).toBe('button')
  })

  it('greys out the wind detail while the wind is off', () => {
    const off = schemaFor({ wind: false })
    const on = schemaFor({ wind: true })
    for (const k of ['windSpeed', 'windDir', 'gust']) {
      expect(off.find((d) => d.key === k)?.disabled).toBe(true)
      expect(on.find((d) => d.key === k)?.disabled).toBe(false)
    }
    expect(off.find((d) => d.key === 'spacing')?.disabled).toBeUndefined()
  })
})

describe('control validation', () => {
  it('clamps sliders, rejects non-finite numbers, unknown options and wrong types', () => {
    expect(sanitizeControl(def('spacing'), 99)).toBe(4)
    expect(sanitizeControl(def('spacing'), -5)).toBe(1)
    expect(sanitizeControl(def('spacing'), Number.NaN)).toBeNull()
    expect(sanitizeControl(def('spacing'), '2')).toBeNull()
    expect(sanitizeControl(def('shape'), 'circle')).toBe('circle')
    expect(sanitizeControl(def('shape'), 'blob')).toBeNull()
    expect(sanitizeControl(def('wind'), 1)).toBeNull()
    expect(sanitizeControl(def('wind'), false)).toBe(false)
    expect(sanitizeControl(def('takeoff'), true)).toBe(true)
  })

  it('pushes valid values into the sim settings and ignores bad ones', () => {
    // Arrange
    const st = defaultSettings()
    // Act
    applyValues({
      rate: '2000', integrator: 'euler', shape: 'column', routeMode: 'once', avoid: false, wind: false,
      spacing: 3, cruiseAlt: 20, cruiseSpeed: 4, windSpeed: 6, windDir: 90, gust: 1, posP: 2, rateD: 'x',
    }, st)
    // Assert
    expect(st.physicsHz).toBe(2000)
    expect(st.integrator).toBe('euler')
    expect(st.shape).toBe('column')
    expect(st.routeMode).toBe('once')
    expect(st.avoid).toBe(false)
    expect(st.wind).toEqual({ enabled: false, speed: 6, dirDeg: 90, gust: 1 })
    expect(st.spacing).toBe(3)
    expect(st.cruiseAlt).toBe(8)
    expect(st.cruiseSpeed).toBe(4)
    expect(st.gains.posP).toBe(2)
    expect(st.gains.rateD).toBe(DEFAULT_GAINS.rateD)
    applyValues({ rate: '777', integrator: 'leapfrog', shape: 'blob' }, st)
    expect([st.physicsHz, st.integrator, st.shape]).toEqual([2000, 'euler', 'column'])
  })

  it('reads the drone count, falling back to 4 for anything outside 3-6', () => {
    expect(droneCountFrom('5')).toBe(5)
    expect(droneCountFrom(3)).toBe(3)
    expect(droneCountFrom('9')).toBe(4)
    expect(droneCountFrom('4.5')).toBe(4)
    expect(droneCountFrom(undefined)).toBe(4)
  })
})

describe('instrument layout', () => {
  it('has FORMATION and BATTERY gauges, per-drone altitude and error charts, leader attitude and thrust bars', () => {
    // Act
    const l = buildLayout(5)
    // Assert
    expect(l.gauges.map((g) => g.key)).toEqual(['formation', 'battery'])
    expect(l.charts.map((c) => c.key)).toEqual(['alt', 'err', 'att'])
    expect(l.charts[0].channels.map((c) => c.key)).toEqual(['alt1', 'alt2', 'alt3', 'alt4', 'alt5'])
    expect(l.charts[1].channels).toHaveLength(5)
    expect(l.charts[2].channels.map((c) => c.key)).toEqual(['roll', 'pitch'])
    expect(l.bars?.labels).toEqual(['D1', 'D2', 'D3', 'D4', 'D5'])
    const readouts = l.readouts.map((r) => r.key)
    for (const k of ['minSep', 'wind', 'leaderSpeed', 'wp', 'flight', 'loopHz']) expect(readouts).toContain(k)
  })
})
