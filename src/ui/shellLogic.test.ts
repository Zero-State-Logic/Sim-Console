import { describe, expect, it } from 'vitest'
import { parseRobotParam, parseViewParam, robotFromLocation, withRobotParam } from './urlState'
import { DRAWER_DEFAULT_PX, DRAWER_MIN_PX, clampDrawerHeight, drawerMaxPx, formatClock, formatDuration, formatSpeed } from './layoutMath'
import { parsePrefs, useUi } from './uiStore'
import { FACTORY_ID, presetsFor } from './profiles/presets'
import { TRANSIENT_KEYS, applyControlValues, type ProfileTargetModule } from '../core/profiles'
import type { ControlDef, ControlValue, HardwareSpec, RobotKind } from '../core/types'

describe('robot URL parameter', () => {
  it('reads a known robot kind, case and whitespace insensitive', () => {
    expect(parseRobotParam('?robot=sweeper')).toBe('sweeper')
    expect(parseRobotParam('?a=1&robot=%20SWARM%20')).toBe('swarm')
  })

  it('ignores unknown, empty and missing values', () => {
    expect(parseRobotParam('?robot=tank')).toBeNull()
    expect(parseRobotParam('?robot=')).toBeNull()
    expect(parseRobotParam('')).toBeNull()
    expect(parseRobotParam('?robot=__proto__')).toBeNull()
  })

  it('sets the robot while keeping other parameters', () => {
    // Arrange
    const search = '?debug=1&robot=walker'
    // Act
    const next = withRobotParam(search, 'swarm')
    // Assert
    expect(next).toBe('?debug=1&robot=swarm')
    expect(withRobotParam('', 'walker')).toBe('?robot=walker')
  })
})

describe('drawer sizing', () => {
  it('caps the drawer at 75 % of the viewport, never below the minimum', () => {
    expect(drawerMaxPx(1000)).toBe(750)
    expect(drawerMaxPx(100)).toBe(DRAWER_MIN_PX)
    expect(clampDrawerHeight(drawerMaxPx(1000) + 50, 1000)).toBe(750)
  })
})

describe('built-in presets', () => {
  const kinds: RobotKind[] = ['walker', 'sweeper', 'swarm']

  it('starts every robot with the factory preset, followed by curated ones', () => {
    for (const kind of kinds) {
      const list = presetsFor(kind)
      expect(list[0].id).toBe(FACTORY_ID)
      expect(Object.keys(list[0].controls)).toHaveLength(0)
      expect(list.length).toBeGreaterThan(2)
    }
  })

  it('uses unique ids, the right kind and never a momentary drive key', () => {
    for (const kind of kinds) {
      const list = presetsFor(kind)
      expect(new Set(list.map((p) => p.id)).size).toBe(list.length)
      for (const p of list) {
        expect(p.kind).toBe(kind)
        for (const k of TRANSIENT_KEYS) expect(k in p.controls).toBe(false)
      }
    }
  })
})

/* Minimal module: a 'mode' select and a 'gain' slider. */
class TinyModule implements ProfileTargetModule {
  readonly kind: RobotKind = 'sweeper'
  values: Record<string, ControlValue> = {}
  getControlSchema(): ControlDef[] {
    return [
      { type: 'select', key: 'mode', label: 'MODE', group: 'G', value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { type: 'slider', key: 'gain', label: 'GAIN', group: 'G', min: 0, max: 10, step: 0.5, value: 1 },
      { type: 'select', key: 'dir', label: 'DIR', group: 'G', value: 'stop', display: 'grid3', options: [{ value: 'stop', label: 'S' }, { value: 'f', label: 'F' }] },
    ]
  }
  getHardwareSpec(): HardwareSpec {
    return { robot: 'sweeper', joints: 4, jointNames: [], jointLimits: [], homePose: [], defaultLevel: { wired: 'joint', wireless: 'high' } }
  }
  loadConfig(): void {}
}

describe('applyControlValues', () => {
  it('validates each value against the live schema before writing it', () => {
    // Arrange
    const m = new TinyModule()
    const writes: string[] = []
    const target = { module: () => m, setControl: (k: string, v: ControlValue) => writes.push(`${k}=${String(v)}`) }
    // Act
    const report = applyControlValues({ mode: 'b', gain: 12.3, missing: true, dir: 'f' }, target)
    // Assert
    expect(writes).toEqual(['mode=b', 'gain=10'])
    expect(report.applied).toEqual(['mode', 'gain'])
    expect(report.rejected).toEqual(['missing'])
  })

  it('rejects an option the schema does not offer and writes nothing for it', () => {
    const m = new TinyModule()
    const writes: string[] = []
    const report = applyControlValues({ mode: 'zzz' }, { module: () => m, setControl: (k) => writes.push(k) })
    expect(writes).toEqual([])
    expect(report.rejected).toEqual(['mode'])
  })
})

describe('stored UI preferences', () => {
  it('falls back to defaults for missing or malformed storage', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '[]']) {
      const p = parsePrefs(raw)
      expect(p.drawerHeight).toBe(DRAWER_DEFAULT_PX)
      expect(p.padLatch).toBe(false)
      expect(p.collapsed).toEqual({})
    }
  })

  it('keeps well-typed fields and drops the rest', () => {
    // Arrange
    const raw = JSON.stringify({ drawerHeight: 412, padLatch: true, collapsed: { LOCOMOTION: true, GAINS: 'yes', [`${'x'.repeat(80)}`]: true } })
    // Act
    const p = parsePrefs(raw)
    // Assert
    expect(p).toEqual({ drawerHeight: 412, padLatch: true, collapsed: { LOCOMOTION: true } })
  })

  it('never lets a stored key reach the object prototype', () => {
    const p = parsePrefs('{"collapsed":{"__proto__":true,"ACTIONS":false},"drawerHeight":"tall"}')
    expect(Object.getPrototypeOf(p.collapsed)).toBe(Object.prototype)
    expect(Object.keys(p.collapsed)).toEqual(['ACTIONS'])
    expect(p.drawerHeight).toBe(DRAWER_DEFAULT_PX)
  })
})

describe('shell UI store', () => {
  it('opens one overlay rail at a time and toggles it closed', () => {
    const ui = useUi.getState()
    ui.closeRails()
    ui.toggleRail('left')
    expect(useUi.getState().railOpen).toBe('left')
    ui.toggleRail('right')
    expect(useUi.getState().railOpen).toBe('right')
    ui.toggleRail('right')
    expect(useUi.getState().railOpen).toBeNull()
  })

  it('collapses control groups independently, without storage available', () => {
    const ui = useUi.getState()
    ui.toggleCollapsed('GAINS')
    expect(useUi.getState().collapsed.GAINS).toBe(true)
    ui.toggleCollapsed('GAINS')
    expect(useUi.getState().collapsed.GAINS).toBe(false)
    expect(useUi.getState().collapsed.LOCOMOTION).toBeUndefined()
  })

  it('bumps the camera nonce so re-selecting a preset re-tweens', () => {
    const before = useUi.getState().cameraNonce
    useUi.getState().bumpCamera()
    expect(useUi.getState().cameraNonce).toBe(before + 1)
  })
})

describe('chrome formatting', () => {
  it('formats the sim clock as MM:SS.d and H:MM:SS.d past an hour', () => {
    expect(formatClock(0)).toBe('00:00.0')
    expect(formatClock(65.37)).toBe('01:05.3')
    expect(formatClock(3725.5)).toBe('1:02:05.5')
    expect(formatClock(-3)).toBe('00:00.0')
    expect(formatClock(Number.NaN)).toBe('00:00.0')
  })

  it('formats timeline durations and speed steps', () => {
    expect(formatDuration(4.24)).toBe('4.2 s')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatSpeed(0.25)).toBe('¼×')
    expect(formatSpeed(0.5)).toBe('½×')
    expect(formatSpeed(2)).toBe('2×')
  })

  it('reads no robot from the location outside a browser', () => {
    expect(robotFromLocation()).toBeNull()
  })
})

describe('parseViewParam', () => {
  it('accepts only the known camera presets, case-insensitively', () => {
    expect(parseViewParam('?view=top')).toBe('top')
    expect(parseViewParam('?robot=sweeper&view=FOLLOW')).toBe('follow')
    expect(parseViewParam('?view=orbit')).toBeNull()
    expect(parseViewParam('')).toBeNull()
  })
})
