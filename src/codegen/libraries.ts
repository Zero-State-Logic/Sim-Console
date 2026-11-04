import type { GenContext } from './context'
import type { LibraryRef } from './types'

/* ============================================================
   LIBRARIES — exact Library Manager names, PlatformIO ids and pip
   packages each build needs. One table feeds the README, the
   dialog and platformio.ini, so they never disagree.
   ============================================================ */

export interface LibInfo extends LibraryRef {
  /** PlatformIO lib_deps entry; null when it ships with the core. */
  pio: string | null
}

const ARDUINO_JSON: LibInfo = {
  name: 'ArduinoJson',
  version: '7.x',
  how: 'Arduino IDE: Library Manager, search "ArduinoJson" by Benoit Blanchon',
  pio: 'bblanchon/ArduinoJson@^7.2.0',
}
const PCA: LibInfo = {
  name: 'Adafruit PWM Servo Driver Library',
  version: '3.x',
  how: 'Library Manager, "Adafruit PWM Servo Driver Library" (installs Adafruit BusIO with it)',
  pio: 'adafruit/Adafruit PWM Servo Driver Library@^3.0.2',
}
const ESP32_SERVO: LibInfo = {
  name: 'ESP32Servo',
  version: '3.x',
  how: 'Library Manager, "ESP32Servo" by Kevin Harrington',
  pio: 'madhephaestus/ESP32Servo@^3.0.5',
}
const NIMBLE: LibInfo = {
  name: 'NimBLE-Arduino',
  version: '2.x',
  how: 'Library Manager, "NimBLE-Arduino" by h2zero (version 2.x: the 1.x callback API differs)',
  pio: 'h2zero/NimBLE-Arduino@^2.1.0',
}
const WEBSOCKETS: LibInfo = {
  name: 'WebSockets',
  version: '2.4+',
  how: 'Library Manager, "WebSockets" by Markus Sattler (arduinoWebSockets)',
  pio: 'links2004/WebSockets@^2.6.1',
}

const CORE: Record<string, LibInfo> = {
  esp32: {
    name: 'esp32 board package',
    version: '2.0.x or 3.x',
    how: 'Boards Manager, "esp32" by Espressif Systems (URL: https://espressif.github.io/arduino-esp32/package_esp32_index.json)',
    pio: null,
  },
  pico: {
    name: 'Raspberry Pi Pico/RP2040 board package (arduino-pico)',
    version: '3.x or 4.x',
    how: 'Boards Manager, "Raspberry Pi Pico/RP2040" by Earle Philhower (URL: https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json)',
    pio: null,
  },
  stm32: {
    name: 'STM32 MCU based boards (STM32duino)',
    version: '2.x',
    how: 'Boards Manager, "STM32 MCU based boards" by STMicroelectronics (URL: https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json)',
    pio: null,
  },
}

export function mcuLibraries(ctx: GenContext): LibInfo[] {
  const core = CORE[ctx.board === 'picow' ? 'pico' : ctx.board]
  const libs: LibInfo[] = core ? [core, ARDUINO_JSON] : [ARDUINO_JSON]
  if (ctx.robot !== 'swarm' && ctx.driver === 'pca9685') libs.push(PCA)
  if (ctx.robot === 'walker' && ctx.driver === 'gpio' && ctx.board === 'esp32') libs.push(ESP32_SERVO)
  if (ctx.link === 'ble') libs.push(NIMBLE)
  if (ctx.link === 'ws') libs.push(WEBSOCKETS)
  return libs
}

export function piLibraries(ctx: GenContext): LibInfo[] {
  const libs: LibInfo[] = [
    {
      name: 'adafruit-circuitpython-servokit',
      version: '>=1.3',
      how: 'pip install -r requirements.txt (pulls adafruit-circuitpython-pca9685 and Blinka)',
      pio: null,
    },
  ]
  if (ctx.link === 'ws') libs.push({ name: 'websockets', version: '>=12', how: 'pip install -r requirements.txt', pio: null })
  if (ctx.link === 'serial') libs.push({ name: 'pyserial', version: '>=3.5', how: 'pip install -r requirements.txt', pio: null })
  return libs
}

export function toLibraryRefs(libs: LibInfo[]): LibraryRef[] {
  return libs.map((l) => ({ name: l.name, version: l.version, how: l.how }))
}
