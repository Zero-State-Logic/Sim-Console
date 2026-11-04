import type { HardwareSpec } from '../../core/types'
import type { BodyHost, VirtualBody } from './common'
import type { Rng } from './random'
import { SweeperBody } from './sweeperBody'
import { SwarmBody } from './swarmBody'
import { WalkerBody } from './walkerBody'

/* ============================================================
   VIRTUAL BODIES — the physical side of the Virtual Device, one
   per robot kind. Deliberately simple, honest models:
    walker : hobby servos (lag + slew), hidden mounting error,
             on-board gait, IMU / loads from the reached pose
    sweeper: mecanum wheels with motor lag, odometry integration
    swarm  : thrust-vectored point-mass quads
   ============================================================ */

export type { BodyHost, DriveMode, VirtualBody } from './common'
export { SweeperBody } from './sweeperBody'
export { SwarmBody } from './swarmBody'
export { WalkerBody } from './walkerBody'

export function createBody(spec: HardwareSpec, rng: Rng, miscal: boolean, host: BodyHost): VirtualBody {
  if (spec.robot === 'sweeper') return new SweeperBody(spec, rng, host)
  if (spec.robot === 'swarm') return new SwarmBody(spec, rng, host)
  return new WalkerBody(spec, rng, miscal, host)
}
