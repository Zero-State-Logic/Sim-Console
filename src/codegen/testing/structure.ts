/* ============================================================
   STRUCTURE CHECKS for generated source, used by the tests since
   no compiler runs in CI: balanced delimiters outside strings and
   comments, macro names, free functions declared before use, and
   Python indentation. Each returns a list of problems (empty = ok).
   ============================================================ */

type Lang = 'cpp' | 'python'

/** Remove comments and string / char literals, keeping line breaks and length roughly. */
export function stripCode(src: string, lang: Lang): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (lang === 'cpp' && c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (lang === 'cpp' && c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (lang === 'python' && c === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (lang === 'python' && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3)
      const end = src.indexOf(q, i + 3)
      const stop = end < 0 ? src.length : end + 3
      // one-line placeholder; its newlines follow it, so line numbers stay right
      const breaks = src.slice(i, stop).split('\n').length - 1
      out += `""${'\n'.repeat(breaks)}`
      i = stop
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      out += `${c}${c}`
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Unbalanced or mismatched (), [] and {} outside strings and comments. */
export function delimiterProblems(src: string, lang: Lang): string[] {
  const code = stripCode(src, lang)
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const stack: { ch: string; line: number }[] = []
  const problems: string[] = []
  let line = 1
  for (const ch of code) {
    if (ch === '\n') line++
    else if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, line })
    else if (ch in pairs) {
      const top = stack.pop()
      if (!top || top.ch !== pairs[ch]) problems.push(`line ${line}: '${ch}' does not close ${top ? `'${top.ch}' from line ${top.line}` : 'anything'}`)
    }
  }
  for (const s of stack) problems.push(`line ${s.line}: '${s.ch}' is never closed`)
  return problems
}

/** #define names that are not valid upper-case macro identifiers. */
export function macroProblems(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^#define\s+(\S+)/gm)) if (!/^[A-Z_][A-Z0-9_]*$/.test(m[1])) out.push(`bad macro name '${m[1]}'`)
  return out
}

/**
 * Free functions (defined at column 0) called before their definition. Methods are
 * indented and class members may be used anywhere, so they are not checked.
 */
export function declareBeforeUseProblems(src: string): string[] {
  const code = stripCode(src, 'cpp')
  const defs = new Map<string, number>()
  for (const m of code.matchAll(/^(?:static\s+)?(?:inline\s+)?[A-Za-z_][\w:<>]*[\s*&]+([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:const\s*)?\{/gm)) {
    if (!defs.has(m[1])) defs.set(m[1], m.index ?? 0)
  }
  // prototypes (e.g. the weak user hooks) count as declarations
  for (const m of code.matchAll(/^[A-Za-z_][\w:<>]*[\s*&]+([A-Za-z_]\w*)\s*\([^;{]*\)[^;{]*;/gm)) {
    defs.set(m[1], Math.min(defs.get(m[1]) ?? Infinity, m.index ?? 0))
  }
  const problems: string[] = []
  for (const [name, at] of defs) {
    const first = new RegExp(`(?<![\\w.>:])${name}\\s*\\(`).exec(code)
    if (first && first.index < at) {
      const line = code.slice(0, first.index).split('\n').length
      problems.push(`'${name}' is used on line ${line} before it is declared`)
    }
  }
  return problems
}

/** `static` free functions that are never called (GCC -Wunused-function in a sketch build). */
export function unusedStaticProblems(src: string): string[] {
  const code = stripCode(src, 'cpp')
  const problems: string[] = []
  for (const m of code.matchAll(/^static\s+(?:inline\s+)?[A-Za-z_][\w:<>]*[\s*&]+([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/gm)) {
    const uses = code.match(new RegExp(`(?<![\\w])${m[1]}\\b`, 'g'))?.length ?? 0
    if (uses < 2) problems.push(`static function '${m[1]}' is never used`)
  }
  return problems
}

/** Python: no tabs, indentation in steps of 4, blocks open after ':' lines. */
export function pythonIndentProblems(src: string): string[] {
  const problems: string[] = []
  const lines = stripCode(src, 'python').split('\n')
  let prevIndent = 0
  let opens = false
  let depth = 0
  lines.forEach((raw, i) => {
    if (raw.includes('\t')) problems.push(`line ${i + 1}: tab character`)
    const text = raw.trimEnd()
    if (!text.trim()) return
    const indent = text.length - text.trimStart().length
    if (depth === 0) {
      if (indent % 4 !== 0) problems.push(`line ${i + 1}: indentation ${indent} is not a multiple of 4`)
      if (opens && indent <= prevIndent) problems.push(`line ${i + 1}: expected an indented block`)
      if (!opens && indent > prevIndent) problems.push(`line ${i + 1}: unexpected indent`)
      prevIndent = indent
    }
    for (const ch of text) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
    }
    opens = depth === 0 && text.endsWith(':')
  })
  return problems
}
