import type { SandboxCommand, SandboxFnDef, SensorSnapshot } from '../../core/types'
import { DEG, MAX_WHEEL_SPEED, MODES } from './constants'
import type { SweeperSim } from './sim'

/*
 * CODE drive source: the functions user code can call. Commands come back to the module
 * one frame later; queries are answered in the worker from the sensor snapshot.
 * Units on this API: meters, m/s, degrees and deg/s (wheel speeds stay rad/s).
 */

export const SANDBOX_API: SandboxFnDef[] = [
  { name: 'setWheels', kind: 'command', params: ['fl', 'fr', 'rl', 'rr'], doc: 'Set the four wheel speeds, rad/s (positive rolls forward).' },
  { name: 'drive', kind: 'command', params: ['vx', 'vy', 'wz'], doc: 'Body twist: vx forward m/s, vy left m/s, wz CCW deg/s. Mixed to the wheels by mecanum IK.' },
  { name: 'stop', kind: 'command', params: [], doc: 'Stop all wheels.' },
  { name: 'setGoal', kind: 'command', params: ['x', 'y'], doc: 'Hand control to the built-in planner: A* + pure pursuit to (x, y) meters.' },
  { name: 'setMode', kind: 'command', params: ['index'], doc: 'Run a built-in behaviour: 0 COVERAGE, 1 GOTO, 2 TELEOP, 3 WANDER.' },
  { name: 'readLidar', kind: 'query', params: ['angleDeg'], sensor: 'lidar', doc: 'LiDAR range at a whole degree 0..359 (CCW from forward), meters; 0 = no return.' },
  { name: 'readMinRange', kind: 'query', params: [], sensor: 'minRange', doc: 'Smallest LiDAR range in the last revolution, meters.' },
  { name: 'readFrontRange', kind: 'query', params: [], sensor: 'frontRange', doc: 'Smallest LiDAR range within 5 degrees of straight ahead, meters.' },
  { name: 'readPose', kind: 'query', params: ['i'], sensor: 'pose', doc: 'Wheel-odometry pose: i = 0 x m, 1 y m, 2 heading deg (drifts with WHEEL SLIP, as on the real robot).' },
  { name: 'readWheel', kind: 'query', params: ['i'], sensor: 'wheel', doc: 'Measured wheel speed, rad/s: 0 FL, 1 FR, 2 RL, 3 RR.' },
  { name: 'readBump', kind: 'query', params: [], sensor: 'bump', doc: '1 while the bumper is pressed, else 0.' },
  { name: 'coverage', kind: 'query', params: [], sensor: 'coverage', doc: 'Floor coverage, percent.' },
]

/** Fresh snapshot (the sandbox may post it asynchronously, so nothing is shared). */
export function sandboxSensors(sim: SweeperSim): SensorSnapshot {
  return {
    lidar: Array.from(sim.lidar.bins, (r) => Math.round(r * 1000) / 1000),
    minRange: sim.lidar.minRange(),
    frontRange: sim.lidar.rangeAround(0, 5),
    // what code on the board can know: odometry, not ground truth
    pose: [sim.odom.x, sim.odom.y, sim.odom.th / DEG],
    wheel: [sim.wheel[0], sim.wheel[1], sim.wheel[2], sim.wheel[3]],
    bump: sim.bump ? 1 : 0,
    coverage: sim.coverage.percent(),
  }
}

const ARITY: Record<string, number> = { setWheels: 4, drive: 3, stop: 0, setGoal: 2, setMode: 1 }

const clamp = (v: number, lim: number): number => Math.max(-lim, Math.min(lim, v))

/** Apply validated commands in order. Unknown names or bad arguments are ignored. */
export function applySandbox(sim: SweeperSim, cmds: readonly SandboxCommand[]): number {
  let applied = 0
  for (const c of cmds) {
    const n = ARITY[c.fn]
    if (n === undefined || !Array.isArray(c.args) || c.args.length < n) continue
    const a = c.args
    if (!a.slice(0, n).every((v) => typeof v === 'number' && Number.isFinite(v))) continue
    applied++
    switch (c.fn) {
      case 'setWheels':
        sim.drive = 'wheels'
        for (let i = 0; i < 4; i++) sim.extWheels[i] = clamp(a[i], MAX_WHEEL_SPEED)
        break
      case 'drive':
        sim.drive = 'twist'
        sim.extTwist.vx = clamp(a[0], 1)
        sim.extTwist.vy = clamp(a[1], 1)
        sim.extTwist.wz = clamp(a[2], 720) * DEG
        break
      case 'stop':
        sim.drive = 'twist'
        sim.extTwist.vx = 0
        sim.extTwist.vy = 0
        sim.extTwist.wz = 0
        break
      case 'setGoal':
        sim.drive = 'nav'
        if (sim.nav.mode !== 'goto') sim.nav.setMode('goto')
        sim.nav.setGoal(clamp(a[0], sim.half), clamp(a[1], sim.half))
        break
      default: {
        const i = Math.round(a[0])
        if (i < 0 || i >= MODES.length) {
          applied--
          break
        }
        sim.drive = 'nav'
        sim.nav.setMode(MODES[i])
      }
    }
  }
  return applied
}
