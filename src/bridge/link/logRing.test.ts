import { describe, expect, it } from 'vitest'
import { LOG_TEXT_CHARS, LogRing } from './logRing'

describe('LogRing', () => {
  it('keeps entries oldest-first with increasing ids', () => {
    const r = new LogRing(4)
    r.push(1, 'tx', 'a')
    r.push(2, 'rx', 'b')
    const s = r.snapshot()
    expect(s.map((e) => e.text)).toEqual(['a', 'b'])
    expect(s[1].id).toBeGreaterThan(s[0].id)
  })

  it('overwrites the oldest entries past capacity', () => {
    const r = new LogRing(3)
    for (const t of ['a', 'b', 'c', 'd', 'e']) r.push(0, 'sys', t)
    expect(r.length).toBe(3)
    expect(r.snapshot().map((e) => e.text)).toEqual(['c', 'd', 'e'])
  })

  it('returns the newest N matching a filter', () => {
    const r = new LogRing(10)
    for (let i = 0; i < 6; i++) r.push(i, i % 2 ? 'rx' : 'tx', `l${i}`)
    expect(r.snapshot(2, (e) => e.dir === 'rx').map((e) => e.text)).toEqual(['l3', 'l5'])
  })

  it('returns copies so later pushes do not mutate a snapshot', () => {
    const r = new LogRing(1)
    r.push(0, 'rx', 'first')
    const s = r.snapshot()
    r.push(1, 'rx', 'second')
    expect(s[0].text).toBe('first')
  })

  it('truncates very long text for display', () => {
    const r = new LogRing(2)
    r.push(0, 'rx', 'x'.repeat(LOG_TEXT_CHARS + 50))
    expect(r.snapshot()[0].text).toMatch(/\(\+50 chars\)$/)
  })

  it('bumps version on push and clear, and clear empties it', () => {
    const r = new LogRing(2)
    const v0 = r.version
    r.push(0, 'rx', 'a')
    r.clear()
    expect(r.version).toBe(v0 + 2)
    expect(r.snapshot()).toEqual([])
  })

  it('exports NDJSON with ts, dir, text and the tag when present', () => {
    const r = new LogRing(4)
    r.push(1.6, 'rx', '{"t":"pong","id":1}')
    r.push(2, 'rx', 'boot', 'invalid')
    const lines = r.toNdjson().trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { ts: 2, dir: 'rx', text: '{"t":"pong","id":1}' },
      { ts: 2, dir: 'rx', text: 'boot', tag: 'invalid' },
    ])
  })
})
