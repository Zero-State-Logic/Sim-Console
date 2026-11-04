/* ============================================================
   WALKER GEOMETRY — leg layout for 4 / 6 / 8 legs.
   Body frame is REP-103: x forward, y left, z up, origin on the
   coxa mount plane at the body centre. Meters and radians.
   Leg order: L1..L(n/2) = right side front→rear,
              L(n/2+1)..Ln = left side front→rear (mirror of the right).
   The tibia length is measured from the knee axis to the ground
   contact point of the foot (the tip), so IK plants the tip at z = 0.
   ============================================================ */

export type LegCount = 4 | 6 | 8
export const LEG_COUNTS: readonly LegCount[] = [4, 6, 8]
export const MAX_LEGS = 8
export const MAX_JOINTS = MAX_LEGS * 3

/** Visual / collision radius of the foot cap, meters. */
export const FOOT_RADIUS = 0.011

export interface WalkerDims {
  coxa: number
  femur: number
  tibia: number
  /** Radius of the circle the coxa mounts sit on. */
  bodyRadius: number
}

export const DEFAULT_DIMS: Readonly<WalkerDims> = { coxa: 0.045, femur: 0.075, tibia: 0.13, bodyRadius: 0.11 }

/** Valid range per dimension (meters). Used by the sliders and by config validation. */
export const DIM_RANGES: Readonly<Record<keyof WalkerDims, readonly [number, number]>> = {
  coxa: [0.02, 0.08],
  femur: [0.04, 0.12],
  tibia: [0.07, 0.2],
  bodyRadius: [0.07, 0.16],
}

export interface LegLayout {
  n: LegCount
  dims: WalkerDims
  mountX: Float64Array
  mountY: Float64Array
  /** Direction the coxa points at joint zero, radians CCW from forward. */
  mountYaw: Float64Array
  /** -1 = right side, +1 = left side. */
  side: Int8Array
  /** 0 = front-most leg on its side. */
  rank: Int8Array
  /** Neutral foot position in the gait (ground) frame, meters. */
  neutralX: Float64Array
  neutralY: Float64Array
  /** Horizontal distance from the coxa axis to the neutral foot. */
  footReach: number
}

/** Mount angles per side, front→rear, degrees from forward (right side is negated). */
const MOUNT_ANGLES_DEG: Record<LegCount, number[]> = {
  4: [40, 140],
  6: [40, 90, 140],
  8: [22.5, 67.5, 112.5, 157.5],
}

const DEG = Math.PI / 180

/*
 * Neutral stance chosen to match the reference look: femur raised ~35°, tibia ~10°
 * off vertical, splayed out. Expressed as fractions of the link lengths so every
 * DIMENSIONS setting gets the same posture.
 */
export function footReachFor(d: WalkerDims): number {
  return d.coxa + d.femur * Math.cos(35 * DEG) + d.tibia * Math.cos(80 * DEG)
}

export function nominalHeightFor(d: WalkerDims): number {
  return d.tibia * Math.sin(80 * DEG) - d.femur * Math.sin(35 * DEG)
}

/**
 * Mount plane above the ground when the robot lies on its belly plate. Matches the
 * bottom of the visual chassis plate (scene/parts.ts).
 */
export const BELLY_HEIGHT = 0.022

const HEIGHT_CAP = 0.2

function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * Body-height range in which the neutral foot stays reachable with a little margin:
 * the femur-to-foot distance stays inside [1.05·|femur − tibia|, 0.97·(femur + tibia)],
 * and the body never goes below its belly.
 */
export function heightRange(d: WalkerDims): [number, number] {
  const u = footReachFor(d) - d.coxa
  const far = 0.97 * (d.femur + d.tibia)
  const near = 1.05 * Math.abs(d.femur - d.tibia)
  const hi = Math.sqrt(Math.max(far * far - u * u, 0))
  const lo = Math.sqrt(Math.max(near * near - u * u, 0))
  const min = roundMm(Math.max(lo, BELLY_HEIGHT + 0.01))
  return [min, Math.max(min + 0.01, roundMm(Math.min(hi, HEIGHT_CAP)))]
}

/** Default standing height for a set of dimensions, inside its height range. */
export function standHeightFor(d: WalkerDims): number {
  const [lo, hi] = heightRange(d)
  return roundMm(Math.min(Math.max(nominalHeightFor(d), lo), hi))
}

export function isLegCount(n: number): n is LegCount {
  return n === 4 || n === 6 || n === 8
}

export function clampDims(d: WalkerDims): WalkerDims {
  const c = (k: keyof WalkerDims) => Math.min(Math.max(d[k], DIM_RANGES[k][0]), DIM_RANGES[k][1])
  return { coxa: c('coxa'), femur: c('femur'), tibia: c('tibia'), bodyRadius: c('bodyRadius') }
}

export function buildLayout(n: LegCount, dims: WalkerDims): LegLayout {
  const angles = MOUNT_ANGLES_DEG[n]
  const half = n / 2
  const reach = footReachFor(dims)
  const L: LegLayout = {
    n,
    dims: { ...dims },
    mountX: new Float64Array(n),
    mountY: new Float64Array(n),
    mountYaw: new Float64Array(n),
    side: new Int8Array(n),
    rank: new Int8Array(n),
    neutralX: new Float64Array(n),
    neutralY: new Float64Array(n),
    footReach: reach,
  }
  for (let i = 0; i < n; i++) {
    const left = i >= half
    const rank = left ? i - half : i
    const yaw = (left ? 1 : -1) * angles[rank] * DEG
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    L.mountX[i] = dims.bodyRadius * c
    L.mountY[i] = dims.bodyRadius * s
    L.mountYaw[i] = yaw
    L.side[i] = left ? 1 : -1
    L.rank[i] = rank
    L.neutralX[i] = L.mountX[i] + reach * c
    L.neutralY[i] = L.mountY[i] + reach * s
  }
  return L
}

/** Largest neutral-foot radius from the body centre (used to scale yaw rate). */
export function maxFootRadius(L: LegLayout): number {
  let r = 0
  for (let i = 0; i < L.n; i++) r = Math.max(r, Math.hypot(L.neutralX[i], L.neutralY[i]))
  return r
}

export function legLabel(i: number): string {
  return `L${i + 1}`
}

const JOINT_NAMES = ['coxa', 'femur', 'tibia'] as const

export function jointName(j: number): string {
  return `${legLabel(Math.floor(j / 3))} ${JOINT_NAMES[j % 3]}`
}

export function bodyName(n: LegCount): string {
  return n === 4 ? 'QUAD' : n === 6 ? 'HEX' : 'OCTO'
}
