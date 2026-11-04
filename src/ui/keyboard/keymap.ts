import type { ControlDef } from '../../core/types'

/*
 * Keyboard mapping, pure. Physical key codes (KeyboardEvent.code) are used so WASD sits
 * in the same place on AZERTY/QWERTZ layouts. The shell turns held keys into the shared
 * direction-pad ('dir') and turn ('turn') control values.
 */

export type DirValue = 'fl' | 'f' | 'fr' | 'l' | 'stop' | 'r' | 'bl' | 'b' | 'br'
export type TurnValue = 'ccw' | 'none' | 'cw'
type Axis = 'f' | 'b' | 'l' | 'r'

export const DIR_KEYS: Readonly<Record<string, Axis>> = {
  KeyW: 'f',
  ArrowUp: 'f',
  KeyS: 'b',
  ArrowDown: 'b',
  KeyA: 'l',
  ArrowLeft: 'l',
  KeyD: 'r',
  ArrowRight: 'r',
}

export const TURN_KEYS: Readonly<Record<string, 'ccw' | 'cw'>> = { KeyQ: 'ccw', KeyE: 'cw' }

export function isDirKey(code: string): boolean {
  return code in DIR_KEYS
}

export function isTurnKey(code: string): boolean {
  return code in TURN_KEYS
}

/** Held keys → 3×3 pad value. Opposite keys cancel; two axes make a diagonal. */
export function dirFromKeys(held: ReadonlySet<string>): DirValue {
  let fwd = 0
  let side = 0
  const seen = new Set<Axis>()
  for (const code of held) {
    const a = DIR_KEYS[code]
    if (!a || seen.has(a)) continue
    seen.add(a)
    if (a === 'f') fwd++
    else if (a === 'b') fwd--
    else if (a === 'l') side--
    else side++
  }
  const v = (fwd > 0 ? 'f' : fwd < 0 ? 'b' : '') + (side < 0 ? 'l' : side > 0 ? 'r' : '')
  return (v || 'stop') as DirValue
}

export function turnFromKeys(held: ReadonlySet<string>): TurnValue {
  let ccw = false
  let cw = false
  for (const code of held) {
    if (TURN_KEYS[code] === 'ccw') ccw = true
    else if (TURN_KEYS[code] === 'cw') cw = true
  }
  return ccw === cw ? 'none' : ccw ? 'ccw' : 'cw'
}

/**
 * Fit a pad value to the options a module actually offers: a missing diagonal falls back
 * to its forward/back component, then its side component, then 'stop'.
 */
export function resolveDir(v: DirValue, options: readonly string[]): string {
  if (options.includes(v)) return v
  if (v.length === 2) {
    if (options.includes(v[0])) return v[0]
    if (options.includes(v[1])) return v[1]
  }
  return options.includes('stop') ? 'stop' : options[0] ?? 'stop'
}

export interface DriveKeyInfo {
  /** Options of the 'dir' select, or null when the module has no direction pad. */
  dir: string[] | null
  turn: string[] | null
}

/** Which keyboard-drivable controls the schema exposes. */
export function driveKeyInfo(schema: readonly ControlDef[]): DriveKeyInfo {
  let dir: string[] | null = null
  let turn: string[] | null = null
  for (const d of schema) {
    if (d.type !== 'select' || d.disabled) continue
    if (d.key === 'dir' && d.display === 'grid3') dir = d.options.map((o) => o.value)
    else if (d.key === 'turn') turn = d.options.map((o) => o.value)
  }
  return { dir, turn }
}

/** Which drive controls a key event touched. */
export interface DriveAxes {
  dir: boolean
  turn: boolean
}

/** Axes driven by these key codes (e.g. the keys a blur just released). */
export function axesOf(codes: Iterable<string>): DriveAxes {
  let dir = false
  let turn = false
  for (const c of codes) {
    if (isDirKey(c)) dir = true
    else if (isTurnKey(c)) turn = true
  }
  return { dir, turn }
}

export interface DriveWrite {
  key: 'dir' | 'turn'
  value: string
}

/**
 * Control writes for the held keys, limited to the axes a key event touched, so tapping
 * Q never stops a latched (or mouse-held) pad and W never cancels a turn. Writes that
 * would not change the current value are skipped.
 */
export function driveWrites(
  held: ReadonlySet<string>,
  info: DriveKeyInfo,
  current: Readonly<Record<string, unknown>>,
  axes: DriveAxes,
): DriveWrite[] {
  const out: DriveWrite[] = []
  if (axes.dir && info.dir) {
    const v = resolveDir(dirFromKeys(held), info.dir)
    if (current.dir !== v) out.push({ key: 'dir', value: v })
  }
  if (axes.turn && info.turn) {
    const v = turnFromKeys(held)
    if (info.turn.includes(v) && current.turn !== v) out.push({ key: 'turn', value: v })
  }
  return out
}

export type ShortcutAction =
  | { type: 'togglePlay' }
  | { type: 'reset' }
  | { type: 'robot'; index: number }
  | { type: 'follow' }
  | { type: 'cycleCamera' }
  | { type: 'help' }

export interface Modifiers {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const ROBOT_DIGITS: Readonly<Record<string, number>> = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 }

/** One-shot shortcuts. Ctrl/Cmd/Alt combos are left to the browser. */
export function shortcutFor(code: string, mods: Modifiers): ShortcutAction | null {
  if (mods.ctrlKey || mods.metaKey || mods.altKey) return null
  if (code === 'Slash' && mods.shiftKey) return { type: 'help' }
  if (mods.shiftKey) return null
  if (code === 'Space') return { type: 'togglePlay' }
  if (code === 'KeyR') return { type: 'reset' }
  if (code === 'KeyF') return { type: 'follow' }
  if (code === 'KeyC') return { type: 'cycleCamera' }
  if (code in ROBOT_DIGITS) return { type: 'robot', index: ROBOT_DIGITS[code] }
  return null
}

/** Next preset id in the cycle (module presets, then 'follow'). Unknown ids restart the cycle. */
export function nextCameraPreset(ids: readonly string[], current: string): string {
  if (ids.length === 0) return current
  const i = ids.indexOf(current)
  return ids[(i + 1) % ids.length]
}

/** F toggles between FOLLOW and the module's default view. */
export function toggleFollow(current: string, defaultId: string): string {
  return current === 'follow' ? defaultId : 'follow'
}

/** Minimal element shape, so focus checks are testable without a DOM. */
export interface FocusLike {
  tagName: string
  type?: string
  isContentEditable?: boolean
  closest?(selector: string): unknown
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'time', ''])

/** True when keys should go to the focused element (text fields, selects, CodeMirror). */
export function isTypingTarget(el: FocusLike | null): boolean {
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.type ?? '').toLowerCase())
  if (el.isContentEditable) return true
  return Boolean(el.closest?.('.cm-editor, [contenteditable="true"], [role="textbox"]'))
}

/** Arrow keys on a focused range input adjust the slider natively; leave them alone. */
export function isNativeArrowTarget(el: FocusLike | null, code: string): boolean {
  if (!el || !code.startsWith('Arrow')) return false
  const tag = el.tagName.toUpperCase()
  return (tag === 'INPUT' && el.type === 'range') || Boolean(el.closest?.('[role="radiogroup"], [role="tablist"], [role="slider"]'))
}
