import { describe, expect, it } from 'vitest'
import { createVM, type ValueType, type VM, type VMValue } from '../index'
import { compileOk, RecordingHost } from './harness'

/** Host that tracks the latest angle written to each servo handle. */
class ServoBench extends RecordingHost {
  readonly angle = new Map<number, number>()
  readonly pin = new Map<number, number>()

  callNative(name: string, args: VMValue[], argTypes: ValueType[], self: number | null): VMValue | void {
    super.callNative(name, args, argTypes, self)
    if (self === null) return
    if (name === 'Servo.attach') this.pin.set(self, Number(args[0]))
    if (name === 'Servo.write') this.angle.set(self, Number(args[0]))
    return 1
  }
}

/** Advances virtual time in fixed frames, like the sandbox does at 60 fps. */
function runUntil(vm: VM, endMs: number, frameMs: number, startMs = 0): void {
  for (let t = startMs; t < endMs; t += frameMs) vm.run(200_000, t)
  vm.run(200_000, endMs)
}

const SWEEP = `#include <Servo.h>

Servo myservo;  // create servo object to control a servo
int pos = 0;    // variable to store the servo position

void setup() {
  myservo.attach(9);  // attaches the servo on pin 9 to the servo object
}

void loop() {
  for (pos = 0; pos <= 180; pos += 1) { // goes from 0 degrees to 180 degrees
    myservo.write(pos);
    delay(15);
  }
  for (pos = 180; pos >= 0; pos -= 1) {
    myservo.write(pos);
    delay(15);
  }
}
`

describe('sketch: the classic Servo Sweep example', () => {
  it('attaches pin 9 and follows the 15 ms per degree timing in virtual time', () => {
    // Arrange
    const host = new ServoBench()
    const vm = createVM(compileOk(SWEEP, undefined).program!, host, { maxLoopsPerRun: 1000 })
    const servo = (): number => host.constructed[0].handle
    // Act + Assert: the write for degree k happens at t = 15k ms
    runUntil(vm, 1000, 1000 / 60)
    expect(host.pin.get(servo())).toBe(9)
    expect(host.angle.get(servo())).toBe(66)
    runUntil(vm, 2700, 1000 / 60, 1000)
    expect(host.angle.get(servo())).toBe(180)
    // on the way back: at t = 2715 + 15j the angle is 180 - j
    runUntil(vm, 3015, 1000 / 60, 2700)
    expect(host.angle.get(servo())).toBe(160)
    expect(vm.getGlobals().pos).toBe(160)
  })

  it('writes the full 0..180..0 sequence once per loop()', () => {
    const host = new ServoBench()
    const vm = createVM(compileOk(SWEEP).program!, host, { maxLoopsPerRun: 1 })
    let done = false
    for (let t = 0; t < 6000 && !done; t += 5) done = vm.run(1_000_000, t).loopCompleted
    const writes = host.callsTo('Servo.write').map((c) => c.args[0])
    expect(done).toBe(true)
    expect(writes).toHaveLength(362)
    expect(writes.slice(0, 3)).toEqual([0, 1, 2])
    expect(writes[180]).toBe(180)
    expect(writes[181]).toBe(180)
    expect(writes[361]).toBe(0)
  })
})

const TRIPOD = `// 18-servo hexapod: tripod gait timed with millis()
#include <Servo.h>

#define LEGS 6
#define JOINTS 3
const unsigned long STEP_MS = 400;   // one half-cycle (one tripod swings)
const int STRIDE = 20;               // coxa swing, degrees
const int LIFT = 30;                 // femur lift, degrees

Servo legs[LEGS * JOINTS];
const byte pins[LEGS * JOINTS] = {
  2, 3, 4,   5, 6, 7,   8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19
};

unsigned long phaseStart = 0;
int phase = 0;

struct Joint { int coxa; int femur; int tibia; };

bool inTripodA(int leg) { return leg % 2 == 0; }   // legs 0, 2, 4 vs 1, 3, 5

void writeLeg(int leg, const Joint &j) {
  legs[leg * JOINTS + 0].write(j.coxa);
  legs[leg * JOINTS + 1].write(j.femur);
  legs[leg * JOINTS + 2].write(j.tibia);
}

Joint pose(bool swing, float t) {
  int sweep = (int)(STRIDE * (t - 0.5) * 2);
  int lift = swing ? (int)(LIFT * sin(PI * t)) : 0;
  Joint j = { swing ? 90 + sweep : 90 - sweep, 90 + lift, 90 - lift / 2 };
  return j;
}

void setup() {
  for (int i = 0; i < LEGS * JOINTS; i++) legs[i].attach(pins[i]);
  phaseStart = millis();
}

void loop() {
  unsigned long now = millis();
  if (now - phaseStart >= STEP_MS) {
    phase = 1 - phase;
    phaseStart += STEP_MS;
  }
  float t = (float)(now - phaseStart) / STEP_MS;
  for (int leg = 0; leg < LEGS; leg++) {
    bool swing = inTripodA(leg) == (phase == 0);
    writeLeg(leg, pose(swing, t));
  }
  delay(20);
}
`

describe('sketch: 18-servo tripod gait with Servo legs[18] and millis() timing', () => {
  function bench(): { host: ServoBench; vm: VM; joint: (leg: number, j: number) => number | undefined } {
    const host = new ServoBench()
    const vm = createVM(compileOk(TRIPOD).program!, host, { maxLoopsPerRun: 1000 })
    const joint = (leg: number, j: number): number | undefined => host.angle.get(host.constructed[leg * 3 + j].handle)
    return { host, vm, joint }
  }

  it('constructs 18 servos and attaches them to pins 2..19 in order', () => {
    const { host, vm } = bench()
    vm.run(100_000, 0)
    expect(host.constructed).toHaveLength(18)
    expect(host.constructed.map((c) => host.pin.get(c.handle))).toEqual(Array.from({ length: 18 }, (_, i) => i + 2))
  })

  it('lifts tripod A mid-swing while tripod B stands', () => {
    const { vm, joint } = bench()
    runUntil(vm, 200, 1000 / 60)
    // t = 0.5: coxa centred, femur lifted by 30, tibia folded by 15
    for (const leg of [0, 2, 4]) expect([joint(leg, 0), joint(leg, 1), joint(leg, 2)]).toEqual([90, 120, 75])
    for (const leg of [1, 3, 5]) expect([joint(leg, 0), joint(leg, 1), joint(leg, 2)]).toEqual([90, 90, 90])
  })

  it('sweeps the coxas in opposite directions at a quarter phase', () => {
    const { vm, joint } = bench()
    runUntil(vm, 100, 1000 / 60)
    // t = 0.25: sweep = -10, lift = (int)(30 sin(pi/4)) = 21
    expect([joint(0, 0), joint(0, 1), joint(0, 2)]).toEqual([80, 111, 80])
    expect([joint(1, 0), joint(1, 1), joint(1, 2)]).toEqual([100, 90, 90])
  })

  it('switches tripods every 400 ms', () => {
    const { vm, joint } = bench()
    runUntil(vm, 600, 1000 / 60)
    expect(vm.getGlobals().phase).toBe(1)
    expect(joint(1, 1)).toBe(120)
    expect(joint(0, 1)).toBe(90)
    runUntil(vm, 1000, 1000 / 60, 600)
    expect(vm.getGlobals().phase).toBe(0)
    expect(joint(0, 1)).toBe(120)
  })

  it('runs 10 seconds of gait well inside the frame budget', () => {
    const { vm, host } = bench()
    const t0 = performance.now()
    runUntil(vm, 10_000, 1000 / 60)
    const ms = performance.now() - t0
    expect(vm.status).toBe('sleeping')
    // 500 loop() iterations × 18 servo writes
    expect(host.callsTo('Servo.write').length).toBe(501 * 18)
    expect(ms).toBeLessThan(2000)
  })
})

const BLINK_WITHOUT_DELAY = `const int ledPin = LED_BUILTIN;
int ledState = LOW;
unsigned long previousMillis = 0;
const long interval = 1000;

void setup() {
  pinMode(ledPin, OUTPUT);
}

void loop() {
  unsigned long currentMillis = millis();
  if (currentMillis - previousMillis >= interval) {
    previousMillis = currentMillis;
    if (ledState == LOW) {
      ledState = HIGH;
    } else {
      ledState = LOW;
    }
    digitalWrite(ledPin, ledState);
  }
}
`

const PCA9685_TEST = `#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver();

#define SERVOMIN  150 // minimum pulse length count (out of 4096)
#define SERVOMAX  600 // maximum pulse length count (out of 4096)
#define SERVO_FREQ 50 // analog servos run at ~50 Hz

uint8_t servonum = 0;

void setup() {
  Serial.begin(9600);
  Serial.println(F("8 channel Servo test!"));
  pwm.begin();
  pwm.setPWMFreq(SERVO_FREQ);
  delay(10);
}

void setServoPulse(uint8_t n, double pulse) {
  double pulselength;
  pulselength = 1000000;     // 1,000,000 us per second
  pulselength /= SERVO_FREQ; // 50 Hz
  pulselength /= 4096;       // 12 bits of resolution
  pulse *= 1000000;          // convert input seconds to us
  pulse /= pulselength;
  pwm.setPWM(n, 0, pulse);
}

void loop() {
  for (uint16_t pulselen = SERVOMIN; pulselen < SERVOMAX; pulselen += 50) {
    pwm.setPWM(servonum, 0, pulselen);
  }
  setServoPulse(servonum, 0.0015);
  delay(500);
  servonum++;
  if (servonum > 7) servonum = 0;
}
`

describe('sketch: everyday Arduino examples', () => {
  it('BlinkWithoutDelay toggles the LED once per second', () => {
    const host = new ServoBench()
    const vm = createVM(compileOk(BLINK_WITHOUT_DELAY).program!, host, { maxLoopsPerRun: 50 })
    runUntil(vm, 3500, 1000 / 60)
    expect(host.callsTo('pinMode')[0].args).toEqual([13, 1])
    expect(host.callsTo('digitalWrite').map((c) => c.args[1])).toEqual([1, 0, 1])
  })

  it('the Adafruit PCA9685 servo test drives channels with integer pulse counts', () => {
    const host = new ServoBench()
    const vm = createVM(compileOk(PCA9685_TEST).program!, host, { maxLoopsPerRun: 10 })
    runUntil(vm, 1100, 1000 / 60)
    expect(host.serial).toBe('8 channel Servo test!\n')
    const pwm = host.callsTo('Adafruit_PWMServoDriver.setPWM').map((c) => c.args)
    expect(pwm.slice(0, 3)).toEqual([[0, 0, 150], [0, 0, 200], [0, 0, 250]])
    // 1.5 ms at 50 Hz with 4096 steps: 1500 / (20000 / 4096) = 307.2 → 307
    expect(pwm[9]).toEqual([0, 0, 307])
    expect(pwm[10][0]).toBe(1)
  })
})
