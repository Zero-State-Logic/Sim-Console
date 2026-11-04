import type { LegCount, LegLayout } from './geometry'

/* ============================================================
   GAIT TABLE — leg-count agnostic phase offsets + duty factor.
   Leg i's cycle starts (touchdown) at global phase φ = offset_i.
   Local phase ψ = frac(φ − offset); stance while ψ < duty,
   swing while ψ ≥ duty.
   ============================================================ */

export type GaitId = 'tripod' | 'tetrapod' | 'ripple' | 'wave' | 'crawl' | 'trot' | 'pace'

export interface GaitDef {
  id: GaitId
  label: string
  /** Per-leg phase offsets in [0, 1). */
  offsets: number[]
  /** Default duty factor (fraction of the cycle in stance). */
  duty: number
  /** Default cycle frequency, Hz (GAIT SPEED resets to it when the gait is picked, like the duty). */
  freq: number
  /** Smallest duty that keeps the gait's intended number of stance legs. */
  minDuty: number
  /** True when the gait keeps ≥ 3 feet down (a support polygon) at all times. */
  staticallyStable: boolean
  /** Shift the body over the support triangle while each leg swings (quadruped creep). */
  sway: boolean
}

export const MAX_DUTY = 0.95
/** Cycle frequency of the hexapod-style gaits, Hz. */
const BASE_FREQ = 1.2

function frac(v: number): number {
  return v - Math.floor(v)
}

/** Offsets for a back-to-front wave on each side, left side shifted by `sideShift`. */
function sideWaveOffsets(L: LegLayout, sideShift: number): number[] {
  const k = L.n / 2
  return Array.from({ length: L.n }, (_, i) => frac((k - 1 - L.rank[i]) / k + (L.side[i] > 0 ? sideShift : 0)))
}

function alternating(L: LegLayout): number[] {
  return Array.from({ length: L.n }, (_, i) => ((L.rank[i] + (L.side[i] > 0 ? 1 : 0)) % 2) * 0.5)
}

function wave(L: LegLayout): number[] {
  const k = L.n / 2
  return Array.from({ length: L.n }, (_, i) => ((L.side[i] > 0 ? k : 0) + (k - 1 - L.rank[i])) / L.n)
}

/** Quadruped legs: right front 0, right hind 1, left front 2, left hind 3. */
function quadOffsets(rf: number, rh: number, lf: number, lh: number): number[] {
  return [rf, rh, lf, lh]
}

function multiLegGaits(L: LegLayout): GaitDef[] {
  const n = L.n
  const k = n / 2
  const alt: GaitDef = {
    id: n === 6 ? 'tripod' : 'tetrapod',
    label: n === 6 ? 'TRIPOD' : 'TETRAPOD',
    offsets: alternating(L),
    duty: 0.5,
    minDuty: 0.5,
    freq: BASE_FREQ,
    staticallyStable: true,
    sway: false,
  }
  const ripple: GaitDef = {
    id: 'ripple',
    label: 'RIPPLE',
    offsets: sideWaveOffsets(L, 0.5),
    duty: 1 - 1 / k,
    minDuty: 1 - 1 / k,
    freq: BASE_FREQ,
    staticallyStable: true,
    sway: false,
  }
  const waveGait: GaitDef = {
    id: 'wave',
    label: 'WAVE',
    offsets: wave(L),
    duty: 1 - 1 / n,
    minDuty: 1 - 1 / n,
    freq: BASE_FREQ,
    staticallyStable: true,
    sway: false,
  }
  return [alt, ripple, waveGait]
}

function quadGaits(): GaitDef[] {
  return [
    {
      // McGhee's statically stable creep sequence LH → LF → RH → RF. Two of its four
      // lift-offs swap support across a diagonal, so the CoM may only cross it in the
      // four-feet windows, (4β − 3)/4 of the cycle each: β must exceed 0.75, and the
      // cycle must be slow enough for servos to shift the body in that window.
      id: 'crawl',
      label: 'CRAWL',
      offsets: quadOffsets(0.75, 0.5, 0.25, 0),
      // 0.5 Hz at β = 0.85: 200 ms four-feet windows for a ~5 cm body shift, and swings
      // that stay under MG996R joint rates (~310 °/s at 60 % speed)
      duty: 0.85,
      minDuty: 0.8,
      freq: 0.5,
      staticallyStable: true,
      sway: true,
    },
    {
      id: 'trot',
      label: 'TROT',
      offsets: quadOffsets(0, 0.5, 0.5, 0),
      duty: 0.5,
      minDuty: 0.5,
      freq: BASE_FREQ,
      staticallyStable: false,
      sway: false,
    },
    {
      id: 'pace',
      label: 'PACE',
      offsets: quadOffsets(0, 0, 0.5, 0.5),
      duty: 0.5,
      minDuty: 0.5,
      freq: BASE_FREQ,
      staticallyStable: false,
      sway: false,
    },
  ]
}

/** The gaits that are valid for this layout, default first. */
export function gaitsFor(L: LegLayout): GaitDef[] {
  return L.n === 4 ? quadGaits() : multiLegGaits(L)
}

export function defaultGaitId(n: LegCount): GaitId {
  return n === 4 ? 'crawl' : n === 6 ? 'tripod' : 'tetrapod'
}

/** Duty actually used: never below the gait's minimum, never above MAX_DUTY. */
export function effectiveDuty(g: GaitDef, requested: number): number {
  return Math.min(Math.max(requested, g.minDuty), MAX_DUTY)
}

/** Local phase of leg i at global phase φ. */
export function localPhase(g: GaitDef, i: number, phase: number): number {
  return frac(phase - g.offsets[i])
}

/** Number of legs in their stance window at global phase φ. */
export function stanceCountAt(g: GaitDef, duty: number, phase: number): number {
  let c = 0
  for (let i = 0; i < g.offsets.length; i++) if (localPhase(g, i, phase) < duty) c++
  return c
}
