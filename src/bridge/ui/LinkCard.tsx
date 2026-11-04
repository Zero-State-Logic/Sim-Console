import { runtime } from '../../core/runtime'
import { hardwareBridge } from '../index'
import { useBridge } from '../store'
import { canApplyControl, formatBytesPerSec, formatRate, switchPlan, type SwitchPlan } from '../view/link'
import { pillView } from '../view/status'
import { transportLabel } from '../view/transports'

/* Link status: the color-coded state pill, error guidance, device info and link stats. */

export function StatePill() {
  const state = useBridge((s) => s.state)
  const stale = useBridge((s) => s.stale)
  const transport = useBridge((s) => s.transport)
  const v = pillView(state, stale)
  return (
    <div className="hw-head">
      <div className={`hw-pill tone-${v.tone}`} role="status" aria-live="polite">
        <span className={`hw-dot${v.pulse ? ' pulse' : ''}`} aria-hidden="true" />
        {v.label}
      </div>
      {transport && state !== 'idle' && <span className="hw-via">{transportLabel(transport)}</span>}
    </div>
  )
}

export function StateHint() {
  const state = useBridge((s) => s.state)
  const stale = useBridge((s) => s.stale)
  return <p className="hw-hint">{pillView(state, stale).hint}</p>
}

function applySwitch(plan: SwitchPlan): void {
  if (runtime.module.kind !== plan.kind) runtime.setRobot(plan.kind)
  if (plan.control && canApplyControl(runtime.module.getControlSchema(), plan.control)) {
    runtime.setControl(plan.control.key, plan.control.value)
  }
}

export function ErrorBox() {
  const error = useBridge((s) => s.error)
  const canRetry = useBridge((s) => s.canRetry)
  if (!error) return null
  const plan = error.code === 'mismatch' && error.suggest ? switchPlan(error.suggest) : null
  return (
    <div className="hw-err" role="alert">
      <b>{error.message}</b>
      {error.detail && <p>{error.detail}</p>}
      <div className="hw-row">
        {plan && (
          <button type="button" className="hw-btn accent" onClick={() => applySwitch(plan)} title="Reshape the virtual robot to match what the board announced">
            {plan.label}
          </button>
        )}
        {canRetry && (
          <button type="button" className="hw-btn" onClick={() => hardwareBridge.retry()}>
            RETRY
          </button>
        )}
      </div>
    </div>
  )
}

export function DeviceInfo() {
  const hello = useBridge((s) => s.hello)
  if (!hello) return null
  const counts = [
    hello.legs !== undefined ? `${hello.legs} legs` : '',
    hello.wheels !== undefined ? `${hello.wheels} wheels` : '',
    hello.drones !== undefined ? `${hello.drones} drones` : '',
  ].filter(Boolean)
  return (
    <dl className="hw-kv">
      <dt>BOARD</dt>
      <dd>{hello.board}</dd>
      <dt>ROBOT</dt>
      <dd>
        {hello.robot}
        {counts.length > 0 && ` · ${counts.join(' · ')}`}
      </dd>
      <dt>JOINTS</dt>
      <dd>{hello.joints}</dd>
      <dt>FW</dt>
      <dd title={hello.fw}>{hello.fw ?? '—'}</dd>
      {hello.caps && hello.caps.length > 0 && (
        <>
          <dt>CAPS</dt>
          <dd className="hw-caps">{hello.caps.join(' ')}</dd>
        </>
      )}
    </dl>
  )
}

export function LinkStats() {
  const rtt = useBridge((s) => s.rttMs)
  const rx = useBridge((s) => s.rxLinesPerSec)
  const tx = useBridge((s) => s.txLinesPerSec)
  const rxB = useBridge((s) => s.rxBytesPerSec)
  const txB = useBridge((s) => s.txBytesPerSec)
  const dropped = useBridge((s) => s.droppedLines)
  const cmds = useBridge((s) => s.cmdCount)
  return (
    <div className="hw-stats">
      <div>
        <span>RTT</span>
        <b>{rtt === null ? '—' : `${rtt.toFixed(rtt < 10 ? 1 : 0)} ms`}</b>
      </div>
      <div title={formatBytesPerSec(rxB)}>
        <span>RX /s</span>
        <b>{formatRate(rx)}</b>
      </div>
      <div title={formatBytesPerSec(txB)}>
        <span>TX /s</span>
        <b>{formatRate(tx)}</b>
      </div>
      <div title="lines dropped by the framer or the validator">
        <span>DROP</span>
        <b className={dropped > 0 ? 'bad' : undefined}>{dropped}</b>
      </div>
      <div className="wide">
        <span>CMDS SENT</span>
        <b>{cmds}</b>
      </div>
      <div className="wide">
        <span>BYTES RX · TX</span>
        <b>
          {formatBytesPerSec(rxB)} · {formatBytesPerSec(txB)}
        </b>
      </div>
    </div>
  )
}
