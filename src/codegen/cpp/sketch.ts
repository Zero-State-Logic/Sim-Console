import { BOARD_TITLE, LINK_TITLE } from '../context'
import type { GenContext } from '../context'
import { block, commentSafe } from '../format'

/* ============================================================
   EXAMPLE SKETCH — shows the three touch points and where the
   user's existing code goes. The hooks are listed commented out
   with their exact signatures.
   ============================================================ */

function hookExamples(ctx: GenContext): string {
  const lines: string[] = []
  if (ctx.robot === 'walker') {
    lines.push('// float kiyo_read_load(uint8_t leg) { return myFootSensor(leg); }               // foot load 0..1')
    lines.push('// float kiyo_read_joint_deg(uint8_t joint) { return NAN; }                       // servo feedback, deg')
  }
  if (ctx.robot === 'sweeper') lines.push('// float kiyo_read_wheel_speed(uint8_t wheel) { return myEncoderRadPerSec(wheel); }   // enables the speed loop')
  lines.push('// bool kiyo_read_imu(float* rollDeg, float* pitchDeg, float* yawDeg) { *rollDeg = 0; *pitchDeg = 0; *yawDeg = 0; return true; }')
  lines.push('// float kiyo_read_vbat() { return myBatteryVolts(); }                            // volts')
  return lines.join('\n')
}

function serialNote(ctx: GenContext): string {
  if (ctx.link !== 'serial') return '  // Serial is free for your own debug prints (115200 baud): the app talks over the radio.'
  return '  // With the USB serial link, Serial belongs to the bridge. Print with Bridge.log("...")\n  // instead of Serial.print(), or the app sees lines it cannot parse.'
}

export function buildSketch(ctx: GenContext): string {
  return block(String.raw`
/*
 * ${ctx.sketch}.ino  -  SIM CONSOLE bridge example for ${commentSafe(ctx.robotLabel)} on ${BOARD_TITLE[ctx.board]} (${LINK_TITLE[ctx.link]}).
 *
 * Three touch points link your board with the app:
 *   (1) #include "kiyobridge.h"   kiyobridge.h sits next to this .ino
 *   (2) Bridge.begin();           first line of setup()
 *   (3) Bridge.update();          first line of loop()
 * Already have a sketch? Copy those three lines into it and keep the rest of your code.
 */
#include "kiyobridge.h"   // (1)

void setup() {
  Bridge.begin();        // (2) opens the link and sends hello; outputs stay off until the app sends "home"

  // ---- your existing setup() code goes here (sensors, displays, ...) ----
${serialNote(ctx)}
}

void loop() {
  Bridge.update();       // (3) reads commands, moves the robot, sends telemetry, runs the watchdog

  // ---- your existing loop() code goes here ----
  // Keep loop() fast. Never block it with a long delay(): Bridge.update() must run every
  // few ms, and after ${ctx.hw.watchdogMs} ms without commands the watchdog will ${ctx.hw.watchdogAction} the robot.
  // Use a millis() timer instead:
  //   static uint32_t last = 0;
  //   if (millis() - last >= 100) { last = millis(); /* runs every 100 ms */ }
  //
  // Bridge.live() is true once the app has homed the robot; Bridge.estopped() after E-STOP.
}

// ---- optional hooks: uncomment and fill in to add live data to the app's instruments ----
${hookExamples(ctx)}
`)
}
