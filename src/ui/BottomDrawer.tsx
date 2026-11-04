import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useConsole, type DriveSource } from '../store'
import { HardwareDrawer } from '../bridge/ui'
import { CodeDrawer } from '../sandbox/ui'
import { DRAWER_DEFAULT_PX, DRAWER_MIN_PX, clampDrawerHeight, drawerMaxPx } from './layoutMath'
import { useUi } from './uiStore'

/*
 * Drive-source drawer, in flow under the stage: the serial monitor / telemetry for
 * HARDWARE, the editor and console for CODE. The top edge is a resize handle (drag,
 * arrow keys, double-click to toggle max); the height is remembered per browser.
 * Collapsing hides the body without unmounting it, so editor state survives.
 */
const KEY_STEP_PX = 24
const TITLES: Record<Exclude<DriveSource, 'sim'>, { name: string; sub: string }> = {
  hardware: { name: 'HARDWARE LINK', sub: 'NDJSON · serial monitor · telemetry' },
  code: { name: 'CODE SANDBOX', sub: 'editor · console · robot API' },
}

function viewportH(): number {
  return typeof window === 'undefined' ? 900 : window.innerHeight
}

function Grip({ drawer, height }: { drawer: RefObject<HTMLElement>; height: number }) {
  const setHeight = useUi((s) => s.setDrawerHeight)
  const drag = useRef<{ id: number; y0: number; h0: number; h: number } | null>(null)

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !drawer.current) return
    e.preventDefault()
    const h0 = Math.round(drawer.current.getBoundingClientRect().height)
    drag.current = { id: e.pointerId, y0: e.clientY, h0, h: h0 }
    e.currentTarget.setPointerCapture(e.pointerId)
    drawer.current.classList.add('resizing')
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !drawer.current) return
    d.h = clampDrawerHeight(d.h0 + (d.y0 - e.clientY), viewportH())
    // live height goes straight to the DOM; the store is written once on release
    drawer.current.style.height = `${d.h}px`
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    drawer.current?.classList.remove('resizing')
    setHeight(d.h)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const max = drawerMaxPx(viewportH())
    const next =
      e.key === 'ArrowUp' ? height + KEY_STEP_PX
      : e.key === 'ArrowDown' ? height - KEY_STEP_PX
      : e.key === 'Home' ? DRAWER_MIN_PX
      : e.key === 'End' ? max
      : null
    if (next === null) return
    e.preventDefault()
    setHeight(clampDrawerHeight(next, viewportH()))
  }
  const onDouble = (): void => {
    const max = drawerMaxPx(viewportH())
    setHeight(height >= max - 4 ? DRAWER_DEFAULT_PX : max)
  }

  return (
    <div
      className="drawer-grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize drawer"
      aria-valuemin={DRAWER_MIN_PX}
      aria-valuemax={drawerMaxPx(viewportH())}
      aria-valuenow={height}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={onDouble}
    >
      <span className="pill" aria-hidden="true" />
    </div>
  )
}

export default function BottomDrawer() {
  const src = useConsole((s) => s.driveSource)
  const open = useConsole((s) => s.drawerOpen)
  const setDrawerOpen = useConsole((s) => s.setDrawerOpen)
  const stored = useUi((s) => s.drawerHeight)
  const ref = useRef<HTMLElement>(null)

  if (src === 'sim') return null
  const height = clampDrawerHeight(stored, viewportH())
  const title = TITLES[src]
  const style = open ? ({ height: `${height}px` } as CSSProperties) : undefined

  return (
    <section ref={ref} className={`drawer ${src}${open ? ' open' : ' collapsed'}`} style={style} aria-label={title.name}>
      {open && <Grip drawer={ref} height={height} />}
      <header className="drawer-head">
        <span className="dh-title">
          <span className="d" aria-hidden="true" />
          {title.name}
          <span className="dh-sub">{title.sub}</span>
        </span>
        <button
          type="button"
          className="dh-toggle"
          onClick={() => setDrawerOpen(!open)}
          aria-expanded={open}
          aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
        >
          <span aria-hidden="true">{open ? '▾' : '▴'}</span>
          {open ? 'HIDE' : 'SHOW'}
        </button>
      </header>
      <div className="drawer-body" hidden={!open}>
        {src === 'hardware' ? <HardwareDrawer /> : <CodeDrawer />}
      </div>
    </section>
  )
}
