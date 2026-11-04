import { create } from 'zustand'
import { runtime } from '../../core/runtime'
import { recorder } from '../../core/recorder'
import { useHardware } from '../../core/hardware'
import { useConsole } from '../../store'
import {
  applyControlValues,
  applyProfile,
  captureProfile,
  parseProfileFile,
  profileFileName,
  readProfiles,
  removeProfile,
  serializeProfile,
  upsertProfile,
  writeProfiles,
  type ProfileTarget,
  type RobotProfile,
} from '../../core/profiles'
import { downloadText, pickTextFile } from '../dom'
import type { BuiltinPreset } from './presets'

/* Profiles UI state, wired to the runtime. The validation and apply logic is pure (core/profiles.ts). */

const MAX_IMPORT_BYTES = 2_000_000

export interface ProfileMessage {
  text: string
  tone: 'info' | 'warn'
}

interface ProfilesState {
  list: RobotProfile[]
  message: ProfileMessage | null
  refresh: () => void
  save: (name: string) => void
  load: (p: RobotProfile) => void
  loadPreset: (p: BuiltinPreset) => void
  remove: (p: RobotProfile) => void
  exportOne: (p: RobotProfile) => void
  exportAll: (list: RobotProfile[]) => void
  importFile: () => Promise<void>
  clearMessage: () => void
}

const target: ProfileTarget = {
  currentKind: () => runtime.module.kind,
  setRobot: (kind) => runtime.setRobot(kind),
  module: () => runtime.module,
  setControl: (key, value) => runtime.setControl(key, value),
  setHardware: (cfg) => useHardware.getState().setConfig(cfg),
}

/**
 * False once a write failed (private mode, quota, blocked storage). From then on the
 * in-memory list is the only copy, so refresh must not replace it with what storage holds.
 */
let storageInSync = true

function persist(list: RobotProfile[]): ProfileMessage | null {
  storageInSync = writeProfiles(list)
  return storageInSync ? null : { text: 'Browser storage is unavailable: profiles last until the tab closes. Export them to keep them.', tone: 'warn' }
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  list: readProfiles(),
  message: null,

  // picks up saves from other tabs, but never drops profiles that only live in memory
  refresh: () => {
    if (storageInSync) set({ list: readProfiles() })
  },

  save: (name) => {
    const p = captureProfile(name, runtime.module, useHardware.getState().config)
    const list = upsertProfile(get().list, p)
    set({ list, message: persist(list) ?? { text: `Saved “${p.name}”.`, tone: 'info' } })
  },

  load: (p) => {
    if (recorder.isReplaying()) recorder.exitReplay(runtime.module)
    const report = applyProfile(p, target)
    // loadConfig() can change control values and the schema without going through
    // runtime.setControl, so the rails must re-read the module (charts keep their history)
    useConsole.setState((st) => ({ controlRev: st.controlRev + 1, layoutRev: st.layoutRev + 1 }))
    const parts = [`Loaded “${p.name}”: ${report.applied.length} control${report.applied.length === 1 ? '' : 's'} applied.`]
    if (report.rejected.length) parts.push(`Skipped ${report.rejected.join(', ')} (not valid for this robot now).`)
    if (report.configError) parts.push(`Module config rejected: ${report.configError}`)
    set({ message: { text: parts.join(' '), tone: report.rejected.length || report.configError ? 'warn' : 'info' } })
  },

  loadPreset: (p) => {
    if (recorder.isReplaying()) recorder.exitReplay(runtime.module)
    // a fresh module is the factory state; the preset's values go on top, validated
    runtime.setRobot(p.kind)
    const report = applyControlValues(p.controls, target)
    const skipped = report.rejected.length ? ` Skipped ${report.rejected.join(', ')} (not offered by this robot).` : ''
    set({ message: { text: `Preset ${p.name} loaded.${skipped}`, tone: report.rejected.length ? 'warn' : 'info' } })
  },

  remove: (p) => {
    const list = removeProfile(get().list, p.kind, p.name)
    set({ list, message: persist(list) ?? { text: `Deleted “${p.name}”.`, tone: 'info' } })
  },

  exportOne: (p) => downloadText(profileFileName(p), serializeProfile(p)),

  exportAll: (list) => {
    if (list.length === 0) return
    downloadText('simconsole-profiles.json', JSON.stringify({ profiles: list }, null, 2))
  },

  importFile: async () => {
    try {
      const file = await pickTextFile('.json,application/json', MAX_IMPORT_BYTES)
      if (!file) return
      const res = parseProfileFile(file.text)
      if (!res.ok) {
        set({ message: { text: `Import failed: ${res.error}`, tone: 'warn' } })
        return
      }
      let list = get().list
      for (const p of res.value) list = upsertProfile(list, p)
      const n = res.value.length
      set({ list, message: persist(list) ?? { text: `Imported ${n} profile${n === 1 ? '' : 's'} from ${file.name}.`, tone: 'info' } })
    } catch (e) {
      set({ message: { text: e instanceof Error ? e.message : 'Import failed.', tone: 'warn' } })
    }
  },

  clearMessage: () => set({ message: null }),
}))
