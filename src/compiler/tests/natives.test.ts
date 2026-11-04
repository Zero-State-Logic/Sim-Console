import { describe, expect, it } from 'vitest'
import { compile, createVM } from '../index'
import { compileOk, OPTS, RecordingHost, runSketch } from './harness'

const inSetup = (body: string, globals = ''): string => `${globals}\nvoid setup() {\n${body}\n}\nvoid loop() {}`

describe('native calls', () => {
  it('passes static argument types so the host can format Serial.print(3) vs Serial.print(3.0)', () => {
    const body = "byte b = 7; long l = 8; String s = \"x\"; char buf[] = \"hi\"; Serial.print(3); Serial.print(3.0); Serial.print(3.0f); Serial.print('a'); Serial.print(\"t\"); Serial.print(true); Serial.print(b); Serial.print(l); Serial.print(s); Serial.print(buf);"
    const { host } = runSketch(inSetup(body))
    expect(host.callsTo('Serial.print').map((c) => c.argTypes[0])).toEqual(['int', 'double', 'float', 'char', 'string', 'bool', 'unsigned', 'long', 'string', 'string'])
    expect(host.serial).toBe('33.003.00at178xhi')
  })

  it('passes the optional format argument', () => {
    const { host } = runSketch(inSetup('Serial.println(255, HEX);'))
    const c = host.callsTo('Serial.println')[0]
    expect(c.args).toEqual([255, 16])
    expect(c.argTypes).toEqual(['int', 'int'])
  })

  it('converts arguments to the declared parameter types', () => {
    const { host } = runSketch(inSetup('setJoint(2.9, 45); setJoint(1, 0.1);'))
    const calls = host.callsTo('setJoint')
    expect(calls[0].args).toEqual([2, 45])
    expect(calls[0].argTypes).toEqual(['int', 'float'])
    expect(calls[1].args[1]).toBe(Math.fround(0.1))
  })

  it('converts results to the declared return type', () => {
    const src = inSetup('float f = readLoad(0); bool r = isReady(); int pin = digitalRead(2); Serial.print(f, 4); Serial.print(r); Serial.print(pin);')
    const r = compileOk(src)
    const host = new RecordingHost()
    host.answers = { readLoad: () => 0.1, isReady: () => true, digitalRead: () => 1.9 }
    createVM(r.program!, host).run(10000, 0)
    expect(host.serial).toBe('0.100011')
  })

  it('passes String parameters as text and rejects implicit number → String', () => {
    const { host } = runSketch(inSetup('setName("walker"); String n = "six"; setName(n + 6);'))
    expect(host.callsTo('setName').map((c) => c.args[0])).toEqual(['walker', 'six6'])
    expect(compile(inSetup('setName(5);'), OPTS).ok).toBe(false)
  })

  it('treats Serial as true in conditions (while (!Serial);)', () => {
    expect(runSketch(inSetup('Serial.begin(115200); while (!Serial) ; if (Serial) Serial.print("up");')).out).toBe('up')
  })

  it('turns a host exception into a runtime error at the call', () => {
    const r = compileOk(inSetup('int a = 1;\n  analogWrite(3, a);'))
    const host = new RecordingHost()
    host.answers = {
      analogWrite: () => {
        throw new Error('pin 3 has no PWM')
      },
    }
    const res = createVM(r.program!, host).run(10000, 0)
    expect(res.status).toBe('error')
    expect(res.error?.message).toBe('analogWrite(): pin 3 has no PWM')
    expect(res.error?.line).toBe(4)
  })
})

describe('native classes', () => {
  it('constructs global objects before setup() and passes the handle as self', () => {
    const { host } = runSketch('#include <Servo.h>\nServo s;\nvoid setup() { s.attach(9); s.write(90); }\nvoid loop() {}')
    expect(host.constructed.map((c) => c.cls)).toEqual(['Servo'])
    const h = host.constructed[0].handle
    expect(host.calls.map((c) => [c.name, c.args, c.self])).toEqual([
      ['Servo.attach', [9], h],
      ['Servo.write', [90], h],
    ])
  })

  it('constructs every element of a Servo array with its own handle', () => {
    const { host } = runSketch('Servo legs[18];\nvoid setup() { for (int i = 0; i < 18; i++) legs[i].attach(i + 2); legs[17].write(45); }\nvoid loop() {}')
    expect(host.constructed).toHaveLength(18)
    const handles = host.constructed.map((c) => c.handle)
    expect(new Set(handles).size).toBe(18)
    const attaches = host.callsTo('Servo.attach')
    expect(attaches.map((c) => c.args[0])).toEqual(Array.from({ length: 18 }, (_, i) => i + 2))
    expect(attaches.map((c) => c.self)).toEqual(handles)
    expect(host.callsTo('Servo.write')[0].self).toBe(handles[17])
  })

  it('supports the three constructor spellings with arguments', () => {
    const src = 'Adafruit_PWMServoDriver a = Adafruit_PWMServoDriver();\nAdafruit_PWMServoDriver b = Adafruit_PWMServoDriver(0x41);\nAdafruit_PWMServoDriver c(0x42);\nvoid setup() { b.begin(); b.setPWMFreq(50); b.setPWM(0, 0, 307); }\nvoid loop() {}'
    const { host } = runSketch(src)
    expect(host.constructed.map((c) => c.args)).toEqual([[], [0x41], [0x42]])
    expect(host.callsTo('Adafruit_PWMServoDriver.setPWM')[0].args).toEqual([0, 0, 307])
    expect(host.callsTo('Adafruit_PWMServoDriver.setPWMFreq')[0].argTypes).toEqual(['float'])
  })

  it('passes native objects to functions by value or reference as handles', () => {
    const src = 'Servo a;\nvoid center(Servo &s) { s.write(90); }\nvoid park(Servo s) { s.write(0); }\nvoid setup() { center(a); park(a); }\nvoid loop() {}'
    const { host } = runSketch(src)
    const h = host.constructed[0].handle
    expect(host.callsTo('Servo.write').map((c) => [c.args[0], c.self])).toEqual([[90, h], [0, h]])
  })

  it('constructs local native objects each time their declaration runs', () => {
    const { host } = runSketch('void setup() { for (int i = 0; i < 2; i++) { Servo t; t.attach(i); } }\nvoid loop() {}')
    expect(host.constructed).toHaveLength(2)
  })

  it('reports a host that returns no handle', () => {
    const r = compileOk('Servo s;\nvoid setup() {}\nvoid loop() {}')
    const host = new RecordingHost()
    host.constructNative = (): number => Number.NaN
    const res = createVM(r.program!, host).run(1000, 0)
    expect(res.status).toBe('error')
    expect(res.error?.message).toMatch(/no object handle/)
  })
})
