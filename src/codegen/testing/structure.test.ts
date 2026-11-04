import { describe, expect, it } from 'vitest'
import { declareBeforeUseProblems, delimiterProblems, macroProblems, pythonIndentProblems, stripCode, unusedStaticProblems } from './structure'

describe('structure checks catch the bugs they exist for', () => {
  it('ignores delimiters inside strings and comments, and flags real mismatches', () => {
    expect(delimiterProblems('int a() { return f("}", \'(\'); } // )', 'cpp')).toEqual([])
    expect(delimiterProblems('void f() { if (x) { }', 'cpp')[0]).toMatch(/never closed/)
    expect(delimiterProblems('x = [1, 2)', 'python')[0]).toMatch(/does not close/)
  })

  it('flags a free function called before its definition (the old gaitSelect bug)', () => {
    const src = 'static void begin() {\n  pick("a");\n}\nstatic bool pick(const char* n) {\n  return n;\n}\n'
    expect(declareBeforeUseProblems(src)[0]).toMatch(/'pick' is used on line 2/)
    expect(declareBeforeUseProblems('bool hook(int x) __attribute__((weak));\nstatic void a() { hook(1); }\n')).toEqual([])
  })

  it('flags a static function nobody calls (the pcaOff warning)', () => {
    const src = 'static void pcaOff(int ch) { (void)ch; }\nstatic void used() {}\nvoid loop() { used(); }\n'
    expect(unusedStaticProblems(src)).toEqual(["static function 'pcaOff' is never used"])
  })

  it('checks macro names', () => {
    expect(macroProblems('#define KIYO_OK 1\n#define bad-name 2\n')).toEqual(["bad macro name 'bad-name'"])
  })

  it('checks Python block structure and keeps line numbers through docstrings', () => {
    expect(pythonIndentProblems('def f():\n    """doc\n    more."""\n    return 1\n')).toEqual([])
    expect(pythonIndentProblems('def f():\nreturn 1\n')[0]).toMatch(/expected an indented block/)
    expect(pythonIndentProblems('x = 1\n    y = 2\n')[0]).toMatch(/unexpected indent/)
    expect(pythonIndentProblems('if x:\n   y = 1\n')[0]).toMatch(/multiple of 4/)
    expect(stripCode('a = """x\ny"""\nb', 'python').split('\n')).toHaveLength(3)
  })
})
