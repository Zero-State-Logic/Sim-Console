import { describe, expect, it } from 'vitest'
import type { LinkState } from '../types'
import { canEstop, canHome, escEstops, isOpen, pillView } from './status'

const ALL: LinkState[] = ['idle', 'connecting', 'handshake', 'verify', 'ready', 'homing', 'live', 'estopped', 'error', 'disconnected']

describe('pillView', () => {
  it('gives every state a label, a tone and a hint', () => {
    for (const s of ALL) {
      const v = pillView(s, false)
      expect(v.label.length).toBeGreaterThan(0)
      expect(v.hint.length).toBeGreaterThan(0)
    }
  })

  it('reserves the orange live tone for LIVE and red for stop and error states', () => {
    // Act
    const tones = Object.fromEntries(ALL.map((s) => [s, pillView(s, false).tone]))
    // Assert
    expect(ALL.filter((s) => tones[s] === 'live')).toEqual(['live'])
    expect(tones.estopped).toBe('stop')
    expect(tones.error).toBe('error')
    expect(tones.disconnected).toBe('error')
    expect(tones.ready).toBe('ready')
    expect(tones.idle).toBe('off')
  })

  it('pulses only while something is in flight', () => {
    expect(pillView('handshake', false).pulse).toBe(true)
    expect(pillView('homing', false).pulse).toBe(true)
    expect(pillView('ready', false).pulse).toBe(false)
    expect(pillView('error', false).pulse).toBe(false)
  })

  it('marks a stale link in the label and the hint, keeping LIVE orange', () => {
    // Act
    const live = pillView('live', true)
    const ready = pillView('ready', true)
    const err = pillView('error', true)
    // Assert
    expect(live.label).toBe('LIVE · STALE')
    expect(live.tone).toBe('live')
    expect(live.hint).toMatch(/500 ms/)
    expect(ready.tone).toBe('busy')
    expect(err.label).toBe('ERROR')
  })
})

describe('state predicates', () => {
  it('offers E-STOP whenever a port is open, including errors and a latched stop', () => {
    expect(ALL.filter(canEstop)).toEqual(['handshake', 'verify', 'ready', 'homing', 'live', 'estopped', 'error'])
  })

  it('binds ESC to E-STOP only while the robot is or may be moving', () => {
    expect(ALL.filter((s) => escEstops(s, null))).toEqual(['homing', 'live'])
    expect(escEstops('error', 'home-timeout')).toBe(true)
    expect(escEstops('error', 'home-failed')).toBe(true)
    expect(escEstops('error', 'mismatch')).toBe(false)
  })

  it('offers HOME once verified, and to retry a failed home', () => {
    expect(ALL.filter((s) => canHome(s, null))).toEqual(['ready', 'live', 'estopped'])
    expect(canHome('error', 'home-timeout')).toBe(true)
    expect(canHome('error', 'home-failed')).toBe(true)
    expect(canHome('error', 'mismatch')).toBe(false)
  })

  it('treats a link as open between the port opening and a disconnect', () => {
    expect(ALL.filter(isOpen)).toEqual(['handshake', 'verify', 'ready', 'homing', 'live', 'estopped', 'error'])
  })
})
