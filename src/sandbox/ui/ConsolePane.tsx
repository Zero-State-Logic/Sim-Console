import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { sandbox } from '..'
import { sandboxConsole, useSandbox } from '../store'

/* CONSOLE: serial output, runtime errors and sandbox notes, plus a Serial input line. */

const KIND_CLASS: Record<string, string> = {
  out: 'o',
  in: 'in',
  info: 'info',
  warn: 'warn',
  error: 'err',
  sys: 'sys',
}

function fmtTime(ms: number): string {
  return (ms / 1000).toFixed(3).padStart(8, ' ')
}

export function ConsolePane() {
  useSandbox((s) => s.consoleRev)
  const [showTime, setShowTime] = useState(true)
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lines = sandboxConsole.lines

  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  const onScroll = (): void => {
    const el = box.current
    if (el) stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (text.length === 0) return
    sandbox.sendSerial(text)
    setText('')
  }

  return (
    <div className="sbx-console">
      <div className="sbx-pane-bar">
        <span className="mono">{lines.length} / 1000 lines</span>
        <span className="sbx-spacer" />
        <button type="button" className={`sbx-chip${showTime ? ' on' : ''}`} aria-pressed={showTime} onClick={() => setShowTime(!showTime)}>
          TIME
        </button>
        <button type="button" className="sbx-chip" onClick={() => sandbox.clearConsole()}>
          CLEAR
        </button>
      </div>
      <div ref={box} className="serial sbx-lines" onScroll={onScroll} role="log" aria-live="off" aria-label="Program console">
        {lines.length === 0 && <div className="l k">Serial output, errors and notes appear here.</div>}
        {lines.map((l) => (
          <div key={l.id} className={`l ${KIND_CLASS[l.kind] ?? 'o'}`}>
            {showTime && <span className="k">{fmtTime(l.tMs)} </span>}
            {l.kind === 'in' && <span className="k">› </span>}
            {l.text || ' '}
          </div>
        ))}
      </div>
      <form className="sbx-input" onSubmit={onSubmit}>
        <input
          className="mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="send a line to Serial.read()  ⏎"
          aria-label="Serial input"
          maxLength={512}
          spellCheck={false}
        />
        <button type="submit" className="sbx-chip" disabled={text.length === 0}>
          SEND
        </button>
      </form>
    </div>
  )
}
