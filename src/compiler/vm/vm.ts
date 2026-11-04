/* ============================================================
   BYTECODE VM — stack machine with call frames, bounds-checked
   arrays, virtual time and an instruction budget per run().
   delay() sleeps in virtual time: if the wake time is still in
   the past of the host clock (`nowMs`) the VM keeps going in the
   same run(), so delay-paced sketches keep exact timing even at a
   coarse frame rate.
   ============================================================ */

import { floatToInt32, nextRandom } from '../arith'
import type { Diagnostic, VM, VMHost, VMOptions, VMRunResult, VMStatus, VMValue } from '../api'
import { PROGRAM_VERSION, type BytecodeProgram, type FnDesc } from '../bytecode'
import { setOwn } from '../tables'
import { callBuiltin, type BuiltinHost } from './builtins'
import { charCode, checkLength, numToString } from './strings'
import { charsToString, copyInto, deepClone, exportValue, fromHostResult, makeDefault, toHostArg, type Slot } from './values'

const DEFAULT_MAX_DEPTH = 256
const INITIAL_STACK = 1024

/** A runtime fault; `site` indexes program.sites (or -1 to use the current line). */
class VMFault extends Error {
  constructor(message: string, readonly site: number) {
    super(message)
  }
}

export class BytecodeVM implements VM, BuiltinHost {
  private readonly code: Int32Array
  private readonly maxLoops: number
  private readonly maxDepth: number
  private readonly stack: Slot[] = zeros(INITIAL_STACK)
  private globals: Slot[] = []
  private readonly framePc: Int32Array
  private readonly frameFp: Int32Array
  private readonly frameFn: Int32Array
  private depth = 0
  private pc = 0
  private sp = 0
  private fp = 0
  private lastPc = 0
  private state: VMStatus = 'ready'
  private wakeAt = 0
  private clock = 0
  private bootMs = 0
  private now = 0
  private rng = 1
  private fault: Diagnostic | undefined

  constructor(private readonly p: BytecodeProgram, private readonly host: VMHost, opts: VMOptions = {}) {
    if (p.kind !== 'kiyo-bytecode' || !Array.isArray(p.code)) throw new Error('Not a compiled program')
    if (p.version !== PROGRAM_VERSION) throw new Error(`Program was compiled by bytecode version ${p.version}; this VM runs version ${PROGRAM_VERSION}. Recompile it`)
    this.code = Int32Array.from(p.code)
    this.maxLoops = Math.max(1, opts.maxLoopsPerRun ?? 1)
    this.maxDepth = Math.max(1, opts.maxCallDepth ?? DEFAULT_MAX_DEPTH)
    this.framePc = new Int32Array(this.maxDepth + 1)
    this.frameFp = new Int32Array(this.maxDepth + 1)
    this.frameFn = new Int32Array(this.maxDepth + 1)
  }

  get status(): VMStatus {
    return this.state
  }

  get currentLine(): number {
    return this.lineAt(this.lastPc)
  }

  reset(): void {
    this.state = 'ready'
    this.fault = undefined
    this.depth = 0
    this.sp = 0
    this.fp = 0
    this.pc = this.p.entry
    this.lastPc = this.p.entry
    this.globals = []
  }

  getGlobals(): Record<string, VMValue> {
    const out: Record<string, VMValue> = {}
    this.p.globals.forEach((g, i) => {
      if (g.hidden) return
      setOwn(out, g.name, exportValue(this.p, this.globals[i] ?? 0, g.type))
    })
    return out
  }

  /* ---------------- BuiltinHost ---------------- */

  elapsedMs(): number {
    return this.clock - this.bootMs
  }

  random(): number {
    this.rng = nextRandom(this.rng)
    return this.rng
  }

  seed(s: number): void {
    this.rng = s >>> 0
  }

  /* ---------------- run ---------------- */

  run(budget: number, nowMs: number): VMRunResult {
    if (this.state === 'halted' || this.state === 'error') return this.result(0, false)
    if (this.state === 'ready') {
      this.boot(nowMs)
    } else if (this.state === 'sleeping') {
      if (nowMs < this.wakeAt) return this.result(0, false)
      this.clock = this.wakeAt
    } else {
      this.clock = Math.max(this.clock, nowMs)
    }
    this.now = Math.max(nowMs, this.clock)
    this.state = 'running'
    if (budget <= 0) return this.result(0, false)
    return this.exec(Math.floor(budget))
  }

  private boot(nowMs: number): void {
    this.reset()
    this.globals = zeros(this.p.globals.length)
    this.clock = nowMs
    this.bootMs = nowMs
    this.rng = 1
  }

  private result(executed: number, loopCompleted: boolean): VMRunResult {
    const r: VMRunResult = { status: this.state, executed, loopCompleted, line: this.currentLine }
    if (this.state === 'sleeping') r.wakeAtMs = this.wakeAt
    if (this.state === 'error' && this.fault) r.error = this.fault
    return r
  }

  lineAt(pc: number): number {
    const pcs = this.p.linePcs
    let lo = 0
    let hi = pcs.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (pcs[mid] <= pc) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return best >= 0 ? this.p.lineNos[best] : 1
  }

  private colAt(pc: number): number {
    const pcs = this.p.linePcs
    let best = -1
    for (let i = 0; i < pcs.length && pcs[i] <= pc; i++) best = i
    return best >= 0 ? this.p.colNos[best] : 1
  }

  private fail(err: unknown, at: number): void {
    const site = err instanceof VMFault && err.site >= 0 ? this.p.sites[err.site] : null
    const message = err instanceof Error ? err.message : String(err)
    const line = site ? site.line : this.lineAt(at)
    const col = site ? site.col : this.colAt(at)
    this.fault = { severity: 'error', message, line, col, endLine: site?.endLine ?? line, endCol: site?.endCol ?? col + 1 }
    this.state = 'error'
    this.lastPc = at
  }

  /*
   * ---------------- the interpreter loop ----------------
   * Case labels are literal opcode numbers (named in comments): with property
   * lookups like `case Op.ADD:` V8 cannot build a jump table and dispatch is
   * many times slower. tests/opcodes.test.ts keeps these numbers in sync with Op.
   */

  private exec(budget: number): VMRunResult {
    const code = this.code
    const consts = this.p.consts
    const globals = this.globals
    const st = this.stack
    let pc = this.pc
    let sp = this.sp
    let fp = this.fp
    let left = budget
    let loops = 0
    let loopCompleted = false
    let at = pc
    const save = (): void => {
      this.pc = pc
      this.sp = sp
      this.fp = fp
      this.lastPc = at
    }
    try {
      while (left > 0) {
        left--
        at = pc
        switch (code[pc++]) {
          case 1 /* PUSH_I */: st[sp++] = code[pc++]; break
          case 2 /* PUSH_K */: st[sp++] = consts[code[pc++]] as Slot; break
          case 3 /* POP */: sp--; break
          case 4 /* DUP */: st[sp] = st[sp - 1]; sp++; break
          case 5 /* DUP2 */: st[sp] = st[sp - 2]; st[sp + 1] = st[sp - 1]; sp += 2; break
          case 6 /* DUP_X1 */: {
            const b = st[sp - 1]
            st[sp - 1] = st[sp - 2]
            st[sp - 2] = b
            st[sp++] = b
            break
          }
          case 7 /* DUP_X2 */: {
            const c = st[sp - 1]
            st[sp - 1] = st[sp - 2]
            st[sp - 2] = st[sp - 3]
            st[sp - 3] = c
            st[sp++] = c
            break
          }
          case 8 /* LOAD_L */: st[sp++] = st[fp + code[pc++]]; break
          case 9 /* STORE_L */: st[fp + code[pc++]] = st[--sp]; break
          case 10 /* LOAD_G */: st[sp++] = globals[code[pc++]]; break
          case 11 /* STORE_G */: globals[code[pc++]] = st[--sp]; break
          case 12 /* LOAD_R */: {
            const s = fp + code[pc++]
            st[sp++] = (st[s] as Slot[])[st[s + 1] as number]
            break
          }
          case 13 /* STORE_R */: {
            const s = fp + code[pc++]
            ;(st[s] as Slot[])[st[s + 1] as number] = st[--sp]
            break
          }
          case 14 /* ADDR_L */: st[sp++] = st; st[sp++] = fp + code[pc++]; break
          case 15 /* ADDR_G */: st[sp++] = globals; st[sp++] = code[pc++]; break
          case 16 /* ADDR_R */: {
            const s = fp + code[pc++]
            st[sp++] = st[s]
            st[sp++] = st[s + 1]
            break
          }
          case 17 /* LOAD_IDX */: {
            const i = st[--sp] as number
            const a = st[sp - 1] as Slot[]
            if (!(i >= 0 && i < a.length)) this.bounds(code[pc], i, a.length)
            pc++
            st[sp - 1] = a[i]
            break
          }
          case 18 /* STORE_IDX */:
          case 19 /* STORE_IDX_K */: {
            const v = st[--sp]
            const i = st[--sp] as number
            const a = st[--sp] as Slot[]
            if (!(i >= 0 && i < a.length)) this.bounds(code[pc], i, a.length)
            pc++
            a[i] = v
            if (code[at] === 19 /* STORE_IDX_K */) st[sp++] = v
            break
          }
          case 20 /* CHECK_IDX */: {
            const i = st[sp - 1] as number
            const a = st[sp - 2] as Slot[]
            if (!(i >= 0 && i < a.length)) this.bounds(code[pc], i, a.length)
            pc++
            break
          }
          case 21 /* LOAD_FIELD */: st[sp - 1] = (st[sp - 1] as Slot[])[code[pc++]]; break
          case 22 /* STORE_FIELD */:
          case 23 /* STORE_FIELD_K */: {
            const v = st[--sp]
            ;(st[--sp] as Slot[])[code[pc++]] = v
            if (code[at] === 23 /* STORE_FIELD_K */) st[sp++] = v
            break
          }
          case 24 /* NEWOBJ */: st[sp++] = makeDefault(this.p, code[pc++], (cls) => this.construct(cls, [])); break
          case 25 /* CLONE_K */: st[sp++] = deepClone(consts[code[pc++]]); break
          case 26 /* COPY */: st[sp - 1] = deepClone(st[sp - 1]); break
          case 27 /* COPY_INTO */: {
            const src = st[--sp]
            copyInto(st[--sp], src)
            break
          }
          case 28 /* ADD */: sp--; st[sp - 1] = (st[sp - 1] as number) + (st[sp] as number); break
          case 29 /* SUB */: sp--; st[sp - 1] = (st[sp - 1] as number) - (st[sp] as number); break
          case 30 /* MUL */: sp--; st[sp - 1] = (st[sp - 1] as number) * (st[sp] as number); break
          case 31 /* DIV */: sp--; st[sp - 1] = (st[sp - 1] as number) / (st[sp] as number); break
          case 32 /* IMUL */: sp--; st[sp - 1] = Math.imul(st[sp - 1] as number, st[sp] as number); break
          case 33 /* IDIV */: {
            const b = st[--sp] as number
            if (b === 0) throw new VMFault('Integer division by zero', code[pc])
            pc++
            st[sp - 1] = Math.trunc((st[sp - 1] as number) / b)
            break
          }
          case 34 /* IMOD */: {
            const b = st[--sp] as number
            if (b === 0) throw new VMFault('Integer remainder (%) by zero', code[pc])
            pc++
            st[sp - 1] = (st[sp - 1] as number) % b
            break
          }
          case 35 /* NEG */: st[sp - 1] = -(st[sp - 1] as number); break
          case 36 /* BAND */: sp--; st[sp - 1] = (st[sp - 1] as number) & (st[sp] as number); break
          case 37 /* BOR */: sp--; st[sp - 1] = (st[sp - 1] as number) | (st[sp] as number); break
          case 38 /* BXOR */: sp--; st[sp - 1] = (st[sp - 1] as number) ^ (st[sp] as number); break
          case 39 /* BNOT */: st[sp - 1] = ~(st[sp - 1] as number); break
          case 40 /* SHL */: sp--; st[sp - 1] = (st[sp - 1] as number) << (st[sp] as number); break
          case 41 /* SHR */: sp--; st[sp - 1] = (st[sp - 1] as number) >> (st[sp] as number); break
          case 42 /* USHR */: sp--; st[sp - 1] = (st[sp - 1] as number) >>> (st[sp] as number); break
          case 43 /* NOT */: st[sp - 1] = st[sp - 1] === 0 ? 1 : 0; break
          case 44 /* TOBOOL */: st[sp - 1] = st[sp - 1] !== 0 ? 1 : 0; break
          case 45 /* LT */: sp--; st[sp - 1] = st[sp - 1] < st[sp] ? 1 : 0; break
          case 46 /* LE */: sp--; st[sp - 1] = st[sp - 1] <= st[sp] ? 1 : 0; break
          case 47 /* GT */: sp--; st[sp - 1] = st[sp - 1] > st[sp] ? 1 : 0; break
          case 48 /* GE */: sp--; st[sp - 1] = st[sp - 1] >= st[sp] ? 1 : 0; break
          case 49 /* EQ */: sp--; st[sp - 1] = st[sp - 1] === st[sp] ? 1 : 0; break
          case 50 /* NE */: sp--; st[sp - 1] = st[sp - 1] !== st[sp] ? 1 : 0; break
          case 51 /* W8 */: st[sp - 1] = ((st[sp - 1] as number) << 24) >> 24; break
          case 52 /* WU8 */: st[sp - 1] = (st[sp - 1] as number) & 0xff; break
          case 53 /* W16 */: st[sp - 1] = ((st[sp - 1] as number) << 16) >> 16; break
          case 54 /* WU16 */: st[sp - 1] = (st[sp - 1] as number) & 0xffff; break
          case 55 /* W32 */: st[sp - 1] = (st[sp - 1] as number) | 0; break
          case 56 /* WU32 */: st[sp - 1] = (st[sp - 1] as number) >>> 0; break
          case 57 /* FROUND */: st[sp - 1] = Math.fround(st[sp - 1] as number); break
          case 58 /* F2I */: st[sp - 1] = floatToInt32(st[sp - 1] as number, true); break
          case 59 /* F2U */: st[sp - 1] = floatToInt32(st[sp - 1] as number, false); break
          case 60 /* CONCAT */: sp--; st[sp - 1] = checkLength((st[sp - 1] as string) + (st[sp] as string)); break
          case 61 /* TOSTR */: st[sp - 1] = numToString(st[sp - 1] as number, code[pc++]); break
          case 62 /* JMP */: pc = code[pc]; break
          case 63 /* JZ */: pc = st[--sp] === 0 ? code[pc] : pc + 1; break
          case 64 /* JNZ */: pc = st[--sp] !== 0 ? code[pc] : pc + 1; break
          case 65 /* CALL */: {
            const fi = code[pc++]
            const f: FnDesc = this.p.functions[fi]
            if (this.depth >= this.maxDepth) {
              throw new VMFault(`Stack overflow: more than ${this.maxDepth} nested calls (runaway recursion in '${f.name}'?)`, -1)
            }
            this.framePc[this.depth] = pc
            this.frameFp[this.depth] = fp
            this.frameFn[this.depth] = fi
            this.depth++
            fp = sp - f.paramSlots
            const top = fp + f.frameSlots
            if (top >= st.length - 8) this.growStack(top + 8)
            for (let k = sp; k < top; k++) st[k] = 0
            sp = top
            pc = f.entry
            break
          }
          case 66 /* RET */:
            sp = fp
            this.depth--
            pc = this.framePc[this.depth]
            fp = this.frameFp[this.depth]
            break
          case 67 /* RETV */: {
            const v = st[sp - 1]
            sp = fp
            this.depth--
            pc = this.framePc[this.depth]
            fp = this.frameFp[this.depth]
            st[sp++] = v
            break
          }
          case 68 /* CALLB */: {
            const id = code[pc]
            const argc = code[pc + 1]
            pc += 3
            const base = sp - argc
            st[base] = callBuiltin(this, id, st, base, argc)
            sp = base + 1
            break
          }
          case 69 /* CALLN */: sp = this.native(code[pc], code[pc + 1], st, sp); pc += 2; break
          case 70 /* NEWN */: {
            const argc = code[pc + 1]
            const base = sp - argc
            const args: VMValue[] = []
            for (let k = 0; k < argc; k++) args.push(toHostArg(st[base + k], 'any'))
            st[base] = this.construct(this.p.classes[code[pc]], args)
            sp = base + 1
            pc += 2
            break
          }
          case 71 /* SLEEP */: {
            const ms = st[--sp] as number
            const wake = this.clock + (ms > 0 ? ms : 0)
            if (wake <= this.now) {
              this.clock = wake
              break
            }
            this.wakeAt = wake
            this.state = 'sleeping'
            save()
            return this.result(budget - left, loopCompleted)
          }
          case 72 /* YIELD */:
            save()
            return this.result(budget - left, loopCompleted)
          case 73 /* LOOPDONE */:
            loopCompleted = true
            if (++loops >= this.maxLoops) {
              save()
              return this.result(budget - left, true)
            }
            break
          case 0 /* HALT */:
            this.state = 'halted'
            pc--
            save()
            return this.result(budget - left, loopCompleted)
          case 74 /* STR_INDEX */: {
            const i = (st[--sp] as number) >>> 0
            const s = st[sp - 1] as string
            st[sp - 1] = i < s.length ? charCode(s, i) : 0
            pc++
            break
          }
          case 75 /* CHARS2STR */: st[sp - 1] = charsToString(st[sp - 1] as Slot[]); break
          case 76 /* PTR_ADD */: {
            const n = st[--sp] as number
            const s = st[sp - 1] as string
            if (n < 0 || n > s.length) throw new VMFault(`Pointer arithmetic moved ${n} characters into a ${s.length}-character string (outside it)`, code[pc])
            pc++
            st[sp - 1] = s.slice(n)
            break
          }
          default:
            throw new VMFault(`internal: bad opcode ${code[at]} at ${at}`, -1)
        }
        if (sp >= st.length - 8) this.growStack(sp + 8)
      }
    } catch (err) {
      this.fail(err, at)
      this.sp = sp
      return this.result(budget - left, loopCompleted)
    }
    save()
    return this.result(budget - left, loopCompleted)
  }

  /** Grows in place: the stack is also the container of reference parameters (ADDR_L), so it keeps its identity. */
  private growStack(min: number): void {
    const st = this.stack
    const target = Math.max(min, st.length * 2)
    while (st.length < target) st.push(0)
  }

  private bounds(site: number, i: number, len: number): never {
    const name = this.p.sites[site]?.name
    const what = name ? `'${name}'` : 'the array'
    throw new VMFault(`Index ${i} is out of bounds for ${what} (size ${len}, valid 0..${len - 1})`, site)
  }

  private construct(cls: string, args: VMValue[]): number {
    let h: number
    try {
      h = this.host.constructNative(cls, args)
    } catch (e) {
      throw new VMFault(`${cls}(): ${e instanceof Error ? e.message : String(e)}`, -1)
    }
    if (typeof h !== 'number' || !Number.isFinite(h)) throw new VMFault(`${cls}(): the host returned no object handle`, -1)
    return h
  }

  /** Native call: args (and self) come off the stack; returns the new sp. */
  private native(siteIdx: number, argc: number, st: Slot[], sp: number): number {
    const site = this.p.natives[siteIdx]
    const base = sp - argc
    const args: VMValue[] = []
    for (let k = 0; k < argc; k++) args.push(toHostArg(st[base + k], site.argTypes[k]))
    let self: number | null = null
    let start = base
    if (site.hasSelf) {
      start = base - 1
      self = st[start] as number
    }
    let r: VMValue | void
    try {
      r = this.host.callNative(site.name, args, site.argTypes, self)
    } catch (e) {
      throw new VMFault(`${site.name}(): ${e instanceof Error ? e.message : String(e)}`, -1)
    }
    const v = fromHostResult(r, site.ret, this.p.intBits)
    if (v === null) return start
    st[start] = v
    return start + 1
  }
}

/** A packed (non-holey) array of zeros. */
function zeros(n: number): Slot[] {
  const a: Slot[] = []
  for (let i = 0; i < n; i++) a.push(0)
  return a
}
