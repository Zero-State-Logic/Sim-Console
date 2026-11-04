import type { RobotEntry } from '../../core/types'
import { WalkerModule } from './WalkerModule'

/* WALKER — discovered by the robot registry (src/robots/index.ts). */
export const entry: RobotEntry = {
  kind: 'walker',
  label: 'WALKER',
  create: () => new WalkerModule(),
}
