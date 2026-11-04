import type { RobotEntry, RobotKind } from '../core/types'
import { createPlaceholder } from './placeholder'

/*
 * Robot registry. Each robot folder exports `entry: RobotEntry` from its index.ts
 * (src/robots/walker/index.ts, ...). Folders are discovered at build time, so adding a
 * robot never means editing this file. A kind without a module falls back to a placeholder.
 */
export const ROBOT_KINDS: { kind: RobotKind; label: string }[] = [
  { kind: 'walker', label: 'WALKER' },
  { kind: 'sweeper', label: 'SWEEPER' },
  { kind: 'swarm', label: 'SWARM' },
]

const found = import.meta.glob<{ entry?: RobotEntry }>('./*/index.ts', { eager: true })

const entries = new Map<RobotKind, RobotEntry>()
for (const mod of Object.values(found)) {
  if (mod.entry) entries.set(mod.entry.kind, mod.entry)
}

export function getRobotEntry(kind: RobotKind): RobotEntry {
  const e = entries.get(kind)
  if (e) return e
  const label = ROBOT_KINDS.find((r) => r.kind === kind)?.label ?? kind.toUpperCase()
  return { kind, label, create: () => createPlaceholder(kind, label) }
}
