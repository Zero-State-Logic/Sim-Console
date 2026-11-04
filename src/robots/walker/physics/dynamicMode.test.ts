import { describe, expect, it } from 'vitest'
import { WalkerSim } from '../sim'
import { ACTUATOR_PRESETS } from '../actuator'
import { loadRapier, type Rapier } from './loader'
import { DynamicMode } from './dynamicMode'

const DT = 1 / 60

function deferred(): { promise: Promise<Rapier>; resolve: (r: Rapier) => void } {
  let resolve: (r: Rapier) => void = () => {}
  const promise = new Promise<Rapier>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('DynamicMode', () => {
  it('loads lazily, runs, writes the physics state into the sim and frees the world on disable', async () => {
    // Arrange
    let changes = 0
    const d = new DynamicMode(() => changes++)
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.mg996r }
    expect(d.status).toBe('off')
    // Act
    const ready = d.enable(sim)
    expect(d.status).toBe('loading')
    expect(d.enable(sim)).toBe(ready)
    expect(await ready).toBe(true)
    for (let k = 0; k < 60; k++) {
      sim.plan(DT, { vx: 0, vy: 0, wz: 0 }, false)
      d.step(DT, sim, sim.actuators.out)
    }
    // Assert
    expect(d.running).toBe(true)
    expect(changes).toBe(1)
    expect(sim.poseSource).toBe('physics')
    expect(sim.state.contact.slice(0, 6).every((c) => c === 1)).toBe(true)
    expect(d.tipped).toBe(false)
    d.disable()
    expect(d.status).toBe('off')
    expect(d.step(DT, sim, sim.actuators.out)).toBe(false)
  })

  it('respawns a fresh world for a new leg count', async () => {
    const d = new DynamicMode(() => {})
    const sim = new WalkerSim(6)
    await d.enable(sim)
    sim.configure(4, sim.layout.dims)
    d.respawn(sim)
    for (let k = 0; k < 30; k++) d.step(DT, sim, sim.actuators.out)
    expect(sim.state.contact.slice(0, 4).every((c) => c === 1)).toBe(true)
    d.dispose()
  })

  it('falls back with the error message when Rapier fails to load', async () => {
    let changes = 0
    const d = new DynamicMode(() => changes++, () => Promise.reject(new Error('wasm blocked')))
    expect(await d.enable(new WalkerSim(6))).toBe(false)
    expect(d.status).toBe('failed')
    expect(d.error).toBe('wasm blocked')
    expect(changes).toBe(1)
  })

  it('ignores a load that finishes after the user switched back to KINEMATIC', async () => {
    const R = await loadRapier()
    const slow = deferred()
    let changes = 0
    const d = new DynamicMode(() => changes++, () => slow.promise)
    const ready = d.enable(new WalkerSim(6))
    d.disable()
    slow.resolve(R)
    expect(await ready).toBe(false)
    expect(d.status).toBe('off')
    expect(changes).toBe(0)
  })
})

describe('KINEMATIC vs DYNAMIC consistency', () => {
  it('sags about the same on the same servos (shared proportional-band stiffness)', async () => {
    for (const n of [4, 6, 8] as const) {
      const kin = new WalkerSim(n)
      kin.actuator = { ...ACTUATOR_PRESETS.mg996r }
      for (let k = 0; k < 120; k++) kin.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, k * DT)
      const dyn = new WalkerSim(n)
      dyn.actuator = { ...ACTUATOR_PRESETS.mg996r }
      const d = new DynamicMode(() => {})
      await d.enable(dyn)
      for (let k = 0; k < 120; k++) d.step(DT, dyn, dyn.actuators.out)
      const kinSag = kin.pose.height - kin.state.bodyPos[2]
      const dynSag = dyn.pose.height - dyn.state.bodyPos[2]
      expect(kinSag, `${n} legs`).toBeGreaterThan(0)
      expect(dynSag, `${n} legs`).toBeGreaterThan(0)
      expect(Math.abs(kinSag - dynSag), `${n} legs`).toBeLessThan(0.003)
      d.dispose()
    }
  })
})
