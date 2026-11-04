import { describe, expect, it } from 'vitest'
import { batteryPercent } from '../robots/swarm/hardwareIO'
import { BAT_FLOOR_PCT, batteryOnWire } from './cpp/swarm'
import { generateFirmware } from './index'
import { hwFor, request, swarmSpec } from './testing/fixtures'

describe('swarm relay battery on the wire', () => {
  it('never lets the app read a drone battery fuller than it is', () => {
    // the app decodes 0-4.35 as a cell voltage, so 4 % sent raw would read as ~85 %
    expect(batteryPercent(4)).toBeGreaterThan(50)
    for (let pct = 0; pct <= 100; pct += 0.25) {
      const shown = batteryPercent(batteryOnWire(pct))
      expect(shown).toBeLessThanOrEqual(pct + 0.5)
      if (pct >= BAT_FLOOR_PCT) expect(Math.abs(shown - pct)).toBeLessThanOrEqual(0.5)
      else expect(shown).toBe(0)
    }
  })

  it('applies the same floor in the generated relay telemetry', () => {
    const r = generateFirmware(request(swarmSpec(4), hwFor('esp32', 'serial', 'gpio', 4), 'high'))
    const h = r.files.find((f) => f.path.endsWith('kiyobridge.h'))?.content ?? ''
    expect(r.errors).toEqual([])
    expect(h).toContain(`#define KIYO_BAT_FLOOR_PCT ${BAT_FLOOR_PCT}f`)
    expect(h).toContain('fix(pct < KIYO_BAT_FLOOR_PCT ? 0.0f : pct, 0)')
  })
})
