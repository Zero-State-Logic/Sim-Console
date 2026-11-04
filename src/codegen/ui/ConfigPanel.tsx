import type { HardwareConfig } from '../../core/hardware'
import type { BoardId } from '../../core/protocol'
import type { CommandLevel, HardwareSpec } from '../../core/types'
import { BLE_NAME_MAX, SSID_MAX } from '../validate'
import { NumberInput, Row, Section, Segmented, TextInput } from './fields'
import {
  BAUD_RATES,
  boardChoices,
  driverChoices,
  effectiveTransport,
  levelChoices,
  patchForDriver,
  transportChoices,
} from './model'
import type { LinkTransport } from './model'
import PinTable from './PinTable'

/* ============================================================
   CONFIG COLUMN — target (board, transport, output, level), link
   settings, timing and the pin table. Every edit is written to the
   shared hardware profile (useHardware), except the level, which
   only the firmware cares about.
   ============================================================ */

interface Props {
  spec: HardwareSpec
  hw: HardwareConfig
  level: CommandLevel
  onLevel: (l: CommandLevel) => void
  onBoard: (b: BoardId) => void
  onTransport: (t: LinkTransport) => void
  onPatch: (patch: Partial<HardwareConfig>) => void
}

function LinkSettings({ hw, transport, onPatch }: { hw: HardwareConfig; transport: LinkTransport; onPatch: Props['onPatch'] }) {
  if (transport === 'serial') {
    const cdc = hw.board === 'pico' || hw.board === 'picow' || hw.board === 'pizero2w'
    return (
      <Row label="BAUD" note={cdc ? 'Native USB ignores the baud; it is kept for the app side.' : 'Both ends must match. 921600 for streaming every joint.'}>
        <select className="cg-input" value={hw.baud} onChange={(e) => onPatch({ baud: Number(e.target.value) })} aria-label="Baud rate">
          {[...new Set([...BAUD_RATES, hw.baud])].sort((a, b) => a - b).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </Row>
    )
  }
  if (transport === 'ble') {
    return (
      <Row label="BLE NAME" note="Shown in the browser's Bluetooth picker. Nordic UART Service.">
        <TextInput value={hw.bleName} maxLength={BLE_NAME_MAX} ariaLabel="BLE device name" onCommit={(v) => onPatch({ bleName: v })} />
      </Row>
    )
  }
  if (hw.board === 'pizero2w') {
    return <p className="cg-note block">The Pi joins the WiFi you set in Raspberry Pi Imager and serves ws://&lt;pi&gt;:81.</p>
  }
  return (
    <>
      <Segmented
        label="WIFI MODE"
        value={hw.wifiMode}
        choices={[
          { value: 'ap', label: 'ACCESS POINT', hint: 'The board makes its own network (192.168.4.1)' },
          { value: 'sta', label: 'JOIN NETWORK', hint: 'The board joins your router and prints its IP' },
        ]}
        onChange={(m) => onPatch({ wifiMode: m })}
      />
      <Row label="SSID" note="The password is never stored: type it into kiyobridge.h where it says CHANGE_ME.">
        <TextInput value={hw.wifiSsid} maxLength={SSID_MAX} ariaLabel="WiFi SSID" onCommit={(v) => onPatch({ wifiSsid: v })} />
      </Row>
    </>
  )
}

function Timing({ hw, swarm, onPatch }: { hw: HardwareConfig; swarm: boolean; onPatch: Props['onPatch'] }) {
  return (
    <div className="cg-grid2">
      <Row label="CMD HZ">
        <NumberInput value={hw.commandHz} min={1} max={500} ariaLabel="Command rate" onCommit={(v) => onPatch({ commandHz: Math.round(v) })} />
      </Row>
      <Row label="TEL HZ">
        <NumberInput value={hw.telemetryHz} min={1} max={200} ariaLabel="Telemetry rate" onCommit={(v) => onPatch({ telemetryHz: Math.round(v) })} />
      </Row>
      <Row label="WATCHDOG MS">
        <NumberInput value={hw.watchdogMs} min={50} max={60000} step={50} ariaLabel="Watchdog timeout" onCommit={(v) => onPatch({ watchdogMs: Math.round(v) })} />
      </Row>
      <Row label="ON TIMEOUT">
        <select className="cg-input" value={hw.watchdogAction} aria-label="Watchdog action" onChange={(e) => onPatch({ watchdogAction: e.target.value === 'relax' ? 'relax' : 'hold' })}>
          <option value="hold">{swarm ? 'HOLD POSITION' : 'HOLD POSE'}</option>
          <option value="relax">{swarm ? 'LAND' : 'RELAX (OFF)'}</option>
        </select>
      </Row>
      {swarm ? null : (
        <>
          <Row label="PULSE MIN µS">
            <NumberInput value={hw.servoMinUs} min={100} max={3000} step={10} ariaLabel="Minimum pulse" onCommit={(v) => onPatch({ servoMinUs: Math.round(v) })} />
          </Row>
          <Row label="PULSE MAX µS">
            <NumberInput value={hw.servoMaxUs} min={100} max={3000} step={10} ariaLabel="Maximum pulse" onCommit={(v) => onPatch({ servoMaxUs: Math.round(v) })} />
          </Row>
          <Row label="SERVO TRAVEL °">
            <NumberInput value={hw.servoRangeDeg} min={1} max={360} ariaLabel="Servo travel" onCommit={(v) => onPatch({ servoRangeDeg: v })} />
          </Row>
        </>
      )}
    </div>
  )
}

export default function ConfigPanel({ spec, hw, level, onLevel, onBoard, onTransport, onPatch }: Props) {
  const transport = effectiveTransport(hw)
  const swarm = spec.robot === 'swarm'
  const outputs = spec.robot === 'sweeper' ? `${spec.joints} MOTORS` : swarm ? 'ESP-NOW' : `${spec.joints} SERVOS`
  return (
    <div className="cg-config">
      <Section title="TARGET" sub={`${spec.robot.toUpperCase()} · ${outputs}`}>
        <Segmented label="BOARD" value={hw.board} choices={boardChoices(spec.robot)} onChange={onBoard} />
        <Segmented label="TRANSPORT" value={transport} choices={transportChoices(hw.board)} onChange={onTransport} />
        {swarm ? null : (
          <Segmented label="OUTPUT" value={hw.servoDriver} choices={driverChoices(hw.board, spec.joints)} onChange={(d) => onPatch(patchForDriver(hw, d, spec.joints))} />
        )}
        <Segmented label="LEVEL" value={swarm ? 'high' : level} choices={levelChoices(spec.robot)} onChange={onLevel} />
      </Section>
      <Section title="LINK" sub={transport.toUpperCase()}>
        <LinkSettings hw={hw} transport={transport} onPatch={onPatch} />
      </Section>
      <Section title="TIMING" sub="WATCHDOG · PULSES">
        <Timing hw={hw} swarm={swarm} onPatch={onPatch} />
      </Section>
      <Section title={swarm ? 'DRONES' : 'WIRING'} sub={swarm ? `${spec.joints} DRONES` : hw.servoDriver === 'pca9685' ? 'PCA9685 CHANNELS' : 'GPIO PINS'}>
        <PinTable spec={spec} hw={hw} serial={transport === 'serial'} onPatch={onPatch} />
      </Section>
    </div>
  )
}
