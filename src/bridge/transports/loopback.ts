import type { HardwareConfig } from '../../core/hardware'
import type { HardwareSpec } from '../../core/types'
import { LineFramer } from '../link/framing'
import type { Transport, TransportEventState } from '../types'
import { VirtualDevice } from '../virtual/device'
import { createRng, type Rng } from '../virtual/random'
import { TransportEvents } from './emitter'

/* ============================================================
   LOOPBACK — the VIRTUAL DEVICE on a fake wire. Lines cross with a
   few ms of latency and jitter (order preserved, like a UART), the
   device is stepped from a timer, and its output goes through the
   same line framer as a real port. Works in every browser.
   ============================================================ */

export interface LoopbackOptions {
  /** Read at connect and at reflash: the robot the virtual board is "flashed" for. */
  spec: () => HardwareSpec
  config: () => HardwareConfig
  miscalibrate: boolean
  latencyMs?: number
  jitterMs?: number
  stepMs?: number
  connectDelayMs?: number
  now?: () => number
  seed?: number
}

const DEFAULTS = { latencyMs: 3, jitterMs: 1.5, stepMs: 10, connectDelayMs: 150 }
/** Clamp the step after a throttled background tab so the physics does not explode. */
const MAX_STEP_MS = 250

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export class LoopbackTransport implements Transport {
  readonly id = 'loopback' as const
  private readonly ev = new TransportEvents()
  private readonly framer = new LineFramer({ onLine: (l) => this.ev.line(l), onOversize: (b) => this.ev.drop(b) })
  private readonly now: () => number
  private readonly rng: Rng
  private device: VirtualDevice | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastStep = 0
  /** Delivery times stay monotonic per direction so jitter never reorders lines. */
  private nextIn = 0
  private nextOut = 0
  private readonly o: Required<Omit<LoopbackOptions, 'seed'>>

  constructor(opts: LoopbackOptions) {
    this.o = { ...DEFAULTS, now: defaultNow, ...opts }
    this.now = this.o.now
    this.rng = createRng((opts.seed ?? 1) + 17)
  }

  isSupported(): boolean {
    return true
  }

  get virtual(): VirtualDevice | null {
    return this.device
  }

  async connect(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.o.connectDelayMs))
    this.framer.reset()
    this.device = new VirtualDevice({
      spec: this.o.spec(),
      getConfig: this.o.config,
      emit: (line) => this.toApp(line),
      miscalibrate: this.o.miscalibrate,
    })
    this.device.start()
    this.lastStep = this.now()
    this.timer = setInterval(() => this.stepDevice(), this.o.stepMs)
  }

  async disconnect(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.device = null
  }

  write(line: string): boolean {
    if (!this.device) return false
    const delay = this.delay('out')
    setTimeout(() => this.device?.receive(line), delay)
    return true
  }

  reflash(): void {
    this.device?.reflash(this.o.spec())
  }

  onLine(fn: (line: string) => void): () => void {
    return this.ev.onLine(fn)
  }

  onState(fn: (s: TransportEventState, detail?: string) => void): () => void {
    return this.ev.onState(fn)
  }

  onDrop(fn: (bytes: number) => void): () => void {
    return this.ev.onDrop(fn)
  }

  private stepDevice(): void {
    const t = this.now()
    const dt = Math.min(t - this.lastStep, MAX_STEP_MS)
    this.lastStep = t
    if (dt > 0) this.device?.step(dt)
  }

  private toApp(line: string): void {
    const delay = this.delay('in')
    setTimeout(() => {
      if (this.device) this.framer.push(`${line}\n`)
    }, delay)
  }

  /** Latency + jitter for one line, never earlier than the previous line in that direction. */
  private delay(dir: 'in' | 'out'): number {
    const t = this.now()
    const want = t + this.o.latencyMs + this.rng.next() * this.o.jitterMs
    const at = Math.max(want, dir === 'in' ? this.nextIn : this.nextOut)
    if (dir === 'in') this.nextIn = at
    else this.nextOut = at
    return Math.max(0, at - t)
  }
}
