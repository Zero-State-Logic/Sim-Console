import { useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { stepChoice } from './model'
import type { Choice } from './model'

/* ============================================================
   FORM PIECES for the firmware dialog: a segmented radio group,
   a labelled row, and text / number inputs that commit on blur or
   Enter (so the generator does not rerun on every keystroke).
   ============================================================ */

interface SegmentedProps<T extends string> {
  label: string
  value: T
  choices: Choice<T>[]
  onChange: (v: T) => void
}

export function Segmented<T extends string>({ label, value, choices, onChange }: SegmentedProps<T>) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const next = stepChoice(choices, value, dir)
    if (next === null || next === value) return
    onChange(next)
    const group = e.currentTarget
    window.requestAnimationFrame(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus())
  }
  return (
    <div className="cg-field">
      <span className="cg-label">{label}</span>
      <div className="cg-segs" role="radiogroup" aria-label={label} onKeyDown={onKey}>
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={c.value === value}
            tabIndex={c.value === value ? 0 : -1}
            className={`cg-seg${c.value === value ? ' on' : ''}`}
            disabled={c.disabled}
            title={c.hint}
            onClick={() => onChange(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Row({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <label className="cg-field">
      <span className="cg-label">{label}</span>
      {children}
      {note ? <span className="cg-note">{note}</span> : null}
    </label>
  )
}

interface TextInputProps {
  value: string
  /** Return false to reject the text; the field then snaps back to `value`. */
  onCommit: (v: string) => boolean | void
  maxLength?: number
  placeholder?: string
  ariaLabel?: string
  invalid?: boolean
}

/** Text input that keeps a local draft and commits on blur / Enter. */
export function TextInput({ value, onCommit, maxLength, placeholder, ariaLabel, invalid }: TextInputProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft !== value && onCommit(draft) === false) setDraft(value)
  }
  return (
    <input
      className={`cg-input${invalid ? ' bad' : ''}`}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

interface NumberInputProps {
  value: number
  min: number
  max: number
  step?: number
  onCommit: (v: number) => void
  ariaLabel?: string
}

/** Number input: commits finite values clamped to [min, max]; anything else snaps back. */
export function NumberInput({ value, min, max, step = 1, onCommit, ariaLabel }: NumberInputProps) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const v = Math.min(Math.max(n, min), max)
    setDraft(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <input
      className="cg-input num"
      type="number"
      inputMode="decimal"
      value={draft}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

export function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="cg-section">
      <h4 className="cg-h">
        {title}
        {sub ? <span className="u">{sub}</span> : null}
      </h4>
      {children}
    </section>
  )
}
