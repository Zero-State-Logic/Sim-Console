import { cpp } from '@codemirror/lang-cpp'
import { javascript } from '@codemirror/lang-javascript'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { forceLinting, linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { Prec, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { Diagnostic } from '../../compiler/api'
import type { Dialect } from '../protocol'

/* ============================================================
   CODEMIRROR SETUP — dark editor on #0F1214 with the orange
   cursor, inline diagnostics, and the running line highlighted.
   ============================================================ */

const BG = '#0F1214'
const INK = '#D7DBDE'
const MUTED = '#5A6570'

export const editorTheme: Extension = [
  EditorView.theme(
    {
      '&': { backgroundColor: BG, color: INK, height: '100%', fontSize: '12px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
      '.cm-content': { caretColor: '#FF5A1F', padding: '8px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#FF5A1F', borderLeftWidth: '2px' },
      '.cm-gutters': { backgroundColor: BG, color: MUTED, border: 'none', borderRight: '1px solid #1E2428' },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px' },
      '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.05)', color: INK },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'rgba(108,76,240,0.38)',
      },
      '.cm-matchingBracket': { backgroundColor: 'rgba(255,90,31,0.18)', color: '#FFFFFF', outline: '1px solid rgba(255,90,31,0.5)' },
      '.cm-foldPlaceholder': { backgroundColor: '#1E2428', border: 'none', color: INK },
      '.cm-tooltip': { backgroundColor: '#181D21', color: INK, border: '1px solid #2A3238', borderRadius: '3px' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgba(108,76,240,0.45)', color: '#FFFFFF' },
      '.cm-diagnostic': { fontFamily: 'var(--mono)', fontSize: '11px', padding: '4px 8px' },
      '.cm-diagnostic-error': { borderLeft: '3px solid #D11F2D' },
      '.cm-diagnostic-warning': { borderLeft: '3px solid #E8A200' },
      '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy #FF4D5A', textUnderlineOffset: '3px' },
      '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy #E8A200', textUnderlineOffset: '3px' },
      '.cm-sbx-runline': { backgroundColor: 'rgba(255,90,31,0.11)', boxShadow: 'inset 3px 0 0 #FF5A1F' },
      '.cm-searchMatch': { backgroundColor: 'rgba(232,162,0,0.25)' },
      '.cm-panels': { backgroundColor: '#181D21', color: INK },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#B69CFF' },
      { tag: [t.typeName, t.standard(t.typeName), t.className], color: '#8AB4FF' },
      { tag: [t.number, t.bool, t.null, t.atom], color: '#FF9E6B' },
      { tag: [t.string, t.special(t.string), t.character], color: '#4FD6A0' },
      { tag: [t.comment, t.lineComment, t.blockComment], color: '#66737C', fontStyle: 'italic' },
      { tag: [t.processingInstruction, t.meta], color: '#E8A200' },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#F2E6C9' },
      { tag: [t.macroName, t.constant(t.variableName)], color: '#FFB37A' },
      { tag: [t.operator, t.punctuation, t.bracket], color: '#AAB3BA' },
      { tag: t.propertyName, color: '#CFD6DB' },
      { tag: t.variableName, color: INK },
      { tag: t.invalid, color: '#FF4D5A' },
    ]),
  ),
]

/* ---------------- running line ---------------- */

/** 1-based line to highlight; 0 clears. */
export const setRunLine = StateEffect.define<number>()

function runLineDeco(doc: Text, line: number): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  if (line >= 1 && line <= doc.lines) {
    const ln = doc.line(line)
    b.add(ln.from, ln.from, Decoration.line({ class: 'cm-sbx-runline' }))
  }
  return b.finish()
}

export const runLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes)
    for (const e of tr.effects) if (e.is(setRunLine)) next = runLineDeco(tr.state.doc, e.value)
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

/* ---------------- diagnostics ---------------- */

/** Compiler / runtime diagnostics (1-based line:col) to CodeMirror ranges in this doc. */
export function toCmDiagnostics(doc: Text, diags: readonly Diagnostic[]): CmDiagnostic[] {
  const out: CmDiagnostic[] = []
  for (const d of diags) {
    if (d.line < 1 || d.line > doc.lines) continue
    const ln = doc.line(d.line)
    const from = Math.min(ln.from + Math.max(d.col - 1, 0), ln.to)
    let to = ln.to
    if (d.endLine !== undefined && d.endCol !== undefined && d.endLine >= 1 && d.endLine <= doc.lines) {
      const end = doc.line(d.endLine)
      to = Math.min(end.from + Math.max(d.endCol - 1, 0), end.to)
    }
    if (to <= from) to = Math.min(from + 1, doc.length)
    out.push({ from, to: Math.max(to, from), severity: d.severity, message: d.message, source: 'sandbox' })
  }
  return out
}

/** Lezer syntax errors (JS only: the C++ grammar is stricter than Arduino code). */
function syntaxErrors(state: EditorState): CmDiagnostic[] {
  const out: CmDiagnostic[] = []
  syntaxTree(state).iterate({
    enter(n) {
      if (!n.type.isError || out.length >= 20) return
      const from = n.from
      const to = Math.min(Math.max(n.to, from + 1), state.doc.length)
      out.push({ from: Math.min(from, to), to, severity: 'error', message: 'Syntax error', source: 'parser' })
    },
  })
  return out
}

/**
 * One linter for everything: the worker's diagnostics (read through `getDiags`) plus,
 * for JS, live parser errors. Call refreshDiagnostics() when the worker reports new ones.
 */
export function diagnosticsLinter(dialect: Dialect, getDiags: () => readonly Diagnostic[]): Extension {
  return [
    linter((view) => [...toCmDiagnostics(view.state.doc, getDiags()), ...(dialect === 'js' ? syntaxErrors(view.state) : [])], { delay: 350 }),
    lintGutter(),
  ]
}

export function refreshDiagnostics(view: EditorView): void {
  forceLinting(view)
}

export interface EditorKeys {
  run(): void
  step(): void
  save(): void
}

const handled = (fn: () => void) => (): boolean => {
  fn()
  return true
}

export function editorKeymap(keys: EditorKeys): Extension {
  return Prec.highest(
    keymap.of([
      { key: 'Mod-Enter', run: handled(() => keys.run()) },
      { key: 'Shift-Mod-Enter', run: handled(() => keys.step()) },
      { key: 'Mod-s', run: handled(() => keys.save()), preventDefault: true },
    ]),
  )
}

export function languageFor(dialect: Dialect): Extension {
  return dialect === 'cpp' ? cpp() : javascript()
}
