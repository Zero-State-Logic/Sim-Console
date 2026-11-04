import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Op, OP_ARGS } from '../bytecode'

const vmSource = readFileSync(fileURLToPath(new URL('../vm/vm.ts', import.meta.url)), 'utf-8')

describe('opcode table', () => {
  it('keeps the literal case labels in the VM in sync with Op', () => {
    // Arrange: every `N /* NAME */` the interpreter switch uses
    const used = [...vmSource.matchAll(/(\d+) \/\* ([A-Z0-9_]+) \*\//g)].map((m) => [m[2], Number(m[1])] as const)
    // Assert
    expect(used.length).toBeGreaterThan(70)
    for (const [name, value] of used) expect([name, value]).toEqual([name, Op[name as keyof typeof Op]])
  })

  it('dispatches every opcode', () => {
    const handled = new Set([...vmSource.matchAll(/case (\d+) \/\*/g)].map((m) => Number(m[1])))
    for (const [name, value] of Object.entries(Op)) expect([name, handled.has(value)]).toEqual([name, true])
  })

  it('uses unique, dense opcode numbers with an operand count each', () => {
    const values = Object.values(Op)
    expect(new Set(values).size).toBe(values.length)
    expect(Math.max(...values)).toBe(values.length - 1)
    expect(OP_ARGS).toHaveLength(values.length)
  })
})
