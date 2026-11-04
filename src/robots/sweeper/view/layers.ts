import * as THREE from 'three'

/*
 * Floor overlays (map, coverage, paths, LiDAR fan) live on their own layer.
 * drei's ContactShadows re-renders the whole scene with a depth override from a camera
 * at y = 0; flat overlays a few mm above the floor would print a dark sheet over the
 * arena. The shadow camera only sees layer 0, so overlays are kept off it, and this hook
 * enables the overlay layer on whichever camera renders the scene normally (no override
 * material set), i.e. the main view and its postprocessing passes.
 */

export const OVERLAY_LAYER = 5

export function onOverlayLayer<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => c.layers.set(OVERLAY_LAYER))
  return o
}

/** A zero-area, never-culled mesh whose onBeforeRender turns the overlay layer on. */
export function makeLayerHook(): THREE.Mesh {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3))
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false })
  const hook = new THREE.Mesh(geo, mat)
  hook.frustumCulled = false
  hook.renderOrder = -1000
  hook.onBeforeRender = (_r, scene, camera) => {
    if (scene.overrideMaterial === null) camera.layers.enable(OVERLAY_LAYER)
  }
  return hook
}
