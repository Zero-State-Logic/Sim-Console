/*
 * Render-loop statistics for the HUD. The scene driver ticks it every frame; the HUD
 * reads it on its own throttled rAF. Plain mutable object: no React state.
 */
const WINDOW_S = 0.5

export class FrameStats {
  /** Frames per second averaged over the last ~0.5 s. */
  fps = 0
  private frames = 0
  private elapsed = 0

  tick(dt: number): void {
    if (!(dt > 0)) return
    this.frames++
    this.elapsed += dt
    if (this.elapsed >= WINDOW_S) {
      this.fps = this.frames / this.elapsed
      this.frames = 0
      this.elapsed = 0
    }
  }
}

export const frameStats = new FrameStats()
