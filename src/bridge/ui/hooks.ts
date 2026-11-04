import { useEffect, useState } from 'react'
import { runtime } from '../../core/runtime'
import type { HardwareSpec, RobotModule } from '../../core/types'
import { useConsole } from '../../store'
import { readBrowserEnv, type BrowserEnv } from '../link/env'

/* Small hooks shared by the bridge panel and drawer. */

/** The active robot module, re-read whenever the shell bumps its layout or controls. */
export function useActiveModule(): RobotModule {
  useConsole((s) => s.robot)
  useConsole((s) => s.layoutRev)
  useConsole((s) => s.controlRev)
  return runtime.module
}

export function useActiveSpec(): HardwareSpec {
  return useActiveModule().getHardwareSpec()
}

/** Feature detection runs once: the browser does not grow Web Serial mid-session. */
let envCache: BrowserEnv | null = null
export function useBrowserEnv(): BrowserEnv {
  if (!envCache) envCache = readBrowserEnv()
  return envCache
}

/** Re-render every `ms` while mounted (cheap polling of mutable sources). */
export function useTicker(ms: number): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms)
    return () => clearInterval(id)
  }, [ms])
  return n
}

/** Hand the viewer a text file (the serial log export). */
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** True when keyboard focus is in a text field (shortcuts must not fire). */
export function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return type === 'text' || type === 'search' || type === 'url' || type === 'number' || type === 'password' || type === 'email'
}
