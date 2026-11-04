import type { HardwareConfig } from '../core/hardware'
import type { CommandLevel, HardwareSpec } from '../core/types'

/* ============================================================
   CODEGEN CONTRACT — what the firmware generator takes and gives.
   Pure data: the dialog renders it, the zip builder packs it.
   ============================================================ */

export type FileLanguage = 'cpp' | 'python' | 'ini' | 'markdown' | 'text'

export interface FirmwareRequest {
  spec: HardwareSpec
  hw: HardwareConfig
  /** Display name of the robot, e.g. 'WALKER'. Only used in comments and docs. */
  robotLabel: string
  level: CommandLevel
}

export interface GeneratedFile {
  /** Zip-relative path, forward slashes, e.g. 'walker_esp32/kiyobridge.h'. */
  path: string
  language: FileLanguage
  content: string
}

export interface LibraryRef {
  /** Exact Library Manager / pip name. */
  name: string
  version: string
  /** One line: how to install it. */
  how: string
}

export interface FirmwareResult {
  files: GeneratedFile[]
  libraries: LibraryRef[]
  steps: string[]
  warnings: string[]
  /** Non-empty means the combination cannot be generated; files is then empty. */
  errors: string[]
}
