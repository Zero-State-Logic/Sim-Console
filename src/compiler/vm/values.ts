/* ============================================================
   VM VALUES — the runtime value model and the conversions at the
   host boundary. Numbers are JS numbers already wrapped to their
   C type; bools are 0/1; Strings are JS strings; arrays and
   structs are JS arrays (structs by field index); native
   objects are host handles (numbers).
   ============================================================ */

import { floatToInt32, wrapInt } from '../arith'
import type { VMValue, ValueType } from '../api'
import type { BytecodeProgram, ConstValue, TypeDesc } from '../bytecode'
import { setOwn } from '../tables'

/** A stack / storage cell. Containers (the stack itself, globals) are arrays of slots too. */
export type Slot = number | string | Slot[]

export function deepClone(v: Slot | ConstValue): Slot {
  if (!Array.isArray(v)) return v
  const out = new Array<Slot>(v.length)
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    out[i] = Array.isArray(x) ? deepClone(x) : x
  }
  return out
}

/** Struct / array assignment: copies src into dst in place (references to dst stay valid). */
export function copyInto(dst: Slot, src: Slot): void {
  if (!Array.isArray(dst) || !Array.isArray(src)) return
  for (let i = 0; i < src.length; i++) {
    const s = src[i]
    const d = dst[i]
    if (Array.isArray(s) && Array.isArray(d) && d.length === s.length) copyInto(d, s)
    else dst[i] = Array.isArray(s) ? deepClone(s) : s
  }
}

export type ConstructNative = (cls: string) => number

/** Zero value of a runtime type; native objects are constructed through the host. */
export function makeDefault(p: BytecodeProgram, t: number, construct: ConstructNative): Slot {
  const d = p.types[t]
  switch (d.k) {
    case 'num': return 0
    case 'str': return ''
    case 'native': return construct(d.cls)
    case 'array': {
      const elem = p.types[d.elem]
      if (elem.k === 'num') return new Array<Slot>(d.len).fill(0)
      if (elem.k === 'str') return new Array<Slot>(d.len).fill('')
      const out = new Array<Slot>(d.len)
      for (let i = 0; i < d.len; i++) out[i] = makeDefault(p, d.elem, construct)
      return out
    }
    case 'struct':
      return p.structs[d.id].fields.map((f) => makeDefault(p, f.type, construct))
  }
}

/** Runtime value → watch-panel value (bools as booleans, chars and char arrays as text, structs as objects). */
export function exportValue(p: BytecodeProgram, v: Slot, t: number): VMValue {
  const d: TypeDesc = p.types[t]
  switch (d.k) {
    case 'num':
      if (d.bool) return v !== 0
      if (d.char) return typeof v === 'number' ? (v === 0 ? '' : String.fromCharCode(v & 0xff)) : String(v)
      return typeof v === 'number' ? v : 0
    case 'str': return typeof v === 'string' ? v : String(v)
    case 'native': return typeof v === 'number' ? v : 0
    case 'array': {
      const arr = Array.isArray(v) ? v : []
      const elem = p.types[d.elem]
      if (elem.k === 'num' && elem.char) return charsToString(arr)
      return arr.map((x) => exportValue(p, x, d.elem))
    }
    case 'struct': {
      const arr = Array.isArray(v) ? v : []
      const obj: { [field: string]: VMValue } = {}
      p.structs[d.id].fields.forEach((f, i) => {
        setOwn(obj, f.name, exportValue(p, arr[i] ?? 0, f.type))
      })
      return obj
    }
  }
}

/** A char array up to its terminating zero, as text. */
export function charsToString(arr: Slot[]): string {
  let s = ''
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i]
    if (typeof c !== 'number' || c === 0) break
    s += String.fromCharCode(c & 0xff)
  }
  return s
}

/** VM value → what the host receives for one native argument. */
export function toHostArg(v: Slot, t: ValueType): VMValue {
  if (t === 'bool') return v !== 0
  if (Array.isArray(v)) return deepClone(v) as VMValue
  return v
}

/** Host answer → VM value of the native's declared return type. */
export function fromHostResult(r: VMValue | void, t: ValueType, intBits: number): Slot | null {
  switch (t) {
    case 'void': return null
    case 'bool': return r ? 1 : 0
    case 'string': return r === undefined || r === null ? '' : String(r)
    case 'float': return Math.fround(numberOf(r))
    // on AVR (16-bit int) double is a 32-bit float too
    case 'double':
    case 'any': return intBits === 16 ? Math.fround(numberOf(r)) : numberOf(r)
    case 'char': return wrapInt(floatToInt32(numberOf(r), true), 8, true)
    case 'int': return wrapInt(floatToInt32(numberOf(r), true), intBits, true)
    case 'long': return floatToInt32(numberOf(r), true)
    case 'unsigned': return floatToInt32(numberOf(r), false)
  }
}

function numberOf(r: VMValue | void): number {
  if (typeof r === 'number') return r
  if (typeof r === 'boolean') return r ? 1 : 0
  if (typeof r === 'string') {
    const n = Number(r)
    return Number.isNaN(n) ? 0 : n
  }
  return 0
}
