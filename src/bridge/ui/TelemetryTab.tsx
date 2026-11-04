import type { TelMsg } from '../../core/protocol'
import type { TelemetryTable } from '../../core/types'
import { useBridge } from '../store'
import { useActiveModule, useTicker } from './hooks'

/*
 * TELEMETRY: the module's own per-leg / per-wheel / per-drone table built from the
 * newest validated `tel`, refreshed at 10 Hz, plus the board-level fields.
 */

const REFRESH_MS = 100

function cell(v: number | string): string {
  if (typeof v === 'string') return v
  if (!Number.isFinite(v)) return '—'
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)
}

function TableView({ table }: { table: TelemetryTable }) {
  if (table.rows.length === 0) return <p className="hw-hint">This robot module has no telemetry table.</p>
  return (
    <table className="hw-table">
      <thead>
        <tr>
          <th scope="col" />
          {table.cols.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((r, i) => (
          <tr key={r.label}>
            <th scope="row">
              <span className="sw" style={{ background: `var(--l${(i % 8) + 1})` }} aria-hidden="true" />
              {r.label}
            </th>
            {r.cells.map((v, j) => (
              <td key={table.cols[j] ?? j} className={typeof v === 'string' ? 'str' : undefined}>
                {cell(v)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function triple(v: [number, number, number] | undefined): string {
  return v ? v.map((x) => x.toFixed(1)).join(' / ') : '—'
}

function BoardFields({ tel }: { tel: TelMsg | null }) {
  const stale = useBridge((s) => s.stale)
  const rx = useBridge((s) => s.rxLinesPerSec)
  const state = useBridge((s) => s.state)
  return (
    <dl className="hw-kv hw-telkv">
      <dt>LINK</dt>
      <dd className={stale ? 'bad' : undefined}>{stale ? 'STALE (no tel 500 ms)' : state.toUpperCase()}</dd>
      <dt>UPTIME</dt>
      <dd>{tel?.ms !== undefined ? `${(tel.ms / 1000).toFixed(2)} s` : '—'}</dd>
      <dt>LINES /s</dt>
      <dd>{rx.toFixed(1)}</dd>
      <dt>VBAT</dt>
      <dd>{tel?.vbat !== undefined ? `${tel.vbat.toFixed(2)} V` : '—'}</dd>
      <dt>IMU r/p/y °</dt>
      <dd>{triple(tel?.imu)}</dd>
      {tel?.pose && (
        <>
          <dt>POSE x/y/hdg</dt>
          <dd>
            {tel.pose[0].toFixed(3)} / {tel.pose[1].toFixed(3)} / {tel.pose[2].toFixed(1)}°
          </dd>
        </>
      )}
      {tel?.scan && (
        <>
          <dt>LIDAR</dt>
          <dd>{tel.scan.r.length} samples</dd>
        </>
      )}
    </dl>
  )
}

export function TelemetryTab() {
  useTicker(REFRESH_MS)
  const module = useActiveModule()
  const tel = useBridge.getState().latestTel
  const table = module.telemetryTable(tel)
  return (
    <div className="hw-tel">
      <div className="hw-telmain">
        {!tel && <p className="hw-hint">No telemetry yet: the table shows the model's own values until the board streams.</p>}
        <TableView table={table} />
      </div>
      <aside className="hw-telside reg">
        <BoardFields tel={tel} />
      </aside>
    </div>
  )
}
