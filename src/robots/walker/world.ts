import type { WorldConfig } from '../../core/types'

/*
 * Bench setup for a ~0.5 m wide walker: 5 cm grid cells, 25 cm sections, soft shadows
 * sized to the robot. Camera presets are three.js Y-up world coordinates; the robot's
 * forward (+x body) is +x in three, its left (+y body) is −z. 'iso' is the default.
 */
export const WALKER_WORLD: WorldConfig = {
  gridCellSize: 0.05,
  gridSectionSize: 0.25,
  gridFadeDistance: 7,
  shadowScale: 1.6,
  minDistance: 0.22,
  maxDistance: 4,
  cameraPresets: [
    { id: 'iso', label: 'ISO', position: [0.6, 0.42, 0.62], target: [0, 0.05, 0] },
    { id: 'front', label: 'FRONT', position: [0.8, 0.16, 0], target: [0, 0.06, 0] },
    { id: 'side', label: 'SIDE', position: [0, 0.16, 0.8], target: [0, 0.06, 0] },
    { id: 'top', label: 'TOP', position: [0, 0.95, 0.001], target: [0, 0, 0] },
  ],
}
