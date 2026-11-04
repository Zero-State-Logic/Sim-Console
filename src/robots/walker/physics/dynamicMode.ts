import type { ActuatorParams } from '../actuator'
import type { WalkerSim } from '../sim'
import { loadRapier, type Rapier } from './loader'
import { RapierWalker } from './rapierWalker'

/* ============================================================
   DYNAMIC MODE lifecycle — Rapier is loaded lazily the first time
   DYNAMIC is picked, one world per spawn, freed on mode switch,
   respawn and dispose. A failed load (or spawn) falls back with an
   error message; a load that finishes after the user switched back
   to KINEMATIC is ignored. No three.js, so it runs in Node tests.
   ============================================================ */

export type PhysicsStatus = 'off' | 'loading' | 'running' | 'failed'

export class DynamicMode {
  status: PhysicsStatus = 'off'
  /** Why the last attempt failed (shown after falling back to KINEMATIC). */
  error = ''
  private R: Rapier | null = null
  private walker: RapierWalker | null = null
  /** Bumped on every enable/disable so a stale async load can tell it lost. */
  private generation = 0
  private pending: Promise<boolean> = Promise.resolve(false)

  /** onChange fires when an async load settles (the module re-reads its controls). */
  constructor(private readonly onChange: () => void, private readonly load: () => Promise<Rapier> = loadRapier) {}

  get running(): boolean {
    return this.status === 'running' && this.walker !== null
  }

  get tipped(): boolean {
    return this.walker?.tipped ?? false
  }

  /** Horizontal body speed from physics, m/s. */
  get speed(): number {
    return this.walker?.speed ?? 0
  }

  /** Switch DYNAMIC on. Resolves true once the world runs; false on failure or when switched off first. */
  enable(sim: WalkerSim): Promise<boolean> {
    if (this.status === 'running' || this.status === 'loading') return this.pending
    const gen = ++this.generation
    this.status = 'loading'
    this.error = ''
    this.pending = this.load().then(
      (R) => this.onLoaded(gen, R, sim),
      (err: unknown) => this.onFailed(gen, err),
    )
    return this.pending
  }

  disable(): void {
    this.generation++
    this.free()
    this.status = 'off'
  }

  /** Fresh world at the sim's current pose (after a reset, leg-count or dimension change). */
  respawn(sim: WalkerSim): void {
    if (!this.R || this.status !== 'running') return
    this.free()
    this.spawn(this.R, sim)
  }

  /** New servo preset: motor stiffness, damping and torque cap. */
  configure(p: ActuatorParams): void {
    this.walker?.configureMotors(p)
  }

  /**
   * One frame: drive the motors to `targets` (radians), run the fixed substeps and
   * read body pose, joint angles, foot loads and motor torques back into the sim.
   */
  step(dt: number, sim: WalkerSim, targets: Float64Array): boolean {
    const w = this.walker
    if (!w) return false
    w.setTargets(targets)
    w.step(dt)
    w.read(sim.state)
    sim.evaluatePhysics()
    return true
  }

  dispose(): void {
    this.disable()
  }

  private onLoaded(gen: number, R: Rapier, sim: WalkerSim): boolean {
    if (gen !== this.generation) return false
    this.R = R
    try {
      this.spawn(R, sim)
    } catch (err: unknown) {
      return this.onFailed(gen, err)
    }
    this.status = 'running'
    this.onChange()
    return true
  }

  private onFailed(gen: number, err: unknown): boolean {
    if (gen !== this.generation) return false
    this.free()
    this.status = 'failed'
    this.error = err instanceof Error ? err.message : String(err)
    this.onChange()
    return false
  }

  private spawn(R: Rapier, sim: WalkerSim): void {
    const s = sim.state
    this.walker = new RapierWalker(R, sim.layout, sim.mass, { pos: s.bodyPos, R: s.bodyR, q: s.q }, sim.actuator)
  }

  private free(): void {
    this.walker?.dispose()
    this.walker = null
  }
}
