import * as Dialog from '@radix-ui/react-dialog'
import { lazy, Suspense } from 'react'
import { create } from 'zustand'
import './codegen.css'

/*
 * Firmware codegen UI entry points (kept stable for the shell and the bridge):
 *
 *  CodegenDialog       → mounted once by the shell (renders nothing while closed).
 *  openCodegenDialog() → called from the top bar FIRMWARE button and from the
 *                        bridge's HardwarePanel ("Generate firmware").
 *
 * The dialog body (generator, CodeMirror, fflate) is code-split and loads on first open.
 */
interface CodegenUiState {
  open: boolean
  setOpen: (b: boolean) => void
}

export const useCodegenUi = create<CodegenUiState>((set) => ({
  open: false,
  setOpen: (b) => set({ open: b }),
}))

export function openCodegenDialog(): void {
  useCodegenUi.getState().setOpen(true)
}

const CodegenPanel = lazy(() => import('./CodegenPanel'))

export function CodegenDialog() {
  const open = useCodegenUi((s) => s.open)
  const setOpen = useCodegenUi((s) => s.setOpen)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="cg-overlay" />
        <Dialog.Content className="cg-dialog reg" aria-describedby="cg-desc">
          <header className="cg-head">
            <Dialog.Title className="cg-title">
              FIRMWARE <span className="u">KIYOBRIDGE · PROTOCOL V1</span>
            </Dialog.Title>
            <Dialog.Description id="cg-desc" className="cg-desc">
              Pick the board and wiring, then paste the code where each file says. Your board then speaks the same NDJSON protocol as
              the Virtual Device, and the instruments read it like the sim.
            </Dialog.Description>
            <Dialog.Close className="cg-x" aria-label="Close the firmware dialog">
              ×
            </Dialog.Close>
          </header>
          {open ? (
            <Suspense fallback={<div className="cg-loading">LOADING THE GENERATOR…</div>}>
              <CodegenPanel />
            </Suspense>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
