import type { GenContext } from './context'
import { mcuLibraries } from './libraries'

/* ============================================================
   platformio.ini — lives in the sketch folder with src_dir = .,
   so the same folder opens in the Arduino IDE and in PlatformIO.
   ============================================================ */

interface PioEnv {
  name: string
  lines: string[]
}

function env(ctx: GenContext): PioEnv {
  if (ctx.board === 'esp32') return { name: 'esp32', lines: ['platform = espressif32', 'board = esp32dev', 'framework = arduino'] }
  if (ctx.board === 'pico' || ctx.board === 'picow') {
    return {
      name: ctx.board,
      lines: [
        'platform = https://github.com/maxgerhardt/platform-raspberrypi.git',
        `board = ${ctx.board === 'picow' ? 'rpipicow' : 'rpipico'}`,
        'framework = arduino',
        'board_build.core = earlephilhower',
      ],
    }
  }
  return { name: 'nucleo_f401re', lines: ['platform = ststm32', 'board = nucleo_f401re', 'framework = arduino'] }
}

export function buildPlatformio(ctx: GenContext): string {
  const e = env(ctx)
  const deps = mcuLibraries(ctx)
    .map((l) => l.pio)
    .filter((d): d is string => d !== null)
  const stm32Alt =
    ctx.board === 'stm32'
      ? `
; Black Pill (STM32F411) with USB CDC instead of the Nucleo's ST-Link virtual COM port:
; [env:blackpill_f411ce]
; platform = ststm32
; board = blackpill_f411ce
; framework = arduino
; upload_protocol = dfu
; build_flags = -D PIO_FRAMEWORK_ARDUINO_ENABLE_CDC -D USBCON
`
      : ''
  return `; platformio.ini for ${ctx.sketch} (SIM CONSOLE kiyobridge)
; Open this folder in VS Code with the PlatformIO extension, then Upload.
; The Arduino IDE ignores this file and opens ${ctx.sketch}.ino directly.

[platformio]
src_dir = .
default_envs = ${e.name}

[env:${e.name}]
${e.lines.join('\n')}
monitor_speed = ${ctx.link === 'serial' ? ctx.hw.baud : 115200}
build_src_filter = +<*> -<.git/> -<.svn/> -<.pio/> -<.vscode/>
lib_deps =
${deps.map((d) => `  ${d}`).join('\n')}
${stm32Alt}`
}
