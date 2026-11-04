import type { GenContext } from './context'
import { buildHeader } from './cpp/header'
import { buildSketch } from './cpp/sketch'
import { droneSketch } from './cpp/swarm'
import { mcuLibraries, piLibraries, toLibraryRefs } from './libraries'
import type { LibInfo } from './libraries'
import { buildPlatformio } from './platformio'
import { buildPiFiles, PI_FOLDER } from './python/daemon'
import { buildReadme } from './readme'
import { buildSteps } from './steps'
import type { FirmwareRequest, FirmwareResult, GeneratedFile } from './types'
import { buildContext } from './validate'

/* ============================================================
   FIRMWARE CODEGEN — public entry. generateFirmware() never
   throws: an invalid board / transport / robot / driver / level
   combination comes back as errors with the fix in plain words.
   ============================================================ */

export type { FileLanguage, FirmwareRequest, FirmwareResult, GeneratedFile, LibraryRef } from './types'
export { zipFiles, zipName } from './zip'

/** Text that must never reach a generated file (a formatting bug upstream). */
const LEAKS: { name: string; re: RegExp }[] = [
  { name: 'undefined', re: /\bundefined\b/ },
  { name: 'NaN', re: /\bNaN\b/ },
  { name: 'Infinity', re: /\bInfinity\b/ },
  { name: '[object Object]', re: /\[object Object\]/ },
]

function mcuFiles(ctx: GenContext, libs: LibInfo[]): GeneratedFile[] {
  const dir = ctx.sketch
  const files: GeneratedFile[] = [
    { path: `${dir}/${dir}.ino`, language: 'cpp', content: buildSketch(ctx) },
    { path: `${dir}/kiyobridge.h`, language: 'cpp', content: buildHeader(ctx) },
    { path: `${dir}/platformio.ini`, language: 'ini', content: buildPlatformio(ctx) },
    { path: `${dir}/README_FIRMWARE.md`, language: 'markdown', content: buildReadme(ctx, libs) },
  ]
  if (ctx.robot === 'swarm') {
    const drone = `${dir}_drone`
    files.push({ path: `${drone}/${drone}.ino`, language: 'cpp', content: droneSketch(ctx) })
  }
  return files
}

function piFiles(ctx: GenContext, libs: LibInfo[]): GeneratedFile[] {
  return [...buildPiFiles(ctx, libs), { path: `${PI_FOLDER}/README_FIRMWARE.md`, language: 'markdown', content: buildReadme(ctx, libs) }]
}

/** Names the files whose text contains a leaked JS value. */
export function findLeaks(files: GeneratedFile[]): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const leak of LEAKS) if (leak.re.test(f.content)) out.push(`${f.path} contains '${leak.name}'`)
  }
  return out
}

function failure(errors: string[], warnings: string[] = []): FirmwareResult {
  return { files: [], libraries: [], steps: [], warnings, errors }
}

/** Generate every file for one robot × board × transport × servo driver × level. */
export function generateFirmware(req: FirmwareRequest): FirmwareResult {
  try {
    const v = buildContext(req)
    if (!v.ctx) return failure(v.errors.length ? v.errors : ['this combination cannot be generated'], v.warnings)
    const ctx = v.ctx
    const linux = ctx.info.kind === 'linux'
    const libs = linux ? piLibraries(ctx) : mcuLibraries(ctx)
    const files = linux ? piFiles(ctx, libs) : mcuFiles(ctx, libs)
    const leaks = findLeaks(files)
    if (leaks.length) return failure(leaks.map((l) => `internal generator error: ${l}`), v.warnings)
    return { files, libraries: toLibraryRefs(libs), steps: buildSteps(ctx), warnings: v.warnings, errors: [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return failure([`internal generator error: ${msg}. Check the robot spec and hardware settings.`])
  }
}
