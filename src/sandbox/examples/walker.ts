import { BOARDS, defaultServoPins, formatPin } from '../../core/hardware'
import type { Example, ExampleCtx } from './types'

/* Walker examples. The API comes from the walker module (setJoint, walk, setBodyPose, ...). */

const TRIPOD_CPP = `// Tripod walk with walk()
// The gait engine does the inverse kinematics: this sketch only steers it.
// Forward, turn in place, strafe left, stand still: 4 s each, forever.

const float SPEED = 0.06;   // m/s
const float TURN = 25.0;    // deg/s, CCW positive
unsigned long phaseStart = 0;
int phase = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  setGait(0);              // 0 = tripod (tetrapod on 8 legs, crawl on 4)
  setBodyHeight(0.09);
  Serial.print("legs: ");
  Serial.println((int)legCount());
}

void loop() {
  unsigned long now = millis();
  if (now - phaseStart >= 4000) {
    phase = (phase + 1) % 4;
    phaseStart = now;
    Serial.print("phase ");
    Serial.print(phase);
    Serial.print("  yaw ");
    Serial.println(readImu(2), 1);
  }
  switch (phase) {
    case 0: walk(SPEED, 0, 0); break;
    case 1: walk(0, 0, TURN); break;
    case 2: walk(0, SPEED, 0); break;
    default: stop(); break;
  }
  digitalWrite(LED_BUILTIN, phase == 3 ? LOW : HIGH);
}
`

const TRIPOD_JS = `// Tripod walk with walk()
// The gait engine does the inverse kinematics: this program only steers it.
// Forward, turn in place, strafe left, stand still: 4 s each, forever.

const SPEED = 0.06   // m/s
const TURN = 25      // deg/s, CCW positive
const MOVES = [
  () => walk(SPEED, 0, 0),
  () => walk(0, 0, TURN),
  () => walk(0, SPEED, 0),
  () => stop(),
]
let phase = 0

function setup() {
  Serial.begin(115200)
  pinMode(LED_BUILTIN, OUTPUT)
  setGait(0)              // 0 = tripod (tetrapod on 8 legs, crawl on 4)
  setBodyHeight(0.09)
  Serial.println('legs: ' + legCount())
}

async function loop() {
  MOVES[phase]()
  digitalWrite(LED_BUILTIN, phase === 3 ? LOW : HIGH)
  Serial.println('phase ' + phase + '  yaw ' + readImu(2).toFixed(1))
  watch('phase', phase)
  await delay(4000)       // virtual time: the robot keeps walking meanwhile
  phase = (phase + 1) % MOVES.length
}
`

interface FemurServo {
  leg: number
  joint: number
  pin: number
  label: string
}

function legCountOf(ctx: ExampleCtx): number {
  return ctx.spec.legs ?? Math.floor(ctx.spec.joints / 3)
}

/** Femur joints and the GPIO pin each one answers to in the current hardware profile. */
function femurServos(ctx: ExampleCtx): FemurServo[] {
  const { hw, spec } = ctx
  const pins = hw.servoDriver === 'gpio' ? hw.servoPins : defaultServoPins(hw.board, 'gpio', spec.joints)
  const out: FemurServo[] = []
  for (let leg = 0; leg < legCountOf(ctx); leg++) {
    const joint = leg * 3 + 1
    const pin = pins[joint] ?? -1
    if (pin >= 0) out.push({ leg, joint, pin, label: formatPin(hw.board, 'gpio', pin) })
  }
  return out
}

/** Comment lines for legs whose femur has no GPIO pin (e.g. 18 joints on 16 ESP32 pins). */
function missingNote(ctx: ExampleCtx, servos: readonly FemurServo[]): string {
  const have = new Set(servos.map((s) => s.leg))
  const lines: string[] = []
  for (let leg = 0; leg < legCountOf(ctx); leg++) {
    if (!have.has(leg)) lines.push(`// L${leg + 1} femur: no GPIO pin left on this board, so it keeps walking with the gait`)
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

function profileNote(ctx: ExampleCtx): string {
  const board = BOARDS[ctx.hw.board].label
  return ctx.hw.servoDriver === 'gpio'
    ? `// Profile: ${board}, servos on GPIO (HARDWARE > pin map).`
    : `// Profile: ${board} with a PCA9685, so Servo pins follow the board's\n// default GPIO order. Use Adafruit_PWMServoDriver to drive the PCA channels.`
}

function servoCpp(ctx: ExampleCtx): string {
  const servos = femurServos(ctx)
  const decl = servos.map((s) => `Servo femur${s.leg + 1};   // L${s.leg + 1} femur = joint ${s.joint}, pin ${s.label}`).join('\n')
  const attach = servos.map((s) => `  femur${s.leg + 1}.attach(${s.label});`).join('\n')
  const write = servos.map((s, i) => `  femur${s.leg + 1}.write(${i % 2 === 0 ? 'up' : 'down'});`).join('\n')
  return `// Servo.h sweep mapped to joints
// A plain servo sketch: each Servo.attach(pin) is matched to a joint through
// the hardware profile, the same pin table the firmware generator writes.
// The same sketch on the real robot moves the real femurs.
${profileNote(ctx)}
#include <Servo.h>

${decl || '// no femur joint has a GPIO pin in this profile'}${missingNote(ctx, servos)}

void setup() {
  Serial.begin(115200);
${attach}
  Serial.println("femur servos attached");
}

void loop() {
  // two groups in anti-phase, 0.5 Hz, +-25 degrees around neutral (90)
  float s = sin(millis() * 0.001 * PI);
  int up = 90 + (int)(25 * s);
  int down = 90 - (int)(25 * s);
${write}
  delay(20);
}
`
}

function servoJs(ctx: ExampleCtx): string {
  const servos = femurServos(ctx)
  const pins = servos.map((s) => (ctx.hw.board === 'stm32' ? s.label : String(s.pin))).join(', ')
  return `// Servo.h sweep mapped to joints (JS shim)
// Each servo.attach(pin) is matched to a joint through the hardware profile,
// the same pin table the firmware generator writes.
${profileNote(ctx)}

const FEMUR_PINS = [${pins}]   // femur of leg 1, 2, ... in this profile
const femurs = FEMUR_PINS.map((pin) => {
  const s = new Servo()
  s.attach(pin)
  return s
})

function setup() {
  Serial.println(femurs.length + ' femur servos attached')
}

async function loop() {
  // two groups in anti-phase, 0.5 Hz, +-25 degrees around neutral (90)
  const s = Math.sin(millis() * 0.001 * PI)
  femurs.forEach((servo, i) => servo.write(90 + (i % 2 === 0 ? 25 : -25) * s))
  await delay(20)
}
`
}

const WAVE_CPP = `// Body wave with setBodyPose()
// The feet stay planted while the body rolls, pitches and yaws on a slow
// circle. Watch the load bars: the weight walks around the support polygon.

unsigned long lastPrint = 0;

void setup() {
  Serial.begin(115200);
  stop();
  setBodyHeight(0.10);
}

void loop() {
  float t = millis() / 1000.0;
  float roll = 10.0 * sin(t * 1.5);
  float pitch = 8.0 * cos(t * 1.5);
  float yaw = 6.0 * sin(t * 0.5);
  setBodyPose(roll, pitch, yaw);

  if (millis() - lastPrint >= 1000) {
    lastPrint = millis();
    Serial.print("roll ");
    Serial.print(readImu(0), 1);
    Serial.print("  pitch ");
    Serial.print(readImu(1), 1);
    Serial.print("  load L1 ");
    Serial.print(readLoad(0), 2);
    Serial.println(" N");
  }
}
`

const WAVE_JS = `// Body wave with setBodyPose()
// The feet stay planted while the body rolls, pitches and yaws on a slow
// circle. Watch the load bars: the weight walks around the support polygon.

let lastPrint = 0

function setup() {
  stop()
  setBodyHeight(0.10)
}

function loop() {
  const t = millis() / 1000
  setBodyPose(10 * Math.sin(t * 1.5), 8 * Math.cos(t * 1.5), 6 * Math.sin(t * 0.5))
  watch('roll', readImu(0))
  watch('pitch', readImu(1))
  if (millis() - lastPrint >= 1000) {
    lastPrint = millis()
    const loads = []
    for (let i = 0; i < legCount(); i++) loads.push(readLoad(i).toFixed(2))
    Serial.println('load N: ' + loads.join('  '))
  }
}
`

export const WALKER_EXAMPLES: Example[] = [
  { id: 'walker-tripod', title: 'Tripod walk with walk()', summary: 'Steer the gait engine: forward, turn, strafe, stop.', cpp: TRIPOD_CPP, js: TRIPOD_JS },
  { id: 'walker-servo', title: 'Servo.h sweep mapped to joints', summary: 'A plain servo sketch; pins map to joints through the hardware profile.', cpp: servoCpp, js: servoJs },
  { id: 'walker-wave', title: 'Body wave with setBodyPose()', summary: 'Roll, pitch and yaw the body with the feet planted.', cpp: WAVE_CPP, js: WAVE_JS },
]
