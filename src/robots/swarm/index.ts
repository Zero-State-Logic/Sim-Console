import type { RobotEntry } from '../../core/types'
import { SwarmModule } from './SwarmModule'

/* SWARM — discovered by the robot registry (src/robots/index.ts). */
export const entry: RobotEntry = {
  kind: 'swarm',
  label: 'SWARM',
  create: () => new SwarmModule(),
}
