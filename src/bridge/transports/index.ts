import type { HardwareConfig } from '../../core/hardware'
import type { TransportId } from '../../core/protocol'
import type { HardwareSpec } from '../../core/types'
import type { Transport } from '../types'
import { BleTransport } from './ble'
import { LoopbackTransport } from './loopback'
import { SerialTransport } from './serial'
import { WsTransport } from './ws'

export { NUS_RX, NUS_SERVICE, NUS_TX } from './bleQueue'

export interface TransportContext {
  config: () => HardwareConfig
  spec: () => HardwareSpec
  /** Virtual device only: simulate a servo mounting error for the calibration demo. */
  miscalibrate: boolean
}

/** Build the transport the config selects. */
export function createTransport(id: TransportId, ctx: TransportContext): Transport {
  const cfg = ctx.config()
  switch (id) {
    case 'serial':
      return new SerialTransport(cfg.baud)
    case 'ble':
      return new BleTransport(cfg.bleName)
    case 'ws':
      return new WsTransport(cfg.wsUrl)
    case 'loopback':
      return new LoopbackTransport({ spec: ctx.spec, config: ctx.config, miscalibrate: ctx.miscalibrate })
  }
}
