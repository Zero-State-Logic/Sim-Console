import { defaultHardwareConfig, defaultServoPins } from '../../core/hardware'
import type { HardwareConfig, ServoDriver } from '../../core/hardware'
import type { BoardId, TransportId } from '../../core/protocol'
import type { CommandLevel, HardwareSpec } from '../../core/types'
import type { FirmwareRequest } from '../types'
import { legIk } from '../walkerGeom'
import type { WalkerGeom } from '../walkerGeom'

/* ============================================================
   TEST FIXTURES — self-contained robot specs shaped exactly like
   the robot modules produce (walker layout of src/robots/walker,
   romi sweeper, N-drone swarm), so the generator tests do not
   depend on another area being mid-edit.
   ============================================================ */

const DEG = Math.PI / 180
const MOUNT_ANGLES: Record<number, number[]> = { 4: [40, 140], 6: [40, 90, 140], 8: [22.5, 67.5, 112.5, 157.5] }
const LIMITS: [number, number][] = [
  [-70, 70],
  [-85, 85],
  [-80, 80],
]
const DIMS = { coxa: 0.045, femur: 0.075, tibia: 0.13, bodyRadius: 0.11 }
const r4 = (v: number) => Math.round(v * 10000) / 10000

export function walkerGeom(legs: number): WalkerGeom {
  const angles = MOUNT_ANGLES[legs]
  const half = legs / 2
  const mountX: number[] = []
  const mountY: number[] = []
  const mountYawDeg: number[] = []
  for (let i = 0; i < legs; i++) {
    const left = i >= half
    const yaw = (left ? 1 : -1) * angles[left ? i - half : i]
    mountX.push(r4(DIMS.bodyRadius * Math.cos(yaw * DEG)))
    mountY.push(r4(DIMS.bodyRadius * Math.sin(yaw * DEG)))
    mountYawDeg.push(yaw)
  }
  return {
    legs,
    coxa: DIMS.coxa,
    femur: DIMS.femur,
    tibia: DIMS.tibia,
    standHeight: r4(DIMS.tibia * Math.sin(80 * DEG) - DIMS.femur * Math.sin(35 * DEG)),
    footReach: r4(DIMS.coxa + DIMS.femur * Math.cos(35 * DEG) + DIMS.tibia * Math.cos(80 * DEG)),
    mountX,
    mountY,
    mountYawDeg,
  }
}

export function walkerSpec(legs: 4 | 6 | 8): HardwareSpec {
  const g = walkerGeom(legs)
  const joints = legs * 3
  const home: number[] = []
  for (let i = 0; i < legs; i++) {
    const yaw = g.mountYawDeg[i] * DEG
    const fx = g.mountX[i] + g.footReach * Math.cos(yaw)
    const fy = g.mountY[i] + g.footReach * Math.sin(yaw)
    home.push(...legIk(g, i, fx, fy, -g.standHeight).q.map((v) => Math.round(v * 10) / 10))
  }
  const names = ['coxa', 'femur', 'tibia']
  return {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, j) => `L${Math.floor(j / 3) + 1} ${names[j % 3]}`),
    jointLimits: Array.from({ length: joints }, (_, j) => [LIMITS[j % 3][0], LIMITS[j % 3][1]] as [number, number]),
    homePose: home,
    legs,
    defaultLevel: { wired: 'joint', wireless: 'high' },
    geometry: {
      coxa: g.coxa,
      femur: g.femur,
      tibia: g.tibia,
      standHeight: g.standHeight,
      footReach: g.footReach,
      mountX: g.mountX,
      mountY: g.mountY,
      mountYawDeg: g.mountYawDeg,
    },
  }
}

export function sweeperSpec(): HardwareSpec {
  return {
    robot: 'sweeper',
    joints: 4,
    jointNames: ['WHEEL FL', 'WHEEL FR', 'WHEEL RL', 'WHEEL RR'],
    jointLimits: [0, 1, 2, 3].map((): [number, number] => [-859, 859]),
    homePose: [0, 0, 0, 0],
    wheels: 4,
    defaultLevel: { wired: 'joint', wireless: 'high' },
    geometry: { wheelRadius: 0.04, halfLength: 0.095, halfWidth: 0.105, maxWheelSpeed: 15 },
  }
}

export function swarmSpec(n = 4): HardwareSpec {
  return {
    robot: 'swarm',
    joints: n,
    jointNames: Array.from({ length: n }, (_, i) => `D${i + 1}`),
    jointLimits: Array.from({ length: n }, (): [number, number] => [-180, 180]),
    homePose: new Array<number>(n).fill(0),
    drones: n,
    defaultLevel: { wired: 'high', wireless: 'high' },
    geometry: { armLength: 0.125, mass: 0.6, cruiseAlt: 1.5 },
  }
}

/** A hardware config for a board / transport / driver with default pins. */
export function hwFor(board: BoardId, transport: TransportId, driver: ServoDriver, joints: number, patch: Partial<HardwareConfig> = {}): HardwareConfig {
  const base = defaultHardwareConfig(board, joints)
  return { ...base, transport, servoDriver: driver, servoPins: defaultServoPins(board, driver, joints), ...patch }
}

export function request(spec: HardwareSpec, hw: HardwareConfig, level: CommandLevel): FirmwareRequest {
  return { spec, hw, robotLabel: spec.robot.toUpperCase(), level }
}
