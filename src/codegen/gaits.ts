import type { WalkerGeom } from './walkerGeom'

/* ============================================================
   GAIT TABLES for the on-board gait, built from the leg layout so
   the firmware only does table lookups. Leg-count agnostic:
   side comes from the sign of mountY (REP-103: y left) and rank
   from mountX (front first), so any leg order works.
     4 legs: crawl (creep), trot, pace
     6 legs: tripod, ripple, wave
     8 legs: tetrapod, ripple, wave
   Each gait = duty factor + per-leg phase offset in [0, 1).
   Leg phase = frac(phase - offset) and stance is [0, duty), the
   same convention and tables as src/robots/walker/gaits.ts, so the
   board walks exactly like the sim.
   ============================================================ */

export interface GaitDef {
  name: string
  /** Other mode names the firmware accepts for this gait. */
  aliases: string[]
  duty: number
  offsets: number[]
  /** Quadruped creep: the body sways over the three planted feet before each lift (src/codegen/creep.ts). */
  creep: boolean
}

export interface LegClass {
  /** 0 = right, 1 = left. */
  side: number
  /** 0 = front-most on its side. */
  rank: number
  perSide: number
}

export function classifyLegs(g: WalkerGeom): LegClass[] {
  const sides = g.mountY.map((y, i) => (y > 1e-9 || (Math.abs(y) <= 1e-9 && g.mountYawDeg[i] > 0) ? 1 : 0))
  const out: LegClass[] = []
  for (let i = 0; i < g.legs; i++) {
    const same = sides
      .map((s, j) => ({ s, j }))
      .filter((e) => e.s === sides[i])
      .sort((a, b) => g.mountX[b.j] - g.mountX[a.j] || a.j - b.j)
    out.push({ side: sides[i], rank: same.findIndex((e) => e.j === i), perSide: same.length })
  }
  return out
}

const frac = (v: number) => v - Math.floor(v)
const r4 = (v: number) => Math.round(v * 10000) / 10000

/** Alternating groups (tripod / trot / tetrapod): neighbours on a side and across the body differ. */
function alternating(cls: LegClass[]): number[] {
  return cls.map((c) => ((c.rank + c.side) % 2 === 0 ? 0 : 0.5))
}

/** One leg at a time: rear→front on the right, then rear→front on the left. */
function waveOffsets(cls: LegClass[]): number[] {
  const n = cls.length
  return cls.map((c) => r4((c.side * c.perSide + (c.perSide - 1 - c.rank)) / n))
}

/** Rear→front wave on each side, the two sides half a cycle apart. */
function rippleOffsets(cls: LegClass[]): number[] {
  return cls.map((c) => r4(frac((c.perSide - 1 - c.rank) / c.perSide + 0.5 * c.side)))
}

/** McGhee's creep sequence (lateral: LH, LF, RH, RF), as in the sim. Stable only with the body sway. */
function crawlOffsets(cls: LegClass[]): number[] {
  return cls.map((c) => (c.side === 0 ? (c.rank === 0 ? 0.75 : 0.5) : c.rank === 0 ? 0.25 : 0))
}

/** The sim's crawl duty (src/robots/walker/gaits.ts): long four-feet windows for the body sway. */
export const CRAWL_DUTY = 0.85

export function gaitsFor(g: WalkerGeom): GaitDef[] {
  const cls = classifyLegs(g)
  const n = g.legs
  const perSide = Math.max(1, Math.max(...cls.map((c) => c.perSide)))
  if (n === 4) {
    return [
      { name: 'crawl', aliases: ['creep', 'wave'], duty: CRAWL_DUTY, offsets: crawlOffsets(cls), creep: true },
      { name: 'trot', aliases: ['tripod', 'tetrapod'], duty: 0.5, offsets: alternating(cls), creep: false },
      { name: 'pace', aliases: [], duty: 0.5, offsets: cls.map((c) => (c.side === 0 ? 0 : 0.5)), creep: false },
    ]
  }
  const alt: GaitDef =
    n === 8
      ? { name: 'tetrapod', aliases: ['tripod', 'trot'], duty: 0.5, offsets: alternating(cls), creep: false }
      : { name: 'tripod', aliases: ['trot', 'tetrapod'], duty: 0.5, offsets: alternating(cls), creep: false }
  return [
    alt,
    { name: 'ripple', aliases: [], duty: r4(1 - 1 / perSide), offsets: rippleOffsets(cls), creep: false },
    { name: 'wave', aliases: ['crawl', 'creep'], duty: r4(1 - 1 / n), offsets: waveOffsets(cls), creep: false },
  ]
}

/** Flattened (name → gait index) table the firmware searches, primary names first. */
export function gaitKeys(gaits: GaitDef[]): { key: string; index: number }[] {
  const keys: { key: string; index: number }[] = gaits.map((gd, i) => ({ key: gd.name, index: i }))
  gaits.forEach((gd, i) => {
    for (const a of gd.aliases) if (!keys.some((k) => k.key === a)) keys.push({ key: a, index: i })
  })
  return keys
}

/** Leg phase in [0, 1): stance below duty, swing above. Same as localPhase in the sim. */
export function legPhase(gd: GaitDef, leg: number, phase: number): number {
  return frac(phase - gd.offsets[leg])
}

/** Number of legs in swing at a phase (used by tests to check static stability). */
export function swingCount(gd: GaitDef, phase: number): number {
  return gd.offsets.filter((_, i) => legPhase(gd, i, phase) >= gd.duty).length
}
