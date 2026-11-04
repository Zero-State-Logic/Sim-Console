import { describe, expect, it } from 'vitest'
import { compile, createVM } from '../../compiler'
import { defaultHardwareConfig } from '../../core/hardware'
import type { HardwareSpec, RobotKind, SandboxFnDef, SensorSnapshot } from '../../core/types'
import { SWARM_SANDBOX_API } from '../../robots/swarm/sandboxIO'
import { SANDBOX_API as SWEEPER_SANDBOX_API } from '../../robots/sweeper/sandboxApi'
import { WALKER_SANDBOX_API } from '../../robots/walker/sandboxApi'
import { examplesFor, exampleSource, type ExampleCtx } from '../examples'
import { ArduinoShim } from '../shim/arduino'
import { buildCompileOptions } from '../shim/cppBinding'
import { CppProgram, type CompilerFns } from './cppRunner'

/*
 * Runs the sandbox against the REAL compiler (src/compiler): the full path from
 * source text to robot commands, with nothing mocked.
 */

const COMPILER: CompilerFns = { compile, createVM }

function compilerReady(): boolean {
  try {
    return compile('void setup() {}\nvoid loop() {}\n', buildCompileOptions([], 'esp32', 32)).ok
  } catch {
    return false
  }
}

const READY = compilerReady()

const APIS: Record<RobotKind, readonly SandboxFnDef[]> = {
  walker: WALKER_SANDBOX_API,
  sweeper: SWEEPER_SANDBOX_API,
  swarm: SWARM_SANDBOX_API,
}

const SENSORS: Record<RobotKind, SensorSnapshot> = {
  walker: { joint: new Array(18).fill(0), load: new Array(6).fill(4), contact: new Array(6).fill(1), imu: [1, 2, 3], legs: 6, joints: 18 },
  sweeper: { lidar: Array.from({ length: 360 }, () => 1.2), minRange: 0.3, frontRange: 1.2, pose: [0, 0, 0], wheel: [0, 0, 0, 0], bump: 0, coverage: 3 },
  swarm: { posX: [0, 1, 2], posY: [1, 1, 1], posZ: [0, 0, 0], battery: [99, 98, 97], speed: [0, 0, 0], drones: 3 },
}

function spec(kind: RobotKind, joints: number, legs?: number): HardwareSpec {
  return { robot: kind, joints, jointNames: [], jointLimits: [], homePose: [], legs, defaultLevel: { wired: 'joint', wireless: 'high' } }
}

const CTX: Record<RobotKind, ExampleCtx> = {
  walker: { spec: spec('walker', 18, 6), hw: defaultHardwareConfig('esp32', 18) },
  sweeper: { spec: spec('sweeper', 4), hw: defaultHardwareConfig('esp32', 4) },
  swarm: { spec: spec('swarm', 3), hw: defaultHardwareConfig('esp32', 3) },
}

function load(kind: RobotKind, source: string, joints = 18) {
  const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', joints) }, [...APIS[kind]])
  const res = CppProgram.load(source, shim, 32, COMPILER)
  return { shim, res }
}

describe.skipIf(!READY)('C++ examples compile and run on the real compiler', () => {
  for (const kind of ['walker', 'sweeper', 'swarm'] as RobotKind[]) {
    for (const ex of examplesFor(kind)) {
      it(`${kind} / ${ex.title}`, () => {
        const { shim, res } = load(kind, exampleSource(kind, ex.id, 'cpp', CTX[kind]) ?? '')
        expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
        let cmds = 0
        for (let i = 0; i < 30; i++) {
          shim.beginTick(i * 16.7, SENSORS[kind])
          const out = res.program?.tick(i * 16.7)
          expect(out?.status === 'error' ? out.error : null).toBeNull()
          cmds += shim.takeOutput().cmds.length
        }
        expect(cmds).toBeGreaterThan(0)
      })
    }
  }
})

describe.skipIf(!READY)('Arduino shim on the real VM', () => {
  it('formats Serial.print by static type', () => {
    const { shim, res } = load('walker', 'void setup() {\n  Serial.begin(115200);\n  int i = 3;\n  float f = 3;\n  Serial.print(i);\n  Serial.print(" ");\n  Serial.print(f);\n  Serial.print(" ");\n  Serial.println(255, HEX);\n}\nvoid loop() {}\n')
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    shim.beginTick(0, SENSORS.walker)
    res.program?.tick(0)
    expect(shim.takeOutput().serial.join('')).toBe('3 3.00 FF\r\n')
  })

  it('maps Servo.attach(pin) + write() to setJoint through the profile', () => {
    // 12-joint ESP32 profile drives servos from GPIO; joint 1 = GPIO 14
    const src = '#include <Servo.h>\nServo s;\nvoid setup() { s.attach(14); }\nvoid loop() { s.write(120); }\n'
    const { shim, res } = load('walker', src, 12)
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    shim.beginTick(0, SENSORS.walker)
    res.program?.tick(0)
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [1, 30] }])
  })

  it('maps PCA9685 setPWM channels to joints', () => {
    const src = '#include <Wire.h>\n#include <Adafruit_PWMServoDriver.h>\nAdafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);\nvoid setup() { pwm.begin(); pwm.setPWMFreq(50); }\nvoid loop() { pwm.writeMicroseconds(3, 1700); }\n'
    const { shim, res } = load('walker', src, 18)
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    shim.beginTick(0, SENSORS.walker)
    res.program?.tick(0)
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [3, 18] }])
  })

  it('reads queries by index and sleeps in delay() on the virtual clock', () => {
    const src = 'void setup() { Serial.begin(9600); }\nvoid loop() {\n  Serial.println(readLoad(2), 1);\n  delay(100);\n}\n'
    const { shim, res } = load('walker', src)
    shim.beginTick(0, { ...SENSORS.walker, load: [1, 2, 7.26, 4, 5, 6] })
    const first = res.program?.tick(0)
    expect(shim.takeOutput().serial.join('')).toBe('7.3\r\n')
    expect(first).toMatchObject({ status: 'sleeping', wakeAtMs: 100 })
    shim.beginTick(50, SENSORS.walker)
    expect(res.program?.tick(50)?.status).toBe('sleeping')
  })

  it('compiles a pasted kiyobridge sketch with the no-op Bridge', () => {
    const src = '#include "kiyobridge.h"\nvoid setup() { Bridge.begin(); }\nvoid loop() { Bridge.update(); }\n'
    const { shim, res } = load('walker', src)
    expect(res.program).not.toBeNull()
    shim.beginTick(0, SENSORS.walker)
    res.program?.tick(0)
    expect(shim.takeOutput().log[0].level).toBe('info')
  })

  it('keeps delay() periods exact at 60 fps: delay(20) runs loop() at 50 Hz, delay(100) at 10 Hz', () => {
    for (const [ms, want] of [[20, 50], [30, 33], [100, 10]] as const) {
      // Arrange
      const { shim, res } = load('walker', `void loop() {\n  Serial.println(millis());\n  delay(${ms});\n}\n`)
      let text = ''
      // Act: two seconds of frames
      for (let i = 0; i <= 120; i++) {
        const t = (i * 1000) / 60
        shim.beginTick(t, SENSORS.walker)
        res.program?.tick(t)
        text += shim.takeOutput().serial.join('')
      }
      // Assert: loop() count over the second second, and millis() steps by exactly `ms`
      const stamps = text.trim().split('\r\n').map(Number)
      const second = stamps.filter((v) => v >= 1000 && v < 2000)
      expect(second.length).toBeGreaterThanOrEqual(want - 1)
      expect(second.length).toBeLessThanOrEqual(want + 1)
      expect(second[1] - second[0]).toBe(ms)
    }
  })

  it('caps a delay() shorter than a frame at one loop() per frame without drifting', () => {
    const { shim, res } = load('walker', 'void loop() {\n  Serial.println(millis());\n  delay(5);\n}\n')
    let text = ''
    for (let i = 0; i <= 60; i++) {
      const t = (i * 1000) / 60
      shim.beginTick(t, SENSORS.walker)
      res.program?.tick(t)
      text += shim.takeOutput().serial.join('')
    }
    const stamps = text.trim().split('\r\n').map(Number)
    expect(stamps.length).toBeGreaterThanOrEqual(58)
    expect(1000 - stamps[stamps.length - 1]).toBeLessThanOrEqual(25)
  })

  it('spends the budget on a runaway loop instead of hanging', () => {
    const { shim, res } = load('walker', 'void loop() { while (true) { } }\n')
    shim.beginTick(0, SENSORS.walker)
    const out = res.program?.tick(0)
    expect(out?.status).toBe('running')
    expect(out?.loops).toBe(0)
    expect(out?.executed).toBeGreaterThan(1000)
  })
})

describe('integration test gate', () => {
  it('reports whether the real compiler is available', () => {
    expect(typeof READY).toBe('boolean')
  })
})
