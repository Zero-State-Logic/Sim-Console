import { useMemo, useRef, type CSSProperties } from 'react'
import { telemetryBus } from '../../core/telemetryBus'
import type { GaugeDef } from '../../core/types'
import { useRaf } from '../useRaf'
import { GAUGE_START_DEG, GAUGE_SWEEP_DEG, arcPoint, formatGaugeValue, gaugeArc, gaugeDigits, gaugeFraction, gaugeTicks } from './gaugeMath'

/*
 * 240° dial with a big mono readout, like the reference "52 / 42" gauges. The arc and
 * the value are written to the DOM on rAF, only when the shown value changes.
 */
const VIEW = 100
const CX = 50
const CY = 52
const R = 40
const TICKS = 12

export default function Gauge({ def, compact }: { def: GaugeDef; compact: boolean }) {
  const arc = useRef<SVGPathElement>(null)
  const knob = useRef<SVGCircleElement>(null)
  const val = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  const min = def.min ?? 0
  const max = def.max ?? 100
  const digits = gaugeDigits(min, max)
  const track = useMemo(() => gaugeArc(CX, CY, R, 1), [])
  const ticks = useMemo(() => gaugeTicks(CX, CY, R - 10, R - 7, TICKS), [])
  const [lx, ly] = arcPoint(CX, CY, R, GAUGE_START_DEG)
  const [rx, ry] = arcPoint(CX, CY, R, GAUGE_START_DEG - GAUGE_SWEEP_DEG)

  useRaf(() => {
    const raw = telemetryBus.current.gauges[def.key]
    const v = typeof raw === 'number' ? raw : Number.NaN
    const text = formatGaugeValue(v, digits)
    const f = gaugeFraction(v, min, max)
    const key = `${text}|${f.toFixed(3)}`
    if (key === last.current) return
    last.current = key
    if (val.current) val.current.textContent = text
    arc.current?.setAttribute('d', gaugeArc(CX, CY, R, f))
    const [kx, ky] = arcPoint(CX, CY, R, GAUGE_START_DEG - GAUGE_SWEEP_DEG * f)
    if (knob.current) {
      knob.current.setAttribute('cx', kx.toFixed(2))
      knob.current.setAttribute('cy', ky.toFixed(2))
      knob.current.style.opacity = Number.isFinite(v) ? '1' : '0'
    }
  })

  const size = compact ? 84 : 112
  return (
    <figure className={`gauge${compact ? ' compact' : ''}`} style={{ width: size, '--gs': `${size}px`, '--gc': def.color } as CSSProperties} aria-label={`${def.label}${def.unit ? ` (${def.unit})` : ''}`}>
      <svg width={size} height={size * 0.86} viewBox={`0 0 ${VIEW} ${VIEW * 0.86}`} aria-hidden="true">
        <path d={track} className="g-track" />
        {ticks.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={i % 3 === 0 ? 'g-tick major' : 'g-tick'} />
        ))}
        <path ref={arc} d="" className="g-arc" style={{ stroke: def.color }} />
        <circle ref={knob} r="3.6" cx={lx} cy={ly} className="g-knob" style={{ stroke: def.color, opacity: 0 }} />
        <text x={lx + 2} y={ly + 11} className="g-lim" textAnchor="middle">{formatGaugeValue(min, digits)}</text>
        <text x={rx - 2} y={ry + 11} className="g-lim" textAnchor="middle">{formatGaugeValue(max, digits)}</text>
      </svg>
      <div className="g-read">
        <span className="g-val" ref={val} style={{ color: def.color }}>—</span>
        {def.unit && <span className="g-unit">{def.unit}</span>}
      </div>
      <figcaption className="g-lab">{def.label}</figcaption>
    </figure>
  )
}
