import { useState, type ChangeEvent } from 'react'
import { sandbox } from '..'
import { DIALECTS } from '../protocol'
import { isActive, useSandbox } from '../store'
import { DIALECT_LABEL, statCells, statusDetail, statusView } from './labels'

/*
 * Right-rail panel while the drive source is CODE: program status, language,
 * RUN / PAUSE / STEP / RESET / STOP, example picker, run stats and the LED_BUILTIN light.
 */

function StatusPill() {
  const state = useSandbox((s) => s.state)
  const wakeAtMs = useSandbox((s) => s.wakeAtMs)
  const dirty = useSandbox((s) => s.dirty)
  const dialect = useSandbox((s) => s.dialect)
  const kind = useSandbox((s) => s.kind)
  const v = statusView(state)
  return (
    <div className={`status code sbx-status tone-${v.tone}`} role="status" aria-live="polite">
      <span className="d" aria-hidden="true" />
      <div>
        {v.label}
        <div className="sub">
          {DIALECT_LABEL[dialect].toLowerCase()} · {kind} · {statusDetail(state, wakeAtMs, dirty)}
        </div>
      </div>
    </div>
  )
}

function DialectSwitch() {
  const dialect = useSandbox((s) => s.dialect)
  return (
    <div className="sbx-seg" role="group" aria-label="Language">
      {DIALECTS.map((d) => (
        <button key={d} type="button" className={d === dialect ? 'on' : ''} aria-pressed={d === dialect} onClick={() => sandbox.setDialect(d)}>
          {DIALECT_LABEL[d]}
        </button>
      ))}
    </div>
  )
}

function Transport() {
  const state = useSandbox((s) => s.state)
  const dirty = useSandbox((s) => s.dirty)
  const active = isActive(state)
  const running = state === 'running' || state === 'sleeping'
  const busy = state === 'compiling'
  const runLabel = active && dirty ? 'RELOAD' : state === 'paused' ? 'RESUME' : 'RUN'
  return (
    <div className="sbx-transport" role="group" aria-label="Program control">
      <button type="button" className={`sbx-btn run${running ? ' on' : ''}`} disabled={busy || (running && !dirty)} onClick={() => sandbox.run()} title="Compile and run (Ctrl+Enter)">
        <span className="ic" aria-hidden="true">▶</span>
        {runLabel}
      </button>
      <button type="button" className={`sbx-btn${state === 'paused' ? ' on' : ''}`} disabled={!running} onClick={() => sandbox.pause()} title="Pause the program (the robot keeps its last commands)">
        <span className="ic" aria-hidden="true">❚❚</span>
        PAUSE
      </button>
      <button type="button" className="sbx-btn" disabled={busy} onClick={() => sandbox.step()} title="Pause and run one frame (Ctrl+Shift+Enter)">
        <span className="ic" aria-hidden="true">▶❘</span>
        STEP
      </button>
      <button type="button" className="sbx-btn" disabled={!active} onClick={() => sandbox.reset()} title="Start over from setup()">
        <span className="ic" aria-hidden="true">↺</span>
        RESET
      </button>
      <button type="button" className="sbx-btn stop" disabled={!active && !busy} onClick={() => sandbox.stop()} title="Stop and hand the robot back to the sim">
        <span className="ic" aria-hidden="true">■</span>
        STOP
      </button>
    </div>
  )
}

function ExamplePicker() {
  const examples = useSandbox((s) => s.examples)
  const dialect = useSandbox((s) => s.dialect)
  const prev = useSandbox((s) => s.prevSource)
  const [picked, setPicked] = useState('')
  const list = examples.filter((e) => e.dialects.includes(dialect))
  const onPick = (e: ChangeEvent<HTMLSelectElement>): void => {
    const id = e.target.value
    if (!id) return
    sandbox.loadExample(id)
    setPicked('')
  }
  const current = list.find((e) => e.id === picked)
  return (
    <div className="sbx-field">
      <label className="sbx-label" htmlFor="sbx-example">EXAMPLES</label>
      <div className="sbx-row">
        <select id="sbx-example" className="mono" value={picked} onChange={onPick}>
          <option value="">load an example…</option>
          {list.map((e) => (
            <option key={e.id} value={e.id} title={e.summary}>
              {e.title}
            </option>
          ))}
        </select>
        {prev !== null && (
          <button type="button" className="sbx-chip" onClick={() => sandbox.restorePrevious()} title="Put back the code the example replaced">
            ↶ UNDO
          </button>
        )}
      </div>
      {current && <p className="sbx-hint">{current.summary}</p>}
    </div>
  )
}

function Stats() {
  const stats = useSandbox((s) => s.stats)
  const dialect = useSandbox((s) => s.dialect)
  const line = useSandbox((s) => s.line)
  return (
    <dl className="sbx-stats mono">
      {statCells(stats, dialect, line).map((c) => (
        <div key={c.label}>
          <dt>{c.label}</dt>
          <dd>
            {c.value}
            {c.value !== '—' && c.unit && <span className="u"> {c.unit}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function LedIndicator() {
  const led = useSandbox((s) => s.led)
  const pin = useSandbox((s) => s.ledPin)
  const board = useSandbox((s) => s.board)
  const on = led > 0.004
  const pinText = board === 'stm32' ? 'PC13' : board === 'picow' ? 'CYW43 LED' : `GPIO ${pin}`
  const level = led >= 0.999 ? 'ON' : on ? `PWM ${Math.round(led * 100)} %` : 'OFF'
  return (
    <div className={`sbx-led mono${on ? ' on' : ''}`}>
      <span className="lamp" style={{ opacity: on ? 0.35 + 0.65 * led : 1 }} aria-hidden="true" />
      <span>LED_BUILTIN</span>
      <span className="u">{pinText}</span>
      <span className="lv">{level}</span>
    </div>
  )
}

function ErrorBox() {
  const error = useSandbox((s) => s.error)
  const state = useSandbox((s) => s.state)
  if (!error || (state !== 'error' && state !== 'stopped')) return null
  return (
    <div className="sbx-err" role="alert">
      <b>{state === 'error' ? `line ${error.line}` : 'watchdog'}</b>
      <p>{error.message}</p>
    </div>
  )
}

export function CodePanel() {
  return (
    <div className="sbx-panel">
      <StatusPill />
      <DialectSwitch />
      <Transport />
      <ErrorBox />
      <ExamplePicker />
      <Stats />
      <LedIndicator />
    </div>
  )
}
