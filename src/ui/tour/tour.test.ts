import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOUR_STEPS, TOUR_STORAGE_KEY, parseTourFlag, placeCard, shouldAutoStart, visibleBox } from './tourModel'

const VIEW = { w: 1440, h: 900 }
const CARD = { w: 372, h: 220 }

describe('tour steps', () => {
  it('opens with a centred welcome and ends on Help', () => {
    expect(TOUR_STEPS[0].target).toBeNull()
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].id).toBe('help')
  })

  it('has unique ids and real copy on every step', () => {
    const ids = TOUR_STEPS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of TOUR_STEPS) {
      expect(s.title.length).toBeGreaterThan(3)
      expect(s.body.length).toBeGreaterThan(40)
    }
  })
})

describe('placeCard', () => {
  it('centres the card when there is no target', () => {
    const p = placeCard(null, CARD, VIEW)
    expect(p.side).toBe('center')
    expect(p.x).toBeCloseTo((VIEW.w - CARD.w) / 2)
    expect(p.y).toBeCloseTo((VIEW.h - CARD.h) / 2)
  })

  it('puts the card below a small top-bar target', () => {
    const p = placeCard({ x: 100, y: 10, w: 220, h: 28 }, CARD, VIEW)
    expect(p.side).toBe('bottom')
    expect(p.y).toBeGreaterThan(38)
  })

  it('puts the card beside a full-height left rail', () => {
    const p = placeCard({ x: 0, y: 46, w: 296, h: 854 }, CARD, VIEW)
    expect(p.side).toBe('right')
    expect(p.x).toBeGreaterThan(296)
  })

  it('puts the card beside a full-height right rail', () => {
    const p = placeCard({ x: 1144, y: 46, w: 296, h: 854 }, CARD, VIEW)
    expect(p.side).toBe('left')
    expect(p.x + CARD.w).toBeLessThan(1144)
  })

  it('falls back inside a target that fills the screen (the 3D view)', () => {
    const p = placeCard({ x: 296, y: 46, w: 848, h: 854 }, CARD, { w: 1100, h: 900 })
    expect(p.side).toBe('inside')
  })

  it('always keeps the card on screen', () => {
    for (const t of [{ x: 1400, y: 880, w: 30, h: 20 }, { x: -20, y: -20, w: 40, h: 40 }, { x: 600, y: 400, w: 10, h: 10 }]) {
      const p = placeCard(t, CARD, VIEW)
      expect(p.x).toBeGreaterThanOrEqual(12)
      expect(p.y).toBeGreaterThanOrEqual(12)
      expect(p.x + CARD.w).toBeLessThanOrEqual(VIEW.w - 12)
      expect(p.y + CARD.h).toBeLessThanOrEqual(VIEW.h - 12)
    }
  })
})

describe('visibleBox', () => {
  it('ignores collapsed or off-screen elements (rails hidden on small screens)', () => {
    expect(visibleBox(null, VIEW)).toBeNull()
    expect(visibleBox({ left: 0, top: 0, width: 0, height: 300 }, VIEW)).toBeNull()
    expect(visibleBox({ left: 2000, top: 10, width: 100, height: 100 }, VIEW)).toBeNull()
    expect(visibleBox({ left: 10, top: 10, width: 100, height: 50 }, VIEW)).toEqual({ x: 10, y: 10, w: 100, h: 50 })
  })
})

describe('first-run flag', () => {
  it('only trusts the two known outcomes', () => {
    expect(parseTourFlag('done')).toBe('done')
    expect(parseTourFlag('skipped')).toBe('skipped')
    expect(parseTourFlag('yes')).toBeNull()
    expect(parseTourFlag(null)).toBeNull()
  })

  it('auto-starts for first-time users and on ?tour, never after done or skip', () => {
    expect(shouldAutoStart(null, '')).toBe(true)
    expect(shouldAutoStart('done', '')).toBe(false)
    expect(shouldAutoStart('skipped', '?robot=walker')).toBe(false)
    expect(shouldAutoStart('done', '?tour=1')).toBe(true)
    expect(shouldAutoStart(null, '?tour=0')).toBe(false)
  })
})

describe('tour store', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  it('walks forward and back, then remembers a finished tour', async () => {
    const { useTour, maybeStartTour } = await import('./tourStore')
    expect(maybeStartTour('')).toBe(true)
    const t = useTour.getState
    t().back()
    expect(t().index).toBe(0)
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) t().next()
    expect(t().index).toBe(TOUR_STEPS.length - 1)
    t().next()
    expect(t().open).toBe(false)
    expect(store.get(TOUR_STORAGE_KEY)).toBe('done')
    expect(maybeStartTour('')).toBe(false)
  })

  it('SKIP closes at any step and is remembered', async () => {
    const { useTour, maybeStartTour } = await import('./tourStore')
    useTour.getState().start()
    useTour.getState().next()
    useTour.getState().next()
    useTour.getState().skip()
    expect(useTour.getState().open).toBe(false)
    expect(store.get(TOUR_STORAGE_KEY)).toBe('skipped')
    expect(maybeStartTour('')).toBe(false)
  })
})
