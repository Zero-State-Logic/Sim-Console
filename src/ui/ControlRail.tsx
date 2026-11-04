import type { ReactNode } from 'react'
import { useConsole, type DriveSource } from '../store'
import { runtime } from '../core/runtime'
import { useRecorder } from '../core/recorder'
import type { ControlDef, ControlValue } from '../core/types'
import { HardwarePanel } from '../bridge/ui'
import { CodePanel } from '../sandbox/ui'
import Control from './controls/Control'
import { groupControls } from './controls/controlMath'
import { useUi } from './uiStore'

/*
 * Right rail: DRIVE SOURCE switch on top with the active source's panel under it, then
 * the module's controls grouped into panels in schema order. Every write goes through
 * runtime.setControl so the store, bridge and sandbox stay consistent.
 */
const SOURCES: { id: DriveSource; label: string; sub: string }[] = [
  { id: 'sim', label: 'SIM', sub: 'simulator' },
  { id: 'hardware', label: 'HARDWARE', sub: 'real board' },
  { id: 'code', label: 'CODE', sub: 'your program' },
]

function DriveSourceSwitch() {
  const src = useConsole((s) => s.driveSource)
  return (
    <div className="dswitch" role="group" aria-label="Drive source">
      {SOURCES.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={src === o.id}
          className={`dseg ${o.id}${src === o.id ? ' on' : ''}`}
          onClick={() => runtime.setDriveSource(o.id)}
        >
          <span className="d" aria-hidden="true" />
          <span className="dl">{o.label}</span>
          <span className="ds">{o.sub}</span>
        </button>
      ))}
    </div>
  )
}

function SimStatus() {
  useConsole((s) => s.layoutRev)
  const playing = useConsole((s) => s.playing)
  const speed = useConsole((s) => s.timeScale)
  const replaying = useRecorder((s) => s.replaying)
  const state = replaying ? 'REPLAYING RECORDING' : playing ? 'SIMULATION RUNNING' : 'SIMULATION PAUSED'
  return (
    <div className={`status sim${playing && !replaying ? ' live' : ''}`}>
      <span className="d" aria-hidden="true" />
      <div>
        {state}
        <div className="sub">
          {runtime.module.label.toLowerCase()} · {speed.toFixed(2)}× · no hardware
        </div>
      </div>
    </div>
  )
}

function SourcePanel() {
  const src = useConsole((s) => s.driveSource)
  if (src === 'hardware') return <HardwarePanel />
  if (src === 'code') return <CodePanel />
  return <SimStatus />
}

/** Consecutive buttons share one row; everything else stacks. */
function renderDefs(defs: ControlDef[], values: Record<string, ControlValue>, onSet: (k: string, v: ControlValue) => void): ReactNode[] {
  const out: ReactNode[] = []
  let row: ControlDef[] = []
  const flush = (): void => {
    if (row.length === 0) return
    out.push(
      <div className="btnrow" key={`row-${row[0].key}`}>
        {row.map((d) => <Control key={d.key} def={d} value={undefined} onSet={onSet} />)}
      </div>,
    )
    row = []
  }
  for (const d of defs) {
    if (d.type === 'button') {
      row.push(d)
      continue
    }
    flush()
    out.push(<Control key={d.key} def={d} value={values[d.key]} onSet={onSet} />)
  }
  flush()
  return out
}

function ControlGroupPanel({ index, group, children }: { index: number; group: string; children: ReactNode }) {
  const collapsed = useUi((s) => Boolean(s.collapsed[group]))
  const toggle = useUi((s) => s.toggleCollapsed)
  const bodyId = `grp-${index}`
  return (
    <section className={`panel reg ctlgroup${collapsed ? ' collapsed' : ''}`}>
      <h3>
        <button type="button" className="grp-head" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => toggle(group)}>
          <span className="idx">{String(index + 1).padStart(2, '0')}</span>
          {group}
          <span className="chev" aria-hidden="true">{collapsed ? '+' : '−'}</span>
        </button>
      </h3>
      {!collapsed && <div id={bodyId} className="grp-body">{children}</div>}
    </section>
  )
}

function ModuleControls() {
  useConsole((s) => s.controlRev)
  useConsole((s) => s.layoutRev)
  const m = runtime.module
  const values = m.getControlValues()
  const groups = groupControls(m.getControlSchema())
  const onSet = (key: string, v: ControlValue): void => runtime.setControl(key, v)
  return (
    <>
      {groups.map((g, i) => (
        <ControlGroupPanel key={g.group} index={i} group={g.group}>
          {renderDefs(g.defs, values, onSet)}
        </ControlGroupPanel>
      ))}
    </>
  )
}

export default function ControlRail() {
  return (
    <div className="rail-inner">
      <section className="panel reg panel-source">
        <div className="dslabel">
          DRIVE SOURCE <span className="dsh">same instruments, any source</span>
        </div>
        <DriveSourceSwitch />
        <div className="source-panel">
          <SourcePanel />
        </div>
      </section>
      <ModuleControls />
    </div>
  )
}
