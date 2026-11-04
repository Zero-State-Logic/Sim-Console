import * as Tabs from '@radix-ui/react-tabs'
import { Component, lazy, Suspense, useState, type ReactNode } from 'react'
import { useSandbox } from '../store'
import { ApiPane } from './ApiPane'
import { ConsolePane } from './ConsolePane'
import { jumpTo } from './editorBus'
import { FILE_EXT, diagSummary } from './labels'
import { WatchPane } from './WatchPane'

/*
 * Bottom drawer while the drive source is CODE: the editor on the left (with a
 * clickable problems list), CONSOLE · API · WATCH on the right.
 */

const Editor = lazy(() => import('./Editor'))

type TabId = 'console' | 'api' | 'watch'
const TAB_KEY = 'simconsole.code.tab'

function readTab(): TabId {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'api' || v === 'watch' ? v : 'console'
  } catch {
    return 'console'
  }
}

function saveTab(t: TabId): void {
  try {
    localStorage.setItem(TAB_KEY, t)
  } catch {
    /* storage unavailable: the tab just is not remembered */
  }
}

/** Keeps a failed editor chunk load from taking the drawer down. */
class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    if (this.state.failed) return <div className="sbx-edload">The editor failed to load. Reload the page to try again.</div>
    return this.props.children
  }
}

function Problems() {
  const diagnostics = useSandbox((s) => s.diagnostics)
  const error = useSandbox((s) => s.error)
  const all = error ? [...diagnostics, error] : diagnostics
  if (all.length === 0) return null
  return (
    <ul className="sbx-problems mono" aria-label="Problems">
      {all.slice(0, 50).map((d, i) => (
        <li key={`${d.line}:${d.col}:${i}`}>
          <button type="button" className={`sev-${d.severity}`} onClick={() => jumpTo(d.line, d.col)}>
            <span className="pos">{d.line}:{d.col}</span>
            <span className="sev">{d.severity === 'error' ? 'ERR' : 'WARN'}</span>
            <span className="msg">{d.message}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function EditorHead() {
  const kind = useSandbox((s) => s.kind)
  const dialect = useSandbox((s) => s.dialect)
  const dirty = useSandbox((s) => s.dirty)
  const diagnostics = useSandbox((s) => s.diagnostics)
  const hasErrors = diagnostics.some((d) => d.severity === 'error')
  return (
    <div className="sbx-edhead mono">
      <span className="file">
        {kind}.{FILE_EXT[dialect]}
        {dirty && <span className="dirty" title="Changed since the last RUN">●</span>}
      </span>
      <span className={`diag${hasErrors ? ' bad' : ''}`}>{diagSummary(diagnostics)}</span>
      <span className="sbx-spacer" />
      <span className="keys">CTRL+ENTER run · CTRL+SHIFT+ENTER step</span>
    </div>
  )
}

export function CodeDrawer() {
  const [tab, setTab] = useState<TabId>(readTab)
  const onTab = (v: string): void => {
    const t: TabId = v === 'api' || v === 'watch' ? v : 'console'
    setTab(t)
    saveTab(t)
  }
  return (
    <div className="sbx-drawer">
      <section className="sbx-editor" aria-label="Program editor">
        <EditorHead />
        <div className="sbx-cm-wrap">
          <EditorBoundary>
            <Suspense fallback={<div className="sbx-edload">loading editor…</div>}>
              <Editor />
            </Suspense>
          </EditorBoundary>
        </div>
        <Problems />
      </section>
      <Tabs.Root className="sbx-side" value={tab} onValueChange={onTab}>
        <Tabs.List className="sbx-tablist" aria-label="Program tools">
          <Tabs.Trigger className="sbx-tab" value="console">CONSOLE</Tabs.Trigger>
          <Tabs.Trigger className="sbx-tab" value="api">API</Tabs.Trigger>
          <Tabs.Trigger className="sbx-tab" value="watch">WATCH</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content className="sbx-tabpanel" value="console">
          <ConsolePane />
        </Tabs.Content>
        <Tabs.Content className="sbx-tabpanel" value="api">
          <ApiPane />
        </Tabs.Content>
        <Tabs.Content className="sbx-tabpanel" value="watch">
          <WatchPane />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
