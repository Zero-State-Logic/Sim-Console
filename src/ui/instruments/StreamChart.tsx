import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { telemetryBus } from '../../core/telemetryBus'
import { recorder } from '../../core/recorder'
import { runtime } from '../../core/runtime'
import type { ChartDef } from '../../core/types'
import { resolveCssColor } from '../dom'
import { formatControlValue } from '../controls/controlMath'
import { withAlpha } from './color'
import { SeriesBuffer, autoRange } from './series'

/*
 * Streaming multi-channel chart on uPlot. Samples the telemetry bus on its own rAF keyed
 * on sim time, so it holds still while paused. During replay it shows the recorded
 * window ending at the cursor. Hovering reads values at the cursor in the legend chips.
 */
const HEIGHT = 112
const DEFAULT_WINDOW_S = 6
const LEGEND_HZ = 10
const AXIS_FONT = '500 9px "JetBrains Mono", ui-monospace, monospace'

function axisFormat(v: number, span: number): string {
  const d = span < 0.1 ? 3 : span < 2 ? 2 : span < 20 ? 1 : 0
  return formatControlValue(v, d)
}

function buildOptions(def: ChartDef, width: number, series: SeriesBuffer, view: { tEnd: number; hover: number | null }): uPlot.Options {
  const windowSec = def.windowSec ?? DEFAULT_WINDOW_S
  const colors = def.channels.map((c) => resolveCssColor(c.color))
  const ink = resolveCssColor('var(--ink-2)')
  const grid = resolveCssColor('var(--line)')
  const axisBase = { stroke: ink, font: AXIS_FONT, grid: { stroke: grid, width: 1 }, ticks: { show: false }, gap: 4 }
  return {
    width,
    height: HEIGHT,
    legend: { show: false },
    cursor: {
      drag: { x: false, y: false, setScale: false },
      points: { show: false },
      y: false,
    },
    select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    scales: {
      x: { time: false, range: () => [view.tEnd - windowSec, view.tEnd] },
      y: { range: () => autoRange(series.ys, def.min, def.max) },
    },
    axes: [
      { ...axisBase, size: 20, space: 46, values: (_u, splits) => splits.map((s) => `${formatControlValue(s, 0)}s`) },
      {
        ...axisBase,
        size: 38,
        space: 22,
        values: (u, splits) => {
          const sc = u.scales.y
          const span = (sc.max ?? 1) - (sc.min ?? 0)
          return splits.map((s) => axisFormat(s, span))
        },
      },
    ],
    series: [
      {},
      ...def.channels.map((c, i) => ({
        label: c.label,
        stroke: colors[i],
        width: i === 0 ? 1.75 : 1.25,
        fill: i === 0 ? withAlpha(colors[i], 0.1) : undefined,
        points: { show: false },
      })),
    ],
    hooks: {
      setCursor: [
        (u: uPlot) => {
          view.hover = u.cursor.idx ?? null
        },
      ],
    },
  }
}

export default function StreamChart({ def }: { def: ChartDef }) {
  const host = useRef<HTMLDivElement>(null)
  const chipVals = useRef<(HTMLElement | null)[]>([])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const windowSec = def.windowSec ?? DEFAULT_WINDOW_S
    const keys = def.channels.map((c) => c.key)
    const series = new SeriesBuffer(keys.length, windowSec)
    const view = { tEnd: 0, hover: null as number | null }
    const plot = new uPlot(buildOptions(def, Math.max(el.clientWidth, 120), series, view), series.data as unknown as uPlot.AlignedData, el)
    const live = (i: number): number => telemetryBus.current.channels[keys[i]] ?? Number.NaN
    let lastCursor = Number.NaN
    let wasReplaying = false
    let lastLegend = 0
    let id = 0

    const writeLegend = (now: number): void => {
      if (now - lastLegend < 1000 / LEGEND_HZ) return
      lastLegend = now
      const row = view.hover !== null && view.hover < series.length ? view.hover : series.length - 1
      for (let i = 0; i < keys.length; i++) {
        const cell = chipVals.current[i]
        if (cell) cell.textContent = row >= 0 ? formatControlValue(series.ys[i][row], 2) : '—'
      }
    }

    const loadReplay = (cursor: number): void => {
      const end = recorder.indexAt(cursor)
      const start = Math.max(recorder.indexAt(cursor - windowSec) - 1, 0)
      series.load(
        end - start + 1,
        (r) => recorder.frameAt(start + r)?.t ?? Number.POSITIVE_INFINITY,
        (r, ch) => recorder.frameAt(start + r)?.tel.channels[keys[ch]] ?? Number.NaN,
        cursor,
      )
    }

    const tick = (now: number): void => {
      let changed = false
      if (recorder.isReplaying()) {
        const cursor = recorder.cursor()
        if (cursor !== lastCursor || !wasReplaying) {
          lastCursor = cursor
          loadReplay(cursor)
          view.tEnd = cursor
          changed = true
        }
        wasReplaying = true
      } else {
        if (wasReplaying) series.reset()
        wasReplaying = false
        // runtime.t, not tel.t: the chart must advance even if a module leaves tel.t at 0
        const t = runtime.t
        if (series.push(t, live)) {
          view.tEnd = t
          changed = true
        }
      }
      if (changed) plot.setData(series.data as unknown as uPlot.AlignedData, true)
      writeLegend(now)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)

    const ro = new ResizeObserver(() => {
      const w = Math.max(el.clientWidth, 120)
      if (w !== plot.width) plot.setSize({ width: w, height: HEIGHT })
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(id)
      ro.disconnect()
      plot.destroy()
    }
  }, [def])

  return (
    <section className="panel reg chart-panel">
      <h3>
        {def.title} <span className="u">{def.unit}</span>
      </h3>
      <div className="chips" aria-label={`${def.title} channels`}>
        {def.channels.map((c, i) => (
          <span className="chip" key={c.key}>
            <span className="sw" style={{ background: c.color }} aria-hidden="true" />
            <span className="cl">{c.label}</span>
            <b ref={(n) => { chipVals.current[i] = n }}>—</b>
          </span>
        ))}
      </div>
      <div className="scope" ref={host} role="img" aria-label={`${def.title} live chart, last ${def.windowSec ?? DEFAULT_WINDOW_S} seconds`} />
    </section>
  )
}
