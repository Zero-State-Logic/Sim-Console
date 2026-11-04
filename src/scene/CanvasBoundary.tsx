import { Component, useEffect, type ReactNode } from 'react'
import { runtime } from '../core/runtime'
import { frameStats } from './frameStats'

/*
 * Keeps the console usable when 3D can't run: an error boundary around the Canvas plus
 * a headless driver that keeps stepping the runtime, so instruments, the hardware link
 * and the code sandbox still work without a viewport.
 */

/** rAF loop that drives the runtime when no Canvas is rendering. */
export function HeadlessDriver() {
  useEffect(() => {
    let id = 0
    let last = performance.now()
    const loop = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      runtime.frame(dt)
      frameStats.tick(dt)
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])
  return null
}

export function ViewportUnavailable({ reason, onRetry }: { reason: string; onRetry?: () => void }) {
  return (
    <div className="vp-fallback reg" role="alert">
      <HeadlessDriver />
      <div className="vp-fallback-card">
        <div className="vp-fallback-kicker mono">VIEWPORT OFFLINE</div>
        <h2>3D view unavailable</h2>
        <p>{reason}</p>
        <p className="sub">
          The simulation keeps running: instruments, controls, recording, the hardware link and the code sandbox all still work.
          Try enabling hardware acceleration in your browser settings, or switch quality to LOW.
        </p>
        {onRetry && (
          <button type="button" className="tbtn accent" onClick={onRetry}>
            RETRY 3D
          </button>
        )}
      </div>
    </div>
  )
}

interface BoundaryProps {
  children: ReactNode
}

interface BoundaryState {
  error: string | null
}

export class CanvasBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(e: unknown): BoundaryState {
    return { error: e instanceof Error ? e.message : 'The renderer failed to start.' }
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <ViewportUnavailable
          reason={`The renderer stopped: ${this.state.error.slice(0, 160)}`}
          onRetry={this.retry}
        />
      )
    }
    return this.props.children
  }
}
