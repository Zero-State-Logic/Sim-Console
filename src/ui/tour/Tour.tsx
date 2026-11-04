import { useEffect, useRef } from 'react'
import { TOUR_STEPS, placeCard, visibleBox } from './tourModel'
import { maybeStartTour, useTour } from './tourStore'
import './tour.css'

/*
 * First-run tour overlay. A spotlight glides from one part of the console to the next
 * while a card explains it; SKIP TOUR (or Esc) leaves at any step. Position is written
 * straight to the DOM on rAF, so a shifting layout never costs a React render per frame.
 * role="dialog" + data-state="open" also pauses the console's global keyboard shortcuts.
 */
const SPOT_PAD = 6
const START_DELAY_MS = 700

function targetRect(selector: string | null): DOMRect | null {
  if (!selector) return null
  const el = document.querySelector(selector)
  return el ? el.getBoundingClientRect() : null
}

function useTourKeys(open: boolean): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const t = useTour.getState()
      const action = e.key === 'Escape' ? t.skip : e.key === 'ArrowRight' ? t.next : e.key === 'ArrowLeft' ? t.back : null
      if (!action) return
      e.preventDefault()
      e.stopImmediatePropagation()
      action()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
}

/** Keep the spotlight and the card on the current target every frame. */
function useFollowTarget(open: boolean, index: number, spot: React.RefObject<HTMLDivElement>, card: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    if (!open) return
    const step = TOUR_STEPS[index]
    let raf = 0
    const tick = (): void => {
      const view = { w: window.innerWidth, h: window.innerHeight }
      const box = visibleBox(targetRect(step.target), view)
      const s = spot.current
      if (s) {
        // with no target the spotlight shrinks to a point and its shadow dims the whole screen
        const x = box ? box.x - SPOT_PAD : view.w / 2
        const y = box ? box.y - SPOT_PAD : view.h / 2
        s.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
        s.style.width = `${box ? Math.round(box.w + 2 * SPOT_PAD) : 0}px`
        s.style.height = `${box ? Math.round(box.h + 2 * SPOT_PAD) : 0}px`
        s.classList.toggle('none', !box)
      }
      const c = card.current
      if (c) {
        const p = placeCard(box, { w: c.offsetWidth, h: c.offsetHeight }, view)
        c.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`
        c.dataset.side = p.side
        c.classList.add('placed')
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [open, index, spot, card])
}

export default function Tour() {
  const open = useTour((s) => s.open)
  const index = useTour((s) => s.index)
  const next = useTour((s) => s.next)
  const back = useTour((s) => s.back)
  const skip = useTour((s) => s.skip)
  const spot = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const primary = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const id = window.setTimeout(() => maybeStartTour(window.location.search), START_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [])
  useTourKeys(open)
  useFollowTarget(open, index, spot, card)
  useEffect(() => {
    if (open) primary.current?.focus({ preventScroll: true })
  }, [open, index])

  if (!open) return null
  const step = TOUR_STEPS[index]
  const first = index === 0
  const last = index === TOUR_STEPS.length - 1
  const primaryLabel = first ? 'START TOUR' : last ? 'FINISH' : 'NEXT'

  return (
    <div className="tour" role="dialog" aria-modal="true" data-state="open" aria-labelledby="tour-title" aria-describedby="tour-body">
      <div className="tour-scrim" />
      <div ref={spot} className="tour-spot" aria-hidden="true" />
      <div ref={card} className="tour-card reg">
        <div className="tour-meta">
          <span className="tour-count">
            STEP {index + 1} <span className="of">/ {TOUR_STEPS.length}</span>
          </span>
          <button type="button" className="tour-skip" onClick={skip}>
            SKIP TOUR
          </button>
        </div>
        {/* re-keyed per step so the text fades in fresh while the card itself glides */}
        <div className="tour-copy" key={step.id}>
          <h2 id="tour-title" className="tour-title">{step.title}</h2>
          <p id="tour-body" className="tour-body">{step.body}</p>
        </div>
        <div className="tour-dots" aria-hidden="true">
          {TOUR_STEPS.map((s, i) => (
            <span key={s.id} className={i === index ? 'on' : i < index ? 'done' : ''} />
          ))}
        </div>
        <div className="tour-actions">
          {first ? (
            <button type="button" className="tbtn" onClick={skip}>
              NOT NOW
            </button>
          ) : (
            <button type="button" className="tbtn" onClick={back}>
              BACK
            </button>
          )}
          <button ref={primary} type="button" className="tbtn accent" onClick={next}>
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
