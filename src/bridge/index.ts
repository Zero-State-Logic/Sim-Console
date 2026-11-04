import { useHardware } from '../core/hardware'
import type { RobotModule } from '../core/types'
import { BridgeHost } from './host'
import { bridgeLog, useBridge } from './store'
import { createTransport } from './transports'

/*
 * HARDWARE drive source — public API used by src/core/runtime.ts.
 * `bridge` is the runtime-facing BridgeApi; `hardwareBridge` is the same host with
 * the user actions (connect, home, E-STOP, monitor, calibration) for src/bridge/ui.
 * Nothing starts at import time: the pump timer runs only while a link is attached.
 */
export interface BridgeApi {
  /**
   * Called every frame while the drive source is HARDWARE (dt = 0 when paused).
   * Sends module.buildCommand() at the configured command rate once the link is LIVE,
   * and feeds the newest inbound `tel` to module.applyTelemetry().
   */
  tick(module: RobotModule, dt: number, t: number): void
  /** Drive source switched to HARDWARE. Starts the home-first handshake if connected. */
  onSourceEnter(module: RobotModule): void
  /** Drive source left HARDWARE. Must put the real robot in a safe state (hold/home). */
  onSourceExit(module: RobotModule): void
  /** Active robot module was replaced. */
  onRobotChange(module: RobotModule): void
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export const hardwareBridge = new BridgeHost({
  now,
  startTimer: (fn, ms) => {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  },
  getConfig: () => useHardware.getState().config,
  setConfig: (patch) => useHardware.getState().setConfig(patch),
  publish: (patch) => useBridge.setState(patch),
  log: bridgeLog,
  makeTransport: createTransport,
  miscalibrate: useBridge.getState().miscalibrate,
})

export const bridge: BridgeApi = hardwareBridge

export type { BridgeHost, SendResult } from './host'
export { useBridge, bridgeLog } from './store'
