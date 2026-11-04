import { describe, expect, it } from 'vitest'
import { parseSwarmConfig, serializeSwarmConfig } from './config'
import { MAX_WAYPOINTS, SwarmSim, VOLUME_HALF, defaultSettings } from './sim/swarmSim'

describe('swarm profile config', () => {
  it('serializes the route in three.js ground coordinates [x, z] plus the formation settings', () => {
    // Arrange
    const s = new SwarmSim(4, defaultSettings())
    s.setWaypoints([[1, 2], [-3, 4]])
    s.settings.shape = 'circle'
    s.settings.spacing = 2.5
    // Act
    const c = serializeSwarmConfig(s)
    // Assert: sim (x, y) -> ground (x, z = -y)
    expect(c).toEqual({ v: 1, waypoints: [[1, -2], [-3, -4]], shape: 'circle', spacing: 2.5, cruiseAlt: 3, cruiseSpeed: 2, routeMode: 'loop' })
  })

  it('round-trips through JSON into the same sim waypoints and control values', () => {
    // Arrange
    const s = new SwarmSim(4, defaultSettings())
    s.setWaypoints([[5, -6], [0, 7.5], [-2, 0]])
    s.settings.routeMode = 'pingpong'
    // Act
    const parsed = parseSwarmConfig(JSON.parse(JSON.stringify(serializeSwarmConfig(s))))
    // Assert
    expect(parsed?.waypoints).toEqual([[5, -6], [0, 7.5], [-2, 0]])
    expect(parsed?.values).toEqual({ shape: 'wedge', routeMode: 'pingpong', spacing: 2, cruiseAlt: 3, cruiseSpeed: 2 })
  })

  it('clamps out-of-range numbers, skips malformed waypoints and caps the route length', () => {
    // Arrange
    const many = Array.from({ length: MAX_WAYPOINTS + 10 }, (_, i) => [i % 5, 0])
    const raw = {
      waypoints: [[99, -99], 'x', [1], [Number.NaN, 2], [1, '2'], ...many],
      spacing: 50,
      cruiseAlt: -1,
      cruiseSpeed: 0.1,
      shape: 'blob',
      routeMode: 'zigzag',
    }
    // Act
    const parsed = parseSwarmConfig(raw)
    // Assert
    expect(parsed?.waypoints?.[0]).toEqual([VOLUME_HALF, VOLUME_HALF])
    expect(parsed?.waypoints?.length).toBeLessThanOrEqual(MAX_WAYPOINTS)
    expect(parsed?.values).toEqual({ spacing: 4, cruiseAlt: 1, cruiseSpeed: 0.5 })
  })

  it('rejects values that are not a swarm config at all', () => {
    expect(parseSwarmConfig(null)).toBeNull()
    expect(parseSwarmConfig('waypoints')).toBeNull()
    expect(parseSwarmConfig(42)).toBeNull()
    expect(parseSwarmConfig({ v: 2, waypoints: [] })).toBeNull()
  })
})
