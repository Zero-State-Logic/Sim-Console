import { describe, expect, it } from 'vitest'
import { CATEGORICAL_VARS, categoricalColor, cssVarFallback, parseCssVar, withAlpha } from './color'
import {
  GAUGE_START_DEG,
  arcPath,
  arcPoint,
  formatGaugeValue,
  gaugeArc,
  gaugeDigits,
  gaugeFraction,
  gaugeTicks,
} from './gaugeMath'
import { SeriesBuffer, autoRange } from './series'

describe('gaugeFraction', () => {
  it('normalises into [0, 1] and clamps', () => {
    expect(gaugeFraction(50, 0, 100)).toBe(0.5)
    expect(gaugeFraction(-5, 0, 100)).toBe(0)
    expect(gaugeFraction(500, 0, 100)).toBe(1)
    expect(gaugeFraction(0, -1, 1)).toBe(0.5)
  })

  it('returns 0 for NaN values and degenerate ranges', () => {
    expect(gaugeFraction(Number.NaN, 0, 1)).toBe(0)
    expect(gaugeFraction(3, 2, 2)).toBe(0)
  })
})

describe('arc geometry', () => {
  it('places 0° on +x and 90° straight up in SVG coordinates', () => {
    const [x0, y0] = arcPoint(10, 10, 5, 0)
    const [x90, y90] = arcPoint(10, 10, 5, 90)
    expect(x0).toBeCloseTo(15)
    expect(y0).toBeCloseTo(10)
    expect(x90).toBeCloseTo(10)
    expect(y90).toBeCloseTo(5)
  })

  it('starts the gauge at lower-left and ends at lower-right', () => {
    const full = gaugeArc(40, 40, 30, 1)
    const [sx, sy] = arcPoint(40, 40, 30, GAUGE_START_DEG)
    expect(sy).toBeGreaterThan(40)
    expect(sx).toBeLessThan(40)
    expect(full.startsWith(`M ${Math.round(sx * 100) / 100} ${Math.round(sy * 100) / 100} A 30 30 0 1 1`)).toBe(true)
  })

  it('sweeps clockwise: half scale points straight up, full scale ends mirrored at lower-right', () => {
    // 210° - 120° = 90° (top); 210° - 240° = -30° → (cx + r·cos30°, cy + r/2)
    const end = (path: string): number[] => path.trim().split(/\s+/).slice(-2).map(Number)
    const [hx, hy] = end(gaugeArc(40, 40, 30, 0.5))
    const [fx, fy] = end(gaugeArc(40, 40, 30, 1))
    expect(hx).toBeCloseTo(40, 2)
    expect(hy).toBeCloseTo(10, 2)
    expect(fx).toBeCloseTo(40 + 30 * Math.cos(Math.PI / 6), 2)
    expect(fy).toBeCloseTo(55, 2)
  })

  it('uses the small-arc flag up to 180° and the large one beyond', () => {
    expect(arcPath(0, 0, 1, 90, 90)).toContain(' 0 0 1 ')
    expect(arcPath(0, 0, 1, 90, 200)).toContain(' 0 1 1 ')
  })

  it('draws nothing for an empty or invalid sweep', () => {
    expect(gaugeArc(0, 0, 1, 0)).toBe('')
    expect(arcPath(0, 0, 1, 0, Number.NaN)).toBe('')
  })

  it('makes count + 1 ticks across the sweep', () => {
    const ticks = gaugeTicks(0, 0, 10, 12, 4)
    expect(ticks).toHaveLength(5)
    const [x1, y1] = ticks[2]
    // the middle tick of a symmetric 240° sweep points straight up
    expect(x1).toBeCloseTo(0)
    expect(y1).toBeCloseTo(-10)
  })
})

describe('gauge value formatting', () => {
  it('picks fewer decimals for wider ranges', () => {
    expect(gaugeDigits(0, 1)).toBe(2)
    expect(gaugeDigits(-10, 10)).toBe(1)
    expect(gaugeDigits(0, 100)).toBe(0)
  })

  it('formats without negative zero and shows a dash for NaN', () => {
    expect(formatGaugeValue(52.4, 0)).toBe('52')
    expect(formatGaugeValue(-0.04, 1)).toBe('0.0')
    expect(formatGaugeValue(-1.25, 1)).toBe('-1.3')
    expect(formatGaugeValue(Number.NaN, 0)).toBe('—')
  })
})

describe('color helpers', () => {
  it('parses css variables with and without fallbacks', () => {
    expect(parseCssVar('var(--l1)')).toBe('--l1')
    expect(parseCssVar(' var( --accent-press , #fff ) ')).toBe('--accent-press')
    expect(parseCssVar('#FF5A1F')).toBeNull()
    expect(cssVarFallback('var(--x, #123456)')).toBe('#123456')
    expect(cssVarFallback('var(--x)')).toBeNull()
  })

  it('applies alpha to hex and rgb colors and passes other forms through', () => {
    expect(withAlpha('#FF5A1F', 0.2)).toBe('rgba(255,90,31,0.2)')
    expect(withAlpha('#0c8', 1)).toBe('rgba(0,204,136,1)')
    expect(withAlpha('#0C8F9BCC', 0.5)).toBe('rgba(12,143,155,0.5)')
    expect(withAlpha('rgb(1, 2, 3)', 2)).toBe('rgba(1,2,3,1)')
    expect(withAlpha('teal', 0.5)).toBe('teal')
  })

  it('cycles through the eight leg tokens', () => {
    expect(categoricalColor(0)).toBe('var(--l1)')
    expect(categoricalColor(9)).toBe('var(--l2)')
    expect(categoricalColor(-1)).toBe('var(--l8)')
    expect(CATEGORICAL_VARS).toHaveLength(8)
  })
})

describe('SeriesBuffer', () => {
  it('appends samples no closer than minDt and exposes a stable data tuple', () => {
    // Arrange
    const s = new SeriesBuffer(2, 6, 0.1)
    const data = s.data
    // Act
    s.push(0, (i) => i)
    const skipped = s.push(0.05, () => 9)
    s.push(0.1, (i) => i + 10)
    // Assert
    expect(skipped).toBe(false)
    expect(s.length).toBe(2)
    expect(s.data).toBe(data)
    expect(data).toEqual([[0, 0.1], [0, 10], [1, 11]])
  })

  it('trims to the window but keeps one point before the left edge', () => {
    const s = new SeriesBuffer(1, 1, 0.1)
    for (let i = 0; i <= 30; i++) s.push(i * 0.1, () => i)
    expect(s.xs[0]).toBeLessThanOrEqual(3 - 1)
    expect(s.xs[1]).toBeGreaterThan(3 - 1)
    expect(s.xs[s.length - 1]).toBeCloseTo(3)
    expect(s.ys[0]).toHaveLength(s.length)
  })

  it('restarts when the clock goes backwards and replaces non-finite values with 0', () => {
    const s = new SeriesBuffer(1, 6)
    s.push(5, () => 1)
    s.push(6, () => 2)
    s.push(1, () => Number.NaN)
    expect(s.xs).toEqual([1])
    expect(s.ys[0]).toEqual([0])
    expect(s.push(Number.NaN, () => 1)).toBe(false)
  })

  it('loads a recorded window ending at the replay cursor', () => {
    const s = new SeriesBuffer(1, 1)
    const ts = [0, 0.5, 1, 1.5, 2, 2.5]
    s.load(ts.length, (r) => ts[r], (r) => r * 10, 2)
    expect(s.xs).toEqual([1, 1.5, 2])
    expect(s.ys[0]).toEqual([20, 30, 40])
    expect(s.latestT).toBe(2)
  })
})

describe('autoRange', () => {
  it('uses fixed bounds when both are given', () => {
    expect(autoRange([[100]], -1, 1)).toEqual([-1, 1])
  })

  it('pads the data range and honours a single fixed bound', () => {
    const [lo, hi] = autoRange([[0, 10]])
    expect(lo).toBeCloseTo(-0.8)
    expect(hi).toBeCloseTo(10.8)
    expect(autoRange([[2, 4]], 0)[0]).toBe(0)
  })

  it('widens a flat line and falls back for empty data', () => {
    expect(autoRange([[3, 3]])).toEqual([2.5, 3.5])
    expect(autoRange([[]])).toEqual([0, 1])
  })
})
