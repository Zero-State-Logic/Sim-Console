import { create } from 'zustand'
import type { DriveSource, RobotKind } from './core/types'

export type { DriveSource } from './core/types'
export type Quality = 'high' | 'low'

/*
 * UI-facing console state. Anything that must fire side effects (switching robot,
 * switching drive source, setting a control) goes through `runtime` in
 * src/core/runtime.ts, which then writes here. Components only read.
 */
interface ConsoleState {
  robot: RobotKind
  driveSource: DriveSource
  playing: boolean
  /** Sim speed multiplier (0.25 – 2). */
  timeScale: number
  drawerOpen: boolean
  quality: Quality
  /** Active camera preset id ('follow' is always available). */
  cameraPreset: string
  /** Bumped when control values change; control UI re-reads module values. */
  controlRev: number
  /** Bumped when the control schema or instrument layout changes shape. */
  layoutRev: number

  setPlaying: (b: boolean) => void
  togglePlaying: () => void
  setTimeScale: (s: number) => void
  setDrawerOpen: (b: boolean) => void
  setQuality: (q: Quality) => void
  setCameraPreset: (id: string) => void
}

export const useConsole = create<ConsoleState>((set) => ({
  robot: 'walker',
  driveSource: 'sim',
  playing: true,
  timeScale: 1,
  drawerOpen: false,
  quality: 'high',
  cameraPreset: 'iso',
  controlRev: 0,
  layoutRev: 0,

  setPlaying: (b) => set({ playing: b }),
  togglePlaying: () => set((st) => ({ playing: !st.playing })),
  setTimeScale: (s) => set({ timeScale: Math.min(Math.max(s, 0.25), 2) }),
  setDrawerOpen: (b) => set({ drawerOpen: b }),
  setQuality: (q) => set({ quality: q }),
  setCameraPreset: (id) => set({ cameraPreset: id }),
}))
