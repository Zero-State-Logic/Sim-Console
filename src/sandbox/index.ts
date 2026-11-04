import { useHardware } from '../core/hardware'
import type { RobotModule } from '../core/types'
import { SandboxController } from './host/controller'
import { SourceStore, browserStorage } from './host/persist'
import { spawnWorker } from './host/spawn'
import { realTimers } from './host/watchdog'
import { sandboxConsole, sandboxStore } from './store'

/*
 * CODE drive source — public API used by src/core/runtime.ts.
 * The controller (src/sandbox/host/controller.ts) runs the user program in a Web
 * Worker; the UI (src/sandbox/ui) calls its run / pause / step / reset / stop.
 */
export interface SandboxApi {
  /**
   * Called every frame while the drive source is CODE (dt = 0 when paused).
   * Posts module.getSandboxSensors() to the worker and applies the commands it
   * returned last time via module.applySandboxCommands() (one frame of latency).
   */
  tick(module: RobotModule, dt: number, t: number): void
  /** Drive source switched to CODE. */
  onSourceEnter(module: RobotModule): void
  /** Drive source left CODE. Stops the program and calls module.releaseSandbox(). */
  onSourceExit(module: RobotModule): void
  /** Active robot module was replaced (reload examples / API docs). */
  onRobotChange(module: RobotModule): void
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** The app's sandbox: SandboxApi for the runtime, plus program controls for the UI. */
export const sandbox: SandboxController & SandboxApi = new SandboxController({
  spawn: spawnWorker,
  store: sandboxStore,
  console: sandboxConsole,
  persist: new SourceStore(browserStorage()),
  hardware: () => useHardware.getState().config,
  timers: realTimers,
  clock,
})

export { useSandbox, sandboxStore, sandboxConsole, type ProgramState, type SandboxState } from './store'
export type { Dialect } from './protocol'
