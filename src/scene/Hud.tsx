import { useEffect, useMemo, useRef } from 'react'
import { telemetryBus } from '../core/telemetryBus'
import { useRecorder, recorder } from '../core/recorder'
import { runtime } from '../core/runtime'
import { useConsole } from '../store'
import type { ReadoutDef, RobotModule } from '../core/types'
import { useRaf } from '../ui/useRaf'
import { useUi } from '../ui/uiStore'
import { formatClock } from '../ui/layoutMath'
import { formatControlValue } from '../ui/controls/controlMath'
import { frameStats } from './frameStats'
import { pickHudReadouts } from './hudReadouts'

/*
 * Viewport overlays: registration frame, module label + live readouts (top-left),
 * speed / FPS (bottom-left), REC / REPLAY badge (bottom-right) and transient notices.
 * Values are written straight to the DOM on a throttled rAF.
 */
const NOTICE_MS = 4500
const SOURCE_LABEL = { sim: 'SIM', hardware: 'HARDWARE', code: 'CODE' } as const

function formatReadout(d: ReadoutDef, v: number | string | undefined): string {
  if (typeof v === 'number') return formatControlValue(v, d.digits ?? 1)
  return v ?? '—'
}

function Readouts({ module }: { module: RobotModule }) {
  const layoutRev = useConsole((s) => s.layoutRev)
  const defs = useMemo(() => pickHudReadouts(module.getInstrumentLayout().readouts), [module, layoutRev])
  const cells = useRef<(HTMLElement | null)[]>([])
  useRaf(() => {
    const r = telemetryBus.current.readouts
    for (let i = 0; i < defs.length; i++) {
      const el = cells.current[i]
      if (el) el.textContent = formatReadout(defs[i], r[defs[i].key])
    }
  }, 15)
  if (defs.length === 0) return null
  return (
    <div className="hud-readouts">
      {defs.map((d, i) => (
        <span key={d.key} className="hud-ro">
          <span className="k">{d.label}</span>
          <b ref={(el) => { cells.current[i] = el }}>—</b>
          {d.unit && <span className="u">{d.unit}</span>}
        </span>
      ))}
    </div>
  )
}

function Status() {
  const fps = useRef<HTMLSpanElement>(null)
  const speed = useConsole((s) => s.timeScale)
  const quality = useConsole((s) => s.quality)
  const playing = useConsole((s) => s.playing)
  const replaying = useRecorder((s) => s.replaying)
  useRaf(() => {
    if (fps.current) fps.current.textContent = String(Math.round(frameStats.fps))
  }, 4)
  const state = replaying ? 'REPLAY' : playing ? 'RUN' : 'HOLD'
  return (
    <div className="hud-bl mono" aria-hidden="true">
      <span className={playing && !replaying ? 'run' : 'held'}>{state}</span>
      <span>SPEED <b>{speed.toFixed(2)}×</b></span>
      <span><b ref={fps}>0</b> FPS</span>
      <span>{quality === 'high' ? 'HQ' : 'LQ'}</span>
    </div>
  )
}

function RecBadge() {
  const recording = useRecorder((s) => s.recording)
  const replaying = useRecorder((s) => s.replaying)
  const label = useRef<HTMLSpanElement>(null)
  useRaf(() => {
    if (!label.current) return
    label.current.textContent = formatClock(replaying ? recorder.cursor() : runtime.t)
  }, 10)
  if (!recording && !replaying) return null
  return (
    <div className={`hud-br mono ${replaying ? 'replay' : 'rec'}`} role="status">
      <span className="d" aria-hidden="true" />
      {replaying ? 'REPLAY' : 'REC'} <span ref={label}>00:00.0</span>
    </div>
  )
}

function Notice() {
  const notice = useUi((s) => s.notice)
  const clear = useUi((s) => s.clearNotice)
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(clear, NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice, clear])
  if (!notice) return null
  return (
    <div className={`hud-notice ${notice.tone}`} role="status" aria-live="polite">
      {notice.text}
      <button type="button" onClick={clear} aria-label="Dismiss notice">×</button>
    </div>
  )
}

export default function Hud({ module }: { module: RobotModule }) {
  const source = useConsole((s) => s.driveSource)
  const layoutRev = useConsole((s) => s.layoutRev)
  const subtitle = useMemo(() => module.getInstrumentLayout().subtitle, [module, layoutRev])

  return (
    <div className="hud" aria-label="Viewport overlay">
      <span className="hud-corner tl" aria-hidden="true" />
      <span className="hud-corner tr" aria-hidden="true" />
      <span className="hud-corner bl" aria-hidden="true" />
      <span className="hud-corner br" aria-hidden="true" />
      <div className="hud-tl">
        <div className="hud-title">
          <span className={`hud-src ${source}`}>{SOURCE_LABEL[source]}</span>
          <span className="hud-name">{module.label}</span>
          {subtitle && <span className="hud-sub mono">{subtitle}</span>}
        </div>
        <Readouts module={module} />
      </div>
      <Status />
      <RecBadge />
      <Notice />
    </div>
  )
}
