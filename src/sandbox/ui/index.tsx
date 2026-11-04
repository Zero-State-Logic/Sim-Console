import './sandbox.css'

/*
 * Sandbox UI entry points mounted by the shell (no props):
 *  CodePanel  → right rail, under the DRIVE SOURCE switch, when source = CODE
 *               (language, run / pause / step / reset / stop, status, examples, stats, LED).
 *  CodeDrawer → bottom drawer body when source = CODE
 *               (CodeMirror editor with inline diagnostics, CONSOLE, API reference, WATCH).
 */
export { CodePanel } from './CodePanel'
export { CodeDrawer } from './CodeDrawer'
