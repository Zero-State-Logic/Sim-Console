import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_STORAGE_KEY, captureProfile, type StorageLike } from '../../core/profiles'
import { runtime } from '../../core/runtime'
import { useHardware } from '../../core/hardware'
import { useConsole } from '../../store'
import { useProfiles } from './profileStore'

/* The profiles store against working, and failing, browser storage (stubbed). */

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

beforeEach(() => {
  runtime.setRobot('walker')
  useProfiles.setState({ list: [], message: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('profiles store', () => {
  it('saves to storage and refresh picks up profiles written by another tab', () => {
    // Arrange
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    useProfiles.getState().save('mine')
    const other = captureProfile('from another tab', runtime.module, useHardware.getState().config)
    const stored = JSON.parse(storage.data.get(PROFILE_STORAGE_KEY) ?? '[]') as unknown[]
    storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify([...stored, other]))
    // Act
    useProfiles.getState().refresh()
    // Assert
    expect(useProfiles.getState().list.map((p) => p.name)).toEqual(['mine', 'from another tab'])
  })

  it('makes the rails re-read the module after a load that only carries module config', () => {
    // Arrange: a profile with no control values, so no runtime.setControl call happens
    vi.stubGlobal('localStorage', memoryStorage())
    const p = { ...captureProfile('config only', runtime.module, useHardware.getState().config), controls: {} }
    const before = useConsole.getState()
    // Act
    useProfiles.getState().load(p)
    // Assert: loadConfig bypasses setControl, so the shell must bump the revisions itself
    const after = useConsole.getState()
    expect(after.controlRev).toBeGreaterThan(before.controlRev)
    expect(after.layoutRev).toBeGreaterThan(before.layoutRev)
    expect(useProfiles.getState().message?.tone).toBe('info')
  })

  it('keeps in-memory profiles on refresh when storage writes fail', () => {
    // Arrange: reads work but every write throws (quota / blocked storage)
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    useProfiles.getState().save('only in memory')
    expect(useProfiles.getState().message?.tone).toBe('warn')
    // Act: reopening the dialog refreshes the list
    useProfiles.getState().refresh()
    // Assert
    expect(useProfiles.getState().list.map((p) => p.name)).toEqual(['only in memory'])
  })
})
