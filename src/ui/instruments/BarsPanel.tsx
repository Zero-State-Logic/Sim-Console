import { useRef } from 'react'
import { telemetryBus } from '../../core/telemetryBus'
import type { BarsDef } from '../../core/types'
import { useRaf } from '../useRaf'
import { formatControlValue } from '../controls/controlMath'
import { categoricalColor } from './color'

/*
 * Per-item bars (leg load, wheel speed, drone thrust). Item colors come from the module
 * or the per-leg tokens; a value at or past the bar's max switches to the overload color.
 */
const OVERLOAD_AT = 0.98

export default function BarsPanel({ def }: { def: BarsDef }) {
  const fills = useRef<(HTMLSpanElement | null)[]>([])
  const nums = useRef<(HTMLSpanElement | null)[]>([])
  const rows = useRef<(HTMLDivElement | null)[]>([])
  const shown = useRef<string[]>([])
  const max = def.max > 0 ? def.max : 1

  useRaf(() => {
    const vals = telemetryBus.current.bars
    for (let i = 0; i < def.labels.length; i++) {
      const v = vals[i] ?? 0
      const f = Math.min(Math.max(v / max, 0), 1)
      const text = formatControlValue(v, max <= 10 ? 2 : 0)
      const key = `${text}|${f.toFixed(3)}`
      if (shown.current[i] === key) continue
      shown.current[i] = key
      const fill = fills.current[i]
      if (fill) fill.style.transform = `scaleX(${f.toFixed(4)})`
      const num = nums.current[i]
      if (num) num.textContent = text
      rows.current[i]?.classList.toggle('over', v >= max * OVERLOAD_AT)
    }
  })

  return (
    <section className="panel reg">
      <h3>
        {def.title} <span className="u">{def.unit}</span>
      </h3>
      <div className="bars">
        {def.labels.map((label, i) => {
          const color = def.colors?.[i] ?? categoricalColor(i)
          return (
            <div className="barrow" key={`${label}-${i}`} ref={(el) => { rows.current[i] = el }}>
              <span className="id" style={{ color }}>{label}</span>
              <span className="bt" aria-hidden="true">
                <span className="bf" style={{ background: color }} ref={(el) => { fills.current[i] = el }} />
              </span>
              <span className="pc" ref={(el) => { nums.current[i] = el }}>0</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
