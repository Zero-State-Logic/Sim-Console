import { useHardware } from '../../core/hardware'
import type { CommandLevel } from '../../core/types'
import { hardwareBridge } from '../index'
import { useBridge } from '../store'
import { bandwidthNote } from '../view/link'
import { COMMAND_RATES } from '../view/transports'
import { useActiveSpec } from './hooks'

/* Command level (JOINT = stream every joint, HIGH = twist + gait) with the bandwidth estimate. */

const LEVELS: { id: CommandLevel | null; label: string; hint: string }[] = [
  { id: null, label: 'AUTO', hint: 'JOINT over USB / virtual, HIGH over BLE / WiFi' },
  { id: 'joint', label: 'JOINT', hint: 'Stream every joint target; the app runs the IK' },
  { id: 'high', label: 'HIGH', hint: 'Send body twist + gait; the board runs its own IK' },
]

function defaultLevel(spec: { defaultLevel: { wired: CommandLevel; wireless: CommandLevel } }, transport: string): CommandLevel {
  return transport === 'ble' || transport === 'ws' ? spec.defaultLevel.wireless : spec.defaultLevel.wired
}

export function LevelControl() {
  const spec = useActiveSpec()
  const cfg = useHardware((s) => s.config)
  const override = useBridge((s) => s.levelOverride)
  const cmdBytes = useBridge((s) => s.cmdBytes)
  const rxBps = useBridge((s) => s.rxBytesPerSec)
  const state = useBridge((s) => s.state)
  const linkTransport = useBridge((s) => s.transport)
  const transport = state !== 'idle' && linkTransport ? linkTransport : cfg.transport
  const level = override ?? defaultLevel(spec, transport)
  const note = bandwidthNote({
    spec,
    level,
    transport,
    baud: cfg.baud,
    commandHz: cfg.commandHz,
    measuredCmdBytes: state === 'live' ? cmdBytes : 0,
    rxBytesPerSec: state === 'idle' ? 0 : rxBps,
  })
  return (
    <div className="hw-level">
      <div className="hw-sublabel">
        COMMAND LEVEL <span>{level.toUpperCase()}</span>
      </div>
      <div className="hw-segs" role="radiogroup" aria-label="Command level">
        {LEVELS.map((l) => (
          <button
            key={l.label}
            type="button"
            role="radio"
            aria-checked={override === l.id}
            className={override === l.id ? 'on' : undefined}
            title={l.hint}
            onClick={() => hardwareBridge.setLevelOverride(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="hw-sublabel">
        COMMAND RATE <span>{cfg.commandHz} Hz</span>
      </div>
      <div className="hw-segs" role="radiogroup" aria-label="Command rate">
        {COMMAND_RATES.map((hz) => (
          <button
            key={hz}
            type="button"
            role="radio"
            aria-checked={cfg.commandHz === hz}
            className={cfg.commandHz === hz ? 'on' : undefined}
            onClick={() => useHardware.getState().setConfig({ commandHz: hz })}
          >
            {hz}
          </button>
        ))}
      </div>
      {note && (
        <p className={`hw-bw${note.warn ? ' warn' : ''}`}>
          <span className="mono">{note.text}</span>
          {note.advice && <b>{note.advice}</b>}
        </p>
      )}
    </div>
  )
}
