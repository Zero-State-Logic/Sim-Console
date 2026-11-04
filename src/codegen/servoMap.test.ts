import { describe, expect, it } from 'vitest'
import { jointToServoDeg, servoDegToUs, usToPcaTicks } from '../core/hardware'
import { generateFirmware } from './index'
import { hex2, pcaAddress, pcaTicksInt, servoTable, tableToUs } from './servoMap'
import { hwFor, request, walkerSpec } from './testing/fixtures'

/** Parse a generated float array, C++ `NAME[...] = { 1.0f, ... };` or Python `NAME = [1.0, ...]`. */
function floats(src: string, name: string): number[] {
  const m = new RegExp(`${name}(?:\\[[^\\]]*\\])? = [{[]([^}\\]]*)[}\\]]`).exec(src)
  if (!m) throw new Error(`${name} not found`)
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/f$/, ''))
    .filter(Boolean)
    .map(Number)
}

function scalar(src: string, re: RegExp): number {
  const m = re.exec(src)
  if (!m) throw new Error(`${re} not found`)
  return Number(m[1].replace(/f$/, ''))
}

/** The firmware's formula, evaluated from the constants it was generated with. */
function firmwareUs(center: number[], gain: number[], range: number, minUs: number, maxUs: number, j: number, deg: number): number {
  const f = Math.min(Math.max((center[j] + gain[j] * deg) / range, 0), 1)
  return Math.round(minUs + f * (maxUs - minUs))
}

const SAMPLE_DEG = [-95, -70, -33.3, -0.4, 0, 0.6, 12.5, 45, 80, 120]

describe('servo mapping', () => {
  const spec = walkerSpec(6)
  const hw = hwFor('esp32', 'serial', 'pca9685', 18, {
    jointInvert: Array.from({ length: 18 }, (_, j) => j % 3 === 1),
    jointOffsetDeg: Array.from({ length: 18 }, (_, j) => (j % 4) * 2.5 - 3),
    jointScale: Array.from({ length: 18 }, (_, j) => 0.9 + (j % 5) * 0.05),
    servoMinUs: 600,
    servoMaxUs: 2400,
  })

  it('reference table equals jointToServoDeg + servoDegToUs for every joint', () => {
    const t = servoTable(hw, 18)
    for (let j = 0; j < 18; j++) {
      for (const deg of SAMPLE_DEG) expect(tableToUs(t, j, deg)).toBe(servoDegToUs(hw, jointToServoDeg(hw, j, deg)))
    }
  })

  it('generated C++ constants reproduce the app mapping', () => {
    const header = generateFirmware(request(spec, hw, 'joint')).files.find((f) => f.path.endsWith('kiyobridge.h'))?.content ?? ''
    const center = floats(header, 'KIYO_SERVO_CENTER')
    const gain = floats(header, 'KIYO_SERVO_GAIN')
    const range = scalar(header, /#define KIYO_SERVO_RANGE_DEG (\S+)/)
    const minUs = scalar(header, /#define KIYO_SERVO_MIN_US (\d+)/)
    const maxUs = scalar(header, /#define KIYO_SERVO_MAX_US (\d+)/)
    expect(center).toHaveLength(18)
    for (let j = 0; j < 18; j++) {
      for (const deg of SAMPLE_DEG) expect(firmwareUs(center, gain, range, minUs, maxUs, j, deg)).toBe(servoDegToUs(hw, jointToServoDeg(hw, j, deg)))
    }
  })

  it('generated Python constants reproduce the app mapping', () => {
    const piHw = { ...hw, board: 'pizero2w' as const, transport: 'ws' as const }
    const py = generateFirmware(request(spec, piHw, 'joint')).files.find((f) => f.path.endsWith('kiyobridge.py'))?.content ?? ''
    const center = floats(py, 'SERVO_CENTER')
    const gain = floats(py, 'SERVO_GAIN')
    const range = scalar(py, /SERVO_RANGE_DEG = (\S+)/)
    for (let j = 0; j < 18; j++) {
      for (const deg of SAMPLE_DEG) expect(firmwareUs(center, gain, range, 600, 2400, j, deg)).toBe(servoDegToUs(piHw, jointToServoDeg(piHw, j, deg)))
    }
  })

  it('integer PCA9685 ticks match usToPcaTicks at 50 Hz', () => {
    for (let us = 400; us <= 2600; us += 7) expect(pcaTicksInt(us)).toBe(usToPcaTicks(us))
  })

  it('splits channels across the 0x40 and 0x41 boards', () => {
    expect(pcaAddress(15)).toBe(0x40)
    expect(pcaAddress(16)).toBe(0x41)
    expect(hex2(0x41)).toBe('0x41')
  })
})
