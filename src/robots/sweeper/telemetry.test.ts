import { describe, expect, it } from 'vitest'
import { DEG } from './constants'
import { SweeperSim } from './sim'
import { CLEARANCE_MAX_CM, TelemetryBuilder, clearanceCm } from './telemetry'

describe('clearance gauge', () => {
  it('converts meters to cm, clamped to the gauge, with no return as full scale', () => {
    expect(clearanceCm(0.42)).toBeCloseTo(42)
    expect(clearanceCm(-0.1)).toBe(0)
    expect(clearanceCm(5)).toBe(CLEARANCE_MAX_CM)
    expect(clearanceCm(Infinity)).toBe(CLEARANCE_MAX_CM)
  })
})

describe('telemetry frame', () => {
  it('reports the sim state in instrument units and reuses one frame object', () => {
    // Arrange
    const sim = new SweeperSim(6, [])
    sim.nav.setMode('teleop')
    sim.nav.teleopDir = 'f'
    sim.step(1)
    const b = new TelemetryBuilder()
    // Act
    const f = b.update(sim, 'TEST')
    const g = b.update(sim, 'TEST', 12.5)
    // Assert
    expect(g).toBe(f)
    expect(f.readouts.x).toBe(sim.pose.x)
    expect(f.readouts.hdg).toBeCloseTo(sim.pose.th / DEG)
    expect(f.readouts.speed).toBeGreaterThan(0.2)
    expect(f.channels.wFL).toBe(sim.wheel[0])
    expect(f.bars[2]).toBe(Math.abs(sim.wheel[2]))
    expect(f.gauges.coverage).toBe(12.5)
    expect(f.readouts.known as number).toBeGreaterThan(10)
    expect(f.readouts.status).toBe('TEST')
  })

  it('refreshes MAP KNOWN again after invalidate()', () => {
    const sim = new SweeperSim(6, [])
    sim.step(0.5)
    const b = new TelemetryBuilder()
    const before = b.update(sim, '').readouts.known as number
    sim.resetMap()
    b.invalidate()
    expect(b.update(sim, '').readouts.known).toBeLessThan(before)
  })
})
