import { useEffect } from 'react'
import { runtime } from '../../core/runtime'
import { recorder } from '../../core/recorder'
import { cycleCamera, resetSim, switchRobotByIndex, toggleFollowCamera, togglePlay } from '../actions'
import { useUi } from '../uiStore'
import {
  axesOf,
  driveKeyInfo,
  driveWrites,
  isDirKey,
  isNativeArrowTarget,
  isTurnKey,
  isTypingTarget,
  shortcutFor,
  type DriveAxes,
  type ShortcutAction,
} from './keymap'

/*
 * Global shortcuts and keyboard driving. Space play/pause, R reset, 1/2/3 robot, F
 * follow, C cycle camera, ? help. WASD / arrows drive a 'dir' pad, Q/E a 'turn' select,
 * releasing back to stop / none. Keys typed into fields, editors and open dialogs are
 * left alone.
 */

function run(action: ShortcutAction): void {
  switch (action.type) {
    case 'togglePlay':
      togglePlay()
      break
    case 'reset':
      resetSim()
      break
    case 'robot':
      switchRobotByIndex(action.index)
      break
    case 'follow':
      toggleFollowCamera()
      break
    case 'cycleCamera':
      cycleCamera()
      break
    case 'help':
      useUi.getState().setHelpOpen(true)
      break
  }
}

/** Write drive values from the held keys for the axes a key event touched. */
function applyDrive(held: ReadonlySet<string>, axes: DriveAxes): void {
  if (recorder.isReplaying()) return
  const m = runtime.module
  for (const w of driveWrites(held, driveKeyInfo(m.getControlSchema()), m.getControlValues(), axes)) runtime.setControl(w.key, w.value)
}

function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null
}

/** A focused button reached by keyboard keeps its native Space/Enter activation. */
function keyboardFocusedControl(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  if (!el.matches('button, [role="button"], [role="switch"], [role="radio"], a[href], summary')) return false
  try {
    return el.matches(':focus-visible')
  } catch {
    return false
  }
}

export function useKeyboard(): void {
  useEffect(() => {
    const held = new Set<string>()
    let spaceHandled = false

    const onKeyDown = (e: KeyboardEvent): void => {
      const el = document.activeElement instanceof HTMLElement ? document.activeElement : null
      if (isTypingTarget(el) || modalOpen()) return
      if (e.code === 'Escape') {
        useUi.getState().closeRails()
        return
      }
      if (isDirKey(e.code) || isTurnKey(e.code)) {
        if (e.ctrlKey || e.metaKey || e.altKey || isNativeArrowTarget(el, e.code)) return
        e.preventDefault()
        if (!held.has(e.code)) {
          held.add(e.code)
          applyDrive(held, axesOf([e.code]))
        }
        return
      }
      const action = shortcutFor(e.code, e)
      if (!action) return
      if (action.type === 'togglePlay' && keyboardFocusedControl(el)) return
      e.preventDefault()
      if (action.type === 'togglePlay') spaceHandled = true
      if (e.repeat) return
      run(action)
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && spaceHandled) {
        // stop a mouse-focused button from also "clicking" on keyup
        e.preventDefault()
        spaceHandled = false
      }
      if (held.delete(e.code)) applyDrive(held, axesOf([e.code]))
    }

    const releaseAll = (): void => {
      if (held.size === 0) return
      const axes = axesOf(held)
      held.clear()
      applyDrive(held, axes)
    }
    const onVisibility = (): void => {
      if (document.hidden) releaseAll()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', releaseAll)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', releaseAll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
