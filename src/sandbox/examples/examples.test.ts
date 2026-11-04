import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../../core/hardware'
import type { HardwareSpec, RobotKind, SandboxFnDef, SensorSnapshot } from '../../core/types'
import { SWARM_SANDBOX_API } from '../../robots/swarm/sandboxIO'
import { SANDBOX_API as SWEEPER_SANDBOX_API } from '../../robots/sweeper/sandboxApi'
import { WALKER_SANDBOX_API } from '../../robots/walker/sandboxApi'
import { JsProgram } from '../runner/jsRunner'
import { ArduinoShim } from '../shim/arduino'
import { defaultSource, exampleInfos, examplesFor, exampleSource, type ExampleCtx } from '.'

const APIS: Record<RobotKind, readonly SandboxFnDef[]> = {
  walker: WALKER_SANDBOX_API,
  sweeper: SWEEPER_SANDBOX_API,
  swarm: SWARM_SANDBOX_API,
}

const SENSORS: Record<RobotKind, SensorSnapshot> = {
  walker: { joint: new Array(18).fill(0), load: new Array(6).fill(4.2), contact: new Array(6).fill(1), imu: [1, -2, 30], legs: 6, joints: 18 },
  sweeper: {
    lidar: Array.from({ length: 360 }, (_, d) => (d === 0 ? 0.2 : 1.5)),
    minRange: 0.2,
    frontRange: 0.2,
    pose: [0.1, -0.2, 15],
    wheel: [1, 1, 1, 1],
    bump: 1,
    coverage: 12.5,
  },
  swarm: { posX: [0, 1, 2, 3], posY: [1, 1, 1, 1], posZ: [0, 0, 1, 1], battery: [95, 80, 90, 99], speed: [0.5, 0.4, 0.3, 0.2], drones: 4 },
}

function spec(kind: RobotKind, joints: number, legs?: number): HardwareSpec {
  return { robot: kind, joints, jointNames: [], jointLimits: [], homePose: [], legs, defaultLevel: { wired: 'joint', wireless: 'high' } }
}

const CTX: Record<RobotKind, ExampleCtx> = {
  walker: { spec: spec('walker', 18, 6), hw: defaultHardwareConfig('esp32', 18) },
  sweeper: { spec: spec('sweeper', 4), hw: defaultHardwareConfig('esp32', 4) },
  swarm: { spec: spec('swarm', 4), hw: defaultHardwareConfig('esp32', 4) },
}

const REQUIRED: Record<RobotKind, string[]> = {
  walker: ['Tripod walk with walk()', 'Servo.h sweep mapped to joints', 'Body wave with setBodyPose()'],
  sweeper: ['Wall follower with readLidar()', 'Bump and turn', 'Square path with drive()'],
  swarm: ['Triangle formation hop', 'Orbit a point with setTarget()', 'Land on low battery'],
}

const KINDS: RobotKind[] = ['walker', 'sweeper', 'swarm']

describe('example catalogue', () => {
  for (const kind of KINDS) {
    it(`${kind}: offers the required examples in both dialects`, () => {
      const infos = exampleInfos(kind)
      expect(infos.map((e) => e.title)).toEqual(REQUIRED[kind])
      for (const e of infos) expect(e.dialects).toEqual(['cpp', 'js'])
    })
  }

  it('starts a fresh buffer with the first example', () => {
    expect(defaultSource('walker', 'cpp', CTX.walker)).toBe(exampleSource('walker', 'walker-tripod', 'cpp', CTX.walker))
  })

  it('returns null for an unknown example', () => {
    expect(exampleSource('walker', 'nope', 'js', CTX.walker)).toBeNull()
  })
})

/** Robot functions an example calls, by name (C++ and JS share the names). */
function calledRobotFns(src: string, api: readonly SandboxFnDef[]): string[] {
  return api.filter((f) => new RegExp(`\\b${f.name}\\s*\\(`).test(src)).map((f) => f.name)
}

describe('JS examples run against the real robot APIs', () => {
  for (const kind of KINDS) {
    for (const ex of examplesFor(kind)) {
      it(`${kind} / ${ex.title}`, async () => {
        // Arrange
        const source = exampleSource(kind, ex.id, 'js', CTX[kind])
        expect(source).not.toBeNull()
        const shim = new ArduinoShim({ ...CTX[kind].hw }, [...APIS[kind]])
        const res = JsProgram.load(source ?? '', shim)
        expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
        // Act: ten frames of 1/60 s, then one long jump past every delay
        const cmds = []
        for (let i = 0; i <= 10; i++) {
          shim.beginTick(i * 16.7, SENSORS[kind])
          const out = await res.program?.tick(i * 16.7)
          expect(out?.status).not.toBe('error')
          cmds.push(...shim.takeOutput().cmds)
        }
        shim.beginTick(20_000, SENSORS[kind])
        expect((await res.program?.tick(20_000))?.status).not.toBe('error')
        cmds.push(...shim.takeOutput().cmds)
        // Assert: the program drove the robot through its API
        expect(cmds.length).toBeGreaterThan(0)
        const names = new Set(APIS[kind].filter((f) => f.kind === 'command').map((f) => f.name))
        for (const c of cmds) expect(names.has(c.fn)).toBe(true)
      })
    }
  }
})

describe('C++ examples only call functions the robot exposes', () => {
  for (const kind of KINDS) {
    for (const ex of examplesFor(kind)) {
      it(`${kind} / ${ex.title}`, () => {
        const src = exampleSource(kind, ex.id, 'cpp', CTX[kind]) ?? ''
        expect(src).toMatch(/void (setup|loop)\(\)/)
        // every example drives the robot: through the robot API or through Servo outputs
        const drivesServos = /\bServo\s+\w+/.test(src)
        expect(drivesServos || calledRobotFns(src, APIS[kind]).length > 0).toBe(true)
        const other = KINDS.filter((k) => k !== kind).flatMap((k) => APIS[k].map((f) => f.name))
        const own = new Set(APIS[kind].map((f) => f.name))
        const foreign = other.filter((n) => !own.has(n) && new RegExp(`\\b${n}\\s*\\(`).test(src))
        expect(foreign).toEqual([])
      })
    }
  }
})

describe('Servo.h example follows the hardware profile', () => {
  it('uses the board default GPIO order on a PCA9685 profile (18 joints on ESP32)', () => {
    const src = exampleSource('walker', 'walker-servo', 'cpp', CTX.walker) ?? ''
    // femur of leg 1 is joint 1 -> default ESP32 GPIO order [13, 14, ...] -> pin 14
    expect(src).toContain('femur1.attach(14);')
    expect(src).toContain('PCA9685')
  })

  it('uses the profile pins on a GPIO profile, with STM32 pin names', () => {
    const hw: HardwareConfig = { ...defaultHardwareConfig('stm32', 12) }
    const ctx: ExampleCtx = { spec: spec('walker', 12, 4), hw }
    const src = exampleSource('walker', 'walker-servo', 'cpp', ctx) ?? ''
    // STM32 default pins in joint order: PA8 PA9 ... -> joint 1 = PA9
    expect(src).toContain('femur1.attach(PA9);')
    expect(src.match(/femur\d\.attach\(/g)).toHaveLength(4)
  })
})
