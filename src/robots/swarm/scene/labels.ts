import * as THREE from 'three'

/*
 * Small numbered badges (waypoint indices) drawn on a canvas in the theme's data
 * font. Returns null outside a browser so the module still builds in Node tests.
 */

const SIZE = 64

export function numberTexture(n: number, ring: string, ink: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = '#FDFDFE'
  g.beginPath()
  g.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 4, 0, Math.PI * 2)
  g.fill()
  g.lineWidth = 4
  g.strokeStyle = ring
  g.stroke()
  g.fillStyle = ink
  g.font = `700 ${n > 9 ? 26 : 30}px "JetBrains Mono", ui-monospace, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(String(n), SIZE / 2, SIZE / 2 + 1)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}
