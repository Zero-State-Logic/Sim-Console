import * as THREE from 'three'
import type { SwarmSim } from '../sim/swarmSim'
import { MAX_DRONES, MAX_WAYPOINTS, VOLUME_HALF, padXY } from '../sim/swarmSim'
import { simToThree } from '../sim/frames'
import { DroneVisual } from './droneVisual'
import type { DroneVisualOpts } from './droneVisual'
import { DRONE_COLORS, createKit, disposeKit } from './kit'
import type { Kit } from './kit'
import { SlotLayer, WaypointLayer, buildPad, buildVolumeFrame } from './markers'
import { TRAIL_HZ, Trail } from './trails'

/*
 * Scene manager for the swarm. Owns every three.js object under the module root and
 * mirrors the sim once per frame without allocating. The fleet (drones, trails,
 * pads) is rebuilt when the drone count changes; the furniture is built once.
 */

export interface SceneOpts {
  trails: boolean
  slots: boolean
  vscale: number
  /** Waypoint under the pointer (-1 = none). */
  hover: number
}

const tA = new THREE.Vector3()
const tB = new THREE.Vector3()
/** Tether is drawn only when the slot error is visible. */
const TETHER_MIN = 0.15

export class SwarmScene {
  private readonly kit: Kit = createKit()
  private readonly fleet = new THREE.Group()
  private visuals: DroneVisual[] = []
  private trails: Trail[] = []
  private fleetOwn: { dispose(): void }[] = []
  private readonly waypoints: WaypointLayer
  private readonly slots: SlotLayer
  private readonly frameGeo: THREE.BufferGeometry
  private wpRev = -1
  private wpAlt = -1
  private wpClosed = false
  private trailAcc = 0
  private time = 0
  private readonly visOpts: DroneVisualOpts = { vscale: 1, time: 0, leader: false }

  constructor(private readonly root: THREE.Group) {
    this.waypoints = new WaypointLayer(this.kit, MAX_WAYPOINTS)
    this.slots = new SlotLayer(this.kit, DRONE_COLORS, MAX_DRONES)
    const frame = buildVolumeFrame(this.kit, VOLUME_HALF, 8)
    this.frameGeo = frame.geo
    root.add(this.fleet, this.waypoints.group, this.slots.group, frame.obj)
  }

  /** (Re)build drone visuals, trails and pads for the sim's fleet. */
  buildFleet(sim: SwarmSim): void {
    this.disposeFleet()
    const n = sim.count
    for (let i = 0; i < n; i++) {
      const color = DRONE_COLORS[i % DRONE_COLORS.length]
      const v = new DroneVisual(this.kit, color)
      this.visuals.push(v)
      this.fleet.add(v.group, v.shadow)
      const tr = new Trail(color)
      this.trails.push(tr)
      this.fleet.add(tr.line)
      const pad = buildPad(this.kit, color, this.fleetOwn)
      const p = padXY(i, n)
      simToThree(pad.position, p[0], p[1], 0)
      this.fleet.add(pad)
    }
    for (let i = 0; i < MAX_DRONES; i++) this.slots.hide(i)
    this.slots.commit()
    this.wpRev = -1
  }

  clearTrails(): void {
    for (const t of this.trails) t.clear()
  }

  /** Mirror the sim into the scene. dt = 0 still refreshes poses (replay, pause). */
  sync(sim: SwarmSim, dt: number, o: SceneOpts): void {
    this.time += dt
    const vo = this.visOpts
    vo.vscale = o.vscale
    vo.time = this.time
    const lead = sim.renderLead
    for (let i = 0; i < this.visuals.length && i < sim.count; i++) {
      vo.leader = i === sim.leaderId
      this.visuals[i].update(sim.drones[i], dt, vo, lead)
    }
    this.syncTrails(sim, dt, o.trails)
    this.syncSlots(sim, o)
    this.syncWaypoints(sim, o.hover)
  }

  /** Append one trail sample for every armed drone (replay steps forward without dt). */
  pushTrails(sim: SwarmSim): void {
    for (let i = 0; i < this.trails.length && i < sim.count; i++) {
      const d = sim.drones[i]
      if (!d.armed) continue
      simToThree(tA, d.s[0], d.s[1], d.s[2])
      this.trails[i].push(tA.x, tA.y, tA.z)
    }
  }

  private syncTrails(sim: SwarmSim, dt: number, on: boolean): void {
    for (const t of this.trails) t.line.visible = on
    this.trailAcc += dt
    if (!on || this.trailAcc < 1 / TRAIL_HZ) return
    this.trailAcc = 0
    this.pushTrails(sim)
  }

  private syncSlots(sim: SwarmSim, o: SceneOpts): void {
    for (let i = 0; i < MAX_DRONES; i++) {
      const d = sim.drones[i]
      if (!o.slots || !d || d.mode !== 'flying') {
        this.slots.hide(i)
        continue
      }
      simToThree(tA, d.target[0], d.target[1], d.target[2])
      simToThree(tB, d.s[0], d.s[1], d.s[2])
      this.slots.place(i, tA, d.yawSp, o.vscale, d.trackErr > TETHER_MIN ? tB : null)
    }
    this.slots.commit()
  }

  private syncWaypoints(sim: SwarmSim, hover: number): void {
    const alt = sim.settings.cruiseAlt
    const closed = sim.settings.routeMode === 'loop'
    if (sim.wpRevision !== this.wpRev || alt !== this.wpAlt || closed !== this.wpClosed) {
      this.waypoints.layout(sim.waypoints, sim.wpCount, alt, closed)
      this.wpRev = sim.wpRevision
      this.wpAlt = alt
      this.wpClosed = closed
    }
    const active = sim.phase === 'mission' && !sim.route.done ? sim.route.target : -1
    this.waypoints.highlight(active, sim.wpCount, this.time, hover)
  }

  private disposeFleet(): void {
    for (const v of this.visuals) v.dispose()
    for (const t of this.trails) t.dispose()
    for (const r of this.fleetOwn) r.dispose()
    this.visuals = []
    this.trails = []
    this.fleetOwn = []
    this.fleet.clear()
  }

  dispose(): void {
    this.disposeFleet()
    this.waypoints.dispose()
    this.slots.dispose()
    this.frameGeo.dispose()
    disposeKit(this.kit)
    this.root.clear()
  }
}
