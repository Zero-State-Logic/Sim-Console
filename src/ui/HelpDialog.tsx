import * as Dialog from '@radix-ui/react-dialog'
import { useUi } from './uiStore'
import { useTour } from './tour/tourStore'

/* Keyboard shortcuts, the three drive sources, and honest browser-support notes. */

const REPO_URL = 'https://github.com/Zero-State-Logic/Sim-Console'
const RELEASES_URL = `${REPO_URL}/releases/latest`

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause (drives the replay transport while replaying)'],
  ['R', 'Reset the robot and the sim clock'],
  ['1 · 2 · 3', 'Switch robot: WALKER · SWEEPER · SWARM'],
  ['W A S D · arrows', 'Drive the direction pad (two keys = diagonal, release = stop)'],
  ['Q · E', 'Turn counter-clockwise / clockwise'],
  ['F', 'Toggle the FOLLOW camera'],
  ['C', 'Cycle camera presets'],
  ['?', 'This help (and the guided tour)'],
  ['Esc', 'Close dialogs and overlay panels'],
]

const SOURCES: { id: string; name: string; text: string }[] = [
  {
    id: 'sim',
    name: 'SIM',
    text: 'The simulator computes every frame: kinematics, gait, loads, sensors. Use it to design and tune before any hardware exists.',
  },
  {
    id: 'hardware',
    name: 'HARDWARE',
    text: 'A real board drives the instruments over USB, Bluetooth or WiFi using the NDJSON protocol. The app homes the robot first, then streams commands; E-STOP is always one click away. The built-in Virtual Device lets you try the flow with no board.',
  },
  {
    id: 'code',
    name: 'CODE',
    text: 'Your own controller (an Arduino-style C++ sketch or JavaScript) runs off the main thread with a watchdog and drives the virtual robot through the same API your firmware would use.',
  },
]

interface Support {
  serial: boolean
  bluetooth: boolean
  secure: boolean
}

function detectSupport(): Support {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { serial?: unknown; bluetooth?: unknown })
  return {
    serial: Boolean(nav && 'serial' in nav),
    bluetooth: Boolean(nav && 'bluetooth' in nav),
    secure: typeof window !== 'undefined' && window.isSecureContext,
  }
}

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`flag ${ok ? 'ok' : 'no'}`}>
      <span className="d" aria-hidden="true" />
      {label} <b>{ok ? 'available' : 'not available'}</b>
    </span>
  )
}

export default function HelpDialog() {
  const open = useUi((s) => s.helpOpen)
  const setOpen = useUi((s) => s.setHelpOpen)
  const support = detectSupport()
  const startTour = (): void => {
    setOpen(false)
    useTour.getState().start()
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg dlg-wide reg" aria-describedby="help-desc">
          <header className="dlg-head">
            <Dialog.Title className="dlg-title">
              HELP <span className="u">SIM CONSOLE</span>
            </Dialog.Title>
            <Dialog.Close className="dlg-x" aria-label="Close help">
              ×
            </Dialog.Close>
          </header>
          <Dialog.Description id="help-desc" className="dlg-desc">
            One bench, three drive sources. The instruments read the same telemetry whether the sim, a real board or your code is
            in control.
          </Dialog.Description>

          <div className="help-grid">
            <section>
              <h4>KEYBOARD</h4>
              <dl className="keys">
                {SHORTCUTS.map(([k, v]) => (
                  <div key={k} className="krow">
                    <dt>
                      {k.split(' · ').map((part) => (
                        <kbd key={part}>{part}</kbd>
                      ))}
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section>
              <h4>DRIVE SOURCES</h4>
              <ul className="srcs">
                {SOURCES.map((s) => (
                  <li key={s.id} className={`src ${s.id}`}>
                    <span className="sname">{s.name}</span>
                    <p>{s.text}</p>
                  </li>
                ))}
              </ul>

              <h4>THIS BROWSER</h4>
              <div className="flags">
                <Flag ok={support.serial} label="Web Serial (USB)" />
                <Flag ok={support.bluetooth} label="Web Bluetooth" />
                <Flag ok={support.secure} label="Secure context (HTTPS)" />
              </div>
              <ul className="notes">
                <li>Web Serial and Web Bluetooth need Chrome or Edge on desktop (Android Chrome for Bluetooth), served over HTTPS or localhost. Firefox and Safari do not implement them.</li>
                <li>
                  WiFi boards speak plain <code>ws://</code>. An HTTPS page cannot open <code>ws://</code> to a LAN address (mixed
                  content): run the bundled relay on your PC (<code>node tools/ws-relay.mjs ws://&lt;board-ip&gt;:81</code>, then
                  connect to the <code>ws://localhost:8787/?k=…</code> address it prints), run the app locally with{' '}
                  <code>npm run dev</code>, or use USB / Bluetooth instead.
                </li>
                <li>Simulation, recording, profiles, firmware generation, the code sandbox and the Virtual Device work in every modern browser.</li>
              </ul>
            </section>
          </div>

          <footer className="help-foot">
            <button type="button" className="tbtn accent" onClick={startTour}>
              TAKE THE TOUR
            </button>
            <a className="tbtn" href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
              GET THE DESKTOP APP
            </a>
            <a className="tbtn" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              SOURCE ON GITHUB
            </a>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
