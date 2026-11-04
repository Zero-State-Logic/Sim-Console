import { create } from 'zustand'
import { TOUR_STEPS, TOUR_STORAGE_KEY, parseTourFlag, shouldAutoStart, type TourOutcome } from './tourModel'

/*
 * Tour state: open/closed, the current step, and the remembered outcome so the tour
 * only greets first-time users. Storage access is wrapped (private mode, blocked
 * storage): the tour then simply shows again next time.
 */
function readFlag(): TourOutcome | null {
  try {
    return parseTourFlag(localStorage.getItem(TOUR_STORAGE_KEY))
  } catch {
    return null
  }
}

function writeFlag(outcome: TourOutcome): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, outcome)
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

interface TourState {
  open: boolean
  index: number
  start: () => void
  next: () => void
  back: () => void
  skip: () => void
}

export const useTour = create<TourState>((set, get) => ({
  open: false,
  index: 0,
  start: () => set({ open: true, index: 0 }),
  next: () => {
    const { index } = get()
    if (index >= TOUR_STEPS.length - 1) {
      writeFlag('done')
      set({ open: false, index: 0 })
      return
    }
    set({ index: index + 1 })
  },
  back: () => set((s) => ({ index: Math.max(0, s.index - 1) })),
  skip: () => {
    writeFlag('skipped')
    set({ open: false, index: 0 })
  },
}))

/** Called once at startup: greets first-time visitors (or ?tour=1) with the tour. */
export function maybeStartTour(search: string): boolean {
  if (!shouldAutoStart(readFlag(), search)) return false
  useTour.getState().start()
  return true
}
