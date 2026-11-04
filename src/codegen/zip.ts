import { strToU8, zipSync } from 'fflate'
import type { Zippable } from 'fflate'
import type { FirmwareResult, GeneratedFile } from './types'

/* ============================================================
   ZIP — packs the generated files for "Download .zip". Paths keep
   their folders (walker_esp32/kiyobridge.h), so unzipping gives a
   sketch folder the Arduino IDE opens directly.
   ============================================================ */

/** Unix file mode in the zip's external attributes: rw-r--r--, rwxr-xr-x for scripts. */
const MODE_FILE = 0o100644
const MODE_EXEC = 0o100755
const UNIX_OS = 3
/** Fixed timestamp so the same input gives the same bytes (zip dates start in 1980). */
const ZIP_MTIME = new Date('2024-01-01T00:00:00Z')

export function zipFiles(files: GeneratedFile[]): Uint8Array {
  const tree: Zippable = {}
  for (const f of files) {
    const mode = f.path.endsWith('.py') ? MODE_EXEC : MODE_FILE
    // external attributes: unix mode in the high 16 bits
    tree[f.path] = [strToU8(f.content), { os: UNIX_OS, attrs: mode * 65536, mtime: ZIP_MTIME }]
  }
  return zipSync(tree, { level: 6 })
}

/** Download name: the top folder of the first file, e.g. walker_esp32.zip. */
export function zipName(result: Pick<FirmwareResult, 'files'>): string {
  const top = result.files[0]?.path.split('/')[0]
  return `${top && /^[a-z0-9_]+$/i.test(top) ? top : 'kiyobridge'}.zip`
}
