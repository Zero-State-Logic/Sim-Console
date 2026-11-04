import type { ControlDef, ControlValue } from '../../core/types'
import type { SimParams } from './sim'
import type { ViewFlags } from './view/SweeperView'

/*
 * Control plumbing kept out of the module: which control feeds which sim parameter or
 * view flag, and validation of incoming values (UI, keyboard, profiles, sandbox). A
 * value that does not fit its control is rejected, never coerced into another meaning.
 */

/** Numeric controls that map 1:1 onto a sim parameter. */
export const PARAM_KEYS: Readonly<Record<string, keyof SimParams>> = {
  maxSpeed: 'maxSpeed',
  lookahead: 'lookahead',
  speed: 'teleopSpeed',
  brush: 'brushWidth',
  noise: 'noise',
}

/** Boolean controls that map onto a sim parameter. */
export const PARAM_TOGGLES: Readonly<Record<string, 'safety' | 'slip'>> = {
  safety: 'safety',
  slip: 'slip',
}

export const FLAG_KEYS: Readonly<Record<string, keyof ViewFlags>> = {
  showMap: 'map',
  showCoverage: 'coverage',
  showRays: 'rays',
  showPlan: 'plan',
}

export const ARENA_ACTIONS = ['addBox', 'addCyl', 'removeSel', 'randomize', 'clear'] as const
export type ArenaAction = (typeof ARENA_ACTIONS)[number]

export function isArenaAction(key: string): key is ArenaAction {
  return (ARENA_ACTIONS as readonly string[]).includes(key)
}

/** The value as the control accepts it (sliders clamped and snapped), or null to reject. */
export function sanitizeControl(def: ControlDef, value: ControlValue): ControlValue | null {
  switch (def.type) {
    case 'slider': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      const clamped = Math.min(def.max, Math.max(def.min, value))
      const snapped = def.min + Math.round((clamped - def.min) / def.step) * def.step
      // keep the decimal noise of the snap out of the stored value
      return Math.min(def.max, Number(snapped.toFixed(6)))
    }
    case 'select':
      return typeof value === 'string' && def.options.some((o) => o.value === value) ? value : null
    case 'toggle':
      return typeof value === 'boolean' ? value : null
    default:
      return true
  }
}
