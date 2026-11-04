import * as THREE from 'three'
import { BaseModule } from '../core/BaseModule'
import type {
  CommandLevel,
  ControlDef,
  HardwareSpec,
  InstrumentLayout,
  RobotKind,
  StepContext,
  TelemetryFrame,
  WorldConfig,
} from '../core/types'
import type { CmdMsg, TelMsg } from '../core/protocol'

/*
 * Fallback module: a spinning block that satisfies the RobotModule contract. The
 * registry only uses it for a robot kind that has no module of its own.
 */
const SCHEMA: ControlDef[] = [
  { type: 'slider', key: 'speed', label: 'SPEED', group: 'PARAMETERS', min: 0, max: 3, step: 0.05, value: 1, unit: '×' },
]

const WORLD: WorldConfig = {
  gridCellSize: 0.1,
  gridSectionSize: 0.5,
  gridFadeDistance: 12,
  shadowScale: 3,
  minDistance: 0.4,
  maxDistance: 8,
  cameraPresets: [{ id: 'iso', label: 'ISO', position: [0.9, 0.7, 1.1], target: [0, 0.1, 0] }],
}

class PlaceholderModule extends BaseModule {
  readonly world = WORLD
  private mesh: THREE.Mesh
  private t = 0

  constructor(readonly kind: RobotKind, readonly label: string) {
    super()
    this.initValues(SCHEMA)
    const geo = this.track(new THREE.BoxGeometry(0.2, 0.08, 0.3))
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0xfbfbfc, roughness: 0.5 }))
    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.position.y = 0.1
    this.mesh.castShadow = true
    this.root.add(this.mesh)
  }

  update(dt: number, _ctx: StepContext): void {
    this.t += dt * this.num('speed', 1)
    this.mesh.rotation.y = this.t
  }

  reset(): void {
    this.t = 0
  }

  getControlSchema(): ControlDef[] {
    return SCHEMA
  }

  getInstrumentLayout(): InstrumentLayout {
    return {
      title: this.label,
      subtitle: 'PLACEHOLDER',
      gauges: [{ key: 'speed', label: 'Speed %', color: 'var(--accent)' }],
      charts: [{ key: 'osc', title: 'SIGNAL', unit: 'arb', min: -1, max: 1, channels: [{ key: 'sin', label: 'sin', color: '#FF5A1F' }] }],
      readouts: [],
    }
  }

  getTelemetry(): TelemetryFrame {
    return {
      t: this.t,
      gauges: { speed: (this.num('speed', 1) / 3) * 100 },
      channels: { sin: Math.sin(this.t * 3) },
      bars: [],
      readouts: {},
    }
  }

  getHardwareSpec(): HardwareSpec {
    return {
      robot: this.kind,
      joints: 1,
      jointNames: ['J1'],
      jointLimits: [[-90, 90]],
      homePose: [0],
      defaultLevel: { wired: 'joint', wireless: 'high' },
    }
  }

  buildCommand(_level: CommandLevel): CmdMsg {
    return { t: 'cmd', q: [0] }
  }

  applyTelemetry(_tel: TelMsg): void {}
}

export function createPlaceholder(kind: RobotKind, label: string): PlaceholderModule {
  return new PlaceholderModule(kind, label)
}
