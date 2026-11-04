import { formatWatch } from '../runner/watch'
import { useSandbox } from '../store'

/* WATCH: program globals (C++ VM globals, or JS watch() values) and the sensor snapshot. */

export function WatchPane() {
  const globals = useSandbox((s) => s.globals)
  const sensors = useSandbox((s) => s.sensors)
  const dialect = useSandbox((s) => s.dialect)
  const state = useSandbox((s) => s.state)
  const sensorKeys = Object.keys(sensors)
  const emptyHint = dialect === 'js'
    ? 'Call watch(\'name\', value) in your program to add a row.'
    : state === 'idle' ? 'Global variables appear here while the program runs.' : 'No global variables.'

  return (
    <div className="sbx-watch">
      <h4>GLOBALS <span className="u">about 4 Hz</span></h4>
      <table className="sbx-table mono">
        <tbody>
          {globals.map((g) => (
            <tr key={g.name}>
              <th scope="row">{g.name}</th>
              <td>{g.value}</td>
            </tr>
          ))}
          {globals.length === 0 && (
            <tr>
              <td className="sbx-empty" colSpan={2}>{emptyHint}</td>
            </tr>
          )}
        </tbody>
      </table>
      <h4>SENSORS IN <span className="u">last snapshot sent to the program</span></h4>
      <table className="sbx-table mono">
        <tbody>
          {sensorKeys.map((k) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{formatWatch(sensors[k])}</td>
            </tr>
          ))}
          {sensorKeys.length === 0 && (
            <tr>
              <td className="sbx-empty" colSpan={2}>Sensor values appear once the program runs.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
