import { describe, expect, it } from 'vitest'
import { SourceStore, browserStorage, sourceKey, type KV } from './persist'

function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v)
    },
  }
}

const throwing: KV = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

describe('SourceStore', () => {
  it('saves under simconsole.code.<kind>.<dialect>', () => {
    const kv = memoryKV()
    new SourceStore(kv).save('walker', 'cpp', 'void loop() {}')
    expect(sourceKey('walker', 'cpp')).toBe('simconsole.code.walker.cpp')
    expect(kv.data.get('simconsole.code.walker.cpp')).toBe('void loop() {}')
  })

  it('loads what an earlier session saved', () => {
    const kv = memoryKV()
    kv.setItem('simconsole.code.swarm.js', 'function loop() {}')
    expect(new SourceStore(kv).load('swarm', 'js')).toBe('function loop() {}')
    expect(new SourceStore(kv).load('swarm', 'cpp')).toBeNull()
  })

  it('keeps working in memory when storage throws', () => {
    // Arrange: private mode / blocked storage
    const store = new SourceStore(throwing)
    // Act
    store.save('sweeper', 'js', 'drive(0.1, 0, 0)')
    store.saveDialect('js')
    // Assert
    expect(store.load('sweeper', 'js')).toBe('drive(0.1, 0, 0)')
    expect(store.loadDialect()).toBe('js')
  })

  it('works with no storage at all', () => {
    const store = new SourceStore(null)
    expect(store.load('walker', 'cpp')).toBeNull()
    store.save('walker', 'cpp', 'x')
    expect(store.load('walker', 'cpp')).toBe('x')
  })

  it('ignores a garbage dialect preference', () => {
    const kv = memoryKV()
    kv.setItem('simconsole.code.dialect', 'cobol')
    expect(new SourceStore(kv).loadDialect()).toBeNull()
  })

  it('probes browser storage without throwing', () => {
    const kv = browserStorage()
    expect(kv === null || typeof kv.getItem === 'function').toBe(true)
  })
})
