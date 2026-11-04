import { compile, createVM } from '../compiler'
import type { Drain } from './runner/jsRunner'
import { WorkerCore } from './workerCore'

/*
 * CODE SANDBOX WORKER. Started by the main thread with
 *   new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
 * It owns nothing but the user program; all logic lives in workerCore.ts.
 * The worker itself is the isolation boundary: the main thread validates every
 * reply and terminates this worker when a tick blocks for more than a second.
 */

interface WorkerScope {
  postMessage(msg: unknown): void
  onmessage: ((e: MessageEvent) => void) | null
}

const scope = self as unknown as WorkerScope

/** Macrotask yield through a MessageChannel: lets user microtasks settle without timer clamping. */
function channelDrain(): Drain {
  const ch = new MessageChannel()
  const waiting: (() => void)[] = []
  ch.port1.onmessage = () => {
    waiting.shift()?.()
  }
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve)
      ch.port2.postMessage(0)
    })
}

const core = new WorkerCore(
  { compiler: { compile, createVM }, clock: () => performance.now(), drain: channelDrain() },
  (msg) => scope.postMessage(msg),
)

scope.onmessage = (e: MessageEvent) => {
  void core.receive(e.data)
}
