import { BOARD_TITLE } from './context'
import type { GenContext } from './context'

/* ============================================================
   STEPS — the numbered "what to do, where to paste it" list. The
   dialog shows it and README_FIRMWARE.md repeats it.
   ============================================================ */

function appConnect(ctx: GenContext): string {
  if (ctx.link === 'ble') return `In SIM CONSOLE pick HARDWARE, transport BLE, press CONNECT and choose "${ctx.hw.bleName}" in the browser's device list (Chrome / Edge).`
  if (ctx.link === 'ws') {
    const where =
      ctx.info.kind === 'linux'
        ? 'find the Pi\'s address (journalctl -u kiyobridge prints it, or use <pi>.local), then'
        : ctx.hw.wifiMode === 'ap'
          ? `join the WiFi "${ctx.hw.wifiSsid}" from your computer, then`
          : 'read the board IP from its serial monitor (115200 baud), then'
    return `In SIM CONSOLE pick HARDWARE, transport WIFI, ${where} enter ws://<ip>:81 and press CONNECT (from the hosted HTTPS site use tools/ws-relay.mjs or run the app locally).`
  }
  return `In SIM CONSOLE pick HARDWARE, transport USB SERIAL${ctx.usbCdc ? '' : ` at ${ctx.hw.baud} baud`}, press CONNECT and choose the board's port (Chrome / Edge).`
}

function mcuSteps(ctx: GenContext): string[] {
  const steps = [
    `Install the ${BOARD_TITLE[ctx.board]} board package and the libraries listed below (Arduino IDE: Boards Manager and Library Manager).`,
    `Download the .zip and unzip it. The folder ${ctx.sketch}/ holds ${ctx.sketch}.ino, kiyobridge.h, platformio.ini and README_FIRMWARE.md.`,
    `New project: open ${ctx.sketch}/${ctx.sketch}.ino in the Arduino IDE (or the folder in PlatformIO). Existing sketch: copy kiyobridge.h next to your .ino and add the three lines: #include "kiyobridge.h" at the top, Bridge.begin(); in setup(), Bridge.update(); in loop().`,
  ]
  if (ctx.link === 'ws') steps.push('Open kiyobridge.h and replace CHANGE_ME in KIYO_WIFI_PASS with your WiFi password (8+ characters in access-point mode). The app never stores it.')
  steps.push(ctx.robot === 'swarm' ? 'Wire nothing: the relay talks to the drones over ESP-NOW. Flash the drone sketch on each drone (set KIYO_DRONE_ID per drone).' : 'Wire the outputs as in the wiring table of README_FIRMWARE.md. Power the servos / motors from their own supply and join the grounds.')
  steps.push(`Select the board and port, then Upload.${ctx.board === 'stm32' ? ' On Nucleo boards Serial is the ST-Link virtual COM port.' : ''}`)
  steps.push(appConnect(ctx))
  steps.push('The board answers with hello. Press HOME: the robot moves to its safe pose and acks, then the app goes LIVE. E-STOP turns every output off.')
  return steps
}

function piSteps(ctx: GenContext): string[] {
  const steps = [
    'Flash Raspberry Pi OS Lite (64-bit, Bookworm) to the SD card with Raspberry Pi Imager; set a username, WiFi and enable SSH there.',
    'Enable I2C: sudo raspi-config nonint do_i2c 0, and add dtparam=i2c_arm_baudrate=400000 to /boot/firmware/config.txt for fast servo updates. Wire the PCA9685: SDA = pin 3, SCL = pin 5, VCC = 3.3 V pin 1, GND = pin 6.',
  ]
  if (ctx.link === 'serial') {
    steps.push('Enable the USB serial gadget: add dtoverlay=dwc2 to /boot/firmware/config.txt and modules-load=dwc2,g_serial after rootwait in /boot/firmware/cmdline.txt, then reboot. Use the Pi\'s USB data port (not PWR); the PC sees a new COM port.')
  }
  const handTest =
    ctx.link === 'ws'
      ? 'Test it by hand: .venv/bin/python kiyobridge.py --port 8081 (ports below 1024 need root; the service gets the right to use 81). Add --dry-run to try it without a PCA9685.'
      : 'Test it by hand: .venv/bin/python kiyobridge.py (add --dry-run to run without a PCA9685, --stdio to type NDJSON lines yourself).'
  steps.push(
    'Copy the kiyobridge_pi/ folder to /home/<you>/kiyobridge on the Pi (scp -r kiyobridge_pi <you>@<pi>.local:~/kiyobridge).',
    'Install: cd ~/kiyobridge && python3 -m venv --system-site-packages .venv && .venv/bin/pip install -r requirements.txt',
    handTest,
    'Run it at boot: edit User= and the paths in kiyobridge.service, then sudo cp kiyobridge.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now kiyobridge (logs: journalctl -u kiyobridge -f).',
    appConnect(ctx),
    'The Pi answers with hello. Press HOME: the robot moves to its safe pose and acks, then the app goes LIVE.',
  )
  return steps
}

export function buildSteps(ctx: GenContext): string[] {
  return ctx.info.kind === 'linux' ? piSteps(ctx) : mcuSteps(ctx)
}
