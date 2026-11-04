import type { EditorView } from '@codemirror/view'

/*
 * The mounted CodeMirror view, shared with the side panes (API entries insert snippets,
 * diagnostics jump to their line). Module state, not React state: nothing re-renders.
 */
let current: EditorView | null = null

export function setEditorView(v: EditorView | null): void {
  current = v
}

/** Insert text at the cursor (replacing the selection) and focus the editor. */
export function insertAtCursor(text: string): boolean {
  const v = current
  if (!v) return false
  const sel = v.state.selection.main
  v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, scrollIntoView: true })
  v.focus()
  return true
}

/** Move the cursor to a 1-based line:col and scroll it into view. */
export function jumpTo(line: number, col = 1): boolean {
  const v = current
  if (!v) return false
  const doc = v.state.doc
  const ln = doc.line(Math.min(Math.max(line, 1), doc.lines))
  const pos = Math.min(ln.from + Math.max(col - 1, 0), ln.to)
  v.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  v.focus()
  return true
}
