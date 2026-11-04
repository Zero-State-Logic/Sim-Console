import { create } from 'zustand'
import { useConsole } from '../store'
import { RingBuffer, advanceSampleGrid, indexAtOrBefore, shouldSample } from '../ui/recording/ringBuffer'
import {
  buildCsv,
  buildRecordingFile,
  cloneSnapshot,
  cloneTelemetry,
  parseRecording,
  serializeRecording,
  type RecordingFrame,
} from '../ui/recording/recordingFormat'
import type { RobotKind, RobotModule, TelemetryFrame } from './types'

/*
 * Record & replay. REC samples {t, module.snapshot(), telemetry} at 30 Hz into a 120 s
 * ring buffer. Replay pauses the live sim (the runtime skips update while
 * isReplaying()), restores the module at the cursor and feeds the recorded telemetry to
 * the bus, so every instrument shows the past exactly as it was. Exiting replay restores
 * the live state captured on entry.
 */
export interface RecorderApi {
  /** True while the timeline is scrubbing a recording; the runtime then skips the sim. */
  isReplaying(): boolean
  /** Called every simulated frame. Cheap no-op when not recording. */
  capture(t: number, module: RobotModule, tel: TelemetryFrame): void
  /** Restore the module to the current replay cursor and return the telemetry to show. */
  applyReplayFrame(module: RobotModule): TelemetryFrame | null
  /** Drop everything (called on robot switch / reset). */
  clear(): void
}

export const RECORD_HZ = 30
export const RECORD_MAX_SEC = 120
export const RECORD_CAPACITY = RECORD_HZ * RECORD_MAX_SEC
/** Store pushes are throttled so React sees ~5 updates/s, never 60. */
const UI_PUSH_MS = 200
/** Longest real-time gap a replay step will advance by (tab switch). */
const MAX_REPLAY_STEP_S = 0.1

export interface RecorderUiState {
  recording: boolean
  replaying: boolean
  replayPlaying: boolean
  frames: number
  /** Seconds covered by the buffer (last.t - first.t). */
  duration: number
  startT: number
  endT: number
  /** Replay cursor, absolute sim seconds. */
  cursor: number
  kind: RobotKind | null
  /** Last import/export problem, shown by the timeline. */
  message: string | null
}

const INITIAL_UI: RecorderUiState = {
  recording: false,
  replaying: false,
  replayPlaying: false,
  frames: 0,
  duration: 0,
  startT: 0,
  endT: 0,
  cursor: 0,
  kind: null,
  message: null,
}

export const useRecorder = create<RecorderUiState>(() => ({ ...INITIAL_UI }))

export type ImportResult = { ok: true; frames: number } | { ok: false; error: string }

const frameTime = (f: RecordingFrame): number => f.t

export class Recorder implements RecorderApi {
  private buf = new RingBuffer<RecordingFrame>(RECORD_CAPACITY)
  private recording = false
  private replaying = false
  private replayPlaying = false
  private cursorT = 0
  /** Sampling grid point of the last sample (30 Hz grid, see advanceSampleGrid). */
  private lastSampleT = Number.NEGATIVE_INFINITY
  private appliedIndex = -1
  private liveSnap: unknown = null
  private hasLiveSnap = false
  private liveT = 0
  private wasPlaying = true
  private lastNow = 0
  private lastUiPush = Number.NEGATIVE_INFINITY
  private kind: RobotKind | null = null
  private label = ''

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly period = 1 / RECORD_HZ,
  ) {}

  /* ---------------- RecorderApi (runtime) ---------------- */

  isReplaying(): boolean {
    return this.replaying
  }

  capture(t: number, module: RobotModule, tel: TelemetryFrame): void {
    if (!this.recording || this.replaying) return
    if (module.kind !== this.kind) {
      // robot switched while recording: the old frames can't restore the new module
      this.buf.clear()
      this.kind = module.kind
      this.label = module.label
      this.lastSampleT = Number.NEGATIVE_INFINITY
    }
    const last = this.buf.last()
    if (last && t < last.t) {
      // sim clock went backwards (reset): keep recording from the new origin
      this.buf.clear()
    }
    if (!shouldSample(t, this.lastSampleT, this.period)) return
    this.lastSampleT = advanceSampleGrid(t, this.lastSampleT, this.period)
    this.buf.push({ t, snap: cloneSnapshot(module.snapshot()), tel: cloneTelemetry(tel, t) })
    this.pushUi(false)
  }

  applyReplayFrame(module: RobotModule): TelemetryFrame | null {
    const now = this.now()
    const dtReal = Math.min(Math.max((now - this.lastNow) / 1000, 0), MAX_REPLAY_STEP_S)
    this.lastNow = now
    const n = this.buf.size
    if (n === 0) return null
    const first = this.buf.first() as RecordingFrame
    const last = this.buf.last() as RecordingFrame
    if (this.replayPlaying) {
      this.cursorT += dtReal * useConsole.getState().timeScale
      if (this.cursorT >= last.t) {
        this.cursorT = last.t
        this.replayPlaying = false
        this.pushUi(true)
      }
    }
    this.cursorT = Math.min(Math.max(this.cursorT, first.t), last.t)
    const i = indexAtOrBefore(this.buf, this.cursorT, frameTime)
    const frame = this.buf.get(i) as RecordingFrame
    if (i !== this.appliedIndex) {
      this.restoreInto(module, frame.snap, frame.t)
      this.appliedIndex = i
    }
    this.pushUi(false)
    return frame.tel
  }

  clear(): void {
    this.buf.clear()
    if (this.replaying) useConsole.getState().setPlaying(this.wasPlaying)
    this.replaying = false
    this.replayPlaying = false
    this.appliedIndex = -1
    this.hasLiveSnap = false
    this.liveSnap = null
    this.lastSampleT = Number.NEGATIVE_INFINITY
    this.pushUi(true)
  }

  /* ---------------- recording ---------------- */

  get size(): number {
    return this.buf.size
  }

  isRecording(): boolean {
    return this.recording
  }

  /** Start a fresh recording (drops the previous one). */
  start(module: RobotModule): void {
    if (this.replaying) this.exitReplay(module)
    this.buf.clear()
    this.kind = module.kind
    this.label = module.label
    this.recording = true
    this.lastSampleT = Number.NEGATIVE_INFINITY
    this.setMessage(null)
    this.pushUi(true)
  }

  stop(): void {
    this.recording = false
    this.pushUi(true)
  }

  toggle(module: RobotModule): void {
    if (this.recording) this.stop()
    else this.start(module)
  }

  /** Drop the recording and leave replay (restoring live state first). */
  discard(module: RobotModule): void {
    if (this.replaying) this.exitReplay(module)
    this.recording = false
    this.clear()
  }

  /** Oldest-first frames (a copy). */
  frames(): RecordingFrame[] {
    return this.buf.toArray()
  }

  frameAt(i: number): RecordingFrame | undefined {
    return this.buf.get(i)
  }

  /** Index of the frame shown at sim time t (-1 when empty). */
  indexAt(t: number): number {
    return indexAtOrBefore(this.buf, t, frameTime)
  }

  /* ---------------- replay ---------------- */

  cursor(): number {
    return this.cursorT
  }

  isReplayPlaying(): boolean {
    return this.replayPlaying
  }

  /** `liveT` is the live sim clock, handed back to the module on exit. */
  enterReplay(module: RobotModule, liveT = 0): boolean {
    if (this.replaying || this.buf.size === 0) return this.replaying
    this.recording = false
    this.liveSnap = cloneSnapshot(module.snapshot())
    this.hasLiveSnap = true
    this.liveT = liveT
    const st = useConsole.getState()
    this.wasPlaying = st.playing
    st.setPlaying(false)
    this.replaying = true
    this.replayPlaying = false
    this.appliedIndex = -1
    this.cursorT = (this.buf.first() as RecordingFrame).t
    this.lastNow = this.now()
    this.pushUi(true)
    return true
  }

  exitReplay(module: RobotModule): void {
    if (!this.replaying) return
    this.replaying = false
    this.replayPlaying = false
    this.appliedIndex = -1
    if (this.hasLiveSnap) this.restoreInto(module, this.liveSnap, this.liveT)
    this.hasLiveSnap = false
    this.liveSnap = null
    useConsole.getState().setPlaying(this.wasPlaying)
    this.pushUi(true)
  }

  setReplayPlaying(b: boolean): void {
    if (!this.replaying) return
    const last = this.buf.last()
    // pressing play at the end rewinds, like any transport
    if (b && last && this.cursorT >= last.t) this.cursorT = (this.buf.first() as RecordingFrame).t
    this.replayPlaying = b
    this.lastNow = this.now()
    this.pushUi(true)
  }

  toggleReplayPlaying(): void {
    this.setReplayPlaying(!this.replayPlaying)
  }

  /** Move the cursor to sim time t (clamped to the recording). */
  seek(t: number): void {
    const first = this.buf.first()
    const last = this.buf.last()
    if (!first || !last || !Number.isFinite(t)) return
    this.cursorT = Math.min(Math.max(t, first.t), last.t)
    this.pushUi(true)
  }

  /** Step the cursor by whole frames (negative = back). */
  step(frames: number): void {
    if (this.buf.size === 0) return
    const i = Math.min(Math.max(this.indexAt(this.cursorT) + Math.trunc(frames), 0), this.buf.size - 1)
    this.replayPlaying = false
    this.seek((this.buf.get(i) as RecordingFrame).t)
  }

  /* ---------------- import / export ---------------- */

  exportCsv(): string {
    return buildCsv(this.buf.toArray())
  }

  exportJson(now: Date = new Date()): string {
    const kind = this.kind ?? 'walker'
    return serializeRecording(buildRecordingFile(kind, this.label || kind.toUpperCase(), RECORD_HZ, this.buf.toArray(), now))
  }

  /** Load a JSON recording for the active module and open it in replay. */
  importJson(text: string, module: RobotModule, liveT = 0): ImportResult {
    const parsed = parseRecording(text, module.kind, RECORD_CAPACITY)
    if (!parsed.ok) {
      this.setMessage(parsed.error)
      return parsed
    }
    if (this.replaying) this.exitReplay(module)
    this.recording = false
    this.buf.load(parsed.value.frames)
    this.kind = parsed.value.kind
    this.label = parsed.value.label
    this.setMessage(null)
    this.enterReplay(module, liveT)
    return { ok: true, frames: this.buf.size }
  }

  setMessage(message: string | null): void {
    useRecorder.setState({ message })
  }

  /* ---------------- internals ---------------- */

  private restoreInto(module: RobotModule, snap: unknown, t: number): void {
    module.restore(cloneSnapshot(snap))
    // a dt=0 update re-poses the scene graph from the restored state (same call the
    // runtime makes every frame while paused)
    module.update(0, { source: 'sim', t })
  }

  private pushUi(force: boolean): void {
    const now = this.now()
    if (!force && now - this.lastUiPush < UI_PUSH_MS) return
    this.lastUiPush = now
    const first = this.buf.first()
    const last = this.buf.last()
    useRecorder.setState({
      recording: this.recording,
      replaying: this.replaying,
      replayPlaying: this.replayPlaying,
      frames: this.buf.size,
      startT: first?.t ?? 0,
      endT: last?.t ?? 0,
      duration: first && last ? last.t - first.t : 0,
      cursor: this.cursorT,
      kind: this.buf.size > 0 || this.recording ? this.kind : null,
    })
  }
}

export const recorder = new Recorder()
