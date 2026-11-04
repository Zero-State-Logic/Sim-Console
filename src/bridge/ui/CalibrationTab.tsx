import { useHardware } from '../../core/hardware'
import type { JointCalibration } from '../calib/fit'
import { hardwareBridge } from '../index'
import { useBridge, type CalibUi } from '../store'
import { useTicker } from './hooks'

/*
 * CALIBRATION: record commanded q vs measured ang while LIVE (or run a step sweep with
 * the robot on a stand), fit measured = a·commanded + b per joint, show residuals and
 * the link latency from cross-correlation, then APPLY to the hardware profile.
 */

function f(x: number, d: number): string {
  return Number.isFinite(x) ? x.toFixed(d) : '—'
}

function Workflow({ ui, blocker }: { ui: CalibUi; blocker: string | null }) {
  const live = blocker === null
  const hasData = ui.telSamples > 0
  return (
    <div className="hw-calflow">
      <div className="hw-row">
        {ui.recording && !ui.sweeping ? (
          <button type="button" className="hw-btn rec on" onClick={() => hardwareBridge.calibStop()}>
            STOP
          </button>
        ) : (
          <button type="button" className="hw-btn rec" disabled={!live || ui.sweeping} onClick={() => hardwareBridge.calibRecord()} title="Record while you drive the robot">
            RECORD
          </button>
        )}
        {ui.sweeping ? (
          <button type="button" className="hw-btn on" onClick={() => hardwareBridge.calibStopSweep()}>
            STOP SWEEP
          </button>
        ) : (
          <button
            type="button"
            className="hw-btn"
            disabled={!live || ui.recording}
            onClick={() => hardwareBridge.calibSweep()}
            title="Steps every joint ±15° around home and holds each level. Put the robot on a stand first."
          >
            STEP SWEEP
          </button>
        )}
        <button type="button" className="hw-btn" disabled={!hasData || ui.sweeping} onClick={() => hardwareBridge.calibFit()}>
          FIT
        </button>
        <button type="button" className="hw-btn primary" disabled={!ui.result?.ok} onClick={() => hardwareBridge.calibApply()}>
          APPLY
        </button>
        <button type="button" className="hw-btn danger" onClick={() => hardwareBridge.calibReset()} title="Scale 1, offset 0 on every joint">
          RESET CALIBRATION
        </button>
      </div>
      {blocker && <p className="hw-note warn">{blocker}</p>}
      {ui.sweeping && (
        <div className="hw-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ui.sweepProgress * 100)}>
          <div style={{ transform: `scaleX(${ui.sweepProgress})` }} />
        </div>
      )}
      <p className="hw-calstat mono">
        {ui.recording ? '● REC ' : ''}
        {ui.cmdSamples} cmd · {ui.telSamples} measured · {ui.durationSec.toFixed(1)} s{ui.full ? ' · buffer full' : ''}
      </p>
      {ui.message && <p className="hw-hint">{ui.message}</p>}
      <p className="hw-hint">
        The fit turns measured = a·commanded + b into the profile's joint scale and offset, so the corrected servo angle cancels the error. The
        virtual device picks it up at once; a real board needs GENERATE FIRMWARE and a re-flash. Settled (held) samples are used when there are enough:
        moving samples read the gain low because the servo lags.
      </p>
    </div>
  )
}

function JointRow({ j, scale, offset }: { j: JointCalibration; scale: number; offset: number }) {
  const fit = j.fit
  return (
    <tr className={j.suspect ? 'suspect' : undefined}>
      <th scope="row">{j.name}</th>
      <td className="str">{j.source === 'none' ? '—' : j.source.toUpperCase()}</td>
      <td>{fit ? f(fit.a, 4) : '—'}</td>
      <td>{fit ? f(fit.b, 2) : '—'}</td>
      <td>{fit ? f(fit.rmsRaw, 2) : '—'}</td>
      <td className="good">{fit ? f(fit.rms, 2) : '—'}</td>
      <td>
        {f(scale, 4)} → <b>{f(j.scale, 4)}</b>
      </td>
      <td>
        {f(offset, 2)} → <b>{f(j.offset, 2)}</b>
      </td>
      <td className="str">{j.suspect ? (fit ? 'CHECK WIRING / INVERT' : 'NO DATA') : fit && !fit.excited ? 'OFFSET ONLY' : 'OK'}</td>
    </tr>
  )
}

function Results({ ui }: { ui: CalibUi }) {
  const cfg = useHardware((s) => s.config)
  const r = ui.result
  if (!r) return <p className="hw-hint">No fit yet. RECORD (or STEP SWEEP), then FIT.</p>
  if (!r.ok) return <p className="hw-note bad">{r.reason}</p>
  const lat = Number.isFinite(r.latency.score) ? `${r.latency.lagMs.toFixed(0)} ms (correlation ${r.latency.score.toFixed(3)})` : 'not measurable (nothing moved)'
  return (
    <div className="hw-calres">
      <p className="hw-calstat mono">
        LATENCY cmd → measured: <b>{lat}</b> · {r.pairs} pairs
      </p>
      <table className="hw-table">
        <thead>
          <tr>
            <th scope="col">JOINT</th>
            <th scope="col">DATA</th>
            <th scope="col">GAIN a</th>
            <th scope="col">BIAS b °</th>
            <th scope="col">RMS raw °</th>
            <th scope="col">RMS fit °</th>
            <th scope="col">SCALE</th>
            <th scope="col">OFFSET °</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {r.joints.map((j) => (
            <JointRow key={j.index} j={j} scale={cfg.jointScale[j.index] ?? 1} offset={cfg.jointOffsetDeg[j.index] ?? 0} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CalibrationTab() {
  // the blocker depends on link state and level; the ticker keeps it and the progress fresh
  useTicker(250)
  const ui = useBridge((s) => s.calib)
  useBridge((s) => s.state)
  useBridge((s) => s.level)
  const blocker = hardwareBridge.calibBlocker()
  return (
    <div className="hw-cal">
      <Workflow ui={ui} blocker={blocker} />
      <Results ui={ui} />
    </div>
  )
}
