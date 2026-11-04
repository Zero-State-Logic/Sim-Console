import { describe, expect, it } from 'vitest'
import { compile, createVM } from '../compiler'
import { defaultHardwareConfig } from '../core/hardware'
import type { RobotKind, RobotModule } from '../core/types'
import { getRobotEntry } from '../robots'
import { examplesFor, exampleSource } from './examples'
import { hwMapFor } from './host/controller'
import type { OutMsg, WorkerMsg } from './protocol'
import { WorkerCore } from './workerCore'

/*
 * CODE source end to end, headless: every C++ example for every robot is compiled by our
 * compiler, run by the worker core, and its commands fed back into the real robot module
 * exactly as the runtime does it (sensors in, commands out, one frame of latency). The
 * robot must actually move: its recorded state has to change measurably.
 */
const FRAME = 1 / 60

function numbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v)
  else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<unknown>
    for (let i = 0; i < a.length; i++) numbers(a[i], out)
  }
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbers(x, out)
  return out
}

function maxChange(a: number[], b: number[]): number {
  let m = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

async function runExample(kind: RobotKind, id: string, seconds: number) {
  const m: RobotModule = getRobotEntry(kind).create()
  const spec = m.getHardwareSpec()
  const hw = defaultHardwareConfig('esp32', spec.joints)
  const src = exampleSource(kind, id, 'cpp', { spec, hw })
  if (!src) throw new Error(`no C++ source for ${kind}/${id}`)
  const posted: WorkerMsg[] = []
  let wall = 0
  const core = new WorkerCore({ compiler: { compile, createVM }, clock: () => wall }, (msg) => posted.push(msg))
  await core.receive({ t: 'load', id: 1, dialect: 'cpp', source: src, api: m.getSandboxApi(), hw: hwMapFor(hw, m), intBits: 32 })
  const loaded = posted.find((p) => p.t === 'loaded')
  const before = numbers(m.snapshot())
  let t = 0
  let errors = 0
  for (let seq = 1; t < seconds; seq++) {
    t += FRAME
    wall += FRAME * 1000
    await core.receive({ t: 'tick', seq, nowMs: t * 1000, sensors: m.getSandboxSensors() })
    const out = posted[posted.length - 1] as OutMsg
    if (out.t === 'out') {
      if (out.error) errors++
      m.applySandboxCommands(out.cmds)
    }
    m.update(FRAME, { source: 'code', t })
  }
  const after = numbers(m.snapshot())
  m.dispose()
  return { loaded, change: maxChange(before, after), errors }
}

describe('CODE source drives the real robots end to end', () => {
  for (const kind of ['walker', 'sweeper', 'swarm'] as RobotKind[]) {
    for (const ex of examplesFor(kind)) {
      it(`${kind} / ${ex.title}: compiles, runs and moves the robot`, async () => {
        const r = await runExample(kind, ex.id, kind === 'swarm' ? 8 : 4)
        expect(r.loaded).toMatchObject({ t: 'loaded', ok: true })
        expect(r.errors).toBe(0)
        expect(r.change).toBeGreaterThan(1e-3)
      }, 60_000)
    }
  }
})
