import { useConsole } from '../store'
import type { RobotModule } from '../core/types'
import { selectCamera } from '../ui/actions'
import { FOLLOW_ID } from './cameraMath'

/* Camera preset buttons in the viewport's top-right corner. */
export default function CameraBar({ module }: { module: RobotModule }) {
  const active = useConsole((s) => s.cameraPreset)
  const presets = module.world.cameraPresets.filter((p) => p.id !== FOLLOW_ID)

  return (
    <div className="hud-cams" role="group" aria-label="Camera view">
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className={active === p.id ? 'on' : ''}
          aria-pressed={active === p.id}
          onClick={() => selectCamera(p.id)}
          title={`${p.label} view (C cycles)`}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        className={`follow${active === FOLLOW_ID ? ' on' : ''}`}
        aria-pressed={active === FOLLOW_ID}
        onClick={() => selectCamera(FOLLOW_ID)}
        title="Follow the robot (F)"
      >
        <span className="dot" aria-hidden="true" />
        FOLLOW
      </button>
    </div>
  )
}
