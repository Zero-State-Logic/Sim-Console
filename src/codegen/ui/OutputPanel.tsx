import * as Tabs from '@radix-ui/react-tabs'
import { useEffect, useRef, useState } from 'react'
import type { FirmwareResult, GeneratedFile } from '../types'
import { zipFiles, zipName } from '../zip'
import CodeView from './CodeView'
import { copyText, downloadBytes } from './dom'
import { TOUCH_POINTS } from './model'

/* ============================================================
   OUTPUT COLUMN — one tab per generated file (read-only editor,
   COPY), DOWNLOAD .ZIP, then the guide: numbered steps, libraries,
   and the warnings / errors panel.
   ============================================================ */

const COPIED_MS = 1400

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function fileRole(f: GeneratedFile): string {
  const name = baseName(f.path)
  if (name === 'kiyobridge.h') return 'paste once, next to your .ino'
  if (name.endsWith('_drone.ino')) return 'flash on every drone'
  if (name.endsWith('.ino')) return 'example sketch: the three touch points'
  if (name === 'kiyobridge.py') return 'the daemon: copy the folder to the Pi'
  if (name === 'kiyobridge.service') return 'systemd unit: starts it at boot'
  if (name === 'requirements.txt') return 'pip install -r requirements.txt'
  if (name === 'platformio.ini') return 'optional: build the folder in PlatformIO'
  return 'wiring, libraries, steps and safety'
}

/** A button that shows COPIED for a moment after a successful copy. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onCopy = async () => {
    const ok = await copyText(text)
    setState(ok ? 'ok' : 'fail')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), COPIED_MS)
  }
  const shown = state === 'ok' ? 'COPIED' : state === 'fail' ? 'COPY FAILED' : label
  return (
    <button type="button" className={`cg-btn${state === 'ok' ? ' ok' : ''}`} onClick={onCopy}>
      {shown}
    </button>
  )
}

function Problems({ result }: { result: FirmwareResult }) {
  if (!result.errors.length && !result.warnings.length) return <p className="cg-note">No warnings for this combination.</p>
  return (
    <ul className="cg-problems">
      {result.errors.map((e) => (
        <li key={`e-${e}`} className="err">
          <b>ERROR</b> {e}
        </li>
      ))}
      {result.warnings.map((w) => (
        <li key={`w-${w}`} className="warn">
          <b>NOTE</b> {w}
        </li>
      ))}
    </ul>
  )
}

function Guide({ result }: { result: FirmwareResult }) {
  const problems = result.errors.length + result.warnings.length
  return (
    <Tabs.Root className="cg-guide" defaultValue={result.errors.length ? 'problems' : 'steps'}>
      <Tabs.List className="cg-tabs small" aria-label="Firmware guide">
        <Tabs.Trigger className="cg-tab" value="steps">
          STEPS
        </Tabs.Trigger>
        <Tabs.Trigger className="cg-tab" value="libs">
          LIBRARIES
        </Tabs.Trigger>
        <Tabs.Trigger className="cg-tab" value="problems">
          {result.errors.length ? 'ERRORS' : 'WARNINGS'} <span className={`cg-count${result.errors.length ? ' err' : ''}`}>{problems}</span>
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content className="cg-guide-body" value="steps">
        {result.steps.length ? (
          <ol className="cg-steps">
            {result.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        ) : (
          <p className="cg-note">Fix the errors to get the steps.</p>
        )}
      </Tabs.Content>
      <Tabs.Content className="cg-guide-body" value="libs">
        <table className="cg-table libs">
          <tbody>
            {result.libraries.map((l) => (
              <tr key={l.name}>
                <td className="name">{l.name}</td>
                <td className="ro">{l.version}</td>
                <td>{l.how}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Tabs.Content>
      <Tabs.Content className="cg-guide-body" value="problems">
        <Problems result={result} />
      </Tabs.Content>
    </Tabs.Root>
  )
}

function Files({ files }: { files: GeneratedFile[] }) {
  const [active, setActive] = useState(files[0]?.path ?? '')
  const current = files.find((f) => f.path === active) ?? files[0]
  const onZip = () => downloadBytes(zipFiles(files), zipName({ files }))
  return (
    <Tabs.Root className="cg-files" value={current.path} onValueChange={setActive}>
      <div className="cg-files-head">
        <Tabs.List className="cg-tabs" aria-label="Generated files">
          {files.map((f) => (
            <Tabs.Trigger key={f.path} className="cg-tab" value={f.path} title={f.path}>
              {baseName(f.path)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <button type="button" className="cg-btn accent" onClick={onZip}>
          DOWNLOAD .ZIP
        </button>
      </div>
      <div className="cg-file-bar">
        <span className="cg-path">{current.path}</span>
        <span className="cg-role">{fileRole(current)}</span>
        <CopyButton text={current.content} label={`COPY ${baseName(current.path).toUpperCase()}`} />
      </div>
      {files.map((f) => (
        <Tabs.Content key={f.path} className="cg-file-body" value={f.path}>
          {f.path === current.path ? <CodeView value={f.content} language={f.language} label={f.path} /> : null}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  )
}

export default function OutputPanel({ result }: { result: FirmwareResult }) {
  const mcu = result.files.some((f) => f.path.endsWith('kiyobridge.h'))
  return (
    <div className="cg-output">
      {result.files.length ? (
        <>
          {mcu ? (
            <div className="cg-touch">
              <span className="cg-label">ALREADY HAVE A SKETCH? ADD THREE LINES</span>
              <pre>{TOUCH_POINTS}</pre>
              <CopyButton text={TOUCH_POINTS} label="COPY LINES" />
            </div>
          ) : null}
          <Files key={result.files.map((f) => f.path).join('|')} files={result.files} />
        </>
      ) : (
        <div className="cg-blocked">
          <span className="cg-label">CANNOT GENERATE THIS COMBINATION</span>
          <Problems result={result} />
        </div>
      )}
      <Guide key={result.errors.length ? 'err' : 'ok'} result={result} />
    </div>
  )
}
