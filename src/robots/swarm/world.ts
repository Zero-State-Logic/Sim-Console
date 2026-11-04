import type { WorldConfig } from '../../core/types'
import { VOLUME_HALF } from './sim/swarmSim'

/*
 * World framing for the swarm: a 20 m flight volume, a 1 m blueprint grid with 5 m
 * sections, and camera presets that frame the whole volume at the default cruise
 * altitude. three.js Y-up; the robots' forward (sim +x) is three.js +X.
 */

const SPAN = 2 * VOLUME_HALF
const AIM: [number, number, number] = [0, 2.2, 0]

export const SWARM_WORLD: WorldConfig = {
  gridCellSize: 1,
  gridSectionSize: 5,
  gridFadeDistance: 70,
  // shadow frustum and contact shadows are centred on the leader; this covers a formation
  shadowScale: 16,
  minDistance: 1.2,
  maxDistance: 3.2 * SPAN,
  cameraPresets: [
    { id: 'iso', label: 'ISO', position: [15.5, 12.5, 17], target: AIM },
    { id: 'front', label: 'FRONT', position: [24, 4.5, 0], target: AIM },
    { id: 'side', label: 'SIDE', position: [0, 4.5, 24], target: AIM },
    { id: 'top', label: 'TOP', position: [0, 32, 0], target: [0, 0, 0] },
  ],
}
