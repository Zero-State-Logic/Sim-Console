import { useEffect, useRef } from 'react'

/**
 * Run `cb` on every animation frame (or at most `hz` times per second). The latest
 * callback is always used, so it can read fresh props without re-subscribing. This is
 * how instruments paint at 60 Hz without React re-renders.
 */
export function useRaf(cb: (now: number) => void, hz = 0): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    let id = 0
    let last = 0
    const minGap = hz > 0 ? 1000 / hz : 0
    const loop = (now: number): void => {
      if (now - last >= minGap) {
        last = now
        ref.current(now)
      }
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [hz])
}
