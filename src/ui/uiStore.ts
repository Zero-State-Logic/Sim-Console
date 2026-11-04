import { create } from 'zustand'
import { DRAWER_DEFAULT_PX } from './layoutMath'

/*
 * Shell-local UI state (layout chrome, dialogs, camera requests). Console state that
 * the rest of the app reads lives in src/store.ts; this store is only for the shell's own chrome.
 * Small per-browser preferences are remembered in localStorage (wrapped: private mode
 * and blocked storage just fall back to defaults).
 */

const PREFS_KEY = 'simconsole.ui.v1'

export interface Prefs {
  drawerHeight: number
  /** Direction pad latches instead of press-and-hold. */
  padLatch: boolean
  /** Collapsed control panels by group name. */
  collapsed: Record<string, boolean>
}

const DEFAULT_PREFS: Prefs = { drawerHeight: DRAWER_DEFAULT_PX, padLatch: false, collapsed: {} }
const MAX_GROUP_KEY = 64

/** Rebuild preferences from stored JSON (untrusted: every field type-checked). */
export function parsePrefs(raw: string | null): Prefs {
  const base: Prefs = { ...DEFAULT_PREFS, collapsed: {} }
  if (!raw) return base
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    if (!p || typeof p !== 'object') return base
    const collapsed: Record<string, boolean> = {}
    if (p.collapsed && typeof p.collapsed === 'object' && !Array.isArray(p.collapsed)) {
      for (const [k, v] of Object.entries(p.collapsed as Record<string, unknown>)) {
        if (typeof v === 'boolean' && k.length <= MAX_GROUP_KEY && k !== '__proto__') collapsed[k] = v
      }
    }
    return {
      drawerHeight: typeof p.drawerHeight === 'number' && Number.isFinite(p.drawerHeight) ? p.drawerHeight : base.drawerHeight,
      padLatch: typeof p.padLatch === 'boolean' ? p.padLatch : false,
      collapsed,
    }
  } catch {
    return base
  }
}

function loadPrefs(): Prefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY))
  } catch {
    return parsePrefs(null)
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable: preferences stay for this session only */
  }
}

export type RailSide = 'left' | 'right'

interface UiState extends Prefs {
  /** Overlay rails on narrow screens (<= 1100 px). */
  railOpen: RailSide | null
  helpOpen: boolean
  profilesOpen: boolean
  /** Bumped by every camera request, so re-selecting the active preset re-tweens. */
  cameraNonce: number
  /** Transient toast-style notice shown in the viewport. */
  notice: { text: string; tone: 'info' | 'warn'; at: number } | null

  toggleRail: (side: RailSide) => void
  closeRails: () => void
  setHelpOpen: (b: boolean) => void
  setProfilesOpen: (b: boolean) => void
  setDrawerHeight: (px: number) => void
  setPadLatch: (b: boolean) => void
  toggleCollapsed: (group: string) => void
  bumpCamera: () => void
  notify: (text: string, tone?: 'info' | 'warn') => void
  clearNotice: () => void
}

export const useUi = create<UiState>((set, get) => {
  const persist = (patch: Partial<Prefs>): void => {
    const st = get()
    savePrefs({ drawerHeight: st.drawerHeight, padLatch: st.padLatch, collapsed: st.collapsed, ...patch })
  }
  return {
    ...loadPrefs(),
    railOpen: null,
    helpOpen: false,
    profilesOpen: false,
    cameraNonce: 0,
    notice: null,

    toggleRail: (side) => set((st) => ({ railOpen: st.railOpen === side ? null : side })),
    closeRails: () => set({ railOpen: null }),
    setHelpOpen: (b) => set({ helpOpen: b }),
    setProfilesOpen: (b) => set({ profilesOpen: b }),
    setDrawerHeight: (px) => {
      set({ drawerHeight: px })
      persist({ drawerHeight: px })
    },
    setPadLatch: (b) => {
      set({ padLatch: b })
      persist({ padLatch: b })
    },
    toggleCollapsed: (group) => {
      const collapsed = { ...get().collapsed, [group]: !get().collapsed[group] }
      set({ collapsed })
      persist({ collapsed })
    },
    bumpCamera: () => set((st) => ({ cameraNonce: st.cameraNonce + 1 })),
    notify: (text, tone = 'info') => set({ notice: { text, tone, at: Date.now() } }),
    clearNotice: () => set({ notice: null }),
  }
})
