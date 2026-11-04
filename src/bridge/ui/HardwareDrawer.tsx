import * as Tabs from '@radix-ui/react-tabs'
import { useState } from 'react'
import { useBridge } from '../store'
import { formatRate } from '../view/link'
import { pillView } from '../view/status'
import { CalibrationTab } from './CalibrationTab'
import { SerialMonitor } from './SerialMonitor'
import { TelemetryTab } from './TelemetryTab'

/* Bottom drawer while the source is HARDWARE: SERIAL MONITOR · TELEMETRY · CALIBRATION. */

type TabId = 'monitor' | 'telemetry' | 'calibration'
const TAB_KEY = 'simconsole.bridge.tab'

function readTab(): TabId {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'telemetry' || v === 'calibration' ? v : 'monitor'
  } catch {
    return 'monitor'
  }
}

function saveTab(t: TabId): void {
  try {
    localStorage.setItem(TAB_KEY, t)
  } catch {
    /* storage unavailable: the tab just is not remembered */
  }
}

function LinkSummary() {
  const state = useBridge((s) => s.state)
  const stale = useBridge((s) => s.stale)
  const rtt = useBridge((s) => s.rttMs)
  const rx = useBridge((s) => s.rxLinesPerSec)
  const tx = useBridge((s) => s.txLinesPerSec)
  const v = pillView(state, stale)
  return (
    <div className="hw-drawsum mono">
      <span className={`hw-pill sm tone-${v.tone}`}>
        <span className={`hw-dot${v.pulse ? ' pulse' : ''}`} aria-hidden="true" />
        {v.label}
      </span>
      <span>RTT {rtt === null ? '—' : `${rtt.toFixed(0)} ms`}</span>
      <span>RX {formatRate(rx)}/s</span>
      <span>TX {formatRate(tx)}/s</span>
    </div>
  )
}

export function HardwareDrawer() {
  const [tab, setTab] = useState<TabId>(readTab)
  const onChange = (v: string): void => {
    const t: TabId = v === 'telemetry' || v === 'calibration' ? v : 'monitor'
    setTab(t)
    saveTab(t)
  }
  return (
    <Tabs.Root className="hw-drawer" value={tab} onValueChange={onChange}>
      <div className="hw-tabbar">
        <Tabs.List className="hw-tablist" aria-label="Hardware tools">
          <Tabs.Trigger className="hw-tab" value="monitor">
            SERIAL MONITOR
          </Tabs.Trigger>
          <Tabs.Trigger className="hw-tab" value="telemetry">
            TELEMETRY
          </Tabs.Trigger>
          <Tabs.Trigger className="hw-tab" value="calibration">
            CALIBRATION
          </Tabs.Trigger>
        </Tabs.List>
        <LinkSummary />
      </div>
      <Tabs.Content className="hw-tabpanel" value="monitor">
        <SerialMonitor />
      </Tabs.Content>
      <Tabs.Content className="hw-tabpanel" value="telemetry">
        <TelemetryTab />
      </Tabs.Content>
      <Tabs.Content className="hw-tabpanel" value="calibration">
        <CalibrationTab />
      </Tabs.Content>
    </Tabs.Root>
  )
}
