import CodeMirror from '@uiw/react-codemirror'
import type { EditorView } from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'
import { sandbox } from '..'
import { sandboxStore, useSandbox, isActive } from '../store'
import { setEditorView } from './editorBus'
import { diagnosticsLinter, editorKeymap, editorTheme, languageFor, refreshDiagnostics, runLineField, setRunLine } from './editorSetup'

/*
 * The code editor (CodeMirror 6). Loaded lazily, so the editor chunk is only fetched
 * once the CODE drawer opens. The source lives in the sandbox store; diagnostics and
 * the running line are pushed into the view as effects (no re-mount, no re-render).
 */

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  indentOnInput: true,
  tabSize: 2,
}

export default function Editor() {
  const source = useSandbox((s) => s.source)
  const dialect = useSandbox((s) => s.dialect)
  const diagnostics = useSandbox((s) => s.diagnostics)
  const error = useSandbox((s) => s.error)
  const line = useSandbox((s) => s.line)
  const state = useSandbox((s) => s.state)
  const view = useRef<EditorView | null>(null)

  const extensions = useMemo(
    () => [
      languageFor(dialect),
      runLineField,
      diagnosticsLinter(dialect, () => {
        const st = sandboxStore.getState()
        return st.error ? [...st.diagnostics, st.error] : st.diagnostics
      }),
      editorKeymap({ run: () => sandbox.run(), step: () => sandbox.step(), save: () => sandbox.persistNow() }),
    ],
    [dialect],
  )

  useEffect(() => {
    if (view.current) refreshDiagnostics(view.current)
  }, [diagnostics, error])

  const runLine = isActive(state) ? line : 0
  useEffect(() => {
    view.current?.dispatch({ effects: setRunLine.of(runLine) })
  }, [runLine])

  useEffect(() => () => setEditorView(null), [])

  return (
    <CodeMirror
      className="sbx-cm"
      value={source}
      height="100%"
      theme={editorTheme}
      basicSetup={BASIC_SETUP}
      extensions={extensions}
      onChange={(v) => sandbox.setSource(v)}
      onCreateEditor={(v) => {
        view.current = v
        setEditorView(v)
        v.dispatch({ effects: setRunLine.of(runLine) })
      }}
      aria-label={dialect === 'cpp' ? 'Arduino C++ source' : 'JavaScript source'}
      spellCheck={false}
    />
  )
}
