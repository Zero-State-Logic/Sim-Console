import { formatPin } from '../../core/hardware'
import type { GenContext, SweeperCtx } from '../context'
import { block, cFloat, cFloatList, cList } from '../format'
import { pcaCore } from './servos'

/* ============================================================
   C++ SWEEPER — 4 DC motors through a TB6612-style driver (PWM +
   IN1 + IN2 per motor, one STBY), mecanum mixing for cmd v, wheel
   speeds for cmd w, optional encoder PI loop, on-board odometry,
   and an optional LD06 LiDAR reader (KIYO_LD06 = 1).
   ============================================================ */

/** Speed-loop gains and limits (duty per rad/s). Editable in the generated header. */
export const WHEEL_TUNING = { kp: 0.04, ki: 0.4, iMax: 2, accel: 40 }
export const SCAN_BINS = 90

function pinList(ctx: GenContext, pins: number[]): string {
  return cList(pins.map((p) => formatPin(ctx.board, ctx.driver, p)))
}

function lidarConfig(ctx: GenContext, s: SweeperCtx): string {
  const where: Record<string, string> = {
    esp32: `#define KIYO_LD06_RX ${s.motors.lidarRx}                 // ESP32 GPIO wired to the LD06 TX (Serial2)`,
    pico: '// LD06 TX -> GP1 (Serial1 / UART0 RX)',
    picow: '// LD06 TX -> GP1 (Serial1 / UART0 RX)',
    stm32: '// LD06 TX -> PB7 (USART1 RX)',
  }
  return `${where[ctx.board] ?? ''}
#define KIYO_LD06_YAW_DEG 0.0f         // LiDAR mounting yaw: its 0 deg relative to the robot's forward
#define KIYO_SCAN_BINS ${SCAN_BINS}             // ${360 / SCAN_BINS} deg bins sent in telemetry`
}

export function sweeperConfig(ctx: GenContext): string {
  const s = ctx.sweeper as SweeperCtx
  const dir = ctx.hw.jointInvert.slice(0, 4).map((inv, i) => (inv ? -1 : 1) * (ctx.hw.jointScale[i] ?? 1))
  const pca = ctx.driver === 'pca9685'
  return block(String.raw`
// ---------- mecanum base (REP-103: x forward, y left; wheel order ${s.wheels.map((w) => w.name).join(', ')}) ----------
#define KIYO_WHEEL_RADIUS ${cFloat(s.geom.wheelRadius)}
#define KIYO_MAX_WHEEL_SPEED ${cFloat(s.geom.maxWheelSpeed)}   // rad/s at full PWM
#define KIYO_WHEEL_ACCEL ${cFloat(WHEEL_TUNING.accel)}       // rad/s^2, keeps the wheels from slipping
// speed loop, used only when kiyo_read_wheel_speed() is defined
#define KIYO_WHEEL_KP ${cFloat(WHEEL_TUNING.kp)}
#define KIYO_WHEEL_KI ${cFloat(WHEEL_TUNING.ki)}
#define KIYO_WHEEL_I_MAX ${cFloat(WHEEL_TUNING.iMax)}
// w_i * r = vx - wz * y_i + k_i * (vy + wz * x_i)
static const float KIYO_WHEEL_X[KIYO_WHEELS] = ${cFloatList(s.wheels.map((w) => w.x))};
static const float KIYO_WHEEL_Y[KIYO_WHEELS] = ${cFloatList(s.wheels.map((w) => w.y))};
static const float KIYO_WHEEL_K[KIYO_WHEELS] = ${cFloatList(s.wheels.map((w) => w.k))};
// least-squares forward kinematics: [vx, vy, wz] = FK * w
static const float KIYO_FK[3][KIYO_WHEELS] = ${cList(s.forward.map((row) => cFloatList(row, 6)), 1)};
// motor polarity x scale per wheel (jointInvert / jointScale in the app)
static const float KIYO_WHEEL_DIR[KIYO_WHEELS] = ${cFloatList(dir, 4)};

// ---------- motor driver pins (TB6612FNG-style${pca ? ', all on the PCA9685' : ''}) ----------
static const uint32_t KIYO_IN1[KIYO_WHEELS] = ${pinList(ctx, s.motors.in1)};
static const uint32_t KIYO_IN2[KIYO_WHEELS] = ${pinList(ctx, s.motors.in2)};
#define KIYO_STBY_PIN ${formatPin(ctx.board, ctx.driver, s.motors.stby)}

// ---------- optional LD06 LiDAR (230400 baud UART) ----------
#ifndef KIYO_LD06
#define KIYO_LD06 0                    // 1 = read an LD06 and send its scan in telemetry
#endif
${lidarConfig(ctx, s)}`)
}

function motorIo(ctx: GenContext): string {
  if (ctx.driver === 'pca9685') {
    return pcaCore(ctx) + String.raw`

static void pinOut(uint32_t ch, bool high) { pcaFor(ch).setPWM((uint8_t)(ch & 15), high ? 4096 : 0, high ? 0 : 4096); }

static void pwmOut(uint32_t ch, float duty) {
  const long t = roundL(clampF(duty, 0.0f, 1.0f) * 4095.0f);
  if (t <= 0) pcaFor(ch).setPWM((uint8_t)(ch & 15), 0, 4096);
  else if (t >= 4095) pcaFor(ch).setPWM((uint8_t)(ch & 15), 4096, 0);
  else pcaFor(ch).setPWM((uint8_t)(ch & 15), 0, (uint16_t)t);
}

static void ioBegin() { pcaBegin(); }`
  }
  return String.raw`
static void pinOut(uint32_t pin, bool high) { digitalWrite(pin, high ? HIGH : LOW); }

static void pwmOut(uint32_t pin, float duty) { analogWrite(pin, (int)roundL(clampF(duty, 0.0f, 1.0f) * 255.0f)); }

static void ioBegin() {
  pinMode(KIYO_STBY_PIN, OUTPUT);
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    pinMode(KIYO_IN1[i], OUTPUT);
    pinMode(KIYO_IN2[i], OUTPUT);
    pinMode(KIYO_PIN[i], OUTPUT);
  }
}`
}

function lidarSerial(ctx: GenContext): { decl: string; begin: string } {
  if (ctx.board === 'esp32') return { decl: '#define KIYO_LD06_SERIAL Serial2', begin: 'KIYO_LD06_SERIAL.begin(230400, SERIAL_8N1, KIYO_LD06_RX, -1);' }
  if (ctx.board === 'stm32') return { decl: 'static HardwareSerial ldSerial(PB7, PB6);\n#define KIYO_LD06_SERIAL ldSerial', begin: 'KIYO_LD06_SERIAL.begin(230400);' }
  return { decl: '#define KIYO_LD06_SERIAL Serial1', begin: 'KIYO_LD06_SERIAL.begin(230400);' }
}

function lidar(ctx: GenContext): string {
  const ser = lidarSerial(ctx)
  return String.raw`
#if KIYO_LD06
${ser.decl}
static uint8_t ldCrc[256];
static uint8_t ldPkt[47];
static uint8_t ldLen = 0;
static float ldBin[KIYO_SCAN_BINS];    // nearest return per bin, meters (0 = none)
static float ldScan[KIYO_SCAN_BINS];   // last complete revolution
static bool ldReady = false;
static float ldLast = 0.0f;
static uint32_t ldBad = 0;

static void ldBegin() {
  for (int i = 0; i < 256; i++) {   // LD06 CRC-8, polynomial 0x4D
    uint8_t c = (uint8_t)i;
    for (uint8_t b = 0; b < 8; b++) c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x4D) : (uint8_t)(c << 1);
    ldCrc[i] = c;
  }
  for (uint8_t b = 0; b < KIYO_SCAN_BINS; b++) ldBin[b] = 0.0f;
  ${ser.begin}
}

static void ldRevolution() {
  for (uint8_t b = 0; b < KIYO_SCAN_BINS; b++) { ldScan[b] = ldBin[b]; ldBin[b] = 0.0f; }
  ldReady = true;
}

// One 47-byte packet: header, speed, start angle, 12 x (mm, intensity), end angle, time, CRC.
static void ldDecode() {
  uint8_t crc = 0;
  for (uint8_t i = 0; i < 46; i++) crc = ldCrc[(crc ^ ldPkt[i]) & 0xFF];
  if (crc != ldPkt[46]) { ldBad++; return; }
  const float start = (float)(uint16_t)(ldPkt[4] | (ldPkt[5] << 8)) * 0.01f;
  float stop = (float)(uint16_t)(ldPkt[42] | (ldPkt[43] << 8)) * 0.01f;
  if (stop < start) stop += 360.0f;
  const float step = (stop - start) / 11.0f;
  for (uint8_t i = 0; i < 12; i++) {
    float cw = start + step * (float)i;
    if (cw >= 360.0f) cw -= 360.0f;
    if (cw + 180.0f < ldLast) ldRevolution();   // the angle wrapped: one full turn collected
    ldLast = cw;
    const uint16_t mm = (uint16_t)(ldPkt[6 + 3 * i] | (ldPkt[7 + 3 * i] << 8));
    if (mm == 0) continue;
    float ccw = KIYO_LD06_YAW_DEG - cw;         // LD06 turns clockwise, the app wants CCW from forward
    while (ccw < 0.0f) ccw += 360.0f;
    while (ccw >= 360.0f) ccw -= 360.0f;
    int bin = (int)(ccw * (float)KIYO_SCAN_BINS / 360.0f);
    if (bin >= KIYO_SCAN_BINS) bin = KIYO_SCAN_BINS - 1;
    const float m = (float)mm * 0.001f;
    if (ldBin[bin] == 0.0f || m < ldBin[bin]) ldBin[bin] = m;
  }
}

static void ldPoll() {
  for (int budget = 0; budget < 512 && KIYO_LD06_SERIAL.available() > 0; budget++) {
    const uint8_t b = (uint8_t)KIYO_LD06_SERIAL.read();
    if (ldLen == 0) { if (b == 0x54) ldPkt[ldLen++] = b; continue; }
    if (ldLen == 1) {
      if (b == 0x2C) ldPkt[ldLen++] = b;
      else ldLen = (b == 0x54) ? 1 : 0;
      continue;
    }
    ldPkt[ldLen++] = b;
    if (ldLen == 47) { ldDecode(); ldLen = 0; }
  }
}
#endif`
}

function robot(): string {
  return String.raw`
static float wTarget[KIYO_WHEELS];   // rad/s, after saturation
static float wCmd[KIYO_WHEELS];      // rad/s, after the acceleration limit
static float wMeas[KIYO_WHEELS];     // encoder speed, or wCmd without encoders
static float wInt[KIYO_WHEELS];
static float odoX = 0.0f;
static float odoY = 0.0f;
static float odoTh = 0.0f;
static bool motorsOn = false;
static bool wLimited = false;
static uint32_t homeDoneAt = 0;
static Note cmdNote;   // malformed-command diagnostics, flushed once a second

static void standby(bool run) { pinOut(KIYO_STBY_PIN, run); }

// duty -1..1. At zero: short brake (both IN high) or coast (both low).
static void motorWrite(uint8_t i, float duty, bool brake) {
  const float mag = fabsf(duty);
  if (mag < 0.004f) {
    pinOut(KIYO_IN1[i], brake);
    pinOut(KIYO_IN2[i], brake);
    pwmOut(KIYO_PIN[i], 0.0f);
    return;
  }
  pinOut(KIYO_IN1[i], duty > 0.0f);
  pinOut(KIYO_IN2[i], duty < 0.0f);
  pwmOut(KIYO_PIN[i], mag);
}

static void wheelsZero(bool resetCmd) {
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    wTarget[i] = 0.0f;
    wInt[i] = 0.0f;
    if (resetCmd) { wCmd[i] = 0.0f; wMeas[i] = 0.0f; }
  }
}

static void motorsOff() {
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) motorWrite(i, 0.0f, false);
  standby(false);
  motorsOn = false;
}

static void robotBegin() {
  ioBegin();
  wheelsZero(true);
  motorsOff();
#if KIYO_LD06
  ldBegin();
#endif
}

static void robotHomeStart(uint32_t now) {
  wheelsZero(true);
  odoX = odoY = odoTh = 0.0f;
  standby(true);
  motorsOn = true;
  homeDoneAt = now;   // stopped wheels are the home pose
}

static bool robotHomeDone(uint32_t now) { return (int32_t)(now - homeDoneAt) >= 0; }

// Mecanum inverse kinematics: body twist -> wheel speeds.
static void mixTwist(float vx, float vy, float wz) {
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    wTarget[i] = (vx - wz * KIYO_WHEEL_Y[i] + KIYO_WHEEL_K[i] * (vy + wz * KIYO_WHEEL_X[i])) / KIYO_WHEEL_RADIUS;
  }
}

static bool robotCommand(JsonDocument& doc, uint32_t now) {
  (void)now;
  JsonArrayConst w = doc["w"].as<JsonArrayConst>();
  JsonArrayConst v = doc["v"].as<JsonArrayConst>();
  if (!w.isNull()) {
    if (w.size() != KIYO_WHEELS) { cmdNote.set("cmd w must have 4 wheel speeds"); return false; }
    uint8_t i = 0;
    for (JsonVariantConst s : w) wTarget[i++] = s.is<float>() ? s.as<float>() : 0.0f;
  } else if (!v.isNull() && v.size() == 3) {
    mixTwist(v[0] | 0.0f, v[1] | 0.0f, v[2] | 0.0f);
  } else {
    return false;
  }
  // saturate as one vector so the robot keeps its heading and only slows down
  float peak = 0.0f;
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    if (!isNum(wTarget[i])) wTarget[i] = 0.0f;
    if (fabsf(wTarget[i]) > peak) peak = fabsf(wTarget[i]);
  }
  if (peak > KIYO_MAX_WHEEL_SPEED) {
    const float s = KIYO_MAX_WHEEL_SPEED / peak;
    for (uint8_t i = 0; i < KIYO_WHEELS; i++) wTarget[i] *= s;
    wLimited = true;
  }
  return true;
}

static void odometry(float dt) {
  float vx = 0.0f, vy = 0.0f, wz = 0.0f;
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    vx += KIYO_FK[0][i] * wMeas[i];
    vy += KIYO_FK[1][i] * wMeas[i];
    wz += KIYO_FK[2][i] * wMeas[i];
  }
  const float c = cosf(odoTh);
  const float s = sinf(odoTh);
  odoX += (vx * c - vy * s) * dt;
  odoY += (vx * s + vy * c) * dt;
  odoTh += wz * dt;
  if (odoTh > kPi) odoTh -= 2.0f * kPi;
  else if (odoTh < -kPi) odoTh += 2.0f * kPi;
}

static void robotControl(float dt, uint32_t now) {
  (void)now;
  float peak = 0.0f;
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    const float d = fabsf(wTarget[i] - wCmd[i]);
    if (d > peak) peak = d;
  }
  const float maxStep = KIYO_WHEEL_ACCEL * dt;
  const float k = peak > maxStep && peak > 0.0f ? maxStep / peak : 1.0f;
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    wCmd[i] += k * (wTarget[i] - wCmd[i]);
    float duty = wCmd[i] / KIYO_MAX_WHEEL_SPEED;   // feed-forward
    const float meas = kiyo_read_wheel_speed ? kiyo_read_wheel_speed(i) : NAN;
    if (isNum(meas)) {
      const float err = wCmd[i] - meas;
      wInt[i] = clampF(wInt[i] + err * dt, -KIYO_WHEEL_I_MAX, KIYO_WHEEL_I_MAX);
      duty += KIYO_WHEEL_KP * err + KIYO_WHEEL_KI * wInt[i];
      wMeas[i] = meas;
    } else {
      wMeas[i] = wCmd[i];
    }
    if (motorsOn) motorWrite(i, clampF(duty * KIYO_WHEEL_DIR[i], -1.0f, 1.0f), true);
  }
  odometry(dt);
#if KIYO_LD06
  ldPoll();
#endif
}

static void robotSafe(bool relax) {
  wheelsZero(false);   // decelerate under the acceleration limit, then brake
  if (relax) { wheelsZero(true); motorsOff(); }
}

static void robotEstop() {
  wheelsZero(true);
  motorsOff();
}

static void robotTelemetry(Writer& w) {
  w.key("enc").put('[');
  for (uint8_t i = 0; i < KIYO_WHEELS; i++) {
    if (i) w.put(',');
    w.fix(wMeas[i], 2);
  }
  w.put(']');
  w.key("pose").put('[').fix(odoX, 3).put(',').fix(odoY, 3).put(',').fix(odoTh * kRad2Deg, 1).put(']');
#if KIYO_LD06
  if (ldReady) {
    ldReady = false;
    w.key("scan").raw("{\"a0\":").fix(180.0f / KIYO_SCAN_BINS, 2).raw(",\"da\":").fix(360.0f / KIYO_SCAN_BINS, 2).raw(",\"r\":[");
    for (uint8_t b = 0; b < KIYO_SCAN_BINS; b++) {
      if (b) w.put(',');
      w.fix(ldScan[b], 3);
    }
    w.raw("]}");
  }
#endif
}

static void robotCaps(Writer& w) {
  if (kiyo_read_wheel_speed && isNum(kiyo_read_wheel_speed(0))) w.raw(",\"encoders\"");
#if KIYO_LD06
  w.raw(",\"lidar\"");
#endif
}

static void robotFlushLogs() {
  cmdNote.flush("warn");
  if (wLimited) {
    wLimited = false;
    log("warn", "wheel speed limited to KIYO_MAX_WHEEL_SPEED");
  }
#if KIYO_LD06
  if (ldBad > 0) {
    Text t;
    t.add("LD06: ").add((unsigned long)ldBad).add(" packets failed CRC");
    ldBad = 0;
    log("warn", t.c_str());
  }
#endif
}`
}

export function sweeperSection(ctx: GenContext): string {
  return block(String.raw`
// ===================== robot: mecanum sweeper =====================
namespace kiyo {
${motorIo(ctx)}
${lidar(ctx)}
${robot()}

}  // namespace kiyo
`)
}

export function sweeperIncludes(ctx: GenContext): string[] {
  return ctx.driver === 'pca9685' ? ['<Wire.h>', '<Adafruit_PWMServoDriver.h>   // Adafruit PWM Servo Driver Library (drives the motor PWM too)'] : []
}
