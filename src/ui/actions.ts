import { runtime } from '../core/runtime'
import { recorder } from '../core/recorder'
import { ROBOT_KINDS } from '../robots'
import { useConsole, type Quality } from '../store'
import type { RobotKind } from '../core/types'
import { FOLLOW_ID, presetIds } from '../scene/cameraMath'
import { rememberQuality } from '../scene/device'
import { nextCameraPreset, toggleFollow } from './keyboard/keymap'
import { useUi } from './uiStore'

/*
 * Shell actions shared by buttons and keyboard shortcuts, so both paths behave the
 * same (e.g. Space and the PLAY button both drive the replay transport while replaying).
 */

export function selectCamera(id: string): void {
  useConsole.getState().setCameraPreset(id)
  useUi.getState().bumpCamera()
}

export function cycleCamera(): void {
  selectCamera(nextCameraPreset(presetIds(runtime.module.world), useConsole.getState().cameraPreset))
}

export function toggleFollowCamera(): void {
  const def = runtime.module.world.cameraPresets[0]?.id ?? 'iso'
  selectCamera(toggleFollow(useConsole.getState().cameraPreset, def))
}

export function isFollowing(): boolean {
  return useConsole.getState().cameraPreset === FOLLOW_ID
}

export function togglePlay(): void {
  if (recorder.isReplaying()) recorder.toggleReplayPlaying()
  else useConsole.getState().togglePlaying()
}

export function resetSim(): void {
  runtime.reset()
}

export function switchRobot(kind: RobotKind): void {
  if (useConsole.getState().robot === kind && runtime.module.kind === kind) return
  runtime.setRobot(kind)
}

export function switchRobotByIndex(i: number): void {
  const entry = ROBOT_KINDS[i]
  if (entry) switchRobot(entry.kind)
}

export function toggleRecording(): void {
  recorder.toggle(runtime.module)
}

export function enterReplay(): void {
  recorder.enterReplay(runtime.module, runtime.t)
}

export function exitReplay(): void {
  recorder.exitReplay(runtime.module)
}

export function discardRecording(): void {
  recorder.discard(runtime.module)
}

export function setQuality(q: Quality): void {
  useConsole.getState().setQuality(q)
  rememberQuality(q)
}
