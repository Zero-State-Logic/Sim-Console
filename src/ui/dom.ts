import { cssVarFallback, parseCssVar } from './instruments/color'

/* Browser-only helpers: downloads, file pickers, CSS token resolution. */

/** Save text as a file through a temporary object URL. */
export function downloadText(fileName: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // revoke on the next tick so the download has started
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Open a file picker and resolve with the chosen file's text (null if cancelled). */
export function pickTextFile(accept: string, maxBytes: number): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) {
        resolve(null)
        return
      }
      if (file.size > maxBytes) {
        reject(new Error(`File is too large (${Math.round(file.size / 1e6)} MB, limit ${Math.round(maxBytes / 1e6)} MB).`))
        return
      }
      file.text().then((text) => resolve({ name: file.name, text }), () => reject(new Error('Could not read the file.')))
    })
    input.addEventListener('cancel', () => {
      input.remove()
      resolve(null)
    })
    document.body.appendChild(input)
    input.click()
  })
}

const colorCache = new Map<string, string>()

/** Resolve 'var(--token)' to its computed value for canvas drawing. Cached per token. */
export function resolveCssColor(color: string): string {
  const name = parseCssVar(color)
  if (!name) return color
  const cached = colorCache.get(color)
  if (cached) return cached
  let v = ''
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  } catch {
    v = ''
  }
  const out = v || cssVarFallback(color) || '#828A90'
  colorCache.set(color, out)
  return out
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
