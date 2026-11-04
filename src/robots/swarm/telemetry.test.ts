import { describe, expect, it } from 'vitest'
import { SAT_THRUST } from './sim/mixer'
import { SwarmSim, defaultSettings } from './sim/swarmSim'
import { SwarmTelemetry, alertCode, alertLabel, formatFlightTime, formationScore, waypointLabel } from './telemetry'

describe('swarm telemetry formatting', () => {
  it('scores the formation 100 % on the slots, falling linearly to 0 % at 2 m RMS', () => {
    expect(formationScore(0, 3)).toBe(100)
    expect(formationScore(1, 3)).toBeCloseTo(50, 12)
    expect(formationScore(5, 3)).toBe(0)
    expect(formationScore(0, 0)).toBe(0)
    expect(formationScore(Number.NaN, 3)).toBe(0)
  })

  it('formats flight time as m:ss.s', () => {
    expect(formatFlightTime(0)).toBe('0:00.0')
    expect(formatFlightTime(9.96)).toBe('0:09.9')
    expect(formatFlightTime(65.25)).toBe('1:05.2')
    expect(formatFlightTime(600)).toBe('10:00.0')
    expect(formatFlightTime(-3)).toBe('0:00.0')
  })

  it('shows the waypoint being flown to as i/n, DONE after a ONCE route, a dash without a route', () => {
    expect(waypointLabel(0, 4, false)).toBe('1/4')
    expect(waypointLabel(3, 4, false)).toBe('4/4')
    expect(waypointLabel(9, 4, false)).toBe('4/4')
    expect(waypointLabel(2, 4, true)).toBe('DONE')
    expect(waypointLabel(0, 0, false)).toBe('—')
  })

  it('ranks alerts crash > low battery > motor saturation, lowest drone id first', () => {
    // Arrange
    const s = new SwarmSim(4, defaultSettings())
    s.takeoff()
    // Act + Assert
    expect(alertLabel(alertCode(s), false)).toBe('NOMINAL')
    expect(alertLabel(alertCode(s), true)).toBe('MIRRORING HW')
    s.drones[3].ctrl.satFlags = SAT_THRUST
    expect(alertLabel(alertCode(s), false)).toBe('D4 MOTOR SAT')
    s.drones[2].lowBattery = true
    expect(alertLabel(alertCode(s), false)).toBe('D3 LOW BATTERY')
    s.drones[1].crash('test', s.params)
    s.drones[0].crash('test', s.params)
    expect(alertLabel(alertCode(s), false)).toBe('D1 CRASHED')
  })
})

describe('SwarmTelemetry frame', () => {
  it('fills one stable frame in place, with every key the layout declares', () => {
    // Arrange
    const s = new SwarmSim(3, defaultSettings())
    s.takeoff()
    // one second into the climb: airborne, not yet at the cruise altitude
    for (let i = 0; i < 60; i++) s.advance(1 / 60)
    const tel = new SwarmTelemetry(3)
    // Act
    const a = tel.fill(s, 0.4, false)
    const b = tel.fill(s, 0.4, false)
    // Assert
    expect(b).toBe(a)
    expect(Object.keys(a.gauges).sort()).toEqual(['battery', 'formation'])
    expect(Object.keys(a.channels).sort()).toEqual(['alt1', 'alt2', 'alt3', 'err1', 'err2', 'err3', 'pitch', 'roll'])
    expect(a.bars).toHaveLength(3)
    for (const v of a.bars) {
      expect(v).toBeGreaterThan(0.3)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(a.channels.alt1).toBeCloseTo(s.drones[0].s[2], 12)
    expect(a.readouts.phase).toBe('TAKEOFF')
    expect(a.readouts.airborne).toBe('3/3')
    expect(a.readouts.wp).toBe('1/4')
    expect(a.readouts.cost).toBe(0.4)
    expect(a.readouts.loopHz).toBeGreaterThan(900)
    expect(a.t).toBe(s.t)
  })

  it('reports the weakest battery and resizes with the fleet', () => {
    // Arrange
    const s = new SwarmSim(4, defaultSettings())
    s.drones[2].battery.reset(0.37)
    const tel = new SwarmTelemetry(4)
    // Act
    const f = tel.fill(s, 0, true)
    tel.resize(6)
    // Assert
    expect(f.gauges.battery).toBeCloseTo(37, 9)
    expect(f.readouts.phase).toBe('IDLE · HW')
    expect(tel.frame.bars).toHaveLength(6)
    expect(tel.frame.channels.alt6).toBe(0)
  })
})
