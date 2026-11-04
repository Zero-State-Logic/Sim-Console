import { describe, expect, it } from 'vitest'
import type { SandboxFnDef } from '../../core/types'
import { SHIM_CLASSES, SHIM_FUNCTIONS } from '../shim/reference'
import type { ProgramState } from '../store'
import { diagSummary, fmtCount, fmtMs, robotSignature, robotSnippet, shimSignature, statCells, statusDetail, statusView } from './labels'

const CMD: SandboxFnDef = { name: 'setJoint', kind: 'command', params: ['joint', 'deg'], doc: '' }
const QRY: SandboxFnDef = { name: 'readLoad', kind: 'query', params: ['leg'], sensor: 'load', doc: '' }

describe('status text', () => {
  it('has a label and tone for every program state', () => {
    const states: ProgramState[] = ['idle', 'compiling', 'running', 'paused', 'sleeping', 'error', 'stopped']
    for (const s of states) expect(statusView(s).label.length).toBeGreaterThan(0)
    expect(statusView('running').tone).toBe('live')
    expect(statusView('error').tone).toBe('err')
  })

  it('explains sleeping, dirty and idle states', () => {
    expect(statusDetail('sleeping', 1500, false)).toBe('wakes at 1.50 s sim time')
    expect(statusDetail('running', null, true)).toBe('editor changed: RUN reloads')
    expect(statusDetail('idle', null, false)).toMatch(/RUN/)
  })
})

describe('number formatting', () => {
  it('formats milliseconds and counts compactly', () => {
    expect(fmtMs(null)).toBe('—')
    expect(fmtMs(1.234)).toBe('1.23')
    expect(fmtMs(45.67)).toBe('45.7')
    expect(fmtCount(1234)).toBe('1,234')
    expect(fmtCount(45_000)).toBe('45k')
    expect(fmtCount(2_500_000)).toBe('2.5M')
  })

  it('shows instruction counts for C++ only, after the first tick', () => {
    const stats = { compileMs: 2, instrPerTick: 1500, loopHz: 59.9, ticks: 10 }
    expect(statCells(stats, 'cpp', 12).map((c) => c.value)).toEqual(['2.00', '1,500', '59.9', '12'])
    expect(statCells(stats, 'js', 0).map((c) => c.value)).toEqual(['2.00', '—', '59.9', '—'])
  })
})

describe('API signatures', () => {
  it('renders robot functions per dialect', () => {
    expect(robotSignature(CMD, 'cpp')).toBe('void setJoint(joint, deg)')
    expect(robotSignature(QRY, 'cpp')).toBe('float readLoad(leg)')
    expect(robotSignature(QRY, 'js')).toBe('readLoad(leg) → number')
    expect(robotSnippet(CMD, 'cpp')).toBe('setJoint(0, 0);')
    expect(robotSnippet(QRY, 'js')).toBe('readLoad(0)')
  })

  it('renders shim functions with optional params in brackets', () => {
    const print = SHIM_FUNCTIONS.find((f) => f.name === 'Serial.print')
    const attach = SHIM_CLASSES[0].methods.find((f) => f.name === 'attach')
    expect(print && shimSignature(print, 'cpp')).toBe('int Serial.print(auto value, [int format])')
    expect(print && shimSignature(print, 'js')).toBe('Serial.print(value, [format]) → number')
    expect(attach && shimSignature(attach, 'cpp', 'Servo')).toBe('int Servo.attach(int pin, [int minUs], [int maxUs])')
  })

  it('summarizes diagnostics', () => {
    expect(diagSummary([])).toBe('no problems')
    expect(diagSummary([{ severity: 'error' }, { severity: 'error' }, { severity: 'warning' }])).toBe('2 errors · 1 warning')
  })
})
