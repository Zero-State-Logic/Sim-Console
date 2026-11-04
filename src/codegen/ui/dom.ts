/* ============================================================
   BROWSER HELPERS for the firmware dialog: clipboard with a
   fallback for non-secure contexts, and a Blob download.
   ============================================================ */

/** Copy text; falls back to a hidden textarea where the async clipboard is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* permission denied: try the legacy path below */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

/** Save bytes as a file through a temporary object URL. */
export function downloadBytes(bytes: Uint8Array, name: string, type = 'application/zip'): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // revoke after the click has been handled, or some browsers cancel the download
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
