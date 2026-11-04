import { describe, expect, it } from 'vitest'
import type { ControlDef } from '../../core/types'
import { ACTUATOR_PRESETS } from './actuator'
import {
  ACT_RANGES,
  actuatorToUi,
  buildSchema,
  dirVector,
  legCountFrom,
  presetFrom,
  sanitizeControl,
  sliderRange,
  turnSign,
  uiToActuator,
} from './controls'
import { buildLayout, DEFAULT_DIMS } from './geometry'
import { gaitsFor } from './gaits'

const DEG = Math.PI / 180

function schema(): ControlDef[] {
  const gaits = gaitsFor(buildLayout(6, DEFAULT_DIMS))
  return buildSchema({ gaits, minDuty: gaits[0].minDuty, physics: 'kinematic', heightRange: [0.03, 0.18], standHeight: 0.085 })
}

describe('direction pad and turn', () => {
  it('maps every pad value to a unit (or zero) body-frame direction, REP-103 (y left)', () => {
    expect(dirVector('f')).toEqual([1, 0])
    expect(dirVector('l')).toEqual([0, 1])
    expect(dirVector('r')).toEqual([0, -1])
    expect(dirVector('stop')).toEqual([0, 0])
    expect(Math.hypot(...dirVector('br'))).toBeCloseTo(1, 12)
    expect(dirVector('bogus')).toEqual([0, 0])
    expect(turnSign('ccw')).toBe(1)
    expect(turnSign('cw')).toBe(-1)
    expect(turnSign('none')).toBe(0)
  })
})

describe('actuator UI mapping', () => {
  it('round-trips preset values through the sliders', () => {
    const p = ACTUATOR_PRESETS.ds3218
    const back = uiToActuator(actuatorToUi(p))
    expect(back.tau).toBeCloseTo(p.tau, 12)
    expect(back.speed).toBeCloseTo(p.speed, 12)
    expect(back.stall).toBeCloseTo(p.stall, 12)
    expect(back.deadband).toBeCloseTo(p.deadband, 12)
    expect(back.backlash).toBeCloseTo(p.backlash, 12)
  })

  it('shows IDEAL as the slider maxima and keeps the reference stall current for custom values', () => {
    const ui = actuatorToUi(ACTUATOR_PRESETS.ideal)
    expect(ui.speedDeg).toBe(ACT_RANGES.speedDeg[1])
    expect(ui.stallNm).toBe(ACT_RANGES.stallNm[1])
    const c = uiToActuator({ tauMs: 20, speedDeg: 300, stallNm: 2, deadbandDeg: 1, backlashDeg: 0 })
    expect(c.speed).toBeCloseTo(300 * DEG, 12)
    expect(c.stall / c.kt).toBeCloseTo(ACTUATOR_PRESETS.mg996r.stall / ACTUATOR_PRESETS.mg996r.kt, 12)
  })
})

describe('schema helpers', () => {
  it('validates writes against the control definition', () => {
    const s = schema()
    const find = (k: string): ControlDef => s.find((d) => d.key === k) as ControlDef
    expect(sanitizeControl(find('speed'), 150)).toBe(100)
    expect(sanitizeControl(find('speed'), '40')).toBe(40)
    expect(sanitizeControl(find('speed'), 'x')).toBeNull()
    expect(sanitizeControl(find('gait'), 'ripple')).toBe('ripple')
    expect(sanitizeControl(find('gait'), 'trot')).toBeNull()
    expect(sanitizeControl(find('treadmill'), 1)).toBeNull()
    expect(sanitizeControl(find('respawn'), false)).toBe(true)
  })

  it('uses the context height range and exposes slider ranges', () => {
    expect(sliderRange(schema(), 'height')).toEqual([0.03, 0.18])
    expect(sliderRange(schema(), 'gait')).toBeNull()
  })

  it('parses leg counts and presets defensively', () => {
    expect(legCountFrom('4')).toBe(4)
    expect(legCountFrom('8')).toBe(8)
    expect(legCountFrom('7')).toBe(6)
    expect(presetFrom('sg90')).toBe('sg90')
    expect(presetFrom('v8')).toBe('ideal')
  })
})
