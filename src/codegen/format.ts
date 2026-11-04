/* ============================================================
   LITERAL FORMATTING — numbers, strings and arrays as they must
   appear in generated C++ and Python. Every number goes through
   here, so no 'NaN', 'Infinity' or 'undefined' can reach a file.
   ============================================================ */

const DEFAULT_DIGITS = 5

/** Round to `digits` decimals and drop float noise; non-finite becomes 0 (validation rejects it first). */
export function roundTo(n: number, digits = DEFAULT_DIGITS): number {
  if (!Number.isFinite(n)) return 0
  const r = Number(n.toFixed(digits))
  return Object.is(r, -0) ? 0 : r
}

/** Plain decimal text for a number, never exponent notation. */
export function numText(n: number, digits = DEFAULT_DIGITS): string {
  const r = roundTo(n, digits)
  // toFixed switches to exponent notation from 1e21 on; such values are integers anyway
  if (Math.abs(r) >= 1e21) return `${BigInt(Math.round(r)).toString()}.0`
  const s = r.toFixed(digits)
  // trim trailing zeros but keep at least one digit after the point
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '.0') : `${s}.0`
}

/** C++ float literal, e.g. 90.0f, -0.25f. */
export function cFloat(n: number, digits = DEFAULT_DIGITS): string {
  return `${numText(n, digits)}f`
}

/** C++ integer literal (rounded). */
export function cInt(n: number): string {
  return String(Math.round(roundTo(n, 0)))
}

/** C++ brace initializer from preformatted items, wrapped every `perLine` items. */
export function cList(items: string[], perLine = 8, indent = '  '): string {
  if (items.length === 0) return '{}'
  if (items.length <= perLine) return `{ ${items.join(', ')} }`
  const rows: string[] = []
  for (let i = 0; i < items.length; i += perLine) rows.push(indent + items.slice(i, i + perLine).join(', '))
  return `{\n${rows.join(',\n')}\n}`
}

export function cFloatList(values: number[], digits = DEFAULT_DIGITS, perLine = 8): string {
  return cList(values.map((v) => cFloat(v, digits)), perLine)
}

/** Printable-ASCII subset of a string (names, SSIDs). Other characters are dropped. */
export function asciiOnly(s: string): string {
  return Array.from(s)
    .filter((ch) => ch >= ' ' && ch <= '~')
    .join('')
}

/** C++ string literal. Escapes quotes, backslashes and '?' (no trigraph surprises). */
export function cString(s: string): string {
  const body = asciiOnly(s).replace(/[\\"?]/g, (ch) => `\\${ch}`)
  return `"${body}"`
}

/** Text safe to put inside a C++ or Python comment (no comment terminators, one line). */
export function commentSafe(s: string): string {
  return asciiOnly(s).replace(/\*\//g, '* /').replace(/\/\*/g, '/ *')
}

/** Python float literal. */
export function pyFloat(n: number, digits = DEFAULT_DIGITS): string {
  return numText(n, digits)
}

/** Python string literal (JSON string syntax is valid Python for printable ASCII). */
export function pyString(s: string): string {
  return JSON.stringify(asciiOnly(s))
}

export function pyFloatList(values: number[], digits = DEFAULT_DIGITS, perLine = 8): string {
  return pyList(values.map((v) => pyFloat(v, digits)), perLine)
}

export function pyList(items: string[], perLine = 8, indent = '    '): string {
  if (items.length <= perLine) return `[${items.join(', ')}]`
  const rows: string[] = []
  for (let i = 0; i < items.length; i += perLine) rows.push(indent + items.slice(i, i + perLine).join(', '))
  return `[\n${rows.join(',\n')},\n]`
}

/** Strip the first newline of a template block so sections can be written flush-left. */
export function block(s: string): string {
  return s.startsWith('\n') ? s.slice(1) : s
}

/** Join non-empty sections with one blank line between them. */
export function joinSections(parts: (string | false | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.replace(/\s+$/, ''))
    .join('\n\n')
    .concat('\n')
}

/** Identifier-safe slug, e.g. sketch folder names. */
export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[a-z]/.test(out) ? out : `k_${out}`
}
