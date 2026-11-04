import { formatPin } from '../core/hardware'
import { BOARD_TITLE, FW_ID, LINK_TITLE, WIFI_PASS_PLACEHOLDER } from './context'
import type { GenContext, SweeperCtx } from './context'
import { numText } from './format'
import type { LibInfo } from './libraries'
import { hex2, pcaAddress } from './servoMap'
import { buildSteps } from './steps'

/* ============================================================
   README_FIRMWARE.md — wiring table, libraries, flashing and
   placement steps, the protocol in brief, and power safety.
   ============================================================ */

const md = (s: string) => s.replace(/\|/g, '\\|')

function pinCell(ctx: GenContext, pin: number): string {
  if (ctx.driver === 'pca9685') return `PCA9685 ${hex2(pcaAddress(pin))} ch ${pin % 16}`
  return ctx.board === 'stm32' ? formatPin(ctx.board, 'gpio', pin) : `GPIO ${pin}`
}

function walkerWiring(ctx: GenContext): string {
  const rows = ctx.names.map((name, j) => {
    const [lo, hi] = ctx.limits[j]
    const inv = ctx.hw.jointInvert[j] ? 'yes' : 'no'
    return `| ${j} | ${md(name)} | ${pinCell(ctx, ctx.hw.servoPins[j])} | ${numText(lo, 1)} .. ${numText(hi, 1)} | ${numText(ctx.home[j], 1)} | ${inv} | ${numText(ctx.hw.jointOffsetDeg[j] ?? 0, 2)} | ${numText(ctx.hw.jointScale[j] ?? 1, 3)} |`
  })
  return [
    '| # | Joint | Signal | Limits (deg) | Home (deg) | Invert | Offset (deg) | Scale |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Servo pulse: ${ctx.hw.servoMinUs}-${ctx.hw.servoMaxUs} µs over ${ctx.hw.servoRangeDeg}°; joint 0° = servo ${ctx.hw.servoRangeDeg / 2}° + offset. Joint zero = coxa straight out, femur horizontal, tibia pointing down. Signs: coxa + = counter-clockwise seen from above, femur + = up, tibia + = foot out. Flip "Invert" for servos mounted the other way round.`,
  ].join('\n')
}

function sweeperWiring(ctx: GenContext): string {
  const s = ctx.sweeper as SweeperCtx
  const p = (pin: number) => pinCell(ctx, pin)
  const rows = s.wheels.map((w, i) => `| ${i} | ${md(w.name)} | ${p(s.motors.pwm[i])} | ${p(s.motors.in1[i])} | ${p(s.motors.in2[i])} | ${ctx.hw.jointInvert[i] ? 'yes' : 'no'} |`)
  const lidar =
    ctx.board === 'esp32' ? `GPIO ${s.motors.lidarRx}` : ctx.board === 'stm32' ? 'PB7 (USART1 RX)' : ctx.board === 'pizero2w' ? 'GPIO15 / pin 10 (UART RX)' : 'GP1 (UART0 RX)'
  return [
    '| # | Wheel | PWM | IN1 | IN2 | Invert |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `Motor driver STBY: ${p(s.motors.stby)} (high = run). TB6612FNG wiring per motor: PWMx, xIN1, xIN2; VM = motor supply, VCC = logic 3.3 V. Two TB6612 boards drive four motors.`,
    '',
    `Optional LD06 LiDAR: LD06 TX → ${lidar}, 5 V and GND from the logic supply. Set KIYO_LD06 to 1 ${ctx.info.kind === 'linux' ? '(LD06 = True in kiyobridge.py)' : 'in kiyobridge.h'} to send its scan in telemetry.`,
  ].join('\n')
}

function swarmWiring(ctx: GenContext): string {
  return [
    `The relay needs no wiring: it is an ESP32 on USB / BLE / WiFi to the app and ESP-NOW to the drones (WiFi channel 1 unless your router dictates another in STA mode).`,
    '',
    `Each of the ${ctx.drones} drones runs ${ctx.sketch}_drone/${ctx.sketch}_drone.ino on an ESP32 on the drone (or wired to its flight controller) with KIYO_DRONE_ID = 0..${ctx.drones - 1}. Fill in kiyoOnSetpoint() / kiyoReadState() to talk to your flight controller (MAVLink, MSP, ...).`,
    '',
    '**Flight stabilisation stays on each drone\'s flight controller.** The relay only forwards position setpoints and hold / land / E-STOP commands.',
  ].join('\n')
}

function libTable(libs: LibInfo[]): string {
  return ['| Library | Version | How to install |', '|---|---|---|', ...libs.map((l) => `| ${md(l.name)} | ${md(l.version)} | ${md(l.how)} |`)].join('\n')
}

function powerNotes(ctx: GenContext): string {
  const lines = [
    '- Never power servos or motors from the board\'s 5 V / 3.3 V pin or from USB. Use a separate supply sized for the stall current (a hexapod can pull 10-20 A peaks; MG996R stalls at about 2.5 A each).',
    '- **Join the grounds**: the servo / motor supply ground must connect to the board ground, or the signals float.',
    '- Put a 1000-2200 µF low-ESR capacitor across the servo rail near the PCA9685 / servo headers to ride through current spikes.',
    '- Brown-out symptoms: random resets, the board re-sending hello, servos twitching at power-up. Fix the supply, do not lower the watchdog.',
    '- Servos stay limp until the app sends HOME, and the watchdog acts after the configured timeout without commands. E-STOP turns every output off.',
  ]
  if (ctx.board === 'pico' || ctx.board === 'picow' || ctx.board === 'stm32' || ctx.board === 'esp32') lines.push('- Logic is 3.3 V. Most hobby servos accept a 3.3 V signal; motor drivers like the TB6612 take 3.3 V logic on VCC.')
  if (ctx.info.kind === 'linux') lines.push('- Power the Pi from its own 5 V / 2.5 A supply. Shut it down with sudo poweroff before cutting power to protect the SD card.')
  return lines.join('\n')
}

function protocolNotes(ctx: GenContext): string {
  return [
    'Newline-delimited JSON, one object per line, both directions:',
    '',
    '```',
    `board → app  {"t":"hello","proto":1,"board":"${ctx.board}","robot":"${ctx.robot}","joints":${ctx.joints},...,"fw":"${FW_ID}","caps":[...]}`,
    'app → board  {"t":"home"}        board → app {"t":"ack","of":"home","ok":true}   (once in the home pose)',
    `app → board  {"t":"cmd","seq":42,${ctx.robot === 'swarm' ? '"sp":[{"id":0,"p":[x,y,z],"yaw":0}]' : ctx.level === 'high' ? '"v":[vx,vy,wz],"mode":"...","h":0.09' : ctx.robot === 'sweeper' ? '"w":[w1,w2,w3,w4]' : '"q":[deg,...]'}}`,
    'board → app  {"t":"tel","ms":10422,...}                                     (telemetry)',
    'app → board  {"t":"estop"}  {"t":"ping","id":7}  {"t":"hello?"}',
    'board → app  {"t":"ack","of":"estop","ok":true}  {"t":"pong","id":7}  {"t":"log","lvl":"warn","msg":"servo 4 clamped"}',
    '```',
    '',
    `Commands are accepted only after HOME. Joint targets are clamped to the limits (logged once a second). With no command for ${ctx.hw.watchdogMs} ms the watchdog ${ctx.hw.watchdogAction === 'hold' ? 'holds the last pose' : 'turns the outputs off; send HOME to resume'}.`,
  ].join('\n')
}

function hooksNotes(ctx: GenContext): string {
  if (ctx.info.kind === 'linux') {
    const robotHooks = ctx.robot === 'walker' ? ['read_joint_deg(joint)', 'read_load(leg)'] : ['read_wheel_speed(wheel) (rad/s; turns on the speed loop)']
    return `Edit the read_* functions near the top of kiyobridge.py (return None for "no data"): ${[...robotHooks, 'read_imu()', 'read_vbat()'].join(', ')}.`
  }
  const hooks = ['`bool kiyo_read_imu(float* rollDeg, float* pitchDeg, float* yawDeg)`', '`float kiyo_read_vbat()`']
  if (ctx.robot === 'walker') hooks.unshift('`float kiyo_read_joint_deg(uint8_t joint)`', '`float kiyo_read_load(uint8_t leg)`')
  if (ctx.robot === 'sweeper') hooks.unshift('`float kiyo_read_wheel_speed(uint8_t wheel)` (rad/s; turns on the speed loop)')
  return `Define any of these in your sketch with the exact signature to add live data (return NAN / false for "no data"). Leave them out and the field is omitted: ${hooks.join(', ')}.`
}

function whereCodeGoes(ctx: GenContext): string {
  if (ctx.info.kind === 'linux') {
    return [
      '- The daemon owns the PCA9685 and the link. Add sensors through the read_* hooks, and keep each hook fast (it runs on every telemetry tick): read a value a background thread keeps fresh rather than blocking on I/O.',
      '- Other programs on the Pi must not drive the same PCA9685 channels. Stop the service (sudo systemctl stop kiyobridge) before running your own servo scripts.',
    ].join('\n')
  }
  return [
    '- Keep your own `setup()` / `loop()` code; add the three bridge lines. `Bridge.update()` must run every few milliseconds, so never block `loop()` with a long `delay()` (use `millis()` timers).',
    `- ${ctx.link === 'serial' ? 'With the USB serial link the port belongs to the bridge: log with `Bridge.log("text")`, not `Serial.print()`.' : 'Serial (115200 baud) is free for your debug prints.'}`,
  ].join('\n')
}

function wiring(ctx: GenContext): string {
  if (ctx.robot === 'walker') return walkerWiring(ctx)
  if (ctx.robot === 'sweeper') return sweeperWiring(ctx)
  return swarmWiring(ctx)
}

function files(ctx: GenContext): string {
  if (ctx.info.kind === 'linux') {
    return '- `kiyobridge.py`: the daemon (protocol, PCA9685 output, watchdog, telemetry)\n- `requirements.txt`: Python packages\n- `kiyobridge.service`: systemd unit that starts it at boot'
  }
  const lines = [
    `- \`${ctx.sketch}.ino\`: example sketch with the three touch points`,
    '- `kiyobridge.h`: everything else. Paste it once, next to your .ino',
    '- `platformio.ini`: the same folder builds in PlatformIO (src_dir = .)',
  ]
  if (ctx.robot === 'swarm') lines.push(`- \`../${ctx.sketch}_drone/${ctx.sketch}_drone.ino\`: the drone-side receiver`)
  return lines.join('\n')
}

export function buildReadme(ctx: GenContext, libs: LibInfo[]): string {
  const steps = buildSteps(ctx)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n')
  const wifi = ctx.link === 'ws' && ctx.info.kind === 'mcu' ? `\n> WiFi password: type it where the code says \`${WIFI_PASS_PLACEHOLDER}\`. SIM CONSOLE never stores it and never puts it in generated files.\n` : ''
  return `# ${ctx.robotLabel} firmware for ${BOARD_TITLE[ctx.board]}

Generated by SIM CONSOLE (${FW_ID}). Link: **${LINK_TITLE[ctx.link]}** · level: **${ctx.level.toUpperCase()}** · output: **${ctx.robot === 'swarm' ? 'ESP-NOW relay' : ctx.driver === 'pca9685' ? 'PCA9685' : 'GPIO'}**.
${wifi}
## Files

${files(ctx)}

## Steps

${steps}

## Wiring

${wiring(ctx)}

## Libraries

${libTable(libs)}

## Where your code goes

${whereCodeGoes(ctx)}
- Optional hooks: ${hooksNotes(ctx)}

## Protocol (v1)

${protocolNotes(ctx)}

## Power and brown-out safety

${powerNotes(ctx)}
`
}
