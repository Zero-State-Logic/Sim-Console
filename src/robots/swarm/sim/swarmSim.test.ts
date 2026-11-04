import { describe, expect, it } from 'vitest'
import { SwarmSim, defaultSettings, padXY, MAX_DRONES, LOW_BATTERY } from './swarmSim'
import type { SwarmSettings } from './swarmSim'
import { FORMATION_SHAPES } from './formation'
import { applySnapshot, isSwarmSnapshot, takeSnapshot } from './snapshot'

function calm(patch: Partial<SwarmSettings> = {}): SwarmSettings {
  const s = defaultSettings()
  s.wind = { ...s.wind, enabled: false }
  return { ...s, ...patch }
}

/** Run the sim at a 60 fps frame rate. */
function run(sim: SwarmSim, seconds: number, each?: (sim: SwarmSim) => void): void {
  const frames = Math.round(seconds * 60)
  for (let i = 0; i < frames; i++) {
    sim.advance(1 / 60)
    each?.(sim)
  }
}

describe('swarm mission', () => {
  it('starts with every drone landed on its own pad', () => {
    const sim = new SwarmSim(5, calm())
    expect(sim.count).toBe(5)
    expect(sim.phase).toBe('idle')
    for (const d of sim.drones) {
      expect(d.mode).toBe('landed')
      expect([d.s[0], d.s[1]]).toEqual(padXY(d.id, 5))
    }
  })

  it('TAKEOFF climbs every drone to the cruise altitude and starts the mission', () => {
    // Arrange
    const sim = new SwarmSim(4, calm({ cruiseAlt: 3 }))
    // Act
    sim.takeoff()
    run(sim, 5)
    // Assert
    expect(sim.phase).toBe('mission')
    for (const d of sim.drones) {
      expect(d.mode).toBe('flying')
      expect(Math.abs(d.s[2] - 3)).toBeLessThan(0.35)
    }
  })

  it('flies the route in formation: waypoints advance and the slot error converges', () => {
    const sim = new SwarmSim(4, calm())
    sim.takeoff()
    const seen = new Set<number>()
    let minSep = Infinity
    run(sim, 45, (s) => {
      seen.add(s.route.target)
      minSep = Math.min(minSep, s.minSeparation)
    })
    expect(seen.size).toBe(4)
    expect(sim.formationRms).toBeLessThan(0.6)
    expect(minSep).toBeGreaterThan(0.5)
    expect(sim.drones.every((d) => d.mode === 'flying')).toBe(true)
  })

  it('holds every formation shape with 6 drones in calm air', () => {
    for (const shape of FORMATION_SHAPES) {
      const sim = new SwarmSim(MAX_DRONES, calm({ shape, cruiseSpeed: 1.5 }))
      sim.clearWaypoints()
      sim.addWaypoint(6, 0)
      sim.takeoff()
      run(sim, 25)
      expect(sim.drones.every((d) => d.mode === 'flying')).toBe(true)
      expect(sim.formationRms).toBeLessThan(0.3)
    }
  })

  it('LAND brings every drone down and disarms it, then the swarm goes idle', () => {
    const sim = new SwarmSim(3, calm())
    sim.takeoff()
    run(sim, 8)
    sim.land()
    expect(sim.phase).toBe('landing')
    run(sim, 10)
    expect(sim.phase).toBe('idle')
    for (const d of sim.drones) {
      expect(d.mode).toBe('landed')
      expect(d.s[2]).toBeCloseTo(sim.params.gearHeight, 6)
    }
  })

  it('drains every battery monotonically while flying', () => {
    const sim = new SwarmSim(3, calm())
    sim.takeoff()
    let prev = sim.drones.map((d) => d.battery.soc)
    for (let k = 0; k < 20; k++) {
      run(sim, 0.5)
      const now = sim.drones.map((d) => d.battery.soc)
      now.forEach((v, i) => expect(v).toBeLessThan(prev[i]))
      prev = now
    }
  })

  it('lands a drone in place when its battery hits the failsafe level', () => {
    const sim = new SwarmSim(3, calm())
    sim.takeoff()
    run(sim, 6)
    sim.drones[2].battery.reset((LOW_BATTERY - 1) / 100)
    run(sim, 12)
    expect(sim.drones[2].lowBattery).toBe(true)
    expect(sim.drones[2].mode).toBe('landed')
    expect(sim.drones[0].mode).toBe('flying')
  })

  it('runs the selected physics rate and reports the loop frequency', () => {
    for (const hz of [500, 1000, 2000]) {
      const sim = new SwarmSim(3, calm({ physicsHz: hz }))
      sim.takeoff()
      let steps = 0
      for (let i = 0; i < 60; i++) steps += sim.advance(1 / 60)
      expect(Math.abs(steps - hz)).toBeLessThanOrEqual(2)
      expect(Math.abs(sim.loopHz - hz) / hz).toBeLessThan(0.05)
    }
  })

  it('is deterministic: the same inputs give bit-identical states (wind on)', () => {
    const a = new SwarmSim(4)
    const b = new SwarmSim(4)
    a.takeoff()
    b.takeoff()
    run(a, 6)
    run(b, 6)
    expect(Array.from(a.drones[3].s)).toEqual(Array.from(b.drones[3].s))
  })

  it('flies bit-identically at 30, 60 and 144 fps: the fixed-step accumulator hides the frame rate (wind on)', () => {
    // Arrange + Act: 8 s of mission at three render rates
    const fly = (fps: number): SwarmSim => {
      const sim = new SwarmSim(4)
      sim.takeoff()
      for (let i = 0; i < 8 * fps; i++) sim.advance(1 / fps)
      return sim
    }
    const sims = [30, 60, 144].map(fly)
    // float rounding can leave one substep in the accumulator: line them up on the step count
    const steps = (s: SwarmSim): number => Math.round(s.t * s.settings.physicsHz)
    const last = Math.max(...sims.map(steps))
    for (const s of sims) while (steps(s) < last) s.advance(1 / s.settings.physicsHz)
    // Assert
    for (const s of sims.slice(1)) {
      for (let i = 0; i < 4; i++) expect(Array.from(s.drones[i].s)).toEqual(Array.from(sims[0].drones[i].s))
    }
    expect(sims[0].phase).toBe('mission')
  })

  it('flies a CODE-commanded drone to its explicit target and releases it back', () => {
    const sim = new SwarmSim(3, calm())
    sim.setManualTarget(1, 2, 3, 4)
    run(sim, 8)
    const d = sim.drones[1]
    expect(Math.hypot(d.s[0] - 2, d.s[1] - 3, d.s[2] - 4)).toBeLessThan(0.05)
    expect(sim.drones[0].mode).toBe('landed')
    sim.clearManual()
    run(sim, 1)
    expect(sim.phase).toBe('mission')
  })
})

describe('swarm avoidance', () => {
  function swap(avoid: boolean): { crashed: boolean; minSep: number } {
    const sim = new SwarmSim(3, calm({ avoid }))
    sim.setManualTarget(0, -5, 0, 3)
    sim.setManualTarget(1, 5, 0, 3)
    run(sim, 6)
    sim.setManualTarget(0, 5, 0, 3)
    sim.setManualTarget(1, -5, 0, 3)
    let minSep = Infinity
    run(sim, 12, (s) => {
      const a = s.drones[0].s, b = s.drones[1].s
      minSep = Math.min(minSep, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
    })
    return { crashed: sim.drones[0].mode === 'crashed' || sim.drones[1].mode === 'crashed', minSep }
  }

  it('keeps a head-on pair of real quadrotors apart with ORCA on', () => {
    const r = swap(true)
    expect(r.crashed).toBe(false)
    expect(r.minSep).toBeGreaterThan(0.5)
  })

  it('lets them collide (and crash) with avoidance off — honestly', () => {
    const r = swap(false)
    expect(r.crashed).toBe(true)
  })
})

describe('swarm waypoints and snapshots', () => {
  it('adds, clamps, removes and clears waypoints', () => {
    const sim = new SwarmSim(3, calm())
    sim.clearWaypoints()
    expect(sim.addWaypoint(1, 1)).toBe(true)
    expect(sim.addWaypoint(50, -50)).toBe(true)
    expect([sim.waypoints[2], sim.waypoints[3]]).toEqual([10, -10])
    expect(sim.removeNearestWaypoint(1.2, 1, 1)).toBe(true)
    expect(sim.wpCount).toBe(1)
    expect(sim.removeNearestWaypoint(0, 0, 1)).toBe(false)
    expect(sim.addWaypoint(NaN, 0)).toBe(false)
    sim.clearWaypoints()
    expect(sim.wpCount).toBe(0)
  })

  it('restores a snapshot exactly and continues identically', () => {
    const a = new SwarmSim(4, calm())
    a.takeoff()
    run(a, 7)
    const snap = takeSnapshot(a)
    expect(isSwarmSnapshot(JSON.parse(JSON.stringify(snap)))).toBe(true)
    const b = new SwarmSim(3, calm())
    expect(applySnapshot(b, snap)).toBe(true)
    expect(b.count).toBe(4)
    expect(Array.from(b.drones[2].s)).toEqual(Array.from(a.drones[2].s))
    expect(b.phase).toBe(a.phase)
  })

  it('sanitises an imported snapshot: unit attitude, rotor speeds within the motor range, wrapped heading', () => {
    // Arrange: a hand-edited recording, valid in shape but physically off
    const sim = new SwarmSim(3, calm())
    const snap = takeSnapshot(sim)
    snap.s[6] = 2 // q = (2, 0, 0, 0): identity, not unit
    snap.s[13 + 6] = 0 // a zero quaternion on drone 2
    snap.w[0] = 1e9
    snap.w[1] = -5
    snap.heading = 7
    // Act
    expect(applySnapshot(sim, JSON.parse(JSON.stringify(snap)))).toBe(false)
    // Assert
    for (const d of sim.drones) expect(Math.hypot(d.s[6], d.s[7], d.s[8], d.s[9])).toBeCloseTo(1, 12)
    expect(sim.drones[0].omega[0]).toBe(sim.params.omegaMax)
    expect(sim.drones[0].omega[1]).toBe(0)
    expect(sim.heading).toBeCloseTo(7 - 2 * Math.PI, 12)
    sim.advance(0.5)
    expect(sim.drones.every((d) => Number.isFinite(d.s[0] + d.s[2]))).toBe(true)
  })

  it('rejects malformed snapshots', () => {
    const sim = new SwarmSim(3, calm())
    const good = takeSnapshot(sim)
    expect(applySnapshot(sim, null)).toBeNull()
    expect(applySnapshot(sim, { ...good, n: 9 })).toBeNull()
    expect(applySnapshot(sim, { ...good, s: good.s.map(() => NaN) })).toBeNull()
    expect(applySnapshot(sim, { ...good, modes: good.modes.map(() => 'warp') })).toBeNull()
    expect(applySnapshot(sim, { ...good, phase: 'party' })).toBeNull()
  })
})

describe('hardware mirror', () => {
  it('mirrors real positions and produces setpoints from the mission layer', () => {
    const sim = new SwarmSim(3, calm())
    sim.takeoff()
    for (let k = 0; k < 30; k++) {
      for (const d of sim.drones) sim.mirrorDrone(d.id, d.home[0], d.home[1], 0.035 + k * 0.1, 0, 0, 0, 90)
      sim.advanceMirror(0.04)
    }
    expect(sim.drones[0].s[2]).toBeCloseTo(0.035 + 29 * 0.1, 9)
    expect(sim.drones[0].target[2]).toBeCloseTo(3, 9)
    expect(sim.drones[0].battery.percent).toBeCloseTo(90, 9)
    expect(sim.drones[0].s[5]).toBeGreaterThan(1)
  })

  it('ignores non-finite telemetry', () => {
    const sim = new SwarmSim(3, calm())
    sim.mirrorDrone(0, NaN, 0, 0, 0, 0, 0)
    sim.mirrorDrone(7, 1, 1, 1, 0, 0, 0)
    sim.mirrorDrone(1, 0, 0, 1, Infinity, 0, 0)
    expect(Number.isFinite(sim.drones[0].s[0])).toBe(true)
    expect(Number.isFinite(sim.drones[1].s[6])).toBe(true)
  })

  it('drops (never clamps) absurd positions, so a LAND anchor can never come from garbage', () => {
    // Arrange
    const sim = new SwarmSim(3, calm())
    sim.mirrorDrone(0, 2, -1, 3, 0, 0, 0, 80)
    // Act
    sim.mirrorDrone(0, 1e6, 0, 3, 0, 0, 0, 80)
    sim.mirrorDrone(0, 2, -1, -5e3, 0, 0, 0, 80)
    // Assert: the last sane sample stands
    expect([sim.drones[0].s[0], sim.drones[0].s[1], sim.drones[0].s[2]]).toEqual([2, -1, 3])
  })
})
