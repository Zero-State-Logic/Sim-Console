import { useRef } from 'react'
import { runtime } from '../core/runtime'
import { useConsole } from '../store'
import type { InstrumentLayout } from '../core/types'
import BarsPanel from './instruments/BarsPanel'
import Gauge from './instruments/Gauge'
import ReadoutsPanel from './instruments/ReadoutsPanel'
import StreamChart from './instruments/StreamChart'

/*
 * Left rail: renders the module's InstrumentLayout generically. React only re-renders on
 * layoutRev; every instrument paints itself from the telemetry bus on its own rAF.
 * layoutRev also bumps for control-schema changes, so the layout object is kept while
 * its content is unchanged and the charts keep their history.
 */
function useStableLayout(): InstrumentLayout {
  useConsole((s) => s.layoutRev)
  const next = runtime.module.getInstrumentLayout()
  const cache = useRef<{ sig: string; layout: InstrumentLayout } | null>(null)
  const sig = `${runtime.module.kind}:${JSON.stringify(next)}`
  if (!cache.current || cache.current.sig !== sig) cache.current = { sig, layout: next }
  return cache.current.layout
}

export default function InstrumentRail() {
  const layout = useStableLayout()
  const compact = layout.gauges.length > 2

  return (
    <div className="rail-inner">
      {layout.gauges.length > 0 && (
        <section className="panel reg panel-hero">
          <h3>
            {layout.title} <span className="u">{layout.subtitle}</span>
          </h3>
          <div className={`gauges${compact ? ' compact' : ''}`}>
            {layout.gauges.map((g) => (
              <Gauge key={g.key} def={g} compact={compact} />
            ))}
          </div>
        </section>
      )}
      {layout.charts.map((c) => (
        <StreamChart key={c.key} def={c} />
      ))}
      {layout.bars && layout.bars.labels.length > 0 && <BarsPanel def={layout.bars} />}
      {layout.readouts.length > 0 && <ReadoutsPanel defs={layout.readouts} />}
    </div>
  )
}
