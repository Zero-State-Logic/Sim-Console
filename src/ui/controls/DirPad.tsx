import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { SelectDef } from '../../core/types'
import { useUi } from '../uiStore'
import { DIR_GLYPHS, controlId, gridCells, releaseValue } from './controlMath'
import { Hint } from './Hint'

interface Props {
  def: SelectDef
  value: string
  onChange: (v: string) => void
}

/*
 * 3×3 direction pad. For the shared 'dir' control it is press-and-hold: pointerdown
 * drives, pointerup / cancel / lost capture returns to 'stop'. LATCH makes clicks stick.
 * Keyboard activation (Enter/Space) always latches; WASD drive it globally.
 */
export default function DirPad({ def, value, onChange }: Props) {
  const latch = useUi((s) => s.padLatch)
  const setLatch = useUi((s) => s.setPadLatch)
  const release = releaseValue(def)
  const holding = useRef<number | null>(null)
  const momentary = release !== null && !latch
  const cells = gridCells(def.options)
  const labelId = `${controlId(def.key)}-label`

  const down = (e: ReactPointerEvent<HTMLButtonElement>, v: string): void => {
    if (def.disabled || !momentary || e.button !== 0) return
    e.preventDefault()
    holding.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    onChange(v)
  }
  const up = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (holding.current !== e.pointerId || release === null) return
    holding.current = null
    onChange(release)
  }

  return (
    <div className={`ctl pad${def.disabled ? ' is-disabled' : ''}`}>
      <div className="lr">
        <span id={labelId}>{def.label}</span>
        {def.hint && <Hint text={def.hint} />}
        {release !== null && (
          <button
            type="button"
            className={`latch${latch ? ' on' : ''}`}
            aria-pressed={latch}
            onClick={() => setLatch(!latch)}
            title="Latch: clicks keep driving until STOP"
          >
            LATCH
          </button>
        )}
      </div>
      <div className="padgrid" role="group" aria-labelledby={labelId}>
        {cells.map((o, i) =>
          o ? (
            <button
              key={o.value}
              type="button"
              className={`pcell${o.value === value ? ' on' : ''}${o.value === release ? ' stop' : ''}`}
              aria-pressed={o.value === value}
              aria-label={o.label}
              disabled={def.disabled}
              onPointerDown={(e) => down(e, o.value)}
              onPointerUp={up}
              onPointerCancel={up}
              onLostPointerCapture={up}
              onClick={(e) => {
                // pointer presses were handled on down; this is keyboard or latch mode
                if (momentary && e.detail > 0) return
                onChange(o.value)
              }}
            >
              {o.icon ?? DIR_GLYPHS[o.value] ?? o.label}
            </button>
          ) : (
            <span key={`empty-${i}`} className="pcell empty" aria-hidden="true" />
          ),
        )}
      </div>
      <div className="padkeys mono" aria-hidden="true">
        {release !== null ? (momentary ? 'HOLD · W A S D / ARROWS' : 'LATCHED · ■ TO STOP') : ''}
      </div>
    </div>
  )
}
