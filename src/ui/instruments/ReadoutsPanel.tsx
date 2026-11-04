import { useRef } from 'react'
import { telemetryBus } from '../../core/telemetryBus'
import type { ReadoutDef } from '../../core/types'
import { useRaf } from '../useRaf'
import { formatControlValue } from '../controls/controlMath'

/* Two-column grid of labelled numeric/text readouts, refreshed at 15 Hz. */
export default function ReadoutsPanel({ defs }: { defs: ReadoutDef[] }) {
  const cells = useRef<(HTMLElement | null)[]>([])
  const shown = useRef<string[]>([])

  useRaf(() => {
    const r = telemetryBus.current.readouts
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i]
      const v = r[d.key]
      const text = typeof v === 'number' ? formatControlValue(v, d.digits ?? 2) : v ?? '—'
      if (shown.current[i] === text) continue
      shown.current[i] = text
      const el = cells.current[i]
      if (el) el.textContent = text
    }
  }, 15)

  return (
    <section className="panel reg">
      <h3>READOUTS <span className="u">{defs.length}</span></h3>
      <dl className="readouts">
        {defs.map((d, i) => (
          <div className="ro" key={d.key}>
            <dt>{d.label}</dt>
            <dd>
              <b ref={(el) => { cells.current[i] = el }}>—</b>
              {d.unit && <span className="u">{d.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
