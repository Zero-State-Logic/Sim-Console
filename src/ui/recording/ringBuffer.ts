/*
 * Fixed-capacity ring buffer. Pushing past capacity overwrites the oldest entry, so a
 * recording keeps the newest N frames without ever reallocating. Logical index 0 is
 * always the oldest entry still held.
 */
export class RingBuffer<T> {
  private items: (T | undefined)[]
  private head = 0
  private count = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer')
    this.items = new Array<T | undefined>(capacity)
  }

  get size(): number {
    return this.count
  }

  get isFull(): boolean {
    return this.count === this.capacity
  }

  push(item: T): void {
    const slot = (this.head + this.count) % this.capacity
    this.items[slot] = item
    if (this.count < this.capacity) this.count++
    else this.head = (this.head + 1) % this.capacity
  }

  /** Logical index: 0 = oldest. Returns undefined out of range. */
  get(i: number): T | undefined {
    if (i < 0 || i >= this.count || !Number.isInteger(i)) return undefined
    return this.items[(this.head + i) % this.capacity]
  }

  first(): T | undefined {
    return this.get(0)
  }

  last(): T | undefined {
    return this.get(this.count - 1)
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.capacity)
    this.head = 0
    this.count = 0
  }

  /** Oldest-first copy. */
  toArray(): T[] {
    const out: T[] = []
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.head + i) % this.capacity] as T)
    return out
  }

  /** Replace the contents with `list`, keeping only the newest `capacity` entries. */
  load(list: readonly T[]): void {
    this.clear()
    const start = Math.max(0, list.length - this.capacity)
    for (let i = start; i < list.length; i++) this.push(list[i])
  }
}

/**
 * Index of the last entry whose key is <= `t` (entries sorted ascending by key).
 * Returns 0 when `t` is before the first entry and -1 when the buffer is empty.
 */
export function indexAtOrBefore<T>(buf: RingBuffer<T>, t: number, key: (item: T) => number): number {
  const n = buf.size
  if (n === 0) return -1
  let lo = 0
  let hi = n - 1
  if (t <= key(buf.get(0) as T)) return 0
  if (t >= key(buf.get(hi) as T)) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (key(buf.get(mid) as T) <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Slack so a 30 Hz grid sampled from a 60 Hz loop doesn't drift to 20 Hz on rounding. */
const SAMPLE_EPS = 1e-6

/**
 * True when a sample should be taken at sim time `t`, given the sampling grid point of
 * the last sample (see advanceSampleGrid) and the period. A clock that went backwards
 * (reset) always samples.
 */
export function shouldSample(t: number, lastT: number, period: number): boolean {
  if (!Number.isFinite(t)) return false
  if (!Number.isFinite(lastT) || t < lastT) return true
  return t - lastT >= period - SAMPLE_EPS
}

/**
 * Grid point to remember after sampling at `t`: the last multiple of `period` past
 * `gridT` that is not after t. Anchoring to the grid instead of to t keeps the average
 * rate at exactly 1/period for any frame rate (a 50 Hz loop would otherwise record at
 * 25 Hz, a 144 Hz loop at 28.8 Hz). A first sample or a clock reset anchors at t.
 */
export function advanceSampleGrid(t: number, gridT: number, period: number): number {
  if (!Number.isFinite(gridT) || t < gridT || !(period > 0)) return t
  const k = Math.max(1, Math.floor((t - gridT + SAMPLE_EPS) / period))
  return gridT + k * period
}
