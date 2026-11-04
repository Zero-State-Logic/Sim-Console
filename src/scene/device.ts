import type { Quality } from '../store'
import { QUALITY_STORAGE_KEY, detectQuality, parseStoredQuality } from './quality'

/* Browser capability probes, run once. */

export interface WebGLSupport {
  webgl: boolean
  webgl2: boolean
}

let support: WebGLSupport | null = null

export function probeWebGL(): WebGLSupport {
  if (support) return support
  let webgl = false
  let webgl2 = false
  try {
    const c = document.createElement('canvas')
    const gl2 = c.getContext('webgl2')
    webgl2 = Boolean(gl2)
    webgl = webgl2 || Boolean(c.getContext('webgl') ?? c.getContext('experimental-webgl'))
    gl2?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    webgl = false
    webgl2 = false
  }
  support = { webgl, webgl2 }
  return support
}

/** The user's remembered choice, else auto-detection. */
export function initialQuality(): Quality {
  try {
    const stored = parseStoredQuality(localStorage.getItem(QUALITY_STORAGE_KEY))
    if (stored) return stored
  } catch {
    /* storage blocked: fall through to detection */
  }
  return detectQuality({
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    cores: typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0,
    webgl2: probeWebGL().webgl2,
  })
}

export function rememberQuality(q: Quality): void {
  try {
    localStorage.setItem(QUALITY_STORAGE_KEY, q)
  } catch {
    /* not persisted */
  }
}
