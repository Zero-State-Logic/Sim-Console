import { useEffect } from 'react'
import { openCodegenDialog } from '../../codegen/ui'
import { useHardware } from '../../core/hardware'
import { useConsole } from '../../store'
import { hardwareBridge } from '../index'
import { useBridge } from '../store'
import { canEstop, canHome, escEstops } from '../view/status'
import { supportNotices, transportOptions } from '../view/transports'
import { ConnectForm } from './ConnectForm'
import { isTyping, useBrowserEnv } from './hooks'
import { LevelControl } from './LevelControl'
import { DeviceInfo, ErrorBox, LinkStats, StateHint, StatePill } from './LinkCard'

/*
 * Right rail under the DRIVE SOURCE switch while the source is HARDWARE:
 * link state, E-STOP / HOME, transport + board + connect, device info, link stats,
 * command level with the bandwidth note, feature notices and the firmware generator.
 */

/** ESC is an E-STOP while the robot could be moving (not while typing in a field). */
function useEscapeEstop(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape' || e.repeat || isTyping(document.activeElement)) return
      const st = useBridge.getState()
      if (st.attached && escEstops(st.state, st.error?.code ?? null)) hardwareBridge.estop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function SafetyRow() {
  const state = useBridge((s) => s.state)
  const code = useBridge((s) => s.error?.code ?? null)
  const attached = useBridge((s) => s.attached)
  const estopOn = attached && canEstop(state)
  return (
    <div className="hw-safety">
      <button
        type="button"
        className={`hw-estop${state === 'estopped' ? ' latched' : ''}`}
        disabled={!estopOn}
        onClick={() => hardwareBridge.estop()}
        title={state === 'estopped' ? 'Send E-STOP again' : 'Stop streaming and stop the board (ESC)'}
      >
        <span className="big">E-STOP</span>
        <span className="kbd">{state === 'estopped' ? 'LATCHED · HOME TO RE-ARM' : 'ESC'}</span>
      </button>
      <button
        type="button"
        className="hw-btn home"
        disabled={!attached || !canHome(state, code)}
        onClick={() => hardwareBridge.home()}
        title="Send home: the board eases to its safe pose and acks"
      >
        HOME
      </button>
    </div>
  )
}

function Notices() {
  const board = useHardware((s) => s.config.board)
  const notices = supportNotices(transportOptions(board, useBrowserEnv()))
  if (notices.length === 0) return null
  return (
    <ul className="hw-notices">
      {notices.map((n) => (
        <li key={n}>{n}</li>
      ))}
      <li>VIRTUAL DEVICE works in every browser.</li>
    </ul>
  )
}

function Footer() {
  const drawerOpen = useConsole((s) => s.drawerOpen)
  return (
    <div className="hw-row">
      <button type="button" className="hw-btn" onClick={openCodegenDialog} title="Generate kiyobridge firmware for this robot and board">
        GENERATE FIRMWARE
      </button>
      <button type="button" className="hw-btn" aria-pressed={drawerOpen} onClick={() => useConsole.getState().setDrawerOpen(!drawerOpen)}>
        {drawerOpen ? 'HIDE MONITOR' : 'MONITOR'}
      </button>
    </div>
  )
}

export function HardwarePanel() {
  useEscapeEstop()
  const attached = useBridge((s) => s.attached)
  return (
    <div className="hw">
      <StatePill />
      <StateHint />
      <SafetyRow />
      <ErrorBox />
      <ConnectForm />
      {attached && <DeviceInfo />}
      {attached && <LinkStats />}
      <LevelControl />
      <Notices />
      <Footer />
    </div>
  )
}
