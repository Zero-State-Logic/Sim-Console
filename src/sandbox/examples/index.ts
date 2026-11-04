import type { RobotKind } from '../../core/types'
import type { Dialect } from '../protocol'
import { SWARM_EXAMPLES } from './swarm'
import { SWEEPER_EXAMPLES } from './sweeper'
import type { Example, ExampleCtx, ExampleInfo } from './types'
import { WALKER_EXAMPLES } from './walker'

export type { Example, ExampleCtx, ExampleInfo } from './types'

const BY_KIND: Record<RobotKind, Example[]> = {
  walker: WALKER_EXAMPLES,
  sweeper: SWEEPER_EXAMPLES,
  swarm: SWARM_EXAMPLES,
}

export function examplesFor(kind: RobotKind): Example[] {
  return BY_KIND[kind] ?? []
}

export function exampleInfos(kind: RobotKind): ExampleInfo[] {
  return examplesFor(kind).map((e) => ({
    id: e.id,
    title: e.title,
    summary: e.summary,
    dialects: (['cpp', 'js'] as Dialect[]).filter((d) => e[d] !== undefined),
  }))
}

/** Source text of one example in one dialect, or null if it has no such version. */
export function exampleSource(kind: RobotKind, id: string, dialect: Dialect, ctx: ExampleCtx): string | null {
  const ex = examplesFor(kind).find((e) => e.id === id)
  const src = ex?.[dialect]
  if (src === undefined) return null
  return typeof src === 'function' ? src(ctx) : src
}

/** The buffer a fresh editor starts with: the robot's first example. */
export function defaultSource(kind: RobotKind, dialect: Dialect, ctx: ExampleCtx): string {
  for (const ex of examplesFor(kind)) {
    const src = exampleSource(kind, ex.id, dialect, ctx)
    if (src !== null) return src
  }
  return dialect === 'cpp' ? 'void setup() {\n}\n\nvoid loop() {\n}\n' : 'function setup() {\n}\n\nfunction loop() {\n}\n'
}
