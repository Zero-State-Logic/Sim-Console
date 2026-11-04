import { useEffect } from 'react'
import { useConsole } from '../store'
import type { RobotKind } from '../core/types'

/*
 * The active robot lives in the URL (?robot=sweeper), so a link opens the console on
 * that robot. Parsing is pure and strict: anything but a known kind is ignored.
 */

const KINDS: readonly RobotKind[] = ['walker', 'sweeper', 'swarm']
export const ROBOT_PARAM = 'robot'

export function parseRobotParam(search: string): RobotKind | null {
  let raw: string | null = null
  try {
    raw = new URLSearchParams(search).get(ROBOT_PARAM)
  } catch {
    return null
  }
  const v = raw?.trim().toLowerCase() ?? ''
  return KINDS.includes(v as RobotKind) ? (v as RobotKind) : null
}

/** The search string with ?robot set to `kind`, other params kept in order. */
export function withRobotParam(search: string, kind: RobotKind): string {
  const params = new URLSearchParams(search)
  params.set(ROBOT_PARAM, kind)
  return `?${params.toString()}`
}

/** Robot named by the page URL, if any (read once at startup). */
export function robotFromLocation(): RobotKind | null {
  return typeof location === 'undefined' ? null : parseRobotParam(location.search)
}

/* ?view= opens on a camera preset (iso, front, side, top or follow): handy for links. */
const VIEWS: readonly string[] = ['iso', 'front', 'side', 'top', 'follow']
export const VIEW_PARAM = 'view'

export function parseViewParam(search: string): string | null {
  let raw: string | null = null
  try {
    raw = new URLSearchParams(search).get(VIEW_PARAM)
  } catch {
    return null
  }
  const v = raw?.trim().toLowerCase() ?? ''
  return VIEWS.includes(v) ? v : null
}

/** Camera preset named by the page URL, if any (read once at startup). */
export function viewFromLocation(): string | null {
  return typeof location === 'undefined' ? null : parseViewParam(location.search)
}

/** Keep ?robot= in step with the active robot (replaceState: no history spam). */
export function useRobotUrlSync(): void {
  const robot = useConsole((s) => s.robot)
  useEffect(() => {
    try {
      if (parseRobotParam(location.search) === robot) return
      const next = `${location.pathname}${withRobotParam(location.search, robot)}${location.hash}`
      history.replaceState(history.state, '', next)
    } catch {
      /* sandboxed frames can refuse history writes; the URL just stays as it was */
    }
  }, [robot])
}
