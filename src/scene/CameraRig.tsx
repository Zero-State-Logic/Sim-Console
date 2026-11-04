import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { useConsole } from '../store'
import { useUi } from '../ui/uiStore'
import type { RobotModule, Vec3Tuple } from '../core/types'
import { FOLLOW_ID, FOLLOW_RATE, TWEEN_SECONDS, findPreset, safePresetPosition, smoothingAlpha, tweenInto } from './cameraMath'

/*
 * Orbit camera with preset tweens and FOLLOW. The scene driver calls update(dt) right
 * after runtime.frame(), so FOLLOW tracks the pose of the frame being rendered.
 * FOLLOW shifts camera and target by the same delta, which keeps the user's orbit offset.
 */

export interface CameraRigHandle {
  update(dt: number): void
  controls(): OrbitControlsImpl | null
}

interface Tween {
  active: boolean
  elapsed: number
  fromPos: Vec3Tuple
  fromTarget: Vec3Tuple
  toPos: Vec3Tuple
  toTarget: Vec3Tuple
}

const newTween = (): Tween => ({ active: false, elapsed: 0, fromPos: [0, 0, 0], fromTarget: [0, 0, 0], toPos: [0, 0, 0], toTarget: [0, 0, 0] })

export const CameraRig = forwardRef<CameraRigHandle, { module: RobotModule }>(function CameraRig({ module }, ref) {
  const camera = useThree((s) => s.camera)
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const tween = useRef<Tween>(newTween())
  const scratchPos = useRef<Vec3Tuple>([0, 0, 0])
  const scratchTarget = useRef<Vec3Tuple>([0, 0, 0])
  const followDelta = useRef(new THREE.Vector3())
  const preset = useConsole((s) => s.cameraPreset)
  const nonce = useUi((s) => s.cameraNonce)
  const world = module.world

  // new module: jump straight to its default view (no tween across robots)
  useLayoutEffect(() => {
    const p = world.cameraPresets[0]
    const c = controlsRef.current
    if (!p) return
    const pos = safePresetPosition(p.position, p.target)
    camera.position.set(pos[0], pos[1], pos[2])
    if (c) {
      c.target.set(p.target[0], p.target[1], p.target[2])
      c.update()
    } else {
      camera.lookAt(p.target[0], p.target[1], p.target[2])
    }
    tween.current.active = false
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.far = Math.max(200, world.maxDistance * 6)
      camera.updateProjectionMatrix()
    }
  }, [module, camera, world])

  // preset requests (store.cameraPreset + a nonce so re-clicking re-tweens)
  useEffect(() => {
    if (preset === FOLLOW_ID) {
      tween.current.active = false
      return
    }
    const p = findPreset(world, preset)
    const c = controlsRef.current
    if (!p || !c) return
    const t = tween.current
    t.fromPos = [camera.position.x, camera.position.y, camera.position.z]
    t.fromTarget = [c.target.x, c.target.y, c.target.z]
    t.toPos = safePresetPosition(p.position, p.target)
    t.toTarget = [p.target[0], p.target[1], p.target[2]]
    t.elapsed = 0
    t.active = true
  }, [preset, nonce, world, camera])

  useImperativeHandle(
    ref,
    () => ({
      controls: () => controlsRef.current,
      update(dt: number) {
        const c = controlsRef.current
        if (!c) return
        const t = tween.current
        if (t.active) {
          t.elapsed += dt
          const p = Math.min(t.elapsed / TWEEN_SECONDS, 1)
          const pos = tweenInto(scratchPos.current, t.fromPos, t.toPos, p)
          const tgt = tweenInto(scratchTarget.current, t.fromTarget, t.toTarget, p)
          camera.position.set(pos[0], pos[1], pos[2])
          c.target.set(tgt[0], tgt[1], tgt[2])
          camera.lookAt(c.target)
          if (p >= 1) t.active = false
          return
        }
        if (useConsole.getState().cameraPreset !== FOLLOW_ID) return
        const ft = module.followTarget()
        if (!ft) return
        const a = smoothingAlpha(FOLLOW_RATE, dt)
        const d = followDelta.current.copy(ft).sub(c.target).multiplyScalar(a)
        c.target.add(d)
        camera.position.add(d)
      },
    }),
    [camera, module],
  )

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.09}
      maxPolarAngle={Math.PI * 0.495}
      minDistance={world.minDistance}
      maxDistance={world.maxDistance}
      // user input cancels a running preset tween
      onStart={() => {
        tween.current.active = false
      }}
    />
  )
})
