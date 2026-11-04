import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { runtime } from '../core/runtime'
import { recorder } from '../core/recorder'
import type { PointerEvt } from '../core/types'

/*
 * Routes canvas pointer events to the module (drag obstacles, drop waypoints). Each
 * event builds a ray from the camera and intersects the y = 0 ground plane. A consumed
 * 'down' stops the event before OrbitControls sees it (capture phase on the canvas
 * container) and keeps orbit disabled until the matching 'up'.
 * The event object, ray and hit vector are reused: modules must copy what they keep.
 */
export default function PointerRouter({ getControls }: { getControls: () => OrbitControlsImpl | null }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)

  useEffect(() => {
    const canvas = gl.domElement
    const host = canvas.parentElement ?? canvas
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    const evt: PointerEvt = { type: 'move', button: 0, shiftKey: false, ctrlKey: false, altKey: false, raycaster, ground: null }
    let captured: number | null = null

    const build = (type: PointerEvt['type'], e: PointerEvent): PointerEvt => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return evt
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      evt.type = type
      evt.button = e.button
      evt.shiftKey = e.shiftKey
      evt.ctrlKey = e.ctrlKey || e.metaKey
      evt.altKey = e.altKey
      evt.ground = raycaster.ray.intersectPlane(ground, hit)
      return evt
    }

    const release = (): void => {
      const c = getControls()
      if (c) c.enabled = true
      if (captured !== null && canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured)
      captured = null
    }

    const onDown = (e: PointerEvent): void => {
      if (recorder.isReplaying() || e.target !== canvas || captured !== null) return
      if (!runtime.pointer(build('down', e))) return
      e.stopPropagation()
      captured = e.pointerId
      const c = getControls()
      if (c) c.enabled = false
      canvas.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent): void => {
      if (recorder.isReplaying()) return
      if (captured !== null && e.pointerId !== captured) return
      runtime.pointer(build('move', e))
    }
    const onUp = (e: PointerEvent): void => {
      if (captured === null || e.pointerId !== captured) {
        if (!recorder.isReplaying() && e.type === 'pointerup' && e.target === canvas) runtime.pointer(build('up', e))
        return
      }
      runtime.pointer(build('up', e))
      release()
    }

    host.addEventListener('pointerdown', onDown, { capture: true })
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerup', onUp)
    host.addEventListener('pointercancel', onUp)
    return () => {
      host.removeEventListener('pointerdown', onDown, { capture: true })
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerup', onUp)
      host.removeEventListener('pointercancel', onUp)
      release()
    }
  }, [gl, camera, getControls])

  return null
}
