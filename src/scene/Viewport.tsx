import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { runtime } from '../core/runtime'
import { useConsole } from '../store'
import type { RobotModule } from '../core/types'
import { CanvasBoundary, ViewportUnavailable } from './CanvasBoundary'
import CameraBar from './CameraBar'
import Hud from './Hud'
import SceneRoot from './SceneRoot'
import { probeWebGL } from './device'
import { qualityProfile } from './quality'

/*
 * The 3D viewport: Canvas (behind an error boundary), DOM HUD overlays and the camera
 * preset bar. The module root is remounted whenever the runtime replaces the module.
 * Rendering is linear with no tone mapping (`flat`), so theme colors are exact in 3D.
 */

let moduleSerial = 0
const moduleIds = new WeakMap<RobotModule, number>()
function moduleKey(m: RobotModule): number {
  let id = moduleIds.get(m)
  if (id === undefined) {
    id = ++moduleSerial
    moduleIds.set(m, id)
  }
  return id
}

function useActiveModule(): RobotModule {
  const [module, setModule] = useState<RobotModule>(() => runtime.module)
  useEffect(() => runtime.onModuleChange(setModule), [])
  return module
}

export default function Viewport() {
  const module = useActiveModule()
  const quality = useConsole((s) => s.quality)
  const [contextLost, setContextLost] = useState(false)
  const webgl = probeWebGL()
  const q = qualityProfile(quality)
  const first = module.world.cameraPresets[0]

  return (
    <div className="vp">
      {webgl.webgl ? (
        <CanvasBoundary>
          <Canvas
            shadows
            flat
            dpr={q.dpr}
            gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
            camera={{ position: first?.position ?? [1, 1, 1], fov: 40, near: 0.01, far: 200 }}
            onCreated={({ gl }) => {
              gl.setClearColor('#FDFDFE')
              gl.domElement.addEventListener('webglcontextlost', () => setContextLost(true))
              gl.domElement.addEventListener('webglcontextrestored', () => setContextLost(false))
            }}
            aria-label={`${module.label} 3D view`}
          >
            <SceneRoot module={module} moduleKey={moduleKey(module)} />
          </Canvas>
        </CanvasBoundary>
      ) : (
        <ViewportUnavailable reason="This browser could not create a WebGL context, so the 3D view is off." />
      )}
      <div className="vp-vignette" aria-hidden="true" />
      <Hud module={module} />
      <CameraBar module={module} />
      {contextLost && (
        <div className="vp-lost mono" role="alert">
          GPU CONTEXT LOST · RESTORING…
        </div>
      )}
    </div>
  )
}
