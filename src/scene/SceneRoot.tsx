import { useCallback, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { runtime } from '../core/runtime'
import { useConsole } from '../store'
import type { RobotModule } from '../core/types'
import { CameraRig, type CameraRigHandle } from './CameraRig'
import Effects from './Effects'
import PointerRouter from './PointerRouter'
import StudioLighting from './StudioLighting'
import { qualityProfile } from './quality'
import { frameStats } from './frameStats'

/*
 * Everything inside the Canvas. One frame callback drives the runtime and then the
 * camera, so FOLLOW always tracks the pose that is about to be rendered.
 */
function Driver({ rig }: { rig: RefObject<CameraRigHandle> }) {
  useFrame((_, dt) => {
    runtime.frame(dt)
    rig.current?.update(Math.min(dt, 0.1))
    frameStats.tick(dt)
  })
  return null
}

export default function SceneRoot({ module, moduleKey }: { module: RobotModule; moduleKey: number }) {
  const quality = useConsole((s) => s.quality)
  // re-read module.world when the layout changes shape (e.g. the sweeper's ARENA SIZE
  // rescales its shadow area and camera presets); worlds are memoized, so robots whose
  // world did not change keep the same object and the camera does not move
  useConsole((s) => s.layoutRev)
  const rig = useRef<CameraRigHandle>(null)
  const getControls = useCallback(() => rig.current?.controls() ?? null, [])
  const q = qualityProfile(quality)

  return (
    <>
      <color attach="background" args={['#FDFDFE']} />
      <StudioLighting module={module} quality={quality} />
      {/* dispose={null}: the module owns its GPU resources and frees them in dispose() */}
      <primitive key={moduleKey} object={module.root} dispose={null} />
      <CameraRig ref={rig} module={module} />
      <PointerRouter getControls={getControls} />
      <Driver rig={rig} />
      {q.postprocessing && <Effects module={module} />}
    </>
  )
}
