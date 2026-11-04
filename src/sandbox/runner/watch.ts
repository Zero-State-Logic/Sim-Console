/* WATCH pane formatting: short, stable text for any VM or JS value. */

const MAX_ITEMS = 16
const MAX_DEPTH = 3
const MAX_CHARS = 400

function fmtNumber(v: number): string {
  if (Number.isInteger(v)) return String(v)
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf'
  const a = Math.abs(v)
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(3)
  return String(Number(v.toFixed(4)))
}

function fmt(v: unknown, depth: number): string {
  if (typeof v === 'number') return fmtNumber(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return JSON.stringify(v)
  if (v === null || v === undefined) return String(v)
  if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[…]' : '{…}'
  if (Array.isArray(v)) {
    const head = v.slice(0, MAX_ITEMS).map((x) => fmt(x, depth + 1))
    if (v.length > MAX_ITEMS) head.push(`… +${v.length - MAX_ITEMS}`)
    return `[${head.join(', ')}]`
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    const head = entries.slice(0, MAX_ITEMS).map(([k, x]) => `${k}: ${fmt(x, depth + 1)}`)
    if (entries.length > MAX_ITEMS) head.push('…')
    return `{${head.join(', ')}}`
  }
  if (typeof v === 'function') return 'ƒ()'
  return String(v)
}

export function formatWatch(v: unknown): string {
  const s = fmt(v, 0)
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}…` : s
}
