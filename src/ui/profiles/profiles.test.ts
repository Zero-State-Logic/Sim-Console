import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../../core/hardware'
import {
  MAX_PROFILES,
  PROFILE_STORAGE_KEY,
  applyProfile,
  captureProfile,
  clampSlider,
  parseProfileFile,
  profileFileName,
  readProfiles,
  removeProfile,
  sanitizeConfig,
  sanitizeControlValue,
  sanitizeHardwareConfig,
  sanitizeName,
  serializeProfile,
  upsertProfile,
  validateProfile,
  writeProfiles,
  type ProfileTarget,
  type ProfileTargetModule,
  type RobotProfile,
  type StorageLike,
} from '../../core/profiles'
import type { ControlDef, ControlValue, HardwareSpec, RobotKind, SelectDef } from '../../core/types'

const SLIDER: ControlDef = { type: 'slider', key: 'speed', label: 'SPEED', group: 'G', min: 0, max: 1, step: 0.05, value: 0.5 }
const SELECT: ControlDef = {
  type: 'select',
  key: 'gait',
  label: 'GAIT',
  group: 'G',
  value: 'tripod',
  options: [{ value: 'tripod', label: 'TRIPOD' }, { value: 'wave', label: 'WAVE' }],
}
const TOGGLE: ControlDef = { type: 'toggle', key: 'dyn', label: 'DYNAMIC', group: 'G', value: false }
const BUTTON: ControlDef = { type: 'button', key: 'home', label: 'HOME', group: 'G' }

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

function profile(over: Partial<RobotProfile> = {}): RobotProfile {
  return {
    version: 1,
    name: 'Hex fast',
    kind: 'walker',
    createdAt: '2026-11-03T10:00:00.000Z',
    controls: { speed: 0.8, gait: 'wave', dyn: true },
    config: { obstacles: [1, 2] },
    hardware: defaultHardwareConfig('esp32', 18),
    ...over,
  }
}

/* A fake robot whose 'legs' control reshapes the gait options, like the walker. */
class FakeRobot implements ProfileTargetModule {
  values: Record<string, ControlValue> = { legs: '6', gait: 'tripod', speed: 0.5 }
  loaded: unknown = undefined
  constructor(readonly kind: RobotKind = 'walker') {}
  getControlSchema(): ControlDef[] {
    const gait: SelectDef = {
      type: 'select',
      key: 'gait',
      label: 'GAIT',
      group: 'GAIT',
      value: String(this.values.gait),
      options: this.values.legs === '8' ? [{ value: 'tetrapod', label: 'T' }, { value: 'wave', label: 'W' }] : [{ value: 'tripod', label: 'T' }],
    }
    return [
      { type: 'select', key: 'legs', label: 'LEGS', group: 'GAIT', value: '6', options: [{ value: '4', label: '4' }, { value: '6', label: '6' }, { value: '8', label: '8' }] },
      gait,
      SLIDER,
    ]
  }
  getHardwareSpec(): HardwareSpec {
    const legs = Number(this.values.legs)
    return { robot: this.kind, joints: legs * 3, jointNames: [], jointLimits: [], homePose: [], defaultLevel: { wired: 'joint', wireless: 'high' } }
  }
  loadConfig(c: unknown): void {
    this.loaded = c
  }
}

function fakeTarget(robot: FakeRobot): ProfileTarget & { calls: string[]; hw: HardwareConfig | null; current: FakeRobot } {
  const t = {
    calls: [] as string[],
    hw: null as HardwareConfig | null,
    current: robot,
    currentKind: () => t.current.kind,
    setRobot: (kind: RobotKind) => {
      t.calls.push(`robot:${kind}`)
      t.current = new FakeRobot(kind)
    },
    module: () => t.current,
    setControl: (key: string, value: ControlValue) => {
      t.calls.push(`${key}=${String(value)}`)
      t.current.values = { ...t.current.values, [key]: value }
    },
    setHardware: (cfg: HardwareConfig) => {
      t.hw = cfg
    },
  }
  return t
}

describe('sanitizeName', () => {
  it('trims, collapses whitespace, strips control characters and caps length', () => {
    expect(sanitizeName('  My\tHex \n fast\u0007 ')).toBe('My Hex fast')
    expect(sanitizeName('x'.repeat(200))).toHaveLength(48)
    expect(sanitizeName(42)).toBe('')
  })
})

describe('clampSlider', () => {
  it('clamps into range and snaps to the step grid anchored at min', () => {
    expect(clampSlider(1.7, 0, 1, 0.05)).toBe(1)
    expect(clampSlider(-3, 0, 1, 0.05)).toBe(0)
    expect(clampSlider(0.123, 0, 1, 0.05)).toBe(0.1)
    expect(clampSlider(0.33, 0.01, 1, 0.1)).toBe(0.31)
  })

  it('does not produce float noise and tolerates a zero step', () => {
    expect(clampSlider(0.3, 0, 1, 0.1)).toBe(0.3)
    expect(clampSlider(0.37, 0, 1, 0)).toBe(0.37)
  })
})

describe('sanitizeControlValue', () => {
  it('clamps slider numbers and rejects non-numbers', () => {
    expect(sanitizeControlValue(SLIDER, 4)).toBe(1)
    expect(sanitizeControlValue(SLIDER, '0.5')).toBeUndefined()
    expect(sanitizeControlValue(SLIDER, Number.NaN)).toBeUndefined()
  })

  it('accepts only listed select options, booleans for toggles and nothing for buttons', () => {
    expect(sanitizeControlValue(SELECT, 'wave')).toBe('wave')
    expect(sanitizeControlValue(SELECT, 'gallop')).toBeUndefined()
    expect(sanitizeControlValue(TOGGLE, true)).toBe(true)
    expect(sanitizeControlValue(TOGGLE, 1)).toBeUndefined()
    expect(sanitizeControlValue(BUTTON, true)).toBeUndefined()
  })
})

describe('sanitizeHardwareConfig', () => {
  it('builds a full config from garbage using board defaults', () => {
    const cfg = sanitizeHardwareConfig('nope', 18)
    expect(cfg).toEqual(defaultHardwareConfig('esp32', 18))
  })

  it('keeps valid saved values, clamps ranges and fits per-joint arrays', () => {
    // Arrange
    const raw = {
      board: 'pico',
      transport: 'serial',
      baud: 99_000_000,
      servoPins: [2, 3, 'x'],
      jointOffsetDeg: [5, 400],
      jointScale: [0.01],
      jointInvert: [true],
      watchdogMs: 1,
      wsUrl: 'http://evil',
      bleName: 'Bot\u0000',
    }
    // Act
    const cfg = sanitizeHardwareConfig(raw, 4)
    // Assert
    expect(cfg.board).toBe('pico')
    expect(cfg.baud).toBe(4_000_000)
    expect(cfg.servoPins).toEqual([2, 3, 4, 5])
    expect(cfg.jointOffsetDeg).toEqual([5, 90, 0, 0])
    expect(cfg.jointScale).toEqual([0.25, 1, 1, 1])
    expect(cfg.jointInvert).toEqual([true, false, false, false])
    expect(cfg.watchdogMs).toBe(50)
    expect(cfg.wsUrl).toBe('ws://192.168.4.1:81')
    expect(cfg.bleName).toBe('KiyoBot')
  })

  it('rejects a transport the board lacks and forces PCA9685 on Linux boards', () => {
    expect(sanitizeHardwareConfig({ board: 'pico', transport: 'ble' }, 3).transport).toBe('serial')
    expect(sanitizeHardwareConfig({ board: 'pizero2w', servoDriver: 'gpio' }, 3).servoDriver).toBe('pca9685')
    expect(sanitizeHardwareConfig({ board: 'esp32', transport: 'loopback' }, 3).transport).toBe('loopback')
  })

  it('never copies unknown keys', () => {
    const cfg = sanitizeHardwareConfig({ board: 'esp32', password: 'hunter2' }, 2) as unknown as Record<string, unknown>
    expect('password' in cfg).toBe(false)
  })
})

describe('sanitizeConfig', () => {
  it('returns a detached JSON copy and drops non-serializable or huge values', () => {
    const src = { a: [1, 2] }
    const out = sanitizeConfig(src) as { a: number[] }
    src.a[0] = 9
    expect(out.a[0]).toBe(1)
    expect(sanitizeConfig(undefined)).toBeNull()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(sanitizeConfig(cyclic)).toBeNull()
    expect(sanitizeConfig('x'.repeat(300_000))).toBeNull()
  })
})

describe('validateProfile', () => {
  it('accepts a well-formed profile', () => {
    const res = validateProfile(JSON.parse(serializeProfile(profile())))
    expect(res).toEqual({ ok: true, value: profile() })
  })

  it('rejects wrong version, unknown kind and missing name', () => {
    expect(validateProfile(null).ok).toBe(false)
    expect(validateProfile({ ...profile(), version: 2 }).ok).toBe(false)
    expect(validateProfile({ ...profile(), kind: 'tank' }).ok).toBe(false)
    expect(validateProfile({ ...profile(), name: '   ' }).ok).toBe(false)
  })

  it('drops non-primitive and unsafe control entries', () => {
    const raw = JSON.parse('{"version":1,"name":"x","kind":"swarm","controls":{"a":1,"b":{"c":1},"__proto__":{"p":1},"d":"ok","e":null}}') as unknown
    const res = validateProfile(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.controls).toEqual({ a: 1, d: 'ok' })
    expect(res.value.createdAt).toBe(new Date(0).toISOString())
    expect(res.value.config).toBeNull()
  })
})

describe('captureProfile', () => {
  it('captures schema values except buttons and momentary dir/turn', () => {
    // Arrange
    const source = {
      kind: 'walker' as RobotKind,
      getControlSchema: (): ControlDef[] => [
        SLIDER,
        BUTTON,
        { ...SELECT, key: 'dir', options: [{ value: 'f', label: 'F' }] },
        { ...SELECT, key: 'turn', options: [{ value: 'cw', label: 'CW' }] },
        SELECT,
      ],
      getControlValues: (): Record<string, ControlValue> => ({ speed: 0.7, dir: 'f', turn: 'cw', gait: 'wave', stale: 1 }),
      serializeConfig: (): unknown => ({ waypoints: [[1, 2]] }),
    }
    // Act
    const p = captureProfile('  Mine ', source, defaultHardwareConfig('esp32', 18), new Date('2026-01-01T00:00:00Z'))
    // Assert
    expect(p.name).toBe('Mine')
    expect(p.controls).toEqual({ speed: 0.7, gait: 'wave' })
    expect(p.config).toEqual({ waypoints: [[1, 2]] })
    expect(p.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('applyProfile', () => {
  it('switches robot when needed, then applies controls, config and hardware', () => {
    // Arrange
    const target = fakeTarget(new FakeRobot('swarm'))
    const p = profile({ controls: { legs: '6', speed: 2 }, config: { k: 1 } })
    // Act
    const report = applyProfile(p, target)
    // Assert
    expect(target.calls[0]).toBe('robot:walker')
    expect(target.calls).toContain('speed=1')
    expect(report.applied.sort()).toEqual(['legs', 'speed'])
    expect(target.current.loaded).toEqual({ k: 1 })
    expect(target.hw?.servoPins).toHaveLength(18)
  })

  it('applies a key unlocked by an earlier control on the same or a later pass', () => {
    const target = fakeTarget(new FakeRobot())
    const report = applyProfile(profile({ controls: { gait: 'tetrapod', legs: '8' } }), target)
    expect(target.calls).toEqual(['legs=8', 'gait=tetrapod'])
    expect(report.rejected).toEqual([])
    expect(target.hw?.servoPins).toHaveLength(24)
  })

  it('reports unknown keys and invalid options as rejected without applying them', () => {
    const target = fakeTarget(new FakeRobot())
    const report = applyProfile(profile({ controls: { gait: 'gallop', bogus: 1, dir: 'f' } }), target)
    expect(report.applied).toEqual([])
    expect(report.rejected.sort()).toEqual(['bogus', 'gait'])
    expect(target.calls).toEqual([])
  })

  it('reports a config the module throws on instead of failing the load', () => {
    const robot = new FakeRobot()
    robot.loadConfig = () => {
      throw new Error('bad obstacles')
    }
    const target = fakeTarget(robot)
    const report = applyProfile(profile(), target)
    expect(report.configError).toBe('bad obstacles')
    expect(target.hw).not.toBeNull()
  })
})

describe('profile list', () => {
  it('upserts by kind and case-insensitive name and caps the list', () => {
    const a = profile({ name: 'A' })
    const list = upsertProfile(upsertProfile([], a), profile({ name: 'a', controls: { speed: 0.1 } }))
    expect(list).toHaveLength(1)
    expect(list[0].controls).toEqual({ speed: 0.1 })
    expect(upsertProfile(list, profile({ name: 'A', kind: 'swarm' }))).toHaveLength(2)
    let big: RobotProfile[] = []
    for (let i = 0; i < MAX_PROFILES + 5; i++) big = upsertProfile(big, profile({ name: `p${i}` }))
    expect(big).toHaveLength(MAX_PROFILES)
    expect(big[0].name).toBe('p5')
  })

  it('removes only the matching kind and name', () => {
    const list = [profile({ name: 'A' }), profile({ name: 'A', kind: 'sweeper' })]
    expect(removeProfile(list, 'walker', 'a')).toEqual([list[1]])
  })
})

describe('storage', () => {
  it('writes and reads back profiles through the storage key', () => {
    const storage = memoryStorage()
    expect(writeProfiles([profile()], storage)).toBe(true)
    expect(Object.keys(storage.data)).toEqual([PROFILE_STORAGE_KEY])
    expect(readProfiles(storage)).toEqual([profile()])
  })

  it('returns an empty list for missing, corrupt or non-array data and skips invalid entries', () => {
    expect(readProfiles(memoryStorage())).toEqual([])
    expect(readProfiles(memoryStorage({ [PROFILE_STORAGE_KEY]: '{bad' }))).toEqual([])
    expect(readProfiles(memoryStorage({ [PROFILE_STORAGE_KEY]: '{}' }))).toEqual([])
    const mixed = JSON.stringify([profile(), { version: 9 }])
    expect(readProfiles(memoryStorage({ [PROFILE_STORAGE_KEY]: mixed }))).toHaveLength(1)
    expect(readProfiles(null)).toEqual([])
  })

  it('survives a storage that throws', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(readProfiles(throwing)).toEqual([])
    expect(writeProfiles([profile()], throwing)).toBe(false)
  })
})

describe('profile files', () => {
  it('names files from kind and a slug of the name', () => {
    expect(profileFileName(profile({ name: 'Hex fast / v2!' }))).toBe('simconsole-walker-hex-fast-v2.json')
    expect(profileFileName(profile({ name: '!!!' }))).toBe('simconsole-walker-profile.json')
  })

  it('parses a single profile, an array and a { profiles } wrapper', () => {
    const one = serializeProfile(profile())
    expect(parseProfileFile(one)).toEqual({ ok: true, value: [profile()] })
    expect(parseProfileFile(`[${one},${one}]`).ok).toBe(true)
    const wrapped = parseProfileFile(JSON.stringify({ profiles: [profile()] }))
    expect(wrapped.ok && wrapped.value).toHaveLength(1)
  })

  it('rejects invalid JSON, empty lists and names the bad entry', () => {
    expect(parseProfileFile('nope')).toEqual({ ok: false, error: 'Not a valid JSON file.' })
    expect(parseProfileFile('[]').ok).toBe(false)
    const res = parseProfileFile(JSON.stringify([profile(), { version: 1, kind: 'walker' }]))
    expect(res).toEqual({ ok: false, error: 'Profile 2: Profile has no name.' })
  })
})
