import type { CSSProperties } from 'react'
import type { SliderDef } from '../../core/types'
import { controlId, digitsForStep, formatControlValue, sliderFraction } from './controlMath'
import { Hint } from './Hint'

interface Props {
  def: SliderDef
  value: number
  onChange: (v: number) => void
}

/* Range slider with a live value readout, unit and min/max ticks. The filled part of the
   track is a CSS gradient driven by --fill. */
export default function SliderControl({ def, value, onChange }: Props) {
  const id = controlId(def.key)
  const digits = def.digits ?? digitsForStep(def.step)
  const f = sliderFraction(value, def.min, def.max)
  const text = formatControlValue(value, digits)
  const style = { '--fill': `${(f * 100).toFixed(2)}%` } as CSSProperties

  return (
    <div className={`ctl slider${def.disabled ? ' is-disabled' : ''}`}>
      <div className="lr">
        <label htmlFor={id}>{def.label}</label>
        {def.hint && <Hint text={def.hint} />}
        <output htmlFor={id} className="val">
          {text}
          {def.unit && <span className="unit">{def.unit}</span>}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        disabled={def.disabled}
        style={style}
        aria-valuetext={`${text}${def.unit ? ` ${def.unit}` : ''}`}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <div className="lim" aria-hidden="true">
        <span>{formatControlValue(def.min, digits)}</span>
        <span>{formatControlValue(def.max, digits)}</span>
      </div>
    </div>
  )
}
