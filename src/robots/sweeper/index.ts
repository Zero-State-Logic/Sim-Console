import type { RobotEntry } from '../../core/types'
import { SweeperModule } from './SweeperModule'

/* SWEEPER — the romi_nav twin. Discovered by the robot registry (src/robots/index.ts). */
export const entry: RobotEntry = {
  kind: 'sweeper',
  label: 'SWEEPER',
  create: () => new SweeperModule(),
}
