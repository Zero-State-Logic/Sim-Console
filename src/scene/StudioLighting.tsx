import { useEffect, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { ContactShadows, Environment, Grid, Lightformer } from '@react-three/drei'
import * as THREE from 'three'
import type { RobotModule } from '../core/types'
import { qualityProfile } from './quality'
import type { Quality } from '../store'

/*
 * Studio light rig: an environment baked once from Lightformers (no HDR download), one
 * soft key light whose shadow frustum follows the robot, a shadow catcher, contact
 * shadows and the module's blueprint grid.
 *
 * The renderer runs without tone mapping (exact theme colors in 3D), so intensities are
 * chosen to keep lit white plastic just under 1.0: env fill ~0.35, top softbox ~0.35,
 * key ~0.25 on an up-facing white face.
 */
const ENV_FILL = '#a3a9ae'
const KEY_INTENSITY = 0.85
/** Key light direction (from target), normalised at use. */
const KEY_DIR = new THREE.Vector3(3.2, 6, 2.4).normalize()
const SHADOW_OPACITY = 0.16
const CONTACT_OPACITY = 0.42
const INK = '#14171A'
const GRID_CELL = '#D3D7DB'
const GRID_SECTION = '#B8BEC4'

function EnvironmentRig({ resolution }: { resolution: number }) {
  return (
    <Environment resolution={resolution} frames={1} background={false}>
      <color attach="background" args={[ENV_FILL]} />
      {/* overhead softbox */}
      <Lightformer form="rect" intensity={1.15} color="#ffffff" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[7, 7, 1]} />
      {/* side strips: give the faceted body its edge highlights */}
      <Lightformer form="rect" intensity={0.9} color="#f4f7fa" position={[-6, 2.2, 1]} rotation-y={Math.PI / 2} scale={[8, 1.6, 1]} />
      <Lightformer form="rect" intensity={0.7} color="#eef3f7" position={[6, 2.6, -1]} rotation-y={-Math.PI / 2} scale={[8, 1.2, 1]} />
      {/* back rim ring, catches clearcoat on silhouettes */}
      <Lightformer form="ring" intensity={1.4} color="#ffffff" position={[0, 3, -8]} scale={3} />
      {/* faint warm kicker from the front-left */}
      <Lightformer form="circle" intensity={0.35} color="#fff1e8" position={[-4, 1, 6]} scale={2} />
    </Environment>
  )
}

interface Props {
  module: RobotModule
  quality: Quality
  /** Exposed so the selective bloom can light its mask (not required for emissive). */
  keyLightRef?: MutableRefObject<THREE.DirectionalLight | null>
}

export default function StudioLighting({ module, quality, keyLightRef }: Props) {
  const light = useRef<THREE.DirectionalLight>(null)
  const shadowGroup = useRef<THREE.Group>(null)
  const anchor = useRef(new THREE.Vector3(Number.NaN, 0, Number.NaN))
  const q = qualityProfile(quality)
  const w = module.world
  const half = Math.max(w.shadowScale * 0.65, 1)

  useEffect(() => {
    const l = light.current
    if (!l) return
    if (keyLightRef) keyLightRef.current = l
    anchor.current.set(Number.NaN, 0, Number.NaN)
    const cam = l.shadow.camera
    cam.left = -half
    cam.right = half
    cam.top = half
    cam.bottom = -half
    cam.near = 0.05
    cam.far = half * 8 + 10
    cam.updateProjectionMatrix()
    l.shadow.bias = -0.0004
    l.shadow.normalBias = 0.012 * Math.max(w.shadowScale / 3, 1)
    l.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize)
    l.shadow.map?.dispose()
    l.shadow.map = null
    l.shadow.needsUpdate = true
  }, [half, q.shadowMapSize, w.shadowScale, keyLightRef])

  // keep the shadow frustum and contact shadows centred on the robot
  useFrame(() => {
    const l = light.current
    if (!l) return
    const ft = module.followTarget()
    const texel = (2 * half) / q.shadowMapSize
    // snapping to the texel grid stops shadow edges shimmering as the robot moves
    const x = ft ? Math.round(ft.x / texel) * texel : 0
    const z = ft ? Math.round(ft.z / texel) * texel : 0
    if (anchor.current.x === x && anchor.current.z === z) return
    anchor.current.set(x, 0, z)
    const dist = half * 4 + 4
    l.position.set(x + KEY_DIR.x * dist, KEY_DIR.y * dist, z + KEY_DIR.z * dist)
    // the target is not in the scene graph, so its world matrix is refreshed by hand
    l.target.position.set(x, 0, z)
    l.target.updateMatrixWorld()
    shadowGroup.current?.position.set(x, 0, z)
  })

  return (
    <>
      <EnvironmentRig resolution={q.envResolution} />
      <directionalLight ref={light} intensity={KEY_INTENSITY} color="#ffffff" castShadow />
      <hemisphereLight args={['#ffffff', '#d9dde1', 0.12]} />

      <group ref={shadowGroup}>
        <ContactShadows
          position={[0, 0.0008, 0]}
          opacity={CONTACT_OPACITY}
          blur={2.4}
          scale={w.shadowScale}
          far={Math.max(0.6, w.shadowScale * 0.35)}
          resolution={q.contactShadowRes}
          color={INK}
        />
      </group>

      {/* catcher for the key light's shadow; sits under any module floor at y = 0 */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.0004, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <shadowMaterial transparent opacity={SHADOW_OPACITY} color={INK} depthWrite={false} />
      </mesh>

      <Grid
        args={[40, 40]}
        cellSize={w.gridCellSize}
        cellThickness={0.6}
        cellColor={GRID_CELL}
        sectionSize={w.gridSectionSize}
        sectionThickness={1.05}
        sectionColor={GRID_SECTION}
        fadeDistance={w.gridFadeDistance}
        fadeStrength={1.4}
        followCamera
        infiniteGrid
        position={[0, -0.001, 0]}
      />
    </>
  )
}
