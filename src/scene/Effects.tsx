import * as THREE from 'three'
import { EffectComposer, N8AO, SMAA } from '@react-three/postprocessing'
import type { RobotModule } from '../core/types'

/*
 * HIGH-quality postprocessing: N8AO ambient occlusion (contact darkening in joints and
 * under the body) and SMAA. No bloom: on a white robot on a white stage any bloom leak
 * veils the whole frame, and the reference look is crisp, not glowing.
 */
export default function Effects({ module }: { module: RobotModule }) {
  // world-space AO radius scaled to the robot (walker ~0.12 m, room-sized scenes more)
  const aoRadius = Math.max(0.06, Math.min(module.world.shadowScale * 0.025, 0.35))

  return (
    <EffectComposer multisampling={0} frameBufferType={THREE.HalfFloatType}>
      <N8AO aoRadius={aoRadius} distanceFalloff={1} intensity={1.6} quality="medium" halfRes color="black" />
      <SMAA />
    </EffectComposer>
  )
}
