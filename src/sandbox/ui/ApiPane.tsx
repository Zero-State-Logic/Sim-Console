import { useState } from 'react'
import type { SandboxFnDef } from '../../core/types'
import type { Dialect } from '../protocol'
import { SHIM_CLASSES, SHIM_FUNCTIONS, VM_BUILTINS, type ShimFn } from '../shim/reference'
import { useSandbox } from '../store'
import { insertAtCursor } from './editorBus'
import { robotSignature, robotSnippet, shimSignature } from './labels'

/*
 * API reference. The ROBOT section is generated at runtime from module.getSandboxApi(),
 * so it always matches the robot on the bench; the ARDUINO section comes from the shim
 * signature table that also feeds the compiler. Click an entry to insert it.
 */

const JS_EXTRAS: readonly { sig: string; doc: string }[] = [
  { sig: 'await delay(ms)', doc: 'Sleep in virtual time inside an async setup() / loop(). A pending delay carries across frames.' },
  { sig: 'watch(name, value)', doc: 'Show a value in the WATCH pane (JS has no global inspection).' },
  { sig: 'millis()  micros()', doc: 'Virtual clock (sim time).' },
  { sig: 'map  constrain  min  max  abs  sq  radians  degrees  random  randomSeed', doc: 'Arduino helpers. Math.* works too.' },
  { sig: 'Sandboxing', doc: 'The program runs in its own Web Worker with no page access; network and messaging globals are hidden.' },
]

function RobotEntry({ f, dialect }: { f: SandboxFnDef; dialect: Dialect }) {
  return (
    <li>
      <button type="button" className="sbx-api-row" onClick={() => insertAtCursor(robotSnippet(f, dialect))} title="Insert at cursor">
        <span className={`sbx-kind ${f.kind}`}>{f.kind === 'command' ? 'CMD' : 'QRY'}</span>
        <code>{robotSignature(f, dialect)}</code>
      </button>
      <p>{f.doc}</p>
    </li>
  )
}

/** Conventional instance names for class-method snippets. */
const INSTANCE: Record<string, string> = { Servo: 'servo', Adafruit_PWMServoDriver: 'pwm' }

function ShimEntry({ f, dialect, owner }: { f: ShimFn; dialect: Dialect; owner?: string }) {
  const name = owner ? `${INSTANCE[owner] ?? owner}.${f.name}` : f.name
  const call = `${name}(${f.params.slice(0, f.params.length - (f.optional ?? 0)).map((p) => p[0]).join(', ')})`
  return (
    <li>
      <button type="button" className="sbx-api-row" onClick={() => insertAtCursor(call)} title="Insert at cursor">
        <code>{shimSignature(f, dialect, owner)}</code>
      </button>
      <p>{f.doc}</p>
    </li>
  )
}

function groupFns(): Map<string, ShimFn[]> {
  const groups = new Map<string, ShimFn[]>()
  for (const f of SHIM_FUNCTIONS) groups.set(f.group, [...(groups.get(f.group) ?? []), f])
  return groups
}

const GROUPS = groupFns()

export function ApiPane() {
  const api = useSandbox((s) => s.api)
  const dialect = useSandbox((s) => s.dialect)
  const label = useSandbox((s) => s.kind.toUpperCase())
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const match = (txt: string): boolean => q.length === 0 || txt.toLowerCase().includes(q)
  const robot = api.filter((f) => match(f.name) || match(f.doc))

  return (
    <div className="sbx-api">
      <div className="sbx-pane-bar">
        <input className="sbx-filter mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…" aria-label="Filter the API reference" />
      </div>
      <div className="sbx-api-scroll">
        <h4>{label} API · {api.length} functions</h4>
        <ul className="sbx-api-list">
          {robot.map((f) => <RobotEntry key={f.name} f={f} dialect={dialect} />)}
          {robot.length === 0 && <li className="sbx-empty">{api.length === 0 ? 'This robot exposes no sandbox API.' : 'No match.'}</li>}
        </ul>
        {dialect === 'js' && (
          <>
            <h4>JAVASCRIPT</h4>
            <ul className="sbx-api-list">
              {JS_EXTRAS.filter((e) => match(e.sig) || match(e.doc)).map((e) => (
                <li key={e.sig}><code className="sbx-sig">{e.sig}</code><p>{e.doc}</p></li>
              ))}
            </ul>
          </>
        )}
        {[...GROUPS].map(([group, fns]) => {
          const shown = fns.filter((f) => match(f.name) || match(f.doc))
          if (shown.length === 0) return null
          return (
            <section key={group}>
              <h4>ARDUINO · {group}</h4>
              <ul className="sbx-api-list">{shown.map((f) => <ShimEntry key={f.name} f={f} dialect={dialect} />)}</ul>
            </section>
          )
        })}
        {SHIM_CLASSES.map((c) => {
          const shown = c.methods.filter((f) => match(f.name) || match(f.doc) || match(c.name))
          if (shown.length === 0) return null
          return (
            <section key={c.name}>
              <h4>ARDUINO · {c.name}</h4>
              <p className="sbx-class-doc">{c.doc}</p>
              <ul className="sbx-api-list">{shown.map((f) => <ShimEntry key={f.name} f={f} dialect={dialect} owner={c.name} />)}</ul>
            </section>
          )
        })}
        {dialect === 'cpp' && (
          <>
            <h4>ARDUINO · BUILT INTO THE VM</h4>
            <ul className="sbx-api-list">
              {VM_BUILTINS.filter((b) => match(b.sig) || match(b.doc)).map((b) => (
                <li key={b.sig}><code className="sbx-sig">{b.sig}</code><p>{b.doc}</p></li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
