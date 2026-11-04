import { describe, expect, it } from 'vitest'
import { SWARM_SANDBOX_API, applySwarmCommands, swarmSensors } from './sandboxIO'
import { SwarmSim, defaultSettings } from './sim/swarmSim'

function sim(n = 4): SwarmSim {
  return new SwarmSim(n, defaultSettings())
}

describe('swarm sandbox API', () => {
  it('exposes exactly the documented commands and queries', () => {
    const byName = new Map(SWARM_SANDBOX_API.map((f) => [f.name, f]))
    expect([...byName.keys()].sort()).toEqual([
      'addWaypoint', 'clearWaypoints', 'droneCount', 'land', 'readBattery', 'readSpeed',
      'readX', 'readY', 'readZ', 'setFormation', 'setTarget', 'setYaw', 'takeoff',
    ])
    expect(byName.get('setTarget')?.params).toEqual(['id', 'x', 'y', 'z'])
    expect(byName.get('addWaypoint')?.params).toEqual(['x', 'z'])
    expect(byName.get('readX')?.sensor).toBe('posX')
    expect(byName.get('readY')?.sensor).toBe('posY')
    expect(byName.get('readZ')?.sensor).toBe('posZ')
    expect(byName.get('readBattery')?.sensor).toBe('battery')
    expect(byName.get('readSpeed')?.sensor).toBe('speed')
    expect(byName.get('droneCount')?.sensor).toBe('drones')
  })

  it('answers every query from the sensor snapshot, in the three.js world frame', () => {
    // Arrange
    const s = sim(3)
    s.drones[1].s.set([1, 2, 3], 0)
    s.drones[1].s.set([0.3, 0.4, 0], 3)
    // Act
    const snap = swarmSensors(s)
    // Assert
    for (const f of SWARM_SANDBOX_API) if (f.kind === 'query') expect(snap[f.sensor ?? '']).toBeDefined()
    expect((snap.posX as number[])[1]).toBe(1)
    expect((snap.posY as number[])[1]).toBe(3)
    expect((snap.posZ as number[])[1]).toBe(-2)
    expect((snap.speed as number[])[1]).toBeCloseTo(0.5, 12)
    expect((snap.battery as number[])[1]).toBe(100)
    expect(snap.drones).toBe(3)
  })
})

describe('swarm sandbox commands', () => {
  it('setTarget converts world (y up) to the sim frame, arms the drone and takes it out of formation', () => {
    // Arrange
    const s = sim(3)
    // Act
    applySwarmCommands(s, [{ fn: 'setTarget', args: [2, 1.5, 4, -3] }])
    // Assert
    const d = s.drones[2]
    expect(d.manual).toBe(true)
    expect(d.armed).toBe(true)
    expect(Array.from(d.manualTarget)).toEqual([1.5, 3, 4])
  })

  it('setYaw takes degrees, setFormation picks a shape by index and rejoins every drone', () => {
    // Arrange
    const s = sim(3)
    applySwarmCommands(s, [{ fn: 'setTarget', args: [0, 0, 2, 0] }])
    // Act + Assert
    applySwarmCommands(s, [{ fn: 'setYaw', args: [1, 90] }])
    expect(s.drones[1].yawOverride).toBeCloseTo(Math.PI / 2, 12)
    const fx = applySwarmCommands(s, [{ fn: 'setFormation', args: [3] }])
    expect(fx.shape).toBe('circle')
    expect(s.drones[0].manual).toBe(false)
    expect(s.drones[1].yawOverride).toBeNull()
  })

  it('takeoff, land, addWaypoint and clearWaypoints drive the mission', () => {
    // Arrange
    const s = sim(3)
    s.clearWaypoints()
    // Act + Assert
    applySwarmCommands(s, [{ fn: 'takeoff', args: [] }])
    expect(s.phase).toBe('takeoff')
    applySwarmCommands(s, [{ fn: 'addWaypoint', args: [4, -5] }, { fn: 'addWaypoint', args: [-2, 1] }])
    expect(s.wpCount).toBe(2)
    expect([s.waypoints[0], s.waypoints[1]]).toEqual([4, 5])
    applySwarmCommands(s, [{ fn: 'clearWaypoints', args: [] }])
    expect(s.wpCount).toBe(0)
    applySwarmCommands(s, [{ fn: 'land', args: [] }])
    expect(s.phase).toBe('landing')
  })

  it('ignores unknown names, bad ids, missing and non-finite arguments', () => {
    // Arrange
    const s = sim(3)
    const wps = s.wpCount
    // Act
    const fx = applySwarmCommands(s, [
      { fn: 'setTarget', args: [7, 1, 1, 1] },
      { fn: 'setTarget', args: [0, Number.NaN, 1, 1] },
      { fn: 'setTarget', args: [0, 1] },
      { fn: 'setYaw', args: [-1, 30] },
      { fn: 'setFormation', args: [9] },
      { fn: 'addWaypoint', args: [Number.POSITIVE_INFINITY, 0] },
      { fn: 'selfDestruct', args: [] },
      { fn: 'setTarget', args: null as unknown as number[] },
    ])
    // Assert
    expect(fx.shape).toBeUndefined()
    expect(s.wpCount).toBe(wps)
    for (const d of s.drones) {
      expect(d.manual).toBe(false)
      expect(d.mode).toBe('landed')
      expect(d.yawOverride).toBeNull()
    }
  })
})
