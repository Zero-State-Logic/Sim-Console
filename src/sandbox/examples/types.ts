import type { HardwareConfig } from '../../core/hardware'
import type { HardwareSpec } from '../../core/types'
import type { Dialect } from '../protocol'

/** What an example may need to tailor itself (the servo sketch uses the real pin map). */
export interface ExampleCtx {
  spec: HardwareSpec
  hw: HardwareConfig
}

export type ExampleSource = string | ((ctx: ExampleCtx) => string)

export interface Example {
  id: string
  title: string
  summary: string
  cpp?: ExampleSource
  js?: ExampleSource
}

/** Store-friendly description (no functions). */
export interface ExampleInfo {
  id: string
  title: string
  summary: string
  dialects: Dialect[]
}
