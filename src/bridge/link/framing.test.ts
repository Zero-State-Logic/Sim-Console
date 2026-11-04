import { describe, expect, it } from 'vitest'
import { LineFramer, utf8Length } from './framing'

function collect(max?: number) {
  const lines: string[] = []
  const drops: number[] = []
  const framer = new LineFramer({ onLine: (l) => lines.push(l), onOversize: (b) => drops.push(b) }, max)
  return { framer, lines, drops }
}

describe('LineFramer', () => {
  it('emits complete lines and buffers a partial tail until its newline arrives', () => {
    // Arrange
    const { framer, lines } = collect()
    // Act
    framer.push('{"t":"pong","id":1}\n{"t":"te')
    framer.push('l","ms":5}')
    const before = [...lines]
    framer.push('\n')
    // Assert
    expect(before).toEqual(['{"t":"pong","id":1}'])
    expect(lines).toEqual(['{"t":"pong","id":1}', '{"t":"tel","ms":5}'])
  })

  it('reassembles a line split into single-character chunks', () => {
    const { framer, lines } = collect()
    const text = '{"t":"log","msg":"hi"}\n'
    for (const ch of text) framer.push(ch)
    expect(lines).toEqual(['{"t":"log","msg":"hi"}'])
  })

  it('strips CR from CRLF line endings, including a CR at the end of a chunk', () => {
    const { framer, lines } = collect()
    framer.push('a\r\nb\r')
    framer.push('\nc\n')
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  it('skips empty lines and bare CRLF', () => {
    const { framer, lines } = collect()
    framer.push('\n\r\n\nx\n\n')
    expect(lines).toEqual(['x'])
  })

  it('drops a complete line longer than the cap and keeps the next one', () => {
    const { framer, lines, drops } = collect(16)
    framer.push('0123456789abcdefXYZ\nok\n')
    expect(lines).toEqual(['ok'])
    expect(drops).toEqual([19])
    expect(framer.dropped).toBe(1)
  })

  it('drops an oversized line that streams in across many chunks without buffering it', () => {
    const { framer, lines, drops } = collect(16)
    framer.push('aaaaaaaaaa')
    framer.push('bbbbbbbbbb')
    framer.push('cccccccccc')
    framer.push('dd\nfine\n')
    expect(lines).toEqual(['fine'])
    expect(drops).toEqual([32])
  })

  it('accepts a line exactly at the cap', () => {
    const { framer, lines } = collect(4)
    framer.push('abcd\nabcde\n')
    expect(lines).toEqual(['abcd'])
  })

  it('measures the cap in UTF-8 bytes, not UTF-16 units', () => {
    const { framer, lines, drops } = collect(4)
    framer.push('éé\nééé\n') // 4 bytes, then 6 bytes
    expect(lines).toEqual(['éé'])
    expect(drops).toEqual([6])
  })

  it('reset() discards a pending partial line', () => {
    const { framer, lines } = collect()
    framer.push('{"t":"te')
    framer.reset()
    framer.push('x\n')
    expect(lines).toEqual(['x'])
  })
})

describe('utf8Length', () => {
  it('counts 1, 2, 3 and 4 byte code points', () => {
    expect(utf8Length('a')).toBe(1)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('€')).toBe(3)
    expect(utf8Length('😀')).toBe(4)
    expect(utf8Length('a😀é')).toBe(7)
  })
})
