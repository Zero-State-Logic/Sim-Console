/* ============================================================
   NAME TABLES — lookups keyed by user identifiers must never reach
   Object.prototype: a sketch may well say toString(), s.valueOf()
   or name a variable __proto__. Constant tables are built without
   a prototype, and objects handed to the host get own properties.
   ============================================================ */

/** A frozen lookup table with no prototype, so `table[name]` is undefined for 'toString'. */
export function table<V>(entries: Record<string, V>): Readonly<Record<string, V>> {
  const t = Object.create(null) as Record<string, V>
  for (const [k, v] of Object.entries(entries)) t[k] = v
  return Object.freeze(t)
}

/** Defines an own enumerable property (works for keys such as '__proto__'). */
export function setOwn<V>(obj: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}
