import { describe, expect, it } from 'vitest'
import { gaitsFor } from '../../codegen/gaits'
import { gaitFoot, gaitTuning, legFk, legIk, neutralFeet } from '../../codegen/walkerGeom'
import { geomOf, walkerGeometrySpec } from './fixtures'
import { OnboardGait } from './walkerGait'

function footOf(gait: OnboardGait, q: Float64Array, leg: number): [number, number, number] {
  return legFk(gait.geom, leg, [q[leg * 3], q[leg * 3 + 1], q[leg * 3 + 2]])
}

function walk(gait: OnboardGait, q: Float64Array, seconds: number, dt = 0.01): void {
  for (let t = 0; t < seconds; t += dt) gait.step(dt, q)
}

describe('OnboardGait: construction and IK', () => {
  it('is built only from a walker spec with usable geometry', () => {
    // Arrange
    const spec = walkerGeometrySpec(6)
    const { geometry: _drop, ...bare } = spec
    // Act / Assert
    expect(OnboardGait.fromSpec(spec)).not.toBeNull()
    expect(OnboardGait.fromSpec(bare)).toBeNull()
    expect(OnboardGait.fromSpec({ ...spec, robot: 'sweeper' })).toBeNull()
    expect(OnboardGait.fromSpec({ ...spec, joints: 17 })).toBeNull()
  })

  it('matches the codegen reference IK the firmware is transliterated from', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const out = new Float64Array(3)
    const targets: [number, number, number][] = [
      [0.17, 0.12, -0.09],
      [0.0, 0.24, -0.05],
      [-0.15, 0.1, -0.12],
      [0.14, -0.14, -0.07],
    ]
    for (let leg = 0; leg < 6; leg++) {
      for (const [x, y, z] of targets) {
        // Act
        const ok = gait.ik(leg, x, y, z, out, 0)
        const ref = legIk(gait.geom, leg, x, y, z)
        // Assert
        expect(ok).toBe(ref.reachable)
        for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(ref.q[k], 9)
      }
    }
  })

  it('reports an out-of-reach target and clamps it onto the reach shell', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const g = gait.geom
    const out = new Float64Array(3)
    // Act
    const ok = gait.ik(0, 1, 1, -0.1, out, 0)
    // Assert: the foot lands on the femur + tibia shell around the femur joint
    expect(ok).toBe(false)
    const foot = legFk(g, 0, [out[0], out[1], out[2]])
    const yaw = Math.atan2(foot[1] - g.mountY[0], foot[0] - g.mountX[0])
    const kx = foot[0] - g.mountX[0] - g.coxa * Math.cos(yaw)
    const ky = foot[1] - g.mountY[0] - g.coxa * Math.sin(yaw)
    expect(Math.hypot(Math.hypot(kx, ky), foot[2])).toBeCloseTo(g.femur + g.tibia - 0.001, 6)
  })
})

describe('OnboardGait: gait loop', () => {
  it('stands on the neutral feet at the stand height when no twist is commanded', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const q = new Float64Array(18)
    const nf = neutralFeet(gait.geom)
    // Act
    gait.activate(q)
    walk(gait, q, 1)
    // Assert
    for (let i = 0; i < 6; i++) {
      const f = footOf(gait, q, i)
      expect(f[0]).toBeCloseTo(nf.x[i], 6)
      expect(f[1]).toBeCloseTo(nf.y[i], 6)
      expect(f[2]).toBeCloseTo(-gait.geom.standHeight, 6)
    }
  })

  it('writes exactly the firmware foot trajectory (gaitFoot) through the IK', () => {
    // Arrange
    const spec = walkerGeometrySpec(6)
    const g = geomOf(spec)
    const gait = OnboardGait.fromSpec(spec) as OnboardGait
    const gd = gaitsFor(g)[0]
    const nf = neutralFeet(g)
    const q = new Float64Array(18)
    gait.activate(q)
    gait.command([0.05, 0, 0], 'tripod', undefined)
    walk(gait, q, 3)
    // Act: rebuild one leg's target from the reference with the gait's own state
    gait.step(0.01, q)
    const tune = gaitTuning(g)
    const vmax = Math.max(...nf.x.map((_, i) => Math.hypot(gait.sx - gait.sw * nf.y[i], gait.sy + gait.sw * nf.x[i])))
    let cycle = tune.cycleMaxS
    if (vmax * cycle * gd.duty > tune.maxStride) cycle = Math.min(Math.max(tune.maxStride / (vmax * gd.duty), tune.cycleMinS), tune.cycleMaxS)
    const scale = vmax * cycle * gd.duty > tune.maxStride ? tune.maxStride / (vmax * cycle * gd.duty) : 1
    const span = cycle * gd.duty * scale
    const leg = 2
    const ph = ((gait.phase - gd.offsets[leg]) % 1 + 1) % 1
    const ref = gaitFoot(nf.x[leg], nf.y[leg], gait.sx * span, gait.sy * span, ph, gd.duty, gait.lift * tune.stepHeight, gait.hs)
    // Assert
    const f = footOf(gait, q, leg)
    for (let k = 0; k < 3; k++) expect(f[k]).toBeCloseTo(ref[k], 6)
  })

  it('slides planted feet at −(v + ω × r_neutral), the firmware stance stroke', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const q = new Float64Array(18)
    const v: [number, number, number] = [0.04, 0.02, 0.3]
    gait.activate(q)
    gait.command(v, 'tripod', undefined)
    walk(gait, q, 4)
    const before = Array.from({ length: 6 }, (_, i) => footOf(gait, q, i))
    const dt = 0.005
    // Act
    gait.step(dt, q)
    // Assert: every stance foot (on the ground before and after) slid by −(v + ω × r)·dt, with
    // r the leg's neutral point (the firmware's straight stance chord)
    let checked = 0
    for (let i = 0; i < 6; i++) {
      const a = before[i]
      const b = footOf(gait, q, i)
      if (a[2] > -gait.hs + 1e-6 || b[2] > -gait.hs + 1e-6) continue
      checked++
      const [nx, ny] = gait.neutral(i)
      expect((b[0] - a[0]) / dt).toBeCloseTo(-(gait.sx - gait.sw * ny), 4)
      expect((b[1] - a[1]) / dt).toBeCloseTo(-(gait.sy + gait.sw * nx), 4)
    }
    expect(checked).toBeGreaterThanOrEqual(3)
  })

  it('keeps three legs down in a tripod and lifts swing feet by at most the step height', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const q = new Float64Array(18)
    gait.activate(q)
    gait.command([0.06, 0, 0], 'tripod', undefined)
    walk(gait, q, 3)
    let maxLift = 0
    // Act / Assert
    for (let s = 0; s < 200; s++) {
      gait.step(0.01, q)
      let down = 0
      for (let i = 0; i < 6; i++) {
        const lift = footOf(gait, q, i)[2] + gait.hs
        maxLift = Math.max(maxLift, lift)
        if (lift < 1e-6) down++
      }
      expect(down).toBeGreaterThanOrEqual(3)
    }
    expect(maxLift).toBeLessThanOrEqual(gait.tuning.stepHeight + 1e-9)
    expect(maxLift).toBeGreaterThan(0.8 * gait.tuning.stepHeight)
  })

  it('shortens the cycle at speed so no stance stroke exceeds the max stride', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const q = new Float64Array(18)
    gait.activate(q)
    gait.command([0.5, 0, 0], 'wave', undefined)
    walk(gait, q, 3)
    let lo = Infinity
    let hi = -Infinity
    // Act: one full cycle of leg 0's x travel
    for (let s = 0; s < 300; s++) {
      gait.step(0.01, q)
      const f = footOf(gait, q, 0)
      lo = Math.min(lo, f[0])
      hi = Math.max(hi, f[0])
    }
    // Assert
    expect(hi - lo).toBeLessThanOrEqual(gait.tuning.maxStride + 1e-6)
    expect(hi - lo).toBeGreaterThan(0.9 * gait.tuning.maxStride)
  })

  it('selects gaits by name or alias and keeps the current one on an unknown name', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(4)) as OnboardGait
    // Act
    const a = gait.command([0, 0, 0], 'trot', undefined)
    const nameA = gait.gaitName
    const b = gait.command([0, 0, 0], 'tripod', undefined)
    const nameB = gait.gaitName
    const c = gait.command([0, 0, 0], 'moonwalk', undefined)
    // Assert
    expect(a).toBeNull()
    expect(nameA).toBe('trot')
    expect(b).toBeNull()
    expect(nameB).toBe('trot')
    expect(c).toMatch(/unknown gait 'moonwalk', keeping trot/)
    expect(gait.gaitName).toBe('trot')
  })

  it('clamps the commanded body height to the tuning range and eases toward it', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const q = new Float64Array(18)
    gait.activate(q)
    // Act
    gait.command([0, 0, 0], undefined, 5)
    const high = gait.h
    gait.command([0, 0, 0], undefined, 0.001)
    walk(gait, q, 3)
    // Assert
    expect(high).toBeCloseTo(gait.tuning.heightMax, 9)
    expect(gait.h).toBeCloseTo(gait.tuning.heightMin, 9)
    expect(footOf(gait, q, 0)[2]).toBeCloseTo(-gait.tuning.heightMin, 3)
  })

  it('halt stops walking but keeps stepping; stop hands control back', () => {
    // Arrange
    const gait = OnboardGait.fromSpec(walkerGeometrySpec(6)) as OnboardGait
    const q = new Float64Array(18)
    gait.activate(q)
    gait.command([0.05, 0, 0], undefined, undefined)
    walk(gait, q, 2)
    // Act
    gait.halt()
    walk(gait, q, 3)
    const settled = gait.sx
    gait.stop()
    // Assert
    expect(Math.abs(settled)).toBeLessThan(1e-4)
    expect(gait.active).toBe(false)
    expect(gait.takeIkMisses()).toBe(0)
  })
})
