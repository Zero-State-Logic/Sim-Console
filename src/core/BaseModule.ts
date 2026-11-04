import * as THREE from 'three'
import type {
  CommandLevel,
  ControlDef,
  ControlValue,
  HardwareSpec,
  InstrumentLayout,
  RobotKind,
  RobotModule,
  SandboxCommand,
  SandboxFnDef,
  SensorSnapshot,
  StepContext,
  TelemetryFrame,
  TelemetryTable,
  WorldConfig,
} from './types'
import type { CmdMsg, TelMsg } from './protocol'

interface Disposable {
  dispose(): void
}

/**
 * Optional base class for robot modules. It owns the control-value map, revision
 * counter and disposal bookkeeping, and gives safe defaults for the optional parts of
 * the contract. Subclasses implement the robot.
 */
export abstract class BaseModule implements RobotModule {
  abstract readonly kind: RobotKind
  abstract readonly label: string
  abstract readonly world: WorldConfig
  readonly root = new THREE.Group()
  revision = 0

  protected values: Record<string, ControlValue> = {}
  private disposables: Disposable[] = []

  /** Seed `values` from the defaults in a schema (keeps values that already exist). */
  protected initValues(schema: ControlDef[]): void {
    const next: Record<string, ControlValue> = { ...this.values }
    for (const d of schema) {
      if (d.type === 'button' || d.key in next) continue
      next[d.key] = d.value
    }
    this.values = next
  }

  protected bumpRevision(): void {
    this.revision++
  }

  /** Register a geometry/material/texture for disposal. Returns it for chaining. */
  protected track<T extends Disposable>(d: T): T {
    this.disposables.push(d)
    return d
  }

  protected num(key: string, fallback = 0): number {
    const v = this.values[key]
    return typeof v === 'number' ? v : fallback
  }

  protected str(key: string, fallback = ''): string {
    const v = this.values[key]
    return typeof v === 'string' ? v : fallback
  }

  protected bool(key: string, fallback = false): boolean {
    const v = this.values[key]
    return typeof v === 'boolean' ? v : fallback
  }

  getControlValues(): Record<string, ControlValue> {
    return { ...this.values }
  }

  setControl(key: string, value: ControlValue): void {
    const schema = this.getControlSchema().find((d) => d.key === key)
    if (!schema) return
    if (schema.type !== 'button') this.values = { ...this.values, [key]: value }
    this.onControl(key, value)
  }

  /** Hook for reacting to a control change (rebuild legs, fire a button, ...). */
  protected onControl(_key: string, _value: ControlValue): void {}

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.root.removeFromParent()
    this.root.clear()
  }

  followTarget(): THREE.Vector3 | null {
    return null
  }

  snapshot(): unknown {
    return null
  }

  restore(_s: unknown): void {}

  serializeConfig(): unknown {
    return null
  }

  loadConfig(_c: unknown): void {}

  telemetryTable(_tel: TelMsg | null): TelemetryTable {
    return { cols: [], rows: [] }
  }

  getSandboxApi(): SandboxFnDef[] {
    return []
  }

  getSandboxSensors(): SensorSnapshot {
    return {}
  }

  applySandboxCommands(_cmds: SandboxCommand[]): void {}

  releaseSandbox(): void {}

  abstract update(dt: number, ctx: StepContext): void
  abstract reset(): void
  abstract getControlSchema(): ControlDef[]
  abstract getInstrumentLayout(): InstrumentLayout
  abstract getTelemetry(): TelemetryFrame
  abstract getHardwareSpec(): HardwareSpec
  abstract buildCommand(level: CommandLevel): CmdMsg
  abstract applyTelemetry(tel: TelMsg): void
}
