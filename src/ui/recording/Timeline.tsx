import { useRef, type CSSProperties } from 'react'
import { recorder, useRecorder, RECORD_HZ, RECORD_MAX_SEC } from '../../core/recorder'
import { runtime } from '../../core/runtime'
import { discardRecording, enterReplay, exitReplay } from '../actions'
import { downloadText, pickTextFile } from '../dom'
import { formatClock, formatDuration } from '../layoutMath'
import { useRaf } from '../useRaf'
import { useUi } from '../uiStore'
import { recordingFileName } from './recordingFormat'

/*
 * Replay timeline above the bottom drawer, shown while a recording exists. The scrubber
 * and time label follow the replay cursor on rAF (no 60 Hz React state); dragging the
 * scrubber seeks, entering replay first if needed.
 */
const MAX_IMPORT_BYTES = 64_000_000

export async function importRecording(): Promise<void> {
  try {
    const file = await pickTextFile('.json,application/json', MAX_IMPORT_BYTES)
    if (!file) return
    const res = recorder.importJson(file.text, runtime.module, runtime.t)
    if (res.ok) useUi.getState().notify(`Loaded ${res.frames} frames from ${file.name}.`)
    else useUi.getState().notify(res.error, 'warn')
  } catch (e) {
    useUi.getState().notify(e instanceof Error ? e.message : 'Could not import the recording.', 'warn')
  }
}

function exportCsv(): void {
  const kind = useRecorder.getState().kind ?? runtime.module.kind
  downloadText(recordingFileName(kind, 'csv'), recorder.exportCsv(), 'text/csv')
}

function exportJson(): void {
  const kind = useRecorder.getState().kind ?? runtime.module.kind
  downloadText(recordingFileName(kind, 'json'), recorder.exportJson())
}

export default function Timeline() {
  const st = useRecorder()
  const scrub = useRef<HTMLInputElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  const visible = st.frames > 0 || st.recording

  useRaf(() => {
    if (!visible) return
    const cur = st.replaying ? recorder.cursor() : st.endT
    if (scrub.current && !dragging.current) scrub.current.value = String(cur)
    if (time.current) time.current.textContent = formatClock(cur - st.startT)
    if (scrub.current) {
      const span = st.endT - st.startT
      const f = span > 0 ? (cur - st.startT) / span : 0
      scrub.current.style.setProperty('--fill', `${(Math.min(Math.max(f, 0), 1) * 100).toFixed(2)}%`)
    }
  }, 30)

  if (!visible) return null
  const fillPct = Math.min(st.duration / RECORD_MAX_SEC, 1) * 100
  const canScrub = st.frames > 1 && !st.recording

  const onSeek = (v: number): void => {
    if (!st.replaying) enterReplay()
    recorder.seek(v)
  }

  return (
    <div className={`timeline${st.replaying ? ' replaying' : ''}${st.recording ? ' recording' : ''}`} role="region" aria-label="Recording timeline">
      <div className="tl-state mono">
        <span className="d" aria-hidden="true" />
        {st.recording ? 'REC' : st.replaying ? 'REPLAY' : 'TAKE'}
        <span className="tl-meta">
          {st.frames} f · {formatDuration(st.duration)} · {RECORD_HZ} Hz
        </span>
      </div>

      <div className="tl-transport">
        <button type="button" className="tl-btn" onClick={() => recorder.step(-1)} disabled={!st.replaying} aria-label="Previous frame">
          ⏮
        </button>
        <button
          type="button"
          className={`tl-btn play${st.replayPlaying ? ' on' : ''}`}
          onClick={() => {
            if (!st.replaying) enterReplay()
            recorder.toggleReplayPlaying()
          }}
          disabled={!canScrub}
          aria-label={st.replayPlaying ? 'Pause replay' : 'Play replay'}
        >
          {st.replayPlaying ? '❚❚' : '▶'}
        </button>
        <button type="button" className="tl-btn" onClick={() => recorder.step(1)} disabled={!st.replaying} aria-label="Next frame">
          ⏭
        </button>
      </div>

      <div className="tl-track" style={{ '--buf': `${fillPct.toFixed(1)}%` } as CSSProperties}>
        <input
          ref={scrub}
          type="range"
          min={st.startT}
          max={Math.max(st.endT, st.startT + 1e-3)}
          step={1 / RECORD_HZ}
          defaultValue={st.startT}
          disabled={!canScrub}
          aria-label="Replay position"
          onPointerDown={() => {
            dragging.current = true
          }}
          onPointerUp={() => {
            dragging.current = false
          }}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
        />
        {st.recording && <span className="tl-buf" aria-hidden="true" />}
      </div>

      <div className="tl-time mono" aria-live="off">
        <span ref={time}>00:00.0</span>
        <span className="of"> / {formatClock(st.duration)}</span>
      </div>

      <div className="tl-actions">
        {st.replaying ? (
          <button type="button" className="tbtn live" onClick={exitReplay}>
            ● BACK TO LIVE
          </button>
        ) : (
          <button type="button" className="tbtn" onClick={enterReplay} disabled={!canScrub}>
            REPLAY
          </button>
        )}
        <button type="button" className="tbtn" onClick={exportCsv} disabled={st.frames === 0 || st.recording} title="Telemetry as CSV">
          CSV
        </button>
        <button type="button" className="tbtn" onClick={exportJson} disabled={st.frames === 0 || st.recording} title="Full recording (re-importable)">
          JSON
        </button>
        <button type="button" className="tbtn" onClick={() => void importRecording()} title="Open a recording (.json)">
          OPEN
        </button>
        <button type="button" className="tbtn icon" onClick={discardRecording} aria-label="Discard recording">
          ×
        </button>
      </div>
      {st.message && (
        <div className="tl-msg" role="alert">
          {st.message}
          <button type="button" onClick={() => recorder.setMessage(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  )
}
