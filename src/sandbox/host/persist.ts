import type { RobotKind } from '../../core/types'
import type { Dialect } from '../protocol'

/* ============================================================
   SOURCE PERSISTENCE — one buffer per robot kind and dialect in
   localStorage ('simconsole.code.<kind>.<dialect>'). Every access
   is wrapped: in private mode or with storage blocked the editor
   keeps working from an in-memory copy for the session.
   ============================================================ */

export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const DIALECT_KEY = 'simconsole.code.dialect'

export function sourceKey(kind: RobotKind, dialect: Dialect): string {
  return `simconsole.code.${kind}.${dialect}`
}

/** localStorage if this context has a usable one, else null. */
export function browserStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class SourceStore {
  private readonly memory = new Map<string, string>()

  constructor(private readonly kv: KV | null) {}

  private read(key: string): string | null {
    if (this.memory.has(key)) return this.memory.get(key) ?? null
    try {
      return this.kv?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  private write(key: string, value: string): void {
    this.memory.set(key, value)
    try {
      this.kv?.setItem(key, value)
    } catch {
      /* quota or blocked storage: the in-memory copy still serves this session */
    }
  }

  load(kind: RobotKind, dialect: Dialect): string | null {
    return this.read(sourceKey(kind, dialect))
  }

  save(kind: RobotKind, dialect: Dialect, source: string): void {
    this.write(sourceKey(kind, dialect), source)
  }

  loadDialect(): Dialect | null {
    const v = this.read(DIALECT_KEY)
    return v === 'cpp' || v === 'js' ? v : null
  }

  saveDialect(d: Dialect): void {
    this.write(DIALECT_KEY, d)
  }
}
