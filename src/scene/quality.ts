import type { Quality } from '../store'

/*
 * Render quality. Auto-detected once at startup; a manual choice from the top bar is
 * remembered per browser and wins over detection.
 */

export const QUALITY_STORAGE_KEY = 'simconsole.quality.v1'
/** At or below this many logical cores, postprocessing costs more than it's worth. */
const LOW_CORES = 4

export interface DeviceInfo {
  userAgent: string
  /** navigator.hardwareConcurrency (0 when unknown). */
  cores: number
  webgl2: boolean
}

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i

export function detectQuality(d: DeviceInfo): Quality {
  if (!d.webgl2) return 'low'
  if (MOBILE_UA.test(d.userAgent)) return 'low'
  if (d.cores > 0 && d.cores <= LOW_CORES) return 'low'
  return 'high'
}

export function parseStoredQuality(raw: string | null): Quality | null {
  return raw === 'high' || raw === 'low' ? raw : null
}

/** Scene settings that differ by quality tier. */
export interface QualityProfile {
  dpr: [number, number]
  shadowMapSize: number
  contactShadowRes: number
  envResolution: number
  postprocessing: boolean
}

export function qualityProfile(q: Quality): QualityProfile {
  return q === 'high'
    ? { dpr: [1, 2], shadowMapSize: 2048, contactShadowRes: 512, envResolution: 256, postprocessing: true }
    : { dpr: [1, 1.5], shadowMapSize: 1024, contactShadowRes: 256, envResolution: 64, postprocessing: false }
}
