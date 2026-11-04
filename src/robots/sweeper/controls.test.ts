import { describe, expect, it } from 'vitest'
import type { ControlDef } from '../../core/types'
import { ARENA_ACTIONS, FLAG_KEYS, PARAM_KEYS, PARAM_TOGGLES, isArenaAction, sanitizeControl } from './controls'
import { SCHEMA, schemaFor } from './schema'

const slider: ControlDef = { type: 'slider', key: 's', label: 'S', group: 'G', min: 0.1, max: 0.6, step: 0.05, value: 0.3 }
const select: ControlDef = { type: 'select', key: 'm', label: 'M', group: 'G', value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }
const toggle: ControlDef = { type: 'toggle', key: 't', label: 'T', group: 'G', value: true }

describe('sanitizeControl', () => {
  it('clamps and snaps slider values to the step grid', () => {
    expect(sanitizeControl(slider, 2)).toBe(0.6)
    expect(sanitizeControl(slider, -1)).toBe(0.1)
    expect(sanitizeControl(slider, 0.33)).toBe(0.35)
  })

  it('rejects non-finite or non-numeric slider values', () => {
    expect(sanitizeControl(slider, Number.NaN)).toBeNull()
    expect(sanitizeControl(slider, '0.3')).toBeNull()
  })

  it('accepts only listed select options and real booleans for toggles', () => {
    expect(sanitizeControl(select, 'b')).toBe('b')
    expect(sanitizeControl(select, 'z')).toBeNull()
    expect(sanitizeControl(toggle, false)).toBe(false)
    expect(sanitizeControl(toggle, 1)).toBeNull()
  })
})

describe('control tables', () => {
  it('only refer to keys the schema defines', () => {
    const keys = new Set(SCHEMA.map((d) => d.key))
    for (const k of [...Object.keys(PARAM_KEYS), ...Object.keys(PARAM_TOGGLES), ...Object.keys(FLAG_KEYS), ...ARENA_ACTIONS]) {
      expect(keys.has(k)).toBe(true)
    }
    expect(isArenaAction('clear')).toBe(true)
    expect(isArenaAction('resetMap')).toBe(false)
  })

  it('follows the shell conventions for the direction pad and turn select', () => {
    const dir = SCHEMA.find((d) => d.key === 'dir')
    const turn = SCHEMA.find((d) => d.key === 'turn')
    expect(dir?.type === 'select' && dir.display).toBe('grid3')
    expect(dir?.type === 'select' && dir.options.map((o) => o.value)).toEqual(['fl', 'f', 'fr', 'l', 'stop', 'r', 'bl', 'b', 'br'])
    expect(turn?.type === 'select' && turn.options.map((o) => o.value)).toEqual(['ccw', 'none', 'cw'])
  })

  it('disables REMOVE SELECTED without a selection', () => {
    expect(schemaFor(false).find((d) => d.key === 'removeSel')?.disabled).toBe(true)
    expect(schemaFor(true).find((d) => d.key === 'removeSel')?.disabled).toBeFalsy()
  })
})
