import { describe, expect, it } from 'vitest'
import type { ControlDef } from '../../core/types'
import {
  axesOf,
  dirFromKeys,
  driveKeyInfo,
  driveWrites,
  isDirKey,
  isNativeArrowTarget,
  isTurnKey,
  isTypingTarget,
  nextCameraPreset,
  resolveDir,
  shortcutFor,
  toggleFollow,
  turnFromKeys,
  type FocusLike,
} from './keymap'

const held = (...codes: string[]): Set<string> => new Set(codes)
const NO_MODS = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
const ALL_DIRS = ['fl', 'f', 'fr', 'l', 'stop', 'r', 'bl', 'b', 'br']

describe('dirFromKeys', () => {
  it('returns stop with nothing held', () => {
    expect(dirFromKeys(held())).toBe('stop')
  })

  it('maps WASD and arrows to the four cardinals', () => {
    expect(dirFromKeys(held('KeyW'))).toBe('f')
    expect(dirFromKeys(held('ArrowDown'))).toBe('b')
    expect(dirFromKeys(held('KeyA'))).toBe('l')
    expect(dirFromKeys(held('ArrowRight'))).toBe('r')
  })

  it('combines two axes into diagonals', () => {
    expect(dirFromKeys(held('KeyW', 'KeyA'))).toBe('fl')
    expect(dirFromKeys(held('ArrowUp', 'KeyD'))).toBe('fr')
    expect(dirFromKeys(held('KeyS', 'ArrowLeft'))).toBe('bl')
    expect(dirFromKeys(held('KeyS', 'KeyD'))).toBe('br')
  })

  it('cancels opposite keys and does not double count W plus ArrowUp', () => {
    expect(dirFromKeys(held('KeyW', 'KeyS'))).toBe('stop')
    expect(dirFromKeys(held('KeyW', 'KeyS', 'KeyD'))).toBe('r')
    expect(dirFromKeys(held('KeyW', 'ArrowUp', 'KeyS'))).toBe('stop')
  })

  it('ignores unrelated keys', () => {
    expect(dirFromKeys(held('KeyQ', 'Space'))).toBe('stop')
  })
})

describe('turnFromKeys', () => {
  it('maps Q to ccw, E to cw, both or neither to none', () => {
    expect(turnFromKeys(held('KeyQ'))).toBe('ccw')
    expect(turnFromKeys(held('KeyE', 'KeyW'))).toBe('cw')
    expect(turnFromKeys(held('KeyQ', 'KeyE'))).toBe('none')
    expect(turnFromKeys(held())).toBe('none')
  })
})

describe('key classification', () => {
  it('recognises drive and turn keys', () => {
    expect(isDirKey('KeyW')).toBe(true)
    expect(isDirKey('KeyQ')).toBe(false)
    expect(isTurnKey('KeyE')).toBe(true)
  })
})

describe('resolveDir', () => {
  it('keeps a value the pad offers', () => {
    expect(resolveDir('fl', ALL_DIRS)).toBe('fl')
  })

  it('falls back from a missing diagonal to its forward component, then side, then stop', () => {
    expect(resolveDir('fl', ['f', 'b', 'l', 'r', 'stop'])).toBe('f')
    expect(resolveDir('br', ['l', 'r', 'stop'])).toBe('r')
    expect(resolveDir('f', ['stop', 'l'])).toBe('stop')
    expect(resolveDir('f', ['x'])).toBe('x')
  })
})

describe('driveKeyInfo', () => {
  it('finds the grid3 dir pad and the turn select', () => {
    // Arrange
    const schema: ControlDef[] = [
      { type: 'select', key: 'dir', label: 'DIR', group: 'L', display: 'grid3', value: 'stop', options: ALL_DIRS.map((v) => ({ value: v, label: v })) },
      { type: 'select', key: 'turn', label: 'TURN', group: 'L', value: 'none', options: ['ccw', 'none', 'cw'].map((v) => ({ value: v, label: v })) },
    ]
    // Act
    const info = driveKeyInfo(schema)
    // Assert
    expect(info.dir).toEqual(ALL_DIRS)
    expect(info.turn).toEqual(['ccw', 'none', 'cw'])
  })

  it('ignores a dir select that is not a grid3 pad or is disabled', () => {
    const schema: ControlDef[] = [
      { type: 'select', key: 'dir', label: 'DIR', group: 'L', value: 'f', options: [{ value: 'f', label: 'f' }] },
      { type: 'select', key: 'turn', label: 'T', group: 'L', value: 'none', disabled: true, options: [] },
    ]
    expect(driveKeyInfo(schema)).toEqual({ dir: null, turn: null })
  })
})

describe('shortcutFor', () => {
  it('maps the documented shortcuts', () => {
    expect(shortcutFor('Space', NO_MODS)).toEqual({ type: 'togglePlay' })
    expect(shortcutFor('KeyR', NO_MODS)).toEqual({ type: 'reset' })
    expect(shortcutFor('Digit2', NO_MODS)).toEqual({ type: 'robot', index: 1 })
    expect(shortcutFor('Numpad3', NO_MODS)).toEqual({ type: 'robot', index: 2 })
    expect(shortcutFor('KeyF', NO_MODS)).toEqual({ type: 'follow' })
    expect(shortcutFor('KeyC', NO_MODS)).toEqual({ type: 'cycleCamera' })
    expect(shortcutFor('Slash', { ...NO_MODS, shiftKey: true })).toEqual({ type: 'help' })
  })

  it('leaves browser combos and unknown keys alone', () => {
    expect(shortcutFor('KeyR', { ...NO_MODS, ctrlKey: true })).toBeNull()
    expect(shortcutFor('KeyR', { ...NO_MODS, metaKey: true })).toBeNull()
    expect(shortcutFor('KeyR', { ...NO_MODS, shiftKey: true })).toBeNull()
    expect(shortcutFor('KeyZ', NO_MODS)).toBeNull()
  })
})

describe('camera cycling', () => {
  const ids = ['iso', 'front', 'side', 'top', 'follow']

  it('advances and wraps, restarting from an unknown id', () => {
    expect(nextCameraPreset(ids, 'iso')).toBe('front')
    expect(nextCameraPreset(ids, 'follow')).toBe('iso')
    expect(nextCameraPreset(ids, '')).toBe('iso')
    expect(nextCameraPreset([], 'iso')).toBe('iso')
  })

  it('toggles follow against the default view', () => {
    expect(toggleFollow('side', 'iso')).toBe('follow')
    expect(toggleFollow('follow', 'iso')).toBe('iso')
  })
})

describe('focus checks', () => {
  const el = (tagName: string, extra: Partial<FocusLike> = {}): FocusLike => ({ tagName, ...extra })

  it('treats text fields, selects, textareas and editors as typing targets', () => {
    expect(isTypingTarget(el('input', { type: 'text' }))).toBe(true)
    expect(isTypingTarget(el('INPUT', { type: 'number' }))).toBe(true)
    expect(isTypingTarget(el('textarea'))).toBe(true)
    expect(isTypingTarget(el('select'))).toBe(true)
    expect(isTypingTarget(el('div', { isContentEditable: true }))).toBe(true)
    expect(isTypingTarget(el('div', { closest: (s) => (s.includes('.cm-editor') ? {} : null) }))).toBe(true)
  })

  it('lets shortcuts through from range inputs, checkboxes, buttons and the body', () => {
    expect(isTypingTarget(el('input', { type: 'range' }))).toBe(false)
    expect(isTypingTarget(el('input', { type: 'checkbox' }))).toBe(false)
    expect(isTypingTarget(el('button', { closest: () => null }))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('reserves arrow keys for focused sliders and radio groups only', () => {
    expect(isNativeArrowTarget(el('input', { type: 'range' }), 'ArrowLeft')).toBe(true)
    expect(isNativeArrowTarget(el('input', { type: 'range' }), 'KeyA')).toBe(false)
    expect(isNativeArrowTarget(el('button', { closest: (s) => (s.includes('radiogroup') ? {} : null) }), 'ArrowUp')).toBe(true)
    expect(isNativeArrowTarget(el('button', { closest: () => null }), 'ArrowUp')).toBe(false)
  })
})

describe('drive writes per key event', () => {
  const info = { dir: ALL_DIRS, turn: ['ccw', 'none', 'cw'] }

  it('leaves a latched pad direction alone when only a turn key changes', () => {
    // Arrange: the pad is latched on forward, no movement keys are held
    const current = { dir: 'f', turn: 'none' }
    // Act: Q goes down
    const writes = driveWrites(held('KeyQ'), info, current, axesOf(['KeyQ']))
    // Assert
    expect(writes).toEqual([{ key: 'turn', value: 'ccw' }])
  })

  it('leaves a turn alone when only a movement key changes', () => {
    const current = { dir: 'stop', turn: 'cw' }
    expect(driveWrites(held('KeyW'), info, current, axesOf(['KeyW']))).toEqual([{ key: 'dir', value: 'f' }])
  })

  it('returns to stop / none on release and skips writes that change nothing', () => {
    expect(driveWrites(held(), info, { dir: 'f', turn: 'none' }, axesOf(['KeyW']))).toEqual([{ key: 'dir', value: 'stop' }])
    expect(driveWrites(held('KeyW'), info, { dir: 'f' }, axesOf(['KeyW']))).toEqual([])
  })

  it('releases both axes when a blur drops movement and turn keys together', () => {
    const axes = axesOf(held('KeyW', 'KeyE'))
    expect(axes).toEqual({ dir: true, turn: true })
    expect(driveWrites(held(), info, { dir: 'f', turn: 'cw' }, axes)).toEqual([
      { key: 'dir', value: 'stop' },
      { key: 'turn', value: 'none' },
    ])
  })

  it('writes nothing for a module without a pad or turn control', () => {
    expect(driveWrites(held('KeyW', 'KeyQ'), { dir: null, turn: null }, {}, { dir: true, turn: true })).toEqual([])
    expect(axesOf(['Space', 'KeyR'])).toEqual({ dir: false, turn: false })
  })
})
