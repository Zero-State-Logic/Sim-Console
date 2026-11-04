import { useEffect, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useConsole } from '../../store'
import { PROFILE_NAME_MAX, sanitizeName, type RobotProfile } from '../../core/profiles'
import { useUi } from '../uiStore'
import { useProfiles } from './profileStore'
import { FACTORY_ID, presetsFor } from './presets'

/* Save / load / delete / import / export robot profiles. */

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()) || d.getTime() === 0) return '—'
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`
}

function ProfileRow({ p }: { p: RobotProfile }) {
  const load = useProfiles((s) => s.load)
  const remove = useProfiles((s) => s.remove)
  const exportOne = useProfiles((s) => s.exportOne)
  const [confirm, setConfirm] = useState(false)
  const nControls = Object.keys(p.controls).length

  useEffect(() => {
    if (!confirm) return
    const id = window.setTimeout(() => setConfirm(false), 3000)
    return () => window.clearTimeout(id)
  }, [confirm])

  return (
    <li className="prow">
      <div className="pmeta">
        <span className="pname">{p.name}</span>
        <span className="pinfo mono">
          <span className={`kchip ${p.kind}`}>{p.kind.toUpperCase()}</span>
          {nControls} controls · {p.hardware.board.toUpperCase()} · {formatDate(p.createdAt)}
        </span>
      </div>
      <div className="pact">
        <button type="button" className="tbtn accent" onClick={() => load(p)}>
          LOAD
        </button>
        <button type="button" className="tbtn" onClick={() => exportOne(p)} aria-label={`Export ${p.name} as JSON`}>
          EXPORT
        </button>
        <button
          type="button"
          className={`tbtn danger${confirm ? ' armed' : ''}`}
          onClick={() => (confirm ? remove(p) : setConfirm(true))}
          aria-label={confirm ? `Confirm delete ${p.name}` : `Delete ${p.name}`}
        >
          {confirm ? 'CONFIRM' : 'DELETE'}
        </button>
      </div>
    </li>
  )
}

function Presets({ robot }: { robot: RobotProfile['kind'] }) {
  const loadPreset = useProfiles((s) => s.loadPreset)
  return (
    <>
      <h4>BUILT-IN</h4>
      <div className="presets" role="group" aria-label="Built-in presets">
        {presetsFor(robot).map((p) => (
          <button
            key={p.id}
            type="button"
            className={`preset${p.id === FACTORY_ID ? ' factory' : ''}`}
            onClick={() => loadPreset(p)}
            title="Resets the robot, then applies the preset"
          >
            <span className="pn">{p.name}</span>
            <span className="pd">{p.desc}</span>
          </button>
        ))}
      </div>
    </>
  )
}

export default function ProfilesDialog() {
  const open = useUi((s) => s.profilesOpen)
  const setOpen = useUi((s) => s.setProfilesOpen)
  const robot = useConsole((s) => s.robot)
  const list = useProfiles((s) => s.list)
  const message = useProfiles((s) => s.message)
  const save = useProfiles((s) => s.save)
  const importFile = useProfiles((s) => s.importFile)
  const exportAll = useProfiles((s) => s.exportAll)
  const clearMessage = useProfiles((s) => s.clearMessage)
  const [name, setName] = useState('')
  const [all, setAll] = useState(false)

  useEffect(() => {
    if (open) useProfiles.getState().refresh()
    else clearMessage()
  }, [open, clearMessage])

  const shown = all ? list : list.filter((p) => p.kind === robot)
  const clean = sanitizeName(name)
  const exists = list.some((p) => p.kind === robot && p.name.toLowerCase() === clean.toLowerCase())

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (!clean) return
    save(clean)
    setName('')
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg reg" aria-describedby="profiles-desc">
          <header className="dlg-head">
            <Dialog.Title className="dlg-title">
              PROFILES <span className="u">{robot.toUpperCase()}</span>
            </Dialog.Title>
            <Dialog.Close className="dlg-x" aria-label="Close profiles">
              ×
            </Dialog.Close>
          </header>
          <Dialog.Description id="profiles-desc" className="dlg-desc">
            A profile stores every control value, the module setup (obstacles, waypoints, …) and the hardware config. Saved in this
            browser; export to share or back up.
          </Dialog.Description>

          <Presets robot={robot} />

          <h4>SAVED</h4>
          <form className="psave" onSubmit={onSubmit}>
            <label htmlFor="profile-name" className="sr">
              Profile name
            </label>
            <input
              id="profile-name"
              type="text"
              value={name}
              maxLength={PROFILE_NAME_MAX}
              placeholder="Name this setup, e.g. hex tripod fast"
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="tbtn accent" disabled={!clean}>
              {exists ? 'OVERWRITE' : 'SAVE CURRENT'}
            </button>
          </form>

          <div className="pbar">
            <div className="segs mini" role="group" aria-label="Show profiles for">
              <button type="button" className={`seg${!all ? ' on' : ''}`} aria-pressed={!all} onClick={() => setAll(false)}>
                THIS ROBOT
              </button>
              <button type="button" className={`seg${all ? ' on' : ''}`} aria-pressed={all} onClick={() => setAll(true)}>
                ALL · {list.length}
              </button>
            </div>
            <div className="pbar-act">
              <button type="button" className="tbtn" onClick={() => void importFile()}>
                IMPORT JSON…
              </button>
              <button type="button" className="tbtn" onClick={() => exportAll(shown)} disabled={shown.length === 0}>
                EXPORT LIST
              </button>
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="pempty mono">No saved profiles {all ? 'yet' : `for ${robot.toUpperCase()}`}. Save the current setup above.</div>
          ) : (
            <ul className="plist">
              {shown
                .slice()
                .reverse()
                .map((p) => (
                  <ProfileRow key={`${p.kind}:${p.name}`} p={p} />
                ))}
            </ul>
          )}

          {message && (
            <div className={`dlg-msg ${message.tone}`} role="status">
              {message.text}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
