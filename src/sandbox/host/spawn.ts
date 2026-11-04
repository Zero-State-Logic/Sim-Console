import type { WorkerLike } from './controller'

/** Start a fresh code worker. Vite bundles worker.ts as its own ES module chunk. */
export function spawnWorker(): WorkerLike {
  return new Worker(new URL('../worker.ts', import.meta.url), { type: 'module', name: 'sim-console-sandbox' })
}
