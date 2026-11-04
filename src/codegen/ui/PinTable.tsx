import type { HardwareConfig } from '../../core/hardware'
import type { HardwareSpec } from '../../core/types'
import { hex2, pcaAddress } from '../servoMap'
import { NumberInput, TextInput } from './fields'
import { parsePin, pinLabel, pinRowIssues, sweeperMotorPins, withEntry } from './model'

/* ============================================================
   PIN / CHANNEL TABLE — one row per joint (servo) or wheel
   (motor PWM). Edits go straight to useHardware.setConfig, so the
   bridge and the sandbox see the same wiring the firmware uses.
   ============================================================ */

interface Props {
  spec: HardwareSpec
  hw: HardwareConfig
  serial: boolean
  onPatch: (patch: Partial<HardwareConfig>) => void
}

function signalHint(hw: HardwareConfig, pin: number): string {
  if (hw.servoDriver !== 'pca9685' || pin < 0) return ''
  return `${hex2(pcaAddress(pin))} ch ${pin % 16}`
}

export default function PinTable({ spec, hw, serial, onPatch }: Props) {
  if (spec.robot === 'swarm') {
    return (
      <p className="cg-note block">
        The relay needs no wiring: it broadcasts setpoints to all {spec.drones ?? spec.joints} drones over ESP-NOW. Put a drone&apos;s MAC
        address in KIYO_DRONE_MAC (kiyobridge.h) to unicast instead.
      </p>
    )
  }
  const n = spec.joints
  const pins = hw.servoPins.slice(0, n)
  const bad = pinRowIssues(hw.board, hw.servoDriver, pins, serial)
  const motors = spec.robot === 'sweeper' ? sweeperMotorPins(hw) : null
  const pca = hw.servoDriver === 'pca9685'
  const pinHead = spec.robot === 'sweeper' ? (pca ? 'PWM CH' : 'PWM PIN') : pca ? 'CHANNEL' : 'PIN'

  const setPin = (j: number, text: string): boolean => {
    const pin = parsePin(hw.board, hw.servoDriver, text)
    if (pin === null) return false
    onPatch({ servoPins: withEntry(hw.servoPins, j, pin) })
    return true
  }

  return (
    <div className="cg-table-wrap">
      <table className="cg-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{spec.robot === 'sweeper' ? 'WHEEL' : 'JOINT'}</th>
            <th>{pinHead}</th>
            {motors ? <th>IN1 / IN2</th> : null}
            <th title="Servo or motor mounted the other way round">INV</th>
            <th title="Calibration offset, degrees">OFS °</th>
            <th title="Calibration scale">SCALE</th>
          </tr>
        </thead>
        <tbody>
          {pins.map((pin, j) => (
            <tr key={spec.jointNames[j] ?? j} className={bad.has(j) ? 'bad' : undefined}>
              <td className="idx">{j}</td>
              <td className="name">{spec.jointNames[j] ?? `J${j + 1}`}</td>
              <td>
                <TextInput value={pinLabel(hw.board, hw.servoDriver, pin)} onCommit={(t) => setPin(j, t)} ariaLabel={`${pinHead} for joint ${j}`} invalid={bad.has(j)} />
                {pca ? <span className="cg-sub">{signalHint(hw, pin)}</span> : null}
              </td>
              {motors ? (
                <td className="ro">
                  {pinLabel(hw.board, hw.servoDriver, motors.in1[j])} / {pinLabel(hw.board, hw.servoDriver, motors.in2[j])}
                </td>
              ) : null}
              <td>
                <input
                  type="checkbox"
                  className="cg-check"
                  checked={hw.jointInvert[j] ?? false}
                  aria-label={`Invert joint ${j}`}
                  onChange={(e) => onPatch({ jointInvert: withEntry(hw.jointInvert, j, e.target.checked) })}
                />
              </td>
              <td>
                <NumberInput value={hw.jointOffsetDeg[j] ?? 0} min={-90} max={90} step={0.5} ariaLabel={`Offset of joint ${j}`} onCommit={(v) => onPatch({ jointOffsetDeg: withEntry(hw.jointOffsetDeg, j, v) })} />
              </td>
              <td>
                <NumberInput value={hw.jointScale[j] ?? 1} min={-3} max={3} step={0.01} ariaLabel={`Scale of joint ${j}`} onCommit={(v) => onPatch({ jointScale: withEntry(hw.jointScale, j, v) })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {motors ? <p className="cg-note block">Standby (STBY): {pinLabel(hw.board, hw.servoDriver, motors.stby)}. Direction lines are picked from free pins; the wiring table in README_FIRMWARE.md lists them all.</p> : null}
      {bad.size ? <p className="cg-note block bad">Rows marked red need another pin: the errors panel says why.</p> : null}
    </div>
  )
}
