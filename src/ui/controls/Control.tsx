import type { ButtonDef, ControlDef, ControlValue, ToggleDef } from '../../core/types'
import { controlId } from './controlMath'
import { Hint } from './Hint'
import SelectControl from './SelectControl'
import SliderControl from './SliderControl'

/* Generic renderer: one component per ControlDef type. All writes go through `onSet`. */

function ToggleControl({ def, value, onSet }: { def: ToggleDef; value: boolean; onSet: (v: boolean) => void }) {
  const id = controlId(def.key)
  return (
    <div className={`ctl toggle${def.disabled ? ' is-disabled' : ''}`}>
      <label htmlFor={id} className="tl">
        {def.label}
      </label>
      {def.hint && <Hint text={def.hint} />}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        className={`switch${value ? ' on' : ''}`}
        disabled={def.disabled}
        onClick={() => onSet(!value)}
      >
        <span className="knob" aria-hidden="true" />
        <span className="state mono">{value ? 'ON' : 'OFF'}</span>
      </button>
    </div>
  )
}

function ButtonControl({ def, onPress }: { def: ButtonDef; onPress: () => void }) {
  return (
    <button type="button" className={`ctl-btn tone-${def.tone ?? 'default'}`} disabled={def.disabled} onClick={onPress} title={def.hint}>
      {def.label}
    </button>
  )
}

interface Props {
  def: ControlDef
  value: ControlValue | undefined
  onSet: (key: string, v: ControlValue) => void
}

export default function Control({ def, value, onSet }: Props) {
  switch (def.type) {
    case 'slider':
      return <SliderControl def={def} value={typeof value === 'number' ? value : def.value} onChange={(v) => onSet(def.key, v)} />
    case 'select':
      return <SelectControl def={def} value={typeof value === 'string' ? value : def.value} onChange={(v) => onSet(def.key, v)} />
    case 'toggle':
      return <ToggleControl def={def} value={typeof value === 'boolean' ? value : def.value} onSet={(v) => onSet(def.key, v)} />
    case 'button':
      return <ButtonControl def={def} onPress={() => onSet(def.key, true)} />
  }
}
