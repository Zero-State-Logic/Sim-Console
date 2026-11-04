import type { GenContext } from '../context'
import { block } from '../format'

/* ============================================================
   C++ SERVO OUTPUT — outBegin / outEnable / outWrite for each
   board × driver, then the joint layer on top (clamp to limits,
   map to microseconds exactly like the app, blend between poses).
     ESP32 GPIO : ESP32Servo (LEDC, 16 channels)
     RP2040 GPIO: pico-sdk hardware PWM, 1 tick = 1 µs at 50 Hz
     STM32 GPIO : Arduino Servo library (STM32duino timer)
     PCA9685    : Adafruit PWM Servo Driver, 0x40 (+ 0x41)
   ============================================================ */

export function servoIncludes(ctx: GenContext): string[] {
  if (ctx.driver === 'pca9685') return ['<Wire.h>', '<Adafruit_PWMServoDriver.h>   // Adafruit PWM Servo Driver Library']
  if (ctx.board === 'esp32') return ['<ESP32Servo.h>                // ESP32Servo by Kevin Harrington']
  if (ctx.board === 'pico' || ctx.board === 'picow') return ['<hardware/pwm.h>              // pico-sdk, part of the arduino-pico core', '<hardware/clocks.h>', '<hardware/gpio.h>']
  return ['<Servo.h>                     // bundled with STM32duino']
}

function esp32Gpio(): string {
  return String.raw`
static Servo servo[KIYO_JOINTS];

static void outBegin() {
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
}

// on: start 50 Hz pulses at us[]; off: stop the pulses (servos go limp)
static void outEnable(bool on, const uint16_t* us) {
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    if (on) {
      servo[j].setPeriodHertz(50);
      servo[j].attach((int)KIYO_PIN[j], KIYO_SERVO_MIN_US, KIYO_SERVO_MAX_US);
      servo[j].writeMicroseconds(us[j]);
    } else {
      servo[j].detach();
    }
  }
}

static void outWrite(uint8_t j, uint16_t us) { servo[j].writeMicroseconds(us); }`
}

function rp2040Gpio(): string {
  return String.raw`
static void outBegin() {}

// on: start 50 Hz pulses at us[]; off: level 0 = no pulses (servos go limp)
static void outEnable(bool on, const uint16_t* us) {
  if (!on) {
    for (uint8_t j = 0; j < KIYO_JOINTS; j++) pwm_set_gpio_level((unsigned)KIYO_PIN[j], 0);
    return;
  }
  pwm_config cfg = pwm_get_default_config();
  pwm_config_set_clkdiv(&cfg, (float)clock_get_hz(clk_sys) / 1000000.0f);   // 1 tick = 1 us
  pwm_config_set_wrap(&cfg, 19999);                                         // 20 ms period = 50 Hz
  // init every slice before setting any level: pwm_init clears both channels of a slice
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    gpio_set_function((unsigned)KIYO_PIN[j], GPIO_FUNC_PWM);
    pwm_init(pwm_gpio_to_slice_num((unsigned)KIYO_PIN[j]), &cfg, true);
  }
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) pwm_set_gpio_level((unsigned)KIYO_PIN[j], us[j]);
}

static void outWrite(uint8_t j, uint16_t us) { pwm_set_gpio_level((unsigned)KIYO_PIN[j], us); }`
}

function stm32Gpio(): string {
  return String.raw`
static Servo servo[KIYO_JOINTS];

static void outBegin() {}

// on: start pulses at us[]; off: detach (servos go limp)
static void outEnable(bool on, const uint16_t* us) {
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    if (on) {
      // attach first: it sets the pulse limits that writeMicroseconds clamps to
      servo[j].attach((int)KIYO_PIN[j], KIYO_SERVO_MIN_US, KIYO_SERVO_MAX_US);
      servo[j].writeMicroseconds(us[j]);
    } else {
      servo[j].detach();
    }
  }
}

static void outWrite(uint8_t j, uint16_t us) { servo[j].writeMicroseconds(us); }`
}

/** PCA9685 objects + pcaFor(), shared by servo and motor builds. */
export function pcaCore(ctx: GenContext): string {
  const two = ctx.pcaBoards > 1
  return String.raw`
static Adafruit_PWMServoDriver pca0(0x40);${two ? '\nstatic Adafruit_PWMServoDriver pca1(0x41);' : ''}

// channel 0-15 = board 0x40${two ? ', 16-31 = board 0x41' : ''}
static Adafruit_PWMServoDriver& pcaFor(uint32_t ch) {${two ? '\n  if (ch >= 16) return pca1;' : ''}
  (void)ch;
  return pca0;
}

static void pcaBegin() {
  Wire.begin();
  pca0.begin();
  pca0.setOscillatorFrequency(KIYO_PCA_OSC_HZ);
  pca0.setPWMFreq(KIYO_PCA_FREQ_HZ);${two ? '\n  pca1.begin();\n  pca1.setOscillatorFrequency(KIYO_PCA_OSC_HZ);\n  pca1.setPWMFreq(KIYO_PCA_FREQ_HZ);' : ''}
  Wire.setClock(400000);
}`
}

function pcaServo(ctx: GenContext): string {
  return pcaCore(ctx) + String.raw`

static void pcaOff(uint32_t ch) { pcaFor(ch).setPWM((uint8_t)(ch & 15), 0, 4096); }   // 4096 = full off

// microseconds -> 12-bit ticks, rounded (same as usToPcaTicks in the app)
static uint16_t usToTicks(uint16_t us) {
  return (uint16_t)(((uint32_t)us * (uint32_t)KIYO_PCA_FREQ_HZ * 4096UL + 500000UL) / 1000000UL);
}

static void outBegin() {
  pcaBegin();
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) pcaOff(KIYO_PIN[j]);   // limp until "home"
}

static void outWrite(uint8_t j, uint16_t us) {
  pcaFor(KIYO_PIN[j]).setPWM((uint8_t)(KIYO_PIN[j] & 15), 0, usToTicks(us));
}

// on: pulses at us[]; off: full-off on every channel (servos go limp)
static void outEnable(bool on, const uint16_t* us) {
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    if (on) outWrite(j, us[j]);
    else pcaOff(KIYO_PIN[j]);
  }
}`
}

export function servoOutputSection(ctx: GenContext): string {
  let body: string
  let title: string
  if (ctx.driver === 'pca9685') {
    body = pcaServo(ctx)
    title = 'PCA9685'
  } else if (ctx.board === 'esp32') {
    body = esp32Gpio()
    title = 'ESP32 GPIO (ESP32Servo)'
  } else if (ctx.board === 'stm32') {
    body = stm32Gpio()
    title = 'STM32 GPIO (Servo)'
  } else {
    body = rp2040Gpio()
    title = 'RP2040 GPIO (hardware PWM)'
  }
  return block(String.raw`
// ===================== servo output: ${title} =====================
namespace kiyo {
${body}

}  // namespace kiyo
`)
}

export function jointLayer(): string {
  return block(String.raw`
// ===================== joints: clamp, map, blend =====================
namespace kiyo {

static float jTarget[KIYO_JOINTS];   // latest target, joint degrees, clamped
static float jOut[KIYO_JOINTS];      // what the servos are told right now
static float jFrom[KIYO_JOINTS];     // start pose of a blend
static uint16_t jUs[KIYO_JOINTS];    // last pulse widths
static uint32_t jBlendStart = 0;
static uint32_t jBlendMs = 0;
static bool jOutputs = false;
static uint32_t jClampMask = 0;      // joints clamped since the last log line

static float jointClamp(uint8_t j, float deg) {
  if (!isNum(deg)) { jClampMask |= (1UL << j); return jTarget[j]; }
  if (deg < KIYO_LIM_LO[j]) { jClampMask |= (1UL << j); return KIYO_LIM_LO[j]; }
  if (deg > KIYO_LIM_HI[j]) { jClampMask |= (1UL << j); return KIYO_LIM_HI[j]; }
  return deg;
}

// Identical to jointToServoDeg + servoDegToUs in the app (src/core/hardware.ts).
static uint16_t jointToUs(uint8_t j, float deg) {
  const float servoDeg = KIYO_SERVO_CENTER[j] + KIYO_SERVO_GAIN[j] * deg;
  const float f = clampF(servoDeg / KIYO_SERVO_RANGE_DEG, 0.0f, 1.0f);
  return (uint16_t)roundL((float)KIYO_SERVO_MIN_US + f * (float)(KIYO_SERVO_MAX_US - KIYO_SERVO_MIN_US));
}

// Start a smooth move from the current output pose to jTarget over ms.
static void jointsBlend(uint32_t now, uint32_t ms) {
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) jFrom[j] = jOut[j];
  jBlendStart = now;
  jBlendMs = ms;
}

static void jointsStep(uint32_t now) {
  float u = 1.0f;
  if (jBlendMs > 0) {
    const uint32_t el = now - jBlendStart;
    if (el >= jBlendMs) {
      jBlendMs = 0;
    } else {
      u = (float)el / (float)jBlendMs;
      u = u * u * (3.0f - 2.0f * u);   // smoothstep
    }
  }
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    jOut[j] = jBlendMs > 0 ? jFrom[j] + (jTarget[j] - jFrom[j]) * u : jTarget[j];
    jUs[j] = jointToUs(j, jOut[j]);
    if (jOutputs) outWrite(j, jUs[j]);
  }
}

static void jointsEnable(bool on) {
  if (on == jOutputs) return;
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) jUs[j] = jointToUs(j, jOut[j]);
  outEnable(on, jUs);
  jOutputs = on;
}

static uint32_t takeClampMask() {
  const uint32_t m = jClampMask;
  jClampMask = 0;
  return m;
}

}  // namespace kiyo
`)
}
