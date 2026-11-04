import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { hardwareBridge } from '../index'
import { validateOutboundLine } from '../link/outbound'
import { bridgeLog, useBridge } from '../store'
import type { LogDir, LogEntry } from '../types'
import {
  ALL_DIRS,
  LineHistory,
  MONITOR_RENDER_LIMIT,
  QUICK_LINES,
  compileFilter,
  dirMark,
  exportFileName,
  formatTs,
  lineClass,
} from '../view/monitor'
import { downloadText } from './hooks'

/*
 * SERIAL MONITOR: the raw NDJSON stream with rx / tx / sys colors, timestamps, filter,
 * pause, autoscroll, clear, .ndjson export and a send box that validates JSON first.
 */

const DIRS: LogDir[] = ['rx', 'tx', 'sys']
const NEAR_BOTTOM_PX = 24

function MonitorLines({ entries, showTs }: { entries: LogEntry[]; showTs: boolean }) {
  if (entries.length === 0) {
    return (
      <div className="l">
        <span className="k"># nothing yet: CONNECT a board or the VIRTUAL DEVICE</span>
      </div>
    )
  }
  return (
    <>
      {entries.map((e) => (
        <div key={e.id} className={`l ${lineClass(e)}`}>
          {showTs && <span className="ts">{formatTs(e.ts)}</span>}
          <span className="dm">{dirMark(e.dir)}</span>
          <span className="msg">{e.text}</span>
        </div>
      ))}
    </>
  )
}

function SendBox() {
  const attached = useBridge((s) => s.attached)
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const history = useRef(new LineHistory())
  const check = text.trim().length > 0 ? validateOutboundLine(text) : null
  const send = (line: string): void => {
    const r = hardwareBridge.sendLine(line)
    setResult(r)
    if (r.ok) {
      history.current.push(line.trim())
      setText('')
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && check?.ok) send(text)
    else if (e.key === 'ArrowUp') {
      const v = history.current.prev()
      if (v !== null) setText(v)
      e.preventDefault()
    } else if (e.key === 'ArrowDown') {
      const v = history.current.next()
      if (v !== null) setText(v)
      e.preventDefault()
    }
  }
  const status = check && !check.ok ? { ok: false, message: check.reason } : result
  return (
    <div className="hw-send">
      <input
        type="text"
        className={check && !check.ok ? 'bad' : undefined}
        value={text}
        spellCheck={false}
        disabled={!attached}
        placeholder={attached ? '{"t":"ping","id":1}   (Enter sends, ↑ recalls)' : 'connect first'}
        aria-label="Line to send"
        onChange={(e) => {
          setText(e.target.value)
          setResult(null)
        }}
        onKeyDown={onKey}
      />
      <button type="button" className="hw-btn" disabled={!attached || !check?.ok} onClick={() => send(text)}>
        SEND
      </button>
      {QUICK_LINES.map((q) => (
        <button key={q.label} type="button" className="hw-chip" disabled={!attached} onClick={() => send(q.line)}>
          {q.label}
        </button>
      ))}
      {status && <span className={`hw-sendmsg${status.ok ? '' : ' bad'}`}>{status.message}</span>}
    </div>
  )
}

/** Live view of the ring, or a frozen copy while paused (the filter still applies to it). */
function useLogView(frozen: LogEntry[] | null, filterText: string, dirs: Record<LogDir, boolean>): LogEntry[] {
  const logRev = useBridge((s) => s.logRev)
  return useMemo(() => {
    const keep = compileFilter({ text: filterText, dirs })
    if (frozen) return frozen.filter(keep)
    return bridgeLog.snapshot(MONITOR_RENDER_LIMIT, keep)
    // logRev is the change signal for the mutable ring
  }, [logRev, frozen, filterText, dirs])
}

export function SerialMonitor() {
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null)
  const [showTs, setShowTs] = useState(true)
  const [auto, setAuto] = useState(true)
  const [filterText, setFilterText] = useState('')
  const [dirs, setDirs] = useState<Record<LogDir, boolean>>(ALL_DIRS)
  const entries = useLogView(frozen, filterText, dirs)
  const paused = frozen !== null
  const togglePause = (): void => setFrozen(paused ? null : bridgeLog.snapshot(MONITOR_RENDER_LIMIT))
  const boxRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (auto && el) el.scrollTop = el.scrollHeight
  }, [entries, auto, showTs])

  const onScroll = (): void => {
    const el = boxRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    if (near !== auto) setAuto(near)
  }

  return (
    <div className="hw-mon">
      <div className="hw-toolbar">
        <input
          type="search"
          className="hw-filter"
          value={filterText}
          placeholder="filter (!text excludes)"
          aria-label="Filter lines"
          onChange={(e) => setFilterText(e.target.value)}
        />
        {DIRS.map((d) => (
          <button key={d} type="button" className={`hw-chip dir-${d}${dirs[d] ? ' on' : ''}`} aria-pressed={dirs[d]} onClick={() => setDirs({ ...dirs, [d]: !dirs[d] })}>
            {d.toUpperCase()}
          </button>
        ))}
        <span className="sep" />
        <button type="button" className={`hw-chip${showTs ? ' on' : ''}`} aria-pressed={showTs} onClick={() => setShowTs(!showTs)}>
          TIME
        </button>
        <button type="button" className={`hw-chip${auto ? ' on' : ''}`} aria-pressed={auto} onClick={() => setAuto(!auto)}>
          AUTOSCROLL
        </button>
        <button type="button" className={`hw-chip${paused ? ' on warn' : ''}`} aria-pressed={paused} onClick={togglePause}>
          {paused ? 'RESUME' : 'PAUSE'}
        </button>
        <button type="button" className="hw-chip" onClick={() => hardwareBridge.clearLog()}>
          CLEAR
        </button>
        <button
          type="button"
          className="hw-chip"
          onClick={() => downloadText(exportFileName(new Date()), hardwareBridge.exportLog(), 'application/x-ndjson')}
          title="Every line in the 2000-line history, as NDJSON"
        >
          EXPORT .NDJSON
        </button>
        <span className="hw-count mono">
          {entries.length}
          {entries.length >= MONITOR_RENDER_LIMIT ? '+' : ''} / {bridgeLog.length}
        </span>
      </div>
      <div className="serial hw-log" ref={boxRef} onScroll={onScroll} role="log" aria-live="off" aria-label="Serial monitor">
        <MonitorLines entries={entries} showTs={showTs} />
      </div>
      <SendBox />
    </div>
  )
}
