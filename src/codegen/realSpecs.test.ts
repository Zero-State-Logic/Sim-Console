import { describe, expect, it } from 'vitest'
import { BOARDS, defaultHardwareConfig } from '../core/hardware'
import type { BoardId } from '../core/protocol'
import type { HardwareSpec } from '../core/types'
import { hardwareSpec as swarmHardwareSpec } from '../robots/swarm/hardwareIO'
import { SwarmSim } from '../robots/swarm/sim/swarmSim'
import { hardwareSpec as sweeperHardwareSpec } from '../robots/sweeper/hardwareMap'
import { walkerHardwareSpec } from '../robots/walker/hardwareSpec'
import { WalkerSim } from '../robots/walker/sim'
import { generateFirmware } from './index'

/*
 * Integration: the specs the real robot modules hand the dialog, with the default
 * hardware profile each board starts from, must generate for every transport the
 * board offers (Pico W BLE excepted, which is refused on purpose).
 */

const SPECS: { name: string; spec: () => HardwareSpec }[] = [
  { name: 'walker 4 legs', spec: () => walkerHardwareSpec(new WalkerSim(4)) },
  { name: 'walker 6 legs', spec: () => walkerHardwareSpec(new WalkerSim(6)) },
  { name: 'walker 8 legs', spec: () => walkerHardwareSpec(new WalkerSim(8)) },
  { name: 'sweeper', spec: () => sweeperHardwareSpec() },
  { name: 'swarm', spec: () => swarmHardwareSpec(new SwarmSim(4)) },
]

describe('real robot specs with each board default profile', () => {
  for (const { name, spec: make } of SPECS) {
    for (const board of Object.keys(BOARDS) as BoardId[]) {
      it(`generates ${name} on ${board} for every supported transport and level`, () => {
        const spec = make()
        if (spec.robot === 'swarm' && board !== 'esp32') return
        for (const transport of BOARDS[board].transports) {
          if (board === 'picow' && transport === 'ble') continue
          for (const level of ['joint', 'high'] as const) {
            const hw = { ...defaultHardwareConfig(board, spec.joints), transport }
            const r = generateFirmware({ spec, hw, robotLabel: name.toUpperCase(), level })
            expect(r.errors, `${board}/${transport}/${level}`).toEqual([])
            expect(r.files.length).toBeGreaterThanOrEqual(4)
          }
        }
      })
    }
  }

  it('matches the walker module joint layout (3 joints per leg, names leg-major)', () => {
    const spec = walkerHardwareSpec(new WalkerSim(6))
    const r = generateFirmware({ spec, hw: defaultHardwareConfig('esp32', 18), robotLabel: 'WALKER', level: 'joint' })
    const header = r.files.find((f) => f.path.endsWith('kiyobridge.h'))?.content ?? ''
    expect(header).toContain(`"${spec.jointNames[0]}"`)
    expect(header).toContain('#define KIYO_LEGS 6')
  })
})
