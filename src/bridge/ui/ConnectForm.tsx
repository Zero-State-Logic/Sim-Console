import { useState } from 'react'
import { BOARDS, useHardware } from '../../core/hardware'
import type { BoardId, TransportId } from '../../core/protocol'
import { runtime } from '../../core/runtime'
import { hardwareBridge } from '../index'
import { checkWsUrl, RELAY_URL } from '../link/env'
import { useBridge } from '../store'
import { BAUD_RATES, transportAfterBoardChange, transportOptions, visibleTransports } from '../view/transports'
import { useBrowserEnv } from './hooks'

/* Transport picker, board, per-transport settings and CONNECT / DISCONNECT. */

const BOARD_LIST = Object.values(BOARDS)

function pageLocation(): { protocol: string; hostname: string } {
  return typeof location === 'undefined' ? { protocol: 'http:', hostname: 'localhost' } : { protocol: location.protocol, hostname: location.hostname }
}

function TransportPicker({ locked }: { locked: boolean }) {
  const cfg = useHardware((s) => s.config)
  const env = useBrowserEnv()
  const options = visibleTransports(transportOptions(cfg.board, env))
  return (
    <div className="hw-transports" role="radiogroup" aria-label="Transport">
      {options.map((o) => {
        const on = cfg.transport === o.id
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={locked}
            className={`hw-tp${on ? ' on' : ''}${o.supported ? '' : ' unsupported'}${o.id === 'loopback' ? ' virtual' : ''}`}
            title={o.reason ?? o.label}
            onClick={() => useHardware.getState().setConfig({ transport: o.id })}
          >
            <span className="l">{o.label}</span>
            <span className="s">{o.supported ? o.sub : 'not in this browser'}</span>
          </button>
        )
      })}
    </div>
  )
}

function BoardSelect({ locked }: { locked: boolean }) {
  const cfg = useHardware((s) => s.config)
  const onChange = (board: BoardId): void => {
    const prev: TransportId = useHardware.getState().config.transport
    useHardware.getState().setBoard(board)
    const keep = transportAfterBoardChange(prev, board)
    if (useHardware.getState().config.transport !== keep) useHardware.getState().setConfig({ transport: keep })
  }
  return (
    <label className="hw-field">
      <span>BOARD</span>
      <select value={cfg.board} disabled={locked} onChange={(e) => onChange(e.target.value as BoardId)}>
        {BOARD_LIST.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function SerialFields({ locked }: { locked: boolean }) {
  const baud = useHardware((s) => s.config.baud)
  const rates = BAUD_RATES.includes(baud) ? BAUD_RATES : [...BAUD_RATES, baud].sort((a, b) => a - b)
  return (
    <label className="hw-field">
      <span>BAUD</span>
      <select value={baud} disabled={locked} onChange={(e) => useHardware.getState().setConfig({ baud: Number(e.target.value) })}>
        {rates.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </label>
  )
}

function BleFields({ locked }: { locked: boolean }) {
  const name = useHardware((s) => s.config.bleName)
  return (
    <label className="hw-field">
      <span>BLE NAME</span>
      <input
        type="text"
        value={name}
        maxLength={24}
        disabled={locked}
        spellCheck={false}
        placeholder="name prefix (empty = any)"
        onChange={(e) => useHardware.getState().setConfig({ bleName: e.target.value })}
      />
    </label>
  )
}

function WsFields({ locked }: { locked: boolean }) {
  const url = useHardware((s) => s.config.wsUrl)
  const check = checkWsUrl(url, pageLocation())
  return (
    <>
      <label className="hw-field">
        <span>WS URL</span>
        <input
          type="url"
          value={url}
          disabled={locked}
          spellCheck={false}
          placeholder="ws://192.168.4.1:81"
          onChange={(e) => useHardware.getState().setConfig({ wsUrl: e.target.value })}
        />
      </label>
      {!check.ok && (
        <div className={`hw-note${check.reason === 'mixed-content' ? ' warn' : ' bad'}`}>
          <b>{check.message}</b>
          {check.guidance.length > 0 && (
            <ul>
              {check.guidance.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
          {check.reason === 'mixed-content' && (
            <button
              type="button"
              className="hw-link"
              disabled={locked}
              title="Then paste the key the relay printed after ?k="
              onClick={() => useHardware.getState().setConfig({ wsUrl: `${RELAY_URL}/?k=` })}
            >
              USE THE LOCAL RELAY URL (ADD ITS KEY)
            </button>
          )}
        </div>
      )}
    </>
  )
}

function VirtualFields({ locked }: { locked: boolean }) {
  const miscal = useBridge((s) => s.miscalibrate)
  return (
    <>
      <label className="hw-check">
        <input type="checkbox" checked={miscal} disabled={locked} onChange={(e) => hardwareBridge.setMiscalibrate(e.target.checked)} />
        <span>Servo mounting error (for the calibration demo)</span>
      </label>
      <p className="hw-hint">An in-browser emulation of the generated firmware: hello, home, watchdog, telemetry. No board needed.</p>
    </>
  )
}

function TransportFields({ id, locked }: { id: TransportId; locked: boolean }) {
  if (id === 'serial') return <SerialFields locked={locked} />
  if (id === 'ble') return <BleFields locked={locked} />
  if (id === 'ws') return <WsFields locked={locked} />
  return <VirtualFields locked={locked} />
}

export function ConnectForm() {
  const cfg = useHardware((s) => s.config)
  const attached = useBridge((s) => s.attached)
  const state = useBridge((s) => s.state)
  const env = useBrowserEnv()
  const [busy, setBusy] = useState(false)
  const option = transportOptions(cfg.board, env).find((o) => o.id === cfg.transport)
  const wsBad = cfg.transport === 'ws' && !checkWsUrl(cfg.wsUrl, pageLocation()).ok
  const canConnect = !!option && option.onBoard && option.supported && !wsBad && !busy
  const onConnect = async (): Promise<void> => {
    setBusy(true)
    try {
      await hardwareBridge.connect(runtime.module)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hw-form">
      <TransportPicker locked={attached} />
      <BoardSelect locked={attached} />
      <TransportFields id={cfg.transport} locked={attached} />
      {attached ? (
        <button type="button" className="hw-btn wide" onClick={() => void hardwareBridge.disconnect()}>
          {state === 'connecting' ? 'CANCEL' : 'DISCONNECT'}
        </button>
      ) : (
        <button type="button" className="hw-btn wide primary" disabled={!canConnect} title={option?.reason} onClick={() => void onConnect()}>
          CONNECT
        </button>
      )}
    </div>
  )
}
