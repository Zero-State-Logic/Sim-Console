import { cpp } from '@codemirror/lang-cpp'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import type { Extension } from '@uiw/react-codemirror'
import type { FileLanguage } from '../types'

/* Read-only CodeMirror view of one generated file. C++ is highlighted; the rest is plain. */

const SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  searchKeymap: true,
}

// Lab-white editor on the frozen theme tokens; data is always JetBrains Mono.
const LAB_THEME = EditorView.theme({
  '&': { backgroundColor: 'var(--surface-2)', color: 'var(--ink-0)', fontSize: '11.5px', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--surface-1)', color: 'var(--ink-2)', borderRight: '1px solid var(--line)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-weak)' },
})

const EXTENSIONS: Record<FileLanguage, Extension[]> = {
  cpp: [cpp(), LAB_THEME, EditorView.lineWrapping],
  python: [LAB_THEME],
  ini: [LAB_THEME],
  markdown: [LAB_THEME, EditorView.lineWrapping],
  text: [LAB_THEME],
}

export default function CodeView({ value, language, label }: { value: string; language: FileLanguage; label: string }) {
  return (
    <div className="cg-code" aria-label={label}>
      <CodeMirror value={value} editable={false} readOnly basicSetup={SETUP} extensions={EXTENSIONS[language]} theme="light" height="100%" />
    </div>
  )
}
