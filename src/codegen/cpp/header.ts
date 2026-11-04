import { formatPin } from '../../core/hardware'
import { BOARD_TITLE, FW_ID, LINK_TITLE, PROTO } from '../context'
import type { GenContext } from '../context'
import { block, cFloat, cFloatList, cList, commentSafe, cString, joinSections } from '../format'
import { cppSend, cppUtils } from './core'
import { bridgeSection, hooksSection } from './bridge'
import { linkConfig, linkIncludes, linkSection } from './link'
import { jointLayer, servoIncludes, servoOutputSection } from './servos'
import { sweeperConfig, sweeperIncludes, sweeperSection } from './sweeper'
import { swarmConfig, swarmIncludes, swarmSection } from './swarm'
import { walkerGaitConfig, walkerSection } from './walker'

/* ============================================================
   kiyobridge.h ASSEMBLY — banner, includes, generated config,
   then the sections in dependency order:
   utils → link → send/log → hooks → outputs → robot → bridge.
   ============================================================ */

/** PCA9685 oscillator calibration (Adafruit's recommended value for most boards). */
export const PCA_OSC_HZ = 27_000_000
export const MOTOR_PWM_HZ = 1000

export function helloObject(ctx: GenContext): Record<string, string | number> {
  const hello: Record<string, string | number> = { t: 'hello', proto: PROTO, board: ctx.board, robot: ctx.robot, joints: ctx.joints }
  if (ctx.robot === 'walker') hello.legs = ctx.legs
  if (ctx.robot === 'sweeper') hello.wheels = ctx.wheels
  if (ctx.robot === 'swarm') hello.drones = ctx.drones
  hello.fw = FW_ID
  return hello
}

/** hello without its closing brace; the firmware appends ,"caps":[...]} at runtime. */
export function helloHead(ctx: GenContext): string {
  return JSON.stringify(helloObject(ctx)).slice(0, -1)
}

function banner(ctx: GenContext): string {
  const what =
    ctx.robot === 'walker'
      ? `${ctx.legs} legs / ${ctx.joints} joints`
      : ctx.robot === 'sweeper'
        ? '4 mecanum wheels'
        : `${ctx.drones} drones (ground-station relay)`
  const out =
    ctx.robot === 'swarm' ? 'ESP-NOW broadcast to the drones' : ctx.driver === 'pca9685' ? `PCA9685 (${ctx.pcaBoards > 1 ? '0x40 + 0x41' : '0x40'})` : 'direct GPIO'
  return block(String.raw`
/*
 * kiyobridge.h  -  SIM CONSOLE hardware bridge (${FW_ID}, protocol v${PROTO}, newline-delimited JSON)
 * Generated for: ${commentSafe(ctx.robotLabel)}, ${what}
 * Board: ${BOARD_TITLE[ctx.board]}   Link: ${LINK_TITLE[ctx.link]}   Level: ${ctx.level.toUpperCase()}   Output: ${out}
 *
 * Paste once: put this file next to your sketch (.ino) and add three lines:
 *   #include "kiyobridge.h"     at the top of the sketch
 *   Bridge.begin();             in setup()
 *   Bridge.update();            in loop(), on every pass
 * Everything else lives here: the link, the NDJSON parser, joint clamping, the servo
 * mapping, the command watchdog, the home pose and telemetry.
 * Include it from ONE file only. Regenerate it in SIM CONSOLE (FIRMWARE) whenever the
 * robot, the board or the wiring changes.
 */
#pragma once`)
}

function includes(ctx: GenContext): string {
  const list = ['<Arduino.h>', '<math.h>', '<string.h>', '<ArduinoJson.h>           // ArduinoJson 7.x by Benoit Blanchon', ...linkIncludes(ctx)]
  if (ctx.robot === 'walker') list.push(...servoIncludes(ctx))
  if (ctx.robot === 'sweeper') list.push(...sweeperIncludes(ctx))
  if (ctx.robot === 'swarm') list.push(...swarmIncludes().filter((i) => !(ctx.link === 'ws' && i === '<WiFi.h>')))
  return list.map((i) => `#include ${i}`).join('\n')
}

function timing(ctx: GenContext): string {
  const hw = ctx.hw
  const relax = hw.watchdogAction === 'relax'
  return String.raw`#define KIYO_FW "${FW_ID}"
#define KIYO_BAUD ${hw.baud}${ctx.usbCdc ? '               // native USB: ignored' : ''}
#define KIYO_TEL_HZ ${hw.telemetryHz}
#define KIYO_TEL_PERIOD_MS ${Math.max(1, Math.round(1000 / hw.telemetryHz))}
#define KIYO_CMD_HZ ${hw.commandHz}                  // what the app sends; informational
#define KIYO_CONTROL_PERIOD_MS 10           // motion update, 100 Hz
#define KIYO_WATCHDOG_MS ${hw.watchdogMs}             // no cmd for this long trips the watchdog
#define KIYO_WATCHDOG_RELAX ${relax ? 1 : 0}            // 0 = hold the last pose, 1 = outputs off (send home again)
#define KIYO_WATCHDOG_TEXT "watchdog: no cmd for ${hw.watchdogMs} ms"
#define KIYO_HOME_SETTLE_MS 600             // first home after power-up: servos jump, wait for them
#define KIYO_HOME_RAMP_MS 800               // later homes: smooth move from the current pose
#define KIYO_MAX_LINE 1024                  // longest accepted command line, bytes
#define KIYO_TX_BUF ${ctx.robot === 'walker' ? 1024 : 1536}                    // longest outgoing line, bytes
#define KIYO_LOG_PERIOD_MS 1000             // diagnostics are rate-limited to one line per kind per second`
}

function jointTables(ctx: GenContext): string {
  const pins = ctx.hw.servoPins.slice(0, ctx.joints).map((p) => formatPin(ctx.board, ctx.driver, p))
  const lo = ctx.limits.map((l) => l[0])
  const hi = ctx.limits.map((l) => l[1])
  const pinDoc =
    ctx.robot === 'sweeper'
      ? '// motor PWM pin per wheel'
      : ctx.driver === 'pca9685'
        ? '// PCA9685 channel per joint: 0-15 on board 0x40, 16-31 on board 0x41'
        : `// GPIO per joint${ctx.board === 'stm32' ? ' (STM32duino pin names)' : ''}`
  const servo =
    ctx.robot === 'walker'
      ? String.raw`
static const float KIYO_LIM_LO[KIYO_JOINTS] = ${cFloatList(lo, 2)};
static const float KIYO_LIM_HI[KIYO_JOINTS] = ${cFloatList(hi, 2)};
static const float KIYO_HOME[KIYO_JOINTS] = ${cFloatList(ctx.home, 2)};
// servo mapping, identical to the app: servoDeg = center + gain * jointDeg
static const float KIYO_SERVO_CENTER[KIYO_JOINTS] = ${cFloatList(ctx.servo.center, 4)};
static const float KIYO_SERVO_GAIN[KIYO_JOINTS] = ${cFloatList(ctx.servo.gain, 4)};
#define KIYO_SERVO_RANGE_DEG ${cFloat(ctx.servo.rangeDeg, 3)}
#define KIYO_SERVO_MIN_US ${ctx.servo.minUs}
#define KIYO_SERVO_MAX_US ${ctx.servo.maxUs}`
      : ''
  return String.raw`
// joint order matches the app${ctx.robot === 'walker' ? ' (leg-major: L1 coxa, L1 femur, L1 tibia, L2 coxa, ...)' : ''}
static const char* const KIYO_JOINT_NAME[KIYO_JOINTS] = ${cList(ctx.names.map((n) => cString(n)), 6)};
${pinDoc}
static const uint32_t KIYO_PIN[KIYO_JOINTS] = ${cList(pins, 12)};${servo}`
}

function counts(ctx: GenContext): string {
  const lines = [`#define KIYO_JOINTS ${ctx.joints}`]
  if (ctx.robot === 'walker') lines.push(`#define KIYO_LEGS ${ctx.legs}`)
  if (ctx.robot === 'sweeper') lines.push(`#define KIYO_WHEELS ${ctx.wheels}`)
  if (ctx.robot === 'swarm') lines.push(`#define KIYO_DRONES ${ctx.drones}`)
  if (ctx.robot !== 'swarm' && ctx.driver === 'pca9685') {
    lines.push(`#define KIYO_PCA_OSC_HZ ${PCA_OSC_HZ}UL          // calibrate with a scope if pulses are off`)
    lines.push(`#define KIYO_PCA_FREQ_HZ ${ctx.robot === 'sweeper' ? MOTOR_PWM_HZ : 50}`)
  }
  return lines.join('\n')
}

function config(ctx: GenContext): string {
  const caps = ctx.caps.map((c) => `\\"${c}\\"`).join(',')
  const parts = [
    '// ===================== configuration (generated) =====================',
    timing(ctx),
    counts(ctx),
    `static const char KIYO_HELLO_HEAD[] = ${cString(helloHead(ctx))};`,
    `static const char KIYO_CAPS[] = "${caps}";`,
  ]
  const robotTables = ctx.robot === 'swarm' ? swarmConfig(ctx) : jointTables(ctx)
  const extra = ctx.robot === 'walker' && ctx.walker ? walkerGaitConfig(ctx.walker) : ctx.robot === 'sweeper' ? sweeperConfig(ctx) : ''
  return [parts.join('\n'), robotTables, linkConfig(ctx), extra].filter(Boolean).join('\n')
}

function robotSections(ctx: GenContext): string[] {
  if (ctx.robot === 'walker') return [servoOutputSection(ctx), jointLayer(), walkerSection(ctx)]
  if (ctx.robot === 'sweeper') return [sweeperSection(ctx)]
  return [swarmSection(ctx)]
}

export function buildHeader(ctx: GenContext): string {
  return joinSections([banner(ctx), includes(ctx), config(ctx), cppUtils(), linkSection(ctx), cppSend(), hooksSection(ctx), ...robotSections(ctx), bridgeSection()])
}
