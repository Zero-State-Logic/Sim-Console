import { describe, expect, it } from 'vitest'
import { BOARDS } from '../core/hardware'
import type { ServoDriver } from '../core/hardware'
import type { BoardId, TransportId } from '../core/protocol'
import type { CommandLevel, HardwareSpec } from '../core/types'
import { NUS, WIFI_PASS_PLACEHOLDER } from './context'
import { findLeaks, generateFirmware } from './index'
import { hwFor, request, swarmSpec, sweeperSpec, walkerSpec } from './testing/fixtures'
import { declareBeforeUseProblems, delimiterProblems, macroProblems, pythonIndentProblems, unusedStaticProblems } from './testing/structure'
import type { FirmwareResult, GeneratedFile } from './types'

const BOARD_IDS: BoardId[] = ['esp32', 'pico', 'picow', 'stm32', 'pizero2w']
const TRANSPORTS: TransportId[] = ['serial', 'ble', 'ws', 'loopback']
const DRIVERS: ServoDriver[] = ['gpio', 'pca9685']
const LEVELS: CommandLevel[] = ['joint', 'high']
const ROBOTS: { name: string; spec: HardwareSpec }[] = [
  { name: 'walker4', spec: walkerSpec(4) },
  { name: 'walker6', spec: walkerSpec(6) },
  { name: 'walker8', spec: walkerSpec(8) },
  { name: 'sweeper', spec: sweeperSpec() },
  { name: 'swarm', spec: swarmSpec(4) },
]

/** The rules the generator must enforce, written independently of validate.ts. */
function shouldGenerate(spec: HardwareSpec, board: BoardId, transport: TransportId, driver: ServoDriver): boolean {
  const info = BOARDS[board]
  if (transport === 'loopback' || !(info.transports as string[]).includes(transport)) return false
  if (board === 'picow' && transport === 'ble') return false
  if (spec.robot === 'swarm') return board === 'esp32'
  if (info.kind === 'linux' && driver === 'gpio') return false
  return !(driver === 'gpio' && spec.joints > info.maxGpioServos)
}

function file(result: FirmwareResult, suffix: string): GeneratedFile {
  const f = result.files.find((x) => x.path.endsWith(suffix))
  if (!f) throw new Error(`no file ending in ${suffix}: ${result.files.map((x) => x.path).join(', ')}`)
  return f
}

/** Entries of a top-level C brace initializer `NAME[...] = { a, b, c };`. */
function cArrayLength(src: string, name: string): number {
  const m = new RegExp(`${name}\\[[^\\]]*\\](?:\\[[^\\]]*\\])? = \\{([\\s\\S]*?)\\};`).exec(src)
  if (!m) return -1
  let depth = 0
  let count = 1
  for (const ch of m[1]) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === ',' && depth === 0) count++
  }
  return m[1].trim() ? count : 0
}

function checkMcu(result: FirmwareResult, spec: HardwareSpec, transport: TransportId): void {
  const header = file(result, 'kiyobridge.h').content
  const sketch = result.files.find((f) => f.path.endsWith('.ino') && !f.path.includes('_drone'))?.content ?? ''
  expect(delimiterProblems(header, 'cpp')).toEqual([])
  expect(delimiterProblems(sketch, 'cpp')).toEqual([])
  expect(macroProblems(header)).toEqual([])
  expect(declareBeforeUseProblems(header)).toEqual([])
  expect(unusedStaticProblems(header)).toEqual([])
  expect(sketch).toContain('#include "kiyobridge.h"')
  expect(sketch).toMatch(/void setup\(\) \{\s+Bridge\.begin\(\);/)
  expect(sketch).toMatch(/void loop\(\) \{\s+Bridge\.update\(\);/)
  for (const sym of ['#pragma once', 'class KiyoBridge', 'KiyoBridge Bridge;', 'void begin()', 'void update()', 'deserializeJson(doc_', 'JsonDocument doc_']) {
    expect(header).toContain(sym)
  }
  const pinMap = spec.robot === 'swarm' ? cArrayLength(header, 'KIYO_DRONE_MAC') : cArrayLength(header, 'KIYO_PIN')
  expect(pinMap).toBe(spec.joints)
  expect(header.includes('<NimBLEDevice.h>')).toBe(transport === 'ble')
  expect(header.includes('<WebSocketsServer.h>')).toBe(transport === 'ws')
  if (transport === 'serial') expect(header).toContain('Serial.begin(KIYO_BAUD)')
}

function checkPi(result: FirmwareResult): void {
  const py = file(result, 'kiyobridge.py').content
  expect(delimiterProblems(py, 'python')).toEqual([])
  expect(pythonIndentProblems(py)).toEqual([])
  expect(file(result, 'requirements.txt').content).toContain('adafruit-circuitpython-servokit')
  expect(file(result, 'kiyobridge.service').content).toContain('ExecStart=')
}

describe('generateFirmware over every board × transport × robot × driver × level', () => {
  for (const { name, spec } of ROBOTS) {
    for (const board of BOARD_IDS) {
      for (const transport of TRANSPORTS) {
        for (const driver of DRIVERS) {
          for (const level of LEVELS) {
            const ok = shouldGenerate(spec, board, transport, driver)
            it(`${ok ? 'generates' : 'refuses'} ${name} on ${board} over ${transport} with ${driver} at ${level}`, () => {
              // Arrange
              const req = request(spec, hwFor(board, transport, driver, spec.joints), level)
              // Act
              const result = generateFirmware(req)
              // Assert
              if (!ok) {
                expect(result.errors.length).toBeGreaterThan(0)
                expect(result.files).toEqual([])
                return
              }
              expect(result.errors).toEqual([])
              expect(findLeaks(result.files)).toEqual([])
              expect(result.steps.length).toBeGreaterThan(4)
              expect(result.libraries.length).toBeGreaterThan(0)
              if (BOARDS[board].kind === 'linux') checkPi(result)
              else checkMcu(result, spec, transport)
            })
          }
        }
      }
    }
  }
})

describe('generated protocol details', () => {
  it('announces the right robot, joint and leg counts in hello', () => {
    // Arrange
    const spec = walkerSpec(8)
    // Act
    const header = file(generateFirmware(request(spec, hwFor('esp32', 'serial', 'pca9685', 24), 'joint')), 'kiyobridge.h').content
    // Assert
    expect(header).toContain('KIYO_HELLO_HEAD[] = "{\\"t\\":\\"hello\\",\\"proto\\":1,\\"board\\":\\"esp32\\",\\"robot\\":\\"walker\\",\\"joints\\":24,\\"legs\\":8,\\"fw\\":\\"kiyobridge-1.0\\""')
  })

  it('announces wheels for the sweeper and drones for the swarm', () => {
    const sweeper = file(generateFirmware(request(sweeperSpec(), hwFor('esp32', 'ws', 'gpio', 4), 'high')), 'kiyobridge.h').content
    const swarm = file(generateFirmware(request(swarmSpec(5), hwFor('esp32', 'serial', 'gpio', 5), 'high')), 'kiyobridge.h').content
    expect(sweeper).toContain('\\"robot\\":\\"sweeper\\",\\"joints\\":4,\\"wheels\\":4')
    expect(swarm).toContain('\\"robot\\":\\"swarm\\",\\"joints\\":5,\\"drones\\":5')
  })

  it('uses the Nordic UART Service UUIDs over BLE', () => {
    const header = file(generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ble', 'pca9685', 18), 'high')), 'kiyobridge.h').content
    expect(header).toContain(`#define KIYO_NUS_SERVICE "${NUS.service}"`)
    expect(header).toContain(`#define KIYO_NUS_RX "${NUS.rx}"`)
    expect(header).toContain(`#define KIYO_NUS_TX "${NUS.tx}"`)
    expect(NUS.service).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e')
    expect(header).toContain('NIMBLE_PROPERTY::NOTIFY')
  })

  it('writes a CHANGE_ME password placeholder and never a stored password', () => {
    const hw = hwFor('esp32', 'ws', 'pca9685', 18, { wifiSsid: 'LabNet', wifiMode: 'sta' })
    const result = generateFirmware(request(walkerSpec(6), hw, 'high'))
    const header = file(result, 'kiyobridge.h').content
    expect(header).toContain(`#define KIYO_WIFI_PASS "${WIFI_PASS_PLACEHOLDER}"`)
    expect(header).toContain('#define KIYO_WIFI_SSID "LabNet"')
    expect(header).toContain('#define KIYO_WIFI_AP 0')
    expect(header).toContain('WebSocketsServer ws(KIYO_WS_PORT)')
    expect(header).toContain('#define KIYO_WS_PORT 81')
    expect(header).toMatch(/Serial\.print\(WiFi\.localIP\(\)\)/)
  })

  it('handles every protocol message in the bridge', () => {
    const header = file(generateFirmware(request(walkerSpec(6), hwFor('esp32', 'serial', 'pca9685', 18), 'joint')), 'kiyobridge.h').content
    for (const t of ['"cmd"', '"home"', '"estop"', '"ping"', '"hello?"']) expect(header).toContain(`strcmp(t, ${t}) == 0`)
    expect(header).toContain('ack("home", true)')
    expect(header).toContain('ack("estop", true)')
    expect(header).toContain('msgW.begin("pong")')
    expect(header).toContain('" clamped"')
    expect(header).toContain('KIYO_WATCHDOG_TEXT')
  })

  it('makes the sketch folder match the .ino name so the Arduino IDE opens it', () => {
    const result = generateFirmware(request(sweeperSpec(), hwFor('stm32', 'serial', 'gpio', 4), 'joint'))
    expect(result.files.map((f) => f.path)).toEqual([
      'sweeper_stm32/sweeper_stm32.ino',
      'sweeper_stm32/kiyobridge.h',
      'sweeper_stm32/platformio.ini',
      'sweeper_stm32/README_FIRMWARE.md',
    ])
  })

  it('adds the drone-side receiver sketch for the swarm', () => {
    const result = generateFirmware(request(swarmSpec(3), hwFor('esp32', 'ws', 'gpio', 3), 'high'))
    const drone = file(result, 'swarm_esp32_drone.ino').content
    expect(drone).toContain('#define KIYO_DRONE_ID 0')
    expect(drone).toContain('esp_now_register_recv_cb(onRecv)')
    expect(drone).toContain('kiyoOnSetpoint')
    expect(delimiterProblems(drone, 'cpp')).toEqual([])
    expect(declareBeforeUseProblems(drone)).toEqual([])
  })

  it('never throws on a malformed request and reports an error instead', () => {
    const broken = { ...walkerSpec(6), jointLimits: undefined } as unknown as HardwareSpec
    const result = generateFirmware(request(broken, hwFor('esp32', 'serial', 'pca9685', 18), 'joint'))
    expect(result.files).toEqual([])
    expect(result.errors[0]).toMatch(/internal generator error|jointLimits/)
  })
})
