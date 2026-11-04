import type RAPIER from '@dimforge/rapier3d-compat'

/*
 * Lazy Rapier loader. The compat build embeds its WASM as base64 (about 2 MB), so it
 * is only fetched the first time someone picks DYNAMIC. One shared promise; a failed
 * load is forgotten so the next attempt can retry.
 */
export type Rapier = typeof RAPIER

let pending: Promise<Rapier> | null = null

export function loadRapier(): Promise<Rapier> {
  if (!pending) {
    pending = import('@dimforge/rapier3d-compat')
      .then(async (m) => {
        const R = m.default
        await R.init()
        return R
      })
      .catch((err: unknown) => {
        pending = null
        throw err instanceof Error ? err : new Error(String(err))
      })
  }
  return pending
}
