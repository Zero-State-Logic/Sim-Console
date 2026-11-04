import { describe, expect, it } from 'vitest'
import { legIK as simLegIk } from '../robots/walker/kinematics'
import { walkerGeom, walkerSpec } from './testing/fixtures'
import { gaitFoot, gaitTuning, legFk, legIk, neutralFeet, readWalkerGeometry } from './walkerGeom'

const DEG = Math.PI / 180

describe('on-board leg IK', () => {
  const g = walkerGeom(6)

  it('round-trips through forward kinematics for reachable targets on every leg', () => {
    const feet = neutralFeet(g)
    for (let leg = 0; leg < g.legs; leg++) {
      for (const [dx, dy, z] of [
        [0, 0, -0.085],
        [0.03, -0.02, -0.06],
        [-0.04, 0.03, -0.11],
        [0.02, 0.02, -0.05],
      ]) {
        const target: [number, number, number] = [feet.x[leg] + dx, feet.y[leg] + dy, z]
        const { q, reachable } = legIk(g, leg, ...target)
        const back = legFk(g, leg, q)
        expect(reachable).toBe(true)
        for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(target[k], 9)
      }
    }
  })

  it('clamps an out-of-reach target onto the workspace and reports it', () => {
    const { q, reachable } = legIk(g, 0, 2, -2, -0.5)
    const back = legFk(g, 0, q)
    const yaw = g.mountYawDeg[0] * DEG
    const lx = Math.cos(yaw) * (back[0] - g.mountX[0]) + Math.sin(yaw) * (back[1] - g.mountY[0])
    const ly = -Math.sin(yaw) * (back[0] - g.mountX[0]) + Math.cos(yaw) * (back[1] - g.mountY[0])
    expect(reachable).toBe(false)
    expect(Math.hypot(Math.hypot(lx, ly) - g.coxa, back[2])).toBeCloseTo(g.femur + g.tibia - 0.001, 6)
  })

  it('agrees with the walker module IK (same joint conventions as the sim)', () => {
    const out = new Float64Array(3)
    const feet = neutralFeet(g)
    for (let leg = 0; leg < g.legs; leg++) {
      const yaw = g.mountYawDeg[leg] * DEG
      for (const [dx, dy, z] of [
        [0, 0, -0.085],
        [0.02, -0.015, -0.07],
      ]) {
        const px = feet.x[leg] + dx
        const py = feet.y[leg] + dy
        const { q } = legIk(g, leg, px, py, z)
        // the sim's IK takes the foot in the leg frame
        const lx = Math.cos(yaw) * (px - g.mountX[leg]) + Math.sin(yaw) * (py - g.mountY[leg])
        const ly = -Math.sin(yaw) * (px - g.mountX[leg]) + Math.cos(yaw) * (py - g.mountY[leg])
        simLegIk({ coxa: g.coxa, femur: g.femur, tibia: g.tibia, bodyRadius: 0.11 }, lx, ly, z, out, 0)
        for (let k = 0; k < 3; k++) expect(q[k]).toBeCloseTo(out[k] / DEG, 1)
      }
    }
  })

  it('reproduces the reference stance: femur raised 35°, tibia 10° off vertical (knee up)', () => {
    const feet = neutralFeet(g)
    const { q } = legIk(g, 0, feet.x[0], feet.y[0], -g.standHeight)
    expect(q[0]).toBeCloseTo(0, 6)
    expect(q[1]).toBeCloseTo(35, 1)
    // tibia 0 = perpendicular to the femur, so 10° off vertical = 10 - 35 = -25°
    expect(q[2]).toBeCloseTo(-25, 1)
  })
})

describe('gait foot trajectory', () => {
  it('slides a stance foot from +stride/2 to -stride/2 on the ground', () => {
    const start = gaitFoot(0.2, 0.1, 0.04, 0, 0, 0.5, 0.03, 0.09)
    const end = gaitFoot(0.2, 0.1, 0.04, 0, 0.4999, 0.5, 0.03, 0.09)
    expect(start).toEqual([0.22, 0.1, -0.09])
    expect(end[0]).toBeCloseTo(0.18, 4)
    expect(end[2]).toBe(-0.09)
  })

  it('lifts the swing foot to the step height halfway through the swing', () => {
    const mid = gaitFoot(0.2, 0.1, 0.04, 0, 0.75, 0.5, 0.03, 0.09)
    expect(mid[0]).toBeCloseTo(0.2, 9)
    expect(mid[2]).toBeCloseTo(-0.06, 9)
  })
})

describe('geometry reading', () => {
  it('reads a complete spec', () => {
    const { geom, errors } = readWalkerGeometry(walkerSpec(8))
    expect(errors).toEqual([])
    expect(geom?.legs).toBe(8)
    expect(geom?.mountX).toHaveLength(8)
  })

  it('names every missing or malformed field', () => {
    const spec = { ...walkerSpec(4), geometry: { coxa: 0.04, femur: -1, mountX: [0, 0] } }
    const { geom, errors } = readWalkerGeometry(spec)
    expect(geom).toBeNull()
    expect(errors.join(' ')).toMatch(/femur/)
    expect(errors.join(' ')).toMatch(/tibia/)
    expect(errors.join(' ')).toMatch(/mountX' must be 4/)
  })

  it('rejects a stand height the legs cannot reach', () => {
    const spec = walkerSpec(6)
    const { errors } = readWalkerGeometry({ ...spec, geometry: { ...spec.geometry, standHeight: 0.5 } })
    expect(errors[0]).toMatch(/standHeight/)
  })

  it('keeps the tuning inside the leg workspace', () => {
    const g = walkerGeom(6)
    const t = gaitTuning(g)
    expect(t.heightMax).toBeLessThan(g.femur + g.tibia)
    expect(t.heightMin).toBeLessThan(g.standHeight)
    expect(t.stepHeight).toBeGreaterThan(0)
    expect(t.stepHeight).toBeLessThanOrEqual(0.06)
  })
})
