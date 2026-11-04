import { describe, expect, it } from 'vitest'
import { BLE_CHUNK, BLE_MAX_BACKLOG, BleWriteQueue, chunkBytes, type GattWriter } from './bleQueue'

const dec = new TextDecoder()

function recorder(opts: { withoutFails?: 'unsupported' | 'other'; noWithout?: boolean } = {}) {
  const without: string[] = []
  const withResp: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const track = async (sink: string[], c: Uint8Array) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 1))
    sink.push(dec.decode(c))
    inFlight--
  }
  const writer: GattWriter = {
    withResponse: (c) => track(withResp, c),
  }
  if (!opts.noWithout) {
    writer.withoutResponse = async (c) => {
      if (opts.withoutFails) {
        const e = new Error('nope')
        e.name = opts.withoutFails === 'unsupported' ? 'NotSupportedError' : 'NetworkError'
        throw e
      }
      await track(without, c)
    }
  }
  return { writer, without, withResp, maxInFlight: () => maxInFlight }
}

describe('chunkBytes', () => {
  it('splits into 20-byte chunks with a short tail', () => {
    const chunks = chunkBytes(new Uint8Array(45))
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5])
  })
})

describe('BleWriteQueue', () => {
  it('writes lines in order, newline-terminated, in chunks of at most 20 bytes, one at a time', async () => {
    // Arrange
    const r = recorder()
    const q = new BleWriteQueue(r.writer)
    const a = '{"t":"cmd","seq":1,"v":[0.1,0,0.2]}'
    // Act
    q.push(a)
    q.push('{"t":"ping","id":1}')
    await q.flush()
    // Assert
    expect(r.without.every((c) => new TextEncoder().encode(c).length <= BLE_CHUNK)).toBe(true)
    expect(r.without.join('')).toBe(`${a}\n{"t":"ping","id":1}\n`)
    expect(r.maxInFlight()).toBe(1)
    expect(q.backlog).toBe(0)
  })

  it('falls back to write-with-response for good when without-response is unsupported', async () => {
    const r = recorder({ withoutFails: 'unsupported' })
    const q = new BleWriteQueue(r.writer)
    q.push('{"t":"home"}')
    q.push('{"t":"ping","id":2}')
    await q.flush()
    expect(q.withResponse).toBe(true)
    expect(r.withResp.join('')).toBe('{"t":"home"}\n{"t":"ping","id":2}\n')
  })

  it('uses write-with-response when the characteristic has no without-response', async () => {
    const r = recorder({ noWithout: true })
    const q = new BleWriteQueue(r.writer)
    q.push('{"t":"estop"}', true)
    await q.flush()
    expect(r.withResp.join('')).toBe('{"t":"estop"}\n')
  })

  it('drops whole non-critical lines past the backlog cap but always queues critical ones', () => {
    const r = recorder()
    const q = new BleWriteQueue(r.writer)
    const big = 'x'.repeat(BLE_MAX_BACKLOG - 10)
    expect(q.push(big)).toBe(true)
    expect(q.push('{"t":"cmd","seq":2}')).toBe(false)
    expect(q.push('{"t":"estop"}', true)).toBe(true)
  })

  it('lets a critical line jump the backlog: unstarted commands go, the line on the air finishes whole', async () => {
    // Arrange
    const r = recorder()
    const q = new BleWriteQueue(r.writer)
    const cmd = (n: number) => `{"t":"cmd","seq":${n},"q":[1.5,1.5,1.5,1.5]}`
    q.push(cmd(1))
    q.push(cmd(2))
    q.push(cmd(3))
    // Act
    q.push('{"t":"estop"}', true)
    await q.flush()
    // Assert
    expect(r.without.join('')).toBe(`${cmd(1)}\n{"t":"estop"}\n`)
    expect(q.superseded).toBe(2)
    expect(q.backlog).toBe(0)
  })

  it('never reorders or drops other critical lines when a critical one arrives', async () => {
    const r = recorder()
    const q = new BleWriteQueue(r.writer)
    q.push('{"t":"ping","id":1}')
    q.push('{"t":"home"}', true)
    q.push('{"t":"cmd","seq":1}')
    q.push('{"t":"estop"}', true)
    await q.flush()
    expect(r.without.join('')).toBe('{"t":"ping","id":1}\n{"t":"home"}\n{"t":"estop"}\n')
  })

  it('closes and reports a real write failure', async () => {
    const r = recorder({ withoutFails: 'other' })
    const q = new BleWriteQueue(r.writer)
    let err: unknown = null
    q.onError = (e) => (err = e)
    q.push('{"t":"home"}')
    await q.flush()
    expect((err as Error).name).toBe('NetworkError')
    expect(q.push('{"t":"home"}')).toBe(false)
  })
})
