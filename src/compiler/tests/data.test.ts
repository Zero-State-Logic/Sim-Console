import { describe, expect, it } from 'vitest'
import { errorsOf, printed, runSketch } from './harness'

describe('arrays', () => {
  it('initialises 1D arrays and zero-fills the rest', () => {
    expect(printed('int a[5] = {1, 2}; for (int i = 0; i < 5; i++) Serial.print(a[i]);')).toBe('12000')
  })

  it('sizes unsized arrays from the initializer and counts with sizeof', () => {
    expect(printed('int pins[] = {2, 4, 6, 8}; Serial.print(sizeof(pins) / sizeof(pins[0]));')).toBe('4')
  })

  it('handles 2D arrays with nested braces and with brace elision', () => {
    const body = 'int m[2][3] = {{1, 2, 3}, {4, 5, 6}}; int f[2][3] = {1, 2, 3, 4, 5, 6}; int s = 0; for (int i = 0; i < 2; i++) for (int j = 0; j < 3; j++) s += m[i][j] * 10 + f[i][j]; Serial.print(s); Serial.print(m[1][2]); Serial.print(sizeof(m) / sizeof(m[0]));'
    expect(printed(body)).toBe('23162')
  })

  it('passes arrays to functions by reference (1D and 2D)', () => {
    const g = 'void fill(int a[], int n, int v) { for (int i = 0; i < n; i++) a[i] = v + i; }\nint total(int m[][2], int rows) { int s = 0; for (int r = 0; r < rows; r++) s += m[r][0] + m[r][1]; return s; }'
    const body = 'int a[3]; fill(a, 3, 10); Serial.print(a[2]); int m[2][2] = {{1, 2}, {3, 4}}; Serial.print(total(m, 2));'
    expect(printed(body, undefined, g)).toBe('1210')
  })

  it('keeps global arrays between loop() iterations', () => {
    const src = 'int hist[3];\nint n = 0;\nvoid setup() {}\nvoid loop() { hist[n % 3] = n; n++; if (n == 4) { Serial.print(hist[0]); Serial.print(hist[1]); Serial.print(hist[2]); } }'
    expect(runSketch(src, 4).out).toBe('312')
  })

  it('initialises char arrays from strings and prints them as text', () => {
    const body = 'char name[] = "hexa"; char buf[8] = "ok"; Serial.println(name); Serial.println(sizeof(name)); Serial.println(buf); Serial.println(strlen(name)); name[0] = \'H\'; Serial.println(name);'
    expect(printed(body)).toBe('hexa\n5\nok\n4\nHexa\n')
  })

  it('rejects an over-long string for a char array and too many initializers', () => {
    expect(errorsOf('char s[3] = "long";\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/too long/)
    expect(errorsOf('int a[2] = {1, 2, 3};\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/Too many initializers/)
  })
})

describe('structs and enums', () => {
  const g = 'struct Point { int x; int y; };\nstruct Leg { Point foot; float angle = 90.0; int id; };'

  it('initialises, reads and writes fields, including nested and default member initialisers', () => {
    const body = 'Point p = {3, 4}; p.y += 10; Leg l; l.foot.x = 7; Leg k = {{1, 2}}; Serial.print(p.x); Serial.print(p.y); Serial.print(l.foot.x); Serial.print(l.angle); Serial.print(k.angle); Serial.print(k.foot.y);'
    expect(printed(body, undefined, g)).toBe('314790.0090.002')
  })

  it('copies on assignment and when passed by value, aliases when passed by reference', () => {
    const fns = `${g}\nvoid byValue(Point p) { p.x = 99; }\nvoid byRef(Point &p) { p.x = 42; }\nPoint make(int v) { Point r = {v, v * 2}; return r; }`
    const body = 'Point a = {1, 2}; Point b = a; b.x = 5; byValue(a); Serial.print(a.x); byRef(a); Serial.print(a.x); Serial.print(b.x); Point c = make(3); Serial.print(c.y);'
    expect(printed(body, undefined, fns)).toBe('14256')
  })

  it('assigns a struct through a reference parameter in place', () => {
    const fns = `${g}\nvoid reset(Point &p) { Point z = {0, 0}; p = z; }`
    expect(printed('Point a = {5, 6}; reset(a); Serial.print(a.x + a.y);', undefined, fns)).toBe('0')
  })

  it('stores arrays of structs and structs of arrays', () => {
    const g2 = 'struct Pose { int joints[3]; };\nPose legs[2] = {{{10, 20, 30}}, {{40, 50, 60}}};'
    const body = 'legs[1].joints[2] += 1; Serial.print(legs[0].joints[1]); Serial.print(legs[1].joints[2]); Pose copy = legs[1]; copy.joints[0] = 0; Serial.print(legs[1].joints[0]);'
    expect(printed(body, undefined, g2)).toBe('206140')
  })

  it('builds temporaries with Point{...} and supports typedef struct', () => {
    const g2 = 'typedef struct { int a; int b; } Pair;\nstruct V { int x; int y; };'
    expect(printed('Pair p = {1, 2}; V v = V{3, 4}; Serial.print(p.a + p.b); Serial.print(v.y);', undefined, g2)).toBe('34')
  })

  it('numbers enum members and scopes enum class members', () => {
    const g2 = 'enum Gait { TRIPOD, WAVE = 5, RIPPLE };\nenum class Dir { Fwd, Back };'
    expect(printed('Serial.print(TRIPOD); Serial.print(RIPPLE); Serial.print((int)Dir::Back); Gait gg = WAVE; Serial.print(gg);', undefined, g2)).toBe('0615')
  })
})

describe('String', () => {
  it('concatenates with numbers, floats, chars and literals', () => {
    const body = 'String s = "v="; s += 5; s = s + ", f=" + 1.5 + \',\' + String(true); Serial.println(s); Serial.println("a" + String(42) + "b");'
    expect(printed(body)).toBe('v=5, f=1.50,1\na42b\n')
  })

  it('compares Strings by content', () => {
    expect(printed('String a = "abc"; String b = "ab"; b += "c"; Serial.print(a == b); Serial.print(a != "abd"); Serial.print(a < "abd"); Serial.print(a.equals(b)); Serial.print(a.equalsIgnoreCase("ABC")); Serial.print(a.compareTo("abd"));')).toBe('11111-1')
  })

  it('implements the query methods', () => {
    const body = 'String s = "Hello, world"; Serial.print(s.length()); Serial.print(s.charAt(4)); Serial.print(s.indexOf(\'o\')); Serial.print(s.indexOf("o", 5)); Serial.print(s.lastIndexOf(\'o\')); Serial.print(s.substring(7)); Serial.print(s.substring(0, 5)); Serial.print(s.startsWith("Hell")); Serial.print(s.endsWith("ld")); Serial.print(s.indexOf("zz"));'
    expect(printed(body)).toBe('12o488worldHello11-1')
  })

  it('parses numbers like atol / atof', () => {
    expect(printed('String a = "  42abc"; String b = "-3.75"; String c = "x"; Serial.print(a.toInt()); Serial.print(" "); Serial.print(b.toFloat()); Serial.print(" "); Serial.print(c.toInt());')).toBe('42 -3.75 0')
  })

  it('mutates in place with toUpperCase, trim, replace, remove, setCharAt and []', () => {
    const body = 'String s = "  walker  "; s.trim(); s.toUpperCase(); Serial.println(s); s.replace("KER", "K"); Serial.println(s); s.remove(1, 2); Serial.println(s); s.setCharAt(0, \'w\'); s[1] = \'L\'; Serial.println(s); Serial.println(s[1]); Serial.println(s.concat(7)); Serial.println(s);'
    expect(printed(body)).toBe('WALKER\nWALK\nWK\nwL\nL\n1\nwL7\n')
  })

  it('passes Strings by value and by reference', () => {
    const g = 'void shout(String &s) { s.toUpperCase(); s += "!"; }\nvoid quiet(String s) { s.toLowerCase(); }'
    expect(printed('String m = "Hi"; quiet(m); shout(m); Serial.print(m);', undefined, g)).toBe('HI!')
  })

  it('copies into char arrays and converts back', () => {
    const body = 'String s = "servo"; char buf[4]; s.toCharArray(buf, sizeof(buf)); Serial.println(buf); String t = String(buf) + "!"; Serial.println(t); Serial.println(s.c_str());'
    expect(printed(body)).toBe('ser\nser!\nservo\n')
  })

  it('returns 0 for out-of-range characters like WString.h', () => {
    expect(printed('String s = "ab"; Serial.print((int)s.charAt(9)); Serial.print((int)s[5]); Serial.print(s.substring(9).length());')).toBe('000')
  })

  it('keeps String arrays and String globals', () => {
    const src = 'String names[] = {"coxa", "femur", "tibia"};\nString log = "";\nvoid setup() { for (int i = 0; i < 3; i++) log += names[i][0]; Serial.print(log); }\nvoid loop() {}'
    expect(runSketch(src).out).toBe('cft')
  })

  it('rejects compound edits of a String character with a hint', () => {
    const sketch = (stmt: string): string => `void setup() { String s = "a"; ${stmt} }\nvoid loop() {}`
    expect(errorsOf(sketch('s[0]++;'))[0]).toMatch(/setCharAt/)
    expect(errorsOf(sketch('s[0] += 1;'))[0]).toMatch(/setCharAt/)
  })
})
