import { describe, expect, it } from 'vitest'
import type { ControlDef, SelectDef } from '../../core/types'
import { DIR_GLYPHS, controlId, digitsForStep, formatControlValue, gridCells, groupControls, releaseValue, sliderFraction } from './controlMath'
import { clampDrawerHeight, formatClock, formatDuration, formatSpeed, DRAWER_MIN_PX } from '../layoutMath'

const DIRS = ['fl', 'f', 'fr', 'l', 'stop', 'r', 'bl', 'b', 'br'].map((v) => ({ value: v, label: v }))
const pad = (over: Partial<SelectDef> = {}): SelectDef => ({
  type: 'select',
  key: 'dir',
  label: 'DIRECTION',
  group: 'LOCOMOTION',
  display: 'grid3',
  value: 'stop',
  options: DIRS,
  ...over,
})

describe('groupControls', () => {
  it('groups visible controls into panels in schema order', () => {
    // Arrange
    const schema: ControlDef[] = [
      { type: 'toggle', key: 'a', label: 'A', group: 'SIMULATION', value: true },
      { type: 'toggle', key: 'b', label: 'B', group: 'GAIT', value: true },
      { type: 'toggle', key: 'c', label: 'C', group: 'SIMULATION', value: true },
      { type: 'toggle', key: 'd', label: 'D', group: 'GAIT', value: true, hidden: true },
      { type: 'toggle', key: 'e', label: 'E', group: 'HIDDEN', value: true, hidden: true },
    ]
    // Act
    const groups = groupControls(schema)
    // Assert
    expect(groups.map((g) => g.group)).toEqual(['SIMULATION', 'GAIT'])
    expect(groups[0].defs.map((d) => d.key)).toEqual(['a', 'c'])
    expect(groups[1].defs.map((d) => d.key)).toEqual(['b'])
  })
})

describe('slider helpers', () => {
  it('computes the filled fraction with clamping', () => {
    expect(sliderFraction(0.25, 0, 1)).toBe(0.25)
    expect(sliderFraction(-1, 0, 1)).toBe(0)
    expect(sliderFraction(1, 1, 1)).toBe(0)
  })

  it('derives decimals from the step', () => {
    expect(digitsForStep(1)).toBe(0)
    expect(digitsForStep(0.5)).toBe(1)
    expect(digitsForStep(0.05)).toBe(2)
    expect(digitsForStep(0.001)).toBe(3)
    expect(digitsForStep(0)).toBe(0)
  })

  it('formats values without negative zero', () => {
    expect(formatControlValue(1.005, 1)).toBe('1.0')
    expect(formatControlValue(-0.001, 2)).toBe('0.00')
    expect(formatControlValue(Number.NaN, 2)).toBe('—')
  })
})

describe('direction pad', () => {
  it('releases to stop only for the shared dir grid3 pad', () => {
    expect(releaseValue(pad())).toBe('stop')
    expect(releaseValue(pad({ key: 'gait' }))).toBeNull()
    expect(releaseValue(pad({ display: 'segmented' }))).toBeNull()
    expect(releaseValue(pad({ options: [{ value: 'f', label: 'f' }] }))).toBeNull()
  })

  it('lays out nine cells, padding short option lists', () => {
    expect(gridCells(DIRS).map((c) => c?.value)).toEqual(DIRS.map((d) => d.value))
    const short = gridCells(DIRS.slice(0, 4))
    expect(short).toHaveLength(9)
    expect(short[8]).toBeNull()
  })

  it('has a glyph for every shared direction and turn value', () => {
    for (const v of [...DIRS.map((d) => d.value), 'ccw', 'none', 'cw']) expect(DIR_GLYPHS[v]).toBeTruthy()
  })
})

describe('controlId', () => {
  it('makes a DOM-safe id', () => {
    expect(controlId('body.height x')).toBe('ctl-body_height_x')
  })
})

describe('layout helpers', () => {
  it('clamps the drawer between 180 px and 75 % of the viewport', () => {
    expect(clampDrawerHeight(50, 1000)).toBe(DRAWER_MIN_PX)
    expect(clampDrawerHeight(900, 1000)).toBe(750)
    expect(clampDrawerHeight(320.4, 1000)).toBe(320)
    expect(clampDrawerHeight(400, 200)).toBe(DRAWER_MIN_PX)
    expect(clampDrawerHeight(Number.NaN, 1000)).toBe(300)
  })

  it('formats the sim clock with tenths and hours past 60 minutes', () => {
    expect(formatClock(0)).toBe('00:00.0')
    expect(formatClock(65.97)).toBe('01:05.9')
    expect(formatClock(3725.5)).toBe('1:02:05.5')
    expect(formatClock(-3)).toBe('00:00.0')
  })

  it('formats short durations and sim speeds', () => {
    expect(formatDuration(4.24)).toBe('4.2 s')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatSpeed(0.25)).toBe('¼×')
    expect(formatSpeed(2)).toBe('2×')
  })
})
