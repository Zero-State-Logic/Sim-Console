import { useRef, type KeyboardEvent } from 'react'
import type { SelectDef } from '../../core/types'
import { DIR_GLYPHS, controlId } from './controlMath'
import { Hint } from './Hint'
import DirPad from './DirPad'

interface Props {
  def: SelectDef
  value: string
  onChange: (v: string) => void
}

/* Select rendered as a segmented radio row (default), a styled dropdown, or a 3×3 pad. */
export default function SelectControl({ def, value, onChange }: Props) {
  if (def.display === 'grid3') return <DirPad def={def} value={value} onChange={onChange} />
  if (def.display === 'dropdown') return <Dropdown def={def} value={value} onChange={onChange} />
  return <Segmented def={def} value={value} onChange={onChange} />
}

function Header({ def, htmlFor }: { def: SelectDef; htmlFor?: string }) {
  return (
    <div className="lr">
      {htmlFor ? <label htmlFor={htmlFor}>{def.label}</label> : <span id={`${controlId(def.key)}-label`}>{def.label}</span>}
      {def.hint && <Hint text={def.hint} />}
    </div>
  )
}

function Dropdown({ def, value, onChange }: Props) {
  const id = controlId(def.key)
  return (
    <div className={`ctl select${def.disabled ? ' is-disabled' : ''}`}>
      <Header def={def} htmlFor={id} />
      <div className="dropdown">
        <select id={id} value={value} disabled={def.disabled} onChange={(e) => onChange(e.target.value)}>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function Segmented({ def, value, onChange }: Props) {
  const group = useRef<HTMLDivElement>(null)
  const labelId = `${controlId(def.key)}-label`

  // radio-group keyboard model: arrows move the selection, focus follows
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step || def.disabled) return
    e.preventDefault()
    const n = def.options.length
    const i = Math.max(def.options.findIndex((o) => o.value === value), 0)
    const next = def.options[(i + step + n) % n]
    onChange(next.value)
    const btn = group.current?.querySelectorAll<HTMLButtonElement>('button')[(i + step + n) % n]
    btn?.focus()
  }

  return (
    <div className={`ctl select${def.disabled ? ' is-disabled' : ''}`}>
      <Header def={def} />
      <div className="segs" role="radiogroup" aria-labelledby={labelId} ref={group} onKeyDown={onKeyDown}>
        {def.options.map((o, idx) => {
          const on = o.value === value
          // keep one tab stop even when the current value is not among the options
          const tabbable = on || (idx === 0 && !def.options.some((x) => x.value === value))
          const glyph = def.key === 'turn' && !o.icon ? DIR_GLYPHS[o.value] : undefined
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={tabbable ? 0 : -1}
              className={`seg${on ? ' on' : ''}`}
              disabled={def.disabled}
              title={o.icon ? o.label : undefined}
              onClick={() => onChange(o.value)}
            >
              {glyph && <span className="glyph" aria-hidden="true">{glyph}</span>}
              {o.icon ?? o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
